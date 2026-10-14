-- ============================================================
-- Migración: 20261014160000_fase_lifecycle_cancellation_and_request_quotas.sql
-- Propósito: 
--   1. P0: Cancelación atómica y trazable de encuentros (ocultamiento en Discovery,
--          cierre y notificación de solicitudes pendientes, notificación a participantes,
--          ocultamiento de logística privada, y bloqueo de eliminación en publicados/activos).
--   2. P1: Cupos por solicitud estrictos (sin clamping silencioso), validación de
--          min_seats_per_request y control estricto cuando available_slots < min_seats_per_request.
--   3. P1: Visibilidad del Host en Discovery (remoción de host exclusion, proyección de is_host
--          y min_seats_per_request).
-- ============================================================

BEGIN;

-- 1. ESQUEMA: columnas adicionales en public.encuentros
ALTER TABLE public.encuentros
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS min_seats_per_request INT DEFAULT 1;

ALTER TABLE public.encuentros
    DROP CONSTRAINT IF EXISTS encuentros_min_seats_per_request_check;

ALTER TABLE public.encuentros
    ADD CONSTRAINT encuentros_min_seats_per_request_check
    CHECK (min_seats_per_request IS NULL OR min_seats_per_request >= 1);


-- 2. RPC CANCELAR ENCUENTRO SEGURO (HARDENED + ATÓMICO + NOTIFICACIONES)
CREATE OR REPLACE FUNCTION public.cancelar_encuentro_seguro(
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
    v_title text;
    v_sol record;
    v_part record;
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
        RETURN pg_catalog.json_build_object('ok', true, 'id', p_encuentro_id, 'estado', 'cancelado');
    END IF;

    -- 1. Marcar encuentro como cancelado e inmediatamente cerrar Discovery
    UPDATE public.encuentros
    SET estado = 'cancelado',
        is_open = false,
        cancelled_at = pg_catalog.now()
    WHERE id = p_encuentro_id;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

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

        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_sol.usuario_id,
            p_notification_type := 'open_encounter_request_cancelled_by_host',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/?tab=solicitudes',
            p_title := 'Encuentro no disponible',
            p_body := 'Tu solicitud quedó sin efecto porque el encuentro ya no está disponible.',
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'request_id', v_sol.id,
                'title', v_title
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
        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_part.user_id,
            p_notification_type := 'encounter_cancelled_for_participant',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/?tab=encuentros',
            p_title := 'Encuentro cancelado',
            p_body := 'El encuentro al que te habías sumado ya no se realizará.',
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'title', v_title
            ),
            p_dedup_key := 'cancelled_part:' || p_encuentro_id || ':' || v_part.user_id
        );
    END LOOP;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'estado', 'cancelado'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_encuentro_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_encuentro_seguro(uuid, uuid) TO authenticated;


-- 3. RPC ELIMINAR ENCUENTRO SEGURO (PROTECCIÓN DE PUBLICADOS/ACTIVOS)
CREATE OR REPLACE FUNCTION public.eliminar_encuentro_seguro(
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

    -- REGLA DE PRODUCTO: Eliminar sólo aplica a borradores o encuentros nunca publicados y sin interacción de terceros.
    IF v_encuentro.is_open = true
       OR v_encuentro.opened_at IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.participantes WHERE encuentro_id = p_encuentro_id)
       OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = p_encuentro_id) THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'cannot_delete_published_or_active_encounter',
            'message', 'Este encuentro no se puede eliminar porque fue publicado o tuvo interacción. Debés cancelarlo.'
        );
    END IF;

    -- Eliminación segura de datos relacionados para borradores no publicados
    DELETE FROM public.participante_disponibilidades WHERE encuentro_id = p_encuentro_id;
    DELETE FROM public.encuentro_opciones_fecha WHERE encuentro_id = p_encuentro_id;
    DELETE FROM public.participantes WHERE encuentro_id = p_encuentro_id;
    DELETE FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = p_encuentro_id;
    DELETE FROM public.encuentros WHERE id = p_encuentro_id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_encuentro_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_encuentro_seguro(uuid, uuid) TO authenticated;


