-- ============================================================
-- Migración 2B.1: add_coordination_backend_read_contracts
-- Bloque 2B: Infraestructura de Lectura para Coordinación
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Agregar duration_minutes y Constraint Idempotente
-- ============================================================
ALTER TABLE public.encuentros ADD COLUMN IF NOT EXISTS duration_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'encuentros_duration_minutes_check'
      AND conrelid = 'public.encuentros'::regclass
  ) THEN
    ALTER TABLE public.encuentros
      ADD CONSTRAINT encuentros_duration_minutes_check
      CHECK (
        duration_minutes IS NULL
        OR duration_minutes BETWEEN 15 AND 1440
      );
  END IF;
END
$$;

-- ============================================================
-- 2. Actualizar crear_encuentro_con_opciones_seguro
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

    -- Inicializar arrays para parseo server-side
    v_arr_fechas := ARRAY[]::date[];
    v_arr_horas := ARRAY[]::time[];
    v_arr_ts := ARRAY[]::timestamptz[];

    FOR v_op IN SELECT * FROM jsonb_array_elements(p_opciones) LOOP
        IF v_op.value->>'fecha' IS NULL OR v_op.value->>'hora_inicio' IS NULL THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_options');
        END IF;

        IF NOT (v_op.value->>'fecha' ~ '^\d{4}-\d{2}-\d{2}$') THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_option_date');
        END IF;
        IF NOT (v_op.value->>'hora_inicio' ~ '^([0-1][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$') THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_option_time');
        END IF;

        BEGIN
            v_op_fecha := (v_op.value->>'fecha')::date;
        EXCEPTION WHEN OTHERS THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_option_date');
        END;

        BEGIN
            v_op_hora := (v_op.value->>'hora_inicio')::time;
        EXCEPTION WHEN OTHERS THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_option_time');
        END;

        v_op_ts := (v_op_fecha + v_op_hora) AT TIME ZONE 'America/Argentina/Buenos_Aires';

        IF v_op_ts <= now() THEN
            RETURN json_build_object('ok', false, 'error', 'option_in_past');
        END IF;

        v_is_duplicate := false;
        IF array_length(v_arr_fechas, 1) > 0 THEN
            FOR v_idx IN 1 .. array_length(v_arr_fechas, 1) LOOP
                IF v_arr_fechas[v_idx] = v_op_fecha AND v_arr_horas[v_idx] = v_op_hora THEN
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
    END LOOP;

    SELECT min(val) INTO v_min_opcion_ts FROM unnest(v_arr_ts) AS val;

    -- 4. Validar Deadline
    IF p_data->>'response_deadline' IS NOT NULL THEN
        IF NOT (p_data->>'response_deadline' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$') THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_deadline');
        END IF;

        BEGIN
            v_deadline := (p_data->>'response_deadline')::timestamptz;
        EXCEPTION
            WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
                RETURN json_build_object('ok', false, 'error', 'invalid_deadline');
        END;

        IF v_deadline <= now() THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_deadline');
        END IF;
        IF v_deadline >= v_min_opcion_ts THEN
            RETURN json_build_object('ok', false, 'error', 'deadline_after_first_option');
        END IF;
    END IF;

    -- 4.b Validar duration_minutes de forma estricta
    IF NOT (p_data ? 'duration_minutes')
       OR p_data->'duration_minutes' = 'null'::jsonb
    THEN
        v_duration_minutes := NULL;
    ELSIF jsonb_typeof(p_data->'duration_minutes') <> 'number' THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'invalid_duration_minutes'
        );
    ELSE
        BEGIN
            v_duration_numeric := (p_data->>'duration_minutes')::numeric;
        EXCEPTION WHEN OTHERS THEN
            RETURN json_build_object(
                'ok', false,
                'error', 'invalid_duration_minutes'
            );
        END;

        IF v_duration_numeric <> trunc(v_duration_numeric)
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

    -- 5. Replicar validaciones reales del esquema
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

    -- 6. Generación server-side estricta de identificadores
    v_enc_id := gen_random_uuid();
    v_token := gen_random_uuid();

    -- 7. Inserción Atómica del Encuentro
    INSERT INTO public.encuentros (
        id, titulo, descripcion, modalidad, lugar_texto, link_virtual,
        tipo_invitacion, host_id, public_token, estado, tema, tema_invitacion, invitation_template,
        date_mode, coordination_status, response_deadline, duration_minutes, fecha, hora, selected_option_id
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
        NULL
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
            'public_token', v_token,
            'date_mode', 'coordination',
            'coordination_status', 'open',
            'response_deadline', v_deadline,
            'duration_minutes', v_duration_minutes
        ),
        'opciones', (
            SELECT COALESCE(json_agg(json_build_object(
                'id', id,
                'fecha', fecha,
                'hora_inicio', hora_inicio,
                'orden', orden
            ) ORDER BY orden), '[]'::json)
            FROM public.encuentro_opciones_fecha
            WHERE encuentro_id = v_enc_id
        )
    );
