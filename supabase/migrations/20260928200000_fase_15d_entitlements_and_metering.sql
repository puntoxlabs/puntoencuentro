-- ============================================================
-- Migración: 20260928200000_fase_15d_entitlements_and_metering.sql
-- Módulo: Encuentros Abiertos 1.5-D — Planes, Entitlements y Metering IA
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLA: public.user_profiles
-- Lazy initialization server-side únicamente para cuentas permanentes.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'premium', 'organizer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now())
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON public.user_profiles;
CREATE POLICY "Users can view own profile" 
    ON public.user_profiles 
    FOR SELECT 
    TO authenticated 
    USING (auth.uid() = user_id);

-- Restricción total de mutación directa para clientes
REVOKE INSERT, UPDATE, DELETE ON public.user_profiles FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.user_profiles TO authenticated;
GRANT ALL ON public.user_profiles TO service_role;

-- ============================================================
-- 2. TABLA: public.plan_definitions
-- Configuración centralizada de capacidades y límites sin números comerciales embebidos.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.plan_definitions (
    plan TEXT PRIMARY KEY CHECK (plan IN ('free', 'premium', 'organizer')),
    ai_monthly_sessions_limit INT, -- NULLABLE: null indica sin límite o no configurado
    ai_monthly_enforcement_enabled BOOLEAN NOT NULL DEFAULT true,
    max_active_open_encounters INT,
    capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now())
);

ALTER TABLE public.plan_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read plan definitions" ON public.plan_definitions;
CREATE POLICY "Anyone can read plan definitions" 
    ON public.plan_definitions 
    FOR SELECT 
    TO authenticated, anon 
    USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.plan_definitions FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.plan_definitions TO authenticated, anon;
GRANT ALL ON public.plan_definitions TO service_role;

-- ============================================================
-- 3. ADITIVO: public.ai_creation_sessions
-- Extender para turns durables, actividad y lease in-flight anti-concurrencia.
-- ============================================================
ALTER TABLE public.ai_creation_sessions 
    ADD COLUMN IF NOT EXISTS last_interaction_at TIMESTAMPTZ DEFAULT pg_catalog.timezone('utc', pg_catalog.now()) NOT NULL,
    ADD COLUMN IF NOT EXISTS processing_lease_id UUID,
    ADD COLUMN IF NOT EXISTS processing_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ai_creation_sessions_lease 
    ON public.ai_creation_sessions(processing_expires_at) 
    WHERE processing_expires_at IS NOT NULL;

