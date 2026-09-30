-- ============================================================
-- Migración: 20260930093500_fix_fase_20c1_alertas_open_encounter.sql
-- Módulo: Fase 2.0-C1 Micro-fix — Momento de Alerta + Privacidad DTO
-- ============================================================

BEGIN;

-- 1. LIMPIEZA DE ALERTAS PREMATURAS
-- Elimina cualquier alerta 'interes_convertido' generada previamente sobre encuentros privados (is_open = false)
DELETE FROM public.alertas_compatibilidad a
USING public.encuentros e
WHERE a.target_encuentro_id = e.id
  AND a.tipo = 'interes_convertido'
  AND e.is_open = false;

-- 2. ACTUALIZACIÓN DE RPC: convertir_intencion_a_encuentro
-- Solo genera alerta si el encuentro ya está abierto al público (is_open = true).
-- Preserva todas las invariantes de locking, estados, ownership e idempotencia.
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

    -- 2. Rechazar cuentas anónimas (se requiere cuenta permanente)
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
    SELECT id, host_id, is_open
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized_encounter');
    END IF;

    -- 11. Actualización atómica de la intención
    UPDATE public.intenciones
    SET estado = 'convertida',
        encuentro_id = p_encuentro_id,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_intencion_id AND user_id = v_user_id;

    -- 12. Generación atómica de alertas para usuarios interesados (Caso C)
    -- ÚNICAMENTE si el encuentro vinculado ya está abierto al público (is_open = true).
    -- Si es privado, la alerta se diferirá hasta su apertura formal vía abrir_encuentro_seguro.
    IF v_encuentro.is_open = true THEN
        INSERT INTO public.alertas_compatibilidad (
            user_id,
            tipo,
            source_intencion_id,
            target_encuentro_id
        )
        SELECT
            ii.user_id,
            'interes_convertido',
            p_intencion_id,
            p_encuentro_id
        FROM public.intencion_intereses ii
        WHERE ii.intencion_id = p_intencion_id
          AND ii.user_id <> v_user_id
        ON CONFLICT (user_id, tipo, source_intencion_id, target_encuentro_id) DO NOTHING;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'id', p_intencion_id,
        'encuentro_id', p_encuentro_id,
        'estado', 'convertida'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.convertir_intencion_a_encuentro(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_intencion_a_encuentro(UUID, UUID) TO authenticated;

-- 3. ACTUALIZACIÓN DE RPC: abrir_encuentro_seguro
-- Al abrir un encuentro, dispara alertas para los interesados de cualquier intención convertida vinculada.
CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT,
    p_open_public_zone TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_locality_exists BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_inactive');
    END IF;

    -- Validar localidad
    SELECT EXISTS (SELECT 1 FROM public.localidades WHERE id = p_locality_id AND activo = true)
    INTO v_locality_exists;

    IF NOT v_locality_exists THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_locality');
    END IF;

    -- Validar cupo
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado = 'confirmado';

    -- Host cuenta como 1 ocupante
    IF p_max_participants < (v_confirmed_count + 1) THEN
        RETURN json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    IF p_max_participants < 2 THEN
        RETURN json_build_object('ok', false, 'error', 'min_two_participants');
    END IF;

    -- Publicar/abrir el encuentro
    UPDATE public.encuentros
    SET is_open = true,
        open_description = NULLIF(trim(p_open_description), ''),
        max_participants = p_max_participants,
        locality_id = p_locality_id,
        open_public_zone = NULLIF(trim(p_open_public_zone), ''),
        opened_at = now(),
        closed_at = NULL
    WHERE id = p_encuentro_id;

    -- Disparar alertas para usuarios interesados en intenciones convertidas a este encuentro
    -- Deduplicado por UNIQUE constraint, excluyendo al host
    INSERT INTO public.alertas_compatibilidad (
        user_id,
        tipo,
        source_intencion_id,
        target_encuentro_id
    )
    SELECT
        ii.user_id,
        'interes_convertido',
        i.id,
        p_encuentro_id
    FROM public.intenciones i
    JOIN public.intencion_intereses ii ON ii.intencion_id = i.id
    WHERE i.encuentro_id = p_encuentro_id
      AND ii.user_id <> v_user_id
    ON CONFLICT (user_id, tipo, source_intencion_id, target_encuentro_id) DO NOTHING;

    RETURN json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'is_open', true,
        'max_participants', p_max_participants,
        'locality_id', p_locality_id,
        'open_public_zone', p_open_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    TO authenticated;

-- 4. ACTUALIZACIÓN DE RPC: get_mis_alertas_seguro
-- Elimina completamente public_token.
-- Sólo expone detalles de encuentros públicamente accesibles (is_open = true y estado = 'activo').
CREATE OR REPLACE FUNCTION public.get_mis_alertas_seguro()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_result JSONB;
BEGIN
    -- 1. Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- 2. Rechazar cuentas anónimas
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 3. Consultar alertas propias ordenadas cronológicamente (más recientes primero)
    -- Sólo expone encuentros públicamente accesibles (is_open = true y estado = 'activo')
    -- NUNCA expone public_token, host_id, lugar_texto exacto, link_virtual privado ni emails.
    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', a.id,
            'tipo', a.tipo,
            'source_intencion_id', a.source_intencion_id,
            'target_encuentro_id', a.target_encuentro_id,
            'leida', a.leida,
            'created_at', a.created_at,
            'encuentro_titulo', e.titulo,
            'encuentro_fecha', e.fecha,
            'encuentro_hora', e.hora,
            'encuentro_modalidad', e.modalidad,
            'encuentro_approximate_zone', COALESCE(e.open_public_zone, l.nombre, 'Zona aproximada'),
            'encuentro', pg_catalog.jsonb_build_object(
                'id', e.id,
                'titulo', e.titulo,
                'descripcion', COALESCE(e.open_description, e.descripcion),
                'fecha', e.fecha,
                'hora', e.hora,
                'modalidad', e.modalidad,
                'approximate_zone', COALESCE(e.open_public_zone, l.nombre, 'Zona aproximada'),
                'locality_id', e.locality_id,
                'is_open', e.is_open
            )
        ) ORDER BY a.created_at DESC
    ), '[]'::jsonb)
    INTO v_result
    FROM public.alertas_compatibilidad a
    JOIN public.encuentros e ON a.target_encuentro_id = e.id
    LEFT JOIN public.localidades l ON e.locality_id = l.id
    WHERE a.user_id = v_user_id
      AND e.is_open = true
      AND e.estado = 'activo';

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'alertas', v_result,
        'data', v_result
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_mis_alertas_seguro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mis_alertas_seguro() TO authenticated;

COMMIT;
