-- ============================================================
-- Migración: 20261001120000_local_first_mar_del_plata_zones.sql
-- Módulo: Local-First Mar del Plata — Catálogo de Macrozonas + Hardening Activo
-- ============================================================

BEGIN;

-- 1. ACTUALIZACIÓN DE MACROZONAS EXISTENTES DE MAR DEL PLATA
UPDATE public.localidades
SET nombre = 'Centro / La Perla',
    orden = 1,
    activo = true,
    ciudad = 'Mar del Plata',
    zona = 'Costa Atlántica',
    pais = 'AR'
WHERE id = 'centro';

UPDATE public.localidades
SET nombre = 'Güemes / Playa Grande',
    orden = 2,
    activo = true,
    ciudad = 'Mar del Plata',
    zona = 'Costa Atlántica',
    pais = 'AR'
WHERE id = 'guemes';

UPDATE public.localidades
SET nombre = 'Plaza Mitre / Chauvín',
    orden = 3,
    activo = true,
    ciudad = 'Mar del Plata',
    zona = 'Costa Atlántica',
    pais = 'AR'
WHERE id = 'mitre';

UPDATE public.localidades
SET nombre = 'Constitución / Norte',
    orden = 4,
    activo = true,
    ciudad = 'Mar del Plata',
    zona = 'Costa Atlántica',
    pais = 'AR'
WHERE id = 'constitucion';

-- 2. DESACTIVAR 'costa' (PRESERVAR FILA E HISTORIAL)
UPDATE public.localidades
SET activo = false
WHERE id = 'costa';

-- 3. INSERTAR NUEVAS MACROZONAS DE MAR DEL PLATA
INSERT INTO public.localidades (id, nombre, ciudad, zona, pais, orden, activo)
VALUES
    ('puerto-mogotes', 'Puerto / Punta Mogotes', 'Mar del Plata', 'Costa Atlántica', 'AR', 5, true),
    ('sur-playas-del-sur', 'Sur / Playas del Sur', 'Mar del Plata', 'Costa Atlántica', 'AR', 6, true)
ON CONFLICT (id) DO UPDATE SET
    nombre = EXCLUDED.nombre,
    ciudad = EXCLUDED.ciudad,
    zona = EXCLUDED.zona,
    pais = EXCLUDED.pais,
    orden = EXCLUDED.orden,
    activo = EXCLUDED.activo;

-- 4. DESACTIVAR LOCALIDADES DE BUENOS AIRES PARA SOFT LAUNCH LOCAL-FIRST
UPDATE public.localidades
SET activo = false
WHERE id IN ('palermo', 'belgrano', 'caballito', 'vicente-lopez', 'villa-urquiza');

