-- ============================================================
-- Migración: 20260929210000_fase_20c1_alertas_caso_c.sql
-- Módulo: Fase 2.0-C1 Infraestructura de Alertas + Caso C
-- Interés en Intención -> Intención convertida en Encuentro
-- ============================================================

BEGIN;

-- 1. TABLA ADITIVA: public.alertas_compatibilidad
CREATE TABLE IF NOT EXISTS public.alertas_compatibilidad (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('interes_convertido')),
    source_intencion_id UUID NOT NULL REFERENCES public.intenciones(id) ON DELETE CASCADE,
    target_encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    leida BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    CONSTRAINT uq_alertas_user_tipo_source_target UNIQUE (
        user_id,
        tipo,
        source_intencion_id,
        target_encuentro_id
    )
);

-- Índices de consulta eficiente
CREATE INDEX IF NOT EXISTS idx_alertas_user_leida_created 
    ON public.alertas_compatibilidad(user_id, leida, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alertas_source_intencion 
    ON public.alertas_compatibilidad(source_intencion_id);

CREATE INDEX IF NOT EXISTS idx_alertas_target_encuentro 
    ON public.alertas_compatibilidad(target_encuentro_id);

-- 2. SEGURIDAD Y RLS
ALTER TABLE public.alertas_compatibilidad ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.alertas_compatibilidad FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.alertas_compatibilidad TO authenticated;
GRANT ALL ON TABLE public.alertas_compatibilidad TO postgres, service_role;

DROP POLICY IF EXISTS alertas_compatibilidad_select_own ON public.alertas_compatibilidad;
CREATE POLICY alertas_compatibilidad_select_own ON public.alertas_compatibilidad
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

-- 3. ACTUALIZACIÓN DE RPC: convertir_intencion_a_encuentro
-- Preserva todas las invariantes existentes y genera alertas deduplicadas (Caso C)
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

    -- 11. Actualización atómica de la intención
    UPDATE public.intenciones
    SET estado = 'convertida',
        encuentro_id = p_encuentro_id,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_intencion_id AND user_id = v_user_id;

    -- 12. Generación atómica de alertas para usuarios interesados (Caso C)
    -- Deduplicada por UNIQUE constraint, excluyendo al propietario de la intención.
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

-- 4. RPC DE LECTURA: get_mis_alertas_seguro
-- Retorna exclusivamente DTO sanitizado con campos públicos seguros del encuentro.
-- NUNCA expone host_id, dirección exacta (lugar_texto), link_virtual privado, ni tokens privados.
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
                'is_open', e.is_open,
                'public_token', e.public_token
            )
        ) ORDER BY a.created_at DESC
    ), '[]'::jsonb)
    INTO v_result
    FROM public.alertas_compatibilidad a
    JOIN public.encuentros e ON a.target_encuentro_id = e.id
    LEFT JOIN public.localidades l ON e.locality_id = l.id
    WHERE a.user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'alertas', v_result,
        'data', v_result
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_mis_alertas_seguro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mis_alertas_seguro() TO authenticated;

-- 5. RPC DE MARCADO: marcar_alerta_leida_seguro
-- Idempotente, sólo permite marcar alertas del propio usuario.
CREATE OR REPLACE FUNCTION public.marcar_alerta_leida_seguro(
    p_alerta_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_alerta RECORD;
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

    -- 3. Validar parámetro
    IF p_alerta_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_alerta_id');
    END IF;

    -- 4. Verificar existencia y pertenencia
    SELECT id, user_id, leida
    INTO v_alerta
    FROM public.alertas_compatibilidad
    WHERE id = p_alerta_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_alerta.user_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 5. Idempotencia: si ya está leída, retornar ok sin modificar
    IF v_alerta.leida = true THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'id', p_alerta_id,
            'leida', true,
            'idempotent', true
        );
    END IF;

    -- 6. Actualización atómica
    UPDATE public.alertas_compatibilidad
    SET leida = true
    WHERE id = p_alerta_id AND user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'id', p_alerta_id,
        'leida', true,
        'idempotent', false
    );
END;
$$;

REVOKE ALL ON FUNCTION public.marcar_alerta_leida_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_alerta_leida_seguro(UUID) TO authenticated;

COMMIT;
