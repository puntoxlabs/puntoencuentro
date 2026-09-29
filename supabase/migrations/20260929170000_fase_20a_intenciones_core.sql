-- ============================================================
-- Migración: 20260929170000_fase_20a_intenciones_core.sql
-- Módulo: Fase 2.0-A Intenciones — Bloque 1: Backend Core
-- ============================================================

BEGIN;

-- 1. TABLA PRINCIPAL: public.intenciones
CREATE TABLE IF NOT EXISTS public.intenciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    titulo TEXT NOT NULL,
    descripcion TEXT,
    temporalidad_texto TEXT,
    fecha_desde DATE,
    fecha_hasta DATE,
    modalidad TEXT NOT NULL DEFAULT 'presencial',
    locality_id TEXT REFERENCES public.localidades(id) ON DELETE SET NULL,
    estado TEXT NOT NULL DEFAULT 'activa',
    encuentro_id UUID REFERENCES public.encuentros(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    -- Invariantes de dominio
    CONSTRAINT check_intenciones_titulo CHECK (
        length(trim(titulo)) > 0 AND length(titulo) <= 120
    ),
    CONSTRAINT check_intenciones_modalidad CHECK (
        modalidad IN ('presencial', 'virtual', 'indistinto')
    ),
    CONSTRAINT check_intenciones_estado CHECK (
        estado IN ('activa', 'pausada', 'convertida', 'cerrada')
    ),
    CONSTRAINT check_intenciones_fechas CHECK (
        fecha_desde IS NULL OR fecha_hasta IS NULL OR fecha_desde <= fecha_hasta
    )
);

-- 2. ÍNDICES DE RENDIMIENTO
CREATE INDEX IF NOT EXISTS idx_intenciones_user_estado 
    ON public.intenciones(user_id, estado);

CREATE INDEX IF NOT EXISTS idx_intenciones_locality 
    ON public.intenciones(locality_id)
    WHERE locality_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intenciones_fechas_activas 
    ON public.intenciones(fecha_hasta)
    WHERE estado = 'activa';

-- 3. TRIGGER AUTOMÁTICO DE updated_at
DROP TRIGGER IF EXISTS trg_intenciones_updated_at ON public.intenciones;
CREATE TRIGGER trg_intenciones_updated_at
    BEFORE UPDATE ON public.intenciones
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. SEGURIDAD: ROW LEVEL SECURITY (100% PRIVADA)
ALTER TABLE public.intenciones ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.intenciones FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intenciones TO authenticated;

-- Policy estricta: un usuario autenticado sólo ve y gestiona sus propias intenciones
DROP POLICY IF EXISTS intenciones_owner_policy ON public.intenciones;
CREATE POLICY intenciones_owner_policy ON public.intenciones
    FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 5. RPC: crear_intencion_segura
CREATE OR REPLACE FUNCTION public.crear_intencion_segura(
    p_titulo TEXT,
    p_descripcion TEXT DEFAULT NULL,
    p_temporalidad_texto TEXT DEFAULT NULL,
    p_fecha_desde DATE DEFAULT NULL,
    p_fecha_hasta DATE DEFAULT NULL,
    p_modalidad TEXT DEFAULT 'presencial',
    p_locality_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_titulo_clean TEXT;
    v_modalidad_clean TEXT;
    v_new_id UUID;
BEGIN
    -- Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- Rechazar cuentas anónimas (se requiere cuenta permanente para intenciones persistentes)
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- Validar título
    v_titulo_clean := trim(COALESCE(p_titulo, ''));
    IF v_titulo_clean = '' OR length(p_titulo) > 120 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_title');
    END IF;

    -- Validar modalidad
    v_modalidad_clean := trim(COALESCE(p_modalidad, 'presencial'));
    IF v_modalidad_clean NOT IN ('presencial', 'virtual', 'indistinto') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_modality');
    END IF;

    -- Validar rango de fechas
    IF p_fecha_desde IS NOT NULL AND p_fecha_hasta IS NOT NULL AND p_fecha_desde > p_fecha_hasta THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_date_range');
    END IF;

    -- Validar localidad si fue provista
    IF p_locality_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.localidades WHERE id = p_locality_id AND activo = true) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_locality');
        END IF;
    END IF;

    -- Inserción segura con user_id derivado exclusivamente de auth.uid()
    INSERT INTO public.intenciones (
        user_id,
        titulo,
        descripcion,
        temporalidad_texto,
        fecha_desde,
        fecha_hasta,
        modalidad,
        locality_id,
        estado
    ) VALUES (
        v_user_id,
        v_titulo_clean,
        NULLIF(trim(COALESCE(p_descripcion, '')), ''),
        NULLIF(trim(COALESCE(p_temporalidad_texto, '')), ''),
        p_fecha_desde,
        p_fecha_hasta,
        v_modalidad_clean,
        p_locality_id,
        'activa'
    )
    RETURNING id INTO v_new_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_new_id);
END;
$$;

