-- Migración: 20261013220000_host_encounters_canonical_slots_contract.sql
-- Propósito: Exponer confirmed_seats y available_slots en get_encuentros_host_seguro y get_counts_participantes_host_seguro
--            para asegurar consistencia semántica exacta en la card del Host dentro de "Mi espacio -> Mis encuentros".

BEGIN;

-- 1. Actualizar get_encuentros_host_seguro para incluir confirmed_seats y available_slots
CREATE OR REPLACE FUNCTION public.get_encuentros_host_seguro(
    p_host_ids uuid[] DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid;
    v_result  json;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('error', 'unauthenticated');
    END IF;

    SELECT pg_catalog.json_agg(
        pg_catalog.json_build_object(
            'id',              e.id,
            'titulo',          e.titulo,
            'open_public_title', e.open_public_title,
            'descripcion',     e.descripcion,
            'open_description', e.open_description,
            'fecha',           e.fecha,
            'hora',            e.hora,
            'modalidad',       e.modalidad,
            'lugar_texto',     e.lugar_texto,
            'link_virtual',    e.link_virtual,
            'tipo_invitacion', e.tipo_invitacion,
            'host_id',         e.host_id,
            'public_token',    e.public_token,
            'estado',          e.estado,
            'tema',            e.tema,
            'reemplaza_a',     e.reemplaza_a,
            'creado_en',       e.creado_en,
            'tema_invitacion',     e.tema_invitacion,
            'invitation_template', e.invitation_template,
            'date_mode',           e.date_mode,
            'coordination_status', e.coordination_status,
            'response_deadline',   e.response_deadline,
            'duration_minutes',    e.duration_minutes,
            'selected_option_id',  e.selected_option_id,
            'is_open',             COALESCE(e.is_open, false),
            'max_participants',    e.max_participants,
            'confirmed_seats',     (
                SELECT COALESCE(pg_catalog.sum(p.seat_count), 0)::int
                FROM public.participantes p
                WHERE p.encuentro_id = e.id AND p.estado = 'confirmado'
            ),
            'available_slots',     GREATEST(0, COALESCE(e.max_participants, 0) - (
                SELECT COALESCE(pg_catalog.sum(p.seat_count), 0)::int
                FROM public.participantes p
                WHERE p.encuentro_id = e.id AND p.estado = 'confirmado'
            )),
            'pending_requests_count', (
                SELECT pg_catalog.count(*)::int
                FROM public.solicitudes_encuentro_abierto s
                WHERE s.encuentro_id = e.id AND s.estado = 'pending'
            ),
            'option_count',        (
                SELECT pg_catalog.count(*)
                FROM public.encuentro_opciones_fecha o
                WHERE o.encuentro_id = e.id
            ),
            'post_event_active_minutes', COALESCE(e.post_event_active_minutes, 45),
            'last_option_at',            (
                SELECT MAX(
                    (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                )
                FROM public.encuentro_opciones_fecha o
                WHERE o.encuentro_id = e.id
            ),
            'has_future_options',        (
                EXISTS (
                    SELECT 1
                    FROM public.encuentro_opciones_fecha o
                    WHERE o.encuentro_id = e.id
                      AND (
                          (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                          + pg_catalog.make_interval(mins => COALESCE(e.duration_minutes, e.post_event_active_minutes, 45))
                      ) >= pg_catalog.now()
                )
            )
        )
        ORDER BY e.creado_en DESC
    )
    INTO v_result
    FROM public.encuentros e
    WHERE e.host_id = v_user_id;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentros_host_seguro(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentros_host_seguro(uuid[]) TO authenticated;

-- 2. Actualizar get_counts_participantes_host_seguro para incluir confirmed_seats y available_slots
CREATE OR REPLACE FUNCTION public.get_counts_participantes_host_seguro(p_encuentro_ids uuid[])
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_counts json;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN '{}'::json;
    END IF;

    IF p_encuentro_ids IS NULL OR array_length(p_encuentro_ids, 1) = 0 THEN
        RETURN '{}'::json;
    END IF;

    SELECT COALESCE(pg_catalog.json_object_agg(
        encuentro_id,
        pg_catalog.json_build_object(
            'total', total,
            'confirmados', confirmados,
            'confirmed_seats', confirmed_seats,
            'available_slots', GREATEST(0, COALESCE(max_participants, 0) - confirmed_seats)
        )
    ), '{}'::json) INTO v_counts
    FROM (
        SELECT 
            p.encuentro_id,
            e.max_participants,
            pg_catalog.count(*) as total,
            SUM(CASE WHEN p.estado = 'confirmado' THEN 1 ELSE 0 END)::int as confirmados,
            SUM(CASE WHEN p.estado = 'confirmado' THEN COALESCE(p.seat_count, 1) ELSE 0 END)::int as confirmed_seats
        FROM public.participantes p
        JOIN public.encuentros e ON p.encuentro_id = e.id
        WHERE p.encuentro_id = ANY(p_encuentro_ids)
          AND e.host_id = v_user_id
        GROUP BY p.encuentro_id, e.max_participants
    ) counts_agrupados;

    RETURN v_counts;
END;
$$;

REVOKE ALL ON FUNCTION public.get_counts_participantes_host_seguro(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_counts_participantes_host_seguro(uuid[]) TO authenticated;

COMMIT;
