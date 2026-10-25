-- ==============================================================================
-- Migración: 20261024230000_hotfix_waitlist_concurrency_and_discovery_v1.sql
-- Fase V1 Mini-Sprint B — Hotfix de Concurrencia, Autorización y Discovery
--
-- Objetivos:
-- 1. P0 — Orden Canónico de Locks (Prevención de Deadlocks):
--    - En 'responder_oferta_lista_espera_seguro' y 'retirarse_lista_espera_seguro',
--      obtener el ID del encuentro sin lock exclusivo y bloquear primero 'encuentros'
--      con FOR UPDATE, seguido de 'solicitudes_encuentro_abierto' con FOR UPDATE.
--    - Revalidar identidad, estado, vigencia y condiciones tras adquirir los locks.
-- 2. P1 — Endurecimiento de Funciones Internas de Lista de Espera:
--    - 'evaluar_y_promover_lista_espera(uuid)' y 'procesar_expiraciones_lista_espera_seguro()':
--      Revocar EXECUTE de PUBLIC, anon y authenticated. Conceder exclusivamente a
--      postgres y service_role.
--    - Protección en runtime contra llamadas directas de clientes web.
-- 3. P1 — Vencimientos y Limpieza de Reservas con Inscripciones Cerradas:
--    - En 'evaluar_y_promover_lista_espera', separar Paso A (limpieza y liberación
--      de reservas temporales expiradas) de Paso B (promoción de nuevos candidatos).
--    - El Paso A se ejecuta SIEMPRE para no retener cupos en limbo, aun con inscripciones cerradas.
--    - El Paso B se condiciona a que el encuentro admita inscripciones (activo, abierto y sin cierre).
-- 4. P0 — Restauración de Invariantes Canónicas de Discovery:
--    - Exclusión de encuentros con fecha/hora pasadas en hora de Argentina ('America/Argentina/Buenos_Aires').
--    - Excepción de modalidad virtual en el filtro de localidad.
--    - Ordenamiento canónico ascendente por fecha y hora próximas.
--    - Límite determinista de 50 registros.
--    - Preservar el cálculo de cupos reservados por lista de espera y conteo de cola.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. RPC: responder_oferta_lista_espera_seguro (ORDEN CANÓNICO DE LOCKS)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.responder_oferta_lista_espera_seguro(
    p_request_id UUID,
    p_acepta BOOLEAN
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
    v_encuentro_id UUID;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_host_expiry TIMESTAMPTZ;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 1. Obtener ID del encuentro sin adquirir lock exclusivo previo de la solicitud
    SELECT encuentro_id INTO v_encuentro_id
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id;

    IF v_encuentro_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 2. Bloquear primero el encuentro (Orden canónico jerárquico: 1. encuentros)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    -- 3. Bloquear la solicitud correspondiente (Orden canónico: 2. solicitudes_encuentro_abierto)
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id AND encuentro_id = v_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 4. Revalidar identidad, propiedad, estado y vencimiento bajo locks adquiridos
    IF v_solicitud.usuario_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_solicitud.estado <> 'waitlist_offered' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_state', 'current_state', v_solicitud.estado);
    END IF;

    -- Verificar si la oferta ya expiró
    IF v_solicitud.waitlist_expires_at IS NOT NULL AND v_solicitud.waitlist_expires_at < v_now THEN
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'waitlist_expired',
            resolved_at = v_now,
            updated_at = v_now
        WHERE id = p_request_id;

        -- Promover al siguiente en la cola
        PERFORM public.evaluar_y_promover_lista_espera(v_solicitud.encuentro_id);

        RETURN pg_catalog.json_build_object('ok', false, 'error', 'offer_expired', 'message', 'El plazo para aceptar la oferta ha vencido.');
    END IF;

    -- 5. Realizar la transición de forma atómica
    IF p_acepta = true THEN
        -- Candidato confirma «Sigo interesado»: pasa a revisión del host reteniendo reserva temporal
        v_host_expiry := public.calcular_vencimiento_aprobacion_host_lista_espera(v_encuentro.fecha, v_encuentro.hora, v_now);

        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'waitlist_confirmed',
            waitlist_confirmed_at = v_now,
            host_approval_expires_at = v_host_expiry,
            updated_at = v_now
        WHERE id = p_request_id;

        -- Notificación in-app y push al anfitrión
        INSERT INTO public.inbox_notifications (
            recipient_user_id,
            notification_type,
            target_type,
            target_id,
            deep_link,
            title,
            body,
            payload,
            dedup_key,
            expires_at
        ) VALUES (
            v_encuentro.host_id,
            'waitlist_candidate_confirmed',
            'encounter',
            v_encuentro.id,
            '/open/' || v_encuentro.id || '#solicitudes',
            'Postulante en espera confirmó interés',
            v_solicitud.nombre_solicitante || ' confirmó su interés para sumarse a "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '". Revisá su solicitud.',
            pg_catalog.json_build_object(
                'encuentro_id', v_encuentro.id,
                'request_id', p_request_id,
                'applicant_name', v_solicitud.nombre_solicitante,
                'seat_count', COALESCE(v_solicitud.seat_count, 1),
                'host_approval_expires_at', v_host_expiry
            ),
            'waitlist_host_review:' || v_encuentro.id || ':' || p_request_id,
            COALESCE(v_host_expiry, v_now + INTERVAL '2 days') + INTERVAL '1 day'
        ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;

        RETURN pg_catalog.json_build_object(
            'ok', true,
            'status', 'waitlist_confirmed',
            'message', 'Interés confirmado. Tu solicitud pasó a revisión del anfitrión.'
        );
    ELSE
        -- Candidato desiste o cede el lugar
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'withdrawn',
            resolved_at = v_now,
            updated_at = v_now
        WHERE id = p_request_id;

        -- Promover inmediatamente al siguiente en la lista de espera
        PERFORM public.evaluar_y_promover_lista_espera(v_solicitud.encuentro_id);

        RETURN pg_catalog.json_build_object(
            'ok', true,
            'status', 'withdrawn',
            'message', 'Has cedido tu lugar en la lista de espera.'
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.responder_oferta_lista_espera_seguro(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.responder_oferta_lista_espera_seguro(UUID, BOOLEAN) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 2. RPC: retirarse_lista_espera_seguro (ORDEN CANÓNICO DE LOCKS)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.retirarse_lista_espera_seguro(
    p_request_id UUID
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
    v_encuentro_id UUID;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_had_reservation BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 1. Obtener ID del encuentro sin adquirir lock exclusivo previo de la solicitud
    SELECT encuentro_id INTO v_encuentro_id
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id;

    IF v_encuentro_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 2. Bloquear primero el encuentro (Orden canónico jerárquico: 1. encuentros)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    -- 3. Bloquear la solicitud correspondiente (Orden canónico: 2. solicitudes_encuentro_abierto)
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id AND encuentro_id = v_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 4. Revalidar identidad, estado y condiciones bajo locks adquiridos
    IF v_solicitud.usuario_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_solicitud.estado NOT IN ('waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_withdraw_state', 'current_state', v_solicitud.estado);
    END IF;

    v_had_reservation := (v_solicitud.estado IN ('waitlist_offered', 'waitlist_confirmed'));

    -- 5. Transición atómica a withdrawn
    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'withdrawn',
        resolved_at = v_now,
        updated_at = v_now
    WHERE id = p_request_id;

    -- Si el usuario tenía cupos reservados, avanzar la lista de espera para el siguiente
    IF v_had_reservation THEN
        PERFORM public.evaluar_y_promover_lista_espera(v_solicitud.encuentro_id);
    END IF;

    RETURN pg_catalog.json_build_object('ok', true, 'status', 'withdrawn');
END;
$$;

REVOKE ALL ON FUNCTION public.retirarse_lista_espera_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retirarse_lista_espera_seguro(UUID) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 3. RPC INTERNA: evaluar_y_promover_lista_espera (DESACOPLE DE EXPIRACIÓN Y PROMOCIÓN)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.evaluar_y_promover_lista_espera(
    p_encuentro_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_encuentro public.encuentros%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_confirmed_seats INT := 0;
    v_reserved_seats INT := 0;
    v_available_seats INT := 0;
    v_promoted_count INT := 0;
    v_expired_count INT := 0;
    v_candidate RECORD;
    v_offer_expiry TIMESTAMPTZ;
    v_exp RECORD;
BEGIN
    -- 1. Bloqueo exclusivo del encuentro para serializar promociones y limpiezas concurrentes
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    -- --------------------------------------------------------------------------
    -- PASO A: Vencer y liberar reservas que ya no son válidas.
    -- Se ejecuta SIEMPRE, incluso si el encuentro tiene inscripciones cerradas,
    -- fue cancelado o ya no está activo, para evitar cupos retenidos en limbo.
    -- --------------------------------------------------------------------------

    -- a) Ofertas al participante vencidas por tiempo
    FOR v_exp IN
        SELECT id, usuario_id, seat_count
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND estado = 'waitlist_offered'
          AND waitlist_expires_at IS NOT NULL
          AND waitlist_expires_at < v_now
        FOR UPDATE
    LOOP
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'waitlist_expired',
            resolved_at = v_now,
            updated_at = v_now
        WHERE id = v_exp.id;

        -- Notificación de oferta vencida
        INSERT INTO public.inbox_notifications (
            recipient_user_id,
            notification_type,
            target_type,
            target_id,
            deep_link,
            title,
            body,
            payload,
            dedup_key,
            expires_at
        ) VALUES (
            v_exp.usuario_id,
            'waitlist_offer_expired',
            'encounter',
            p_encuentro_id,
            '/solicitudes',
            'Oportunidad de cupo vencida',
            'El plazo para confirmar tu interés en "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" ha vencido y el cupo pasó al siguiente postulante.',
            pg_catalog.json_build_object(
                'encuentro_id', p_encuentro_id,
                'request_id', v_exp.id
            ),
            'waitlist_expired:' || p_encuentro_id || ':' || v_exp.id || ':' || v_now::text,
            v_now + INTERVAL '3 days'
        ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;

        v_expired_count := v_expired_count + 1;
    END LOOP;

    -- b) Aprobaciones del anfitrión vencidas por tiempo (reserva temporal abandonada)
    FOR v_exp IN
        SELECT id, usuario_id, seat_count
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND estado = 'waitlist_confirmed'
          AND host_approval_expires_at IS NOT NULL
          AND host_approval_expires_at < v_now
        FOR UPDATE
    LOOP
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'waitlist_expired',
            resolved_at = v_now,
            updated_at = v_now
        WHERE id = v_exp.id;

        v_expired_count := v_expired_count + 1;
    END LOOP;

    -- --------------------------------------------------------------------------
    -- PASO B: Promover candidatos nuevos SOLAMENTE cuando el encuentro admite inscripciones.
    -- Si el encuentro está inactivo, no es abierto o tiene inscripciones cerradas,
    -- concluimos aquí retornando el conteo de expiraciones sin generar nuevas ofertas.
    -- --------------------------------------------------------------------------

    IF v_encuentro.estado <> 'activo'
       OR COALESCE(v_encuentro.is_open, false) <> true
       OR COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'promoted_count', 0,
            'expired_count', v_expired_count,
            'reason', 'inscriptions_not_admitted'
        );
    END IF;

    -- 2. Calcular capacidad ocupada real y reservada
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_reserved_seats
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id AND estado IN ('waitlist_offered', 'waitlist_confirmed');

    v_available_seats := GREATEST(0, COALESCE(v_encuentro.max_participants, 0) - (v_confirmed_seats + v_reserved_seats));

    -- 3. Promoción FIFO considerando solicitudes multi-seat sin bloquear la cola
    WHILE v_available_seats > 0 LOOP
        v_offer_expiry := public.calcular_vencimiento_oferta_lista_espera(v_encuentro.fecha, v_encuentro.hora, v_now);
        IF v_offer_expiry IS NULL THEN
            -- Muy próximo al encuentro para abrir ventanas de espera
            EXIT;
        END IF;

        -- Buscar el siguiente candidato en orden FIFO que quepa en los cupos disponibles
        SELECT * INTO v_candidate
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND estado = 'waitlist_waiting'
          AND COALESCE(seat_count, 1) <= v_available_seats
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED;

        IF NOT FOUND THEN
            -- Ningún candidato restante puede tomar los cupos disponibles
            EXIT;
        END IF;

        -- Promover candidato a estado waitlist_offered
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'waitlist_offered',
            waitlist_offered_at = v_now,
            waitlist_expires_at = v_offer_expiry,
            updated_at = v_now
        WHERE id = v_candidate.id;

        v_available_seats := v_available_seats - COALESCE(v_candidate.seat_count, 1);
        v_reserved_seats := v_reserved_seats + COALESCE(v_candidate.seat_count, 1);
        v_promoted_count := v_promoted_count + 1;

        -- Enviar notificación in-app y push al candidato promovido
        INSERT INTO public.inbox_notifications (
            recipient_user_id,
            notification_type,
            target_type,
            target_id,
            deep_link,
            title,
            body,
            payload,
            dedup_key,
            expires_at
        ) VALUES (
            v_candidate.usuario_id,
            'waitlist_offer_available',
            'encounter',
            p_encuentro_id,
            '/solicitudes',
            '¡Se liberó un cupo!',
            'Hay un lugar disponible para "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '". Tenés tiempo para confirmar que seguís interesado.',
            pg_catalog.json_build_object(
                'encuentro_id', p_encuentro_id,
                'request_id', v_candidate.id,
                'seat_count', COALESCE(v_candidate.seat_count, 1),
                'waitlist_expires_at', v_offer_expiry
            ),
            'waitlist_offer:' || p_encuentro_id || ':' || v_candidate.id || ':' || v_candidate.created_at,
            v_offer_expiry + INTERVAL '1 day'
        ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;
    END LOOP;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'promoted_count', v_promoted_count,
        'expired_count', v_expired_count,
        'available_slots', v_available_seats
    );
END;
$$;

-- Endurecimiento P1: Acceso revocado a clientes directos (authenticated, anon, PUBLIC)
REVOKE ALL ON FUNCTION public.evaluar_y_promover_lista_espera(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluar_y_promover_lista_espera(UUID) TO postgres, service_role;


-- ------------------------------------------------------------------------------
-- 4. RPC INTERNA: procesar_expiraciones_lista_espera_seguro (ENDURECIMIENTO P1)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.procesar_expiraciones_lista_espera_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_role TEXT := COALESCE(
        auth.jwt() ->> 'role',
        NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
        ''
    );
    v_rec RECORD;
    v_encuentros_procesados INT := 0;
BEGIN
    -- Protección en profundidad: rechazar ejecuciones directas de usuarios o anónimos
    IF v_caller_role IN ('authenticated', 'anon') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden', 'message', 'Función de mantenimiento interno no accesible para clientes directos.');
    END IF;

    FOR v_rec IN
        SELECT DISTINCT encuentro_id
        FROM public.solicitudes_encuentro_abierto
        WHERE (estado = 'waitlist_offered' AND waitlist_expires_at < pg_catalog.clock_timestamp())
           OR (estado = 'waitlist_confirmed' AND host_approval_expires_at < pg_catalog.clock_timestamp())
    LOOP
        PERFORM public.evaluar_y_promover_lista_espera(v_rec.encuentro_id);
        v_encuentros_procesados := v_encuentros_procesados + 1;
    END LOOP;

    RETURN pg_catalog.json_build_object('ok', true, 'encuentros_procesados', v_encuentros_procesados);
END;
$$;

-- Endurecimiento P1: Acceso revocado a clientes directos (authenticated, anon, PUBLIC)
REVOKE ALL ON FUNCTION public.procesar_expiraciones_lista_espera_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.procesar_expiraciones_lista_espera_seguro() TO postgres, service_role;


-- ------------------------------------------------------------------------------
-- 5. RPC: get_discovery_encuentros_abiertos (RESTAURACIÓN DE INVARIANTES CANÓNICAS)
-- ------------------------------------------------------------------------------

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
            COALESCE(w_agg.reserved_seats, 0) AS reserved_waitlist_seats,
            COALESCE(w_agg.waiting_count, 0) AS waitlist_count,
            GREATEST(0, e.max_participants - (COALESCE(p_agg.confirmed_seats, 0) + COALESCE(w_agg.reserved_seats, 0))) AS open_slots,
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
        LEFT JOIN (
            SELECT
                encuentro_id,
                COALESCE(pg_catalog.sum(CASE WHEN estado IN ('waitlist_offered', 'waitlist_confirmed') THEN seat_count ELSE 0 END), 0)::int AS reserved_seats,
                COALESCE(pg_catalog.sum(CASE WHEN estado = 'waitlist_waiting' THEN 1 ELSE 0 END), 0)::int AS waiting_count
            FROM public.solicitudes_encuentro_abierto
            WHERE estado IN ('waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
            GROUP BY encuentro_id
        ) w_agg ON w_agg.encuentro_id = e.id
        WHERE e.is_open = true
          AND e.estado <> 'cancelado'
          AND e.moderation_status = 'approved'
          -- Invariante 1: Exclusión de encuentros con fecha/hora transcurridas en hora Argentina
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
          -- Invariante 2: Bloqueo bilateral
          AND (v_user_id IS NULL OR e.host_id <> ALL(v_blocked_host_ids))
          -- Invariante 3: Localidad con excepción para encuentros virtuales
          AND (
              p_locality_ids IS NULL
              OR cardinality(p_locality_ids) = 0
              OR e.locality_id = ANY(p_locality_ids)
              OR e.modalidad = 'virtual'
          )
          -- Invariante 4: Cupos disponibles considerando reservas de lista de espera
          AND (
              p_only_available = false
              OR (
                  COALESCE(e.inscriptions_closed, false) = false
                  AND GREATEST(0, e.max_participants - (COALESCE(p_agg.confirmed_seats, 0) + COALESCE(w_agg.reserved_seats, 0))) >= COALESCE(e.min_seats_per_request, 1)
              )
          )
        -- Invariante 5: Orden cronológico ascendente (próximos primero) y límite determinista
        ORDER BY
            CASE WHEN e.fecha IS NULL THEN 1 ELSE 0 END,
            e.fecha ASC NULLS LAST,
            e.hora ASC NULLS LAST,
            e.opened_at DESC,
            e.id ASC
        LIMIT 50
    ) row_data;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) TO anon, authenticated, postgres, service_role;

COMMIT;
