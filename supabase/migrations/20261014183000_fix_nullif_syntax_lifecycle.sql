-- ============================================================
-- Migración: 20261014183000_fix_nullif_syntax_lifecycle.sql
-- Propósito:
--   Corregir sintaxis NULLIF en funciones de lifecycle para compatibilidad con PostgreSQL.
--   En PostgreSQL estándar, NULLIF es un constructor sintáctico del lenguaje SQL y no una función
--   residente en pg_catalog.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cancelar_encuentro_seguro(
    p_encuentro_id uuid,
    p_host_id uuid,
    p_cancellation_reason text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_title text;
    v_datetime_label text;
    v_clean_reason text;
    v_has_affected boolean := false;
    v_sol record;
    v_part record;
    v_notif_body text;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- Idempotencia: si ya está cancelado, retornar éxito sin repetir efectos
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'id', p_encuentro_id,
            'estado', 'cancelado',
            'cancellation_reason', v_encuentro.cancellation_reason
        );
    END IF;

    v_clean_reason := NULLIF(pg_catalog.btrim(COALESCE(p_cancellation_reason, '')), '');

    -- Comprobar si existen terceros afectados (solicitudes pendientes o participantes confirmados)
    SELECT (
        EXISTS (
            SELECT 1 FROM public.participantes
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_user_id
        ) OR EXISTS (
            SELECT 1 FROM public.solicitudes_encuentro_abierto
            WHERE encuentro_id = p_encuentro_id
              AND estado = 'pending'
        )
    ) INTO v_has_affected;

    -- Si hay usuarios afectados, el motivo es OBLIGATORIO (mínimo 3 caracteres)
    IF v_has_affected AND (v_clean_reason IS NULL OR pg_catalog.length(v_clean_reason) < 3) THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'cancellation_reason_required',
            'message', 'Debés indicar un motivo de cancelación para avisar a los participantes o solicitantes.'
        );
    END IF;

    -- 1. Marcar encuentro como cancelado e inmediatamente cerrar Discovery
    UPDATE public.encuentros
    SET estado = 'cancelado',
        is_open = false,
        cancelled_at = pg_catalog.now(),
        cancelled_by = v_user_id,
        cancellation_reason = v_clean_reason
    WHERE id = p_encuentro_id;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');
    v_datetime_label := CASE
        WHEN v_encuentro.fecha IS NOT NULL AND v_encuentro.hora IS NOT NULL THEN
            pg_catalog.to_char(v_encuentro.fecha, 'DD/MM/YYYY') || ' ' || pg_catalog.to_char(v_encuentro.hora, 'HH24:MI')
        WHEN v_encuentro.fecha IS NOT NULL THEN
            pg_catalog.to_char(v_encuentro.fecha, 'DD/MM/YYYY')
        ELSE 'Fecha a coordinar'
    END;

    -- 2. Transicionar solicitudes pendientes a 'cancelled' y notificar a cada solicitante
    FOR v_sol IN
        SELECT id, usuario_id, nombre_solicitante
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND estado = 'pending'
    LOOP
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'cancelled',
            resolved_at = pg_catalog.now(),
            updated_at = pg_catalog.now()
        WHERE id = v_sol.id;

        v_notif_body := 'Tu solicitud quedó sin efecto porque el encuentro fue cancelado' ||
            CASE WHEN v_clean_reason IS NOT NULL THEN ': ' || v_clean_reason ELSE '.' END;

        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_sol.usuario_id,
            p_notification_type := 'open_encounter_request_cancelled_by_host',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/?tab=solicitudes',
            p_title := 'Encuentro cancelado',
            p_body := v_notif_body,
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'request_id', v_sol.id,
                'title', v_title,
                'cancellation_reason', v_clean_reason,
                'priority', 'critical'
            ),
            p_dedup_key := 'cancelled_req:' || v_sol.id
        );
    END LOOP;

    -- 3. Notificar a los participantes confirmados
    FOR v_part IN
        SELECT DISTINCT user_id
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio')
          AND user_id IS NOT NULL
          AND user_id <> v_user_id
    LOOP
        v_notif_body := v_title || ' (' || v_datetime_label || ') fue cancelado' ||
            CASE WHEN v_clean_reason IS NOT NULL THEN ': ' || v_clean_reason ELSE '.' END;

        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_part.user_id,
            p_notification_type := 'encounter_cancelled_for_participant',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/?tab=encuentros',
            p_title := 'Encuentro cancelado',
            p_body := v_notif_body,
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'title', v_title,
                'original_date_label', v_datetime_label,
                'cancellation_reason', v_clean_reason,
                'priority', 'critical'
            ),
            p_dedup_key := 'cancelled_part:' || p_encuentro_id || ':' || v_part.user_id
        );
    END LOOP;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'estado', 'cancelado',
        'cancellation_reason', v_clean_reason
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_encuentro_seguro(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_encuentro_seguro(uuid, uuid, text) TO authenticated;


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
    v_solicitud_id UUID;
    v_clean_nombre TEXT;
    v_rejected_at TIMESTAMPTZ;
    v_rl JSONB;
    v_effective_seat_count INT := 1;
    v_available_seats INT;
    v_notif_body TEXT;
    v_min_seats INT := 1;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_clean_nombre := pg_catalog.btrim(COALESCE(p_nombre, ''));
    IF pg_catalog.length(v_clean_nombre) < 2 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_name');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.is_open <> true OR v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_available');
    END IF;

    -- INVARIANTE: Bloqueo cuando las inscripciones están cerradas por el host
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

    -- Validar bloqueos bilaterales
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_encuentro.host_id)
           OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_available');
    END IF;

    -- Rate limiting
    v_rl := public.verificar_y_consumir_rate_limit(v_user_id, 'join_request', 5, INTERVAL '1 hour');
    IF (v_rl->>'allowed')::boolean = false THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'rate_limit_exceeded',
            'reset_at', v_rl->>'reset_at'
        );
    END IF;

    -- Validar cupos disponibles
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    v_available_seats := GREATEST(0, v_encuentro.max_participants - v_confirmed_seats);

    IF v_available_seats <= 0 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    -- Multi-seat y límites
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

    -- Comprobar solicitud existente
    SELECT resolved_at INTO v_rejected_at
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id AND usuario_id = v_user_id AND estado = 'rejected';

    IF FOUND THEN
        IF v_rejected_at IS NOT NULL AND v_rejected_at > (pg_catalog.now() - INTERVAL '24 hours') THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'cooldown_active');
        ELSE
            DELETE FROM public.solicitudes_encuentro_abierto
            WHERE encuentro_id = p_encuentro_id AND usuario_id = v_user_id;
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id AND usuario_id = v_user_id AND estado = 'pending'
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_requested');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id AND user_id = v_user_id AND estado IN ('confirmado', 'asistio')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_joined');
    END IF;

    INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id,
        usuario_id,
        nombre_solicitante,
        mensaje,
        estado,
        seat_count
    ) VALUES (
        p_encuentro_id,
        v_user_id,
        v_clean_nombre,
        NULLIF(pg_catalog.btrim(COALESCE(p_mensaje, '')), ''),
        'pending',
        v_effective_seat_count
    )
    RETURNING id INTO v_solicitud_id;

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
        'solicitud_id', v_solicitud_id,
        'seat_count', v_effective_seat_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) TO authenticated;

COMMIT;
