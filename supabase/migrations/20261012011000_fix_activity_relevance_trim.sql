-- ============================================================
-- Migración: 20261012011000_fix_activity_relevance_trim.sql
-- Módulo: Corrección de btrim en fn_normalize_activity_text y crear_intencion_segura
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_normalize_activity_text(p_text TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_cleaned TEXT;
BEGIN
    IF p_text IS NULL OR pg_catalog.btrim(p_text) = '' THEN
        RETURN '';
    END IF;

    -- Minúsculas y reemplazo determinístico de acentos/diacríticos
    v_cleaned := pg_catalog.translate(
        pg_catalog.lower(p_text),
        'áéíóúüñãõàèìòùâêîôûç',
        'aeiouunaoaeiouaeiouc'
    );

    -- Sustituir puntuación y caracteres especiales por espacios
    v_cleaned := pg_catalog.regexp_replace(v_cleaned, '[^a-z0-9]+', ' ', 'g');
    RETURN pg_catalog.btrim(v_cleaned);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_normalize_activity_text(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_normalize_activity_text(TEXT) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.crear_intencion_segura(
    p_titulo TEXT,
    p_descripcion TEXT DEFAULT NULL,
    p_temporalidad_texto TEXT DEFAULT NULL,
    p_fecha_desde DATE DEFAULT NULL,
    p_fecha_hasta DATE DEFAULT NULL,
    p_modalidad TEXT DEFAULT 'presencial',
    p_locality_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_titulo_clean TEXT;
    v_modalidad_clean TEXT;
    v_new_id UUID;
    v_eval_res JSONB;
    v_matches_count INT := 0;
    v_matched_ids JSONB := '[]'::jsonb;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_titulo_clean := pg_catalog.btrim(COALESCE(p_titulo, ''));
    IF v_titulo_clean = '' OR length(p_titulo) > 120 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_title');
    END IF;

    v_modalidad_clean := pg_catalog.btrim(COALESCE(p_modalidad, 'presencial'));
    IF v_modalidad_clean NOT IN ('presencial', 'virtual', 'indistinto') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_modality');
    END IF;

    IF p_fecha_desde IS NOT NULL AND p_fecha_hasta IS NOT NULL AND p_fecha_desde > p_fecha_hasta THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_date_range');
    END IF;

    IF p_locality_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.localidades WHERE id = p_locality_id AND activo = true) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_locality');
        END IF;
    END IF;

    INSERT INTO public.intenciones (
        user_id,
        titulo,
        descripcion,
        temporalidad_texto,
        fecha_desde,
        fecha_hasta,
        modalidad,
        locality_id,
        estado
    ) VALUES (
        v_user_id,
        v_titulo_clean,
        NULLIF(pg_catalog.btrim(COALESCE(p_descripcion, '')), ''),
        NULLIF(pg_catalog.btrim(COALESCE(p_temporalidad_texto, '')), ''),
        p_fecha_desde,
        p_fecha_hasta,
        v_modalidad_clean,
        p_locality_id,
        'activa'
    )
    RETURNING id INTO v_new_id;

    -- Matching inmediato contra encuentros abiertos existentes
    v_eval_res := public.evaluar_matching_intencion_activa(v_new_id);
    IF (v_eval_res ->> 'ok')::boolean = true THEN
        v_matches_count := COALESCE((v_eval_res ->> 'matches_found_count')::int, 0);
        v_matched_ids := COALESCE(v_eval_res -> 'matched_encounter_ids', '[]'::jsonb);
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'matches_found_count', v_matches_count,
        'matched_encounter_ids', v_matched_ids
    );
END;
$$;

REVOKE ALL ON FUNCTION public.crear_intencion_segura(TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_intencion_segura(TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) TO authenticated;

COMMIT;
