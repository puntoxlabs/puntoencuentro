-- ============================================================
-- Migración: 20261012010500_fix_activity_relevance_coalesce.sql
-- Módulo: Corrección de llamada COALESCE en fn_classify_activity
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_classify_activity(
    p_titulo TEXT,
    p_descripcion TEXT DEFAULT NULL
)
RETURNS TABLE (
    activity_canonical TEXT,
    activity_strong_tokens TEXT[],
    activity_matching_eligible BOOLEAN,
    match_ineligible_reason TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    v_norm TEXT;
    v_matched_canonicals TEXT[];
    v_matched_tokens TEXT[];
    v_canon_count INT;
BEGIN
    -- Normalizar texto consolidado con COALESCE nativo
    v_norm := public.fn_normalize_activity_text(
        COALESCE(p_titulo, ''::TEXT) || ' ' || COALESCE(p_descripcion, ''::TEXT)
    );

    IF v_norm = '' THEN
        RETURN QUERY SELECT
            NULL::TEXT,
            '{}'::TEXT[],
            false,
            'no_activity_detected'::TEXT;
        RETURN;
    END IF;

    -- Buscar aliases fuertes que coincidan con límites de palabras en el texto normalizado
    SELECT
        pg_catalog.array_agg(DISTINCT a.canonical_key),
        pg_catalog.array_agg(DISTINCT a.alias_normalized)
    INTO v_matched_canonicals, v_matched_tokens
    FROM public.activity_aliases a
    WHERE a.active = true
      AND a.strength = 'strong'
      AND (' ' || v_norm || ' ') LIKE ('% ' || a.alias_normalized || ' %');

    v_canon_count := COALESCE(pg_catalog.cardinality(v_matched_canonicals), 0);

    IF v_canon_count = 1 THEN
        RETURN QUERY SELECT
            v_matched_canonicals[1],
            COALESCE(v_matched_tokens, '{}'::TEXT[]),
            true,
            NULL::TEXT;
    ELSIF v_canon_count >= 2 THEN
        RETURN QUERY SELECT
            NULL::TEXT,
            COALESCE(v_matched_tokens, '{}'::TEXT[]),
            false,
            'multiple_activities'::TEXT;
    ELSE
        RETURN QUERY SELECT
            NULL::TEXT,
            '{}'::TEXT[],
            false,
            'no_activity_detected'::TEXT;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_classify_activity(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_classify_activity(TEXT, TEXT) TO postgres, service_role;

-- Re-ejecutar triggers en intenciones y encuentros existentes si los hubiera
UPDATE public.intenciones
SET updated_at = updated_at
WHERE activity_classified_at IS NULL;

UPDATE public.encuentros
SET creado_en = creado_en
WHERE open_activity_classified_at IS NULL;

COMMIT;
