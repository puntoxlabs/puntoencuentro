-- ============================================================
-- Migración: 20261014180000_fase_lifecycle_realization_and_cancellation_reasons.sql
-- Propósito:
--   1. Encuentros completos visibles en Discovery con filtro opcional de disponibles.
--   2. Motivo obligatorio de cancelación ante usuarios afectados con trazabilidad completa.
--   3. Cancelación como evento crítico (inbox de alta prioridad, push trigger e in-app modal).
--   4. Mínimo de participantes (min_participants) físico, estados de realización (pending, confirmed, forced),
--      "Hacerlo igual", aviso al caer del mínimo y dedupe de notificación.
--   5. Cierre y reapertura de inscripciones independiente de realización y bloqueo en solicitudes.
--   6. Confirmación final al cerrar inscripciones y flujo de reconfirmación de asistencia ("¿Seguís viniendo?").
--   7. Bloqueo estricto de reapertura de encuentros cancelados.
-- ============================================================

BEGIN;

-- 1. ESQUEMA: columnas adicionales en public.encuentros
ALTER TABLE public.encuentros
    ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES auth.users(id),
    ADD COLUMN IF NOT EXISTS cancellation_reason TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS min_participants INT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS realization_status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS inscriptions_closed BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS inscriptions_closed_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS min_confirmed_notified_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS final_confirmation_notified_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE public.encuentros
    DROP CONSTRAINT IF EXISTS encuentros_min_participants_check;

ALTER TABLE public.encuentros
    ADD CONSTRAINT encuentros_min_participants_check
    CHECK (min_participants IS NULL OR min_participants >= 1);

ALTER TABLE public.encuentros
    DROP CONSTRAINT IF EXISTS encuentros_realization_status_check;

ALTER TABLE public.encuentros
    ADD CONSTRAINT encuentros_realization_status_check
    CHECK (realization_status IN ('pending', 'confirmed', 'forced'));


-- 2. ESQUEMA: columnas adicionales en public.participantes
ALTER TABLE public.participantes
    ADD COLUMN IF NOT EXISTS reconfirmation_status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS reconfirmed_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE public.participantes
    DROP CONSTRAINT IF EXISTS participantes_reconfirmation_status_check;

ALTER TABLE public.participantes
    ADD CONSTRAINT participantes_reconfirmation_status_check
    CHECK (reconfirmation_status IN ('pending', 'confirmed', 'declined'));


-- 3. RPC CANCELAR ENCUENTRO SEGURO (CON MOTIVO OBLIGATORIO Y TRAZABILIDAD CRÍTICA)
DROP FUNCTION IF EXISTS public.cancelar_encuentro_seguro(uuid, uuid);
DROP FUNCTION IF EXISTS public.cancelar_encuentro_seguro(uuid, uuid, text);

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


