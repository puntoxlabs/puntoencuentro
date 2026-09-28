-- ============================================================
-- Migración: 20260928180000_anonymous_account_transfer.sql
-- Módulo: Encuentros Abiertos 1.5-C — Upgrade Seguro y Transfer Ticket
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ACTUALIZAR TRIGGER DE TEMPLATES PARA PERMITIR BYPASS TRANSACCIONAL
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_custom_templates_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_active_count integer;
BEGIN
    -- Bypass explícito durante transferencias de cuenta autorizadas (GUC transaccional)
    IF pg_catalog.current_setting('puntoencuentro.skip_template_limit', true) = 'on' THEN
        RETURN NEW;
    END IF;

    IF NEW.is_active IS DISTINCT FROM true THEN
        RETURN NEW;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(NEW.user_id::text));

    SELECT COUNT(*)
    INTO v_active_count
    FROM public.custom_invitation_templates
    WHERE user_id = NEW.user_id
      AND is_active = true
      AND id IS DISTINCT FROM NEW.id;

    IF v_active_count >= 3 THEN
        RAISE EXCEPTION 'custom_templates_limit_exceeded'
            USING HINT = 'El usuario ya tiene 3 diseños personalizados activos.';
    END IF;

    RETURN NEW;
END;
$$;

-- ============================================================
-- 2. TABLA DE TICKETS DE TRANSFERENCIA CON SNAPSHOTS INMUTABLES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.anonymous_transfer_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    source_user_id_snapshot UUID NOT NULL,
    target_user_id_snapshot UUID,
    token_hash TEXT NOT NULL UNIQUE CHECK (pg_catalog.length(token_hash) = 64),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired', 'revoked')),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    resources_transferred JSONB,
    created_at TIMESTAMPTZ DEFAULT pg_catalog.timezone('utc', pg_catalog.now()) NOT NULL
);

-- Anti-concurrencia: exactamente 1 ticket en estado pending por usuario anónimo
CREATE UNIQUE INDEX IF NOT EXISTS idx_anonymous_transfer_single_pending
    ON public.anonymous_transfer_tickets (source_user_id_snapshot)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_anonymous_transfer_target_user
    ON public.anonymous_transfer_tickets (target_user_id_snapshot)
    WHERE target_user_id_snapshot IS NOT NULL;

ALTER TABLE public.anonymous_transfer_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.anonymous_transfer_tickets FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 3. RPC: get_anonymous_upgrade_state() — ACTUALIZADA COMPLETA
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_anonymous_upgrade_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_has_encounters BOOLEAN := false;
    v_has_zones BOOLEAN := false;
    v_has_participants BOOLEAN := false;
    v_has_requests BOOLEAN := false;
    v_has_templates BOOLEAN := false;
    v_has_ai_sessions BOOLEAN := false;
    v_has_creation_sessions BOOLEAN := false;
    v_has_other BOOLEAN := false;
    v_has_transferable BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF NOT v_is_anon THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'is_anonymous', false,
            'has_owned_encounters', false,
            'has_server_zones', false,
            'has_participant_links', false,
            'has_open_requests', false,
            'has_custom_templates', false,
            'has_ai_sessions', false,
            'has_creation_sessions', false,
            'has_other_transferable_resources', false,
            'has_transferable_resources', false
        );
    END IF;

    -- 1. Encuentros propios como anfitrión
    SELECT EXISTS (
        SELECT 1 FROM public.encuentros WHERE host_id = v_user_id LIMIT 1
    ) INTO v_has_encounters;

    -- 2. Preferencias de localidades
    SELECT EXISTS (
        SELECT 1 FROM public.usuario_localidades WHERE user_id = v_user_id LIMIT 1
    ) INTO v_has_zones;

    -- 3. Participaciones enlazadas
    SELECT EXISTS (
        SELECT 1 FROM public.participantes WHERE user_id = v_user_id LIMIT 1
    ) INTO v_has_participants;

    -- 4. Solicitudes a encuentros abiertos
    SELECT EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE usuario_id = v_user_id LIMIT 1
    ) INTO v_has_requests;

    -- 5. Diseños de invitación personalizados
    SELECT EXISTS (
        SELECT 1 FROM public.custom_invitation_templates WHERE user_id = v_user_id LIMIT 1
    ) INTO v_has_templates;

    -- 6. Sesiones de creación IA
    SELECT EXISTS (
        SELECT 1 FROM public.ai_creation_sessions WHERE user_id = v_user_id LIMIT 1
    ) INTO v_has_ai_sessions;

    -- 7. Sesiones de creación / observabilidad QA
    SELECT EXISTS (
        SELECT 1 FROM public.creation_sessions WHERE user_id = v_user_id LIMIT 1
    ) INTO v_has_creation_sessions;

    v_has_other := (v_has_participants OR v_has_requests OR v_has_templates OR v_has_ai_sessions OR v_has_creation_sessions);
    v_has_transferable := (v_has_encounters OR v_has_zones OR v_has_other);

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'is_anonymous', true,
        'has_owned_encounters', v_has_encounters,
        'has_server_zones', v_has_zones,
        'has_participant_links', v_has_participants,
        'has_open_requests', v_has_requests,
        'has_custom_templates', v_has_templates,
        'has_ai_sessions', v_has_ai_sessions,
        'has_creation_sessions', v_has_creation_sessions,
        'has_other_transferable_resources', v_has_other,
        'has_transferable_resources', v_has_transferable
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_anonymous_upgrade_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_anonymous_upgrade_state() TO authenticated;

