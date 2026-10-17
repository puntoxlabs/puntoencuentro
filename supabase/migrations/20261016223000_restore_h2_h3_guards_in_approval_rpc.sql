-- ==============================================================================
-- Migración: 20261016223000_restore_h2_h3_guards_in_approval_rpc.sql
-- Descripción:
--   Restauración de controles de seguridad H2/H3 en aprobar_solicitud_encuentro_abierto:
--   A. Cuenta permanente obligatoria (permanent_account_required)
--   B. Estado activo del encuentro bajo lock exclusivo (encuentro_not_active)
--   C. Bloqueo bilateral host <-> solicitante (request_not_available)
--   D. Participación activa duplicada (already_joined), preservando idempotencia
--
--   Mantiene íntegras todas las mejoras posteriores:
--   - Orden canónico de bloqueos H2/H3 (encuentros -> solicitudes -> participantes)
--   - Validación de cupos y capacidad (capacity_exceeded)
--   - Reinicio de reconfirmation_status = 'pending' y reconfirmed_at = NULL en re-aprobaciones post-baja
--   - Rotación de token_invitacion para invalidar accesos previos
--   - Idempotencia ante reintentos de la misma solicitud aprobada
--   - Integración con domain_events_outbox
--   - Notificaciones y deduplicación por ciclo de confirmación H6 (min_realization_cycle_id)
--   - Paridad estricta con las 13 columnas autoritativas de public.participantes
-- ==============================================================================

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
    v_is_anon boolean := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
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
    -- 1. Control A: Autenticación y cuenta permanente obligatoria
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 2. Orden canónico de bloqueo: 1) public.encuentros (FOR UPDATE)
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

    -- Control B: Estado activo (exigir 'activo', no permitir estados terminales o inactivos)
    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    -- 3. Orden canónico de bloqueo: 2) public.solicitudes_encuentro_abierto (FOR UPDATE)
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
      AND encuentro_id = v_encuentro.id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- Idempotencia: si la misma solicitud ya está aprobada, retornar ok sin mutar
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

    -- 4. Control C: Bloqueo bilateral
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_solicitud.usuario_id)
           OR (b.blocker_id = v_solicitud.usuario_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_available');
    END IF;

    -- 5. Control D: Participación activa duplicada
    -- Rechazar si el usuario ya figura como confirmado o asistio en el encuentro
    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = v_encuentro.id
          AND user_id = v_solicitud.usuario_id
          AND estado IN ('confirmado', 'asistio')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_joined');
    END IF;

    -- 6. Orden canónico de bloqueo: 3) public.participantes (FOR UPDATE)
    PERFORM 1
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id
    FOR UPDATE;

    v_req_seats := COALESCE(v_solicitud.seat_count, 1);

    -- 7. Calcular cupos ocupados reales y validar capacidad
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id AND estado IN ('confirmado', 'asistio');

    IF (v_confirmed_seats + v_req_seats) > v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'capacity_exceeded',
            'available_slots', GREATEST(0, v_encuentro.max_participants - v_confirmed_seats),
            'requested_seats', v_req_seats
        );
    END IF;

    -- 8. Insertar o sincronizar participante con las 13 columnas autoritativas de public.participantes
    SELECT id, token_invitacion INTO v_participante_id, v_token_invitacion
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id
      AND user_id = v_solicitud.usuario_id
    ORDER BY creado_en DESC, id DESC
    LIMIT 1;

    IF v_participante_id IS NOT NULL THEN
        -- Si existía un participante previo (por ejemplo cancelado tras baja voluntaria),
        -- reactivar como confirmado, reiniciar reconfirmation_status a pending, limpiar reconfirmed_at,
        -- sincronizar seat_count y rotar token_invitacion para invalidar accesos previos.
        v_token_invitacion := pg_catalog.gen_random_uuid();
        UPDATE public.participantes
        SET estado = 'confirmado',
            reconfirmation_status = 'pending',
            reconfirmed_at = NULL,
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
            reconfirmation_status,
            reconfirmed_at
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
            'pending',
            NULL
        );
    END IF;

    -- 9. Actualizar la solicitud a approved con protección contra carreras
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

    -- 10. Insertar Domain Event en Outbox (auditoría / replay)
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

    -- 11. Notificar al solicitante
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

    -- 12. Verificación de realización y mínimo de participantes (H6: deduplicación por ciclo de confirmación)
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

-- Permisos estrictos
REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(uuid, uuid) TO authenticated;

COMMIT;
