-- ============================================================
-- Migration: Generic Server-Side Rate Limiter Core
-- Module: Fase 2.0-C1 Antiabuso Core — T5-B1
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. TABLA PRIVADA: public.rate_limit_policies
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
    action TEXT PRIMARY KEY,
    max_requests INTEGER NOT NULL CHECK (max_requests > 0),
    window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- RLS y Privacidad absoluta de políticas
ALTER TABLE public.rate_limit_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_policies FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rate_limit_policies TO postgres, service_role;

-- Semillas P0 de Soft Launch (Límites técnicos antiabuso)
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES
    ('create_encounter', 20, 3600, true),
    ('create_intention', 6, 3600, true),
    ('join_open_encounter', 12, 3600, true),
    ('join_open_encounter_same_target', 1, 21600, true)
ON CONFLICT (action) DO UPDATE
SET max_requests = EXCLUDED.max_requests,
    window_seconds = EXCLUDED.window_seconds,
    enabled = EXCLUDED.enabled,
    updated_at = pg_catalog.now();

-- ------------------------------------------------------------
-- 2. TABLA PRIVADA: public.rate_limit_buckets
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
    action TEXT NOT NULL REFERENCES public.rate_limit_policies(action) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    scope_key TEXT NOT NULL DEFAULT '',
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    PRIMARY KEY (action, user_id, scope_key, window_start),
    CONSTRAINT check_rate_limit_scope_key_length CHECK (char_length(scope_key) <= 128)
);

-- Índice para optimizar cleanup oportunista por usuario
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_user_window
    ON public.rate_limit_buckets(user_id, window_start);

-- RLS y Privacidad absoluta de buckets (infraestructura interna sin acceso a clientes)
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rate_limit_buckets TO postgres, service_role;

-- ------------------------------------------------------------
-- 3. FUNCIÓN INTERNA ATÓMICA: check_rate_limit_internal
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(
    p_action TEXT,
    p_scope_key TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_scope_key TEXT := COALESCE(p_scope_key, '');
    v_policy RECORD;
    v_window_start TIMESTAMPTZ;
    v_current_count INTEGER;
BEGIN
    -- 1. Control de autenticación: fail-closed si no hay identidad
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'authentication_required');
    END IF;

    -- 2. Validación básica de parámetros de entrada
    IF p_action IS NULL OR char_length(trim(p_action)) = 0 OR char_length(v_scope_key) > 128 THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'invalid_parameters');
    END IF;

    -- 3. Búsqueda server-side de la política
    SELECT max_requests, window_seconds, enabled
    INTO v_policy
    FROM public.rate_limit_policies
    WHERE action = p_action;

    -- 4. Fail-closed si la política no existe
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'rate_limit_policy_not_found');
    END IF;

    -- 5. Semántica administrativa para política deshabilitada
    IF v_policy.enabled = false THEN
        RETURN pg_catalog.jsonb_build_object('allowed', true, 'disabled', true);
    END IF;

    -- 6. Cálculo genérico de ventana discreta en base a epoch UTC
    v_window_start := pg_catalog.to_timestamp(
        floor(extract(epoch from pg_catalog.now()) / v_policy.window_seconds) * v_policy.window_seconds
    );

    -- 7. Operación ATÓMICA de inserción o incremento condicional (Fail-closed en límite)
    INSERT INTO public.rate_limit_buckets (
        action,
        user_id,
        scope_key,
        window_start,
        request_count,
        updated_at
    )
    VALUES (
        p_action,
        v_user_id,
        v_scope_key,
        v_window_start,
        1,
        pg_catalog.now()
    )
    ON CONFLICT (action, user_id, scope_key, window_start)
    DO UPDATE
    SET
        request_count = public.rate_limit_buckets.request_count + 1,
        updated_at = pg_catalog.now()
    WHERE public.rate_limit_buckets.request_count < v_policy.max_requests
    RETURNING request_count INTO v_current_count;

    -- Si no retornó fila, significa que el conflicto ocurrió y request_count ya era >= max_requests
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- 8. Cleanup oportunista acotado únicamente al usuario actual (buckets > 48h)
    DELETE FROM public.rate_limit_buckets
    WHERE user_id = v_user_id
      AND window_start < (pg_catalog.now() - interval '48 hours');

    RETURN pg_catalog.jsonb_build_object('allowed', true);
EXCEPTION WHEN OTHERS THEN
    -- Fail-closed total ante cualquier error inesperado
    RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'rate_limit_error');
END;
$$;

-- ------------------------------------------------------------
-- 4. PRIVACIDAD DE EJECUCIÓN DEL HELPER
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.check_rate_limit_internal(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_internal(TEXT, TEXT) TO postgres, service_role;

-- ------------------------------------------------------------
-- 5. HELPER ADMINISTRATIVO PARA QA Y PRUEBAS CONTROLADAS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit_admin_inspect(
    p_user_id UUID,
    p_action TEXT,
    p_scope_key TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Permitir únicamente a service_role o postgres
    IF current_user NOT IN ('postgres', 'service_role') AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'unauthorized');
    END IF;

    -- Simular la sesión del usuario para evaluar check_rate_limit_internal
    PERFORM pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
    RETURN public.check_rate_limit_internal(p_action, p_scope_key);
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit_admin_inspect(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_admin_inspect(UUID, TEXT, TEXT) TO postgres, service_role;

COMMIT;