-- 4. RPC SET_MIN_PARTICIPANTS_SEGURO (GESTIÓN DEL MÍNIMO Y RECÁLCULO ATÓMICO)
CREATE OR REPLACE FUNCTION public.set_min_participants_seguro(
    p_encuentro_id uuid,
    p_host_id uuid,
    p_min_participants int
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats int := 0;
    v_old_status text;
    v_new_status text;
    v_part record;
    v_title text;
    v_now timestamptz := pg_catalog.now();
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

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_modify_cancelled_encounter');
    END IF;

    IF p_min_participants IS NOT NULL AND p_min_participants < 1 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_min_participants');
    END IF;

    IF p_min_participants IS NOT NULL AND v_encuentro.max_participants IS NOT NULL AND p_min_participants > v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'min_participants_exceeds_max');
    END IF;

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    v_old_status := v_encuentro.realization_status;

    IF p_min_participants IS NULL THEN
        v_new_status := 'pending';
    ELSIF v_encuentro.realization_status = 'forced' THEN
        v_new_status := 'forced';
    ELSIF v_confirmed_seats >= p_min_participants THEN
        v_new_status := 'confirmed';
    ELSE
        v_new_status := 'pending';
    END IF;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

    -- Transición pending -> confirmed por primera vez
    IF v_old_status = 'pending' AND v_new_status = 'confirmed' AND v_encuentro.min_confirmed_notified_at IS NULL THEN
        UPDATE public.encuentros
        SET min_participants = p_min_participants,
            realization_status = v_new_status,
            min_confirmed_notified_at = v_now
        WHERE id = p_encuentro_id;

        FOR v_part IN
            SELECT DISTINCT user_id
            FROM public.participantes
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_user_id
        LOOP
            PERFORM public.insertar_inbox_notification_seguro(
                p_recipient_user_id := v_part.user_id,
                p_notification_type := 'encounter_min_participants_reached',
                p_target_type := 'encounter',
                p_target_id := p_encuentro_id,
                p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
                p_title := '¡Se hace!',
                p_body := '¡Se hace! El encuentro alcanzó el mínimo de participantes.',
                p_payload := pg_catalog.jsonb_build_object(
                    'encounter_id', p_encuentro_id,
                    'title', v_title
                ),
                p_dedup_key := 'min_reached:' || p_encuentro_id || ':' || v_part.user_id
            );
        END LOOP;
    -- Transición confirmed -> pending (si bajó el mínimo o aumentaron el requisito)
    ELSIF v_old_status = 'confirmed' AND v_new_status = 'pending' THEN
        UPDATE public.encuentros
        SET min_participants = p_min_participants,
            realization_status = v_new_status,
            min_confirmed_notified_at = NULL
        WHERE id = p_encuentro_id;

        -- Notificar al host
        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_user_id,
            p_notification_type := 'encounter_below_min_participants',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/meet/' || p_encuentro_id,
            p_title := 'Mínimo de participantes',
            p_body := 'El encuentro volvió a quedar por debajo del mínimo de participantes.',
            p_payload := pg_catalog.jsonb_build_object('encounter_id', p_encuentro_id, 'title', v_title),
            p_dedup_key := 'below_min_host:' || p_encuentro_id || ':' || pg_catalog.to_char(v_now, 'YYYYMMDDHH24MISS')
        );

        -- Notificar a participantes confirmados
        FOR v_part IN
            SELECT DISTINCT user_id
            FROM public.participantes
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_user_id
        LOOP
            PERFORM public.insertar_inbox_notification_seguro(
                p_recipient_user_id := v_part.user_id,
                p_notification_type := 'encounter_below_min_participants',
                p_target_type := 'encounter',
                p_target_id := p_encuentro_id,
                p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
                p_title := 'Mínimo de participantes',
                p_body := 'El encuentro volvió a quedar por debajo del mínimo de participantes.',
                p_payload := pg_catalog.jsonb_build_object('encounter_id', p_encuentro_id, 'title', v_title),
                p_dedup_key := 'below_min_part:' || p_encuentro_id || ':' || v_part.user_id || ':' || pg_catalog.to_char(v_now, 'YYYYMMDDHH24MISS')
            );
        END LOOP;
    ELSE
        UPDATE public.encuentros
        SET min_participants = p_min_participants,
            realization_status = v_new_status
        WHERE id = p_encuentro_id;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'min_participants', p_min_participants,
        'realization_status', v_new_status,
        'confirmed_seats', v_confirmed_seats
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_min_participants_seguro(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_min_participants_seguro(uuid, uuid, int) TO authenticated;


-- 5. RPC HACERLO_IGUAL_SEGURO (REALIZACIÓN FORZADA PERSISTENTE)
CREATE OR REPLACE FUNCTION public.hacerlo_igual_seguro(
    p_encuentro_id uuid,
    p_host_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_part record;
    v_title text;
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

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_modify_cancelled_encounter');
    END IF;

    UPDATE public.encuentros
    SET realization_status = 'forced'
    WHERE id = p_encuentro_id;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

    -- Notificar a participantes confirmados
    FOR v_part IN
        SELECT DISTINCT user_id
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio')
          AND user_id IS NOT NULL
          AND user_id <> v_user_id
    LOOP
        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_part.user_id,
            p_notification_type := 'encounter_realization_forced',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
            p_title := 'El encuentro se realizará',
            p_body := 'El anfitrión confirmó que el encuentro se realizará.',
            p_payload := pg_catalog.jsonb_build_object('encounter_id', p_encuentro_id, 'title', v_title),
            p_dedup_key := 'forced_realization:' || p_encuentro_id || ':' || v_part.user_id
        );
    END LOOP;

    RETURN pg_catalog.json_build_object('ok', true, 'realization_status', 'forced');
END;
$$;

REVOKE ALL ON FUNCTION public.hacerlo_igual_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hacerlo_igual_seguro(uuid, uuid) TO authenticated;


-- 6. RPC CERRAR_INSCRIPCIONES_SEGURO (CIERRE INDEPENDIENTE + CONFIRMACIÓN FINAL)
CREATE OR REPLACE FUNCTION public.cerrar_inscripciones_seguro(
    p_encuentro_id uuid,
    p_host_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_part record;
    v_title text;
    v_now timestamptz := pg_catalog.now();
    v_is_confirmed boolean := false;
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

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_modify_cancelled_encounter');
    END IF;

    v_is_confirmed := (v_encuentro.realization_status IN ('confirmed', 'forced'));

    UPDATE public.encuentros
    SET inscriptions_closed = true,
        inscriptions_closed_at = v_now,
        final_confirmation_notified_at = CASE
            WHEN v_is_confirmed AND final_confirmation_notified_at IS NULL THEN v_now
            ELSE final_confirmation_notified_at
        END
    WHERE id = p_encuentro_id;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

    -- Si el encuentro está confirmado o forzado, enviar notificación de confirmación final
    IF v_is_confirmed AND v_encuentro.final_confirmation_notified_at IS NULL THEN
        FOR v_part IN
            SELECT DISTINCT user_id
            FROM public.participantes
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_user_id
        LOOP
            PERFORM public.insertar_inbox_notification_seguro(
                p_recipient_user_id := v_part.user_id,
                p_notification_type := 'encounter_final_confirmation',
                p_target_type := 'encounter',
                p_target_id := p_encuentro_id,
                p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
                p_title := 'Encuentro confirmado',
                p_body := 'El encuentro está confirmado. ¿Seguís viniendo?',
                p_payload := pg_catalog.jsonb_build_object(
                    'encounter_id', p_encuentro_id,
                    'title', v_title,
                    'action_required', 'reconfirm'
                ),
                p_dedup_key := 'final_conf:' || p_encuentro_id || ':' || v_part.user_id
            );
        END LOOP;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'inscriptions_closed', true,
        'final_confirmation_sent', v_is_confirmed
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_inscripciones_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cerrar_inscripciones_seguro(uuid, uuid) TO authenticated;


-- 7. RPC REABRIR_INSCRIPCIONES_SEGURO (REAPERTURA INDEPENDIENTE, BLOQUEO DE CANCELADOS)
CREATE OR REPLACE FUNCTION public.reabrir_inscripciones_seguro(
    p_encuentro_id uuid,
    p_host_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
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

    -- INVARIANTE: Bloquear reapertura de encuentros cancelados
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_reopen_cancelled_encounter');
    END IF;

    UPDATE public.encuentros
    SET inscriptions_closed = false,
        inscriptions_closed_at = NULL
    WHERE id = p_encuentro_id;

    RETURN pg_catalog.json_build_object('ok', true, 'inscriptions_closed', false);
END;
$$;

REVOKE ALL ON FUNCTION public.reabrir_inscripciones_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reabrir_inscripciones_seguro(uuid, uuid) TO authenticated;


-- 8. RPC RECONFIRMAR_ASISTENCIA_SEGURO (CONFIRM / DECLINE + LIBERACIÓN Y RECÁLCULO)
CREATE OR REPLACE FUNCTION public.reconfirmar_asistencia_seguro(
    p_encuentro_id uuid,
    p_decision text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_part public.participantes%ROWTYPE;
    v_new_confirmed_seats int := 0;
    v_part_rec record;
    v_title text;
    v_now timestamptz := pg_catalog.now();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF p_decision NOT IN ('confirm', 'decline') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_decision');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    SELECT * INTO v_part
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id
      AND user_id = v_user_id
      AND estado IN ('confirmado', 'asistio')
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'participant_not_found');
    END IF;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

    IF p_decision = 'confirm' THEN
        UPDATE public.participantes
        SET reconfirmation_status = 'confirmed',
            reconfirmed_at = v_now
        WHERE id = v_part.id;

        RETURN pg_catalog.json_build_object(
            'ok', true,
            'decision', 'confirm',
            'reconfirmation_status', 'confirmed'
        );
    ELSE
        -- Decision = 'decline': libera lugares (estado = 'cancelado') y guarda estado de reconfirmación
        UPDATE public.participantes
        SET reconfirmation_status = 'declined',
            reconfirmed_at = v_now,
            estado = 'cancelado'
        WHERE id = v_part.id;

        -- Recalcular cupos confirmados
        SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
        INTO v_new_confirmed_seats
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio');

        -- Si cae por debajo del mínimo y estaba 'confirmed' (no forzado), volver a pending
        IF v_encuentro.min_participants IS NOT NULL
           AND v_encuentro.realization_status = 'confirmed'
           AND v_new_confirmed_seats < v_encuentro.min_participants THEN

            UPDATE public.encuentros
            SET realization_status = 'pending',
                min_confirmed_notified_at = NULL
            WHERE id = p_encuentro_id;

            -- Notificar al host
            PERFORM public.insertar_inbox_notification_seguro(
                p_recipient_user_id := v_encuentro.host_id,
                p_notification_type := 'encounter_below_min_participants',
                p_target_type := 'encounter',
                p_target_id := p_encuentro_id,
                p_deep_link := '/meet/' || p_encuentro_id,
                p_title := 'Mínimo de participantes',
                p_body := 'El encuentro volvió a quedar por debajo del mínimo de participantes.',
                p_payload := pg_catalog.jsonb_build_object('encounter_id', p_encuentro_id, 'title', v_title),
                p_dedup_key := 'below_min_host:' || p_encuentro_id || ':' || pg_catalog.to_char(v_now, 'YYYYMMDDHH24MISS')
            );

            -- Notificar a participantes restantes confirmados
            FOR v_part_rec IN
                SELECT DISTINCT user_id
                FROM public.participantes
                WHERE encuentro_id = p_encuentro_id
                  AND estado IN ('confirmado', 'asistio')
                  AND user_id IS NOT NULL
                  AND user_id <> v_encuentro.host_id
                  AND user_id <> v_user_id
            LOOP
                PERFORM public.insertar_inbox_notification_seguro(
                    p_recipient_user_id := v_part_rec.user_id,
                    p_notification_type := 'encounter_below_min_participants',
                    p_target_type := 'encounter',
                    p_target_id := p_encuentro_id,
                    p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
                    p_title := 'Mínimo de participantes',
                    p_body := 'El encuentro volvió a quedar por debajo del mínimo de participantes.',
                    p_payload := pg_catalog.jsonb_build_object('encounter_id', p_encuentro_id, 'title', v_title),
                    p_dedup_key := 'below_min_part:' || p_encuentro_id || ':' || v_part_rec.user_id || ':' || pg_catalog.to_char(v_now, 'YYYYMMDDHH24MISS')
                );
            END LOOP;
        END IF;

        RETURN pg_catalog.json_build_object(
            'ok', true,
            'decision', 'decline',
            'reconfirmation_status', 'declined',
            'released_seats', v_part.seat_count
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text) TO authenticated;


-- 9. ACTUALIZAR APROBAR_SOLICITUD_ENCUENTRO_ABIERTO (SOPORTE PARA min_participants)
CREATE OR REPLACE FUNCTION public.aprobar_solicitud_encuentro_abierto(
    p_request_id UUID,
    p_host_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats INT := 0;
    v_participante_id UUID;
    v_token_invitacion UUID;
    v_req_seats INT := 1;
    v_nuevo_disponible INT;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_part record;
    v_title text;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 1. Bloquear y verificar la solicitud
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    IF v_solicitud.estado <> 'pending' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_already_processed');
    END IF;

    -- 2. Bloquear y verificar el encuentro atómicamente
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_solicitud.encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    -- Guard bilateral de bloqueo
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_solicitud.usuario_id)
           OR (b.blocker_id = v_solicitud.usuario_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_available');
    END IF;

    -- 3. Validar cupo real bajo bloqueo exclusivo de fila
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id AND estado IN ('confirmado', 'asistio');

    v_req_seats := COALESCE(v_solicitud.seat_count, 1);

    IF (v_confirmed_seats + v_req_seats) > v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    -- 4. Crear participante asignando seat_count aprobado
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

    -- 5. Actualizar solicitud a approved
    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'approved',
        participante_id = v_participante_id,
        token_participante = v_token_invitacion,
        resolved_at = v_now,
        updated_at = v_now
    WHERE id = p_request_id;

    -- 6. Insertar Domain Event en Outbox (auditoría / replay)
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

    -- 7. Notificación en Inbox del solicitante
    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_solicitud.usuario_id,
        p_notification_type := 'open_encounter_request_accepted',
        p_target_type := 'encounter',
        p_target_id := v_encuentro.id,
        p_deep_link := '/?tab=encuentros&open_detail=' || v_encuentro.id,
        p_title := '¡Te aceptaron!',
        p_body := 'Ya formás parte del encuentro.',
        p_payload := pg_catalog.jsonb_build_object(
            'encounter_id', v_encuentro.id,
            'request_id', p_request_id,
            'open_public_title', COALESCE(v_encuentro.open_public_title, 'Encuentro abierto')
        ),
        p_dedup_key := 'join_request_approved:' || p_request_id
    );

    -- 8. Verificación de realización y mínimo de participantes
    IF v_encuentro.min_participants IS NOT NULL THEN
        IF v_encuentro.realization_status = 'pending' AND (v_confirmed_seats + v_req_seats) >= v_encuentro.min_participants THEN
            UPDATE public.encuentros
            SET realization_status = 'confirmed',
                min_confirmed_notified_at = COALESCE(min_confirmed_notified_at, v_now)
            WHERE id = v_encuentro.id;

            IF v_encuentro.min_confirmed_notified_at IS NULL THEN
                v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');
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
                            'title', v_title
                        ),
                        p_dedup_key := 'min_reached:' || v_encuentro.id || ':' || v_part.user_id
                    );
                END LOOP;
            END IF;
        END IF;
    END IF;

    v_nuevo_disponible := GREATEST(0, v_encuentro.max_participants - (v_confirmed_seats + v_req_seats));

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', p_request_id,
        'participante_id', v_participante_id,
        'token_invitacion', v_token_invitacion,
        'seat_count', v_req_seats,
        'nuevo_cupo_disponible', v_nuevo_disponible
    );
