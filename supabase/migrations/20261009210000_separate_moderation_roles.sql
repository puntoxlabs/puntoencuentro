-- ==============================================================================
-- MIGRACIÓN ADITIVA: SEPARACIÓN DE ROLES DE MODERACIÓN (Trust & Safety)
-- ==============================================================================
-- Objetivo:
-- 1. Desacoplar permisos de moderación de contenido del rol técnico de QA.
-- 2. Crear tabla dedicada public.moderation_authorized_users con roles 'admin' y 'moderator'.
-- 3. Crear helper server-side public.is_moderation_authorized().
-- 4. Actualizar RPCs administrativos (get_moderation_queue_seguro, resolver_moderacion_encuentro_seguro)
--    para exigir is_moderation_authorized() o service_role.
-- 5. Preservar RLS, revokes estrictos para clientes y compatibilidad con service_role.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. TABLA DEDICADA DE AUTORIZACIÓN DE MODERACIÓN
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.moderation_authorized_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'moderator')),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Habilitar Row Level Security
ALTER TABLE public.moderation_authorized_users ENABLE ROW LEVEL SECURITY;

-- Revocar acceso directo a anon y authenticated (Fail-closed)
REVOKE ALL ON TABLE public.moderation_authorized_users FROM PUBLIC, anon, authenticated;

-- Otorgar SELECT solo a roles administrativos de sistema
GRANT SELECT ON TABLE public.moderation_authorized_users TO postgres, service_role;

-- ------------------------------------------------------------------------------
-- 2. HELPER SERVER-SIDE: is_moderation_authorized()
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_moderation_authorized()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid uuid;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM public.moderation_authorized_users
        WHERE user_id = v_uid
          AND active = true
          AND role IN ('admin', 'moderator')
    );
END;
$$;

-- Seguridad del helper
REVOKE ALL ON FUNCTION public.is_moderation_authorized() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_moderation_authorized() TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 3. ACTUALIZACIÓN DE RPC: get_moderation_queue_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_moderation_queue_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_auth BOOLEAN := false;
    v_result JSON;
