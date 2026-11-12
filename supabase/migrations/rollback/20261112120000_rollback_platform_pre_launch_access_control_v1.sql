-- ==============================================================================
-- Script de Reversión Quirúrgico (Rollback Funcional): Etapa 1 Pre-Launch Access Control
-- Timestamp de origen: 20261112120000
-- Archivo: 20261112120000_rollback_platform_pre_launch_access_control_v1.sql
--
-- PRINCIPIOS DE SEGURIDAD EN ROLLBACK:
-- 1. NUNCA reabrir el acceso al público externo durante PRE-LAUNCH.
--    La reversión de lógica procedimental DEBE preservar el bloqueo de backend.
-- 2. Restablece quirúrgicamente las 7 RPCs a sus cuerpos de negocio funcionales preexistentes,
--    pero incorporando la guarda directa fail-closed 'is_qa_authorized()'.
-- 3. Distinción de perfiles:
--    - Clientes sin JWT: reciben [] o error de autenticación.
--    - Sesiones anónimas externas (no en QA): bloqueadas.
--    - Testers autorizados en QA: operan normalmente con la lógica restablecida.
-- 4. Elimina de forma limpia las entidades auxiliares agregadas (platform_launch_authorizations,
--    platform_access_control_audit, platform_access_control).
-- ==============================================================================

BEGIN;

-- 1. Restablecer get_discovery_encuentros_abiertos con guarda PRE-LAUNCH fail-closed
CREATE OR REPLACE FUNCTION public.get_discovery_encuentros_abiertos(
    p_locality_ids TEXT[] DEFAULT NULL,
    p_only_available BOOLEAN DEFAULT false
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
    -- GUARDA PRE-LANZAMIENTO FAIL-CLOSED DE ROLLBACK:
    -- Si no es un usuario autorizado de QA, bloquea el descubrimiento público en pre-lanzamiento
    IF NOT public.is_qa_authorized() THEN
        RETURN '[]'::json;
    END IF;

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
            COALESCE(e.min_seats_per_request, 1) AS min_seats_per_request,
            e.min_participants,
            COALESCE(e.realization_status, 'pending') AS realization_status,
            COALESCE(e.inscriptions_closed, false) AS inscriptions_closed,
            (v_user_id IS NOT NULL AND e.host_id = v_user_id) AS is_host,
            e.locality_id,
            e.open_public_zone,
            COALESCE(e.open_public_zone, l.nombre, 'Sin zona') AS approximate_zone,
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
        WHERE e.is_open = true
          AND e.estado <> 'cancelado'
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
          AND (p_locality_ids IS NULL OR e.locality_id = ANY(p_locality_ids))
          AND (v_user_id IS NULL OR e.host_id <> ALL(v_blocked_host_ids))
          AND (
              NOT p_only_available
              OR (e.max_participants - (COALESCE(p_agg.confirmed_seats, 0) + COALESCE(w_agg.reserved_seats, 0))) > 0
          )
        ORDER BY
            CASE WHEN e.fecha IS NULL THEN 1 ELSE 0 END,
            e.fecha ASC NULLS LAST,
            e.hora ASC NULLS LAST,
            e.opened_at DESC,
            e.id ASC
        LIMIT 50
    ) row_data;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) TO anon, authenticated, postgres, service_role;


-- 2. Restablecer get_discovery_intenciones_activas con guarda PRE-LAUNCH fail-closed
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
    IF NOT public.is_qa_authorized() THEN
        RETURN '[]'::jsonb;
    END IF;

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
          i.modalidad = 'virtual'
          OR i.locality_id IS NULL
          OR l.activo = true
      )
      AND (
          p_locality_ids IS NULL
          OR pg_catalog.array_length(p_locality_ids, 1) IS NULL
          OR i.modalidad = 'virtual'
          OR (i.locality_id = ANY(p_locality_ids) AND l.activo = true)
      )
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
GRANT EXECUTE ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) TO anon, authenticated, postgres, service_role;


-- 3. Restablecer get_encuentro_abierto_publico con guarda PRE-LAUNCH fail-closed
CREATE OR REPLACE FUNCTION public.get_encuentro_abierto_publico(p_encuentro_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_blocked_host_ids UUID[] := '{}';
    v_result JSON;
BEGIN
    IF NOT public.is_qa_authorized() THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'pre_launch_restricted');
    END IF;

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


