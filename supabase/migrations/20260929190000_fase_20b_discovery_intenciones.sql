-- ============================================================
-- Migración: 20260929190000_fase_20b_discovery_intenciones.sql
-- Módulo: Fase 2.0-B Discovery Unificado — Bloque 1
-- Infraestructura de lectura pública de Intenciones
-- ============================================================

BEGIN;

-- 1. TABLA ADITIVA: public.intencion_intereses
-- Registra interés social ("A mí también me interesa") sobre intenciones activas.
CREATE TABLE IF NOT EXISTS public.intencion_intereses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intencion_id UUID NOT NULL REFERENCES public.intenciones(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    CONSTRAINT uq_intencion_intereses UNIQUE (intencion_id, user_id)
);

-- Índices necesarios para conteo y consulta por intención y usuario
CREATE INDEX IF NOT EXISTS idx_intencion_intereses_intencion_id 
    ON public.intencion_intereses(intencion_id);

CREATE INDEX IF NOT EXISTS idx_intencion_intereses_user_id 
    ON public.intencion_intereses(user_id);

-- 2. SEGURIDAD Y RLS DE intencion_intereses
-- La tabla NO es una API pública directa. anon no puede leer identidades de interesados.
ALTER TABLE public.intencion_intereses ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.intencion_intereses FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.intencion_intereses TO authenticated;

DROP POLICY IF EXISTS intencion_intereses_select_own ON public.intencion_intereses;
CREATE POLICY intencion_intereses_select_own ON public.intencion_intereses
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

-- 3. RPC PÚBLICA DE DISCOVERY: get_discovery_intenciones_activas
-- Devuelve exclusivamente el DTO público sanitizado de intenciones activas.
-- NUNCA expone user_id, encuentro_id, updated_at, ni datos de perfil.
CREATE OR REPLACE FUNCTION public.get_discovery_intenciones_activas(
    p_locality_ids TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_viewer_id UUID := auth.uid();
    v_is_anon BOOLEAN := (v_viewer_id IS NULL) OR COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_result JSONB;
BEGIN
    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', i.id,
            'titulo', i.titulo,
            'descripcion', i.descripcion,
            'temporalidad_texto', i.temporalidad_texto,
            'fecha_desde', i.fecha_desde,
            'fecha_hasta', i.fecha_hasta,
            'modalidad', i.modalidad,
            'locality_id', i.locality_id,
            'approximate_zone', COALESCE(l.nombre, 'Zona aproximada'),
            'interested_count', COALESCE((
                SELECT pg_catalog.count(*)::int
                FROM public.intencion_intereses ii
                WHERE ii.intencion_id = i.id
            ), 0),
            'created_at', i.created_at,
            'is_own', CASE WHEN v_is_anon THEN false ELSE (i.user_id = v_viewer_id) END,
            'viewer_interested', CASE WHEN v_is_anon THEN false ELSE EXISTS(
                SELECT 1
                FROM public.intencion_intereses ii
                WHERE ii.intencion_id = i.id AND ii.user_id = v_viewer_id
            ) END
        ) ORDER BY i.created_at DESC
    ), '[]'::jsonb)
    INTO v_result
    FROM public.intenciones i
    LEFT JOIN public.localidades l ON l.id = i.locality_id
    WHERE i.estado = 'activa'
      AND (
          i.fecha_hasta IS NULL
          OR i.fecha_hasta >= (pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      )
      AND (
          p_locality_ids IS NULL
          OR pg_catalog.array_length(p_locality_ids, 1) IS NULL
          OR i.modalidad = 'virtual'
          OR i.locality_id = ANY(p_locality_ids)
      );

    RETURN v_result;
END;
$$;

-- 4. PRIVILEGIOS: Ejecutable por anon y authenticated
REVOKE ALL ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) TO anon, authenticated;

COMMIT;
