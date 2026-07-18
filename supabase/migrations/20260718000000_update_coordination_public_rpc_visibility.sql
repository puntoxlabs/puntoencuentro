-- ============================================================
-- Migración: update_coordination_public_rpc_visibility
-- Propósito: Exponer mostrar_respuestas_a_invitados y conteos anónimos
-- por opción en los RPC de lectura de coordinación (público y participante).
-- NUNCA expone lista nominal de invitados.
-- ============================================================

BEGIN;

-- 1. Actualizar get_coordinacion_host_seguro
CREATE OR REPLACE FUNCTION public.get_coordinacion_host_seguro(
    p_encuentro_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_enc record;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF COALESCE((auth.jwt()->>'is_anonymous')::boolean, false) THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT * INTO v_enc FROM public.encuentros WHERE id = p_encuentro_id;
    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_enc.host_id IS DISTINCT FROM v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'not_owner');
    END IF;

    IF v_enc.date_mode IS DISTINCT FROM 'coordination' THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_date_mode');
    END IF;

    RETURN (
        WITH opc_base AS (
            SELECT id, fecha, hora_inicio, orden
            FROM public.encuentro_opciones_fecha
            WHERE encuentro_id = p_encuentro_id
        ),
        opc_count AS (
            SELECT count(*) as c FROM opc_base
        ),
        participantes_completos AS (
            SELECT p.id
            FROM public.participantes p
            JOIN public.participante_disponibilidades pd ON pd.participante_id = p.id
            JOIN opc_base ob ON pd.opcion_fecha_id = ob.id
            WHERE p.encuentro_id = p_encuentro_id
              AND pd.encuentro_id = p_encuentro_id
            GROUP BY p.id
            HAVING COUNT(*) = (SELECT c FROM opc_count)
               AND COUNT(DISTINCT pd.opcion_fecha_id) = (SELECT c FROM opc_count)
               AND (SELECT c FROM opc_count) > 0
        ),
        agg_opciones AS (
            SELECT 
                ob.id,
                ob.fecha,
                ob.hora_inicio,
                ob.orden,
                COUNT(pd.respuesta) FILTER (WHERE pd.respuesta = 'available') AS available_count,
                COUNT(pd.respuesta) FILTER (WHERE pd.respuesta = 'maybe') AS maybe_count,
                COUNT(pd.respuesta) FILTER (WHERE pd.respuesta = 'unavailable') AS unavailable_count,
                COUNT(pd.es_preferida) FILTER (WHERE pd.es_preferida = true) AS preferred_count
            FROM opc_base ob
            LEFT JOIN public.participante_disponibilidades pd 
              ON pd.opcion_fecha_id = ob.id 
             AND pd.encuentro_id = p_encuentro_id
             AND pd.participante_id IN (SELECT id FROM participantes_completos)
            GROUP BY ob.id, ob.fecha, ob.hora_inicio, ob.orden
        ),
        agg_participantes AS (
            SELECT 
                p.id,
                p.nombre_invitado,
                p.tipo_invitacion,
                p.estado,
                p.creado_en,
                (EXISTS(SELECT 1 FROM participantes_completos pc WHERE pc.id = p.id)) AS respondio_disponibilidad,
                COALESCE((
                    SELECT json_agg(
                        json_build_object(
                            'opcion_fecha_id', pd.opcion_fecha_id,
                            'respuesta', pd.respuesta,
                            'es_preferida', pd.es_preferida
                        ) ORDER BY ob_in.orden ASC
                    )
                    FROM public.participante_disponibilidades pd
                    JOIN opc_base ob_in ON ob_in.id = pd.opcion_fecha_id
                    WHERE pd.participante_id = p.id AND pd.encuentro_id = p_encuentro_id
                ), '[]'::json) AS respuestas
            FROM public.participantes p
            WHERE p.encuentro_id = p_encuentro_id
        )
        SELECT json_build_object(
            'ok', true,
            'encuentro', json_build_object(
                'id', v_enc.id,
                'titulo', v_enc.titulo,
                'descripcion', v_enc.descripcion,
                'estado', v_enc.estado,
                'modalidad', v_enc.modalidad,
                'lugar_texto', v_enc.lugar_texto,
                'link_virtual', v_enc.link_virtual,
                'tema', v_enc.tema,
                'tipo_invitacion', v_enc.tipo_invitacion,
                'tema_invitacion', COALESCE(v_enc.tema_invitacion, 'classic'),
                'invitation_template', v_enc.invitation_template,
                'public_token', v_enc.public_token,
                'duration_minutes', v_enc.duration_minutes,
                'mostrar_respuestas_a_invitados', v_enc.mostrar_respuestas_a_invitados
            ),
            'coordination_status', v_enc.coordination_status,
            'response_deadline', v_enc.response_deadline,
            'selected_option_id', v_enc.selected_option_id,
            'fecha', v_enc.fecha,
            'hora', v_enc.hora,
            'derived_status', CASE 
                WHEN v_enc.coordination_status = 'closed' THEN 'closed'
                WHEN v_enc.coordination_status = 'open' AND v_enc.response_deadline IS NOT NULL AND now() >= v_enc.response_deadline THEN 'deadline_passed'
                ELSE 'open'
            END,
            'opciones', COALESCE((SELECT json_agg(json_build_object(
                'id', ao.id, 'fecha', ao.fecha, 'hora_inicio', ao.hora_inicio, 'orden', ao.orden, 
                'selected', COALESCE(ao.id = v_enc.selected_option_id, false),
                'available_count', ao.available_count, 'maybe_count', ao.maybe_count, 
                'unavailable_count', ao.unavailable_count, 'preferred_count', ao.preferred_count
            ) ORDER BY ao.orden ASC) FROM agg_opciones ao), '[]'::json),
            'respondent_count', (SELECT count(*) FROM participantes_completos),
            'participantes', COALESCE((SELECT json_agg(json_build_object(
                'id', ap.id, 'nombre_invitado', ap.nombre_invitado, 'tipo_invitacion', ap.tipo_invitacion, 'estado', ap.estado,
                'respondio_disponibilidad', ap.respondio_disponibilidad, 'respuestas', ap.respuestas
            ) ORDER BY ap.creado_en ASC, ap.nombre_invitado ASC) FROM agg_participantes ap), '[]'::json)
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_coordinacion_host_seguro(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_host_seguro(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_host_seguro(uuid) TO postgres, service_role;

-- 2. Actualizar get_coordinacion_publica_seguro
CREATE OR REPLACE FUNCTION public.get_coordinacion_publica_seguro(
    p_public_token text
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_enc record;
    v_token_uuid uuid;
BEGIN
    BEGIN
        v_token_uuid := p_public_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_token');
    END;

    SELECT * INTO v_enc FROM public.encuentros WHERE public_token = v_token_uuid;
    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_enc.estado = 'cancelado' THEN
        RETURN json_build_object('ok', false, 'error', 'encounter_cancelled');
    END IF;

    IF v_enc.date_mode <> 'coordination' THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_date_mode');
    END IF;

    RETURN json_build_object(
        'ok', true,
        'encuentro', json_build_object(
            'titulo', v_enc.titulo,
            'descripcion', v_enc.descripcion,
            'modalidad', v_enc.modalidad,
            'lugar_texto', v_enc.lugar_texto,
            'tipo_invitacion', v_enc.tipo_invitacion,
            'tema', v_enc.tema,
            'estado', v_enc.estado,
            'tema_invitacion', COALESCE(v_enc.tema_invitacion, 'classic'),
            'invitation_template', v_enc.invitation_template,
            'duration_minutes', v_enc.duration_minutes
        ),
        'coordination_status', v_enc.coordination_status,
        'response_deadline', v_enc.response_deadline,
        'selected_option_id', v_enc.selected_option_id,
        'fecha', v_enc.fecha,
        'hora', v_enc.hora,
        'mostrar_respuestas_a_invitados', v_enc.mostrar_respuestas_a_invitados,
        'derived_status', CASE 
            WHEN v_enc.coordination_status = 'closed' THEN 'closed'
            WHEN v_enc.coordination_status = 'open' AND v_enc.response_deadline IS NOT NULL AND now() >= v_enc.response_deadline THEN 'deadline_passed'
            ELSE 'open'
        END,
        'opciones', (
            SELECT COALESCE(json_agg(json_build_object(
                'id', o.id,
                'fecha', o.fecha,
                'hora_inicio', o.hora_inicio,
                'orden', o.orden,
                'selected', COALESCE(o.id = v_enc.selected_option_id, false),
                'available_count', CASE WHEN v_enc.mostrar_respuestas_a_invitados = true THEN COALESCE(agg.available_count, 0) ELSE 0 END,
                'maybe_count', CASE WHEN v_enc.mostrar_respuestas_a_invitados = true THEN COALESCE(agg.maybe_count, 0) ELSE 0 END,
                'unavailable_count', CASE WHEN v_enc.mostrar_respuestas_a_invitados = true THEN COALESCE(agg.unavailable_count, 0) ELSE 0 END,
                'preferred_count', CASE WHEN v_enc.mostrar_respuestas_a_invitados = true THEN COALESCE(agg.preferred_count, 0) ELSE 0 END
            ) ORDER BY o.orden), '[]'::json)
            FROM public.encuentro_opciones_fecha o
            LEFT JOIN (
                SELECT
                    pd.opcion_fecha_id,
                    COUNT(*) FILTER (WHERE pd.respuesta = 'available') AS available_count,
                    COUNT(*) FILTER (WHERE pd.respuesta = 'maybe') AS maybe_count,
                    COUNT(*) FILTER (WHERE pd.respuesta = 'unavailable') AS unavailable_count,
                    COUNT(*) FILTER (WHERE pd.es_preferida = true) AS preferred_count
                FROM public.participante_disponibilidades pd
                WHERE pd.encuentro_id = v_enc.id
                GROUP BY pd.opcion_fecha_id
            ) agg ON agg.opcion_fecha_id = o.id
            WHERE o.encuentro_id = v_enc.id
        )
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_coordinacion_publica_seguro(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_publica_seguro(text) TO anon, authenticated;

-- 3. Actualizar get_coordinacion_participante_seguro
CREATE OR REPLACE FUNCTION public.get_coordinacion_participante_seguro(
    p_token text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_token_uuid uuid;
    v_participante record;
    v_enc record;
BEGIN
    IF p_token IS NULL OR trim(p_token) = '' THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    BEGIN
        v_token_uuid := p_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_token');
    END;

    SELECT * INTO v_participante FROM public.participantes WHERE token_invitacion = v_token_uuid;
    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    SELECT * INTO v_enc FROM public.encuentros WHERE id = v_participante.encuentro_id;
    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_enc.estado = 'cancelado' THEN
        RETURN json_build_object('ok', false, 'error', 'encounter_cancelled');
    END IF;

    IF v_enc.date_mode IS DISTINCT FROM 'coordination' THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_date_mode');
    END IF;

    RETURN (
        WITH opc_base AS (
            SELECT id, fecha, hora_inicio, orden
            FROM public.encuentro_opciones_fecha
            WHERE encuentro_id = v_enc.id
        ),
        opc_count AS (
            SELECT count(*) as c FROM opc_base
        ),
        resp_count AS (
            SELECT count(DISTINCT pd.opcion_fecha_id) as c
            FROM public.participante_disponibilidades pd
            JOIN opc_base ob ON ob.id = pd.opcion_fecha_id
            WHERE pd.participante_id = v_participante.id
              AND pd.encuentro_id = v_enc.id
        )
        SELECT json_build_object(
            'ok', true,
            'encuentro', json_build_object(
                'id', v_enc.id,
                'titulo', v_enc.titulo,
                'descripcion', v_enc.descripcion,
                'estado', v_enc.estado,
                'modalidad', v_enc.modalidad,
                'lugar_texto', v_enc.lugar_texto,
                'tema', v_enc.tema,
                'tipo_invitacion', v_enc.tipo_invitacion,
                'tema_invitacion', COALESCE(v_enc.tema_invitacion, 'classic'),
                'invitation_template', v_enc.invitation_template,
                'duration_minutes', v_enc.duration_minutes
            ),
            'participante', json_build_object(
                'id', v_participante.id,
                'nombre_invitado', v_participante.nombre_invitado,
                'tipo_invitacion', v_participante.tipo_invitacion,
                'estado', v_participante.estado,
                'mensaje_respuesta', v_participante.mensaje_respuesta,
                'respondio_disponibilidad', ((SELECT c FROM opc_count) > 0 AND (SELECT c FROM resp_count) = (SELECT c FROM opc_count) AND (SELECT count(*) FROM public.participante_disponibilidades pd JOIN opc_base ob ON ob.id = pd.opcion_fecha_id WHERE pd.participante_id = v_participante.id AND pd.encuentro_id = v_enc.id) = (SELECT c FROM opc_count))
            ),
            'coordination_status', v_enc.coordination_status,
            'response_deadline', v_enc.response_deadline,
            'selected_option_id', v_enc.selected_option_id,
            'fecha', v_enc.fecha,
            'hora', v_enc.hora,
            'mostrar_respuestas_a_invitados', v_enc.mostrar_respuestas_a_invitados,
            'derived_status', CASE 
                WHEN v_enc.coordination_status = 'closed' THEN 'closed'
                WHEN v_enc.coordination_status = 'open' AND v_enc.response_deadline IS NOT NULL AND now() >= v_enc.response_deadline THEN 'deadline_passed'
                ELSE 'open'
            END,
            'opciones', (
                SELECT COALESCE(json_agg(json_build_object(
                    'id', o.id,
                    'fecha', o.fecha,
                    'hora_inicio', o.hora_inicio,
                    'orden', o.orden,
                    'selected', COALESCE(o.id = v_enc.selected_option_id, false),
                    'respuesta', pd.respuesta,
                    'es_preferida', pd.es_preferida,
                    'available_count', CASE WHEN v_enc.mostrar_respuestas_a_invitados = true THEN COALESCE(agg.available_count, 0) ELSE 0 END,
                    'maybe_count', CASE WHEN v_enc.mostrar_respuestas_a_invitados = true THEN COALESCE(agg.maybe_count, 0) ELSE 0 END,
                    'unavailable_count', CASE WHEN v_enc.mostrar_respuestas_a_invitados = true THEN COALESCE(agg.unavailable_count, 0) ELSE 0 END,
                    'preferred_count', CASE WHEN v_enc.mostrar_respuestas_a_invitados = true THEN COALESCE(agg.preferred_count, 0) ELSE 0 END
                ) ORDER BY o.orden), '[]'::json)
                FROM opc_base o
                LEFT JOIN public.participante_disponibilidades pd 
                  ON pd.opcion_fecha_id = o.id AND pd.participante_id = v_participante.id AND pd.encuentro_id = v_enc.id
                LEFT JOIN (
                    SELECT
                        pd_agg.opcion_fecha_id,
                        COUNT(*) FILTER (WHERE pd_agg.respuesta = 'available') AS available_count,
                        COUNT(*) FILTER (WHERE pd_agg.respuesta = 'maybe') AS maybe_count,
                        COUNT(*) FILTER (WHERE pd_agg.respuesta = 'unavailable') AS unavailable_count,
                        COUNT(*) FILTER (WHERE pd_agg.es_preferida = true) AS preferred_count
                    FROM public.participante_disponibilidades pd_agg
                    WHERE pd_agg.encuentro_id = v_enc.id
                    GROUP BY pd_agg.opcion_fecha_id
                ) agg ON agg.opcion_fecha_id = o.id
            )
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_coordinacion_participante_seguro(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_participante_seguro(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_participante_seguro(text) TO postgres, service_role;

COMMIT;
