-- ============================================================
-- Migration: AI Durable Rate Limit Buckets & Atomic Concurrency RPC
-- Conforms to: Bloqueo 1 (Rate Limit Durable Server-Side Distribuido)
-- ============================================================

-- 1. Table for durable hourly rate-limiting buckets
CREATE TABLE IF NOT EXISTS public.ai_rate_limit_buckets (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    request_count INT NOT NULL DEFAULT 0 CHECK (request_count >= 0),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (user_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_ai_rate_limit_buckets_user_window 
    ON public.ai_rate_limit_buckets(user_id, window_start);

-- 2. Enable Row Level Security (Minimum Privilege: users can only inspect their own bucket)
ALTER TABLE public.ai_rate_limit_buckets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own rate limit buckets" ON public.ai_rate_limit_buckets;
CREATE POLICY "Users can view own rate limit buckets"
    ON public.ai_rate_limit_buckets
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Drop deprecated overload if present
DROP FUNCTION IF EXISTS public.check_and_increment_ai_rate_limit(INT, UUID);

-- 3. Atomic RPC: check_and_increment_ai_rate_limit
-- Prevents race conditions via row-level atomic lock and conditional update.
-- Operates EXCLUSIVELY on auth.uid() to eliminate cross-user bucket tampering.
-- Guaranteed: exactly p_max_requests will be granted, any concurrent excess is rejected.
CREATE OR REPLACE FUNCTION public.check_and_increment_ai_rate_limit(
    p_max_requests INT DEFAULT 40
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_window_start TIMESTAMP WITH TIME ZONE;
    v_current_count INT;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object(
            'allowed', false,
            'error', 'not_authenticated',
            'message', 'Usuario no autenticado.'
        );
    END IF;

    -- Bucket start: truncate to current hour (1-hour window)
    v_window_start := date_trunc('hour', now());

    -- Ensure bucket row exists atomically
    INSERT INTO public.ai_rate_limit_buckets (user_id, window_start, request_count, updated_at)
    VALUES (v_user_id, v_window_start, 0, now())
    ON CONFLICT (user_id, window_start) DO NOTHING;

    -- Atomic row-lock update conditional on limit
    UPDATE public.ai_rate_limit_buckets
    SET request_count = request_count + 1,
        updated_at = now()
    WHERE user_id = v_user_id
      AND window_start = v_window_start
      AND request_count < p_max_requests
    RETURNING request_count INTO v_current_count;

    IF FOUND THEN
        RETURN json_build_object(
            'allowed', true,
            'current_count', v_current_count,
            'max_requests', p_max_requests,
            'window_start', v_window_start
        );
    ELSE
        SELECT request_count INTO v_current_count
        FROM public.ai_rate_limit_buckets
        WHERE user_id = v_user_id
          AND window_start = v_window_start;

        RETURN json_build_object(
            'allowed', false,
            'error', 'rate_limit_exceeded',
            'message', 'Alcanzaste el límite de consultas de IA por hora. Podés continuar manualmente.',
            'current_count', COALESCE(v_current_count, p_max_requests),
            'max_requests', p_max_requests,
            'window_start', v_window_start
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_ai_rate_limit(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_ai_rate_limit(INT) TO authenticated;
