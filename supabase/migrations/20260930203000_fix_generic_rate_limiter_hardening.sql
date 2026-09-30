-- ============================================================
-- Migration: Hardening Generic Rate Limiter & Policy Refinement
-- Module: Fase 2.0-C1 Antiabuso Core — T5-B1.1
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. RETIRAR POLICY CONTEXTUAL ENGAÑOSA (Section 7)
-- El cooldown post-rechazo no debe usar fixed-window bucket.
-- Se resolverá en T5-B2 mediante resolved_at + 6 hours.
-- ------------------------------------------------------------
DELETE FROM public.rate_limit_policies
WHERE action = 'join_open_encounter_same_target';

-- ------------------------------------------------------------
-- 2. HARDENING SEARCH_PATH: check_rate_limit_internal
-- Estándar de seguridad: SET search_path = '' y referencias
-- completamente calificadas.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(
    p_action TEXT,
    p_scope_key TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
    IF p_action IS NULL OR pg_catalog.char_length(trim(p_action)) = 0 OR pg_catalog.char_length(v_scope_key) > 128 THEN
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
        pg_catalog.floor(extract(epoch from pg_catalog.now()) / v_policy.window_seconds) * v_policy.window_seconds
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

-- Preservar privilegios restrictivos
REVOKE ALL ON FUNCTION public.check_rate_limit_internal(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_internal(TEXT, TEXT) TO postgres, service_role;

-- ------------------------------------------------------------
-- 3. HARDENING SEARCH_PATH: check_rate_limit_admin_inspect
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit_admin_inspect(
    p_user_id UUID,
    p_action TEXT,
    p_scope_key TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Permitir únicamente a service_role o postgres
    IF current_user NOT IN ('postgres', 'service_role')
       AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
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