-- 4. RPC get_encuentro_participante_autorizado (OCULTAMIENTO DE LOGÍSTICA SI ESTÁ CANCELADO)
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

        SELECT COALESCE(p.seat_count, 1) INTO v_part_seats
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
            -- Si el encuentro está cancelado, se oculta la logística privada para participantes y público
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
        'estado', v_encuentro.estado
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_participante_autorizado(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentro_participante_autorizado(UUID) TO authenticated;


-- 5. RPC get_discovery_encuentros_abiertos (INCLUSIÓN DE HOST + EXCLUSIÓN DE CANCELADOS + MIN SEATS)
CREATE OR REPLACE FUNCTION public.get_discovery_encuentros_abiertos(
    p_locality_ids TEXT[] DEFAULT NULL
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

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) TO anon, authenticated;


-- 6. RPC solicitar_sumarse_encuentro_abierto (CUPOS ESTRICTOS, NO CLAMPING, MIN_SEATS CHECK)
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
    -- SEGURIDAD: identidad obligatoria y permanente
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
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    IF v_encuentro.is_open <> true THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_open');
    END IF;

    -- Validar que no sea el anfitrión
    IF v_encuentro.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_join_own_encounter');
    END IF;

    -- Bloqueo bilateral (fail-closed silencioso)
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_encuentro.host_id)
           OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_open');
    END IF;

    -- Validar que no tenga ya una solicitud pendiente
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado = 'pending'
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'duplicate_pending_request');
    END IF;

    -- Validar que no sea ya un participante activo confirmado
    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_user_id
          AND estado IN ('confirmado', 'asistio')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_participant');
    END IF;

    v_min_seats := COALESCE(v_encuentro.min_seats_per_request, 1);

    -- Validar cupo disponible al momento de crear la solicitud
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    v_available_seats := GREATEST(0, v_encuentro.max_participants - v_confirmed_seats);

    IF v_available_seats <= 0 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_full');
    END IF;

    -- Si los lugares disponibles son inferiores al mínimo por solicitud requerido:
    IF v_available_seats < v_min_seats THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'available_seats_below_min_request',
            'available_slots', v_available_seats,
            'min_seats_per_request', v_min_seats,
            'message', pg_catalog.format('Quedan %s lugares, pero el mínimo por solicitud es %s.', v_available_seats, v_min_seats)
        );
    END IF;

    -- REGLA DE RESERVA MÚLTIPLE SERVER-SIDE
    IF NOT COALESCE(v_encuentro.allow_multi_seat_requests, false) THEN
        v_effective_seat_count := 1;
    ELSE
        v_effective_seat_count := COALESCE(p_seat_count, 1);
        IF v_effective_seat_count < 1 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_seat_count');
        END IF;

        IF v_effective_seat_count < v_min_seats THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'seats_below_minimum',
                'min_seats_per_request', v_min_seats,
                'message', pg_catalog.format('El mínimo de lugares por solicitud es %s.', v_min_seats)
            );
        END IF;

        IF v_effective_seat_count > COALESCE(v_encuentro.max_seats_per_request, 1) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'seats_exceed_limit');
        END IF;

        IF v_effective_seat_count > v_encuentro.max_participants THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'seats_exceed_capacity');
        END IF;
    END IF;

    -- REGLA ESTRICTA DE CUPOS: NO CLAMPING SILENCIOSO
    -- Si lo solicitado supera los lugares disponibles, rechazar explícitamente
    IF v_effective_seat_count > v_available_seats THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'insufficient_available_slots',
            'available_slots', v_available_seats,
            'min_seats_per_request', v_min_seats,
            'message', pg_catalog.format('No hay suficientes lugares disponibles. Quedan %s lugares.', v_available_seats)
        );
    END IF;

    -- Cooldown post-rechazo (6 horas)
    SELECT COALESCE(resolved_at, updated_at, created_at)
    INTO v_rejected_at
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
      AND estado = 'rejected'
    ORDER BY COALESCE(resolved_at, updated_at, created_at) DESC
    LIMIT 1;

    IF v_rejected_at IS NOT NULL AND pg_catalog.now() < (v_rejected_at + interval '6 hours') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_available');
    END IF;

    -- Rate limiting server-side
    v_rl := public.check_rate_limit_internal('join_open_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- Insertar solicitud con seat_count validado
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
    ) RETURNING id INTO v_solicitud_id;

    -- Notificación en Outbox para el anfitrión
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

    -- Notificación en Inbox del anfitrión
    IF v_effective_seat_count > 1 THEN
        v_notif_body := v_clean_nombre || ' quiere sumarse con ' || v_effective_seat_count || ' lugares.';
    ELSE
        v_notif_body := v_clean_nombre || ' quiere sumarse a tu encuentro.';
    END IF;

    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_encuentro.host_id,
        p_notification_type := 'open_encounter_join_request_received',
        p_target_type := 'encounter',
        p_target_id := p_encuentro_id,
        p_deep_link := '/meet/' || p_encuentro_id || '#solicitudes',
        p_title := 'Nueva solicitud',
        p_body := v_notif_body,
        p_payload := pg_catalog.jsonb_build_object(
            'encounter_id', p_encuentro_id,
            'request_id', v_solicitud_id,
            'seat_count', v_effective_seat_count,
            'applicant_name', v_clean_nombre
        ),
        p_dedup_key := 'join_request_created:' || v_solicitud_id
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', v_solicitud_id,
        'encuentro_id', p_encuentro_id,
        'seat_count', v_effective_seat_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) TO authenticated;