END;
$function$;

-- ============================================================
-- 3. Actualizar get_coordinacion_host_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_coordinacion_host_seguro(
    p_encuentro_id uuid
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid;
    v_enc record;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- Solo permitir a cuentas permanentes
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

    IF v_enc.date_mode <> 'coordination' THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_date_mode');
    END IF;

    RETURN json_build_object(
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
            'duration_minutes', v_enc.duration_minutes
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
        'opciones', (
            SELECT COALESCE(json_agg(json_build_object(
                'id', o.id,
                'fecha', o.fecha,
                'hora_inicio', o.hora_inicio,
                'orden', o.orden,
                'selected', COALESCE(o.id = v_enc.selected_option_id, false),
                'available_count', COALESCE(agg.available_count, 0),
                'maybe_count', COALESCE(agg.maybe_count, 0),
                'unavailable_count', COALESCE(agg.unavailable_count, 0),
                'preferred_count', COALESCE(agg.preferred_count, 0)
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
                GROUP BY pd.opcion_fecha_id
            ) agg ON agg.opcion_fecha_id = o.id
            WHERE o.encuentro_id = v_enc.id
        )
    );
END;
$function$;

-- ============================================================
-- 4. Actualizar get_coordinacion_publica_seguro
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
                'selected', COALESCE(o.id = v_enc.selected_option_id, false)
            ) ORDER BY o.orden), '[]'::json)
            FROM public.encuentro_opciones_fecha o
            WHERE o.encuentro_id = v_enc.id
        )
    );
END;
$function$;

-- ============================================================
-- 5. Actualizar get_coordinacion_participante_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_coordinacion_participante_seguro(
    p_token text
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_token_uuid uuid;
    v_part record;
    v_enc record;
BEGIN
    BEGIN
        v_token_uuid := p_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_token');
    END;

    SELECT * INTO v_part FROM public.participantes WHERE token_invitacion = v_token_uuid;
    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    SELECT * INTO v_enc FROM public.encuentros WHERE id = v_part.encuentro_id;
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
            'tipo_invitacion', v_enc.tipo_invitacion,
            'tema', v_enc.tema,
            'estado', v_enc.estado,
            'tema_invitacion', COALESCE(v_enc.tema_invitacion, 'classic'),
            'invitation_template', v_enc.invitation_template,
            'duration_minutes', v_enc.duration_minutes
        ),
        'participante', json_build_object(
            'id', v_part.id,
            'nombre_invitado', v_part.nombre_invitado,
            'tipo_invitacion', v_part.tipo_invitacion,
            'estado', v_part.estado,
            'mensaje_respuesta', v_part.mensaje_respuesta
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
        'opciones', (
            SELECT COALESCE(json_agg(json_build_object(
                'id', o.id,
                'fecha', o.fecha,
                'hora_inicio', o.hora_inicio,
                'orden', o.orden,
                'selected', COALESCE(o.id = v_enc.selected_option_id, false)
            ) ORDER BY o.orden), '[]'::json)
            FROM public.encuentro_opciones_fecha o
            WHERE o.encuentro_id = v_enc.id
        ),
        'mis_respuestas', (
            SELECT COALESCE(json_agg(json_build_object(
                'opcion_fecha_id', pd.opcion_fecha_id,
                'respuesta', pd.respuesta,
                'es_preferida', pd.es_preferida
            ) ORDER BY o.orden), '[]'::json)
            FROM public.participante_disponibilidades pd
            JOIN public.encuentro_opciones_fecha o ON o.id = pd.opcion_fecha_id
            WHERE pd.participante_id = v_part.id 
              AND pd.encuentro_id = v_enc.id
              AND o.encuentro_id = v_enc.id
        )
    );
END;
$function$;

-- ============================================================
-- 6. Actualizar get_encuentros_host_seguro
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

-- ============================================================
-- 7. Renovar Grants Asegurando Aislamiento
-- ============================================================
REVOKE ALL ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.get_coordinacion_host_seguro(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_host_seguro(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_encuentros_host_seguro(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentros_host_seguro(uuid[]) TO authenticated;

REVOKE ALL ON FUNCTION public.get_coordinacion_participante_seguro(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_participante_seguro(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_coordinacion_publica_seguro(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_publica_seguro(text) TO anon, authenticated;

COMMIT;
