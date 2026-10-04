-- ============================================================
-- Migración: 20261004130000_enable_realtime_and_sanitize_join_request_event.sql
-- Módulo: Realtime Publication, RLS Host y Sanitización de Evento Outbox
-- ============================================================

BEGIN;

-- 1. PUBLICACIÓN REALTIME Y RLS PARA solicitudes_encuentro_abierto E inbox_notifications
GRANT SELECT ON TABLE public.solicitudes_encuentro_abierto TO authenticated;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'solicitudes_encuentro_abierto'
          AND policyname = 'solicitudes_host_read_policy'
    ) THEN
        CREATE POLICY solicitudes_host_read_policy
            ON public.solicitudes_encuentro_abierto
            FOR SELECT
            TO authenticated
            USING (
                EXISTS (
                    SELECT 1 FROM public.encuentros e
                    WHERE e.id = solicitudes_encuentro_abierto.encuentro_id
                      AND e.host_id = auth.uid()
                )
                AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
            );
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_rel pr
            JOIN pg_class c ON c.oid = pr.prrelid
            JOIN pg_publication p ON p.oid = pr.prpubid
            WHERE p.pubname = 'supabase_realtime' AND c.relname = 'inbox_notifications'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox_notifications;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_rel pr
            JOIN pg_class c ON c.oid = pr.prrelid
            JOIN pg_publication p ON p.oid = pr.prpubid
            WHERE p.pubname = 'supabase_realtime' AND c.relname = 'solicitudes_encuentro_abierto'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.solicitudes_encuentro_abierto;
        END IF;
    END IF;
END $$;


-- 2. ACTUALIZAR RPC: solicitar_sumarse_encuentro_abierto
-- Sanitiza el payload de domain_events_outbox para encounter.join_request.created.v1
-- removiendo applicant_name para minimizar PII en outbox.
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
    -- NOTA PRIVACIDAD: applicant_name omitido del outbox payload (ya se guarda en inbox_notifications)
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
            'host_id', v_encuentro.host_id
        ),
        format('encounter:%s:join_request:%s', p_encuentro_id, v_solicitud_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    -- Inserción directa en Inbox del Host
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
