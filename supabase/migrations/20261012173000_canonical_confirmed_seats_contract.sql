-- ============================================================
-- Migración: 20261012173000_canonical_confirmed_seats_contract.sql
-- Objetivo:
--   1. Confirmar contrato canónico:
--      confirmed_seats = SUM(participantes.seat_count)
--      confirmed_requests = COUNT(participantes) (titulares)
--      available_slots = max_participants - confirmed_seats
--   2. Actualizar get_discovery_encuentros_abiertos para retornar
--      tanto confirmed_seats como confirmed_count (= SUM(seat_count)).
--   3. Actualizar get_detalle_host_seguro para retornar confirmed_seats,
--      confirmed_requests y available_slots calculados server-side.
-- ============================================================

BEGIN;

-- 1. get_discovery_encuentros_abiertos
CREATE OR REPLACE FUNCTION public.get_discovery_encuentros_abiertos(
    p_locality_ids TEXT[] DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_blocked_host_ids UUID[] := '{}';
    v_result JSON;
BEGIN
    IF v_user_id IS NOT NULL THEN
        SELECT COALESCE(pg_catalog.array_agg(DISTINCT blocked_user_id), '{}')
        INTO v_blocked_host_ids
        FROM (
            SELECT blocked_id AS blocked_user_id
            FROM public.bloqueos_usuario
            WHERE blocker_id = v_user_id
            UNION
            SELECT blocker_id AS blocked_user_id
            FROM public.bloqueos_usuario
            WHERE blocked_id = v_user_id
        ) b;
    END IF;

    SELECT pg_catalog.json_agg(row_data) INTO v_result
    FROM (
        SELECT
            e.id,
            e.open_public_title AS title,
            e.open_description AS description,
            e.fecha,
            e.hora,
            e.modalidad,
            e.max_participants AS slots,
            e.max_participants AS public_capacity,
            COALESCE(e.allow_multi_seat_requests, false) AS allow_multi_seat_requests,
            COALESCE(e.max_seats_per_request, 1) AS max_seats_per_request,
            e.locality_id,
            e.open_public_zone,
            COALESCE(e.open_public_zone, l.nombre, 'Sin zona') AS approximate_zone,
            e.host_id,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_count,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_seats,
            COALESCE(p_agg.confirmed_requests, 0) AS confirmed_requests,
            GREATEST(0, e.max_participants - COALESCE(p_agg.confirmed_seats, 0)) AS open_slots,
            CASE
                WHEN e.fecha IS NULL THEN 'Fecha a coordinar'
                ELSE pg_catalog.to_char(e.fecha, 'DD/MM/YYYY')
            END AS date_label,
            CASE
                WHEN e.hora IS NULL THEN 'Horario a coordinar'
                ELSE pg_catalog.to_char(e.hora, 'HH24:MI')
            END AS time_label,
            e.opened_at,
            e.tema,
            e.tema_invitacion,
            e.open_activity_canonical,
            e.open_activity_matching_eligible
        FROM public.encuentros e
        LEFT JOIN public.localidades l ON l.id = e.locality_id
        LEFT JOIN (
            SELECT
                encuentro_id,
                COALESCE(pg_catalog.sum(seat_count), 0)::int AS confirmed_seats,
                pg_catalog.count(*)::int AS confirmed_requests
            FROM public.participantes
            WHERE estado IN ('confirmado', 'asistio')
            GROUP BY encuentro_id
        ) p_agg ON p_agg.encuentro_id = e.id
        WHERE e.is_open = true
          AND e.moderation_status = 'approved'
          AND (
              e.fecha IS NULL
              OR e.fecha > (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::date
              OR (
                  e.fecha = (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::date
                  AND (
                      e.hora IS NULL
                      OR e.hora >= (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::time
                  )
              )
          )
          AND (
              e.host_id <> ALL(v_blocked_host_ids)
          )
          AND (
              p_locality_ids IS NULL
              OR e.locality_id = ANY(p_locality_ids)
              OR e.modalidad = 'virtual'
          )
        ORDER BY
            CASE WHEN e.fecha IS NULL THEN 1 ELSE 0 END,
            e.fecha ASC NULLS LAST,
            e.hora ASC NULLS LAST,
            e.opened_at DESC
        LIMIT 50
    ) row_data;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) TO anon, authenticated;

-- 2. get_detalle_host_seguro
CREATE OR REPLACE FUNCTION public.get_detalle_host_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats INT := 0;
    v_confirmed_requests INT := 0;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_host_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('error', 'unauthorized');
    END IF;

    SELECT
        COALESCE(pg_catalog.sum(seat_count), 0)::int,
        pg_catalog.count(*)::int
    INTO
        v_confirmed_seats,
        v_confirmed_requests
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    RETURN pg_catalog.json_build_object(
        'id', v_encuentro.id,
        'titulo', v_encuentro.titulo,
        'open_public_title', v_encuentro.open_public_title,
        'descripcion', v_encuentro.descripcion,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'lugar_texto', v_encuentro.lugar_texto,
        'link_virtual', v_encuentro.link_virtual,
        'tipo_invitacion', v_encuentro.tipo_invitacion,
        'host_id', v_encuentro.host_id,
        'public_token', v_encuentro.public_token,
        'estado', v_encuentro.estado,
        'tema', v_encuentro.tema,
        'tema_invitacion', COALESCE(v_encuentro.tema_invitacion, 'classic'),
        'invitation_template', v_encuentro.invitation_template,
        'reemplaza_a', v_encuentro.reemplaza_a,
        'creado_en', v_encuentro.creado_en,
        'is_open', COALESCE(v_encuentro.is_open, false),
        'open_description', v_encuentro.open_description,
        'max_participants', v_encuentro.max_participants,
        'public_capacity', v_encuentro.max_participants,
        'allow_multi_seat_requests', COALESCE(v_encuentro.allow_multi_seat_requests, false),
        'max_seats_per_request', COALESCE(v_encuentro.max_seats_per_request, 1),
        'confirmed_seats', v_confirmed_seats,
        'confirmed_requests', v_confirmed_requests,
        'available_slots', GREATEST(0, COALESCE(v_encuentro.max_participants, 0) - v_confirmed_seats),
        'locality_id', v_encuentro.locality_id,
        'open_public_zone', v_encuentro.open_public_zone,
        'opened_at', v_encuentro.opened_at,
        'closed_at', v_encuentro.closed_at,
        'moderation_status', v_encuentro.moderation_status
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) TO authenticated;

COMMIT;
