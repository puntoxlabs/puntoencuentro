-- ============================================================
-- Migración: 20260929162500_fix_get_my_entitlements_greatest.sql
-- Módulo: Encuentros Abiertos 1.5-D — Fix GREATEST en get_my_entitlements
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_my_entitlements()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_plan TEXT;
    v_period DATE;
    v_limit INT;
    v_enforced BOOLEAN;
    v_consumed INT := 0;
    v_active_reserved INT := 0;
    v_capabilities JSONB;
BEGIN
    -- Usuario no autenticado / anónimo
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'plan', 'anonymous',
            'authenticated', false,
            'is_anonymous', true,
            'capabilities', pg_catalog.jsonb_build_object(
                'ai_creation', false,
                'recurring', false,
                'habitual_groups', false,
                'advanced_discovery', false
            ),
            'limits', pg_catalog.jsonb_build_object(
                'ai_monthly_sessions', 0,
                'enforcement_enabled', true
            ),
            'usage', pg_catalog.jsonb_build_object(
                'consumed', 0,
                'active_reserved', 0,
                'remaining_effective', 0
            )
        );
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object(
            'plan', 'anonymous',
            'authenticated', true,
            'is_anonymous', true,
            'capabilities', pg_catalog.jsonb_build_object(
                'ai_creation', false,
                'recurring', false,
                'habitual_groups', false,
                'advanced_discovery', false
            ),
            'limits', pg_catalog.jsonb_build_object(
                'ai_monthly_sessions', 0,
                'enforcement_enabled', true
            ),
            'usage', pg_catalog.jsonb_build_object(
                'consumed', 0,
                'active_reserved', 0,
                'remaining_effective', 0
            )
        );
    END IF;

    -- Lazy initialization de perfil para cuenta permanente
    SELECT plan INTO v_plan FROM public.user_profiles WHERE user_id = v_user_id;
    IF NOT FOUND THEN
        v_plan := 'free';
        INSERT INTO public.user_profiles (user_id, plan) VALUES (v_user_id, 'free')
        ON CONFLICT (user_id) DO NOTHING;
    END IF;

    -- Consultar configuración central del plan
    SELECT ai_monthly_sessions_limit, ai_monthly_enforcement_enabled, capabilities 
    INTO v_limit, v_enforced, v_capabilities
    FROM public.plan_definitions WHERE plan = v_plan;

    -- Fail-closed si no existe configuración del plan
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'entitlements_config_unavailable'
        );
    END IF;

    v_period := pg_catalog.date_trunc('month', pg_catalog.timezone('utc', pg_catalog.now()))::date;

    -- Contar consumos confirmados del mes actual
    SELECT count(*) INTO v_consumed 
    FROM public.ai_monthly_usage
    WHERE user_id = v_user_id 
      AND period_start = v_period 
      AND state = 'consumed';

    -- Contar reservas activas vigentes (en vuelo)
    SELECT count(*) INTO v_active_reserved 
    FROM public.ai_monthly_usage
    WHERE user_id = v_user_id 
      AND period_start = v_period 
      AND state = 'reserved'
      AND reservation_expires_at > pg_catalog.timezone('utc', pg_catalog.now());

    RETURN pg_catalog.jsonb_build_object(
        'plan', v_plan,
        'authenticated', true,
        'is_anonymous', false,
        'capabilities', COALESCE(v_capabilities, '{}'::jsonb),
        'limits', pg_catalog.jsonb_build_object(
            'ai_monthly_sessions', v_limit,
            'enforcement_enabled', v_enforced
        ),
        'usage', pg_catalog.jsonb_build_object(
            'consumed', v_consumed,
            'active_reserved', v_active_reserved,
            'remaining_effective', CASE 
                WHEN v_limit IS NULL OR NOT v_enforced THEN NULL 
                ELSE GREATEST(0, v_limit - (v_consumed + v_active_reserved)) 
            END
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_entitlements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_entitlements() TO authenticated, anon;

COMMIT;
