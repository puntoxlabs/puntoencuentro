-- ============================================================
-- Migration: 20261002130000_fix_coverage_btrim.sql
-- Module: Dynamic Coverage MVP — Hardening search_path and string trim
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_coverage_request(
    p_location_text TEXT,
    p_intent_text TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
        RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- 2. Sanitización y validación de entrada
    v_raw_location := trim(COALESCE(p_location_text, ''));
    IF v_raw_location = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'location_required');
    END IF;

    IF char_length(v_raw_location) > 100 THEN
        v_raw_location := substr(v_raw_location, 1, 100);
    END IF;

    v_intent := trim(COALESCE(p_intent_text, ''));
    IF v_intent = '' THEN
        v_intent := NULL;
    ELSIF char_length(v_intent) > 500 THEN
        v_intent := substr(v_intent, 1, 500);
    END IF;

    -- 3. Rate limiting server-side
    v_rl := public.check_rate_limit_internal('submit_coverage_request', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN jsonb_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- 4. Normalización determinística: minúsculas, espacios y acentos comunes
    v_normalized := lower(regexp_replace(v_raw_location, '\s+', ' ', 'g'));
    v_normalized := translate(v_normalized, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU');

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
            RETURN jsonb_build_object(
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
            v_dedupe_key, NULL, v_intent, 'pending', now()
        )
        ON CONFLICT (user_id, dedupe_key) DO UPDATE
        SET last_requested_at = now(),
            intent_text = COALESCE(EXCLUDED.intent_text, public.coverage_requests.intent_text),
            updated_at = now()
        RETURNING id, (xmax = 0) INTO v_req_id, v_is_insert;

        RETURN jsonb_build_object(
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
            v_dedupe_key, NULL, v_intent, 'pending', now()
        )
        ON CONFLICT (user_id, dedupe_key) DO UPDATE
        SET last_requested_at = now(),
            intent_text = COALESCE(EXCLUDED.intent_text, public.coverage_requests.intent_text),
            updated_at = now()
        RETURNING id, (xmax = 0) INTO v_req_id, v_is_insert;

        RETURN jsonb_build_object(
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
        v_dedupe_key, NULL, v_intent, 'pending', now()
    )
    ON CONFLICT (user_id, dedupe_key) DO UPDATE
    SET last_requested_at = now(),
        intent_text = COALESCE(EXCLUDED.intent_text, public.coverage_requests.intent_text),
        updated_at = now()
    RETURNING id, (xmax = 0) INTO v_req_id, v_is_insert;

    RETURN jsonb_build_object(
        'ok', true,
        'result_type', CASE WHEN v_is_insert THEN 'unknown_created' ELSE 'unknown_updated' END,
        'raw_location', v_raw_location
    );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_coverage_request(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_coverage_request(TEXT, TEXT) TO anon, authenticated;

COMMIT;
