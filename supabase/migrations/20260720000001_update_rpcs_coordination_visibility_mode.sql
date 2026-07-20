-- ============================================================
-- Migración: update_rpcs_coordination_visibility_mode
-- Propósito: Actualizar las 5 RPCs de coordinación para usar
--            visibilidad_respuestas_invitados ('hidden'|'summary'|'detail')
--            en lugar del boolean mostrar_respuestas_a_invitados.
--
-- RPCs actualizadas:
--   1. set_visibilidad_respuestas_invitados  — nueva firma: p_modo text
--   2. crear_encuentro_con_opciones_seguro   — soporta nuevo campo
--   3. get_coordinacion_host_seguro          — devuelve nuevo campo
--   4. get_coordinacion_publica_seguro       — devuelve nuevo campo + detail data
--   5. get_coordinacion_participante_seguro  — devuelve nuevo campo + detail data
-- ============================================================

BEGIN;

-- ============================================================
-- 1. set_visibilidad_respuestas_invitados
--    Se usa Function Overloading para mantener compatibilidad
--    con la firma boolean, y se agrega la nueva firma text.
-- ============================================================

-- A. Nueva firma (text)
CREATE OR REPLACE FUNCTION public.set_visibilidad_respuestas_invitados(
  p_encuentro_id uuid,
  p_host_id      uuid,
  p_modo         text    -- 'hidden' | 'summary' | 'detail'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists boolean;
  v_mode text;
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  IF v_user_id <> p_host_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  v_mode := COALESCE(p_modo, 'hidden');

  -- Validar modo
  IF v_mode NOT IN ('hidden', 'summary', 'detail') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_mode');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.encuentros
    WHERE id = p_encuentro_id
      AND host_id = v_user_id
  ) INTO v_exists;

  IF NOT v_exists THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  UPDATE public.encuentros
  SET 
    visibilidad_respuestas_invitados = v_mode,
    mostrar_respuestas_a_invitados   = (v_mode <> 'hidden')
  WHERE id = p_encuentro_id
    AND host_id = v_user_id;

  RETURN jsonb_build_object('ok', true, 'modo', v_mode);
END;
$$;

