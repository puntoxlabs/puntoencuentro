-- ============================================================
-- Migración: 20260929180000_fase_20a_intenciones_conversion.sql
-- Módulo: Fase 2.0-A Intenciones — Bloque 4: Intención -> Encuentro
-- ============================================================

BEGIN;

-- RPC: convertir_intencion_a_encuentro
CREATE OR REPLACE FUNCTION public.convertir_intencion_a_encuentro(
    p_intencion_id UUID,
    p_encuentro_id UUID
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
    v_encuentro RECORD;
BEGIN
    -- 1. Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- 2. Rechazar cuentas anónimas (se requiere cuenta permanente para intenciones y encuentros persistentes)
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 3. Validar parámetros requeridos
    IF p_intencion_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_intencion_id');
    END IF;

    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_encuentro_id');
    END IF;

    -- 4. Obtener y bloquear intención para concurrencia atómica
    SELECT id, user_id, estado, encuentro_id
    INTO v_intencion
    FROM public.intenciones
    WHERE id = p_intencion_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 5. Validar propiedad de la intención
    IF v_intencion.user_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 6. Idempotencia: si ya está convertida a este mismo encuentro
    IF v_intencion.estado = 'convertida' AND v_intencion.encuentro_id = p_encuentro_id THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'id', p_intencion_id,
            'encuentro_id', p_encuentro_id,
            'estado', 'convertida',
            'idempotent', true
        );
    END IF;

    -- 7. Si está convertida a otro encuentro, rechazar
    IF v_intencion.estado = 'convertida' AND v_intencion.encuentro_id IS DISTINCT FROM p_encuentro_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'already_converted');
    END IF;

    -- 8. Si está cerrada, rechazar
    IF v_intencion.estado = 'cerrada' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intention_closed');
    END IF;

    -- 9. Sólo se puede convertir si está 'activa' o 'pausada'
    IF v_intencion.estado NOT IN ('activa', 'pausada') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_state');
    END IF;

    -- 10. Validar existencia y propiedad del encuentro
    SELECT id, host_id
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized_encounter');
    END IF;

    -- 11. Actualización atómica
    UPDATE public.intenciones
    SET estado = 'convertida',
        encuentro_id = p_encuentro_id,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_intencion_id AND user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'id', p_intencion_id,
        'encuentro_id', p_encuentro_id,
        'estado', 'convertida'
    );
END;
$$;

-- Permisos mínimos
REVOKE ALL ON FUNCTION public.convertir_intencion_a_encuentro(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_intencion_a_encuentro(UUID, UUID) TO authenticated;

COMMIT;
