-- ============================================================
-- Migración: 20261004120000_open_encounter_join_request_events_and_inbox.sql
-- Módulo: Eventos de Dominio, Notificaciones de Inbox y Validación de Ubicación Privada
-- ============================================================

BEGIN;

-- 1. ACTUALIZAR RPC: abrir_encuentro_seguro
-- Invariante adicional de seguridad y completitud:
-- - presencial: requiere lugar_texto no vacío
-- - virtual: requiere link_virtual no vacío
CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT DEFAULT NULL,
    p_open_public_zone TEXT DEFAULT NULL -- DEPRECATED: ignorado. Se deriva en servidor.
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_final_locality_id TEXT := NULL;
    v_final_public_zone TEXT := NULL;
    v_loc_record RECORD;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_conv_intencion RECORD;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_inactive');
    END IF;

    -- Validar que la ubicación privada no esté vacía
    IF v_encuentro.modalidad = 'presencial' THEN
        IF v_encuentro.lugar_texto IS NULL OR trim(v_encuentro.lugar_texto) = '' THEN
            RETURN json_build_object('ok', false, 'error', 'private_location_required');
        END IF;

        IF p_locality_id IS NULL OR trim(p_locality_id) = '' THEN
            RETURN json_build_object('ok', false, 'error', 'locality_required');
        END IF;

        SELECT id, nombre INTO v_loc_record
        FROM public.localidades
        WHERE id = trim(p_locality_id) AND activo = true;

        IF NOT FOUND THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_locality');
        END IF;

        v_final_locality_id := v_loc_record.id;
        v_final_public_zone := v_loc_record.nombre;
    ELSIF v_encuentro.modalidad = 'virtual' THEN
        IF v_encuentro.link_virtual IS NULL OR trim(v_encuentro.link_virtual) = '' THEN
            RETURN json_build_object('ok', false, 'error', 'private_virtual_link_required');
        END IF;

        v_final_locality_id := NULL;
        v_final_public_zone := 'Virtual';
    ELSE
        RETURN json_build_object('ok', false, 'error', 'unsupported_modality');
    END IF;

    -- Validar cupo
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado = 'confirmado';

    IF p_max_participants < (v_confirmed_count + 1) THEN
        RETURN json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    IF p_max_participants < 2 THEN
        RETURN json_build_object('ok', false, 'error', 'min_two_participants');
    END IF;

    IF NOT v_encuentro.is_open THEN
        -- Transición real cerrado -> abierto (false -> true)
        UPDATE public.encuentros
        SET is_open = true,
            open_description = NULLIF(trim(p_open_description), ''),
            max_participants = p_max_participants,
            locality_id = v_final_locality_id,
            open_public_zone = v_final_public_zone,
            opened_at = v_now,
            closed_at = NULL
        WHERE id = p_encuentro_id;

        -- Emitir alertas outbox para intenciones convertidas previamente si existieran
        FOR v_conv_intencion IN
            SELECT id
            FROM public.intenciones
            WHERE encuentro_id = p_encuentro_id
              AND estado = 'convertida'
        LOOP
            PERFORM public.emitir_alertas_intencion_convertida_outbox(v_conv_intencion.id, p_encuentro_id);
        END LOOP;

        -- Emisión del Domain Event: encounter.opened.v1 (Transactional Outbox)
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
            'encounter.opened.v1',
            1,
            'encounter',
            p_encuentro_id,
            v_user_id,
            jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'host_id', v_user_id,
                'modalidad', v_encuentro.modalidad,
                'locality_id', v_final_locality_id,
                'max_participants', p_max_participants,
                'opened_at', v_now
            ),
            format('encounter:%s:opened:%s', p_encuentro_id, extract(epoch from v_now)::text),
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;
    ELSE
        -- Ya está abierto: actualizar configuración sin alterar opened_at ni emitir encounter.opened.v1
        UPDATE public.encuentros
        SET open_description = NULLIF(trim(p_open_description), ''),
            max_participants = p_max_participants,
            locality_id = v_final_locality_id,
            open_public_zone = v_final_public_zone
        WHERE id = p_encuentro_id;
    END IF;

    RETURN json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'is_open', true,
        'max_participants', p_max_participants,
        'locality_id', v_final_locality_id,
        'open_public_zone', v_final_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    TO authenticated;


