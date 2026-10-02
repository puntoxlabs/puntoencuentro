-- ============================================================
-- Migración: 20261002120000_dynamic_coverage_mvp.sql
-- Módulo: Dynamic Coverage MVP — Solicitudes de Cobertura y Señales Territoriales
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. TABLA: public.coverage_markets
-- Representa mercados activos y candidatos independientes de localidades
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coverage_markets (
    market_key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    city TEXT NULL,
    region TEXT NULL,
    country_code TEXT NOT NULL DEFAULT 'AR',
    status TEXT NOT NULL CHECK (status IN ('collecting', 'reviewing', 'planned', 'active')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.coverage_markets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.coverage_markets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.coverage_markets TO anon, authenticated;
GRANT ALL ON TABLE public.coverage_markets TO postgres, service_role;

CREATE POLICY "coverage_markets_read_policy" ON public.coverage_markets
    FOR SELECT TO anon, authenticated USING (true);

-- Seed inicial de mercados
INSERT INTO public.coverage_markets (market_key, label, city, region, country_code, status)
VALUES
    ('mar-del-plata', 'Mar del Plata', 'Mar del Plata', 'Buenos Aires', 'AR', 'active'),
    ('gran-mendoza', 'Gran Mendoza', 'Mendoza', 'Mendoza', 'AR', 'collecting')
ON CONFLICT (market_key) DO UPDATE
SET label = EXCLUDED.label,
    city = EXCLUDED.city,
    region = EXCLUDED.region,
    country_code = EXCLUDED.country_code,
    status = EXCLUDED.status,
    updated_at = pg_catalog.now();

-- ------------------------------------------------------------
-- 2. TABLA: public.coverage_location_aliases
-- Mapeo de variantes textuales a mercados o macrozonas existentes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coverage_location_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias_normalized TEXT NOT NULL UNIQUE,
    market_key TEXT NOT NULL REFERENCES public.coverage_markets(market_key) ON DELETE CASCADE,
    existing_locality_id TEXT NULL REFERENCES public.localidades(id) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_coverage_aliases_market ON public.coverage_location_aliases(market_key);
CREATE INDEX IF NOT EXISTS idx_coverage_aliases_norm ON public.coverage_location_aliases(alias_normalized) WHERE active = true;

ALTER TABLE public.coverage_location_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.coverage_location_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.coverage_location_aliases TO anon, authenticated;
GRANT ALL ON TABLE public.coverage_location_aliases TO postgres, service_role;

CREATE POLICY "coverage_aliases_read_policy" ON public.coverage_location_aliases
    FOR SELECT TO anon, authenticated USING (true);

-- Seed curado mínimo de aliases
INSERT INTO public.coverage_location_aliases (alias_normalized, market_key, existing_locality_id, active)
VALUES
    ('mendoza', 'gran-mendoza', NULL, true),
    ('mendoza capital', 'gran-mendoza', NULL, true),
    ('ciudad de mendoza', 'gran-mendoza', NULL, true),
    ('gran mendoza', 'gran-mendoza', NULL, true),
    ('godoy cruz', 'gran-mendoza', NULL, true),
    ('chacras de coria', 'gran-mendoza', NULL, true),
    ('los acantilados', 'mar-del-plata', 'sur-playas-del-sur', true)
ON CONFLICT (alias_normalized) DO UPDATE
SET market_key = EXCLUDED.market_key,
    existing_locality_id = EXCLUDED.existing_locality_id,
    active = EXCLUDED.active;

-- ------------------------------------------------------------
-- 3. TABLA: public.coverage_requests
-- Registro privado de señales territoriales e idempotencia por usuario
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coverage_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    market_key TEXT NULL REFERENCES public.coverage_markets(market_key) ON DELETE SET NULL,
    request_type TEXT NOT NULL CHECK (request_type IN ('new_market', 'catalog_gap', 'unknown')),
    raw_location_text TEXT NOT NULL,
    normalized_input TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    existing_locality_id TEXT NULL REFERENCES public.localidades(id) ON DELETE SET NULL,
    intent_text TEXT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'merged', 'dismissed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    last_requested_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT check_coverage_request_raw_length CHECK (char_length(raw_location_text) <= 100),
    CONSTRAINT check_coverage_request_intent_length CHECK (intent_text IS NULL OR char_length(intent_text) <= 500),
    CONSTRAINT uq_coverage_requests_user_dedupe UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_coverage_requests_user ON public.coverage_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_coverage_requests_market ON public.coverage_requests(market_key);
CREATE INDEX IF NOT EXISTS idx_coverage_requests_status ON public.coverage_requests(status);
CREATE INDEX IF NOT EXISTS idx_coverage_requests_created ON public.coverage_requests(created_at);

ALTER TABLE public.coverage_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.coverage_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.coverage_requests TO anon, authenticated;
GRANT ALL ON TABLE public.coverage_requests TO postgres, service_role;

CREATE POLICY "coverage_requests_select_own" ON public.coverage_requests
    FOR SELECT TO anon, authenticated
    USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 4. POLÍTICA DE RATE LIMITING SERVER-SIDE
-- Acción: 'submit_coverage_request' (10 requests cada 24 horas)
-- ------------------------------------------------------------
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES ('submit_coverage_request', 10, 86400, true)
ON CONFLICT (action) DO UPDATE
SET max_requests = EXCLUDED.max_requests,
    window_seconds = EXCLUDED.window_seconds,
    enabled = EXCLUDED.enabled,
    updated_at = pg_catalog.now();

-- ------------------------------------------------------------
-- 5. RPC PRINCIPAL: submit_coverage_request
-- Normalización determinística server-side, idempotencia y resolución
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_coverage_request(
    p_location_text TEXT,
    p_intent_text TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_raw_location TEXT;
    v_intent TEXT;
    v_normalized TEXT;
    v_alias RECORD;
    v_locality RECORD;
    v_dedupe_key TEXT;
    v_req_type TEXT;
    v_req_id UUID;
    v_rl JSONB;
    v_is_insert BOOLEAN := false;
BEGIN
    -- 1. Verificación de identidad obligatoria
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- 2. Sanitización y validación de entrada
    v_raw_location := pg_catalog.trim(COALESCE(p_location_text, ''));
    IF v_raw_location = '' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'location_required');
    END IF;

    IF pg_catalog.char_length(v_raw_location) > 100 THEN
        v_raw_location := pg_catalog.substr(v_raw_location, 1, 100);
    END IF;

    v_intent := pg_catalog.trim(COALESCE(p_intent_text, ''));
    IF v_intent = '' THEN
        v_intent := NULL;
    ELSIF pg_catalog.char_length(v_intent) > 500 THEN
        v_intent := pg_catalog.substr(v_intent, 1, 500);
    END IF;

    -- 3. Rate limiting server-side
    v_rl := public.check_rate_limit_internal('submit_coverage_request', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- 4. Normalización determinística: minúsculas, espacios y acentos comunes
    v_normalized := pg_catalog.lower(pg_catalog.regexp_replace(v_raw_location, '\s+', ' ', 'g'));
    v_normalized := pg_catalog.translate(v_normalized, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU');

    -- 5. Búsqueda de alias activo
    SELECT a.id, a.alias_normalized, a.market_key, a.existing_locality_id,
           m.label AS market_label, m.status AS market_status
    INTO v_alias
    FROM public.coverage_location_aliases a
    JOIN public.coverage_markets m ON m.market_key = a.market_key
    WHERE a.alias_normalized = v_normalized
      AND a.active = true
    LIMIT 1;

    -- Caso A: alias apunta a market active + existing_locality_id activo
    IF v_alias.id IS NOT NULL AND v_alias.market_status = 'active' AND v_alias.existing_locality_id IS NOT NULL THEN
        SELECT id, nombre INTO v_locality
        FROM public.localidades
        WHERE id = v_alias.existing_locality_id AND activo = true;

        IF v_locality.id IS NOT NULL THEN
            -- Resuelto a macrozona existente activa: NO se crea coverage_request
            RETURN pg_catalog.jsonb_build_object(
                'ok', true,
                'result_type', 'existing_locality',
                'existing_locality_id', v_locality.id,
                'existing_locality_name', v_locality.nombre,
                'market_key', v_alias.market_key,
                'market_label', v_alias.market_label
            );
        END IF;
    END IF;

    -- Caso B: alias apunta a market candidato (status != 'active')
    IF v_alias.id IS NOT NULL AND v_alias.market_status != 'active' THEN
        v_req_type := 'new_market';
        v_dedupe_key := 'market:' || v_alias.market_key;

        INSERT INTO public.coverage_requests (
            user_id, market_key, request_type, raw_location_text, normalized_input,
            dedupe_key, existing_locality_id, intent_text, status, last_requested_at
        ) VALUES (
            v_user_id, v_alias.market_key, v_req_type, v_raw_location, v_normalized,
            v_dedupe_key, NULL, v_intent, 'pending', pg_catalog.now()
        )
        ON CONFLICT (user_id, dedupe_key) DO UPDATE
        SET last_requested_at = pg_catalog.now(),
            intent_text = COALESCE(EXCLUDED.intent_text, public.coverage_requests.intent_text),
            updated_at = pg_catalog.now()
        RETURNING id, (xmax = 0) INTO v_req_id, v_is_insert;

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'result_type', CASE WHEN v_is_insert THEN 'request_created' ELSE 'request_updated' END,
            'market_key', v_alias.market_key,
            'market_label', v_alias.market_label
        );
    END IF;

    -- Caso C: alias apunta a market active pero sin existing_locality_id (catalog gap en ciudad activa)
    IF v_alias.id IS NOT NULL AND v_alias.market_status = 'active' AND v_alias.existing_locality_id IS NULL THEN
        v_req_type := 'catalog_gap';
        v_dedupe_key := 'gap:' || v_alias.market_key || ':' || v_normalized;

        INSERT INTO public.coverage_requests (
            user_id, market_key, request_type, raw_location_text, normalized_input,
            dedupe_key, existing_locality_id, intent_text, status, last_requested_at
        ) VALUES (
            v_user_id, v_alias.market_key, v_req_type, v_raw_location, v_normalized,
            v_dedupe_key, NULL, v_intent, 'pending', pg_catalog.now()
        )
        ON CONFLICT (user_id, dedupe_key) DO UPDATE
        SET last_requested_at = pg_catalog.now(),
            intent_text = COALESCE(EXCLUDED.intent_text, public.coverage_requests.intent_text),
            updated_at = pg_catalog.now()
        RETURNING id, (xmax = 0) INTO v_req_id, v_is_insert;

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'result_type', CASE WHEN v_is_insert THEN 'request_created' ELSE 'request_updated' END,
            'market_key', v_alias.market_key,
            'market_label', v_alias.market_label
        );
    END IF;

    -- Caso D: alias desconocido (unknown location)
    v_req_type := 'unknown';
    v_dedupe_key := 'unknown:' || v_normalized;

    INSERT INTO public.coverage_requests (
        user_id, market_key, request_type, raw_location_text, normalized_input,
        dedupe_key, existing_locality_id, intent_text, status, last_requested_at
    ) VALUES (
        v_user_id, NULL, v_req_type, v_raw_location, v_normalized,
        v_dedupe_key, NULL, v_intent, 'pending', pg_catalog.now()
    )
    ON CONFLICT (user_id, dedupe_key) DO UPDATE
    SET last_requested_at = pg_catalog.now(),
        intent_text = COALESCE(EXCLUDED.intent_text, public.coverage_requests.intent_text),
        updated_at = pg_catalog.now()
    RETURNING id, (xmax = 0) INTO v_req_id, v_is_insert;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'result_type', CASE WHEN v_is_insert THEN 'unknown_created' ELSE 'unknown_updated' END,
        'raw_location', v_raw_location
    );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_coverage_request(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_coverage_request(TEXT, TEXT) TO anon, authenticated;

-- ------------------------------------------------------------
-- 6. VISTAS DE INDICADORES INTERNOS (SOLO POSTGRES / SERVICE ROLE)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_coverage_growth_summary AS
SELECT
    COALESCE(m.market_key, 'unknown') AS market_key,
    COALESCE(m.label, 'Lugares sin clasificar') AS label,
    COALESCE(m.status, 'pending') AS market_status,
    pg_catalog.count(r.id)::int AS total_requests,
    pg_catalog.count(DISTINCT r.user_id)::int AS unique_requesters,
    pg_catalog.count(r.id) FILTER (WHERE r.created_at >= pg_catalog.now() - interval '7 days')::int AS requests_last_7d,
    pg_catalog.count(r.id) FILTER (WHERE r.created_at >= pg_catalog.now() - interval '30 days')::int AS requests_last_30d,
    pg_catalog.count(r.id) FILTER (WHERE r.intent_text IS NOT NULL AND r.intent_text <> '')::int AS requests_with_intent,
    pg_catalog.count(r.id) FILTER (WHERE r.request_type = 'catalog_gap')::int AS catalog_gap_count,
    pg_catalog.max(r.last_requested_at) AS last_request_at
FROM public.coverage_requests r
LEFT JOIN public.coverage_markets m ON r.market_key = m.market_key
GROUP BY m.market_key, m.label, m.status;

REVOKE ALL ON public.v_coverage_growth_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_coverage_growth_summary TO postgres, service_role;

CREATE OR REPLACE VIEW public.v_coverage_unknown_review AS
SELECT
    id,
    raw_location_text,
    normalized_input,
    intent_text,
    status,
    created_at,
    last_requested_at
FROM public.coverage_requests
WHERE request_type = 'unknown';

REVOKE ALL ON public.v_coverage_unknown_review FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_coverage_unknown_review TO postgres, service_role;

COMMIT;
