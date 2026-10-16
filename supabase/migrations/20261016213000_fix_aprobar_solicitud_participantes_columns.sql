-- Migración aditiva: Corregir columnas exactas de tabla participantes en aprobar_solicitud_encuentro_abierto
-- Timestamp: 20261016213000

BEGIN;

CREATE OR REPLACE FUNCTION public.aprobar_solicitud_encuentro_abierto(
    p_request_id uuid,
    p_host_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats int := 0;
    v_req_seats int := 1;
    v_participante_id uuid;
    v_token_invitacion uuid;
    v_title text;
    v_datetime_label text;
    v_part record;
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_nuevo_disponible int;
    v_cycle_id uuid;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- 1. Obtener encuentro primero para bloqueo canónico (Orden canónico: 1. encuentros)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = (
        SELECT encuentro_id
        FROM public.solicitudes_encuentro_abierto
        WHERE id = p_request_id
    )
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_cancelled');
    END IF;

    -- 2. Bloquear y revalidar la solicitud (Orden canónico: 2. solicitudes_encuentro_abierto)
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- Idempotencia: si ya está aprobada, retornar datos consistentes
    IF v_solicitud.estado = 'approved' THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'request_id', p_request_id,
            'participante_id', v_solicitud.participante_id,
            'token_invitacion', v_solicitud.token_participante,
            'seat_count', COALESCE(v_solicitud.seat_count, 1),
            'already_approved', true
        );
    END IF;

    IF v_solicitud.estado <> 'pending' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_request_state');
    END IF;

    -- 3. Bloquear participantes del encuentro (Orden canónico: 3. participantes)
    PERFORM 1
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id
    FOR UPDATE;

    v_req_seats := COALESCE(v_solicitud.seat_count, 1);

    -- 4. Calcular cupos ocupados reales
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id AND estado IN ('confirmado', 'asistio');

    -- 5. Validación de capacidad
    IF (v_confirmed_seats + v_req_seats) > v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'capacity_exceeded',
            'available_slots', GREATEST(0, v_encuentro.max_participants - v_confirmed_seats),
            'requested_seats', v_req_seats
        );
    END IF;

    -- 6. Insertar o sincronizar participante con las columnas exactas de public.participantes
    SELECT id, token_invitacion INTO v_participante_id, v_token_invitacion
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id
      AND user_id = v_solicitud.usuario_id
    LIMIT 1;

    IF v_participante_id IS NOT NULL THEN
        UPDATE public.participantes
        SET estado = 'confirmado',
            seat_count = v_req_seats,
            nombre_invitado = v_solicitud.nombre_solicitante,
            mensaje_respuesta = v_solicitud.mensaje,
            token_invitacion = v_token_invitacion
        WHERE id = v_participante_id;
    ELSE
        v_token_invitacion := pg_catalog.gen_random_uuid();
        v_participante_id := pg_catalog.gen_random_uuid();
        INSERT INTO public.participantes (
            id,
            encuentro_id,
            nombre_invitado,
            tipo_invitacion,
            estado,
            token_invitacion,
            mensaje_respuesta,
            user_id,
            seat_count,
            reconfirmation_status
        ) VALUES (
            v_participante_id,
            v_encuentro.id,
            v_solicitud.nombre_solicitante,
            'individual',
            'confirmado',
            v_token_invitacion,
            v_solicitud.mensaje,
            v_solicitud.usuario_id,
            v_req_seats,
            'pending'
        );
    END IF;

    -- 7. Actualizar la solicitud a approved con protección contra carreras
    BEGIN
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'approved',
            participante_id = v_participante_id,
            token_participante = v_token_invitacion,
            resolved_at = v_now,
            updated_at = v_now
        WHERE id = p_request_id
          AND estado = 'pending';
    EXCEPTION
        WHEN unique_violation THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_already_processed');
    END;

    -- 8. Insertar Domain Event en Outbox (auditoría / replay)
    INSERT INTO public.domain_events_outbox (
        event_type,
        event_version,
        aggregate_type,
        aggregate_id,
        actor_user_id,
        payload,
        dedup_key,
        status
    ) VALUES (
        'encounter.join_request.approved.v1',
        1,
        'encounter',
        v_encuentro.id,
        v_user_id,
        pg_catalog.jsonb_build_object(
            'request_id', p_request_id,
            'encounter_id', v_encuentro.id,
            'applicant_id', v_solicitud.usuario_id,
            'host_id', v_user_id,
            'seat_count', v_req_seats
        ),
        pg_catalog.format('encounter:%s:join_request_approved:%s', v_encuentro.id, p_request_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');
    v_datetime_label := CASE
        WHEN v_encuentro.fecha IS NOT NULL AND v_encuentro.hora IS NOT NULL THEN
            pg_catalog.to_char(v_encuentro.fecha, 'DD/MM/YYYY') || ' ' || pg_catalog.to_char(v_encuentro.hora, 'HH24:MI')
        WHEN v_encuentro.fecha IS NOT NULL THEN
            pg_catalog.to_char(v_encuentro.fecha, 'DD/MM/YYYY')
        ELSE 'Fecha a coordinar'
    END;

    -- 9. Notificar al solicitante
    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_solicitud.usuario_id,
        p_notification_type := 'open_encounter_request_accepted',
        p_target_type := 'encounter',
        p_target_id := v_encuentro.id,
        p_deep_link := '/?tab=encuentros&open_detail=' || v_encuentro.id,
        p_title := '¡Solicitud aceptada!',
        p_body := 'Tu solicitud para ' || v_title || ' fue aceptada.',
        p_payload := pg_catalog.jsonb_build_object(
            'encounter_id', v_encuentro.id,
            'request_id', p_request_id,
            'title', v_title,
            'datetime_label', v_datetime_label,
            'seat_count', v_req_seats
        ),
        p_dedup_key := 'join_request_approved:' || p_request_id
    );

    -- 10. Verificación de realización y mínimo de participantes (H6: deduplicación por ciclo de confirmación)
    IF v_encuentro.min_participants IS NOT NULL THEN
        IF v_encuentro.realization_status = 'pending' AND (v_confirmed_seats + v_req_seats) >= v_encuentro.min_participants THEN
            v_cycle_id := pg_catalog.gen_random_uuid();

            UPDATE public.encuentros
            SET realization_status = 'confirmed',
                min_confirmed_notified_at = v_now,
                min_realization_cycle_id = v_cycle_id
            WHERE id = v_encuentro.id;

            FOR v_part IN
                SELECT DISTINCT user_id
                FROM public.participantes
                WHERE encuentro_id = v_encuentro.id
                  AND estado IN ('confirmado', 'asistio')
                  AND user_id IS NOT NULL
                  AND user_id <> v_user_id
            LOOP
                PERFORM public.insertar_inbox_notification_seguro(
                    p_recipient_user_id := v_part.user_id,
                    p_notification_type := 'encounter_min_participants_reached',
                    p_target_type := 'encounter',
                    p_target_id := v_encuentro.id,
                    p_deep_link := '/?tab=encuentros&open_detail=' || v_encuentro.id,
                    p_title := '¡Se hace!',
                    p_body := '¡Se hace! El encuentro alcanzó el mínimo de participantes.',
                    p_payload := pg_catalog.jsonb_build_object(
                        'encounter_id', v_encuentro.id,
                        'request_id', p_request_id,
                        'title', v_title
                    ),
                    p_dedup_key := 'min_reached:' || v_encuentro.id || ':' || v_cycle_id || ':' || v_part.user_id
                );
            END LOOP;
        END IF;
    END IF;

    v_nuevo_disponible := GREATEST(0, v_encuentro.max_participants - (v_confirmed_seats + v_req_seats));

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', p_request_id,
        'participante_id', v_participante_id,
        'token_invitacion', v_token_invitacion,
        'seat_count', v_req_seats,
        'confirmed_seats', v_confirmed_seats + v_req_seats,
        'available_slots', v_nuevo_disponible,
        'nuevo_cupo_disponible', v_nuevo_disponible,
        'inscriptions_closed', COALESCE(v_encuentro.inscriptions_closed, false)
    );
END;
$$;

-- Permisos
REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(uuid, uuid) TO authenticated;

COMMIT;