-- 4. Restablecer crear_encuentro_seguro con guarda PRE-LAUNCH fail-closed
CREATE OR REPLACE FUNCTION public.crear_encuentro_seguro(p_data jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id          uuid := auth.uid();
    v_is_anon          boolean := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_id               uuid;
    v_token            uuid;
    v_result           json;
    v_tema_invitacion  text;
    v_post_minutes     integer;
    v_post_raw         text;
    v_rl               jsonb;
    v_priv_eval        record;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- GUARDA PRE-LANZAMIENTO FAIL-CLOSED:
    -- Solo usuarios autorizados de QA pueden crear encuentros durante el pre-lanzamiento.
    IF NOT public.is_qa_authorized() THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'pre_launch_creation_restricted',
            'message', 'La creación de encuentros está restringida a usuarios de pruebas autorizados durante el pre-lanzamiento.'
        );
    END IF;

    IF v_is_anon THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('pe_identity_mutation:' || v_user_id::text)
        );
        IF public.is_retired_anonymous_source(v_user_id) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
        END IF;
    END IF;

    v_id    := COALESCE((p_data->>'id')::uuid, gen_random_uuid());
    v_token := COALESCE((p_data->>'public_token')::uuid, gen_random_uuid());

    IF p_data ? 'tipo_invitacion' AND (p_data->>'tipo_invitacion') = 'link_general' THEN
        SELECT * INTO v_priv_eval FROM public.evaluar_antiabuso_privado_determinista(p_data->>'titulo', p_data->>'descripcion');
        IF NOT v_priv_eval.allowed THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'private_content_blocked',
                'reason', v_priv_eval.reason,
                'message', 'El contenido de la invitación no cumple con las pautas de seguridad de la plataforma.'
            );
        END IF;
    END IF;

    v_tema_invitacion := CASE
        WHEN p_data->>'tema_invitacion' IN (
            'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
            'family', 'special', 'romantic', 'sports', 'entertainment',
            'learning', 'wellness', 'custom'
        )
        THEN p_data->>'tema_invitacion'
        ELSE 'classic'
    END;

    v_post_raw := p_data->>'post_event_active_minutes';
    IF v_post_raw IS NOT NULL THEN
        BEGIN
            v_post_minutes := v_post_raw::integer;
        EXCEPTION WHEN OTHERS THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END;
        IF v_post_minutes < 0 OR v_post_minutes > 1440 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END IF;
    ELSE
        v_post_minutes := 45;
    END IF;

    v_rl := public.check_rate_limit_internal('create_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    INSERT INTO public.encuentros (
        id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, link_virtual,
        tipo_invitacion, host_id, public_token, estado, tema, tema_invitacion,
        invitation_template, post_event_active_minutes
    )
    VALUES (
        v_id,
        p_data->>'titulo',
        p_data->>'descripcion',
        (p_data->>'fecha')::date,
        (p_data->>'hora')::time,
        p_data->>'modalidad',
        p_data->>'lugar_texto',
        p_data->>'link_virtual',
        p_data->>'tipo_invitacion',
        v_user_id,
        v_token,
        'activo',
        'blue',
        v_tema_invitacion,
        p_data->>'invitation_template',
        v_post_minutes
    )
    RETURNING
        pg_catalog.json_build_object(
            'ok', true,
            'id', id,
            'public_token', public_token
        ) INTO v_result;

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.crear_encuentro_seguro(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_seguro(jsonb) TO anon, authenticated, postgres, service_role;


-- 5. Restablecer solicitar_sumarse_encuentro_abierto con guarda PRE-LAUNCH fail-closed
CREATE OR REPLACE FUNCTION public.solicitar_sumarse_encuentro_abierto(
    p_encuentro_id uuid,
    p_nombre_solicitante text,
    p_seat_count integer DEFAULT 1
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_enc RECORD;
    v_confirmed_seats INT := 0;
    v_available_slots INT := 0;
    v_waitlist_assigned_seats INT := 0;
    v_new_sol_id UUID;
    v_rl JSONB;
    v_seats INT := COALESCE(p_seat_count, 1);
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- GUARDA PRE-LANZAMIENTO FAIL-CLOSED
    IF NOT public.is_qa_authorized() THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'pre_launch_restricted');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF v_seats < 1 THEN
        v_seats := 1;
    END IF;

    v_rl := public.check_rate_limit_internal('solicitar_sumarse', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    SELECT * INTO v_enc
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF v_enc.id IS NULL OR v_enc.is_open = false OR v_enc.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_available');
    END IF;

    IF v_enc.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'host_cannot_join');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario
        WHERE (blocker_id = v_user_id AND blocked_id = v_enc.host_id)
           OR (blocker_id = v_enc.host_id AND blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'user_blocked');
    END IF;

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id
      AND estado IN ('confirmado', 'asistio');

    SELECT COALESCE(pg_catalog.sum(CASE WHEN estado IN ('waitlist_offered', 'waitlist_confirmed') THEN seat_count ELSE 0 END), 0)::int
    INTO v_waitlist_assigned_seats
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND estado IN ('waitlist_offered', 'waitlist_confirmed');

    v_available_slots := GREATEST(0, v_enc.max_participants - (v_confirmed_seats + v_waitlist_assigned_seats));

    INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id, user_id, nombre_solicitante, estado, seat_count
    ) VALUES (
        p_encuentro_id, v_user_id, pg_catalog.btrim(COALESCE(p_nombre_solicitante, 'Participante')), 'pendiente', v_seats
    )
    RETURNING id INTO v_new_sol_id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'solicitud_id', v_new_sol_id,
        'status', 'pendiente',
        'available_slots', v_available_slots
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(uuid, text, integer) TO authenticated, postgres, service_role;


