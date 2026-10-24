-- ==============================================================================
-- Migración: 20261024220000_open_encounters_waitlist_and_recovery_v1.sql
-- Fase V1 Mini-Sprint B — Lista de Espera y Recuperación de Cupos
--
-- Objetivos y Reglas de Negocio:
-- 1. Si no hay suficientes cupos para una solicitud, se ofrece voluntariamente
--    «Anotarme en lista de espera».
-- 2. Orden FIFO determinístico por created_at con soporte multi-seat (seat_count).
-- 3. Si el primer candidato pide más plazas de las liberadas, no bloquea la cola:
--    avanza al siguiente candidato elegible sin perder la prioridad del primero.
-- 4. Oportunidad temporal: al liberarse cupos, se reserva temporalmente la plaza
--    y se notifica al candidato con plazo de vencimiento configurable:
--      - > 24h antes del encuentro: 12 horas.
--      - 2h a 24h antes del encuentro: 2 horas (acotado al inicio del evento).
--      - < 2h antes del encuentro: no se ofrecen nuevas reservas automáticas.
-- 5. Acción «Sigo interesado»: el candidato confirma vigencia y la solicitud
--    pasa a revisión del anfitrión con reserva temporal activa.
-- 6. Aprobación obligatoria del anfitrión: NUNCA se incorpora a un participante
--    sin consentimiento explícito del organizador.
-- 7. Vencimiento de aprobación del host: si el anfitrión no actúa a tiempo,
--    la reserva expira y los cupos se reasignan a la lista.
-- 8. Liberación inmediata ante rechazo, desistimiento, baja voluntaria o vencimiento.
-- 9. Un único ciclo activo de solicitud/espera por usuario y encuentro.
-- 10. Locks concurrentes y orden canónico de serialización (encuentros -> solicitudes -> participantes).
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. EVOLUCIÓN DE ESQUEMA: public.solicitudes_encuentro_abierto
-- ------------------------------------------------------------------------------

ALTER TABLE public.solicitudes_encuentro_abierto
    DROP CONSTRAINT IF EXISTS solicitudes_encuentro_abierto_estado_check;

ALTER TABLE public.solicitudes_encuentro_abierto
    ADD CONSTRAINT solicitudes_encuentro_abierto_estado_check
    CHECK (estado IN (
        'pending', 'approved', 'rejected', 'withdrawn', 'cancelled',
        'waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed', 'waitlist_expired'
    ));

ALTER TABLE public.solicitudes_encuentro_abierto
    ADD COLUMN IF NOT EXISTS is_waitlist BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS waitlist_offered_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS waitlist_expires_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS waitlist_confirmed_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS host_approval_expires_at TIMESTAMPTZ DEFAULT NULL;

-- Invariante: un único ciclo activo de solicitud o espera por usuario y encuentro
DROP INDEX IF EXISTS public.idx_solicitudes_activas_unicas;
CREATE UNIQUE INDEX idx_solicitudes_activas_unicas
    ON public.solicitudes_encuentro_abierto(encuentro_id, usuario_id)
    WHERE estado IN ('pending', 'approved', 'waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed');

CREATE INDEX IF NOT EXISTS idx_solicitudes_waitlist_queue
    ON public.solicitudes_encuentro_abierto(encuentro_id, created_at ASC)
    WHERE estado = 'waitlist_waiting';

CREATE INDEX IF NOT EXISTS idx_solicitudes_waitlist_offered_exp
    ON public.solicitudes_encuentro_abierto(encuentro_id, waitlist_expires_at)
    WHERE estado = 'waitlist_offered';

CREATE INDEX IF NOT EXISTS idx_solicitudes_waitlist_host_exp
    ON public.solicitudes_encuentro_abierto(encuentro_id, host_approval_expires_at)
    WHERE estado = 'waitlist_confirmed';


-- ------------------------------------------------------------------------------
-- 2. FUNCIONES DE CÁLCULO DE VENCIMIENTOS CONFIGURABLES
-- ------------------------------------------------------------------------------

