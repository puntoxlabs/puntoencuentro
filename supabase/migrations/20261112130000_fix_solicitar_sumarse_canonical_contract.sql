-- ==============================================================================
-- Migración Aditiva: Corrección de Contrato Canónico en solicitar_sumarse_encuentro_abierto
-- Timestamp: 20261112130000
-- Archivo: 20261112130000_fix_solicitar_sumarse_canonical_contract.sql
--
-- Diagnóstico de Regresión:
-- 1. La migración 20261112120000 introdujo ON CONFLICT (encuentro_id, usuario_id) sin
--    índice único total correspondiente (el índice idx_solicitudes_activas_unicas es parcial).
-- 2. El estado insertado era 'pendiente' en lugar de 'pending' (violando el check constraint).
-- 3. La acción de rate limit llamada era 'request_open_encounter' en lugar del helper canónico
--    verificar_y_consumir_rate_limit(..., 'join_request', ...).
-- 4. Omitía el manejo de lista de espera (cola previa waitlist_waiting y quota_exceeded),
--    el bloqueo bilateral, outbox de eventos de dominio e inbox canónico del host.
--
-- Esta migración restaura íntegramente el contrato canónico de la versión 20261024220000
-- (concurrencia FOR SHARE, cupos, lista de espera, estados, rate limiting, duplicados por
--  unique_violation, outbox e inbox) preservando el hermetismo de can_access_pre_launch().
-- ==============================================================================

BEGIN;

-- 1. Registrar alias de acción en rate_limit_policies por retrocompatibilidad
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES 
    ('join_request', 12, 3600, true),
    ('join_open_encounter', 12, 3600, true),
    ('request_open_encounter', 12, 3600, true)
ON CONFLICT (action) DO UPDATE SET enabled = true;