END;
$$;

REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) TO authenticated;


-- 10. ACTUALIZAR SOLICITAR_SUMARSE_ENCUENTRO_ABIERTO (BLOQUEO POR INSCRIPCIONES CERRADAS)
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


-- 11. ACTUALIZAR GET_DISCOVERY_ENCUENTROS_ABIERTOS (PROYECCIÓN DE REALIZACIÓN, CIERRE DE INSCRIPCIONES Y FILTRO OPCIONAL)
DROP FUNCTION IF EXISTS public.get_discovery_encuentros_abiertos(TEXT[]);
DROP FUNCTION IF EXISTS public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN);

CREATE OR REPLACE FUNCTION public.get_discovery_encuentros_abiertos(
    p_locality_ids TEXT[] DEFAULT NULL,
    p_only_available BOOLEAN DEFAULT false
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_blocked_host_ids UUID[] := '{}';
    v_result JSON;
BEGIN
    IF v_user_id IS NOT NULL THEN
        SELECT COALESCE(pg_catalog.array_agg(DISTINCT blocked_user_id), '{}')
        INTO v_blocked_host_ids
        FROM (
            SELECT blocked_id AS blocked_user_id
            FROM public.bloqueos_usuario
            WHERE blocker_id = v_user_id
            UNION
            SELECT blocker_id AS blocked_user_id
            FROM public.bloqueos_usuario
            WHERE blocked_id = v_user_id
        ) b;
    END IF;

    SELECT pg_catalog.json_agg(row_data) INTO v_result
    FROM (
        SELECT
            e.id,
            e.open_public_title AS title,
            e.open_description AS description,
            e.fecha,
            e.hora,
            e.modalidad,
            e.max_participants AS slots,
            e.max_participants AS public_capacity,
            COALESCE(e.allow_multi_seat_requests, false) AS allow_multi_seat_requests,
            COALESCE(e.max_seats_per_request, 1) AS max_seats_per_request,
            COALESCE(e.min_seats_per_request, 1) AS min_seats_per_request,
            e.min_participants,
            COALESCE(e.realization_status, 'pending') AS realization_status,
            COALESCE(e.inscriptions_closed, false) AS inscriptions_closed,
            (v_user_id IS NOT NULL AND e.host_id = v_user_id) AS is_host,
            e.locality_id,
            e.open_public_zone,
            COALESCE(e.open_public_zone, l.nombre, 'Sin zona') AS approximate_zone,
            e.host_id,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_count,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_seats,
            COALESCE(p_agg.confirmed_requests, 0) AS confirmed_requests,
            GREATEST(0, e.max_participants - COALESCE(p_agg.confirmed_seats, 0)) AS open_slots,
            CASE
                WHEN e.fecha IS NULL THEN 'Fecha a coordinar'
                ELSE pg_catalog.to_char(e.fecha, 'DD/MM/YYYY')
            END AS date_label,
            CASE
                WHEN e.hora IS NULL THEN 'Horario a coordinar'
                ELSE pg_catalog.to_char(e.hora, 'HH24:MI')
            END AS time_label,
            e.opened_at,
            e.tema,
            e.tema_invitacion,
            e.open_activity_canonical,
            e.open_activity_matching_eligible
        FROM public.encuentros e
        LEFT JOIN public.localidades l ON l.id = e.locality_id
        LEFT JOIN (
            SELECT
                encuentro_id,
                COALESCE(pg_catalog.sum(seat_count), 0)::int AS confirmed_seats,
                pg_catalog.count(*)::int AS confirmed_requests
            FROM public.participantes
            WHERE estado IN ('confirmado', 'asistio')
            GROUP BY encuentro_id
        ) p_agg ON p_agg.encuentro_id = e.id
        WHERE e.is_open = true
          AND e.estado <> 'cancelado'
          AND e.moderation_status = 'approved'
          AND (
              e.fecha IS NULL
              OR e.fecha > (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::date
              OR (
                  e.fecha = (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::date
                  AND (
                      e.hora IS NULL
                      OR e.hora >= (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::time
                  )
              )
          )
          AND (
              e.host_id <> ALL(v_blocked_host_ids)
          )
          AND (
              p_locality_ids IS NULL
              OR e.locality_id = ANY(p_locality_ids)
              OR e.modalidad = 'virtual'
          )
          AND (
              p_only_available = false
              OR GREATEST(0, e.max_participants - COALESCE(p_agg.confirmed_seats, 0)) > 0
          )
        ORDER BY
            CASE WHEN e.fecha IS NULL THEN 1 ELSE 0 END,
            e.fecha ASC NULLS LAST,
            e.hora ASC NULLS LAST,
            e.opened_at DESC
        LIMIT 50
    ) row_data;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) TO anon, authenticated;


-- 12. ACTUALIZAR GET_ENCUENTRO_PARTICIPANTE_AUTORIZADO (PROYECCIÓN DE MOTIVO, REALIZACIÓN Y RECONFIRMACIÓN)
CREATE OR REPLACE FUNCTION public.get_encuentro_participante_autorizado(
    p_encuentro_id UUID
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
    v_is_host BOOLEAN := false;
    v_is_participant BOOLEAN := false;
    v_part_seats INT := 1;
    v_reconf_status TEXT := 'pending';
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id = v_user_id THEN
        v_is_host := true;
    ELSE
        SELECT EXISTS (
            SELECT 1 FROM public.participantes p
            WHERE p.encuentro_id = p_encuentro_id
              AND p.user_id = v_user_id
              AND p.estado IN ('confirmado', 'asistio')
        ) INTO v_is_participant;

        IF NOT v_is_participant THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        SELECT
            COALESCE(p.seat_count, 1),
            COALESCE(p.reconfirmation_status, 'pending')
        INTO
            v_part_seats,
            v_reconf_status
        FROM public.participantes p
        WHERE p.encuentro_id = p_encuentro_id
          AND p.user_id = v_user_id
          AND p.estado IN ('confirmado', 'asistio')
        LIMIT 1;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', v_encuentro.id,
        'is_host', v_is_host,
        'open_public_title', CASE
            WHEN v_is_host THEN COALESCE(v_encuentro.open_public_title, v_encuentro.titulo)
            ELSE COALESCE(v_encuentro.open_public_title, 'Encuentro')
        END,
        'open_description', CASE
            WHEN v_is_host THEN COALESCE(v_encuentro.open_description, v_encuentro.descripcion)
            ELSE COALESCE(v_encuentro.open_description, '')
        END,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'open_public_zone', v_encuentro.open_public_zone,
        'lugar_texto', CASE
            WHEN v_encuentro.estado = 'cancelado' THEN NULL
            WHEN v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto
            ELSE NULL
        END,
        'link_virtual', CASE
            WHEN v_encuentro.estado = 'cancelado' THEN NULL
            WHEN v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual
            ELSE NULL
        END,
        'seat_count', CASE WHEN v_is_host THEN NULL ELSE v_part_seats END,
        'estado', v_encuentro.estado,
        'cancellation_reason', CASE WHEN v_encuentro.estado = 'cancelado' THEN v_encuentro.cancellation_reason ELSE NULL END,
        'min_participants', v_encuentro.min_participants,
        'realization_status', COALESCE(v_encuentro.realization_status, 'pending'),
        'inscriptions_closed', COALESCE(v_encuentro.inscriptions_closed, false),
        'reconfirmation_status', CASE WHEN v_is_host THEN NULL ELSE v_reconf_status END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_participante_autorizado(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentro_participante_autorizado(UUID) TO authenticated;


-- 13. ACTUALIZAR GET_DETALLE_HOST_SEGURO (PROYECCIÓN DE MÍNIMO, REALIZACIÓN, CIERRE Y TRAZABILIDAD)
CREATE OR REPLACE FUNCTION public.get_detalle_host_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats INT := 0;
    v_confirmed_requests INT := 0;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_host_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('error', 'unauthorized');
    END IF;

    SELECT
        COALESCE(pg_catalog.sum(seat_count), 0)::int,
        pg_catalog.count(*)::int
    INTO
        v_confirmed_seats,
        v_confirmed_requests
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    RETURN pg_catalog.json_build_object(
        'id', v_encuentro.id,
        'titulo', v_encuentro.titulo,
        'open_public_title', v_encuentro.open_public_title,
        'descripcion', v_encuentro.descripcion,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'lugar_texto', v_encuentro.lugar_texto,
        'link_virtual', v_encuentro.link_virtual,
        'tipo_invitacion', v_encuentro.tipo_invitacion,
        'host_id', v_encuentro.host_id,
        'public_token', v_encuentro.public_token,
        'estado', v_encuentro.estado,
        'tema', v_encuentro.tema,
        'tema_invitacion', COALESCE(v_encuentro.tema_invitacion, 'classic'),
        'invitation_template', v_encuentro.invitation_template,
        'reemplaza_a', v_encuentro.reemplaza_a,
        'creado_en', v_encuentro.creado_en,
        'is_open', COALESCE(v_encuentro.is_open, false),
        'open_description', v_encuentro.open_description,
        'max_participants', v_encuentro.max_participants,
        'public_capacity', v_encuentro.max_participants,
        'allow_multi_seat_requests', COALESCE(v_encuentro.allow_multi_seat_requests, false),
        'max_seats_per_request', COALESCE(v_encuentro.max_seats_per_request, 1),
        'min_seats_per_request', COALESCE(v_encuentro.min_seats_per_request, 1),
        'min_participants', v_encuentro.min_participants,
        'realization_status', COALESCE(v_encuentro.realization_status, 'pending'),
        'inscriptions_closed', COALESCE(v_encuentro.inscriptions_closed, false),
        'inscriptions_closed_at', v_encuentro.inscriptions_closed_at,
        'cancelled_at', v_encuentro.cancelled_at,
        'cancelled_by', v_encuentro.cancelled_by,
        'cancellation_reason', v_encuentro.cancellation_reason,
        'confirmed_seats', v_confirmed_seats,
        'confirmed_requests', v_confirmed_requests,
        'available_slots', GREATEST(0, COALESCE(v_encuentro.max_participants, 0) - v_confirmed_seats),
        'locality_id', v_encuentro.locality_id,
        'open_public_zone', v_encuentro.open_public_zone,
        'opened_at', v_encuentro.opened_at,
        'closed_at', v_encuentro.closed_at,
        'moderation_status', v_encuentro.moderation_status
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) TO authenticated;


-- 14. ACTUALIZAR GET_PARTICIPANTES_HOST_SEGURO (PROYECCIÓN DE SEAT_COUNT Y RECONFIRMATION_STATUS)
CREATE OR REPLACE FUNCTION public.get_participantes_host_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_result json;
    v_enc_exists boolean;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.encuentros
        WHERE id = p_encuentro_id AND host_id = v_user_id
    ) INTO v_enc_exists;

    IF NOT v_enc_exists THEN
        RETURN pg_catalog.json_build_object('error', 'encuentro_not_found_or_not_owner');
    END IF;

    SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
        'id', p.id,
        'nombre_invitado', p.nombre_invitado,
        'estado', p.estado,
        'tipo_invitacion', p.tipo_invitacion,
        'token_invitacion', p.token_invitacion,
        'user_id', p.user_id,
        'mensaje_respuesta', p.mensaje_respuesta,
        'seat_count', COALESCE(p.seat_count, 1),
        'reconfirmation_status', COALESCE(p.reconfirmation_status, 'pending'),
        'reconfirmed_at', p.reconfirmed_at,
        'creado_en', p.creado_en
    ) ORDER BY p.creado_en ASC) INTO v_result
    FROM public.participantes p
    WHERE p.encuentro_id = p_encuentro_id;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_participantes_host_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_participantes_host_seguro(uuid, uuid) TO authenticated;

COMMIT;
