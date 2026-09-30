-- ============================================================
-- Migración: 20260930180000_fase_20c1_trust_contextual_unblock_contract.sql
-- Módulo: Fase 2.0-C1 Seguridad y Confianza — T3-B0
-- Contrato contextual seguro para consulta de estado y desbloqueo
-- ============================================================

BEGIN;

-- ============================================================
-- 1. RPC: get_estado_bloqueo_desde_solicitud_seguro
-- Consulta el estado del bloqueo propio derivando la contraparte server-side
-- a partir de la solicitud real. NUNCA expone datos de la contraparte ni
-- si la contraparte ha bloqueado al usuario que consulta.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_estado_bloqueo_desde_solicitud_seguro(
    p_solicitud_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_solicitud RECORD;
    v_counterparty_id UUID;
    v_blocked_by_me BOOLEAN;
BEGIN
    -- 1. Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- 2. Rechazar cuentas anónimas (se requiere cuenta permanente)
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 3. Validar parámetro
    IF p_solicitud_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    -- 4. Obtener server-side la solicitud y el encuentro vinculado
    SELECT s.id, s.usuario_id, s.encuentro_id, e.host_id
    INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto s
    JOIN public.encuentros e ON e.id = s.encuentro_id
    WHERE s.id = p_solicitud_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    -- 5. Derivar contraparte server-side validando pertenencia legítima
    IF v_user_id = v_solicitud.host_id THEN
        -- El llamador es el HOST -> la contraparte es el SOLICITANTE
        v_counterparty_id := v_solicitud.usuario_id;
    ELSIF v_user_id = v_solicitud.usuario_id THEN
        -- El llamador es el SOLICITANTE -> la contraparte es el HOST
        v_counterparty_id := v_solicitud.host_id;
    ELSE
        -- Tercero ajeno a la relación de la solicitud
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 6. Verificar EXCLUSIVAMENTE si el llamador bloqueó a la contraparte
    SELECT EXISTS (
        SELECT 1
        FROM public.bloqueos_usuario
        WHERE blocker_id = v_user_id
          AND blocked_id = v_counterparty_id
    ) INTO v_blocked_by_me;

    -- 7. Retorno mínimo sanitizado (NUNCA expone contraparte, dirección inversa ni UUIDs)
    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'blocked_by_me', v_blocked_by_me
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_estado_bloqueo_desde_solicitud_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_estado_bloqueo_desde_solicitud_seguro(UUID) TO authenticated;

-- ============================================================
-- 2. RPC: desbloquear_desde_solicitud_seguro
-- Desbloquea de forma contextual e idempotente derivando la contraparte server-side.
-- Elimina ÚNICAMENTE el bloqueo propio (blocker_id = auth.uid()).
-- Si la contraparte también había bloqueado, ese bloqueo permanece intacto.
-- ============================================================
CREATE OR REPLACE FUNCTION public.desbloquear_desde_solicitud_seguro(
    p_solicitud_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_solicitud RECORD;
    v_counterparty_id UUID;
BEGIN
    -- 1. Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- 2. Rechazar cuentas anónimas (se requiere cuenta permanente)
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 3. Validar parámetro
    IF p_solicitud_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    -- 4. Obtener server-side la solicitud y el encuentro vinculado
    SELECT s.id, s.usuario_id, s.encuentro_id, e.host_id
    INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto s
    JOIN public.encuentros e ON e.id = s.encuentro_id
    WHERE s.id = p_solicitud_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    -- 5. Derivar contraparte server-side validando pertenencia legítima
    IF v_user_id = v_solicitud.host_id THEN
        v_counterparty_id := v_solicitud.usuario_id;
    ELSIF v_user_id = v_solicitud.usuario_id THEN
        v_counterparty_id := v_solicitud.host_id;
    ELSE
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 6. Eliminar ÚNICAMENTE el bloqueo propio (idempotente)
    DELETE FROM public.bloqueos_usuario
    WHERE blocker_id = v_user_id
      AND blocked_id = v_counterparty_id;

    -- 7. Retorno mínimo sanitizado
    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'blocked', false
    );
END;
$$;

REVOKE ALL ON FUNCTION public.desbloquear_desde_solicitud_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desbloquear_desde_solicitud_seguro(UUID) TO authenticated;

COMMIT;