-- 6. RPC: editar_intencion_segura
CREATE OR REPLACE FUNCTION public.editar_intencion_segura(
    p_id UUID,
    p_titulo TEXT,
    p_descripcion TEXT DEFAULT NULL,
    p_temporalidad_texto TEXT DEFAULT NULL,
    p_fecha_desde DATE DEFAULT NULL,
    p_fecha_hasta DATE DEFAULT NULL,
    p_modalidad TEXT DEFAULT 'presencial',
    p_locality_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_estado_actual TEXT;
    v_titulo_clean TEXT;
    v_modalidad_clean TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_id');
    END IF;

    -- Validar existencia y pertenencia
    SELECT estado INTO v_estado_actual
    FROM public.intenciones
    WHERE id = p_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intencion_not_found');
    END IF;

    -- Estados terminales no se pueden editar
    IF v_estado_actual IN ('convertida', 'cerrada') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intencion_already_terminal');
    END IF;

    -- Validar título
    v_titulo_clean := trim(COALESCE(p_titulo, ''));
    IF v_titulo_clean = '' OR length(p_titulo) > 120 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_title');
    END IF;

    -- Validar modalidad
    v_modalidad_clean := trim(COALESCE(p_modalidad, 'presencial'));
    IF v_modalidad_clean NOT IN ('presencial', 'virtual', 'indistinto') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_modality');
    END IF;

    -- Validar rango de fechas
    IF p_fecha_desde IS NOT NULL AND p_fecha_hasta IS NOT NULL AND p_fecha_desde > p_fecha_hasta THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_date_range');
    END IF;

    -- Validar localidad si fue provista
    IF p_locality_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.localidades WHERE id = p_locality_id AND activo = true) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_locality');
        END IF;
    END IF;

    -- Actualización de contenido permitida (user_id, encuentro_id y created_at NO se modifican)
    UPDATE public.intenciones
    SET titulo = v_titulo_clean,
        descripcion = NULLIF(trim(COALESCE(p_descripcion, '')), ''),
        temporalidad_texto = NULLIF(trim(COALESCE(p_temporalidad_texto, '')), ''),
        fecha_desde = p_fecha_desde,
        fecha_hasta = p_fecha_hasta,
        modalidad = v_modalidad_clean,
        locality_id = p_locality_id,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_id AND user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id);
END;
$$;

-- 7. RPC: cambiar_estado_intencion_segura
CREATE OR REPLACE FUNCTION public.cambiar_estado_intencion_segura(
    p_id UUID,
    p_nuevo_estado TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_estado_actual TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_id');
    END IF;

    -- Transiciones permitidas en Bloque 1: 'activa', 'pausada', 'cerrada'
    -- 'convertida' sólo se permite mediante el flujo formal de handoff (Bloque 4)
    IF p_nuevo_estado = 'convertida' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'manual_conversion_not_allowed');
    END IF;

    IF p_nuevo_estado NOT IN ('activa', 'pausada', 'cerrada') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_state');
    END IF;

    -- Validar pertenencia
    SELECT estado INTO v_estado_actual
    FROM public.intenciones
    WHERE id = p_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intencion_not_found');
    END IF;

    -- Estados terminales son irreversibles
    IF v_estado_actual = 'cerrada' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intencion_already_closed');
    END IF;

    IF v_estado_actual = 'convertida' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intencion_already_converted');
    END IF;

    -- Idempotencia
    IF v_estado_actual = p_nuevo_estado THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'estado', p_nuevo_estado);
    END IF;

    -- Transiciones válidas: activa <-> pausada, activa -> cerrada, pausada -> cerrada
    UPDATE public.intenciones
    SET estado = p_nuevo_estado,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_id AND user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'estado', p_nuevo_estado);
END;
$$;

-- 8. RPC: get_mis_intenciones_seguro
CREATE OR REPLACE FUNCTION public.get_mis_intenciones_seguro()
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
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', i.id,
            'user_id', i.user_id,
            'titulo', i.titulo,
            'descripcion', i.descripcion,
            'temporalidad_texto', i.temporalidad_texto,
            'fecha_desde', i.fecha_desde,
            'fecha_hasta', i.fecha_hasta,
            'modalidad', i.modalidad,
            'locality_id', i.locality_id,
            'localidad_nombre', l.nombre,
            'localidad_ciudad', l.ciudad,
            'localidad_zona', l.zona,
            'estado', i.estado,
            'encuentro_id', i.encuentro_id,
            'created_at', i.created_at,
            'updated_at', i.updated_at
        ) ORDER BY i.created_at DESC
    ), '[]'::jsonb)
    INTO v_result
    FROM public.intenciones i
    LEFT JOIN public.localidades l ON l.id = i.locality_id
    WHERE i.user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'intenciones', v_result);
END;
$$;

-- 9. PERMISOS Y PRIVILEGIOS MÍNIMOS (GRANTS)
REVOKE ALL ON FUNCTION public.crear_intencion_segura(TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_intencion_segura(TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.editar_intencion_segura(UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.editar_intencion_segura(UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.cambiar_estado_intencion_segura(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cambiar_estado_intencion_segura(UUID, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.get_mis_intenciones_seguro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mis_intenciones_seguro() TO authenticated;

COMMIT;
