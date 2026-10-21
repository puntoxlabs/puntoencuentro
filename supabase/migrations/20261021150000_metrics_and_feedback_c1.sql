-- ============================================================
-- Migración: 20261021150000_metrics_and_feedback_c1.sql
-- Módulo: Mini-sprint C1 - Métricas mínimas y feedback de prelanzamiento
-- Descripción:
--   1. Tabla e ingesta de eventos de uso de la aplicación (Home visits,
--      apertura de invitaciones, links compartidos de forma verificada).
--   2. Tabla y circuito seguro de feedback de producto para usuarios autenticados
--      con rate limiting server-side, anti-spam honeypot y cero PII innecesaria.
--   3. Ampliación retrocompatible de get_qa_dashboard_metrics con métricas
--      observadas de adquisición, interacción, RSVP, solicitudes abiertas y avisos.
--   4. RPCs de consulta y gestión de feedback restringidas a QA/Admin.
--   5. Política de retención (90 días) para telemetría de uso.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. TABLA PRIVADA: public.app_usage_events
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_usage_events (
    id BIGSERIAL PRIMARY KEY,
    event_name TEXT NOT NULL CHECK (event_name IN ('home_visit', 'invitation_shared', 'invitation_opened')),
    encounter_id UUID REFERENCES public.encuentros(id) ON DELETE SET NULL,
    encounter_mode TEXT CHECK (encounter_mode IS NULL OR encounter_mode IN ('fixed', 'coordination')),
    share_channel TEXT CHECK (share_channel IS NULL OR share_channel IN ('system_share', 'clipboard_copy')),
    invitation_type TEXT CHECK (invitation_type IS NULL OR invitation_type IN ('individual', 'general', 'coordination_individual', 'coordination_general')),
    client_token_hash TEXT NOT NULL CHECK (pg_catalog.length(client_token_hash) = 64),
    created_at TIMESTAMPTZ DEFAULT pg_catalog.timezone('utc', pg_catalog.now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_usage_events_created_at
    ON public.app_usage_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_usage_events_name_created
    ON public.app_usage_events (event_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_usage_events_client_created
    ON public.app_usage_events (client_token_hash, created_at DESC);

ALTER TABLE public.app_usage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_usage_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.app_usage_events TO postgres, service_role;

-- ------------------------------------------------------------
-- 2. RPC DE INGESTA SEGURA DE EVENTOS DE USO
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_evento_uso(
    p_event_name TEXT,
    p_client_token TEXT,
    p_encounter_id UUID DEFAULT NULL,
    p_encounter_mode TEXT DEFAULT NULL,
    p_share_channel TEXT DEFAULT NULL,
    p_invitation_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_token_hash TEXT;
    v_recent_events_count INT;
BEGIN
    -- Validar nombre de evento
    IF p_event_name IS NULL OR p_event_name NOT IN ('home_visit', 'invitation_shared', 'invitation_opened') THEN
        RAISE EXCEPTION 'invalid_event_name: %', p_event_name;
    END IF;

    -- Validar token de cliente defensivo (16 a 128 chars)
    IF p_client_token IS NULL OR pg_catalog.length(p_client_token) < 16 OR pg_catalog.length(p_client_token) > 128 THEN
        RAISE EXCEPTION 'invalid_client_token: length must be between 16 and 128 characters';
    END IF;

    -- Validar enumerados opcionales
    IF p_encounter_mode IS NOT NULL AND p_encounter_mode NOT IN ('fixed', 'coordination') THEN
        RAISE EXCEPTION 'invalid_encounter_mode: %', p_encounter_mode;
    END IF;

    IF p_share_channel IS NOT NULL AND p_share_channel NOT IN ('system_share', 'clipboard_copy') THEN
        RAISE EXCEPTION 'invalid_share_channel: %', p_share_channel;
    END IF;

    IF p_invitation_type IS NOT NULL AND p_invitation_type NOT IN ('individual', 'general', 'coordination_individual', 'coordination_general') THEN
        RAISE EXCEPTION 'invalid_invitation_type: %', p_invitation_type;
    END IF;

    v_token_hash := pg_catalog.encode(pg_catalog.sha256(p_client_token::bytea), 'hex');

    -- Rate limit anti-abuso: máximo 100 eventos de telemetría por hora por client_token_hash
    SELECT COUNT(*)
    INTO v_recent_events_count
    FROM public.app_usage_events
    WHERE client_token_hash = v_token_hash
      AND created_at >= pg_catalog.timezone('utc', pg_catalog.now()) - INTERVAL '1 hour';

    IF v_recent_events_count >= 100 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- Inserción segura (sin URLs privadas, sin tokens de invitación)
    INSERT INTO public.app_usage_events (
        event_name,
        encounter_id,
        encounter_mode,
        share_channel,
        invitation_type,
        client_token_hash,
        created_at
    )
    VALUES (
        p_event_name,
        p_encounter_id,
        p_encounter_mode,
        p_share_channel,
        p_invitation_type,
        v_token_hash,
        pg_catalog.timezone('utc', pg_catalog.now())
    );

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_evento_uso(TEXT, TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_evento_uso(TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
    TO anon, authenticated, postgres, service_role;

-- ------------------------------------------------------------
-- 3. TABLA PRIVADA: public.user_feedback
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('issue', 'suggestion', 'general')),
    comment TEXT NOT NULL CHECK (pg_catalog.length(comment) >= 3 AND pg_catalog.length(comment) <= 1000),
    page_route TEXT CHECK (page_route IS NULL OR pg_catalog.length(page_route) <= 60),
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'reviewed', 'archived')),
    created_at TIMESTAMPTZ DEFAULT pg_catalog.timezone('utc', pg_catalog.now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_feedback_created_at
    ON public.user_feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_feedback_category_created
    ON public.user_feedback (category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_feedback_status_created
    ON public.user_feedback (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_feedback_user_created
    ON public.user_feedback (user_id, created_at DESC);

ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_feedback FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_feedback TO postgres, service_role;

-- ------------------------------------------------------------
-- 4. POLÍTICA DE RATE LIMITING SERVER-SIDE PARA FEEDBACK
-- ------------------------------------------------------------
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES ('enviar_feedback', 5, 3600, true)
ON CONFLICT (action) DO UPDATE
    SET max_requests = 5,
        window_seconds = 3600,
        enabled = true;

-- ------------------------------------------------------------
-- 5. RPC DE ENVÍO SEGURO DE FEEDBACK (AUTENTICADO + RATE LIMIT + HONEYPOT)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enviar_feedback_usuario(
    p_category TEXT,
    p_comment TEXT,
    p_page_route TEXT DEFAULT NULL,
    p_honeypot TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_trimmed_comment TEXT;
    v_clean_route TEXT := NULL;
    v_rate_res JSONB;
    v_new_id UUID;
BEGIN
    -- 1. Control estricto de autenticación server-side (Ajuste 1: Anti-spam real)
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'authentication_required: user must be logged in to submit feedback';
    END IF;

    -- 2. Trampa anti-bot Honeypot
    IF p_honeypot IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(p_honeypot)) > 0 THEN
        -- Silently fail or abort bot execution
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_submission');
    END IF;

    -- 3. Validación de categoría
    IF p_category IS NULL OR p_category NOT IN ('issue', 'suggestion', 'general') THEN
        RAISE EXCEPTION 'invalid_category: must be issue, suggestion, or general';
    END IF;

    -- 4. Sanitización y validación de comentario
    v_trimmed_comment := pg_catalog.btrim(COALESCE(p_comment, ''));
    IF pg_catalog.length(v_trimmed_comment) < 3 OR pg_catalog.length(v_trimmed_comment) > 1000 THEN
        RAISE EXCEPTION 'invalid_comment_length: comment must be between 3 and 1000 characters';
    END IF;

    -- 5. Sanitización de ruta (Ajuste 2: Cero URLs privadas, tokens o query params)
    IF p_page_route IS NOT NULL THEN
        v_clean_route := pg_catalog.btrim(p_page_route);
        -- Rechazar si contiene query string (?) o fragmento (#) o protocolo
        IF v_clean_route LIKE '%?%' OR v_clean_route LIKE '%#%' OR v_clean_route LIKE '%://%' THEN
            v_clean_route := pg_catalog.split_part(pg_catalog.split_part(v_clean_route, '?', 1), '#', 1);
        END IF;
        IF pg_catalog.length(v_clean_route) > 60 THEN
            v_clean_route := pg_catalog.substring(v_clean_route, 1, 60);
        END IF;
    END IF;

    -- 6. Rate limiting server-side mediante el subsistema transaccional
    v_rate_res := public.check_rate_limit_internal('enviar_feedback', '');
    IF v_rate_res IS NULL OR (v_rate_res->>'allowed')::boolean IS NOT TRUE THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- 7. Inserción
    INSERT INTO public.user_feedback (
        user_id,
        category,
        comment,
        page_route,
        status,
        created_at
    )
    VALUES (
        v_user_id,
        p_category,
        v_trimmed_comment,
        v_clean_route,
        'unread',
        pg_catalog.timezone('utc', pg_catalog.now())
    )
    RETURNING id INTO v_new_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.enviar_feedback_usuario(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enviar_feedback_usuario(TEXT, TEXT, TEXT, TEXT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------
-- 6. RPC ADMIN: CONSULTA DE FEEDBACK DE USUARIOS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_qa_user_feedback(
    p_days INT DEFAULT 30,
    p_category TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_since TIMESTAMPTZ;
    v_feedback_json JSONB;
    v_total_count INT := 0;
BEGIN
    -- Verificación server-side de autorización QA
    IF NOT public.is_qa_authorized() THEN
        RAISE EXCEPTION 'unauthorized: insufficient permissions for QA feedback';
    END IF;

    -- Validación de parámetros
    IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
        RAISE EXCEPTION 'invalid_parameter: p_days must be between 1 and 90';
    END IF;

    IF p_category IS NOT NULL AND p_category NOT IN ('issue', 'suggestion', 'general') THEN
        RAISE EXCEPTION 'invalid_category: %', p_category;
    END IF;

    IF p_status IS NOT NULL AND p_status NOT IN ('unread', 'reviewed', 'archived') THEN
        RAISE EXCEPTION 'invalid_status: %', p_status;
    END IF;

    v_since := pg_catalog.timezone('utc', pg_catalog.now()) - (p_days || ' days')::INTERVAL;

    -- Conteo total
    SELECT COUNT(*)
    INTO v_total_count
    FROM public.user_feedback f
    WHERE f.created_at >= v_since
      AND (p_category IS NULL OR f.category = p_category)
      AND (p_status IS NULL OR f.status = p_status);

    -- Lista segura de items (Cero exposición de PII ni emails innecesarios)
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', f.id,
                'category', f.category,
                'comment', f.comment,
                'page_route', f.page_route,
                'status', f.status,
                'created_at', f.created_at,
                'is_authenticated', true
            )
            ORDER BY f.created_at DESC
        ),
        '[]'::jsonb
    )
    INTO v_feedback_json
    FROM (
        SELECT f.id, f.category, f.comment, f.page_route, f.status, f.created_at
        FROM public.user_feedback f
        WHERE f.created_at >= v_since
          AND (p_category IS NULL OR f.category = p_category)
          AND (p_status IS NULL OR f.status = p_status)
        ORDER BY f.created_at DESC
        LIMIT LEAST(GREATEST(p_limit, 1), 100)
        OFFSET GREATEST(p_offset, 0)
    ) f;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'feedback', v_feedback_json,
        'total_count', v_total_count,
        'limit', p_limit,
        'offset', p_offset
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_qa_user_feedback(INT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_qa_user_feedback(INT, TEXT, TEXT, INT, INT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------
-- 7. RPC ADMIN: ACTUALIZACIÓN DE ESTADO DE FEEDBACK
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_qa_user_feedback_status(
    p_feedback_id UUID,
    p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.is_qa_authorized() THEN
        RAISE EXCEPTION 'unauthorized: insufficient permissions for QA feedback';
    END IF;

    IF p_feedback_id IS NULL THEN
        RAISE EXCEPTION 'invalid_feedback_id: cannot be null';
    END IF;

    IF p_status IS NULL OR p_status NOT IN ('unread', 'reviewed', 'archived') THEN
        RAISE EXCEPTION 'invalid_status: must be unread, reviewed, or archived';
    END IF;

    UPDATE public.user_feedback
    SET status = p_status
    WHERE id = p_feedback_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'feedback_not_found');
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_feedback_id, 'status', p_status);
END;
$$;

REVOKE ALL ON FUNCTION public.update_qa_user_feedback_status(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_qa_user_feedback_status(UUID, TEXT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------
-- 8. AMPLIACIÓN RETROCOMPATIBLE DE public.get_qa_dashboard_metrics
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_qa_dashboard_metrics(
    p_days INT DEFAULT 7
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_since TIMESTAMPTZ;
    -- Métricas existentes del embudo de creación
    v_total_sessions INT := 0;
    v_completed_sessions INT := 0;
    v_probable_abandoned_sessions INT := 0;
    v_cancelled_sessions INT := 0;
    v_ai_sessions INT := 0;
    v_manual_sessions INT := 0;
    v_fixed_encounters INT := 0;
    v_coordination_encounters INT := 0;
    v_deterministic_events INT := 0;
    v_llm_events INT := 0;
    v_fallback_events INT := 0;
    v_clarification_events INT := 0;
    v_avg_latency_ms INT := 0;
    v_p90_latency_ms INT := 0;

    -- Nuevas métricas observadas de adquisición y uso
    v_home_visits INT := 0;
    v_invitations_shared INT := 0;
    v_invitations_opened INT := 0;
    v_sessions_manual INT := 0;
    v_sessions_ai INT := 0;
    v_sessions_coordination INT := 0;

    -- Nuevas métricas de confirmación / rechazos (RSVP)
    v_rsvps_confirmed INT := 0;
    v_rsvps_declined INT := 0;
    v_rsvps_total INT := 0;
    v_rsvp_confirmation_rate NUMERIC := 0;

    -- Nuevas métricas de encuentros abiertos
    v_open_requests_created INT := 0;
    v_open_requests_approved INT := 0;
    v_open_requests_rejected INT := 0;
    v_open_request_approval_rate NUMERIC := 0;

    -- Nuevas métricas de avisos 'Avisame'
    v_avisame_created INT := 0;

    -- Errores técnicos observados en creación
    v_technical_errors INT := 0;
BEGIN
    -- 1. Verificación server-side de autorización QA
    IF NOT public.is_qa_authorized() THEN
        RAISE EXCEPTION 'unauthorized: insufficient permissions for QA metrics';
    END IF;

    -- Validación de parámetros
    IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
        RAISE EXCEPTION 'invalid_parameter: p_days must be between 1 and 90';
    END IF;

    v_since := pg_catalog.timezone('utc', pg_catalog.now()) - (p_days || ' days')::INTERVAL;

    -- 2. Agregados existentes de creation_sessions
    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'completed'),
        -- Heurística observable de abandono: iniciado sin eventos hace > 30 minutos
        COUNT(*) FILTER (WHERE status = 'started' AND last_event_at < pg_catalog.timezone('utc', pg_catalog.now()) - INTERVAL '30 minutes'),
        COUNT(*) FILTER (WHERE status = 'cancelled'),
        COUNT(*) FILTER (WHERE creation_source = 'ai'),
        COUNT(*) FILTER (WHERE creation_source = 'manual'),
        COUNT(*) FILTER (WHERE date_mode = 'fixed' AND status = 'completed'),
        COUNT(*) FILTER (WHERE date_mode = 'coordination' AND status = 'completed'),
        COUNT(*) FILTER (WHERE initial_route = '/create'),
        COUNT(*) FILTER (WHERE initial_route = '/create/ai'),
        COUNT(*) FILTER (WHERE initial_route = '/create/coordination')
    INTO
        v_total_sessions,
        v_completed_sessions,
        v_probable_abandoned_sessions,
        v_cancelled_sessions,
        v_ai_sessions,
        v_manual_sessions,
        v_fixed_encounters,
        v_coordination_encounters,
        v_sessions_manual,
        v_sessions_ai,
        v_sessions_coordination
    FROM public.creation_sessions
    WHERE created_at >= v_since;

    -- 3. Agregados de eventos de creación (IA y errores técnicos)
    SELECT
        COUNT(*) FILTER (WHERE source = 'deterministic'),
        COUNT(*) FILTER (WHERE source IN ('llm_openai', 'llm_mistral')),
        COUNT(*) FILTER (WHERE fallback_used = true),
        COUNT(*) FILTER (WHERE event_type = 'clarification_requested' OR result = 'needs_clarification'),
        COUNT(*) FILTER (WHERE event_type = 'technical_error'),
        COALESCE(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL), 0)::INT,
        COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL), 0)::INT
    INTO
        v_deterministic_events,
        v_llm_events,
        v_fallback_events,
        v_clarification_events,
        v_technical_errors,
        v_avg_latency_ms,
        v_p90_latency_ms
    FROM public.creation_session_events e
    WHERE e.created_at >= v_since;

    -- 4. Agregados observados de uso de la aplicación (app_usage_events)
    SELECT
        COUNT(*) FILTER (WHERE event_name = 'home_visit'),
        COUNT(*) FILTER (WHERE event_name = 'invitation_shared'),
        COUNT(*) FILTER (WHERE event_name = 'invitation_opened')
    INTO
        v_home_visits,
        v_invitations_shared,
        v_invitations_opened
    FROM public.app_usage_events
    WHERE created_at >= v_since;

    -- 5. Agregados observados de confirmaciones y rechazos (participantes)
    SELECT
        COUNT(*) FILTER (WHERE estado = 'confirmado' AND respondido_en >= v_since),
        COUNT(*) FILTER (WHERE estado = 'rechazado' AND respondido_en >= v_since)
    INTO
        v_rsvps_confirmed,
        v_rsvps_declined
    FROM public.participantes;

    v_rsvps_total := v_rsvps_confirmed + v_rsvps_declined;
    IF v_rsvps_total > 0 THEN
        v_rsvp_confirmation_rate := ROUND((v_rsvps_confirmed::NUMERIC / v_rsvps_total::NUMERIC) * 100, 1);
    END IF;

    -- 6. Agregados observados de solicitudes en encuentros abiertos
    SELECT
        COUNT(*) FILTER (WHERE created_at >= v_since),
        COUNT(*) FILTER (WHERE estado = 'aprobada' AND respondido_al >= v_since),
        COUNT(*) FILTER (WHERE estado = 'rechazada' AND respondido_al >= v_since)
    INTO
        v_open_requests_created,
        v_open_requests_approved,
        v_open_requests_rejected
    FROM public.solicitudes_encuentro_abierto;

    IF (v_open_requests_approved + v_open_requests_rejected) > 0 THEN
        v_open_request_approval_rate := ROUND((v_open_requests_approved::NUMERIC / (v_open_requests_approved + v_open_requests_rejected)::NUMERIC) * 100, 1);
    END IF;

    -- 7. Agregados observados de suscripciones 'Avisame'
    SELECT COUNT(*)
    INTO v_avisame_created
    FROM public.match_alert_subscriptions
    WHERE created_at >= v_since;

    RETURN pg_catalog.json_build_object(
        -- Compatibilidad total con dashboard preexistente
        'ok', true,
        'period_days', p_days,
        'total_sessions', v_total_sessions,
        'completed_sessions', v_completed_sessions,
        'abandoned_sessions', v_probable_abandoned_sessions,
        'probable_abandonment_heuristic_minutes', 30,
        'cancelled_sessions', v_cancelled_sessions,
        'conversion_rate', CASE WHEN v_total_sessions > 0 THEN ROUND((v_completed_sessions::NUMERIC / v_total_sessions::NUMERIC) * 100, 1) ELSE 0 END,
        'ai_sessions', v_ai_sessions,
        'manual_sessions', v_manual_sessions,
        'fixed_encounters', v_fixed_encounters,
        'coordination_encounters', v_coordination_encounters,
        'deterministic_events', v_deterministic_events,
        'llm_events', v_llm_events,
        'fallback_events', v_fallback_events,
        'clarification_events', v_clarification_events,
        'avg_latency_ms', v_avg_latency_ms,
        'p90_latency_ms', v_p90_latency_ms,

        -- Nuevos agregados de Adquisición y Canales (Mini-sprint C1)
        'home_visits', v_home_visits,
        'invitations_shared', v_invitations_shared,
        'invitations_opened', v_invitations_opened,
        'sessions_manual', v_sessions_manual,
        'sessions_ai', v_sessions_ai,
        'sessions_coordination', v_sessions_coordination,

        -- Interacción y Respuestas (RSVP)
        'rsvps_confirmed', v_rsvps_confirmed,
        'rsvps_declined', v_rsvps_declined,
        'rsvps_total', v_rsvps_total,
        'rsvp_confirmation_rate', v_rsvp_confirmation_rate,

        -- Encuentros Abiertos
        'open_requests_created', v_open_requests_created,
        'open_requests_approved', v_open_requests_approved,
        'open_requests_rejected', v_open_requests_rejected,
        'open_request_approval_rate', v_open_request_approval_rate,

        -- Avisos Explícitos
        'avisame_created', v_avisame_created,

        -- Fricción & Errores
        'technical_errors', v_technical_errors,

        -- Política de retención de telemetría de uso
        'retention_policy_days', 90
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_qa_dashboard_metrics(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_qa_dashboard_metrics(INT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------
-- 9. FUNCIÓN DE PURGA / RETENCIÓN DE TELEMETRÍA (90 DÍAS)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purgar_telemetria_uso_antigua(
    p_retention_days INT DEFAULT 90
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_deleted INT := 0;
BEGIN
    IF p_retention_days IS NULL OR p_retention_days < 7 THEN
        RAISE EXCEPTION 'invalid_retention_days: minimum is 7 days';
    END IF;

    DELETE FROM public.app_usage_events
    WHERE created_at < pg_catalog.timezone('utc', pg_catalog.now()) - (p_retention_days || ' days')::INTERVAL;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purgar_telemetria_uso_antigua(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purgar_telemetria_uso_antigua(INT) TO postgres, service_role;

COMMIT;