-- 2. ACTUALIZAR RPC: solicitar_sumarse_encuentro_abierto
-- Agrega:
-- A) Inserción atómica en domain_events_outbox (encounter.join_request.created.v1)
-- B) Inserción en public.inbox_notifications para el host con deep link /meet/{id}#solicitudes
--    (el trigger trg_enqueue_web_push_deliveries se activa automáticamente)
CREATE OR REPLACE FUNCTION public.solicitar_sumarse_encuentro_abierto(
    p_encuentro_id UUID,
    p_nombre TEXT,
    p_mensaje TEXT DEFAULT NULL,
    p_usuario_id UUID DEFAULT NULL  -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
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
    v_confirmed_count INT := 0;
    v_solicitud_id UUID;
    v_clean_nombre TEXT;
    v_rejected_at TIMESTAMPTZ;
    v_rl JSONB;
    v_now TIMESTAMPTZ := timezone('utc', now());
    v_notif_res JSONB;
BEGIN
    -- SEGURIDAD: identidad obligatoria y permanente
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_clean_nombre := trim(COALESCE(p_nombre, ''));
    IF length(v_clean_nombre) < 2 THEN
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

    -- Validar que no sea el host
    IF v_encuentro.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_join_own_encounter');
    END IF;

    -- ENFORCEMENT DE BLOQUEO BILATERAL (Fail-closed silencioso)
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

    -- Validar que no sea ya un participante confirmado (por usuario_id en solicitudes aprobadas)
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado = 'approved'
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_participant');
    END IF;

    -- Validar cupo disponible
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado = 'confirmado';

    IF (v_confirmed_count + 1) >= v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_full');
    END IF;

    -- COOLDOWN POST-RECHAZO (6 horas desde el timestamp efectivo del último rejected para este encuentro)
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

    -- ENFORCEMENT DE RATE LIMITING SERVER-SIDE (action: join_open_encounter)
    v_rl := public.check_rate_limit_internal('join_open_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- Insertar solicitud
    INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id,
        usuario_id,
        nombre_solicitante,
        mensaje,
        estado
    ) VALUES (
        p_encuentro_id,
        v_user_id,
        v_clean_nombre,
        NULLIF(trim(p_mensaje), ''),
        'pending'
    ) RETURNING id INTO v_solicitud_id;

    -- Emisión de Domain Event: encounter.join_request.created.v1 (Transactional Outbox)
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
        jsonb_build_object(
            'request_id', v_solicitud_id,
            'encounter_id', p_encuentro_id,
            'host_id', v_encuentro.host_id,
            'applicant_name', v_clean_nombre
        ),
        format('encounter:%s:join_request:%s', p_encuentro_id, v_solicitud_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    -- Inserción directa en Inbox del Host
    -- El trigger trg_enqueue_web_push_deliveries en inbox_notifications encolará automáticamente
    -- la entrega Web Push si el host tiene suscripciones push activas.
    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_encuentro.host_id,
        p_notification_type := 'open_encounter_join_request',
        p_target_type := 'encounter',
        p_target_id := p_encuentro_id,
        p_deep_link := '/meet/' || p_encuentro_id || '#solicitudes',
        p_title := 'Nueva solicitud para sumarse',
        p_body := v_clean_nombre || ' envió una solicitud para sumarse a tu encuentro.',
        p_payload := jsonb_build_object(
            'encounter_id', p_encuentro_id,
            'request_id', v_solicitud_id,
            'applicant_name', v_clean_nombre
        ),
        p_dedup_key := 'join_request:' || v_solicitud_id
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', v_solicitud_id,
        'estado', 'pending'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID)
    TO authenticated;

COMMIT;
