-- ============================================================
-- Migración: fix_coordination_expired_state
-- Propósito: Corregir la inconsistencia funcional en coordinaciones
--            donde todas las opciones vencieron pero el encuentro no
--            tiene fecha confirmada ("coordinación finalizada sin fecha").
--
-- Cambios:
--   1. get_encuentros_host_seguro
--      → has_future_options usa COALESCE(duration_minutes, post_event_active_minutes, 45)
--
--   2. get_encuentros_participados_seguro
--      → has_future_options usa COALESCE(duration_minutes, post_event_active_minutes, 45)
--
--   3. get_coordinacion_host_seguro
--      → derived_status agrega 'expired_unconfirmed' (prioridad sobre deadline_passed)
--      → is_confirmable por opción en el array de opciones
--
--   4. get_coordinacion_publica_seguro
--      → derived_status agrega 'expired_unconfirmed'
--      → is_confirmable por opción
--
--   5. get_coordinacion_participante_seguro
--      → derived_status agrega 'expired_unconfirmed'
--      → is_confirmable por opción
--
--   6. cerrar_coordinacion_seguro
--      → Valida que la opción seleccionada no esté vencida
--        antes de confirmar (error: option_already_expired)
--
--   7. crear_disponibilidad_coordinacion_publica_seguro
--      → Bloquea si coordinación está expired_unconfirmed
--        (error: coordination_already_expired)
--        Precedencia: closed → expired_unconfirmed → deadline_passed
--
--   8. guardar_disponibilidad_coordinacion_participante_seguro
--      → Igual que #7
--
-- Expresión temporal canónica (option_end):
--   (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
--   + make_interval(mins => COALESCE(e.duration_minutes, e.post_event_active_minutes, 45))
--
--   Vencida: option_end < now()
--   Vigente/confirmable: option_end >= now()
--
-- Precedencia de derived_status:
--   1. 'closed'              → coordination_status = 'closed'
--   2. 'expired_unconfirmed' → open + todas opciones vencidas + selected_option_id IS NULL
--   3. 'deadline_passed'     → open + response_deadline vencido
--   4. 'open'               → resto
--
-- PRESERVADO EN CADA RPC:
--   - Firma y tipos de parámetros
--   - Tipo de retorno
--   - SECURITY DEFINER
--   - SET search_path
--   - Validaciones de auth, ownership, cancelado, date_mode, coordination_status
--   - Todos los campos de respuesta existentes
--   - Todos los grants y revokes
-- ============================================================

BEGIN;

-- ============================================================
-- 1. get_encuentros_host_seguro
--    Cambio ÚNICO: COALESCE(e.post_event_active_minutes, 45)
--    → COALESCE(e.duration_minutes, e.post_event_active_minutes, 45)
--    PRESERVA: todos los campos, filtros, orden, grants
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_encuentros_host_seguro(
    p_host_ids uuid[]
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
    v_result json;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'not_authenticated'
        );
    END IF;

    IF p_host_ids IS NULL
       OR array_length(p_host_ids, 1) IS NULL
    THEN
        RETURN '[]'::json;
    END IF;

    IF array_length(p_host_ids, 1) > 5 THEN
        RETURN json_build_object(
            'error', 'too_many_host_ids'
        );
    END IF;

    SELECT json_agg(
        json_build_object(
            'id',              e.id,
            'titulo',          e.titulo,
            'descripcion',     e.descripcion,
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
            'option_count',        (
                SELECT count(*)
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
            -- MODIFICADO: usa COALESCE(duration_minutes, post_event_active_minutes, 45)
            'has_future_options',        (
                EXISTS (
                    SELECT 1
                    FROM public.encuentro_opciones_fecha o
                    WHERE o.encuentro_id = e.id
                      AND (
                          (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                          + make_interval(mins => COALESCE(e.duration_minutes, e.post_event_active_minutes, 45))
                      ) >= now()
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
$function$;

REVOKE ALL ON FUNCTION public.get_encuentros_host_seguro(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentros_host_seguro(uuid[]) TO authenticated;


-- ============================================================
-- 2. get_encuentros_participados_seguro
--    Cambio ÚNICO: has_future_options usa COALESCE(duration_minutes, ...)
--    PRESERVA: _mi_estado, _mi_mensaje, _mi_token_invitacion,
--              lógica WHERE de participados coordinados, todos los demás campos
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_encuentros_participados_seguro()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid;
    v_result  json;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('error', 'unauthenticated');
    END IF;

    SELECT json_agg(
        json_build_object(
            'id',                    e.id,
            'titulo',                e.titulo,
            'descripcion',           e.descripcion,
            'fecha',                 e.fecha,
            'hora',                  e.hora,
            'modalidad',             e.modalidad,
            'lugar_texto',           e.lugar_texto,
            'link_virtual',          e.link_virtual,
            'tipo_invitacion',       e.tipo_invitacion,
            'host_id',               e.host_id,
            'public_token',          e.public_token,
            'reemplaza_a',           e.reemplaza_a,
            'estado',                e.estado,
            'tema',                  e.tema,
            'tema_invitacion',       COALESCE(e.tema_invitacion, 'classic'),
            'invitation_template',   e.invitation_template,
            'creado_en',             e.creado_en,
            'date_mode',             e.date_mode,
            'coordination_status',   e.coordination_status,
            'response_deadline',     e.response_deadline,
            'duration_minutes',      e.duration_minutes,
            'selected_option_id',    e.selected_option_id,
            '_mi_estado',            p.estado,
            '_mi_mensaje',           p.mensaje_respuesta,
            '_mi_token_invitacion',  p.token_invitacion,
            'post_event_active_minutes', COALESCE(e.post_event_active_minutes, 45),
            'last_option_at',            (
                SELECT MAX(
                    (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                )
                FROM public.encuentro_opciones_fecha o
                WHERE o.encuentro_id = e.id
            ),
            -- MODIFICADO: usa COALESCE(duration_minutes, post_event_active_minutes, 45)
            'has_future_options',        (
                EXISTS (
                    SELECT 1
                    FROM public.encuentro_opciones_fecha o
                    WHERE o.encuentro_id = e.id
                      AND (
                          (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                          + make_interval(mins => COALESCE(e.duration_minutes, e.post_event_active_minutes, 45))
                      ) >= now()
                )
            )
        )
        ORDER BY e.creado_en DESC
    )
    INTO v_result
    FROM participantes p
    JOIN encuentros e ON e.id = p.encuentro_id
    WHERE p.user_id = v_user_id
      AND (
          p.estado IN ('confirmado', 'rechazado')
          OR (
              e.date_mode = 'coordination'
              AND EXISTS (
                  SELECT 1 FROM public.participante_disponibilidades pd
                  WHERE pd.participante_id = p.id
                    AND pd.encuentro_id = e.id
              )
          )
      );

    RETURN COALESCE(v_result, '[]'::json);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_encuentros_participados_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentros_participados_seguro() TO authenticated;


-- ============================================================
-- 3. get_coordinacion_host_seguro
--    Cambios:
--    a) derived_status: agrega 'expired_unconfirmed' (prioridad sobre deadline_passed)
--    b) opciones: agrega is_confirmable por opción
--    PRESERVA: auth, host check, date_mode check, CTEs, todos los campos,
--              respondent_count, participantes, grants
-- ============================================================
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
                'mostrar_respuestas_a_invitados', v_enc.mostrar_respuestas_a_invitados,
                'visibilidad_respuestas_invitados', v_enc.visibilidad_respuestas_invitados
            ),
            'coordination_status', v_enc.coordination_status,
            'response_deadline', v_enc.response_deadline,
            'selected_option_id', v_enc.selected_option_id,
            'fecha', v_enc.fecha,
            'hora', v_enc.hora,
            -- MODIFICADO: derived_status con precedencia correcta
            'derived_status', CASE
                WHEN v_enc.coordination_status = 'closed'
                    THEN 'closed'
                WHEN v_enc.coordination_status = 'open'
                  AND EXISTS (SELECT 1 FROM public.encuentro_opciones_fecha WHERE encuentro_id = v_enc.id)
                  AND NOT EXISTS (
                      SELECT 1 FROM public.encuentro_opciones_fecha o
                      WHERE o.encuentro_id = v_enc.id
                        AND (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                            + make_interval(mins => COALESCE(v_enc.duration_minutes, v_enc.post_event_active_minutes, 45))
                            >= now()
                  )
                    THEN 'expired_unconfirmed'
                WHEN v_enc.coordination_status = 'open'
                  AND v_enc.response_deadline IS NOT NULL
                  AND now() >= v_enc.response_deadline
                    THEN 'deadline_passed'
                ELSE 'open'
            END,
            -- MODIFICADO: is_confirmable por opción
            'opciones', COALESCE((SELECT json_agg(json_build_object(
                'id', ao.id, 'fecha', ao.fecha, 'hora_inicio', ao.hora_inicio, 'orden', ao.orden, 
                'selected', COALESCE(ao.id = v_enc.selected_option_id, false),
                'available_count', ao.available_count, 'maybe_count', ao.maybe_count, 
                'unavailable_count', ao.unavailable_count, 'preferred_count', ao.preferred_count,
                'is_confirmable', CASE
                    WHEN v_enc.coordination_status = 'open'
                     AND (ao.fecha + ao.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                         + make_interval(mins => COALESCE(v_enc.duration_minutes, v_enc.post_event_active_minutes, 45))
                         >= now()
                    THEN true
                    ELSE false
                END
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


-- ============================================================
-- 4. get_coordinacion_publica_seguro
--    Cambios:
--    a) derived_status: agrega 'expired_unconfirmed'
--    b) opciones: agrega is_confirmable por opción
--    PRESERVA: token validation, cancelado check, date_mode check,
--              visibilidad, respuestas_detalle, grants a anon/authenticated
-- ============================================================
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
            'id', v_enc.id,
            'titulo', v_enc.titulo,
            'descripcion', v_enc.descripcion,
            'modalidad', v_enc.modalidad,
            'lugar_texto', v_enc.lugar_texto,
            'link_virtual', v_enc.link_virtual,
            'tipo_invitacion', v_enc.tipo_invitacion,
            'tema', v_enc.tema,
            'estado', v_enc.estado,
            'tema_invitacion', COALESCE(v_enc.tema_invitacion, 'classic'),
            'invitation_template', v_enc.invitation_template,
            'duration_minutes', v_enc.duration_minutes,
            'public_token', v_enc.public_token
        ),
        'coordination_status', v_enc.coordination_status,
        'response_deadline', v_enc.response_deadline,
        'selected_option_id', v_enc.selected_option_id,
        'fecha', v_enc.fecha,
        'hora', v_enc.hora,
        'mostrar_respuestas_a_invitados', v_enc.mostrar_respuestas_a_invitados,
        'visibilidad_respuestas_invitados', v_enc.visibilidad_respuestas_invitados,
        -- MODIFICADO: derived_status con precedencia correcta
        'derived_status', CASE
            WHEN v_enc.coordination_status = 'closed'
                THEN 'closed'
            WHEN v_enc.coordination_status = 'open'
              AND EXISTS (SELECT 1 FROM public.encuentro_opciones_fecha WHERE encuentro_id = v_enc.id)
              AND NOT EXISTS (
                  SELECT 1 FROM public.encuentro_opciones_fecha o
                  WHERE o.encuentro_id = v_enc.id
                    AND (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                        + make_interval(mins => COALESCE(v_enc.duration_minutes, v_enc.post_event_active_minutes, 45))
                        >= now()
              )
                THEN 'expired_unconfirmed'
            WHEN v_enc.coordination_status = 'open'
              AND v_enc.response_deadline IS NOT NULL
              AND now() >= v_enc.response_deadline
                THEN 'deadline_passed'
            ELSE 'open'
        END,
        -- MODIFICADO: is_confirmable por opción
        'opciones', (
            SELECT COALESCE(json_agg(json_build_object(
                'id', o.id,
                'fecha', o.fecha,
                'hora_inicio', o.hora_inicio,
                'orden', o.orden,
                'selected', COALESCE(o.id = v_enc.selected_option_id, false),
                'available_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.available_count, 0) ELSE 0 END,
                'maybe_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.maybe_count, 0) ELSE 0 END,
                'unavailable_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.unavailable_count, 0) ELSE 0 END,
                'preferred_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.preferred_count, 0) ELSE 0 END,
                'is_confirmable', CASE
                    WHEN v_enc.coordination_status = 'open'
                     AND (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                         + make_interval(mins => COALESCE(v_enc.duration_minutes, v_enc.post_event_active_minutes, 45))
                         >= now()
                    THEN true
                    ELSE false
                END,
                'respuestas_detalle', CASE
                    WHEN v_enc.visibilidad_respuestas_invitados = 'detail' THEN (
                        SELECT json_agg(
                            json_build_object(
                                'nombre_invitado', COALESCE(NULLIF(TRIM(p.nombre_invitado), ''), 'Invitado'),
                                'respuesta', pd.respuesta,
                                'es_preferida', COALESCE(pd.es_preferida, false)
                            ) ORDER BY LOWER(COALESCE(NULLIF(TRIM(p.nombre_invitado), ''), 'Invitado'))
                        )
                        FROM public.participante_disponibilidades pd
                        JOIN public.participantes p ON p.id = pd.participante_id
                        WHERE pd.opcion_fecha_id = o.id
                          AND pd.encuentro_id = v_enc.id
                    )
                    ELSE NULL
                END
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


-- ============================================================
-- 5. get_coordinacion_participante_seguro
--    Cambios:
--    a) derived_status: agrega 'expired_unconfirmed'
--    b) opciones: agrega is_confirmable por opción
--    PRESERVA: token validation, participante lookup, cancelado,
--              date_mode, respuesta propia (pd), visibilidad,
--              respuestas_detalle, grants
-- ============================================================
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
                'link_virtual', v_enc.link_virtual,
                'tema', v_enc.tema,
                'tipo_invitacion', v_enc.tipo_invitacion,
                'tema_invitacion', COALESCE(v_enc.tema_invitacion, 'classic'),
                'invitation_template', v_enc.invitation_template,
                'duration_minutes', v_enc.duration_minutes,
                'public_token', v_enc.public_token
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
            'visibilidad_respuestas_invitados', v_enc.visibilidad_respuestas_invitados,
            -- MODIFICADO: derived_status con precedencia correcta
            'derived_status', CASE
                WHEN v_enc.coordination_status = 'closed'
                    THEN 'closed'
                WHEN v_enc.coordination_status = 'open'
                  AND EXISTS (SELECT 1 FROM public.encuentro_opciones_fecha WHERE encuentro_id = v_enc.id)
                  AND NOT EXISTS (
                      SELECT 1 FROM public.encuentro_opciones_fecha o
                      WHERE o.encuentro_id = v_enc.id
                        AND (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                            + make_interval(mins => COALESCE(v_enc.duration_minutes, v_enc.post_event_active_minutes, 45))
                            >= now()
                  )
                    THEN 'expired_unconfirmed'
                WHEN v_enc.coordination_status = 'open'
                  AND v_enc.response_deadline IS NOT NULL
                  AND now() >= v_enc.response_deadline
                    THEN 'deadline_passed'
                ELSE 'open'
            END,
            -- MODIFICADO: is_confirmable por opción
            'opciones', (
                SELECT COALESCE(json_agg(json_build_object(
                    'id', o.id,
                    'fecha', o.fecha,
                    'hora_inicio', o.hora_inicio,
                    'orden', o.orden,
                    'selected', COALESCE(o.id = v_enc.selected_option_id, false),
                    'respuesta', pd.respuesta,
                    'es_preferida', pd.es_preferida,
                    'available_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.available_count, 0) ELSE 0 END,
                    'maybe_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.maybe_count, 0) ELSE 0 END,
                    'unavailable_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.unavailable_count, 0) ELSE 0 END,
                    'preferred_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.preferred_count, 0) ELSE 0 END,
                    'is_confirmable', CASE
                        WHEN v_enc.coordination_status = 'open'
                         AND (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                             + make_interval(mins => COALESCE(v_enc.duration_minutes, v_enc.post_event_active_minutes, 45))
                             >= now()
                        THEN true
                        ELSE false
                    END,
                    'respuestas_detalle', CASE
                        WHEN v_enc.visibilidad_respuestas_invitados = 'detail' THEN (
                            SELECT json_agg(
                                json_build_object(
                                    'nombre_invitado', COALESCE(NULLIF(TRIM(p2.nombre_invitado), ''), 'Invitado'),
                                    'respuesta', pd2.respuesta,
                                    'es_preferida', COALESCE(pd2.es_preferida, false)
                                ) ORDER BY LOWER(COALESCE(NULLIF(TRIM(p2.nombre_invitado), ''), 'Invitado'))
                            )
                            FROM public.participante_disponibilidades pd2
                            JOIN public.participantes p2 ON p2.id = pd2.participante_id
                            WHERE pd2.opcion_fecha_id = o.id
                              AND pd2.encuentro_id = v_enc.id
                        )
                        ELSE NULL
                    END
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


-- ============================================================
-- 6. cerrar_coordinacion_seguro
--    Cambio: agrega validación temporal ANTES de UPDATE.
--    Si la opción seleccionada ya venció → error 'option_already_expired'.
--    PRESERVA: auth, not_authenticated, not_found, unauthorized,
--              invalid_date_mode, already_closed, invalid_option,
--              UPDATE, grants
-- ============================================================
CREATE OR REPLACE FUNCTION public.cerrar_coordinacion_seguro(
    p_encuentro_id uuid,
    p_selected_option_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid;
    v_encuentro record;
    v_opcion record;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); 
    END IF;

    SELECT * INTO v_encuentro FROM public.encuentros WHERE id = p_encuentro_id FOR UPDATE;
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'not_found'); 
    END IF;
    
    IF v_encuentro.host_id IS DISTINCT FROM v_user_id THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); 
    END IF;
    
    IF v_encuentro.date_mode IS DISTINCT FROM 'coordination' THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_date_mode'); 
    END IF;
    
    IF v_encuentro.coordination_status IS DISTINCT FROM 'open' THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'already_closed'); 
    END IF;

    SELECT * INTO v_opcion FROM public.encuentro_opciones_fecha
    WHERE id = p_selected_option_id AND encuentro_id = p_encuentro_id;
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_option'); 
    END IF;

    -- NUEVO: Validar que la opción no esté vencida según la expresión canónica
    IF (v_opcion.fecha + v_opcion.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
       + make_interval(mins => COALESCE(v_encuentro.duration_minutes, v_encuentro.post_event_active_minutes, 45))
       < now() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'option_already_expired');
    END IF;

    UPDATE public.encuentros
    SET 
        coordination_status = 'closed',
        selected_option_id = p_selected_option_id,
        fecha = v_opcion.fecha,
        hora = v_opcion.hora_inicio
    WHERE id = p_encuentro_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_coordinacion_seguro(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cerrar_coordinacion_seguro(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.cerrar_coordinacion_seguro(uuid, uuid) TO authenticated;


-- ============================================================
-- 7. crear_disponibilidad_coordinacion_publica_seguro
--    Cambio: agrega bloqueo expired_unconfirmed con precedencia correcta:
--            closed/cancelado → expired_unconfirmed → deadline_passed → resto
--    PRESERVA: token validation, cancelado, date_mode, link_general check,
--              coordination_status (closed), response_deadline, validaciones
--              de nombre/respuestas/opciones, INSERT, grants
-- ============================================================
CREATE OR REPLACE FUNCTION public.crear_disponibilidad_coordinacion_publica_seguro(
    p_public_token text,
    p_nombre text,
    p_respuestas jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_token_uuid uuid;
    v_encuentro record;
    v_nombre text;
    v_option_count int;
    v_resp_count int;
    v_pref_count int;
    v_pref_unavail_count int;
    v_item jsonb;
    v_participante_id uuid;
    v_token_invitacion uuid;
BEGIN
    IF p_public_token IS NULL OR trim(p_public_token) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    BEGIN
        v_token_uuid := p_public_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE public_token = v_token_uuid
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'encounter_cancelled');
    END IF;

    IF v_encuentro.date_mode IS DISTINCT FROM 'coordination' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_date_mode');
    END IF;

    IF v_encuentro.tipo_invitacion IS DISTINCT FROM 'link_general' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_invitation_type');
    END IF;

    IF v_encuentro.coordination_status IS DISTINCT FROM 'open' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'coordination_closed');
    END IF;

    -- NUEVO (precedencia B): Bloquear si todas las opciones están vencidas
    IF EXISTS (SELECT 1 FROM public.encuentro_opciones_fecha WHERE encuentro_id = v_encuentro.id)
       AND NOT EXISTS (
           SELECT 1 FROM public.encuentro_opciones_fecha o
           WHERE o.encuentro_id = v_encuentro.id
             AND (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                 + make_interval(mins => COALESCE(v_encuentro.duration_minutes, v_encuentro.post_event_active_minutes, 45))
                 >= now()
       ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'coordination_already_expired');
    END IF;

    -- Precedencia C: deadline vencido (solo si aún hay opciones futuras)
    IF v_encuentro.response_deadline IS NOT NULL AND now() >= v_encuentro.response_deadline THEN
        RETURN jsonb_build_object('ok', false, 'error', 'response_deadline_passed');
    END IF;

    v_nombre := NULLIF(btrim(p_nombre), '');
    IF v_nombre IS NULL OR char_length(v_nombre) < 1 OR char_length(v_nombre) > 80 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_name');
    END IF;

    IF p_respuestas IS NULL OR jsonb_typeof(p_respuestas) <> 'array' OR jsonb_array_length(p_respuestas) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
    END IF;

    SELECT count(*) INTO v_option_count FROM public.encuentro_opciones_fecha WHERE encuentro_id = v_encuentro.id;
    IF v_option_count = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
    END IF;

    IF jsonb_array_length(p_respuestas) <> v_option_count THEN
        RETURN jsonb_build_object('ok', false, 'error', 'incomplete_responses');
    END IF;

    v_pref_count := 0;
    v_pref_unavail_count := 0;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_respuestas)
    LOOP
        IF jsonb_typeof(v_item) <> 'object' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
        END IF;

        IF NOT (v_item ? 'opcion_fecha_id' AND v_item ? 'respuesta' AND v_item ? 'es_preferida') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
        END IF;

        IF (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 3 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
        END IF;

        IF jsonb_typeof(v_item->'opcion_fecha_id') <> 'string' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
        END IF;
        IF jsonb_typeof(v_item->'respuesta') <> 'string' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_response_value');
        END IF;
        IF jsonb_typeof(v_item->'es_preferida') <> 'boolean' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_preferred');
        END IF;

        DECLARE
            v_op_uuid uuid;
            v_exists boolean;
        BEGIN
            v_op_uuid := (v_item->>'opcion_fecha_id')::uuid;
            SELECT true INTO v_exists FROM public.encuentro_opciones_fecha WHERE id = v_op_uuid AND encuentro_id = v_encuentro.id;
            IF v_exists IS NULL THEN
                RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
            END IF;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
        END;

        IF v_item->>'respuesta' NOT IN ('available', 'maybe', 'unavailable') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_response_value');
        END IF;

        IF (v_item->>'es_preferida')::boolean THEN
            v_pref_count := v_pref_count + 1;
            IF v_item->>'respuesta' = 'unavailable' THEN
                v_pref_unavail_count := v_pref_unavail_count + 1;
            END IF;
        END IF;
    END LOOP;

    SELECT count(DISTINCT value->>'opcion_fecha_id') INTO v_resp_count FROM jsonb_array_elements(p_respuestas);
    IF v_resp_count <> v_option_count THEN
        RETURN jsonb_build_object('ok', false, 'error', 'duplicate_options');
    END IF;

    IF v_pref_count > 1 OR v_pref_unavail_count > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_preferred');
    END IF;

    v_token_invitacion := gen_random_uuid();
    
    INSERT INTO public.participantes (
        encuentro_id, nombre_invitado, tipo_invitacion, estado, token_invitacion
    ) VALUES (
        v_encuentro.id, v_nombre, 'generico', 'pendiente', v_token_invitacion
    ) RETURNING id INTO v_participante_id;

    INSERT INTO public.participante_disponibilidades (
        participante_id, encuentro_id, opcion_fecha_id, respuesta, es_preferida
    )
    SELECT 
        v_participante_id, v_encuentro.id, (value->>'opcion_fecha_id')::uuid, value->>'respuesta', (value->>'es_preferida')::boolean
    FROM jsonb_array_elements(p_respuestas);

    RETURN json_build_object(
        'ok', true,
        'encuentro_id', v_encuentro.id,
        'participante', json_build_object(
            'id', v_participante_id,
            'nombre_invitado', v_nombre,
            'tipo_invitacion', 'generico'
        ),
        'token_invitacion', v_token_invitacion,
        'respondio_disponibilidad', true,
        'mis_respuestas', COALESCE((
            SELECT json_agg(
                json_build_object(
                    'opcion_fecha_id', pd.opcion_fecha_id,
                    'respuesta', pd.respuesta,
                    'es_preferida', pd.es_preferida
                ) ORDER BY o.orden ASC
            )
            FROM public.participante_disponibilidades pd
            JOIN public.encuentro_opciones_fecha o ON o.id = pd.opcion_fecha_id
            WHERE pd.participante_id = v_participante_id AND pd.encuentro_id = v_encuentro.id
        ), '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb) TO postgres, service_role;


-- ============================================================
-- 8. guardar_disponibilidad_coordinacion_participante_seguro
--    Cambio: agrega bloqueo expired_unconfirmed con precedencia correcta
--    PRESERVA: token validation, FOR UPDATE locks, cancelado, date_mode,
--              coordination_status (closed), response_deadline, tipo_invitacion,
--              validaciones de respuestas, DELETE + INSERT, grants
-- ============================================================
CREATE OR REPLACE FUNCTION public.guardar_disponibilidad_coordinacion_participante_seguro(
    p_token text,
    p_respuestas jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_token_uuid uuid;
    v_participante_id uuid;
    v_encuentro_id uuid;
    v_encuentro record;
    v_participante record;
    v_option_count int;
    v_resp_count int;
    v_pref_count int;
    v_pref_unavail_count int;
    v_item jsonb;
BEGIN
    IF p_token IS NULL OR trim(p_token) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    BEGIN
        v_token_uuid := p_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END;

    -- Lectura inicial sin bloqueo
    SELECT id, encuentro_id INTO v_participante_id, v_encuentro_id
    FROM public.participantes
    WHERE token_invitacion = v_token_uuid;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    -- Bloqueo encuentro
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    -- Bloqueo participante (Revalidar)
    SELECT * INTO v_participante
    FROM public.participantes
    WHERE id = v_participante_id AND token_invitacion = v_token_uuid AND encuentro_id = v_encuentro.id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'encounter_cancelled');
    END IF;

    IF v_encuentro.date_mode IS DISTINCT FROM 'coordination' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_date_mode');
    END IF;

    IF v_encuentro.coordination_status IS DISTINCT FROM 'open' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'coordination_closed');
    END IF;

    -- NUEVO (precedencia B): Bloquear si todas las opciones están vencidas
    IF EXISTS (SELECT 1 FROM public.encuentro_opciones_fecha WHERE encuentro_id = v_encuentro.id)
       AND NOT EXISTS (
           SELECT 1 FROM public.encuentro_opciones_fecha o
           WHERE o.encuentro_id = v_encuentro.id
             AND (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                 + make_interval(mins => COALESCE(v_encuentro.duration_minutes, v_encuentro.post_event_active_minutes, 45))
                 >= now()
       ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'coordination_already_expired');
    END IF;

    -- Precedencia C: deadline vencido (solo si aún hay opciones futuras)
    IF v_encuentro.response_deadline IS NOT NULL AND now() >= v_encuentro.response_deadline THEN
        RETURN jsonb_build_object('ok', false, 'error', 'response_deadline_passed');
    END IF;

    IF v_participante.tipo_invitacion NOT IN ('individual', 'generico') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_invitation_type');
    END IF;

    IF p_respuestas IS NULL OR jsonb_typeof(p_respuestas) <> 'array' OR jsonb_array_length(p_respuestas) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
    END IF;

    SELECT count(*) INTO v_option_count FROM public.encuentro_opciones_fecha WHERE encuentro_id = v_encuentro.id;
    IF v_option_count = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
    END IF;

    IF jsonb_array_length(p_respuestas) <> v_option_count THEN
        RETURN jsonb_build_object('ok', false, 'error', 'incomplete_responses');
    END IF;

    v_pref_count := 0;
    v_pref_unavail_count := 0;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_respuestas)
    LOOP
        IF jsonb_typeof(v_item) <> 'object' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
        END IF;

        IF NOT (v_item ? 'opcion_fecha_id' AND v_item ? 'respuesta' AND v_item ? 'es_preferida') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
        END IF;

        IF (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 3 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_responses');
        END IF;

        IF jsonb_typeof(v_item->'opcion_fecha_id') <> 'string' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
        END IF;
        IF jsonb_typeof(v_item->'respuesta') <> 'string' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_response_value');
        END IF;
        IF jsonb_typeof(v_item->'es_preferida') <> 'boolean' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_preferred');
        END IF;

        DECLARE
            v_op_uuid uuid;
            v_exists boolean;
        BEGIN
            v_op_uuid := (v_item->>'opcion_fecha_id')::uuid;
            SELECT true INTO v_exists FROM public.encuentro_opciones_fecha WHERE id = v_op_uuid AND encuentro_id = v_encuentro.id;
            IF v_exists IS NULL THEN
                RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
            END IF;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
        END;

        IF v_item->>'respuesta' NOT IN ('available', 'maybe', 'unavailable') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_response_value');
        END IF;

        IF (v_item->>'es_preferida')::boolean THEN
            v_pref_count := v_pref_count + 1;
            IF v_item->>'respuesta' = 'unavailable' THEN
                v_pref_unavail_count := v_pref_unavail_count + 1;
            END IF;
        END IF;
    END LOOP;

    SELECT count(DISTINCT value->>'opcion_fecha_id') INTO v_resp_count FROM jsonb_array_elements(p_respuestas);
    IF v_resp_count <> v_option_count THEN
        RETURN jsonb_build_object('ok', false, 'error', 'duplicate_options');
    END IF;

    IF v_pref_count > 1 OR v_pref_unavail_count > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_preferred');
    END IF;

    DELETE FROM public.participante_disponibilidades
    WHERE participante_id = v_participante.id
      AND encuentro_id = v_encuentro.id;

    INSERT INTO public.participante_disponibilidades (
        participante_id, encuentro_id, opcion_fecha_id, respuesta, es_preferida
    )
    SELECT 
        v_participante.id, v_encuentro.id, (value->>'opcion_fecha_id')::uuid, value->>'respuesta', (value->>'es_preferida')::boolean
    FROM jsonb_array_elements(p_respuestas);

    RETURN json_build_object(
        'ok', true,
        'encuentro_id', v_encuentro.id,
        'participante_id', v_participante.id,
        'respondio_disponibilidad', true,
        'mis_respuestas', COALESCE((
            SELECT json_agg(
                json_build_object(
                    'opcion_fecha_id', pd.opcion_fecha_id,
                    'respuesta', pd.respuesta,
                    'es_preferida', pd.es_preferida
                ) ORDER BY o.orden ASC
            )
            FROM public.participante_disponibilidades pd
            JOIN public.encuentro_opciones_fecha o ON o.id = pd.opcion_fecha_id
            WHERE pd.participante_id = v_participante.id AND pd.encuentro_id = v_encuentro.id
        ), '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb) TO postgres, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