-- ============================================================
-- 4. TABLA: public.ai_monthly_usage
-- Ledger comercial de consumo mensual (ON DELETE RESTRICT para proteger historial).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_monthly_usage (
    session_id UUID PRIMARY KEY REFERENCES public.ai_creation_sessions(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    reservation_expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    release_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_monthly_usage_user_period 
    ON public.ai_monthly_usage(user_id, period_start);

ALTER TABLE public.ai_monthly_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own usage" ON public.ai_monthly_usage;
CREATE POLICY "Users can view own usage" 
    ON public.ai_monthly_usage 
    FOR SELECT 
    TO authenticated 
    USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.ai_monthly_usage FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.ai_monthly_usage TO authenticated;
GRANT ALL ON public.ai_monthly_usage TO service_role;

-- ============================================================
-- 5. RPC: get_my_entitlements
-- Centraliza capacidades del usuario, consumo efectivo y límites.
-- ============================================================
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
                ELSE pg_catalog.greatest(0, v_limit - (v_consumed + v_active_reserved)) 
            END
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_entitlements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_entitlements() TO authenticated, anon;

-- ============================================================
-- 6. RPC: check_and_reserve_ai_session
-- Inicia/acopla turno, adquiere lease in-flight y reserva cupo mensual.
-- Invocada por userClient (usa auth.uid()).
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_and_reserve_ai_session(
    p_session_id UUID,
    p_lease_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_plan TEXT;
    v_limit INT;
    v_enforced BOOLEAN;
    v_capabilities JSONB;
    v_period DATE;
    v_active_count INT;
    v_session_status TEXT;
    v_turns INT;
    v_existing_state TEXT;
    v_existing_expires TIMESTAMPTZ;
    v_lease_id UUID;
    v_lease_expires TIMESTAMPTZ;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'permanent_account_required');
    END IF;

    IF p_session_id IS NULL OR p_lease_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'invalid_parameters');
    END IF;

    -- Serialización transaccional estricta por usuario
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_user_id::text || '_ai_quota'));

    -- 1. Verificar binding y estado durable de la sesión
    SELECT status, turns, processing_lease_id, processing_expires_at 
    INTO v_session_status, v_turns, v_lease_id, v_lease_expires
    FROM public.ai_creation_sessions 
    WHERE id = p_session_id;

    IF FOUND THEN
        -- Validación de pertenencia exclusiva
        IF NOT EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE id = p_session_id AND user_id = v_user_id) THEN
            RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'unauthorized_session_access');
        END IF;

        -- Estados terminales inmutables
        IF v_session_status IN ('completed', 'abandoned', 'error', 'fallback_manual') THEN
            RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'session_already_terminal');
        END IF;

        -- Límite durable de turnos
        IF v_turns >= 20 THEN
            RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'session_limit_reached');
        END IF;

        -- Control de lease in-flight (evita doble llamada simultánea en la misma sesión)
        IF v_lease_expires IS NOT NULL AND v_lease_expires > pg_catalog.timezone('utc', pg_catalog.now()) AND v_lease_id IS DISTINCT FROM p_lease_id THEN
            RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'ai_session_busy');
        END IF;

        -- Adquirir/renovar lease (TTL de 60s)
        UPDATE public.ai_creation_sessions
        SET processing_lease_id = p_lease_id,
            processing_expires_at = pg_catalog.timezone('utc', pg_catalog.now()) + interval '60 seconds',
            last_interaction_at = pg_catalog.timezone('utc', pg_catalog.now())
        WHERE id = p_session_id;
    ELSE
        -- Registrar nueva sesión iniciada con lease
        INSERT INTO public.ai_creation_sessions (
            id, 
            user_id, 
            status, 
            turns, 
            processing_lease_id, 
            processing_expires_at, 
            last_interaction_at
        ) VALUES (
            p_session_id, 
            v_user_id, 
            'started', 
            0, 
            p_lease_id, 
            pg_catalog.timezone('utc', pg_catalog.now()) + interval '60 seconds',
            pg_catalog.timezone('utc', pg_catalog.now())
        );
    END IF;

    -- 2. Inspeccionar estado en el ledger comercial
    SELECT state, reservation_expires_at 
    INTO v_existing_state, v_existing_expires 
    FROM public.ai_monthly_usage 
    WHERE session_id = p_session_id;

    IF FOUND THEN
        IF v_existing_state = 'consumed' THEN
            -- Sesión ya consumida previamente: permitir interacción sin descontar cuota nueva
            RETURN pg_catalog.jsonb_build_object('allowed', true, 'already_consumed', true);
        ELSIF v_existing_state = 'reserved' THEN
            -- Verificar si la reserva sigue vigente o si expiró
            IF v_existing_expires > pg_catalog.timezone('utc', pg_catalog.now()) THEN
                RETURN pg_catalog.jsonb_build_object('allowed', true, 'already_reserved', true);
            ELSE
                -- Reserva expirada por crash previo: marcar released y permitir re-reserva limpia
                UPDATE public.ai_monthly_usage
                SET state = 'released',
                    released_at = pg_catalog.timezone('utc', pg_catalog.now()),
                    release_reason = 'reservation_expired'
                WHERE session_id = p_session_id;
                v_existing_state := 'released';
            END IF;
        END IF;
    END IF;

    -- 3. Obtener plan y validar entitlements
    SELECT plan INTO v_plan FROM public.user_profiles WHERE user_id = v_user_id;
    IF NOT FOUND THEN
        v_plan := 'free';
        INSERT INTO public.user_profiles (user_id, plan) VALUES (v_user_id, 'free')
        ON CONFLICT (user_id) DO NOTHING;
    END IF;

    SELECT ai_monthly_sessions_limit, ai_monthly_enforcement_enabled, capabilities 
    INTO v_limit, v_enforced, v_capabilities
    FROM public.plan_definitions WHERE plan = v_plan;

    -- Fail-closed si falta configuración
    IF NOT FOUND THEN
        UPDATE public.ai_creation_sessions 
        SET processing_lease_id = NULL, processing_expires_at = NULL 
        WHERE id = p_session_id;
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'entitlements_config_unavailable');
    END IF;

    -- Validar capability explícita
    IF COALESCE((v_capabilities ->> 'ai_creation')::boolean, false) IS NOT TRUE THEN
        UPDATE public.ai_creation_sessions 
        SET processing_lease_id = NULL, processing_expires_at = NULL 
        WHERE id = p_session_id;
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'ai_creation_not_available');
    END IF;

    -- Si el plan tiene enforcement desactivado: permitir sin bloquear, pero manteniendo metering
    IF NOT v_enforced THEN
        v_period := pg_catalog.date_trunc('month', pg_catalog.timezone('utc', pg_catalog.now()))::date;
        INSERT INTO public.ai_monthly_usage (
            session_id, user_id, period_start, state, reserved_at, reservation_expires_at
        ) VALUES (
            p_session_id, v_user_id, v_period, 'reserved', pg_catalog.timezone('utc', pg_catalog.now()), pg_catalog.timezone('utc', pg_catalog.now()) + interval '3 minutes'
        )
        ON CONFLICT (session_id) DO UPDATE SET
            period_start = v_period,
            state = 'reserved',
            reservation_expires_at = pg_catalog.timezone('utc', pg_catalog.now()) + interval '3 minutes',
            released_at = NULL,
            release_reason = NULL;

        RETURN pg_catalog.jsonb_build_object('allowed', true, 'already_reserved', false, 'enforcement_disabled', true);
    END IF;

    -- 4. Enforcement de límite mensual
    IF v_limit IS NULL THEN
        UPDATE public.ai_creation_sessions 
        SET processing_lease_id = NULL, processing_expires_at = NULL 
        WHERE id = p_session_id;
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'entitlements_config_unavailable');
    END IF;

    v_period := pg_catalog.date_trunc('month', pg_catalog.timezone('utc', pg_catalog.now()))::date;

    -- Limpieza pasiva de reservas expiradas del usuario
    UPDATE public.ai_monthly_usage
    SET state = 'released',
        released_at = pg_catalog.timezone('utc', pg_catalog.now()),
        release_reason = 'reservation_expired'
    WHERE user_id = v_user_id
      AND state = 'reserved'
      AND reservation_expires_at <= pg_catalog.timezone('utc', pg_catalog.now());

    -- Conteo de consumos y reservas vigentes del mes
    SELECT count(*) INTO v_active_count 
    FROM public.ai_monthly_usage
    WHERE user_id = v_user_id 
      AND period_start = v_period 
      AND (state = 'consumed' OR (state = 'reserved' AND reservation_expires_at > pg_catalog.timezone('utc', pg_catalog.now())));

    IF v_active_count >= v_limit THEN
        -- Limpiar lease adquirido
        UPDATE public.ai_creation_sessions 
        SET processing_lease_id = NULL, processing_expires_at = NULL 
        WHERE id = p_session_id;

        RETURN pg_catalog.jsonb_build_object(
            'allowed', false,
            'error', 'ai_monthly_limit_reached',
            'limit', v_limit,
            'used', v_active_count
        );
    END IF;

    -- 5. Crear o actualizar reserva en el ledger (atribuida al mes UTC actual)
    INSERT INTO public.ai_monthly_usage (
        session_id,
        user_id,
        period_start,
        state,
        reserved_at,
        reservation_expires_at
    ) VALUES (
        p_session_id,
        v_user_id,
        v_period,
        'reserved',
        pg_catalog.timezone('utc', pg_catalog.now()),
        pg_catalog.timezone('utc', pg_catalog.now()) + interval '3 minutes'
    )
    ON CONFLICT (session_id) DO UPDATE SET
        period_start = v_period,
        state = 'reserved',
        reserved_at = pg_catalog.timezone('utc', pg_catalog.now()),
        reservation_expires_at = pg_catalog.timezone('utc', pg_catalog.now()) + interval '3 minutes',
        released_at = NULL,
        release_reason = NULL,
        consumed_at = NULL;

    RETURN pg_catalog.jsonb_build_object('allowed', true, 'already_reserved', false);
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_reserve_ai_session(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_and_reserve_ai_session(UUID, UUID) TO authenticated;

-- ============================================================
-- 7. RPC INTERNA: internal_finalize_ai_session_consumption
-- Valida lease y estado reserved -> consumed. Incrementa turn durable.
-- Privilegio restringido: EXCLUSIVAMENTE service_role.
-- ============================================================
CREATE OR REPLACE FUNCTION public.internal_finalize_ai_session_consumption(
    p_user_id UUID,
    p_session_id UUID,
    p_lease_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_usage_state TEXT;
BEGIN
    -- Validar existencia y ownership de la sesión
    IF NOT EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE id = p_session_id AND user_id = p_user_id) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'session_not_found');
    END IF;

    -- Validar estado en ledger
    SELECT state INTO v_usage_state 
    FROM public.ai_monthly_usage 
    WHERE session_id = p_session_id AND user_id = p_user_id;

    IF v_usage_state IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'no_reservation_found');
    ELSIF v_usage_state = 'consumed' THEN
        -- Idempotente: ya consumida
        NULL;
    ELSIF v_usage_state = 'reserved' THEN
        UPDATE public.ai_monthly_usage
        SET state = 'consumed',
            consumed_at = pg_catalog.timezone('utc', pg_catalog.now())
        WHERE session_id = p_session_id AND user_id = p_user_id;
    ELSE
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_usage_state_transition');
    END IF;

    -- Incrementar turn durable y limpiar lease
    UPDATE public.ai_creation_sessions
    SET turns = turns + 1,
        processing_lease_id = NULL,
        processing_expires_at = NULL,
        last_interaction_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_session_id AND user_id = p_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.internal_finalize_ai_session_consumption(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.internal_finalize_ai_session_consumption(UUID, UUID, UUID) TO service_role;

-- ============================================================
-- 8. RPC INTERNA: internal_release_ai_session_reservation
-- Libera reserva (reserved -> released) y limpia lease.
-- Privilegio restringido: EXCLUSIVAMENTE service_role.
-- ============================================================
CREATE OR REPLACE FUNCTION public.internal_release_ai_session_reservation(
    p_user_id UUID,
    p_session_id UUID,
    p_lease_id UUID,
    p_reason TEXT DEFAULT 'provider_failure'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_usage_state TEXT;
BEGIN
    -- Validar existencia y ownership de la sesión
    IF NOT EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE id = p_session_id AND user_id = p_user_id) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'session_not_found');
    END IF;

    SELECT state INTO v_usage_state 
    FROM public.ai_monthly_usage 
    WHERE session_id = p_session_id AND user_id = p_user_id;

    IF v_usage_state = 'reserved' THEN
        UPDATE public.ai_monthly_usage
        SET state = 'released',
            released_at = pg_catalog.timezone('utc', pg_catalog.now()),
            release_reason = p_reason
        WHERE session_id = p_session_id AND user_id = p_user_id;
    END IF;

    -- Limpiar lease in-flight
    UPDATE public.ai_creation_sessions
    SET processing_lease_id = NULL,
        processing_expires_at = NULL,
        last_interaction_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_session_id AND user_id = p_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.internal_release_ai_session_reservation(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.internal_release_ai_session_reservation(UUID, UUID, UUID, TEXT) TO service_role;

-- ============================================================
-- 9. RPC INTERNA: internal_record_ai_session_turn
-- Para turnos válidos que no consumen cuota nueva (off_topic o sesión ya consumida).
-- Incrementa turn durable y limpia lease.
-- Privilegio restringido: EXCLUSIVAMENTE service_role.
-- ============================================================
CREATE OR REPLACE FUNCTION public.internal_record_ai_session_turn(
    p_user_id UUID,
    p_session_id UUID,
    p_lease_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE public.ai_creation_sessions
    SET turns = turns + 1,
        processing_lease_id = NULL,
        processing_expires_at = NULL,
        last_interaction_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_session_id AND user_id = p_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.internal_record_ai_session_turn(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.internal_record_ai_session_turn(UUID, UUID, UUID) TO service_role;

-- ============================================================
-- 10. RPC: complete_ai_creation_session
-- Cierra formalmente la sesión asociándola al encuentro creado.
-- Invocada por el frontend tras la creación exitosa del encuentro.
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_ai_creation_session(
    p_session_id UUID,
    p_encounter_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- Validar que la sesión existe y pertenece al usuario
    IF NOT EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE id = p_session_id AND user_id = v_user_id) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'session_not_found');
    END IF;

    -- Validar que el encuentro existe y el usuario es su host
    IF p_encounter_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.encuentros WHERE id = p_encounter_id AND host_id = v_user_id) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_ownership_mismatch');
        END IF;
    END IF;

    UPDATE public.ai_creation_sessions
    SET status = 'completed',
        encounter_id = p_encounter_id,
        completed_at = pg_catalog.timezone('utc', pg_catalog.now()),
        last_interaction_at = pg_catalog.timezone('utc', pg_catalog.now()),
        processing_lease_id = NULL,
        processing_expires_at = NULL
    WHERE id = p_session_id AND user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_ai_creation_session(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_ai_creation_session(UUID, UUID) TO authenticated;

COMMIT;
