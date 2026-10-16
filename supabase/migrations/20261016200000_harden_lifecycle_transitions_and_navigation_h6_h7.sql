-- ============================================================
-- Migración: 20261016200000_harden_lifecycle_transitions_and_navigation_h6_h7.sql
-- Propósito:
--   1. H4 — Coherencia de motivos de cancelación entre Frontend y Backend.
--      Exponer 'has_affected_users' y 'pending_requests_count' en get_detalle_host_seguro.
--      Asegurar navegación a sheet autorizado en cancelación para participantes confirmados.
--   2. H6 — Deduplicación por ciclos de transición legítimos.
--      Identificadores de ciclo persistentes en public.encuentros:
--      'min_realization_cycle_id' y 'inscriptions_cycle_id'.
--      Evitar pérdida de avisos legítimos en ciclos repetidos (pending -> confirmed -> pending -> confirmed,
--      cierre -> reapertura -> nuevo cierre) y garantizar idempotencia estricta en reintentos.
--   3. H7 — Navegación segura y coherente desde notificaciones.
--      Destinos canónicos y autorizados sin exposición de logística privada a no autorizados.
-- ============================================================

BEGIN;

-- 1. ESQUEMA: columnas de ciclo de vida en public.encuentros
ALTER TABLE public.encuentros
    ADD COLUMN IF NOT EXISTS min_realization_cycle_id UUID DEFAULT pg_catalog.gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS inscriptions_cycle_id UUID DEFAULT pg_catalog.gen_random_uuid();

-- 2. RPC GET_DETALLE_HOST_SEGURO (AMPLIACIÓN H4: has_affected_users y pending_requests_count)
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
    v_pending_requests INT := 0;
    v_has_affected BOOLEAN := false;
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

    SELECT pg_catalog.count(*)::int
    INTO v_pending_requests
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id AND estado = 'pending';

    -- Regla canónica de usuarios afectados: participantes confirmados ajenos al host O solicitudes pendientes
    v_has_affected := (
        EXISTS (
            SELECT 1 FROM public.participantes
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_user_id
        ) OR v_pending_requests > 0
    );

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
        'pending_requests_count', v_pending_requests,
        'has_affected_users', v_has_affected,
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


-- 3. RPC CANCELAR_ENCUENTRO_SEGURO (H4 & H7: NAVEGACIÓN Y MOTIVOS OBLIGATORIOS)
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
    v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- 1. Bloquear encuentro primero (Orden canónico: 1. encuentros)
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

    -- 2. Bloquear solicitudes pendientes en orden determinista (Orden canónico: 2. solicitudes_encuentro_abierto)
    PERFORM 1
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND estado = 'pending'
    ORDER BY id
    FOR UPDATE;

    -- 3. Bloquear participantes confirmados en orden determinista (Orden canónico: 3. participantes)
    PERFORM 1
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id
      AND estado IN ('confirmado', 'asistio')
    ORDER BY id
    FOR UPDATE;

    v_clean_reason := NULLIF(pg_catalog.btrim(COALESCE(p_cancellation_reason, '')), '');

    -- 4. Revalidar usuarios afectados bajo los bloqueos adquiridos
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

    -- 5. Marcar encuentro como cancelado e inmediatamente cerrar Discovery e inscripciones
    UPDATE public.encuentros
    SET estado = 'cancelado',
        is_open = false,
        inscriptions_closed = true,
        inscriptions_closed_at = COALESCE(inscriptions_closed_at, v_now),
        cancelled_at = v_now,
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

    -- 6. Transicionar solicitudes pendientes a 'cancelled' y notificar a cada solicitante
    FOR v_sol IN
        SELECT id, usuario_id, nombre_solicitante
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND estado = 'pending'
        ORDER BY id
    LOOP
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'cancelled',
            resolved_at = v_now,
            updated_at = v_now
        WHERE id = v_sol.id
          AND estado = 'pending';

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

    -- 7. Notificar a los participantes confirmados (con deep link a open_detail para detalle autorizado y banner de cancelación)
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
            p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
            p_title := 'Encuentro cancelado',
            p_body := v_notif_body,
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'title', v_title,
                'original_date_label', v_datetime_label,
                'cancellation_reason', v_clean_reason,
                'priority', 'critical'
            ),
            p_dedup_key := 'cancelled_enc:' || p_encuentro_id || ':' || v_part.user_id
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