-- Vencimiento de oferta para el participante
CREATE OR REPLACE FUNCTION public.calcular_vencimiento_oferta_lista_espera(
    p_fecha DATE,
    p_hora TIME,
    p_from TIMESTAMPTZ DEFAULT pg_catalog.clock_timestamp()
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_encuentro_ts TIMESTAMPTZ;
    v_diff INTERVAL;
    v_expiry TIMESTAMPTZ;
BEGIN
    IF p_fecha IS NULL THEN
        RETURN p_from + INTERVAL '12 hours';
    END IF;

    v_encuentro_ts := ((p_fecha::text || ' ' || COALESCE(p_hora, '00:00:00'::time)::text)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires';
    v_diff := v_encuentro_ts - p_from;

    -- Si el encuentro ya pasó o faltan menos de 2 horas: no hay ventana razonable
    IF v_diff <= INTERVAL '2 hours' THEN
        RETURN NULL;
    ELSIF v_diff > INTERVAL '24 hours' THEN
        -- Más de 24h antes: oferta por 12 horas
        v_expiry := p_from + INTERVAL '12 hours';
    ELSE
        -- Entre 2 y 24 horas antes: oferta por 2 horas
        v_expiry := p_from + INTERVAL '2 hours';
    END IF;

    -- Acotar para que venza antes del inicio del encuentro
    IF v_expiry >= v_encuentro_ts THEN
        v_expiry := v_encuentro_ts - INTERVAL '15 minutes';
    END IF;

    IF v_expiry <= p_from THEN
        RETURN NULL;
    END IF;

    RETURN v_expiry;
END;
$$;

-- Vencimiento de aprobación para el anfitrión
CREATE OR REPLACE FUNCTION public.calcular_vencimiento_aprobacion_host_lista_espera(
    p_fecha DATE,
    p_hora TIME,
    p_from TIMESTAMPTZ DEFAULT pg_catalog.clock_timestamp()
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_encuentro_ts TIMESTAMPTZ;
    v_diff INTERVAL;
    v_expiry TIMESTAMPTZ;
BEGIN
    IF p_fecha IS NULL THEN
        RETURN p_from + INTERVAL '12 hours';
    END IF;

    v_encuentro_ts := ((p_fecha::text || ' ' || COALESCE(p_hora, '00:00:00'::time)::text)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires';
    v_diff := v_encuentro_ts - p_from;

    IF v_diff <= INTERVAL '1 hour' THEN
        RETURN NULL;
    ELSIF v_diff > INTERVAL '24 hours' THEN
        -- Más de 24h antes: 12 horas de plazo de revisión
        v_expiry := p_from + INTERVAL '12 hours';
    ELSE
        -- Entre 2 y 24 horas: 2 horas de plazo
        v_expiry := p_from + INTERVAL '2 hours';
    END IF;

    IF v_expiry >= v_encuentro_ts THEN
        v_expiry := v_encuentro_ts - INTERVAL '10 minutes';
    END IF;

    IF v_expiry <= p_from THEN
        RETURN NULL;
    END IF;

    RETURN v_expiry;
END;
$$;


-- ------------------------------------------------------------------------------
-- 3. MOTOR DE EVALUACIÓN Y PROMOCIÓN DETERMINÍSTICA DE LISTA DE ESPERA
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
    -- 1. Bloqueo exclusivo del encuentro para serializar promociones concurrentes
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    -- Si el encuentro no está activo o ya no es abierto, o inscripciones cerradas: no promover
    IF v_encuentro.estado <> 'activo' OR v_encuentro.is_open <> true OR COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
        RETURN pg_catalog.json_build_object('ok', true, 'promoted_count', 0, 'reason', 'not_open_or_closed');
    END IF;

    -- 2. Limpieza atómica de ofertas y aprobaciones vencidas
    -- a) Ofertas al participante vencidas
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

    -- b) Aprobaciones del host vencidas (reserva abandonada)
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

    -- 3. Calcular capacidad ocupada real y reservada
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_reserved_seats
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id AND estado IN ('waitlist_offered', 'waitlist_confirmed');

    v_available_seats := GREATEST(0, COALESCE(v_encuentro.max_participants, 0) - (v_confirmed_seats + v_reserved_seats));

    -- 4. Promoción FIFO considerando solicitudes multi-seat sin bloquear la cola
    WHILE v_available_seats > 0 LOOP
        v_offer_expiry := public.calcular_vencimiento_oferta_lista_espera(v_encuentro.fecha, v_encuentro.hora, v_now);
        IF v_offer_expiry IS NULL THEN
            -- Muy próximo al encuentro para abrir ventanas de espera
            EXIT;
        END IF;

        -- Buscar el candidato en orden FIFO que quepa en los cupos disponibles
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

        -- Enviar notificación in-app y push al candidato
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

REVOKE ALL ON FUNCTION public.evaluar_y_promover_lista_espera(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.evaluar_y_promover_lista_espera(UUID) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 4. RPC: unirse_lista_espera_encuentro_abierto
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.unirse_lista_espera_encuentro_abierto(
    p_encuentro_id UUID,
    p_nombre TEXT,
    p_mensaje TEXT DEFAULT NULL,
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
    v_available_seats INT := 0;
    v_solicitud_id UUID;
    v_clean_nombre TEXT;
    v_effective_seat_count INT := 1;
    v_rejected_at TIMESTAMPTZ;
    v_position INT;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    -- 1. Autenticación y cuenta permanente obligatoria
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

    -- 2. Inspección del encuentro con lock de lectura compartida
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

    -- Participación activa duplicada
    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_user_id
          AND estado IN ('confirmado', 'asistio')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_joined');
    END IF;

    -- Solicitud o lista de espera activa duplicada
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado IN ('pending', 'approved', 'waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_requested');
    END IF;

    -- Cooldown de 24h tras rechazo previo
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

    -- Multi-seat validaciones
    IF COALESCE(v_encuentro.allow_multi_seat_requests, false) = true THEN
        v_effective_seat_count := GREATEST(1, LEAST(COALESCE(p_seat_count, 1), COALESCE(v_encuentro.max_seats_per_request, 1)));
        IF v_effective_seat_count < COALESCE(v_encuentro.min_seats_per_request, 1) THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'seats_below_minimum',
                'min_seats_per_request', v_encuentro.min_seats_per_request
            );
        END IF;
    ELSE
        v_effective_seat_count := 1;
    END IF;

    -- 3. Inserción atómica en lista de espera
    INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id,
        usuario_id,
        nombre_solicitante,
        mensaje,
        estado,
        seat_count,
        is_waitlist,
        created_at,
        updated_at
    ) VALUES (
        p_encuentro_id,
        v_user_id,
        v_clean_nombre,
        p_mensaje,
        'waitlist_waiting',
        v_effective_seat_count,
        true,
        v_now,
        v_now
    ) RETURNING id INTO v_solicitud_id;

    -- 4. Calcular posición ordinal en la lista
    SELECT pg_catalog.count(*)::int INTO v_position
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND estado = 'waitlist_waiting'
      AND created_at <= v_now;

    -- 5. Notificación in-app al solicitante
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
        v_user_id,
        'waitlist_joined',
        'encounter',
        p_encuentro_id,
        '/solicitudes',
        'Te anotaste en la lista de espera',
        'Estás en el puesto #' || v_position || ' para "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '". Te avisaremos si se libera un cupo.',
        pg_catalog.json_build_object(
            'encuentro_id', p_encuentro_id,
            'request_id', v_solicitud_id,
            'position', v_position,
            'seat_count', v_effective_seat_count
        ),
        'waitlist_joined:' || p_encuentro_id || ':' || v_solicitud_id,
        v_now + INTERVAL '30 days'
    ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', v_solicitud_id,
        'position', v_position,
        'seat_count', v_effective_seat_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.unirse_lista_espera_encuentro_abierto(UUID, TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unirse_lista_espera_encuentro_abierto(UUID, TEXT, TEXT, INT) TO authenticated;


-- ------------------------------------------------------------------------------
-- 5. RPC: responder_oferta_lista_espera_seguro
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
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_host_expiry TIMESTAMPTZ;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 1. Bloqueo exclusivo de la solicitud
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_solicitud.usuario_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_solicitud.estado <> 'waitlist_offered' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_state', 'current_state', v_solicitud.estado);
    END IF;

    -- 2. Inspección del encuentro
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_solicitud.encuentro_id
    FOR UPDATE;

    -- 3. Verificar si la oferta ya expiró
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

    -- 4. Procesar decisión del candidato
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
GRANT EXECUTE ON FUNCTION public.responder_oferta_lista_espera_seguro(UUID, BOOLEAN) TO authenticated;


-- ------------------------------------------------------------------------------
-- 6. RPC: retirarse_lista_espera_seguro
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
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_had_reservation BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_solicitud.usuario_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_solicitud.estado NOT IN ('waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_withdraw_state', 'current_state', v_solicitud.estado);
    END IF;

    v_had_reservation := (v_solicitud.estado IN ('waitlist_offered', 'waitlist_confirmed'));

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
GRANT EXECUTE ON FUNCTION public.retirarse_lista_espera_seguro(UUID) TO authenticated;


-- ------------------------------------------------------------------------------
-- 7. ACTUALIZAR: aprobar_solicitud_encuentro_abierto (Soporte de Waitlist)
-- ------------------------------------------------------------------------------

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
    v_other_reserved_seats int := 0;
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

    -- Control B: Estado activo
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

    -- Admite tanto 'pending' (solicitud directa) como 'waitlist_confirmed' (promovido de lista de espera)
    IF v_solicitud.estado NOT IN ('pending', 'waitlist_confirmed') THEN
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

    -- Cupos reservados por OTRAS solicitudes en espera de confirmación o aprobación
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_other_reserved_seats
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = v_encuentro.id
      AND id <> p_request_id
      AND estado IN ('waitlist_offered', 'waitlist_confirmed');

    IF (v_confirmed_seats + v_other_reserved_seats + v_req_seats) > v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'capacity_exceeded',
            'available_slots', GREATEST(0, v_encuentro.max_participants - (v_confirmed_seats + v_other_reserved_seats)),
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
          AND estado IN ('pending', 'waitlist_confirmed');
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

    v_nuevo_disponible := GREATEST(0, v_encuentro.max_participants - (v_confirmed_seats + v_other_reserved_seats + v_req_seats));

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


-- ------------------------------------------------------------------------------
-- 8. ACTUALIZAR: rechazar_solicitud_encuentro_abierto (Liberación de Waitlist)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rechazar_solicitud_encuentro_abierto(
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
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_had_reservation BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- Bloqueo del encuentro
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

    -- Bloqueo de la solicitud
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
      AND encuentro_id = v_encuentro.id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- Idempotencia
    IF v_solicitud.estado = 'rejected' THEN
        RETURN pg_catalog.json_build_object('ok', true, 'request_id', p_request_id, 'already_rejected', true);
    END IF;

    IF v_solicitud.estado NOT IN ('pending', 'waitlist_confirmed', 'waitlist_offered', 'waitlist_waiting') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_request_state');
    END IF;

    v_had_reservation := (v_solicitud.estado IN ('waitlist_offered', 'waitlist_confirmed'));

    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'rejected',
        resolved_at = v_now,
        updated_at = v_now
    WHERE id = p_request_id;

    -- Si era un postulante con reserva temporal, promover al siguiente candidato
    IF v_had_reservation THEN
        PERFORM public.evaluar_y_promover_lista_espera(v_encuentro.id);
    END IF;

    -- Notificación in-app
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
        v_solicitud.usuario_id,
        'open_encounter_rejected',
        'encounter',
        v_encuentro.id,
        '/solicitudes',
        'Solicitud no aprobada',
        'El anfitrión no pudo aceptar tu solicitud para sumarte a "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '".',
        pg_catalog.json_build_object(
            'encuentro_id', v_encuentro.id,
            'request_id', p_request_id
        ),
        'open_request_rejected:' || p_request_id,
        v_now + INTERVAL '30 days'
    ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;

    RETURN pg_catalog.json_build_object('ok', true, 'request_id', p_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID) TO authenticated;


-- ------------------------------------------------------------------------------
-- 9. ENGANCHE DE LIBERACIÓN DE CUPOS EN RECONFIRMAR / DESISTIR
-- ------------------------------------------------------------------------------

-- Cuando un participante declina o desiste de un encuentro abierto, se invoca
-- automáticamente la promoción de la lista de espera.
CREATE OR REPLACE FUNCTION public.trigger_liberacion_cupo_waitlist()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF (OLD.estado IN ('confirmado', 'asistio') AND NEW.estado IN ('cancelado', 'rechazado'))
       OR (OLD.reconfirmation_status = 'confirmed' AND NEW.reconfirmation_status = 'declined') THEN
        PERFORM public.evaluar_y_promover_lista_espera(NEW.encuentro_id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_participantes_liberacion_waitlist ON public.participantes;
CREATE TRIGGER trg_participantes_liberacion_waitlist
    AFTER UPDATE OF estado, reconfirmation_status ON public.participantes
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_liberacion_cupo_waitlist();


-- ------------------------------------------------------------------------------
-- 10. RPC: get_estado_lista_espera_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_estado_lista_espera_seguro(
    p_encuentro_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_position INT := NULL;
    v_total_waiting INT := 0;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_secs_remaining INT := NULL;
BEGIN
    SELECT pg_catalog.count(*)::int INTO v_total_waiting
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND estado = 'waitlist_waiting';

    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'in_waitlist', false,
            'total_waiting', v_total_waiting
        );
    END IF;

    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
      AND estado IN ('waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'in_waitlist', false,
            'total_waiting', v_total_waiting
        );
    END IF;

    IF v_solicitud.estado = 'waitlist_waiting' THEN
        SELECT pg_catalog.count(*)::int INTO v_position
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND estado = 'waitlist_waiting'
          AND created_at <= v_solicitud.created_at;
    END IF;

    IF v_solicitud.estado = 'waitlist_offered' AND v_solicitud.waitlist_expires_at IS NOT NULL THEN
        v_secs_remaining := GREATEST(0, EXTRACT(epoch FROM (v_solicitud.waitlist_expires_at - v_now))::int);
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'in_waitlist', true,
        'request_id', v_solicitud.id,
        'status', v_solicitud.estado,
        'position', v_position,
        'total_waiting', v_total_waiting,
        'seat_count', COALESCE(v_solicitud.seat_count, 1),
        'waitlist_offered_at', v_solicitud.waitlist_offered_at,
        'waitlist_expires_at', v_solicitud.waitlist_expires_at,
        'seconds_remaining', v_secs_remaining,
        'waitlist_confirmed_at', v_solicitud.waitlist_confirmed_at,
        'host_approval_expires_at', v_solicitud.host_approval_expires_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_estado_lista_espera_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_estado_lista_espera_seguro(UUID) TO authenticated, anon;


-- ------------------------------------------------------------------------------
-- 11. RPC: procesar_expiraciones_lista_espera_seguro (Mantenimiento Periódico)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.procesar_expiraciones_lista_espera_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_rec RECORD;
    v_encuentros_procesados INT := 0;
BEGIN
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

REVOKE ALL ON FUNCTION public.procesar_expiraciones_lista_espera_seguro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.procesar_expiraciones_lista_espera_seguro() TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 12. ACTUALIZAR: get_mis_solicitudes_seguro (Proyección de Waitlist)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_mis_solicitudes_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_result JSON;
BEGIN
    IF v_user_id IS NULL OR v_is_anon THEN
        RETURN '[]'::json;
    END IF;

    SELECT pg_catalog.json_agg(
        pg_catalog.json_build_object(
            'request_id',               s.id,
            'encuentro_id',             s.encuentro_id,
            'estado',                   s.estado,
            'seat_count',               COALESCE(s.seat_count, 1),
            'is_waitlist',              COALESCE(s.is_waitlist, false),
            'waitlist_offered_at',      s.waitlist_offered_at,
            'waitlist_expires_at',      s.waitlist_expires_at,
            'waitlist_confirmed_at',    s.waitlist_confirmed_at,
            'host_approval_expires_at', s.host_approval_expires_at,
            'waitlist_position',        CASE
                                            WHEN s.estado = 'waitlist_waiting' THEN (
                                                SELECT pg_catalog.count(*)::int
                                                FROM public.solicitudes_encuentro_abierto w
                                                WHERE w.encuentro_id = s.encuentro_id
                                                  AND w.estado = 'waitlist_waiting'
                                                  AND w.created_at <= s.created_at
                                            )
                                            ELSE NULL
                                        END,
            'created_at',               s.created_at,
            'resolved_at',              s.resolved_at,
            'open_public_title',        COALESCE(e.open_public_title, 'Encuentro'),
            'fecha',                    e.fecha,
            'hora',                     e.hora,
            'modalidad',                e.modalidad,
            'open_public_zone',         COALESCE(e.open_public_zone, 'Virtual'),
            'is_expired',               (e.fecha IS NOT NULL AND (e.fecha + COALESCE(e.hora, '23:59'::time)) < pg_catalog.now())
        )
        ORDER BY
            (s.estado IN ('waitlist_offered', 'waitlist_confirmed', 'pending')) DESC,
            s.created_at DESC
    )
    INTO v_result
    FROM public.solicitudes_encuentro_abierto s
    JOIN public.encuentros e ON e.id = s.encuentro_id
    WHERE s.usuario_id = v_user_id;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_mis_solicitudes_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mis_solicitudes_seguro() TO authenticated;


-- ------------------------------------------------------------------------------
-- 13. ACTUALIZAR: get_solicitudes_host_seguro (Proyección de Waitlist)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_solicitudes_host_seguro(
    p_encuentro_id UUID,
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
    v_encuentro public.encuentros%ROWTYPE;
    v_result JSON;
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
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT pg_catalog.json_agg(r) INTO v_result
    FROM (
        SELECT
            id,
            encuentro_id,
            usuario_id,
            nombre_solicitante,
            mensaje,
            motivo_baja,
            estado,
            is_waitlist,
            waitlist_offered_at,
            waitlist_expires_at,
            waitlist_confirmed_at,
            host_approval_expires_at,
            participante_id,
            token_participante,
            created_at,
            resolved_at,
            COALESCE(seat_count, 1) AS seat_count
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
        ORDER BY
            (estado IN ('waitlist_confirmed', 'pending')) DESC,
            created_at DESC,
            id DESC
    ) r;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'solicitudes', COALESCE(v_result, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_solicitudes_host_seguro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_solicitudes_host_seguro(UUID, UUID) TO authenticated;


-- ------------------------------------------------------------------------------
-- 14. ACTUALIZAR: get_discovery_encuentros_abiertos (Cupos con Reserva de Espera)
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
          AND (v_user_id IS NULL OR e.host_id <> ALL(v_blocked_host_ids))
          AND (
              p_locality_ids IS NULL
              OR cardinality(p_locality_ids) = 0
              OR e.locality_id = ANY(p_locality_ids)
          )
          AND (
              p_only_available = false
              OR (
                  COALESCE(e.inscriptions_closed, false) = false
                  AND GREATEST(0, e.max_participants - (COALESCE(p_agg.confirmed_seats, 0) + COALESCE(w_agg.reserved_seats, 0))) >= COALESCE(e.min_seats_per_request, 1)
              )
          )
        ORDER BY e.opened_at DESC, e.id DESC
    ) row_data;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) TO anon, authenticated;


-- ------------------------------------------------------------------------------
-- 15. ACTUALIZAR: solicitar_sumarse_encuentro_abierto (Respeto de Reservas y Cola)
-- ------------------------------------------------------------------------------

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

    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_encuentro.host_id)
           OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_available');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado IN ('pending', 'waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_requested');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_user_id
          AND estado IN ('confirmado', 'asistio')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_joined');
    END IF;

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

    v_rl := public.verificar_y_consumir_rate_limit(v_user_id, 'join_request', 5, INTERVAL '1 hour');
    IF (v_rl->>'allowed')::boolean = false THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'rate_limit_exceeded',
            'reset_at', v_rl->>'reset_at'
        );
    END IF;

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
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) TO authenticated;


-- ------------------------------------------------------------------------------
-- 16. PROGRAMACIÓN PERIÓDICA DE EXPIRACIONES (pg_cron)
-- ------------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('expiracion_lista_espera_job');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        PERFORM cron.schedule(
            'expiracion_lista_espera_job',
            '*/2 * * * *',
            'SELECT public.procesar_expiraciones_lista_espera_seguro();'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

COMMIT;