-- ============================================================
-- 4. RPC: create_anonymous_transfer_ticket()
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_anonymous_transfer_ticket()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_raw_token TEXT;
    v_token_hash TEXT;
    v_expires_at TIMESTAMPTZ;
    v_has_resources BOOLEAN := false;
    v_existing_ticket_id UUID;
    v_existing_expires_at TIMESTAMPTZ;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF NOT v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_user_required');
    END IF;

    -- Serialización transaccional estricta por source
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_user_id::text || '_transfer_ticket'));

    -- Verificación exhaustiva de recursos transferibles
    SELECT (
        EXISTS (SELECT 1 FROM public.encuentros WHERE host_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.usuario_localidades WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.participantes WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE usuario_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.custom_invitation_templates WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.creation_sessions WHERE user_id = v_user_id)
    ) INTO v_has_resources;

    IF NOT v_has_resources THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'no_transferable_resources');
    END IF;

    -- Verificar si ya existe un ticket pending vigente
    SELECT id, expires_at INTO v_existing_ticket_id, v_existing_expires_at
    FROM public.anonymous_transfer_tickets
    WHERE source_user_id_snapshot = v_user_id
      AND status = 'pending';

    IF FOUND THEN
        IF v_existing_expires_at > pg_catalog.timezone('utc', pg_catalog.now()) THEN
            -- Ticket vigente existe: no revocarlo, no crear otro, informar conflicto controlado
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'transfer_ticket_already_pending'
            );
        ELSE
            -- El ticket expiró: marcarlo expired y permitir crear el nuevo
            UPDATE public.anonymous_transfer_tickets
            SET status = 'expired'
            WHERE id = v_existing_ticket_id;
        END IF;
    END IF;

    -- 256 bits reales certificados usando extensions.gen_random_bytes(32)
    v_raw_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
    v_token_hash := pg_catalog.encode(pg_catalog.sha256(v_raw_token::bytea), 'hex');
    v_expires_at := pg_catalog.timezone('utc', pg_catalog.now()) + interval '15 minutes';

    INSERT INTO public.anonymous_transfer_tickets (
        source_user_id,
        source_user_id_snapshot,
        token_hash,
        expires_at,
        status
    ) VALUES (
        v_user_id,
        v_user_id,
        v_token_hash,
        v_expires_at,
        'pending'
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'ticket_token', v_raw_token,
        'expires_at', v_expires_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.create_anonymous_transfer_ticket() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_anonymous_transfer_ticket() TO authenticated;

-- ============================================================
-- 5. RPC: claim_anonymous_transfer(p_transfer_token)
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_anonymous_transfer(
    p_transfer_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_target_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_clean_token TEXT;
    v_token_hash TEXT;
    v_ticket public.anonymous_transfer_tickets%ROWTYPE;
    v_source_user_id UUID;
    v_source_is_anon BOOLEAN;
    
    -- Contadores de auditoría
    v_encuentros_count INT := 0;
    v_localidades_count INT := 0;
    v_participantes_count INT := 0;
    v_solicitudes_count INT := 0;
    v_templates_count INT := 0;
    v_ai_sessions_count INT := 0;
    v_creation_sessions_count INT := 0;

    -- Scope de encuentros afectados
    v_source_owned_enc_ids UUID[];
    v_affected_external_enc_ids UUID[];

    -- Variables de loop y canonización
    v_enc_id UUID;
    v_canonical_part_id UUID;
    v_canonical_token UUID;
    v_canonical_estado TEXT;
    v_canonical_sol_id UUID;
BEGIN
    -- 1. Validaciones de Identidad y Rol del Target
    IF v_target_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_clean_token := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_transfer_token, '')));
    IF v_clean_token !~ '^[0-9a-f]{64}$' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_token_format');
    END IF;

    v_token_hash := pg_catalog.encode(pg_catalog.sha256(v_clean_token::bytea), 'hex');

    -- 2. Lock de Fila
    SELECT * INTO v_ticket
    FROM public.anonymous_transfer_tickets
    WHERE token_hash = v_token_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_not_found');
    END IF;

    IF v_ticket.status = 'completed' OR v_ticket.used_at IS NOT NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_already_used');
    END IF;

    IF v_ticket.status = 'revoked' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_revoked');
    END IF;

    IF v_ticket.expires_at <= pg_catalog.timezone('utc', pg_catalog.now()) THEN
        UPDATE public.anonymous_transfer_tickets
        SET status = 'expired'
        WHERE id = v_ticket.id;
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_expired');
    END IF;

    v_source_user_id := v_ticket.source_user_id_snapshot;

    -- 3. Verificación de Estado Actual del Source en auth.users
    SELECT is_anonymous INTO v_source_is_anon
    FROM auth.users
    WHERE id = v_source_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'source_user_not_found');
    END IF;

    IF v_source_is_anon IS NOT TRUE THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'source_no_longer_anonymous');
    END IF;

    IF v_source_user_id = v_target_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_transfer_to_same_user');
    END IF;

    -- ========================================================
    -- 4. CAPTURA EXPLÍCITA DEL SCOPE AFECTADO POR ESTA TRANSFERENCIA
    -- ========================================================
    SELECT COALESCE(pg_catalog.array_agg(id), ARRAY[]::UUID[])
    INTO v_source_owned_enc_ids
    FROM public.encuentros
    WHERE host_id = v_source_user_id;

    SELECT COALESCE(pg_catalog.array_agg(DISTINCT sub.encuentro_id), ARRAY[]::UUID[])
    INTO v_affected_external_enc_ids
    FROM (
        SELECT encuentro_id FROM public.participantes WHERE user_id IN (v_source_user_id, v_target_user_id)
        UNION
        SELECT encuentro_id FROM public.solicitudes_encuentro_abierto WHERE usuario_id IN (v_source_user_id, v_target_user_id)
    ) sub
    WHERE sub.encuentro_id NOT IN (SELECT id FROM public.encuentros WHERE host_id = v_target_user_id)
      AND (pg_catalog.cardinality(v_source_owned_enc_ids) = 0 OR sub.encuentro_id <> ALL(v_source_owned_enc_ids));

    -- ========================================================
    -- 5. TRANSFERENCIA ATÓMICA CON RESOLUCIÓN DE CONFLICTOS
    -- ========================================================

    -- A. ENCUENTROS PROPIOS DEL SOURCE
    IF pg_catalog.cardinality(v_source_owned_enc_ids) > 0 THEN
        -- Retirar solicitudes del target en estos encuentros preservando intacto el mensaje del usuario
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'withdrawn',
            resolved_at = pg_catalog.timezone('utc', pg_catalog.now()),
            participante_id = NULL,
            token_participante = NULL
        WHERE usuario_id = v_target_user_id
          AND encuentro_id = ANY(v_source_owned_enc_ids);

        -- Remover participación previa del target para no figurar como anfitrión e invitado
        DELETE FROM public.participantes
        WHERE user_id = v_target_user_id
          AND encuentro_id = ANY(v_source_owned_enc_ids);

        -- Traspaso de titularidad
        UPDATE public.encuentros
        SET host_id = v_target_user_id
        WHERE host_id = v_source_user_id;
        GET DIAGNOSTICS v_encuentros_count = ROW_COUNT;
    END IF;

    -- B. ENCUENTROS EXTERNOS: CANONICAL PARTICIPANT Y SOLICITUDES DETERMINISTAS
    IF pg_catalog.cardinality(v_affected_external_enc_ids) > 0 THEN
        FOR v_enc_id IN (SELECT pg_catalog.unnest(v_affected_external_enc_ids)) LOOP
            -- Paso B1: Identificar Canonical Participant priorizando token real en solicitudes approved
            SELECT id, token_invitacion,
                   CASE
                       WHEN EXISTS (
                           SELECT 1 FROM public.participantes
                           WHERE encuentro_id = v_enc_id AND user_id IN (v_source_user_id, v_target_user_id) AND estado = 'confirmado'
                       ) THEN 'confirmado'
                       WHEN EXISTS (
                           SELECT 1 FROM public.participantes
                           WHERE encuentro_id = v_enc_id AND user_id IN (v_source_user_id, v_target_user_id) AND estado = 'pendiente'
                       ) THEN 'pendiente'
                       ELSE 'rechazado'
                   END
            INTO v_canonical_part_id, v_canonical_token, v_canonical_estado
            FROM public.participantes
            WHERE encuentro_id = v_enc_id
              AND user_id IN (v_source_user_id, v_target_user_id)
            ORDER BY
                (EXISTS (
                    SELECT 1 FROM public.solicitudes_encuentro_abierto s
                    WHERE s.participante_id = public.participantes.id
                      AND s.estado = 'approved'
                      AND s.token_participante IS NOT DISTINCT FROM public.participantes.token_invitacion
                      AND public.participantes.token_invitacion IS NOT NULL
                )) DESC,
                CASE estado WHEN 'confirmado' THEN 3 WHEN 'pendiente' THEN 2 ELSE 1 END DESC,
                (token_invitacion IS NOT NULL) DESC,
                (user_id = v_target_user_id) DESC,
                creado_en ASC,
                id ASC
            LIMIT 1;

            IF v_canonical_part_id IS NOT NULL THEN
                UPDATE public.participantes
                SET user_id = v_target_user_id,
                    estado = v_canonical_estado
                WHERE id = v_canonical_part_id;

                -- Re-vincular solicitudes approved ANTES de borrar los participantes redundantes
                UPDATE public.solicitudes_encuentro_abierto
                SET participante_id = v_canonical_part_id,
                    token_participante = v_canonical_token
                WHERE encuentro_id = v_enc_id
                  AND usuario_id IN (v_source_user_id, v_target_user_id)
                  AND estado = 'approved';

                -- Eliminar participantes redundantes no canónicos
                DELETE FROM public.participantes
                WHERE encuentro_id = v_enc_id
                  AND user_id IN (v_source_user_id, v_target_user_id)
                  AND id <> v_canonical_part_id;

                v_participantes_count := v_participantes_count + 1;
            END IF;

            -- Paso B2: Solicitud Canónica y Orden Estricto Anti-Violación UNIQUE
            SELECT id
            INTO v_canonical_sol_id
            FROM public.solicitudes_encuentro_abierto
            WHERE encuentro_id = v_enc_id
              AND usuario_id IN (v_source_user_id, v_target_user_id)
            ORDER BY
                CASE estado
                    WHEN 'approved'  THEN 4
                    WHEN 'pending'   THEN 3
                    WHEN 'rejected'  THEN 2
                    WHEN 'withdrawn' THEN 1
                    ELSE 0
                END DESC,
                resolved_at DESC NULLS LAST,
                updated_at DESC,
                created_at DESC,
                id ASC
            LIMIT 1;

            IF v_canonical_sol_id IS NOT NULL THEN
                -- 1. Eliminar solicitudes no canónicas PRIMERO para despejar índice parcial unique
                DELETE FROM public.solicitudes_encuentro_abierto
                WHERE encuentro_id = v_enc_id
                  AND usuario_id IN (v_source_user_id, v_target_user_id)
                  AND id <> v_canonical_sol_id;

                -- 2. Actualizar canonical solicitud con el target_user
                UPDATE public.solicitudes_encuentro_abierto
                SET usuario_id = v_target_user_id
                WHERE id = v_canonical_sol_id;

                v_solicitudes_count := v_solicitudes_count + 1;
            END IF;
        END LOOP;
    END IF;

    -- C. LOCALIDADES
    INSERT INTO public.usuario_localidades (user_id, locality_id, created_at)
    SELECT v_target_user_id, locality_id, created_at
    FROM public.usuario_localidades
    WHERE user_id = v_source_user_id
    ON CONFLICT (user_id, locality_id) DO NOTHING;
    GET DIAGNOSTICS v_localidades_count = ROW_COUNT;

    DELETE FROM public.usuario_localidades WHERE user_id = v_source_user_id;

    -- D. CUSTOM TEMPLATES CON BYPASS DE QUOTA TRANSACCIONAL
    PERFORM pg_catalog.set_config('puntoencuentro.skip_template_limit', 'on', true);

    UPDATE public.custom_invitation_templates
    SET user_id = v_target_user_id
    WHERE user_id = v_source_user_id;
    GET DIAGNOSTICS v_templates_count = ROW_COUNT;

    -- E. SESIONES IA Y OBSERVABILIDAD QA
    UPDATE public.ai_creation_sessions
    SET user_id = v_target_user_id
    WHERE user_id = v_source_user_id;
    GET DIAGNOSTICS v_ai_sessions_count = ROW_COUNT;

    UPDATE public.creation_sessions
    SET user_id = v_target_user_id
    WHERE user_id = v_source_user_id;
    GET DIAGNOSTICS v_creation_sessions_count = ROW_COUNT;

    -- ========================================================
    -- 6. VERIFICACIÓN OBLIGATORIA DE POST-CONDICIONES
    -- ========================================================

    -- A. No quedan encuentros con host_id = source
    IF EXISTS (SELECT 1 FROM public.encuentros WHERE host_id = v_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_encounters_remain';
    END IF;

    -- B. No quedan usuario_localidades del source
    IF EXISTS (SELECT 1 FROM public.usuario_localidades WHERE user_id = v_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_localities_remain';
    END IF;

    -- C. No quedan recursos transferibles del source en ninguna tabla
    IF EXISTS (SELECT 1 FROM public.participantes WHERE user_id = v_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_participantes_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE usuario_id = v_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_solicitudes_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.custom_invitation_templates WHERE user_id = v_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_templates_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE user_id = v_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_ai_sessions_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.creation_sessions WHERE user_id = v_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_creation_sessions_remain';
    END IF;

    -- D. Target no debe ser host y participante en los encuentros transferidos
    IF pg_catalog.cardinality(v_source_owned_enc_ids) > 0 THEN
        IF EXISTS (
            SELECT 1 
            FROM public.participantes p
            WHERE p.encuentro_id = ANY(v_source_owned_enc_ids)
              AND p.user_id = v_target_user_id
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_target_is_host_and_participant';
        END IF;
    END IF;

    -- E. En encuentros afectados, ninguna solicitud approved de target referencia participante inexistente
    IF pg_catalog.cardinality(v_affected_external_enc_ids) > 0 THEN
        IF EXISTS (
            SELECT 1 
            FROM public.solicitudes_encuentro_abierto s
            LEFT JOIN public.participantes p ON p.id = s.participante_id
            WHERE s.encuentro_id = ANY(v_affected_external_enc_ids)
              AND s.usuario_id = v_target_user_id
              AND s.estado = 'approved'
              AND (s.participante_id IS NULL OR p.id IS NULL)
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_approved_solicitud_missing_participant';
        END IF;

        -- F. Token_participante de solicitud approved corresponde exactamente a su participante
        IF EXISTS (
            SELECT 1 
            FROM public.solicitudes_encuentro_abierto s
            JOIN public.participantes p ON p.id = s.participante_id
            WHERE s.encuentro_id = ANY(v_affected_external_enc_ids)
              AND s.usuario_id = v_target_user_id
              AND s.estado = 'approved'
              AND (s.token_participante IS NULL OR s.token_participante IS DISTINCT FROM p.token_invitacion OR p.token_invitacion IS NULL)
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_token_mismatch_in_approved_solicitud';
        END IF;

        -- G. No existen solicitudes duplicadas pending para el target en encuentros afectados
        IF EXISTS (
            SELECT encuentro_id
            FROM public.solicitudes_encuentro_abierto
            WHERE usuario_id = v_target_user_id
              AND estado = 'pending'
              AND encuentro_id = ANY(v_affected_external_enc_ids)
            GROUP BY encuentro_id
            HAVING COUNT(*) > 1
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_duplicate_pending_solicitudes';
        END IF;
    END IF;

    -- H. Templates asociados a encuentros transferidos siguen renderizables
    IF pg_catalog.cardinality(v_source_owned_enc_ids) > 0 THEN
        IF EXISTS (
            SELECT 1
            FROM public.encuentros e
            WHERE e.id = ANY(v_source_owned_enc_ids)
              AND e.tema_invitacion = 'custom'
              AND e.invitation_template ~ '^custom_[0-9a-fA-F-]{36}$'
              AND NOT EXISTS (
                  SELECT 1 
                  FROM public.custom_invitation_templates t
                  WHERE t.id = (pg_catalog.substr(e.invitation_template, 8))::uuid
                    AND t.image_path IS NOT NULL
              )
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_custom_template_unrenderable';
        END IF;
    END IF;

    -- ========================================================
    -- 7. MARCAR TICKET CONSUMIDO Y RETORNAR RESPUESTA SEGURA
    -- ========================================================
    UPDATE public.anonymous_transfer_tickets
    SET status = 'completed',
        used_at = pg_catalog.timezone('utc', pg_catalog.now()),
        target_user_id = v_target_user_id,
        target_user_id_snapshot = v_target_user_id,
        resources_transferred = pg_catalog.json_build_object(
            'encuentros', v_encuentros_count,
            'localidades', v_localidades_count,
            'participantes', v_participantes_count,
            'solicitudes', v_solicitudes_count,
            'templates', v_templates_count,
            'ai_sessions', v_ai_sessions_count,
            'creation_sessions', v_creation_sessions_count
        )
    WHERE id = v_ticket.id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentros_transferred', v_encuentros_count,
        'localidades_transferred', v_localidades_count,
        'participantes_transferred', v_participantes_count,
        'solicitudes_transferred', v_solicitudes_count,
        'templates_transferred', v_templates_count,
        'ai_sessions_transferred', v_ai_sessions_count,
        'creation_sessions_transferred', v_creation_sessions_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_anonymous_transfer(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_anonymous_transfer(text) TO authenticated;

COMMIT;