BEGIN
    -- Verificación de rol administrativo de moderación o service_role
    IF auth.role() = 'service_role' THEN
        v_is_auth := true;
    ELSIF v_user_id IS NOT NULL AND public.is_moderation_authorized() THEN
        v_is_auth := true;
    END IF;

    IF NOT v_is_auth THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT pg_catalog.json_agg(q_row) INTO v_result
    FROM (
        SELECT
            e.id,
            e.titulo,
            e.open_description,
            e.host_id,
            e.moderation_status,
            e.moderation_reason,
            e.moderation_categories,
            e.moderation_decision_source,
            e.moderated_at,
            e.creado_en AS created_at,
            e.opened_at,
            COALESCE(r_agg.report_count, 0) AS report_count,
            COALESCE(r_agg.reasons, ARRAY[]::TEXT[]) AS report_reasons
        FROM public.encuentros e
        LEFT JOIN (
            SELECT
                encuentro_id,
                pg_catalog.count(DISTINCT reporter_id) AS report_count,
                pg_catalog.array_agg(DISTINCT reason) AS reasons
            FROM public.public_content_reports
            WHERE status = 'pending'
            GROUP BY encuentro_id
        ) r_agg ON r_agg.encuentro_id = e.id
        WHERE e.moderation_status IN ('review_pending', 'hidden_pending_review', 'rejected')
           OR COALESCE(r_agg.report_count, 0) > 0
        ORDER BY COALESCE(r_agg.report_count, 0) DESC, e.moderated_at DESC NULLS LAST
    ) q_row;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'queue', COALESCE(v_result, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_moderation_queue_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_moderation_queue_seguro() TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 4. ACTUALIZACIÓN DE RPC: resolver_moderacion_encuentro_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolver_moderacion_encuentro_seguro(
    p_encuentro_id UUID,
    p_action TEXT,
    p_note TEXT DEFAULT NULL,
    p_expected_content_hash TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_auth BOOLEAN := false;
    v_encuentro public.encuentros%ROWTYPE;
    v_new_status TEXT;
    v_is_open BOOLEAN;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_clean_note TEXT;
    v_conv_intencion RECORD;
    v_source TEXT;
    v_current_hash TEXT;
    v_mod_role TEXT;
BEGIN
    -- Verificación de rol administrativo o service_role
    IF auth.role() = 'service_role' THEN
        v_is_auth := true;
        v_source := 'automated_moderation';
    ELSIF v_user_id IS NOT NULL AND public.is_moderation_authorized() THEN
        v_is_auth := true;
        -- Obtener rol del moderador para trazabilidad en auditoría
        SELECT role INTO v_mod_role
        FROM public.moderation_authorized_users
        WHERE user_id = v_user_id AND active = true;

        v_source := COALESCE(v_mod_role, 'moderator');
    END IF;

    IF NOT v_is_auth THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    v_clean_note := NULLIF(pg_catalog.btrim(p_note), '');

    -- Control estricto de transiciones de estado para APPROVE
    IF p_action = 'approve' THEN
        -- Moderación automatizada (service_role) SOLO puede aprobar si el estado actual es 'review_pending'
        IF auth.role() = 'service_role' AND v_encuentro.moderation_status <> 'review_pending' THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'invalid_status_transition',
                'current_status', v_encuentro.moderation_status,
                'message', 'Automated moderation can only approve encounters in review_pending'
            );
        END IF;

        -- Staff de moderación no puede aprobar un encuentro en 'rejected' o 'removed' sin revisión
        IF auth.role() <> 'service_role' AND v_encuentro.moderation_status NOT IN ('review_pending', 'hidden_pending_review') THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'invalid_status_transition',
                'current_status', v_encuentro.moderation_status
            );
        END IF;

        -- TOCTOU check: si se provee hash esperado, comparar atómicamente contra el contenido actual en BD
        IF p_expected_content_hash IS NOT NULL THEN
            v_current_hash := public.calcular_content_hash_moderacion(
                v_encuentro.titulo,
                v_encuentro.open_description,
                v_encuentro.modalidad,
                v_encuentro.open_public_zone
            );
            IF v_current_hash <> p_expected_content_hash THEN
                RETURN pg_catalog.json_build_object(
                    'ok', false,
                    'error', 'content_hash_mismatch',
                    'message', 'El contenido fue modificado durante la evaluación de moderación'
                );
            END IF;
        END IF;

        v_new_status := 'approved';
        v_is_open := true;
    ELSIF p_action = 'hide' THEN
        v_new_status := 'hidden_pending_review';
        v_is_open := false;
    ELSIF p_action = 'remove' THEN
        v_new_status := 'removed';
        v_is_open := false;
    ELSIF p_action = 'reject' THEN
        v_new_status := 'rejected';
        v_is_open := false;
    ELSE
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_action');
    END IF;

    -- Actualizar estado del encuentro
    UPDATE public.encuentros
    SET moderation_status = v_new_status,
        is_open = v_is_open,
        moderated_at = v_now,
        moderation_decision_source = v_source,
        closed_at = CASE WHEN NOT v_is_open AND v_encuentro.is_open THEN v_now ELSE closed_at END,
        opened_at = CASE WHEN v_is_open AND opened_at IS NULL THEN v_now ELSE opened_at END
    WHERE id = p_encuentro_id;

    -- Si se aprueba y no estaba abierto, emitir alertas y evento de dominio
    IF v_is_open AND NOT v_encuentro.is_open THEN
        FOR v_conv_intencion IN
            SELECT id
            FROM public.intenciones
            WHERE encuentro_id = p_encuentro_id
              AND estado = 'convertida'
        LOOP
            PERFORM public.emitir_alertas_intencion_convertida_outbox(v_conv_intencion.id, p_encuentro_id);
        END LOOP;

        INSERT INTO public.domain_events_outbox (
            event_type, event_version, aggregate_type, aggregate_id,
            actor_user_id, payload, dedup_key, status
        ) VALUES (
            'encounter.opened.v1', 1, 'encounter', p_encuentro_id,
            v_encuentro.host_id,
            pg_catalog.jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'host_id', v_encuentro.host_id,
                'modalidad', v_encuentro.modalidad,
                'locality_id', v_encuentro.locality_id,
                'max_participants', v_encuentro.max_participants,
                'opened_at', v_now
            ),
            pg_catalog.format('encounter:%s:opened:%s', p_encuentro_id, extract(epoch from v_now)::text),
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;
    END IF;

    -- Actualizar reportes pendientes asociados
    UPDATE public.public_content_reports
    SET status = CASE WHEN p_action = 'approve' THEN 'dismissed' ELSE 'actioned' END,
        reviewed_at = v_now,
        reviewed_by = v_user_id,
        resolution_note = v_clean_note
    WHERE encuentro_id = p_encuentro_id AND status = 'pending';

    -- Registrar auditoría persistente
    INSERT INTO public.public_content_moderation_audit (
        encuentro_id, moderator_id, action, previous_status, new_status,
        reason, categories, source, metadata
    ) VALUES (
        p_encuentro_id, v_user_id, p_action, v_encuentro.moderation_status, v_new_status,
        v_clean_note, ARRAY[]::TEXT[], v_source,
        pg_catalog.jsonb_build_object('moderator_role', CASE WHEN auth.role() = 'service_role' THEN 'service_role' ELSE COALESCE(v_mod_role, 'moderator') END)
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'previous_status', v_encuentro.moderation_status,
        'new_status', v_new_status,
        'is_open', v_is_open
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT, TEXT) TO authenticated, postgres, service_role;
