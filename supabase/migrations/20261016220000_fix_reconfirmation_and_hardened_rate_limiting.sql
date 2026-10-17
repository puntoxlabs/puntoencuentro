-- Migración aditiva y correctiva: Reconfirmación en re-postulación y endurecimiento de rate limiting
-- Timestamp: 20261016220000
-- Afecta: public.aprobar_solicitud_encuentro_abierto, public.verificar_y_consumir_rate_limit, public.rate_limit_policies

BEGIN;

-- ==============================================================================
-- 1. POLÍTICAS DE RATE LIMITING DURABLES (Asegurar política para qa_push_test)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
    action TEXT PRIMARY KEY,
    max_requests INTEGER NOT NULL CHECK (max_requests > 0),
    window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES ('qa_push_test', 10, 60, true)
ON CONFLICT (action) DO NOTHING;

-- ==============================================================================
-- 2. ENDURECIMIENTO DE VERIFICAR_Y_CONSUMIR_RATE_LIMIT (FAIL-CLOSED Y AISLAMIENTO)
-- ==============================================================================
DROP FUNCTION IF EXISTS public.verificar_y_consumir_rate_limit(UUID, TEXT, INT, INTERVAL);

CREATE OR REPLACE FUNCTION public.verificar_y_consumir_rate_limit(
    p_user_id UUID,
    p_action TEXT,
    p_max INT DEFAULT 5,
    p_window INTERVAL DEFAULT INTERVAL '1 hour'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_action TEXT := p_action;
    v_policy RECORD;
    v_res JSONB;
BEGIN
    -- 1. Control de autenticación: fail-closed si no hay identidad
    IF v_auth_uid IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'authentication_required');
    END IF;

    -- 2. Aislamiento de identidad: p_user_id no puede ser distinto de auth.uid()
    -- Evita que un usuario consuma o consulte el rate limit de otro usuario
    IF p_user_id IS NOT NULL AND p_user_id <> v_auth_uid THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'user_identity_mismatch');
    END IF;

    -- 3. Validación de parámetros de entrada
    IF v_action IS NULL OR pg_catalog.char_length(pg_catalog.btrim(v_action)) = 0 THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'invalid_parameters');
    END IF;

    IF p_max IS NOT NULL AND p_max <= 0 THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'invalid_parameters');
    END IF;

    IF p_window IS NOT NULL AND p_window <= INTERVAL '0 seconds' THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'invalid_parameters');
    END IF;

    -- 4. Mapeo de alias a la política canónica durable
    IF v_action = 'join_request' THEN
        v_action := 'join_open_encounter';
    END IF;

    -- 5. Búsqueda server-side en rate_limit_policies
    SELECT max_requests, window_seconds, enabled
    INTO v_policy
    FROM public.rate_limit_policies
    WHERE action = v_action;

    -- 6. Fail-closed total si la política no existe en la infraestructura durable
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
            'allowed', false,
            'error', 'rate_limit_policy_not_found',
            'action', v_action
        );
    END IF;

    -- 7. Si la política está deshabilitada administrativamente
    IF v_policy.enabled = false THEN
        RETURN pg_catalog.jsonb_build_object('allowed', true, 'disabled', true);
    END IF;

    -- 8. Delegar atómicamente a check_rate_limit_internal (mantiene atomicidad en rate_limit_buckets)
    -- check_rate_limit_internal utiliza auth.uid() y las políticas durables sin duplicar contadores
    v_res := public.check_rate_limit_internal(v_action, '');

    -- Si check_rate_limit_internal falló o devolvió error, asegurar fail-closed
    IF v_res IS NULL OR (v_res->>'allowed')::boolean IS NOT true THEN
        RETURN pg_catalog.jsonb_build_object(
            'allowed', false,
            'error', COALESCE(v_res->>'error', 'rate_limit_exceeded'),
            'action', v_action
        );
    END IF;

    RETURN v_res;
EXCEPTION WHEN OTHERS THEN
    -- Fail-closed total ante cualquier error inesperado
    RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'rate_limit_error');
END;
$$;

-- Permisos estrictos
REVOKE ALL ON FUNCTION public.verificar_y_consumir_rate_limit(UUID, TEXT, INT, INTERVAL) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verificar_y_consumir_rate_limit(UUID, TEXT, INT, INTERVAL) TO authenticated, service_role;

-- ==============================================================================
-- 3. APROBAR_SOLICITUD_ENCUENTRO_ABIERTO: REINICIO DE RECONFIRMACIÓN Y ROTACIÓN DE TOKEN
-- ==============================================================================
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

    -- Idempotencia: si ya está aprobada, retornar datos consistentes sin mutar
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
        -- Rotar token de participante para invalidar cualquier acceso de ciclos anteriores
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