REVOKE ALL ON FUNCTION public.set_visibilidad_respuestas_invitados(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_visibilidad_respuestas_invitados(uuid, uuid, text) TO authenticated;

-- B. Firma legacy (boolean) - Delega en la nueva
CREATE OR REPLACE FUNCTION public.set_visibilidad_respuestas_invitados(
  p_encuentro_id uuid,
  p_host_id      uuid,
  p_visible      boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.set_visibilidad_respuestas_invitados(
    p_encuentro_id,
    p_host_id,
    CASE WHEN p_visible IS TRUE THEN 'summary' ELSE 'hidden' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_visibilidad_respuestas_invitados(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_visibilidad_respuestas_invitados(uuid, uuid, boolean) TO authenticated;


-- ============================================================
-- 2. crear_encuentro_con_opciones_seguro
--    Agrega soporte para visibilidad_respuestas_invitados en el payload.
--    Compatibilidad: si no se envía el nuevo campo, se deriva del boolean.
-- ============================================================
CREATE OR REPLACE FUNCTION public.crear_encuentro_con_opciones_seguro(
    p_data jsonb,
    p_opciones jsonb
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid;
    v_enc_id uuid;
    v_token uuid;
    v_tema_invitacion text;
    v_deadline timestamptz;
    v_min_opcion_ts timestamptz;
    v_opciones_count int;
    v_ord int := 1;
    v_op record;
    
    v_op_fecha date;
    v_op_hora time;
    v_op_ts timestamptz;
    
    v_arr_fechas date[];
    v_arr_horas time[];
    v_arr_ts timestamptz[];
    v_idx int;
    v_is_duplicate boolean;
    
    v_titulo text;
    v_modalidad text;
    v_lugar_texto text;
    v_link_virtual text;
    v_tipo_invitacion text;
    v_tema text;
    v_duration_numeric numeric;
    v_duration_minutes integer;
    v_mostrar_respuestas_a_invitados boolean;
    v_visibilidad_respuestas text;
BEGIN
    -- 1. Autenticación forzada por token JWT
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- Solo permitir a cuentas permanentes
    IF COALESCE((auth.jwt()->>'is_anonymous')::boolean, false) THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 2. Validar estructura de p_data
    IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_data');
    END IF;

    -- 3. Validar estructura de opciones
    IF p_opciones IS NULL OR jsonb_typeof(p_opciones) <> 'array' THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_options');
    END IF;

    v_opciones_count := jsonb_array_length(p_opciones);
    IF v_opciones_count < 2 THEN
        RETURN json_build_object('ok', false, 'error', 'minimum_two_options');
    END IF;
    IF v_opciones_count > 3 THEN
        RETURN json_build_object('ok', false, 'error', 'maximum_three_options');
    END IF;

    -- 4. Validar opciones individuales
    FOR v_idx IN 0..jsonb_array_length(p_opciones)-1 LOOP
        v_op_fecha := (p_opciones->v_idx->>'fecha')::date;
        v_op_hora := (p_opciones->v_idx->>'hora_inicio')::time;
        
        IF v_op_fecha IS NULL OR v_op_hora IS NULL THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_option_format');
        END IF;

        -- Migración segura inline sin depender de public.to_argentina_time
        v_op_ts := (v_op_fecha + v_op_hora) AT TIME ZONE 'America/Argentina/Buenos_Aires';
        
        IF v_op_ts < now() THEN
            RETURN json_build_object('ok', false, 'error', 'option_in_past');
        END IF;

        v_is_duplicate := false;
        IF array_length(v_arr_ts, 1) > 0 THEN
            FOR i IN 1..array_length(v_arr_ts, 1) LOOP
                IF v_arr_ts[i] = v_op_ts THEN
                    v_is_duplicate := true;
                    EXIT;
                END IF;
            END LOOP;
        END IF;

        IF v_is_duplicate THEN
            RETURN json_build_object('ok', false, 'error', 'duplicate_options');
        END IF;

        v_arr_fechas := array_append(v_arr_fechas, v_op_fecha);
        v_arr_horas := array_append(v_arr_horas, v_op_hora);
        v_arr_ts := array_append(v_arr_ts, v_op_ts);

        IF v_min_opcion_ts IS NULL OR v_op_ts < v_min_opcion_ts THEN
            v_min_opcion_ts := v_op_ts;
        END IF;
    END LOOP;

    -- 4b. Validar plazo de respuesta opcional
    IF p_data->>'response_deadline' IS NOT NULL THEN
        v_deadline := (p_data->>'response_deadline')::timestamptz;
        IF v_deadline < now() THEN
             RETURN json_build_object('ok', false, 'error', 'deadline_in_past');
        END IF;
        
        IF v_deadline >= v_min_opcion_ts THEN
             RETURN json_build_object('ok', false, 'error', 'deadline_after_options');
        END IF;
    END IF;

    -- Validar duration_minutes
    IF p_data->>'duration_minutes' IS NOT NULL THEN
        v_duration_numeric := (p_data->>'duration_minutes')::numeric;
        
        IF trunc(v_duration_numeric) <> v_duration_numeric 
           OR v_duration_numeric < 15
           OR v_duration_numeric > 1440
        THEN
            RETURN json_build_object(
                'ok', false,
                'error', 'invalid_duration_minutes'
            );
        END IF;

        v_duration_minutes := v_duration_numeric::integer;
    END IF;

    -- 5. Validaciones de campos
    v_titulo := NULLIF(btrim(p_data->>'titulo'), '');
    IF v_titulo IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_data');
    END IF;
    
    v_modalidad := p_data->>'modalidad';
    IF v_modalidad IS NULL OR v_modalidad NOT IN ('presencial', 'virtual') THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_modality');
    END IF;
    
    v_lugar_texto := NULLIF(btrim(p_data->>'lugar_texto'), '');
    IF v_modalidad = 'presencial' AND v_lugar_texto IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'location_required');
    END IF;
    
    v_link_virtual := NULLIF(btrim(p_data->>'link_virtual'), '');
    IF v_modalidad = 'virtual' AND v_link_virtual IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'virtual_link_required');
    END IF;
    
    v_tipo_invitacion := p_data->>'tipo_invitacion';
    IF v_tipo_invitacion IS NULL OR v_tipo_invitacion NOT IN ('individual', 'link_general') THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_invitation_type');
    END IF;

    v_tema := COALESCE(p_data->>'tema', 'blue');
    IF v_tema NOT IN ('blue', 'green', 'orange', 'purple') THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_theme');
    END IF;

    v_tema_invitacion := CASE
        WHEN p_data->>'tema_invitacion' IN (
            'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
            'family', 'special', 'romantic', 'sports', 'entertainment',
            'learning', 'wellness', 'custom'
        ) THEN p_data->>'tema_invitacion'
        ELSE 'classic'
    END;

    -- Visibilidad: leer el nuevo campo primero, derivar del boolean si no está
    v_visibilidad_respuestas := CASE
        WHEN p_data->>'visibilidad_respuestas_invitados' IN ('hidden', 'summary', 'detail')
            THEN p_data->>'visibilidad_respuestas_invitados'
        WHEN COALESCE((p_data->>'mostrar_respuestas_a_invitados')::boolean, false) = true
            THEN 'summary'
        ELSE 'hidden'
    END;

    v_mostrar_respuestas_a_invitados := (v_visibilidad_respuestas <> 'hidden');

    -- 6. Generación server-side de identificadores
    v_enc_id := gen_random_uuid();
    v_token := gen_random_uuid();

    -- 7. Inserción Atómica del Encuentro
    INSERT INTO public.encuentros (
        id, titulo, descripcion, modalidad, lugar_texto, link_virtual,
        tipo_invitacion, host_id, public_token, estado, tema, tema_invitacion, invitation_template,
        date_mode, coordination_status, response_deadline, duration_minutes, fecha, hora, selected_option_id,
        mostrar_respuestas_a_invitados, visibilidad_respuestas_invitados
    )
    VALUES (
        v_enc_id,
        v_titulo,
        p_data->>'descripcion',
        v_modalidad,
        v_lugar_texto,
        v_link_virtual,
        v_tipo_invitacion,
        v_user_id,
        v_token,
        'activo',
        v_tema,
        v_tema_invitacion,
        p_data->>'invitation_template',
        'coordination',
        'open',
        v_deadline,
        v_duration_minutes,
        NULL,
        NULL,
        NULL,
        v_mostrar_respuestas_a_invitados,
        v_visibilidad_respuestas
    );

    -- 8. Inserción de Opciones ordenadas cronológicamente
    FOR v_op IN (
        SELECT f, h 
        FROM unnest(v_arr_fechas, v_arr_horas, v_arr_ts) AS t(f, h, ts)
        ORDER BY ts ASC
    ) LOOP
        INSERT INTO public.encuentro_opciones_fecha (
            encuentro_id, fecha, hora_inicio, orden
        ) VALUES (
            v_enc_id, v_op.f, v_op.h, v_ord
        );
        v_ord := v_ord + 1;
    END LOOP;

    RETURN json_build_object(
        'ok', true,
        'encuentro', json_build_object(
            'id', v_enc_id,
            'public_token', v_token
        )
    );
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object(
        'ok', false,
        'error', 'unknown_error',
        'details', SQLERRM
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) TO authenticated;


-- ============================================================
-- 3. get_coordinacion_host_seguro
--    Agrega visibilidad_respuestas_invitados en el objeto encuentro del resultado.
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


-- ============================================================
-- 4. get_coordinacion_publica_seguro
--    Devuelve visibilidad_respuestas_invitados a nivel raíz.
--    Usa nuevo campo para controlar conteos anónimos.
--    Si visibilidad = 'detail', incluye respuestas_detalle por opción
--    (nombre declarado + respuesta + preferida). Sin emails ni tokens.
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
                'available_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.available_count, 0) ELSE 0 END,
                'maybe_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.maybe_count, 0) ELSE 0 END,
                'unavailable_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.unavailable_count, 0) ELSE 0 END,
                'preferred_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.preferred_count, 0) ELSE 0 END,
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
--    Devuelve visibilidad_respuestas_invitados a nivel raíz.
--    Usa nuevo campo para controlar conteos anónimos.
--    Si visibilidad = 'detail', incluye respuestas_detalle por opción.
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
                    'available_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.available_count, 0) ELSE 0 END,
                    'maybe_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.maybe_count, 0) ELSE 0 END,
                    'unavailable_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.unavailable_count, 0) ELSE 0 END,
                    'preferred_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.preferred_count, 0) ELSE 0 END,
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

COMMIT;

NOTIFY pgrst, 'reload schema';