-- 7. ACTUALIZAR abrir_encuentro_seguro PARA SOPORTAR min_seats_per_request
DROP FUNCTION IF EXISTS public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT);
DROP FUNCTION IF EXISTS public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, INT);

CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT DEFAULT NULL,
    p_open_public_zone TEXT DEFAULT NULL,
    p_open_public_title TEXT DEFAULT NULL,
    p_allow_multi_seat_requests BOOLEAN DEFAULT false,
    p_max_seats_per_request INT DEFAULT 1,
    p_min_seats_per_request INT DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro RECORD;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_was_open BOOLEAN;
    v_eval RECORD;
    v_loc_record RECORD;
    v_final_public_zone TEXT;
    v_final_locality_id TEXT;
    v_final_public_title TEXT;
    v_confirmed_seats INT := 0;
    v_final_multi_seat BOOLEAN := false;
    v_final_max_seats INT := 1;
    v_final_min_seats INT := 1;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_user_id <> p_host_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_active');
    END IF;

    -- Validar cupo
    IF p_max_participants IS NULL OR p_max_participants < 1 OR p_max_participants > 40 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_slots');
    END IF;

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    IF p_max_participants < v_confirmed_seats THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    -- Validar multi-seat y cupos mínimos/máximos por solicitud
    IF COALESCE(p_allow_multi_seat_requests, false) THEN
        v_final_multi_seat := true;
        IF p_max_seats_per_request IS NULL OR p_max_seats_per_request < 2 OR p_max_seats_per_request > p_max_participants THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_max_seats_per_request');
        END IF;
        v_final_max_seats := p_max_seats_per_request;

        v_final_min_seats := COALESCE(p_min_seats_per_request, 1);
        IF v_final_min_seats < 1 OR v_final_min_seats > v_final_max_seats THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_min_seats_per_request');
        END IF;
    ELSE
        v_final_multi_seat := false;
        v_final_max_seats := 1;
        v_final_min_seats := 1;
    END IF;

    -- Resolver título público
    IF p_open_public_title IS NOT NULL AND pg_catalog.btrim(p_open_public_title) <> '' THEN
        v_final_public_title := pg_catalog.btrim(p_open_public_title);
    ELSIF v_encuentro.open_public_title IS NOT NULL AND pg_catalog.btrim(v_encuentro.open_public_title) <> '' THEN
        v_final_public_title := pg_catalog.btrim(v_encuentro.open_public_title);
    ELSE
        v_final_public_title := pg_catalog.btrim(v_encuentro.titulo);
    END IF;

    IF pg_catalog.length(v_final_public_title) < 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_short');
    END IF;
    IF pg_catalog.length(v_final_public_title) > 80 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_long');
    END IF;

    -- Validar logística privada preexistente
    IF v_encuentro.modalidad = 'presencial' THEN
        IF v_encuentro.lugar_texto IS NULL OR pg_catalog.btrim(v_encuentro.lugar_texto) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'private_location_required');
        END IF;
    ELSIF v_encuentro.modalidad = 'virtual' THEN
        IF v_encuentro.link_virtual IS NULL OR pg_catalog.btrim(v_encuentro.link_virtual) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'virtual_link_required');
        END IF;
    END IF;

    -- Resolver localidad y zona según modalidad
    IF v_encuentro.modalidad = 'virtual' THEN
        v_final_locality_id := NULL;
        v_final_public_zone := 'Online';
    ELSE
        v_final_locality_id := p_locality_id;
        v_final_public_zone := NULLIF(pg_catalog.btrim(p_open_public_zone), '');

        IF v_final_locality_id IS NULL AND v_final_public_zone IS NULL THEN
            IF v_encuentro.locality_id IS NOT NULL THEN
                v_final_locality_id := v_encuentro.locality_id;
                v_final_public_zone := v_encuentro.open_public_zone;
            ELSE
                v_final_locality_id := 'guemes';
            END IF;
        END IF;

        IF v_final_locality_id IS NOT NULL AND v_final_public_zone IS NULL THEN
            SELECT * INTO v_loc_record FROM public.localidades WHERE id = v_final_locality_id AND activo = true;
            IF FOUND THEN
                v_final_public_zone := v_loc_record.nombre;
            ELSE
                v_final_locality_id := 'guemes';
                v_final_public_zone := 'Güemes';
            END IF;
        END IF;
    END IF;

    v_was_open := COALESCE(v_encuentro.is_open, false);

    -- Evaluar contenido público con moderación determinista
    SELECT * INTO v_eval FROM public.evaluate_public_content_heuristics(
        v_final_public_title,
        p_open_description,
        v_encuentro.modalidad,
        v_final_public_zone,
        v_encuentro.lugar_texto,
        v_encuentro.link_virtual
    );

    IF NOT v_eval.allowed THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'public_content_rejected',
            'reason', v_eval.reason,
            'message', 'El contenido no cumple las normas de seguridad comunitaria.'
        );
    END IF;

    -- Actualizar datos y estado de moderación (review_pending hasta pipeline)
    UPDATE public.encuentros
    SET is_open = false,
        open_public_title = v_final_public_title,
        open_description = p_open_description,
        max_participants = p_max_participants,
        allow_multi_seat_requests = v_final_multi_seat,
        max_seats_per_request = v_final_max_seats,
        min_seats_per_request = v_final_min_seats,
        locality_id = v_final_locality_id,
        open_public_zone = v_final_public_zone,
        moderation_status = 'review_pending',
        moderated_at = NULL,
        moderation_reason = NULL,
        opened_at = COALESCE(v_encuentro.opened_at, v_now)
    WHERE id = p_encuentro_id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'is_open', false,
        'moderation_status', 'review_pending',
        'open_public_title', v_final_public_title,
        'max_participants', p_max_participants,
        'allow_multi_seat_requests', v_final_multi_seat,
        'max_seats_per_request', v_final_max_seats,
        'min_seats_per_request', v_final_min_seats,
        'locality_id', v_final_locality_id,
        'open_public_zone', v_final_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, INT) TO authenticated;


