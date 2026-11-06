-- ============================================================
-- Migración Aditiva: RPC get_encuentro_abierto_publico
-- Archivo: 20261106175000_open_encounters_social_sharing_v1.sql
-- Mini-sprint: Difusión social de Encuentros Abiertos
-- Provee consulta pública autorizada por UUID sin límite de paginación
-- Garantiza estrictamente las invariantes de moderación, vigencia y privacidad
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_encuentro_abierto_publico(p_encuentro_id uuid)
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
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_id');
    END IF;

    -- 1. Si el usuario está autenticado, obtener bloqueos bilaterales
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

    -- 2. Consultar encuentro abierto con todas las invariantes de Discovery
    SELECT pg_catalog.row_to_json(row_data) INTO v_result
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
            COALESCE(e.min_seats_per_request, 1) AS min_seats_per_request,
            e.min_participants,
            COALESCE(e.realization_status, 'pending') AS realization_status,
            COALESCE(e.inscriptions_closed, false) AS inscriptions_closed,
            (v_user_id IS NOT NULL AND e.host_id = v_user_id) AS is_host,
            e.locality_id,
            e.open_public_zone,
            COALESCE(e.open_public_zone, l.nombre, CASE WHEN e.modalidad = 'virtual' THEN 'Online' ELSE 'Sin zona' END) AS approximate_zone,
            e.host_id,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_count,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_seats,
            COALESCE(p_agg.confirmed_requests, 0) AS confirmed_requests,
            COALESCE(w_agg.reserved_seats, 0) AS reserved_waitlist_seats,
            COALESCE(w_agg.waiting_count, 0) AS waitlist_count,
            GREATEST(0, e.max_participants - (COALESCE(p_agg.confirmed_seats, 0) + COALESCE(w_agg.reserved_seats, 0))) AS open_slots,
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
        LEFT JOIN (
            SELECT
                encuentro_id,
                COALESCE(pg_catalog.sum(CASE WHEN estado IN ('waitlist_offered', 'waitlist_confirmed') THEN seat_count ELSE 0 END), 0)::int AS reserved_seats,
                COALESCE(pg_catalog.sum(CASE WHEN estado = 'waitlist_waiting' THEN 1 ELSE 0 END), 0)::int AS waiting_count
            FROM public.solicitudes_encuentro_abierto
            WHERE estado IN ('waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
            GROUP BY encuentro_id
        ) w_agg ON w_agg.encuentro_id = e.id
        WHERE e.id = p_encuentro_id
          AND e.is_open = true
          AND e.estado <> 'cancelado'
          AND e.moderation_status = 'approved'
          -- Invariante 1: No vencido en hora Argentina
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
          -- Invariante 2: Bloqueo bilateral
          AND (v_user_id IS NULL OR e.host_id <> ALL(v_blocked_host_ids))
        LIMIT 1
    ) row_data;

    IF v_result IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    RETURN pg_catalog.json_build_object('ok', true, 'data', v_result);
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_abierto_publico(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentro_abierto_publico(uuid) TO anon, authenticated, postgres, service_role;

COMMIT;
