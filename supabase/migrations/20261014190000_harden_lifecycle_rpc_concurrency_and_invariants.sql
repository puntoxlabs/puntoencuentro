-- ============================================================
-- Migración: 20261014190000_harden_lifecycle_rpc_concurrency_and_invariants.sql
-- Propósito:
--   1. Hardening de concurrencia:
--      - Lock FOR SHARE en solicitar_sumarse_encuentro_abierto para serializar ante cierre o cancelación.
--      - Bloqueo estricto de reconfirmar_asistencia_seguro en encuentros cancelados.
--   2. Invariante y advertencia obligatoria de min_participants:
--      - set_min_participants_seguro exige confirmación explícita (p_confirm_reversion)
--        cuando el encuentro está confirmado, con inscripciones cerradas, y el nuevo mínimo
--        haría regresar a pending.
--   3. Corrección de filtro Discovery "Solo con lugares disponibles":
--      - Excluir encuentros con inscriptions_closed = true además de los agotados (open_slots <= 0).
--   4. Eliminación de fallback inseguro de p_host_id en get_detalle_host_seguro (estricto auth.uid()).
-- ============================================================

BEGIN;

-- 1. RPC SET_MIN_PARTICIPANTS_SEGURO (ADVERTENCIA Y CONFIRMACIÓN OBLIGATORIA ANTE REVERSIÓN)
DROP FUNCTION IF EXISTS public.set_min_participants_seguro(uuid, uuid, int);
DROP FUNCTION IF EXISTS public.set_min_participants_seguro(uuid, uuid, int, boolean);

CREATE OR REPLACE FUNCTION public.set_min_participants_seguro(
    p_encuentro_id uuid,
    p_host_id uuid,
    p_min_participants int,
    p_confirm_reversion boolean DEFAULT false
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

    -- REGLA DE NEGOCIO: Si el encuentro estaba confirmado, con inscripciones cerradas,
    -- y el nuevo mínimo haría regresar a 'pending', exigir confirmación explícita del Host.
    IF v_old_status = 'confirmed'
       AND COALESCE(v_encuentro.inscriptions_closed, false) = true
       AND v_new_status = 'pending'
       AND COALESCE(p_confirm_reversion, false) = false THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'reversion_confirmation_required',
            'message', 'Este cambio hará que el encuentro vuelva a depender del mínimo de participantes. ¿Querés continuar?'
        );
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
    -- Transición confirmed -> pending
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

REVOKE ALL ON FUNCTION public.set_min_participants_seguro(uuid, uuid, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_min_participants_seguro(uuid, uuid, int, boolean) TO authenticated;


-- 2. RPC RECONFIRMAR_ASISTENCIA_SEGURO (RECHAZO ESTRICTO ANTE ENCUENTRO CANCELADO)
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

    -- INVARIANTE: Un encuentro cancelado no admite confirmación de asistencia
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'cannot_reconfirm_cancelled_encounter',
            'message', 'El encuentro ha sido cancelado.'
        );
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


-- 3. RPC SOLICITAR_SUMARSE_ENCUENTRO_ABIERTO (LOCK FOR SHARE PARA SERIALIZAR ANTE CIERRE O CANCELACIÓN)
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

    -- Concurrencia: FOR SHARE bloquea lectura stale si una transacción concurrente está
    -- cerrando inscripciones (cerrar_inscripciones_seguro) o cancelando (cancelar_encuentro_seguro) con FOR UPDATE.
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


-- 4. RPC GET_DISCOVERY_ENCUENTROS_ABIERTOS (FILTRO DISPONIBLES: EXCLUIR INSCRIPCIONES CERRADAS)
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
              OR (
                  GREATEST(0, e.max_participants - COALESCE(p_agg.confirmed_seats, 0)) > 0
                  AND COALESCE(e.inscriptions_closed, false) = false
              )
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


-- 5. RPC GET_DETALLE_HOST_SEGURO (AUTENTICACIÓN ESTRICTA SIN FALLBACK INSEGURO)
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

COMMIT;
