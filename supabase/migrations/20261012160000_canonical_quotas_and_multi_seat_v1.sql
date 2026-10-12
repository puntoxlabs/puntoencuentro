-- ============================================================
-- Migración: 20261012160000_canonical_quotas_and_multi_seat_v1.sql
-- Objetivo:
--   1. Bug P0 Cupos: Unificar semántica canónica de capacidad.
--      public_capacity = lugares para personas externas (max_participants).
--      El host NO consume un lugar visible.
--      available_seats = max_participants - confirmed_external_seats.
--   2. Multi-seat V1: Permitir reserva múltiple opcional por encuentro
--      con validación server-side, lock concurrente en aprobación
--      y liberación automática en cancelación.
--   3. Normalización y backfill de registros existentes.
-- ============================================================

BEGIN;

-- 1. ALTER TABLE public.encuentros
ALTER TABLE public.encuentros
ADD COLUMN IF NOT EXISTS allow_multi_seat_requests BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS max_seats_per_request INT NOT NULL DEFAULT 1;

-- Constraint de multi-seat en encuentros
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_encuentro_multi_seat'
    ) THEN
        ALTER TABLE public.encuentros
        ADD CONSTRAINT check_encuentro_multi_seat
        CHECK (
            (allow_multi_seat_requests = false AND max_seats_per_request = 1)
            OR
            (allow_multi_seat_requests = true AND max_seats_per_request >= 2)
        );
    END IF;
END $$;

-- Actualizar check_encuentro_abierto_integrity para permitir max_participants >= 1 (lugares externos)
ALTER TABLE public.encuentros
DROP CONSTRAINT IF EXISTS check_encuentro_abierto_integrity;

ALTER TABLE public.encuentros
ADD CONSTRAINT check_encuentro_abierto_integrity
CHECK (
    (is_open = false)
    OR
    (
        is_open = true
        AND max_participants IS NOT NULL
        AND max_participants >= 1
        AND (
            (modalidad = 'presencial' AND locality_id IS NOT NULL AND open_public_zone IS NOT NULL AND pg_catalog.btrim(open_public_zone) <> '')
            OR
            (modalidad = 'virtual' AND locality_id IS NULL AND open_public_zone = 'Virtual')
        )
    )
);

-- Backfill encuentros abiertos existentes:
-- En la versión anterior el modal sumaba +1 para el anfitrión.
-- Normalizamos para que max_participants represente directamente cupos externos.
UPDATE public.encuentros
SET max_participants = max_participants - 1
WHERE is_open = true AND max_participants >= 2;

-- 2. ALTER TABLE public.solicitudes_encuentro_abierto
ALTER TABLE public.solicitudes_encuentro_abierto
ADD COLUMN IF NOT EXISTS seat_count INT NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_solicitud_seat_count'
    ) THEN
        ALTER TABLE public.solicitudes_encuentro_abierto
        ADD CONSTRAINT check_solicitud_seat_count
        CHECK (seat_count >= 1);
    END IF;
END $$;

-- 3. ALTER TABLE public.participantes
ALTER TABLE public.participantes
ADD COLUMN IF NOT EXISTS seat_count INT NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_participante_seat_count'
    ) THEN
        ALTER TABLE public.participantes
        ADD CONSTRAINT check_participante_seat_count
        CHECK (seat_count >= 1);
    END IF;
END $$;

-- Backfill histórico: asegurar que todos los registros preexistentes tengan seat_count = 1
UPDATE public.solicitudes_encuentro_abierto
SET seat_count = 1
WHERE seat_count IS NULL OR seat_count < 1;

UPDATE public.participantes
SET seat_count = 1
WHERE seat_count IS NULL OR seat_count < 1;

-- 4. RPC abrir_encuentro_seguro (actualizada con multi-seat y cupo externo directo)
DROP FUNCTION IF EXISTS public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT);

CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT DEFAULT NULL,
    p_open_public_zone TEXT DEFAULT NULL,
    p_open_public_title TEXT DEFAULT NULL,
    p_allow_multi_seat_requests BOOLEAN DEFAULT false,
    p_max_seats_per_request INT DEFAULT 1
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
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_user_id <> p_host_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id AND host_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_inactive');
    END IF;

    -- Resolución y validación del título público
    IF p_open_public_title IS NOT NULL AND pg_catalog.btrim(p_open_public_title) <> '' THEN
        v_final_public_title := pg_catalog.btrim(p_open_public_title);
    ELSIF v_encuentro.open_public_title IS NOT NULL AND pg_catalog.btrim(v_encuentro.open_public_title) <> '' THEN
        v_final_public_title := pg_catalog.btrim(v_encuentro.open_public_title);
    ELSE
        -- Primera apertura: inicializar explícitamente desde el título privado
        v_final_public_title := pg_catalog.btrim(v_encuentro.titulo);
    END IF;

    IF v_final_public_title IS NULL OR pg_catalog.length(v_final_public_title) < 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_short');
    END IF;

    IF pg_catalog.length(v_final_public_title) > 80 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_long');
    END IF;

    -- Validaciones de descripción pública
    IF p_open_description IS NULL OR pg_catalog.length(pg_catalog.btrim(p_open_description)) < 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'description_too_short');
    END IF;

    -- Validar que la ubicación privada no esté vacía
    IF v_encuentro.modalidad = 'presencial' THEN
        IF v_encuentro.lugar_texto IS NULL OR pg_catalog.btrim(v_encuentro.lugar_texto) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'private_location_required');
        END IF;

        IF p_locality_id IS NULL OR pg_catalog.btrim(p_locality_id) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'locality_required');
        END IF;

        SELECT id, nombre INTO v_loc_record
        FROM public.localidades
        WHERE id = pg_catalog.btrim(p_locality_id) AND activo = true;

        IF NOT FOUND THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_locality');
        END IF;

        v_final_locality_id := v_loc_record.id;
        v_final_public_zone := COALESCE(NULLIF(pg_catalog.btrim(p_open_public_zone), ''), v_loc_record.nombre);
    ELSE
        IF v_encuentro.link_virtual IS NULL OR pg_catalog.btrim(v_encuentro.link_virtual) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'private_link_required');
        END IF;
        v_final_locality_id := NULL;
        v_final_public_zone := 'Virtual';
    END IF;

    -- Validar cupo externo (mínimo 1, máximo 40)
    IF p_max_participants IS NULL OR p_max_participants < 1 OR p_max_participants > 40 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_slots');
    END IF;

    -- Validar que no se reduzca el cupo por debajo de los lugares ya confirmados
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    IF p_max_participants < v_confirmed_seats THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    -- Validar parámetros de reserva múltiple
    IF COALESCE(p_allow_multi_seat_requests, false) THEN
        IF p_max_seats_per_request IS NULL OR p_max_seats_per_request < 2 OR p_max_seats_per_request > p_max_participants THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_max_seats_per_request');
        END IF;
        v_final_multi_seat := true;
        v_final_max_seats := p_max_seats_per_request;
    ELSE
        v_final_multi_seat := false;
        v_final_max_seats := 1;
    END IF;

    v_was_open := v_encuentro.is_open;

    -- MODERACIÓN DETERMINISTA PREVIA AL DISPATCH
    SELECT * INTO v_eval
    FROM public.evaluar_contenido_publico_determinista(v_final_public_title, p_open_description);

    -- CASO 1: BLOQUEO DETERMINISTA INMEDIATO (CHOKE POINT)
    IF v_eval.decision = 'block' THEN
        UPDATE public.encuentros
        SET moderation_status = 'rejected',
            moderation_reason = v_eval.reason,
            moderated_at = v_now,
            moderation_decision_source = 'deterministic',
            moderation_categories = v_eval.categories,
            open_public_title = v_final_public_title,
            is_open = false,
            closed_at = CASE WHEN v_was_open THEN v_now ELSE closed_at END,
            max_participants = p_max_participants,
            allow_multi_seat_requests = v_final_multi_seat,
            max_seats_per_request = v_final_max_seats
        WHERE id = p_encuentro_id;

        INSERT INTO public.public_content_moderation_audit (
            encuentro_id, moderator_id, action, previous_status, new_status,
            reason, categories, source, metadata
        ) VALUES (
            p_encuentro_id, v_user_id, 'deterministic_block', v_encuentro.moderation_status, 'rejected',
            v_eval.reason, v_eval.categories, 'deterministic',
            pg_catalog.jsonb_build_object(
                'open_public_title', v_final_public_title,
                'open_description', p_open_description
            )
        );

        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'content_moderation_blocked',
            'moderation_status', 'rejected',
            'reason', v_eval.reason
        );
    END IF;

    -- CASO 2: NO BLOQUEADO -> Preparar para publicación pero dejar en REVIEW_PENDING e IS_OPEN = FALSE
    UPDATE public.encuentros
    SET moderation_status = 'review_pending',
        moderation_reason = v_eval.reason,
        moderated_at = v_now,
        moderation_decision_source = 'deterministic',
        moderation_categories = v_eval.categories,
        is_open = false,
        open_public_title = v_final_public_title,
        open_description = NULLIF(pg_catalog.btrim(p_open_description), ''),
        max_participants = p_max_participants,
        allow_multi_seat_requests = v_final_multi_seat,
        max_seats_per_request = v_final_max_seats,
        locality_id = v_final_locality_id,
        open_public_zone = v_final_public_zone,
        closed_at = CASE WHEN v_was_open THEN v_now ELSE closed_at END
    WHERE id = p_encuentro_id;

    INSERT INTO public.public_content_moderation_audit (
        encuentro_id, moderator_id, action, previous_status, new_status,
        reason, categories, source, metadata
    ) VALUES (
        p_encuentro_id, v_user_id, 'publish_requested', v_encuentro.moderation_status, 'review_pending',
        v_eval.reason, v_eval.categories, 'user_request',
        pg_catalog.jsonb_build_object(
            'open_public_title', v_final_public_title,
            'open_description', p_open_description
        )
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'is_open', false,
        'moderation_status', 'review_pending',
        'open_public_title', v_final_public_title,
        'open_description', p_open_description,
        'max_participants', p_max_participants,
        'allow_multi_seat_requests', v_final_multi_seat,
        'max_seats_per_request', v_final_max_seats
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT) TO authenticated;

