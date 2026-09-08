-- ============================================================
-- Migration: AI Creation Sessions & Metering (Minimum Privilege)
-- Conforms to: Ajuste 1 (Mínimo Privilegio) & Ajuste 2 (Abandono Derivado)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ai_creation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'abandoned', 'error', 'fallback_manual')),
    date_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (date_mode IN ('fixed', 'coordination')),
    encounter_id UUID REFERENCES public.encuentros(id) ON DELETE SET NULL,
    turns INT NOT NULL DEFAULT 0 CHECK (turns >= 0),
    total_input_tokens INT DEFAULT 0 CHECK (total_input_tokens >= 0),
    total_output_tokens INT DEFAULT 0 CHECK (total_output_tokens >= 0),
    provider TEXT,
    model TEXT,
    total_latency_ms INT DEFAULT 0 CHECK (total_latency_ms >= 0),
    elapsed_ms INT DEFAULT 0 CHECK (elapsed_ms >= 0),
    error_type TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_ai_creation_sessions_user_id ON public.ai_creation_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_creation_sessions_created_at ON public.ai_creation_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_creation_sessions_status ON public.ai_creation_sessions(status);

-- Enable Row Level Security
ALTER TABLE public.ai_creation_sessions ENABLE ROW LEVEL SECURITY;

-- Read policy: Users can only read their own AI sessions
CREATE POLICY "Users can view own ai sessions"
    ON public.ai_creation_sessions
    FOR SELECT
    USING (auth.uid() = user_id);

-- ============================================================
-- RPC 1: registrar_sesion_ai_inicio
-- Inicia una sesión de creación con IA con mínimo privilegio.
-- ============================================================
CREATE OR REPLACE FUNCTION public.registrar_sesion_ai_inicio(
    p_session_id UUID DEFAULT gen_random_uuid(),
    p_provider TEXT DEFAULT NULL,
    p_model TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_id UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    v_id := COALESCE(p_session_id, gen_random_uuid());

    INSERT INTO public.ai_creation_sessions (
        id,
        user_id,
        status,
        date_mode,
        provider,
        model,
        turns
    ) VALUES (
        v_id,
        v_user_id,
        'started',
        'fixed',
        p_provider,
        p_model,
        0
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN json_build_object('ok', true, 'session_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_sesion_ai_inicio(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_sesion_ai_inicio(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- RPC 2: registrar_sesion_ai_fin
-- Actualiza y concluye una sesión con métricas acumuladas.
-- Verifica que pertenezca al usuario autenticado (auth.uid()).
-- ============================================================
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
    p_model TEXT DEFAULT NULL
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
        completed_at = timezone('utc'::text, now())
    WHERE id = p_session_id
      AND user_id = v_user_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
        -- Si la sesión no existía aún (por ejemplo carrera de inicio), la creamos directamente
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
            timezone('utc'::text, now())
        );
    END IF;

    RETURN json_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_sesion_ai_fin(UUID, TEXT, UUID, INT, INT, INT, INT, INT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_sesion_ai_fin(UUID, TEXT, UUID, INT, INT, INT, INT, INT, TEXT, TEXT, TEXT) TO authenticated;
