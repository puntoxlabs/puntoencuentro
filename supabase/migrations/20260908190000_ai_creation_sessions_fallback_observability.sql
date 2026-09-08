-- ============================================================
-- Migration: AI Creation Sessions Fallback Observability
-- Conforms to: Ajuste de Observabilidad & Fallback Multi-Provider
-- Additive local migration: does not drop columns, backwards compatible
-- ============================================================

-- 1. Add metadata column for flexible telemetry (fallbackUsed, failure reasons, latencies breakdown)
ALTER TABLE public.ai_creation_sessions
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- 2. Extend registrar_sesion_ai_fin to accept p_metadata parameter
CREATE OR REPLACE FUNCTION public.registrar_sesion_ai_fin(
    p_session_id UUID,
    p_status TEXT,
    p_encounter_id UUID DEFAULT NULL,
    p_turns INT DEFAULT NULL,
    p_input_tokens INT DEFAULT NULL,
    p_output_tokens INT DEFAULT NULL,
    p_latency_ms INT DEFAULT NULL,
    p_elapsed_ms INT DEFAULT NULL,
    p_error_type TEXT DEFAULT NULL,
    p_provider TEXT DEFAULT NULL,
    p_model TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_updated INT;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF p_status NOT IN ('completed', 'abandoned', 'error', 'fallback_manual') THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_status');
    END IF;

    UPDATE public.ai_creation_sessions
    SET
        status = p_status,
        encounter_id = COALESCE(p_encounter_id, encounter_id),
        turns = COALESCE(p_turns, turns),
        total_input_tokens = COALESCE(p_input_tokens, total_input_tokens),
        total_output_tokens = COALESCE(p_output_tokens, total_output_tokens),
        total_latency_ms = COALESCE(p_latency_ms, total_latency_ms),
        elapsed_ms = COALESCE(p_elapsed_ms, elapsed_ms),
        error_type = COALESCE(p_error_type, error_type),
        provider = COALESCE(p_provider, provider),
        model = COALESCE(p_model, model),
        metadata = CASE
            WHEN p_metadata IS NOT NULL THEN COALESCE(metadata, '{}'::jsonb) || p_metadata
            ELSE metadata
        END,
        completed_at = timezone('utc'::text, now())
    WHERE id = p_session_id
      AND user_id = v_user_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
        -- Si la sesión no existía aún, crear registro inicial con métricas
        INSERT INTO public.ai_creation_sessions (
            id,
            user_id,
            status,
            date_mode,
            encounter_id,
            turns,
            total_input_tokens,
            total_output_tokens,
            total_latency_ms,
            elapsed_ms,
            error_type,
            provider,
            model,
            metadata,
            completed_at
        ) VALUES (
            p_session_id,
            v_user_id,
            p_status,
            'fixed',
            p_encounter_id,
            COALESCE(p_turns, 0),
            COALESCE(p_input_tokens, 0),
            COALESCE(p_output_tokens, 0),
            COALESCE(p_latency_ms, 0),
            COALESCE(p_elapsed_ms, 0),
            p_error_type,
            p_provider,
            p_model,
            COALESCE(p_metadata, '{}'::jsonb),
            timezone('utc'::text, now())
        );
    END IF;

    RETURN json_build_object('ok', true);
END;
$$;

-- Revoke default public permissions and grant to authenticated users
REVOKE ALL ON FUNCTION public.registrar_sesion_ai_fin(UUID, TEXT, UUID, INT, INT, INT, INT, INT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_sesion_ai_fin(UUID, TEXT, UUID, INT, INT, INT, INT, INT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