-- ============================================================
-- 5. HARDENING: get_user_localidades_seguro
-- Solo entrega localidades activas, ignorando preferencias stale
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_localidades_seguro(
    p_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_result JSON;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_user_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN '[]'::json;
    END IF;

    SELECT json_agg(ul.locality_id) INTO v_result
    FROM public.usuario_localidades ul
    JOIN public.localidades l ON ul.locality_id = l.id
    WHERE ul.user_id = v_user_id
      AND l.activo = true;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_localidades_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_localidades_seguro(UUID) TO anon, authenticated;

-- ============================================================
-- 6. HARDENING: get_discovery_encuentros_abiertos
-- Excluye estrictamente encuentros en localidades inactivas
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_discovery_encuentros_abiertos(
    p_locality_ids TEXT[] DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_viewer_id UUID := auth.uid();
    v_result JSON;
BEGIN
    SELECT json_agg(enc_row) INTO v_result
    FROM (
        SELECT
            e.id,
            e.titulo AS title,
            CASE
                WHEN e.tema_invitacion = 'sports' THEN '🎾'
                WHEN e.tema_invitacion = 'friends' THEN '🍻'
                WHEN e.tema_invitacion = 'celebration' THEN '🎉'
                WHEN e.tema_invitacion = 'family' THEN '👨‍👩‍👦'
                WHEN e.tema_invitacion = 'learning' THEN '📚'
                WHEN e.tema_invitacion = 'wellness' THEN '🧘'
                WHEN e.tema_invitacion = 'romantic' THEN '🍷'
                ELSE '✨'
            END AS emoji,
            COALESCE(e.tema_invitacion, 'social') AS activity_type,
            CASE
                WHEN e.fecha IS NOT NULL AND e.hora IS NOT NULL THEN
                    to_char(e.fecha, 'YYYY-MM-DD') || 'T' || to_char(e.hora, 'HH24:MI:SS')
                ELSE
                    to_char(e.creado_en, 'YYYY-MM-DD"T"HH24:MI:SS')
            END AS starts_at,
            CASE
                WHEN e.fecha IS NOT NULL AND e.hora IS NOT NULL THEN
                    to_char(e.fecha, 'DD/MM') || ' · ' || to_char(e.hora, 'HH24:MI') || ' hs'
                WHEN e.date_mode = 'coordination' THEN
                    'Fecha por coordinar'
                ELSE
                    'A convenir'
            END AS date_label,
            COALESCE(e.open_public_zone, l.nombre, 'Zona aproximada') AS approximate_zone,
            e.locality_id,
            GREATEST(0, e.max_participants - (1 + COALESCE(part_counts.confirmed, 0))) AS open_slots,
            (1 + COALESCE(part_counts.confirmed, 0)) AS confirmed_count,
            'es' AS language,
            e.open_description AS description,
            COALESCE(e.opened_at, e.creado_en) AS opened_at
        FROM public.encuentros e
        JOIN public.localidades l ON e.locality_id = l.id
        LEFT JOIN (
            SELECT encuentro_id, COUNT(*) AS confirmed
            FROM public.participantes
            WHERE estado = 'confirmado'
            GROUP BY encuentro_id
        ) part_counts ON part_counts.encuentro_id = e.id
        WHERE e.is_open = true
          AND e.estado = 'activo'
          AND l.activo = true
          -- Filtrar si venció
          AND (
              e.fecha IS NULL
              OR e.hora IS NULL
              OR (e.fecha + e.hora) >= (CURRENT_DATE - INTERVAL '1 day')
          )
          -- Filtrar por localidades si se proveyeron (deben coincidir y ser activas)
          AND (
              p_locality_ids IS NULL
              OR array_length(p_locality_ids, 1) IS NULL
              OR e.locality_id = ANY(p_locality_ids)
          )
          -- Filtrar bloqueos bilaterales si el viewer está autenticado
          AND (
              v_viewer_id IS NULL
              OR NOT EXISTS (
                  SELECT 1 FROM public.bloqueos_usuario b
                  WHERE (b.blocker_id = v_viewer_id AND b.blocked_id = e.host_id)
                     OR (b.blocker_id = e.host_id AND b.blocked_id = v_viewer_id)
              )
          )
        ORDER BY e.opened_at DESC, e.creado_en DESC
    ) enc_row;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) TO anon, authenticated;

-- ============================================================
-- 7. HARDENING: get_discovery_intenciones_activas
-- Excluye intenciones presenciales asociadas a localidades inactivas
-- ============================================================
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
      -- Excluir presenciales asociadas a localidades inactivas
      AND (
          i.modalidad = 'virtual'
          OR i.locality_id IS NULL
          OR l.activo = true
      )
      -- Filtrar por localidades si se proveyeron
      AND (
          p_locality_ids IS NULL
          OR pg_catalog.array_length(p_locality_ids, 1) IS NULL
          OR i.modalidad = 'virtual'
          OR (i.locality_id = ANY(p_locality_ids) AND l.activo = true)
      )
      -- Filtrar bloqueos bilaterales si el viewer está autenticado
      AND (
          v_viewer_id IS NULL
          OR NOT EXISTS (
              SELECT 1 FROM public.bloqueos_usuario b
              WHERE (b.blocker_id = v_viewer_id AND b.blocked_id = i.user_id)
                 OR (b.blocker_id = i.user_id AND b.blocked_id = v_viewer_id)
          )
      );

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) TO anon, authenticated;

COMMIT;
