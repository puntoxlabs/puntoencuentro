-- ============================================================
-- Migración: 20260915100000_qa_observability_backend.sql
-- Módulo: QA Console & Observabilidad de Creación (Etapa A - Hardened)
-- Descripción: Fundación segura de base de datos para observabilidad
--              del embudo de creación (Manual e IA), detección de
--              sesiones problemáticas, integridad de ownership y
--              autorización server-side.
-- ============================================================

-- 1. Tabla de Usuarios Autorizados para QA/Admin
CREATE TABLE IF NOT EXISTS public.qa_authorized_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'qa' CHECK (role IN ('admin', 'qa')),
    created_at TIMESTAMPTZ DEFAULT pg_catalog.timezone('utc', pg_catalog.now()) NOT NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.qa_authorized_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.qa_authorized_users FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.qa_authorized_users TO postgres, service_role;

-- 2. Función de Autorización Server-Side (Hardened search_path = '')
CREATE OR REPLACE FUNCTION public.is_qa_authorized()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM public.qa_authorized_users
        WHERE user_id = v_user_id
          AND role IN ('admin', 'qa')
    );
END;
$$;

REVOKE ALL ON FUNCTION public.is_qa_authorized() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_qa_authorized() TO authenticated, postgres, service_role;

-- 3. Tabla de Sesiones de Creación (Entidad Raíz del Embudo)
CREATE TABLE IF NOT EXISTS public.creation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    client_token_hash TEXT CHECK (client_token_hash IS NULL OR pg_catalog.length(client_token_hash) = 64),
    creation_source TEXT NOT NULL CHECK (creation_source IN ('ai', 'manual')),
    initial_route TEXT NOT NULL CHECK (initial_route IN ('/create', '/create/coordination', '/create/ai')),
    status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'cancelled')),
    date_mode TEXT CHECK (date_mode IN ('fixed', 'coordination')),
    encounter_id UUID REFERENCES public.encuentros(id) ON DELETE SET NULL,
    turns INT NOT NULL DEFAULT 0 CHECK (turns >= 0),
    elapsed_ms INT DEFAULT 0 CHECK (elapsed_ms >= 0),
    frontend_version TEXT CHECK (frontend_version IS NULL OR pg_catalog.length(frontend_version) <= 50),
    edge_version TEXT CHECK (edge_version IS NULL OR pg_catalog.length(edge_version) <= 50),
    created_at TIMESTAMPTZ DEFAULT pg_catalog.timezone('utc', pg_catalog.now()) NOT NULL,
    completed_at TIMESTAMPTZ,
    last_event_at TIMESTAMPTZ DEFAULT pg_catalog.timezone('utc', pg_catalog.now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_creation_sessions_created_at ON public.creation_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creation_sessions_status ON public.creation_sessions(status);
CREATE INDEX IF NOT EXISTS idx_creation_sessions_last_event_at ON public.creation_sessions(last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_creation_sessions_user_id ON public.creation_sessions(user_id) WHERE user_id IS NOT NULL;

ALTER TABLE public.creation_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.creation_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.creation_sessions TO postgres, service_role;

-- 4. Tabla de Eventos de Turno / Hitos de Sesión
CREATE TABLE IF NOT EXISTS public.creation_session_events (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES public.creation_sessions(id) ON DELETE CASCADE,
    turn_number INT NOT NULL DEFAULT 0 CHECK (turn_number >= 0),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'session_started',
        'turn_resolved',
        'clarification_requested',
        'provider_fallback',
        'technical_error',
        'encounter_created',
        'session_cancelled'
    )),
    source TEXT NOT NULL CHECK (source IN (
        'deterministic',
        'llm_openai',
        'llm_mistral',
        'ui_manual',
        'system'
    )),
    operation TEXT CHECK (operation IS NULL OR pg_catalog.length(operation) <= 60),
    result TEXT CHECK (result IS NULL OR result IN (
        'success',
        'needs_clarification',
        'technical_error',
        'off_topic',
        'unclear',
        'cancelled'
    )),
    provider TEXT CHECK (provider IS NULL OR pg_catalog.length(provider) <= 30),
    fallback_used BOOLEAN NOT NULL DEFAULT false,
    latency_ms INT CHECK (latency_ms IS NULL OR (latency_ms >= 0 AND latency_ms <= 300000)),
    fields_changed TEXT[] CHECK (fields_changed IS NULL OR pg_catalog.array_length(fields_changed, 1) <= 15),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT pg_catalog.timezone('utc', pg_catalog.now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_creation_session_events_session_created 
    ON public.creation_session_events(session_id, created_at ASC);

ALTER TABLE public.creation_session_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.creation_session_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.creation_session_events TO postgres, service_role;

-- 5. RPC de Ingesta Segura (Cliente -> Servidor)
CREATE OR REPLACE FUNCTION public.registrar_evento_creacion(
    p_session_id UUID,
    p_event_type TEXT,
    p_source TEXT,
    p_creation_source TEXT DEFAULT NULL,
    p_initial_route TEXT DEFAULT NULL,
    p_turn_number INT DEFAULT NULL,
    p_operation TEXT DEFAULT NULL,
    p_result TEXT DEFAULT NULL,
    p_provider TEXT DEFAULT NULL,
    p_fallback_used BOOLEAN DEFAULT FALSE,
    p_latency_ms INT DEFAULT NULL,
    p_fields_changed TEXT[] DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL,
    p_date_mode TEXT DEFAULT NULL,
    p_encounter_id UUID DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_elapsed_ms INT DEFAULT NULL,
    p_frontend_version TEXT DEFAULT NULL,
    p_edge_version TEXT DEFAULT NULL,
    p_client_token TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_session_exists BOOLEAN;
    v_session_user_id UUID;
    v_session_token_hash TEXT;
    v_session_status TEXT;
    v_computed_hash TEXT;
    v_effective_status TEXT;
    v_effective_route TEXT;
    v_effective_source TEXT;
    v_meta_key TEXT;
    v_meta_value JSONB;
    v_is_service_role BOOLEAN;
BEGIN
    -- 1. Validaciones básicas de identificadores y tipos
    IF p_session_id IS NULL THEN
        RAISE EXCEPTION 'invalid_session_id: cannot be null';
    END IF;

    IF p_event_type NOT IN (
        'session_started',
        'turn_resolved',
        'clarification_requested',
        'provider_fallback',
        'technical_error',
        'encounter_created',
        'session_cancelled'
    ) THEN
        RAISE EXCEPTION 'invalid_event_type: %', p_event_type;
    END IF;

    IF p_source NOT IN ('deterministic', 'llm_openai', 'llm_mistral', 'ui_manual', 'system') THEN
        RAISE EXCEPTION 'invalid_source: %', p_source;
    END IF;

    -- 2. Validación de strings y rangos defensivos
    IF p_operation IS NOT NULL AND pg_catalog.length(p_operation) > 60 THEN
        RAISE EXCEPTION 'operation_too_long: max 60 characters';
    END IF;

    IF p_provider IS NOT NULL AND pg_catalog.length(p_provider) > 30 THEN
        RAISE EXCEPTION 'provider_too_long: max 30 characters';
    END IF;

    IF p_latency_ms IS NOT NULL AND (p_latency_ms < 0 OR p_latency_ms > 300000) THEN
        RAISE EXCEPTION 'invalid_latency_ms: must be between 0 and 300000';
    END IF;

    IF p_turn_number IS NOT NULL AND p_turn_number < 0 THEN
        RAISE EXCEPTION 'invalid_turn_number: cannot be negative';
    END IF;

    IF p_status IS NOT NULL AND p_status NOT IN ('started', 'completed', 'cancelled') THEN
        RAISE EXCEPTION 'invalid_status: %', p_status;
    END IF;

    IF p_date_mode IS NOT NULL AND p_date_mode NOT IN ('fixed', 'coordination') THEN
        RAISE EXCEPTION 'invalid_date_mode: %', p_date_mode;
    END IF;

    -- Validación de client_token
    IF p_client_token IS NOT NULL THEN
        IF pg_catalog.length(p_client_token) < 16 OR pg_catalog.length(p_client_token) > 128 THEN
            RAISE EXCEPTION 'invalid_client_token: length must be between 16 and 128 characters';
        END IF;
        v_computed_hash := pg_catalog.encode(pg_catalog.sha256(p_client_token::bytea), 'hex');
    END IF;

    -- 3. Whitelist estricta de Metadata y prohibición de nesting/PII
    IF p_metadata IS NOT NULL THEN
        IF pg_catalog.pg_column_size(p_metadata) > 2048 THEN
            RAISE EXCEPTION 'metadata_too_large: max 2048 bytes';
        END IF;

        IF pg_catalog.jsonb_typeof(p_metadata) != 'object' THEN
            RAISE EXCEPTION 'metadata_must_be_object';
        END IF;

        FOR v_meta_key, v_meta_value IN SELECT * FROM pg_catalog.jsonb_each(p_metadata) LOOP
            IF v_meta_key NOT IN (
                'ambiguity_type',
                'ambiguity_reason',
                'error_code',
                'input_length',
                'resolver',
                'action_status',
                'turn_intent'
            ) THEN
                RAISE EXCEPTION 'disallowed_metadata_key: %', v_meta_key;
            END IF;

            IF pg_catalog.jsonb_typeof(v_meta_value) IN ('object', 'array') THEN
                RAISE EXCEPTION 'nested_metadata_not_allowed: %', v_meta_key;
            END IF;

            IF pg_catalog.jsonb_typeof(v_meta_value) = 'string' THEN
                IF pg_catalog.length(v_meta_value #>> '{}') > 500 THEN
                    RAISE EXCEPTION 'metadata_string_too_long: %', v_meta_key;
                END IF;
            END IF;
        END LOOP;
    END IF;

    -- 4. Verificación de existencia de la sesión y ownership
    SELECT EXISTS (
        SELECT 1 FROM public.creation_sessions WHERE id = p_session_id
    ) INTO v_session_exists;

    -- Determinar status efectivo
    v_effective_status := COALESCE(
        p_status,
        CASE 
            WHEN p_event_type = 'encounter_created' THEN 'completed'
            WHEN p_event_type = 'session_cancelled' THEN 'cancelled'
            ELSE 'started'
        END
    );

    IF NOT v_session_exists THEN
        -- Normalizar y validar ruta de inicio y fuente de creación
        v_effective_route := COALESCE(p_initial_route, '/create/ai');
        IF v_effective_route NOT IN ('/create', '/create/coordination', '/create/ai') THEN
            RAISE EXCEPTION 'invalid_initial_route: %', v_effective_route;
        END IF;

        -- Inferencia/validación de creation_source coherente
        IF v_effective_route = '/create/ai' THEN
            v_effective_source := 'ai';
        ELSE
            v_effective_source := 'manual';
        END IF;

        IF p_creation_source IS NOT NULL AND p_creation_source != v_effective_source THEN
            RAISE EXCEPTION 'incoherent_creation_source_and_route: source=% route=%', p_creation_source, v_effective_route;
        END IF;

        -- Si la sesión es anónima, se requiere un client_token válido
        IF v_user_id IS NULL AND p_client_token IS NULL THEN
            RAISE EXCEPTION 'client_token_required_for_anonymous_session';
        END IF;

        INSERT INTO public.creation_sessions (
            id,
            user_id,
            client_token_hash,
            creation_source,
            initial_route,
            status,
            date_mode,
            encounter_id,
            turns,
            elapsed_ms,
            frontend_version,
            edge_version,
            created_at,
            completed_at,
            last_event_at
        ) VALUES (
            p_session_id,
            v_user_id,
            v_computed_hash,
            v_effective_source,
            v_effective_route,
            v_effective_status,
            p_date_mode,
            p_encounter_id,
            COALESCE(p_turn_number, 0),
            COALESCE(p_elapsed_ms, 0),
            p_frontend_version,
            p_edge_version,
            v_now,
            CASE WHEN v_effective_status IN ('completed', 'cancelled') THEN v_now ELSE NULL END,
            v_now
        );
    ELSE
        -- Obtener datos de la sesión existente para validar ownership
        SELECT s.user_id, s.client_token_hash, s.status
        INTO v_session_user_id, v_session_token_hash, v_session_status
        FROM public.creation_sessions s
        WHERE s.id = p_session_id;

        v_is_service_role := (COALESCE(pg_catalog.current_setting('request.jwt.claim.role', true), '') = 'service_role');

        IF NOT v_is_service_role THEN
            -- Regla A: Si session.user_id IS NOT NULL, sólo el mismo usuario autenticado puede escribir
            IF v_session_user_id IS NOT NULL THEN
                IF v_user_id IS NULL OR v_user_id != v_session_user_id THEN
                    RAISE EXCEPTION 'unauthorized_session_access: user mismatch';
                END IF;
            -- Regla B y C: Si session.user_id IS NULL, verificar client_token
            ELSE
                IF v_session_token_hash IS NOT NULL THEN
                    IF p_client_token IS NULL OR v_computed_hash != v_session_token_hash THEN
                        RAISE EXCEPTION 'unauthorized_session_access: invalid client token';
                    END IF;
                END IF;
            END IF;
        END IF;

        -- Actualizar sesión existente (asociando user_id autenticado si se validó la sesión anónima)
        UPDATE public.creation_sessions
        SET
            user_id = COALESCE(user_id, v_user_id),
            status = v_effective_status,
            date_mode = COALESCE(p_date_mode, date_mode),
            encounter_id = COALESCE(p_encounter_id, encounter_id),
            turns = GREATEST(turns, COALESCE(p_turn_number, turns)),
            elapsed_ms = GREATEST(elapsed_ms, COALESCE(p_elapsed_ms, elapsed_ms)),
            completed_at = CASE 
                WHEN v_effective_status IN ('completed', 'cancelled') AND completed_at IS NULL THEN v_now 
                ELSE completed_at 
            END,
            last_event_at = v_now
        WHERE id = p_session_id;
    END IF;

    -- 5. Insertar el evento de ciclo de vida
    INSERT INTO public.creation_session_events (
        session_id,
        turn_number,
        event_type,
        source,
        operation,
        result,
        provider,
        fallback_used,
        latency_ms,
        fields_changed,
        metadata,
        created_at
    ) VALUES (
        p_session_id,
        COALESCE(p_turn_number, 0),
        p_event_type,
        p_source,
        p_operation,
        p_result,
        p_provider,
        COALESCE(p_fallback_used, false),
        p_latency_ms,
        p_fields_changed,
        COALESCE(p_metadata, '{}'::jsonb),
        v_now
    );

    RETURN pg_catalog.json_build_object('ok', true, 'session_id', p_session_id);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_evento_creacion(
    UUID, TEXT, TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, TEXT[], JSONB, TEXT, UUID, TEXT, INT, TEXT, TEXT, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.registrar_evento_creacion(
    UUID, TEXT, TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, TEXT[], JSONB, TEXT, UUID, TEXT, INT, TEXT, TEXT, TEXT
) TO anon, authenticated, postgres, service_role;

-- 6. RPC Admin: Métricas de Portada
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
BEGIN
    -- 1. Validación estricta de autorización
    IF NOT public.is_qa_authorized() THEN
        RAISE EXCEPTION 'unauthorized: insufficient permissions for QA metrics';
    END IF;

    -- Validación estricta de parámetros
    IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
        RAISE EXCEPTION 'invalid_parameter: p_days must be between 1 and 90';
    END IF;

    v_since := pg_catalog.timezone('utc', pg_catalog.now()) - (p_days || ' days')::INTERVAL;

    -- 2. Agregados de sesiones
    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'completed'),
        -- Abandono derivado: status = 'started' y sin actividad en > 30 minutos (heurístico)
        COUNT(*) FILTER (WHERE status = 'started' AND last_event_at < pg_catalog.timezone('utc', pg_catalog.now()) - INTERVAL '30 minutes'),
        COUNT(*) FILTER (WHERE status = 'cancelled'),
        COUNT(*) FILTER (WHERE creation_source = 'ai'),
        COUNT(*) FILTER (WHERE creation_source = 'manual'),
        COUNT(*) FILTER (WHERE date_mode = 'fixed' AND status = 'completed'),
        COUNT(*) FILTER (WHERE date_mode = 'coordination' AND status = 'completed')
    INTO
        v_total_sessions,
        v_completed_sessions,
        v_probable_abandoned_sessions,
        v_cancelled_sessions,
        v_ai_sessions,
        v_manual_sessions,
        v_fixed_encounters,
        v_coordination_encounters
    FROM public.creation_sessions
    WHERE created_at >= v_since;

    -- 3. Agregados de eventos de Crear con IA
    SELECT
        COUNT(*) FILTER (WHERE source = 'deterministic'),
        COUNT(*) FILTER (WHERE source IN ('llm_openai', 'llm_mistral')),
        COUNT(*) FILTER (WHERE fallback_used = true),
        COUNT(*) FILTER (WHERE event_type = 'clarification_requested' OR result = 'needs_clarification'),
        COALESCE(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL), 0)::INT,
        COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL), 0)::INT
    INTO
        v_deterministic_events,
        v_llm_events,
        v_fallback_events,
        v_clarification_events,
        v_avg_latency_ms,
        v_p90_latency_ms
    FROM public.creation_session_events e
    WHERE e.created_at >= v_since;

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
        'p90_latency_ms', v_p90_latency_ms
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_qa_dashboard_metrics(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_qa_dashboard_metrics(INT) TO authenticated, postgres, service_role;

-- 7. RPC Admin: Listado Paginado de Sesiones con Detección de Fricción
CREATE OR REPLACE FUNCTION public.get_qa_sessions(
    p_days INT DEFAULT 7,
    p_status TEXT DEFAULT NULL,
    p_source TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_since TIMESTAMPTZ;
    v_sessions JSON;
    v_total INT;
BEGIN
    -- 1. Validación estricta de autorización
    IF NOT public.is_qa_authorized() THEN
        RAISE EXCEPTION 'unauthorized: insufficient permissions for QA sessions';
    END IF;

    -- Validación estricta de parámetros
    IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
        RAISE EXCEPTION 'invalid_parameter: p_days must be between 1 and 90';
    END IF;

    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'invalid_parameter: p_limit must be between 1 and 100';
    END IF;

    IF p_offset IS NULL OR p_offset < 0 OR p_offset > 10000 THEN
        RAISE EXCEPTION 'invalid_parameter: p_offset must be between 0 and 10000';
    END IF;

    IF p_status IS NOT NULL AND p_status NOT IN ('started', 'completed', 'cancelled') THEN
        RAISE EXCEPTION 'invalid_parameter: invalid p_status: %', p_status;
    END IF;

    IF p_source IS NOT NULL AND p_source NOT IN ('ai', 'manual') THEN
        RAISE EXCEPTION 'invalid_parameter: invalid p_source: %', p_source;
    END IF;

    v_since := pg_catalog.timezone('utc', pg_catalog.now()) - (p_days || ' days')::INTERVAL;

    -- Total count con filtros
    SELECT COUNT(*) INTO v_total
    FROM public.creation_sessions s
    WHERE s.created_at >= v_since
      AND (p_status IS NULL OR s.status = p_status)
      AND (p_source IS NULL OR s.creation_source = p_source);

    -- Paginación de sesiones con clasificación determinista de fricción
    SELECT pg_catalog.json_agg(row_data) INTO v_sessions
    FROM (
        SELECT
            s.id,
            s.creation_source,
            s.initial_route,
            s.status,
            s.date_mode,
            s.encounter_id,
            s.turns,
            s.elapsed_ms,
            s.frontend_version,
            s.edge_version,
            s.created_at,
            s.completed_at,
            s.last_event_at,
            -- Detección de Fricción: PROBLEMÁTICA
            -- Reglas:
            -- 1. technical_error no recuperable en eventos (event_type o result)
            -- 2. Doble fallo de provider (>= 2 provider_fallback o fallback_used)
            -- 3. >= 2 aclaraciones acumuladas
            -- 4. >= 8 turnos sin creación (turns >= 8 AND status != 'completed')
            (
                EXISTS (
                    SELECT 1 FROM public.creation_session_events e
                    WHERE e.session_id = s.id AND (e.event_type = 'technical_error' OR e.result = 'technical_error')
                ) OR
                (
                    SELECT COUNT(*) FROM public.creation_session_events e
                    WHERE e.session_id = s.id AND (e.event_type = 'provider_fallback' OR e.fallback_used = true)
                ) >= 2 OR
                (
                    SELECT COUNT(*) FROM public.creation_session_events e
                    WHERE e.session_id = s.id AND (e.event_type = 'clarification_requested' OR e.result = 'needs_clarification')
                ) >= 2 OR
                (s.status != 'completed' AND s.turns >= 8)
            ) AS is_problematic,
            -- Detección de Fricción: REVISAR
            -- Reglas:
            -- 1. Fallback simple utilizado (= 1)
            -- 2. Exactamente 1 aclaración (= 1)
            -- 3. Retry explícito
            -- 4. Duración > 5 min (elapsed_ms > 300000)
            (
                (
                    SELECT COUNT(*) FROM public.creation_session_events e
                    WHERE e.session_id = s.id AND (e.event_type = 'provider_fallback' OR e.fallback_used = true)
                ) = 1 OR
                (
                    SELECT COUNT(*) FROM public.creation_session_events e
                    WHERE e.session_id = s.id AND (e.event_type = 'clarification_requested' OR e.result = 'needs_clarification')
                ) = 1 OR
                EXISTS (
                    SELECT 1 FROM public.creation_session_events e
                    WHERE e.session_id = s.id AND (e.operation = 'RETRY' OR (e.metadata ? 'action_status' AND e.metadata ->> 'action_status' = 'retry'))
                ) OR
                (s.elapsed_ms > 300000)
            ) AS needs_review
        FROM public.creation_sessions s
        WHERE s.created_at >= v_since
          AND (p_status IS NULL OR s.status = p_status)
          AND (p_source IS NULL OR s.creation_source = p_source)
        ORDER BY s.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) row_data;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'sessions', COALESCE(v_sessions, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_qa_sessions(INT, TEXT, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_qa_sessions(INT, TEXT, TEXT, INT, INT) TO authenticated, postgres, service_role;

-- 8. RPC Admin: Timeline Detallado de Sesión
CREATE OR REPLACE FUNCTION public.get_qa_session_timeline(
    p_session_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_session JSON;
    v_events JSON;
BEGIN
    -- 1. Validación estricta de autorización
    IF NOT public.is_qa_authorized() THEN
        RAISE EXCEPTION 'unauthorized: insufficient permissions for QA timeline';
    END IF;

    IF p_session_id IS NULL THEN
        RAISE EXCEPTION 'invalid_parameter: p_session_id cannot be null';
    END IF;

    -- Obtener sesión
    SELECT pg_catalog.row_to_json(s) INTO v_session
    FROM public.creation_sessions s
    WHERE s.id = p_session_id;

    IF v_session IS NULL THEN
        RAISE EXCEPTION 'session_not_found: %', p_session_id;
    END IF;

    -- Obtener eventos cronológicos
    SELECT pg_catalog.json_agg(row_data) INTO v_events
    FROM (
        SELECT
            e.id,
            e.turn_number,
            e.event_type,
            e.source,
            e.operation,
            e.result,
            e.provider,
            e.fallback_used,
            e.latency_ms,
            e.fields_changed,
            e.metadata,
            e.created_at
        FROM public.creation_session_events e
        WHERE e.session_id = p_session_id
        ORDER BY e.created_at ASC, e.id ASC
    ) row_data;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'session', v_session,
        'events', COALESCE(v_events, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_qa_session_timeline(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_qa_session_timeline(UUID) TO authenticated, postgres, service_role;