-- 2. Corrección Integral de la RPC solicitar_sumarse_encuentro_abierto (Contrato Canónico + PRE-LAUNCH)
CREATE OR REPLACE FUNCTION public.solicitar_sumarse_encuentro_abierto(
    p_encuentro_id UUID,
    p_nombre TEXT,
    p_mensaje TEXT DEFAULT NULL,
    p_usuario_id UUID DEFAULT NULL,
    p_seat_count INT DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats INT := 0;
    v_reserved_seats INT := 0;
    v_solicitud_id UUID;
    v_clean_nombre TEXT;
    v_rejected_at TIMESTAMPTZ;
    v_rl JSONB;
    v_effective_seat_count INT := 1;
    v_available_seats INT;
    v_notif_body TEXT;
    v_min_seats INT := 1;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- GUARDA PRE-LANZAMIENTO FAIL-CLOSED:
    IF NOT public.can_access_pre_launch() THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'pre_launch_restricted',
            'message', 'Las solicitudes para sumarse están restringidas a usuarios de pruebas autorizados durante el pre-lanzamiento.'
        );
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_clean_nombre := pg_catalog.btrim(COALESCE(p_nombre, ''));
    IF pg_catalog.length(v_clean_nombre) < 2 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_name');
    END IF;

    -- Concurrencia: FOR SHARE bloquea lectura stale
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.is_open <> true OR v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_available');
    END IF;

    IF COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'inscriptions_closed',
            'message', 'Las inscripciones para este encuentro están cerradas.'
        );
    END IF;

    IF v_encuentro.moderation_status <> 'approved' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'content_not_approved');
    END IF;

    IF v_encuentro.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_request_own_encounter');
    END IF;

    -- Bloqueo bilateral
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_encuentro.host_id)
           OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_available');
    END IF;

    -- Ya solicitado (solicitud activa o en lista de espera)
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado IN ('pending', 'waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_requested');
    END IF;

    -- Ya es participante confirmado
    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_user_id
          AND estado IN ('confirmado', 'asistio')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_joined');
    END IF;

    -- Cooldown de rechazos (24 horas)
    SELECT COALESCE(resolved_at, updated_at, created_at)
    INTO v_rejected_at
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
      AND estado = 'rejected'
    ORDER BY COALESCE(resolved_at, updated_at, created_at) DESC
    LIMIT 1;

    IF v_rejected_at IS NOT NULL AND v_rejected_at > (v_now - INTERVAL '24 hours') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cooldown_active');
    END IF;

    -- Validar cupo real considerando confirmados y reservas temporales de lista de espera
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_reserved_seats
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id AND estado IN ('waitlist_offered', 'waitlist_confirmed');

    v_available_seats := GREATEST(0, v_encuentro.max_participants - (v_confirmed_seats + v_reserved_seats));

    -- Si no hay cupos o ya hay candidatos esperando en cola FIFO, rechazar con quota_exceeded para dirigir a waitlist
    IF v_available_seats <= 0 OR EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id AND estado = 'waitlist_waiting'
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    v_min_seats := COALESCE(v_encuentro.min_seats_per_request, 1);

    IF v_available_seats < v_min_seats THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    IF COALESCE(v_encuentro.allow_multi_seat_requests, false) = true THEN
        v_effective_seat_count := GREATEST(1, COALESCE(p_seat_count, 1));
        IF v_effective_seat_count < v_min_seats THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'below_min_seats_per_request');
        END IF;
        IF v_effective_seat_count > COALESCE(v_encuentro.max_seats_per_request, 1) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'exceeds_max_seats_per_request');
        END IF;
        IF v_effective_seat_count > v_available_seats THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
        END IF;
    ELSE
        IF p_seat_count IS NOT NULL AND p_seat_count > 1 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'multi_seat_disabled');
        END IF;
        v_effective_seat_count := 1;
    END IF;

    -- Rate limit canónico
    v_rl := public.verificar_y_consumir_rate_limit(v_user_id, 'join_request', 5, INTERVAL '1 hour');
    IF (v_rl->>'allowed')::boolean = false THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'rate_limit_exceeded',
            'reset_at', v_rl->>'reset_at'
        );
    END IF;

    -- Inserción canónica segura (con estado 'pending') y captura de unique_violation
    BEGIN
        INSERT INTO public.solicitudes_encuentro_abierto (
            encuentro_id,
            usuario_id,
            nombre_solicitante,
            mensaje,
            estado,
            seat_count,
            created_at,
            updated_at
        ) VALUES (
            p_encuentro_id,
            v_user_id,
            v_clean_nombre,
            NULLIF(pg_catalog.btrim(COALESCE(p_mensaje, '')), ''),
            'pending',
            v_effective_seat_count,
            v_now,
            v_now
        )
        RETURNING id INTO v_solicitud_id;
    EXCEPTION
        WHEN unique_violation THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_requested');
    END;

    -- Outbox de eventos de dominio
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
        'encounter.join_request.created.v1',
        1,
        'encounter',
        p_encuentro_id,
        v_user_id,
        pg_catalog.jsonb_build_object(
            'request_id', v_solicitud_id,
            'encounter_id', p_encuentro_id,
            'applicant_id', v_user_id,
            'host_id', v_encuentro.host_id,
            'seat_count', v_effective_seat_count
        ),
        pg_catalog.format('encounter:%s:join_request:%s', p_encuentro_id, v_solicitud_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    -- Notificación en Inbox del host
    v_notif_body := CASE
        WHEN v_effective_seat_count > 1 THEN v_clean_nombre || ' solicitó ' || v_effective_seat_count || ' lugares.'
        ELSE v_clean_nombre || ' solicitó 1 lugar.'
    END;

    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_encuentro.host_id,
        p_notification_type := 'open_encounter_join_requested',
        p_target_type := 'encounter',
        p_target_id := p_encuentro_id,
        p_deep_link := '/meet/' || p_encuentro_id || '#solicitudes',
        p_title := 'Nueva solicitud para sumarse',
        p_body := v_notif_body,
        p_payload := pg_catalog.jsonb_build_object(
            'encounter_id', p_encuentro_id,
            'request_id', v_solicitud_id,
            'applicant_id', v_user_id,
            'applicant_name', v_clean_nombre,
            'seat_count', v_effective_seat_count
        ),
        p_dedup_key := 'join_requested:' || v_solicitud_id
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', v_solicitud_id,
        'solicitud_id', v_solicitud_id,
        'encuentro_id', p_encuentro_id,
        'estado', 'pending',
        'seat_count', v_effective_seat_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) TO anon, authenticated, postgres, service_role;

COMMIT;