-- 5. RPC solicitar_sumarse_encuentro_abierto (con p_seat_count y validación atómica)
DROP FUNCTION IF EXISTS public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT);

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

    -- REGLA DE RESERVA MÚLTIPLE SERVER-SIDE
    IF NOT COALESCE(v_encuentro.allow_multi_seat_requests, false) THEN
        -- Si multi-seat no está habilitado, forzar estrictamente 1
        v_effective_seat_count := 1;
    ELSE
        v_effective_seat_count := COALESCE(p_seat_count, 1);
        IF v_effective_seat_count < 1 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_seat_count');
        END IF;

        IF v_effective_seat_count > COALESCE(v_encuentro.max_seats_per_request, 1) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'seats_exceed_limit');
        END IF;

        IF v_effective_seat_count > v_encuentro.max_participants THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'seats_exceed_capacity');
        END IF;
    END IF;

    -- Validar cupo disponible al momento de crear la solicitud
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    v_available_seats := GREATEST(0, v_encuentro.max_participants - v_confirmed_seats);

    IF v_available_seats <= 0 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_full');
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

    -- Insertar solicitud con seat_count
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
        NULLIF(pg_catalog.btrim(p_mensaje), ''),
        'pending',
        v_effective_seat_count
    ) RETURNING id INTO v_solicitud_id;

    -- Domain Event: encounter.join_request.created.v1 (Transactional Outbox)
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
            'host_id', v_encuentro.host_id,
            'seat_count', v_effective_seat_count
        ),
        pg_catalog.format('encounter:%s:join_request:%s', p_encuentro_id, v_solicitud_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    -- Inserción directa en Inbox del Host
    IF v_effective_seat_count > 1 THEN
        v_notif_body := v_clean_nombre || ' envió una solicitud para reservar ' || v_effective_seat_count || ' lugares en tu encuentro.';
    ELSE
        v_notif_body := v_clean_nombre || ' envió una solicitud para sumarse a tu encuentro.';
    END IF;

    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_encuentro.host_id,
        p_notification_type := 'open_encounter_join_request',
        p_target_type := 'encounter',
        p_target_id := p_encuentro_id,
        p_deep_link := '/meet/' || p_encuentro_id || '#solicitudes',
        p_title := 'Nueva solicitud para sumarse',
        p_body := v_notif_body,
        p_payload := pg_catalog.jsonb_build_object(
            'encounter_id', p_encuentro_id,
            'request_id', v_solicitud_id,
            'applicant_name', v_clean_nombre,
            'seat_count', v_effective_seat_count
        ),
        p_dedup_key := 'join_request:' || v_solicitud_id
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', v_solicitud_id,
        'estado', 'pending',
        'seat_count', v_effective_seat_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) TO authenticated;

-- 6. RPC aprobar_solicitud_encuentro_abierto (con row lock de concurrencia y asignación de seat_count)
DROP FUNCTION IF EXISTS public.aprobar_solicitud_encuentro_abierto(UUID, UUID);

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

    -- 2. Bloquear y verificar el encuentro atómicamente para prevenir sobrecupo concurrente
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
        seat_count
    ) VALUES (
        v_participante_id,
        v_encuentro.id,
        v_solicitud.nombre_solicitante,
        'individual',
        'confirmado',
        v_token_invitacion,
        v_solicitud.mensaje,
        v_solicitud.usuario_id,
        v_req_seats
    );

    -- 5. Actualizar solicitud a approved
    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'approved',
        participante_id = v_participante_id,
        token_participante = v_token_invitacion,
        resolved_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    WHERE id = p_request_id;

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

