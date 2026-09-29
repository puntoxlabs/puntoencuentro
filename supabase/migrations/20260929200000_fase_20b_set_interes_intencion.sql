-- ============================================================
-- Migración: 20260929200000_fase_20b_set_interes_intencion.sql
-- Módulo: Fase 2.0-B Discovery Unificado — Bloque 2
-- Interés social idempotente sobre intenciones
-- ============================================================

BEGIN;

-- RPC: set_interes_intencion
-- Permite a un usuario con cuenta permanente expresar o retirar interés de forma idempotente.
CREATE OR REPLACE FUNCTION public.set_interes_intencion(
    p_intencion_id UUID,
    p_interesado BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_intencion RECORD;
    v_count INT;
BEGIN
    -- 1. Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- 2. Rechazar cuentas anónimas (se requiere cuenta permanente para interactuar socialmente)
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 3. Validar parámetros requeridos
    IF p_intencion_id IS NULL OR p_interesado IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    -- 4. Verificar intención objetivo (existencia, estado y vigencia temporal según Argentina)
    SELECT id, user_id, estado, fecha_hasta
    INTO v_intencion
    FROM public.intenciones
    WHERE id = p_intencion_id;

    IF NOT FOUND 
       OR v_intencion.estado <> 'activa'
       OR NOT (
           v_intencion.fecha_hasta IS NULL 
           OR v_intencion.fecha_hasta >= (pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
       ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intention_not_found_or_inactive');
    END IF;

    -- 5. Interés propio: El autor no puede marcar interés en su propia intención
    IF v_intencion.user_id = v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_interest_own_intention');
    END IF;

    -- 6. Operación idempotente
    IF p_interesado = true THEN
        INSERT INTO public.intencion_intereses (
            intencion_id,
            user_id
        )
        VALUES (
            p_intencion_id,
            v_user_id
        )
        ON CONFLICT (intencion_id, user_id)
        DO NOTHING;
    ELSE
        DELETE FROM public.intencion_intereses
        WHERE intencion_id = p_intencion_id
          AND user_id = v_user_id;
    END IF;

    -- 7. Calcular conteo final posterior a la operación
    SELECT COALESCE(pg_catalog.count(*)::int, 0)
    INTO v_count
    FROM public.intencion_intereses
    WHERE intencion_id = p_intencion_id;

    -- 8. Retorno estructurado
    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'interesado', p_interesado,
        'interested_count', v_count
    );
END;
$$;

-- Privilegios: Ejecutable únicamente por usuarios autenticados
REVOKE ALL ON FUNCTION public.set_interes_intencion(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_interes_intencion(UUID, BOOLEAN) TO authenticated;

COMMIT;