-- 6. Restablecer submit_coverage_request con guarda PRE-LAUNCH fail-closed
CREATE OR REPLACE FUNCTION public.submit_coverage_request(
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION,
    p_market_slug TEXT DEFAULT NULL,
    p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_request_id UUID;
BEGIN
    IF NOT public.is_qa_authorized() THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'pre_launch_restricted');
    END IF;

    IF p_lat IS NULL OR p_lng IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_coordinates');
    END IF;

    INSERT INTO public.coverage_expansion_requests (
        user_id, lat, lng, market_slug, note
    ) VALUES (
        v_user_id, p_lat, p_lng, p_market_slug, p_note
    )
    RETURNING id INTO v_request_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_coverage_request(DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_coverage_request(DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT) TO anon, authenticated, postgres, service_role;


-- 7. Restablecer abrir_encuentro_seguro con guarda PRE-LAUNCH fail-closed
CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id uuid,
    p_data jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_enc RECORD;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF NOT public.is_qa_authorized() THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'pre_launch_restricted');
    END IF;

    SELECT * INTO v_enc
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF v_enc.id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_enc.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    UPDATE public.encuentros
    SET is_open = true,
        open_public_title = COALESCE(p_data->>'open_public_title', titulo),
        open_description = COALESCE(p_data->>'open_description', descripcion),
        opened_at = pg_catalog.now()
    WHERE id = p_encuentro_id;

    RETURN pg_catalog.json_build_object('ok', true, 'id', p_encuentro_id);
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(uuid, jsonb) TO authenticated, postgres, service_role;


-- 8. ELIMINAR FUNCIONES Y ENTIDADES DE CONTROL DE APERTURA (PRESERVANDO IS_QA_AUTHORIZED)
DROP FUNCTION IF EXISTS public.set_platform_launch_phase(BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.can_access_pre_launch();
DROP FUNCTION IF EXISTS public.is_public_launch_open();
DROP TABLE IF EXISTS public.platform_launch_authorizations CASCADE;
DROP TRIGGER IF EXISTS trg_protect_platform_access_control_audit ON public.platform_access_control_audit;
DROP TRIGGER IF EXISTS trg_protect_platform_access_control_audit_truncate ON public.platform_access_control_audit;
DROP FUNCTION IF EXISTS public.prevent_platform_audit_tampering();
DROP TABLE IF EXISTS public.platform_access_control_audit CASCADE;
DROP TABLE IF EXISTS public.platform_access_control CASCADE;

COMMIT;