-- 7. RPC get_discovery_encuentros_abiertos (cálculo de open_slots sin +1 host y retorno de multi-seat)
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
            e.locality_id,
            e.open_public_zone,
            COALESCE(e.open_public_zone, l.nombre, 'Sin zona') AS approximate_zone,
            e.host_id,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_count,
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
                COALESCE(pg_catalog.sum(seat_count), 0)::int AS confirmed_seats
            FROM public.participantes
            WHERE estado IN ('confirmado', 'asistio')
            GROUP BY encuentro_id
        ) p_agg ON p_agg.encuentro_id = e.id
        WHERE e.is_open = true
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

-- 8. RPC get_solicitudes_host_seguro (retorna seat_count)
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
            estado,
            participante_id,
            token_participante,
            created_at,
            resolved_at,
            COALESCE(seat_count, 1) AS seat_count
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
        ORDER BY created_at DESC
    ) r;

    RETURN pg_catalog.json_build_object('ok', true, 'solicitudes', COALESCE(v_result, '[]'::json));
END;
$$;

REVOKE ALL ON FUNCTION public.get_solicitudes_host_seguro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_solicitudes_host_seguro(UUID, UUID) TO authenticated;

-- 9. RPC get_detalle_host_seguro (incluye multi-seat metadata y disponibilidad canónica)
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

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
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
        'confirmed_seats', v_confirmed_seats,
        'available_slots', GREATEST(0, COALESCE(v_encuentro.max_participants, 0) - v_confirmed_seats),
        'locality_id', v_encuentro.locality_id,
        'open_public_zone', v_encuentro.open_public_zone,
        'opened_at', v_encuentro.opened_at,
        'closed_at', v_encuentro.closed_at,
        'moderation_status', v_encuentro.moderation_status
    );
END;
$$;

-- 10. RPC actualizar_encuentro_seguro (manejo seguro de max_participants y multi-seat sin moderación innecesaria)
CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro(
    p_encuentro_id uuid,
    p_host_id uuid,
    p_data jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro RECORD;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
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

    IF COALESCE(v_new_allow_multi, false) THEN
        IF v_new_max_seats IS NULL OR v_new_max_seats < 2 OR (v_new_max_participants IS NOT NULL AND v_new_max_seats > v_new_max_participants) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_max_seats_per_request');
        END IF;
    ELSE
        v_new_max_seats := 1;
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

    IF p_data ? 'modalidad' AND v_new_modalidad <> v_encuentro.modalidad THEN
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

    -- Título efectivo a moderar: SOLO open_public_title
    v_effective_eval_title := COALESCE(v_new_open_title, v_encuentro.open_public_title);

    -- Si hubo cambios sustanciales en la publicación abierta, invalidar moderación previa
    IF (v_open_title_changed OR v_open_desc_changed OR v_modality_changed OR v_locality_changed OR v_zone_changed)
       AND (v_encuentro.is_open OR v_encuentro.moderation_status = 'approved') THEN
        v_moderation_invalidated := true;

        -- Evaluar reglas deterministas de inmediato
        SELECT * INTO v_eval
        FROM public.evaluar_contenido_publico_determinista(v_effective_eval_title, v_new_open_desc);
        v_det_reason := v_eval.reason;

        IF v_eval.decision = 'block' THEN
            v_new_status := 'rejected';
            v_new_is_open := false;

            INSERT INTO public.public_content_moderation_audit (
                encuentro_id, moderator_id, action, previous_status, new_status,
                reason, categories, source, metadata
            ) VALUES (
                p_encuentro_id, v_user_id, 'deterministic_block', v_encuentro.moderation_status, 'rejected',
                v_eval.reason, v_eval.categories, 'deterministic_edit',
                pg_catalog.jsonb_build_object(
                    'changed_fields', v_changed_fields,
                    'open_public_title', v_effective_eval_title,
                    'open_description', v_new_open_desc
                )
            );
        ELSE
            v_new_status := 'review_pending';
            v_new_is_open := false;

            INSERT INTO public.public_content_moderation_audit (
                encuentro_id, moderator_id, action, previous_status, new_status,
                reason, categories, source, metadata
            ) VALUES (
                p_encuentro_id, v_user_id, 'content_updated', v_encuentro.moderation_status, 'review_pending',
                'content_updated', ARRAY[]::text[], 'user_edit',
                pg_catalog.jsonb_build_object(
                    'changed_fields', v_changed_fields,
                    'open_public_title', v_effective_eval_title,
                    'open_description', v_new_open_desc
                )
            );
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
        'max_seats_per_request', COALESCE(v_new_max_seats, 1)
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) TO authenticated;

COMMIT;