-- 8. ACTUALIZAR RPC actualizar_encuentro_seguro (SOPORTE PARA min_seats_per_request)
CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro(
    p_encuentro_id uuid,
    p_host_id      uuid,
    p_data         jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_now timestamptz := pg_catalog.timezone('utc', pg_catalog.now());
    v_title_changed BOOLEAN := false;
    v_open_title_changed BOOLEAN := false;
    v_open_desc_changed BOOLEAN := false;
    v_modality_changed BOOLEAN := false;
    v_locality_changed BOOLEAN := false;
    v_zone_changed BOOLEAN := false;
    v_moderation_invalidated BOOLEAN := false;
    v_new_status TEXT;
    v_new_is_open BOOLEAN;
    v_changed_fields TEXT[] := ARRAY[]::TEXT[];
    v_eval RECORD;
    v_det_reason TEXT := NULL;
    v_new_title TEXT;
    v_new_open_title TEXT;
    v_new_open_desc TEXT;
    v_new_modalidad TEXT;
    v_new_locality_id TEXT;
    v_new_public_zone TEXT;
    v_loc_record RECORD;
    v_effective_eval_title TEXT;
    v_new_max_participants INT;
    v_new_allow_multi BOOLEAN;
    v_new_max_seats INT;
    v_new_min_seats INT;
    v_confirmed_seats INT := 0;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_user_id <> p_host_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id AND host_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- Si el encuentro está abierto, rechazar cambio de modalidad directamente (invariante existente)
    IF v_encuentro.is_open = true AND p_data ? 'modalidad' AND (p_data->>'modalidad') <> v_encuentro.modalidad THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_change_modality_while_open');
    END IF;

    -- Extraer valores nuevos
    v_new_title := CASE WHEN p_data ? 'titulo' THEN NULLIF(pg_catalog.btrim(p_data->>'titulo'), '') ELSE v_encuentro.titulo END;
    v_new_open_title := CASE WHEN p_data ? 'open_public_title' THEN NULLIF(pg_catalog.btrim(p_data->>'open_public_title'), '') ELSE v_encuentro.open_public_title END;
    v_new_open_desc := CASE WHEN p_data ? 'open_description' THEN NULLIF(pg_catalog.btrim(p_data->>'open_description'), '') ELSE v_encuentro.open_description END;
    v_new_modalidad := COALESCE(p_data->>'modalidad', v_encuentro.modalidad);
    v_new_locality_id := CASE WHEN p_data ? 'locality_id' THEN p_data->>'locality_id' ELSE v_encuentro.locality_id END;
    v_new_public_zone := CASE WHEN p_data ? 'open_public_zone' THEN p_data->>'open_public_zone' ELSE v_encuentro.open_public_zone END;

    -- Validar límites de open_public_title si se intenta modificar
    IF p_data ? 'open_public_title' THEN
        IF v_new_open_title IS NULL OR pg_catalog.length(v_new_open_title) < 3 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_short');
        END IF;
        IF pg_catalog.length(v_new_open_title) > 80 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_long');
        END IF;
    END IF;

    -- Validar cupo si se intenta modificar
    IF p_data ? 'max_participants' THEN
        v_new_max_participants := (p_data->>'max_participants')::int;
        IF v_new_max_participants IS NULL OR v_new_max_participants < 1 OR v_new_max_participants > 40 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_slots');
        END IF;

        SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

        IF v_new_max_participants < v_confirmed_seats THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'max_participants_too_low');
        END IF;
    ELSE
        v_new_max_participants := v_encuentro.max_participants;
    END IF;

    -- Validar multi-seat si se intenta modificar
    IF p_data ? 'allow_multi_seat_requests' THEN
        v_new_allow_multi := (p_data->>'allow_multi_seat_requests')::boolean;
    ELSE
        v_new_allow_multi := v_encuentro.allow_multi_seat_requests;
    END IF;

    IF p_data ? 'max_seats_per_request' THEN
        v_new_max_seats := (p_data->>'max_seats_per_request')::int;
    ELSE
        v_new_max_seats := v_encuentro.max_seats_per_request;
    END IF;

    IF p_data ? 'min_seats_per_request' THEN
        v_new_min_seats := (p_data->>'min_seats_per_request')::int;
    ELSE
        v_new_min_seats := COALESCE(v_encuentro.min_seats_per_request, 1);
    END IF;

    IF COALESCE(v_new_allow_multi, false) THEN
        IF v_new_max_seats IS NULL OR v_new_max_seats < 2 OR (v_new_max_participants IS NOT NULL AND v_new_max_seats > v_new_max_participants) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_max_seats_per_request');
        END IF;
        IF v_new_min_seats IS NOT NULL AND (v_new_min_seats < 1 OR v_new_min_seats > v_new_max_seats) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_min_seats_per_request');
        END IF;
    ELSE
        v_new_max_seats := 1;
        v_new_min_seats := 1;
    END IF;

    -- Si se actualizó locality_id pero no open_public_zone, resolver zona desde localidades
    IF p_data ? 'locality_id' AND v_new_locality_id IS NOT NULL AND NOT (p_data ? 'open_public_zone') THEN
        SELECT * INTO v_loc_record FROM public.localidades WHERE id = v_new_locality_id AND activo = true;
        IF FOUND THEN
            v_new_public_zone := v_loc_record.nombre;
        END IF;
    END IF;

    -- Detectar cambios en campos moderables públicos
    IF p_data ? 'titulo' AND COALESCE(v_new_title, '') <> COALESCE(v_encuentro.titulo, '') THEN
        v_title_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'titulo');
    END IF;

    IF p_data ? 'open_public_title' AND COALESCE(v_new_open_title, '') <> COALESCE(v_encuentro.open_public_title, '') THEN
        v_open_title_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_public_title');
    END IF;

    IF p_data ? 'open_description' AND COALESCE(v_new_open_desc, '') <> COALESCE(v_encuentro.open_description, '') THEN
        v_open_desc_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_description');
    END IF;

    IF p_data ? 'modalidad' AND COALESCE(v_new_modalidad, '') <> COALESCE(v_encuentro.modalidad, '') THEN
        v_modality_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'modalidad');
    END IF;

    IF p_data ? 'locality_id' AND COALESCE(v_new_locality_id, '') <> COALESCE(v_encuentro.locality_id, '') THEN
        v_locality_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'locality_id');
    END IF;

    IF p_data ? 'open_public_zone' AND COALESCE(v_new_public_zone, '') <> COALESCE(v_encuentro.open_public_zone, '') THEN
        v_zone_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_public_zone');
    END IF;

    -- Si el encuentro alguna vez fue abierto/moderado y se modificó algún campo público
    IF v_encuentro.moderation_status IN ('approved', 'rejected') AND (v_open_title_changed OR v_open_desc_changed OR v_modality_changed OR v_locality_changed OR v_zone_changed) THEN
        v_effective_eval_title := COALESCE(v_new_open_title, v_encuentro.open_public_title, v_new_title, v_encuentro.titulo);

        SELECT * INTO v_eval FROM public.evaluate_public_content_heuristics(
            v_effective_eval_title,
            COALESCE(v_new_open_desc, v_encuentro.open_description, ''),
            v_new_modalidad,
            v_new_public_zone,
            v_encuentro.lugar_texto,
            v_encuentro.link_virtual
        );

        v_moderation_invalidated := true;

        IF NOT v_eval.allowed THEN
            v_new_status := 'rejected';
            v_new_is_open := false;
            v_det_reason := v_eval.reason;
        ELSE
            v_new_status := 'review_pending';
            v_new_is_open := false;
        END IF;
    END IF;

    UPDATE public.encuentros
    SET
        titulo = v_new_title,
        open_public_title = v_new_open_title,
        descripcion = CASE
            WHEN p_data ? 'descripcion'
            THEN p_data->>'descripcion'
            ELSE descripcion
        END,
        open_description = v_new_open_desc,
        max_participants = v_new_max_participants,
        allow_multi_seat_requests = COALESCE(v_new_allow_multi, false),
        max_seats_per_request = COALESCE(v_new_max_seats, 1),
        min_seats_per_request = COALESCE(v_new_min_seats, 1),
        fecha = CASE
            WHEN p_data ? 'fecha'
            THEN (p_data->>'fecha')::date
            ELSE fecha
        END,
        hora = CASE
            WHEN p_data ? 'hora'
            THEN (p_data->>'hora')::time
            ELSE hora
        END,
        modalidad = v_new_modalidad,
        locality_id = v_new_locality_id,
        open_public_zone = v_new_public_zone,
        lugar_texto = CASE WHEN p_data ? 'lugar_texto' THEN p_data->>'lugar_texto' ELSE lugar_texto END,
        link_virtual = CASE WHEN p_data ? 'link_virtual' THEN p_data->>'link_virtual' ELSE link_virtual END,
        tipo_invitacion = COALESCE(
            p_data->>'tipo_invitacion',
            tipo_invitacion
        ),
        estado = COALESCE(
            p_data->>'estado',
            estado
        ),
        tema = CASE WHEN p_data ? 'tema' THEN p_data->>'tema' ELSE tema END,
        tema_invitacion = CASE
            WHEN p_data ? 'tema_invitacion'
                 AND p_data->>'tema_invitacion' IN (
                    'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
                    'family', 'special', 'romantic', 'sports', 'entertainment',
                    'learning', 'wellness', 'custom'
                 )
            THEN p_data->>'tema_invitacion'
            ELSE tema_invitacion
        END,
        invitation_template = CASE WHEN p_data ? 'invitation_template' THEN p_data->>'invitation_template' ELSE invitation_template END,
        reemplaza_a = CASE
            WHEN p_data ? 'reemplaza_a'
                 AND p_data->>'reemplaza_a' IS NOT NULL
                 AND p_data->>'reemplaza_a' <> ''
            THEN (p_data->>'reemplaza_a')::uuid
            WHEN p_data ? 'reemplaza_a'
            THEN NULL
            ELSE reemplaza_a
        END,
        moderation_status = COALESCE(v_new_status, moderation_status),
        is_open = COALESCE(v_new_is_open, is_open),
        moderated_at = CASE WHEN v_moderation_invalidated THEN v_now ELSE moderated_at END,
        moderation_reason = CASE
            WHEN v_moderation_invalidated AND v_new_status = 'rejected' THEN v_det_reason
            WHEN v_moderation_invalidated THEN 'content_updated'
            ELSE moderation_reason
        END,
        moderation_decision_source = CASE
            WHEN v_moderation_invalidated AND v_new_status = 'rejected' THEN 'deterministic'
            WHEN v_moderation_invalidated THEN 'content_update'
            ELSE moderation_decision_source
        END,
        closed_at = CASE WHEN v_moderation_invalidated AND v_encuentro.is_open THEN v_now ELSE closed_at END
    WHERE id = p_encuentro_id
      AND host_id = v_user_id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'moderation_invalidated', v_moderation_invalidated,
        'moderation_status', COALESCE(v_new_status, v_encuentro.moderation_status),
        'is_open', COALESCE(v_new_is_open, v_encuentro.is_open),
        'max_participants', v_new_max_participants,
        'allow_multi_seat_requests', COALESCE(v_new_allow_multi, false),
        'max_seats_per_request', COALESCE(v_new_max_seats, 1),
        'min_seats_per_request', COALESCE(v_new_min_seats, 1)
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) TO authenticated;

COMMIT;
