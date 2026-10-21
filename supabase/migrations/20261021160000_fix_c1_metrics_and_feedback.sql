-- ============================================================
-- Migración: 20261021160000_fix_c1_metrics_and_feedback.sql
-- Módulo: Microcierre C1 - Corrección de métricas de solicitudes abiertas,
--         normalización estricta de rutas, exclusión de usuarios anónimos,
--         mitigación anti-abuso de telemetría y programación de retención.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. MITIGACIÓN ANTI-ABUSO EN TELEMETRÍA DE USO (IP HASH & VOLUMEN)
-- ------------------------------------------------------------
ALTER TABLE public.app_usage_events
    ADD COLUMN IF NOT EXISTS ip_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_app_usage_events_ip_created
    ON public.app_usage_events (ip_hash, created_at DESC)
    WHERE ip_hash IS NOT NULL;

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
    v_ip_raw TEXT;
    v_ip_hash TEXT := NULL;
    v_token_count INT;
    v_ip_count INT;
    v_global_count INT;
BEGIN
    -- 1. Validar nombre de evento
    IF p_event_name IS NULL OR p_event_name NOT IN ('home_visit', 'invitation_shared', 'invitation_opened') THEN
        RAISE EXCEPTION 'invalid_event_name: %', p_event_name;
    END IF;

    -- 2. Validar token de cliente defensivo (16 a 128 chars)
    IF p_client_token IS NULL OR pg_catalog.length(p_client_token) < 16 OR pg_catalog.length(p_client_token) > 128 THEN
        RAISE EXCEPTION 'invalid_client_token: length must be between 16 and 128 characters';
    END IF;

    -- 3. Validar enumerados opcionales
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

    -- Extraer IP de headers si está disponible (Cloudflare / Reverse Proxy) y hashear para privacidad
    BEGIN
        v_ip_raw := NULLIF(pg_catalog.current_setting('request.headers', true)::jsonb->>'cf-connecting-ip', '');
        IF v_ip_raw IS NULL THEN
            v_ip_raw := NULLIF(pg_catalog.split_part(pg_catalog.current_setting('request.headers', true)::jsonb->>'x-forwarded-for', ',', 1), '');
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_ip_raw := NULL;
    END;

    IF v_ip_raw IS NOT NULL AND pg_catalog.length(v_ip_raw) > 0 THEN
        v_ip_hash := pg_catalog.encode(pg_catalog.sha256(v_ip_raw::bytea), 'hex');
    END IF;

    -- Rate limit por token de cliente: máx 100 eventos/hora
    SELECT COUNT(*)
    INTO v_token_count
    FROM public.app_usage_events
    WHERE client_token_hash = v_token_hash
      AND created_at >= pg_catalog.timezone('utc', pg_catalog.now()) - INTERVAL '1 hour';

    IF v_token_count >= 100 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- Rate limit por IP hasheada (mitiga rotación de tokens cliente): máx 250 eventos/hora
    IF v_ip_hash IS NOT NULL THEN
        SELECT COUNT(*)
        INTO v_ip_count
        FROM public.app_usage_events
        WHERE ip_hash = v_ip_hash
          AND created_at >= pg_catalog.timezone('utc', pg_catalog.now()) - INTERVAL '1 hour';

        IF v_ip_count >= 250 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
        END IF;
    END IF;

    -- Disyuntor global de volumen: máx 10.000 eventos/hora en toda la tabla
    SELECT COUNT(*)
    INTO v_global_count
    FROM public.app_usage_events
    WHERE created_at >= pg_catalog.timezone('utc', pg_catalog.now()) - INTERVAL '1 hour';

    IF v_global_count >= 10000 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'service_saturated');
    END IF;

    -- Inserción segura
    INSERT INTO public.app_usage_events (
        event_name,
        encounter_id,
        encounter_mode,
        share_channel,
        invitation_type,
        client_token_hash,
        ip_hash,
        created_at
    )
    VALUES (
        p_event_name,
        p_encounter_id,
        p_encounter_mode,
        p_share_channel,
        p_invitation_type,
        v_token_hash,
        v_ip_hash,
        pg_catalog.timezone('utc', pg_catalog.now())
    );

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_evento_uso(TEXT, TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_evento_uso(TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
    TO anon, authenticated, postgres, service_role;

-- ------------------------------------------------------------
-- 2. FUNCIÓN DE NORMALIZACIÓN ESTRICTA DE RUTAS DE FEEDBACK
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalizar_ruta_feedback(p_route TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_clean TEXT;
BEGIN
    IF p_route IS NULL THEN
        RETURN NULL;
    END IF;

    -- Descartar query parameters y fragmentos de forma rigurosa
    v_clean := pg_catalog.split_part(pg_catalog.split_part(pg_catalog.btrim(p_route), '?', 1), '#', 1);

    IF v_clean = '' OR v_clean = '/' THEN
        RETURN '/';
    ELSIF v_clean = '/create' THEN
        RETURN '/create';
    ELSIF v_clean = '/create/ai' THEN
        RETURN '/create/ai';
    ELSIF v_clean = '/create/coordination' THEN
        RETURN '/create/coordination';
    ELSIF v_clean ~ '^/meet/[^/]+$' THEN
        RETURN '/meet/:id';
    ELSIF v_clean ~ '^/coordination/invite/[^/]+$' THEN
        RETURN '/coordination/invite/:token';
    ELSIF v_clean ~ '^/coordination/join/[^/]+$' THEN
        RETURN '/coordination/join/:token';
    ELSIF v_clean ~ '^/coordination/[^/]+$' THEN
        RETURN '/coordination/:id';
    ELSIF v_clean ~ '^/invite/[^/]+$' THEN
        RETURN '/invite/:token';
    ELSIF v_clean ~ '^/join/[^/]+$' THEN
        RETURN '/join/:token';
    ELSIF v_clean ~ '^/add-guests/[^/]+$' THEN
        RETURN '/add-guests/:id';
    ELSIF v_clean ~ '^/share/[^/]+$' THEN
        RETURN '/share/:id';
    ELSIF v_clean ~ '^/invitation/[^/]+$' THEN
        RETURN '/invitation/:id';
    ELSIF v_clean ~ '^/cancel-summary/[^/]+$' THEN
        RETURN '/cancel-summary/:id';
    ELSIF v_clean ~ '^/internal/qa/sessions/[^/]+$' THEN
        RETURN '/internal/qa/sessions/:sessionId';
    ELSIF v_clean = '/internal/qa/sessions' THEN
        RETURN '/internal/qa/sessions';
    ELSIF v_clean = '/internal/qa' THEN
        RETURN '/internal/qa';
    ELSIF v_clean = '/internal/moderation' THEN
        RETURN '/internal/moderation';
    ELSE
        -- Rutas no reconocidas o dinámicas desconocidas se reducen a NULL para no filtrar identificadores
        RETURN NULL;
    END IF;
END;
$$;

-- Sanear filas existentes de prueba en user_feedback
UPDATE public.user_feedback
SET page_route = public.normalizar_ruta_feedback(page_route);

-- ------------------------------------------------------------
-- 3. EXCLUSIÓN DE USUARIOS ANÓNIMOS EN FEEDBACK (is_anonymous = true RECHAZADO)
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
    v_is_anon BOOLEAN := FALSE;
    v_trimmed_comment TEXT;
    v_normalized_route TEXT := NULL;
    v_rate_res JSONB;
    v_new_id UUID;
BEGIN
    -- 1. Control estricto de autenticación server-side y rechazo de anónimos
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'authentication_required: user must be logged in to submit feedback';
    END IF;

    BEGIN
        v_is_anon := COALESCE((auth.jwt()->>'is_anonymous')::boolean, false)
                     OR pg_catalog.current_setting('request.jwt.claim.is_anonymous', true) = 'true';
    EXCEPTION WHEN OTHERS THEN
        v_is_anon := FALSE;
    END;

    IF v_is_anon THEN
        RAISE EXCEPTION 'permanent_account_required: anonymous sessions cannot submit product feedback';
    END IF;

    -- 2. Trampa anti-bot Honeypot
    IF p_honeypot IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(p_honeypot)) > 0 THEN
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

    -- 5. Normalización estricta de ruta (Cero filtración de tokens o IDs privados)
    v_normalized_route := public.normalizar_ruta_feedback(p_page_route);

    -- 6. Rate limiting server-side (5 envíos / hora por usuario permanente)
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
        v_normalized_route,
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
-- 4. CORRECCIÓN DE MÉTRICAS EN get_qa_dashboard_metrics
--    (solicitudes_encuentro_abierto: resolved_at y approved/rejected)
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
    -- Métricas del embudo de creación
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

    -- Métricas observadas de uso y adquisición
    v_home_visits INT := 0;
    v_invitations_shared INT := 0;
    v_invitations_opened INT := 0;
    v_sessions_manual INT := 0;
    v_sessions_ai INT := 0;
    v_sessions_coordination INT := 0;

    -- Métricas de confirmación / rechazos (RSVP)
    v_rsvps_confirmed INT := 0;
    v_rsvps_declined INT := 0;
    v_rsvps_total INT := 0;
    v_rsvp_confirmation_rate NUMERIC := 0;

    -- Métricas de encuentros abiertos (Esquema real: resolved_at y approved/rejected)
    v_open_requests_created INT := 0;
    v_open_requests_approved INT := 0;
    v_open_requests_rejected INT := 0;
    v_open_request_approval_rate NUMERIC := 0;

    -- Métricas de avisos 'Avisame'
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

    -- 2. Agregados de creation_sessions
    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'completed'),
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

    -- 3. Agregados de eventos de creación
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

    -- 4. Agregados observados de uso de la aplicación
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

    -- 6. Agregados observados de solicitudes en encuentros abiertos (ESQUEMA CANÓNICO REAL)
    SELECT
        COUNT(*) FILTER (WHERE created_at >= v_since),
        COUNT(*) FILTER (WHERE estado = 'approved' AND resolved_at >= v_since),
        COUNT(*) FILTER (WHERE estado = 'rejected' AND resolved_at >= v_since)
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

        -- Nuevos agregados observados
        'home_visits', v_home_visits,
        'invitations_shared', v_invitations_shared,
        'invitations_opened', v_invitations_opened,
        'sessions_manual', v_sessions_manual,
        'sessions_ai', v_sessions_ai,
        'sessions_coordination', v_sessions_coordination,

        -- Respuestas (RSVP)
        'rsvps_confirmed', v_rsvps_confirmed,
        'rsvps_declined', v_rsvps_declined,
        'rsvps_total', v_rsvps_total,
        'rsvp_confirmation_rate', v_rsvp_confirmation_rate,

        -- Encuentros Abiertos
        'open_requests_created', v_open_requests_created,
        'open_requests_approved', v_open_requests_approved,
        'open_requests_rejected', v_open_requests_rejected,
        'open_request_approval_rate', v_open_request_approval_rate,

        -- Avisos
        'avisame_created', v_avisame_created,

        -- Errores técnicos
        'technical_errors', v_technical_errors,

        -- Retención
        'retention_policy_days', 90
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_qa_dashboard_metrics(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_qa_dashboard_metrics(INT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------
-- 5. PROGRAMACIÓN DE PURGA EN pg_cron (DIARIA A LAS 03:30 UTC)
-- ------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('purgar_telemetria_uso_antigua_job');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        PERFORM cron.schedule(
            'purgar_telemetria_uso_antigua_job',
            '30 3 * * *',
            'SELECT public.purgar_telemetria_uso_antigua(90);'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

COMMIT;
