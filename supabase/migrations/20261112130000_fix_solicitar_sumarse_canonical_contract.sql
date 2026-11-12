-- ==============================================================================
-- Migración Aditiva: Corrección de Contrato Canónico en solicitar_sumarse_encuentro_abierto
-- Timestamp: 20261112130000
-- Archivo: 20261112130000_fix_solicitar_sumarse_canonical_contract.sql
--
-- Diagnóstico de Regresión:
-- 1. La migración 20261112120000 introdujo ON CONFLICT (encuentro_id, usuario_id) sin
--    índice único total correspondiente (el índice idx_solicitudes_activas_unicas es parcial).
-- 2. El estado insertado era 'pendiente' en lugar de 'pending' (violando el check constraint).
-- 3. La acción de rate limit llamada era 'request_open_encounter' en lugar de 'join_open_encounter'.
--
-- Esta migración restaura la semántica canónica de inserción y lista de espera
-- preservando el hermetismo de la guarda can_access_pre_launch().
-- ==============================================================================

BEGIN;

-- 1. Registrar alias de acción en rate_limit_policies por retrocompatibilidad
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES 
    ('join_open_encounter', 12, 3600, true),
    ('request_open_encounter', 12, 3600, true)
ON CONFLICT (action) DO UPDATE SET enabled = true;

-- 2. Corrección de la RPC solicitar_sumarse_encuentro_abierto
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
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF NOT v_encuentro.is_open THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_an_open_encounter');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_cancelled');
    END IF;

    IF v_encuentro.moderation_status <> 'approved' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_approved');
    END IF;

    IF COALESCE(v_encuentro.inscriptions_closed, false) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'inscriptions_closed');
    END IF;

    IF v_encuentro.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_join_own_encounter');
    END IF;

    -- Validar temporalidad en timezone de Argentina
    IF (v_encuentro.fecha IS NOT NULL AND v_encuentro.fecha < (pg_catalog.timezone('America/Argentina/Buenos_Aires', v_now))::date)
       OR (v_encuentro.fecha = (pg_catalog.timezone('America/Argentina/Buenos_Aires', v_now))::date
           AND v_encuentro.hora IS NOT NULL
           AND v_encuentro.hora < (pg_catalog.timezone('America/Argentina/Buenos_Aires', v_now))::time)
    THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_expired');
    END IF;

    -- Comprobar si ya tiene solicitud activa (pending o waitlist)
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado IN ('pending', 'approved', 'waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_requested');
    END IF;

    -- Comprobar si ya es participante confirmado
    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_user_id
          AND estado IN ('confirmado', 'asistio')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_joined');
    END IF;

    -- Multi-seat validation
    IF COALESCE(v_encuentro.allow_multi_seat_requests, false) THEN
        v_min_seats := COALESCE(v_encuentro.min_seats_per_request, 1);
        v_effective_seat_count := COALESCE(p_seat_count, 1);
        IF v_effective_seat_count < v_min_seats OR v_effective_seat_count > COALESCE(v_encuentro.max_seats_per_request, 1) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_seat_count');
        END IF;
    ELSE
        v_effective_seat_count := 1;
    END IF;

    -- Rate limit (usa acción canónica 'join_open_encounter')
    v_rl := public.check_rate_limit_internal('join_open_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- Cooldown de rechazos (24 horas)
    SELECT updated_at INTO v_rejected_at
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
      AND estado = 'rejected'
    ORDER BY updated_at DESC
    LIMIT 1;

    IF v_rejected_at IS NOT NULL AND (v_now - v_rejected_at) < INTERVAL '24 hours' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_cooldown_active');
    END IF;

    -- Estado de cupos
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    SELECT COALESCE(pg_catalog.sum(CASE WHEN estado IN ('waitlist_offered', 'waitlist_confirmed') THEN seat_count ELSE 0 END), 0)::int
    INTO v_reserved_seats
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id;

    v_available_seats := GREATEST(0, v_encuentro.max_participants - (v_confirmed_seats + v_reserved_seats));

    IF v_available_seats < v_effective_seat_count THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'capacity_exceeded');
    END IF;

    -- Inserción canónica segura (con estado 'pending')
    BEGIN
        INSERT INTO public.solicitudes_encuentro_abierto (
            encuentro_id, usuario_id, nombre_solicitante, mensaje, seat_count, estado, created_at, updated_at
        )
        VALUES (
            p_encuentro_id, v_user_id, v_clean_nombre, pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_mensaje, '')), ''), v_effective_seat_count, 'pending', v_now, v_now
        )
        RETURNING id INTO v_solicitud_id;
    EXCEPTION
        WHEN unique_violation THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_requested');
    END;

    -- Notificación al host
    v_notif_body := CASE
        WHEN v_effective_seat_count > 1 THEN v_clean_nombre || ' solicitó ' || v_effective_seat_count::text || ' lugares para tu encuentro abierto.'
        ELSE v_clean_nombre || ' solicitó sumarse a tu encuentro abierto.'
    END;

    PERFORM public.insertar_inbox_notification_seguro(
        v_encuentro.host_id,
        'solicitud_recibida',
        'encounter',
        p_encuentro_id,
        '/?open_encounter=' || p_encuentro_id::text,
        'Nueva solicitud de encuentro abierto',
        v_notif_body,
        pg_catalog.json_build_object(
            'solicitud_id', v_solicitud_id,
            'nombre_solicitante', v_clean_nombre,
            'seat_count', v_effective_seat_count,
            'mensaje', p_mensaje
        ),
        'solicitud:' || v_solicitud_id::text
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'solicitud_id', v_solicitud_id,
        'estado', 'pending',
        'seat_count', v_effective_seat_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) TO anon, authenticated, postgres, service_role;

COMMIT;