-- 4. RPC SET_MIN_PARTICIPANTS_SEGURO (H6: DEDUPLICACIÓN POR CICLOS REALES)
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
    v_cycle_id uuid;
    v_below_min_id uuid;
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

    -- Transición pending -> confirmed (nuevo ciclo de confirmación de realización)
    IF v_old_status = 'pending' AND v_new_status = 'confirmed' THEN
        v_cycle_id := pg_catalog.gen_random_uuid();

        UPDATE public.encuentros
        SET min_participants = p_min_participants,
            realization_status = v_new_status,
            min_confirmed_notified_at = v_now,
            min_realization_cycle_id = v_cycle_id
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
                p_dedup_key := 'min_reached:' || p_encuentro_id || ':' || v_cycle_id || ':' || v_part.user_id
            );
        END LOOP;

    -- Transición confirmed -> pending (nuevo evento de caída por debajo del mínimo)
    ELSIF v_old_status = 'confirmed' AND v_new_status = 'pending' THEN
        v_below_min_id := pg_catalog.gen_random_uuid();

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
            p_dedup_key := 'below_min_host:' || p_encuentro_id || ':' || v_below_min_id
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
                p_dedup_key := 'below_min_part:' || p_encuentro_id || ':' || v_below_min_id || ':' || v_part.user_id
            );
        END LOOP;
    ELSE
        -- Sin cambio de estado de realización (idempotencia estricta en notificaciones)
        UPDATE public.encuentros
        SET min_participants = p_min_participants,
            realization_status = v_new_status
        WHERE id = p_encuentro_id;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'min_participants', p_min_participants,
        'realization_status', v_new_status
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_min_participants_seguro(uuid, uuid, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_min_participants_seguro(uuid, uuid, int, boolean) TO authenticated;


-- 5. RPC APROBAR_SOLICITUD_ENCUENTRO_ABIERTO (H6: DEDUPLICACIÓN POR CICLOS REALES)
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

    -- 6. Insertar o sincronizar participante
    SELECT id, token_invitacion INTO v_participante_id, v_token_invitacion
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id
      AND user_id = v_solicitud.usuario_id
    LIMIT 1;

    IF v_participante_id IS NOT NULL THEN
        UPDATE public.participantes
        SET estado = 'confirmado',
            seat_count = v_req_seats,
            rol = 'invitado',
            nombre_invitado = v_solicitud.nombre_solicitante,
            updated_at = v_now
        WHERE id = v_participante_id;
    ELSE
        v_token_invitacion := pg_catalog.gen_random_uuid();
        v_participante_id := pg_catalog.gen_random_uuid();
        INSERT INTO public.participantes (
            id,
            encuentro_id,
            user_id,
            nombre_invitado,
            rol,
            tipo_invitacion,
            estado,
            token_invitacion,
            seat_count,
            reconfirmation_status,
            created_at,
            updated_at
        ) VALUES (
            v_participante_id,
            v_encuentro.id,
            v_solicitud.usuario_id,
            v_solicitud.nombre_solicitante,
            'invitado',
            'individual',
            'confirmado',
            v_token_invitacion,
            v_req_seats,
            'pending',
            v_now,
            v_now
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

    -- 8. Notificar al solicitante
    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_solicitud.usuario_id,
        p_notification_type := 'open_encounter_request_approved',
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
        p_dedup_key := 'req_appr:' || p_request_id
    );

    -- 9. Verificación de realización y mínimo de participantes (H6: deduplicación por ciclo de confirmación)
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

REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(uuid, uuid) TO authenticated;


-- 6. RPC CERRAR_INSCRIPCIONES_SEGURO (H6: IDEMPOTENCIA Y CICLOS DE RECONFIRMACIÓN)
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
    v_close_cycle_id uuid;
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

    -- IDEMPOTENCIA: Si ya está cerrado, retornar éxito sin repetir avisos
    IF COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'inscriptions_closed', true,
            'final_confirmation_sent', false,
            'no_change', true
        );
    END IF;

    v_is_confirmed := (v_encuentro.realization_status IN ('confirmed', 'forced'));
    v_close_cycle_id := pg_catalog.gen_random_uuid();

    UPDATE public.encuentros
    SET inscriptions_closed = true,
        inscriptions_closed_at = v_now,
        inscriptions_cycle_id = v_close_cycle_id,
        final_confirmation_notified_at = CASE
            WHEN v_is_confirmed THEN v_now
            ELSE final_confirmation_notified_at
        END
    WHERE id = p_encuentro_id;

    -- Si se cierra en un nuevo ciclo y está confirmado, reiniciar estado de reconfirmación a pending
    IF v_is_confirmed THEN
        UPDATE public.participantes
        SET reconfirmation_status = 'pending'
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio');
    END IF;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

    -- Si el encuentro está confirmado o forzado, enviar notificación de confirmación final con el id del nuevo ciclo
    IF v_is_confirmed THEN
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
                p_dedup_key := 'final_conf:' || p_encuentro_id || ':' || v_close_cycle_id || ':' || v_part.user_id
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


-- 7. RPC REABRIR_INSCRIPCIONES_SEGURO (H6: REAPERTURA Y RESET DE NOTIFICACIÓN FINAL)
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

    -- IDEMPOTENCIA: Si ya está abierto, retornar éxito sin cambios
    IF COALESCE(v_encuentro.inscriptions_closed, false) = false THEN
        RETURN pg_catalog.json_build_object('ok', true, 'inscriptions_closed', false, 'no_change', true);
    END IF;

    UPDATE public.encuentros
    SET inscriptions_closed = false,
        inscriptions_closed_at = NULL,
        final_confirmation_notified_at = NULL
    WHERE id = p_encuentro_id;

    RETURN pg_catalog.json_build_object('ok', true, 'inscriptions_closed', false);
END;
$$;

REVOKE ALL ON FUNCTION public.reabrir_inscripciones_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reabrir_inscripciones_seguro(uuid, uuid) TO authenticated;


-- 8. RPC HACERLO_IGUAL_SEGURO (H6: IDEMPOTENCIA Y DEDUPLICACIÓN EN REALIZACIÓN FORZADA)
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
    v_forced_event_id uuid;
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

    -- IDEMPOTENCIA: Si ya está forzado, retornar sin reenviar avisos
    IF v_encuentro.realization_status = 'forced' THEN
        RETURN pg_catalog.json_build_object('ok', true, 'realization_status', 'forced', 'no_change', true);
    END IF;

    v_forced_event_id := pg_catalog.gen_random_uuid();

    UPDATE public.encuentros
    SET realization_status = 'forced'
    WHERE id = p_encuentro_id;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

    -- Notificar a participantes confirmados con clave única por evento de transición
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
            p_dedup_key := 'forced_realization:' || p_encuentro_id || ':' || v_forced_event_id || ':' || v_part.user_id
        );
    END LOOP;

    RETURN pg_catalog.json_build_object('ok', true, 'realization_status', 'forced');
END;
$$;

REVOKE ALL ON FUNCTION public.hacerlo_igual_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hacerlo_igual_seguro(uuid, uuid) TO authenticated;

COMMIT;
