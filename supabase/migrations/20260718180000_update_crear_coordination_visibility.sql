-- Update crear_encuentro_con_opciones_seguro to support mostrar_respuestas_a_invitados
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

    -- 4. Validar opciones individuales (sin order by porque JSON NO GARANTIZA ORDEN, el cliente DEBE ordenarlas)
    FOR v_idx IN 0..jsonb_array_length(p_opciones)-1 LOOP
        v_op_fecha := (p_opciones->v_idx->>'fecha')::date;
        v_op_hora := (p_opciones->v_idx->>'hora_inicio')::time;
        
        IF v_op_fecha IS NULL OR v_op_hora IS NULL THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_option_format');
        END IF;

        v_op_ts := public.to_argentina_time(v_op_fecha, v_op_hora);
        
        IF v_op_ts < (now() AT TIME ZONE 'America/Argentina/Buenos_Aires') THEN
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

    -- 4. Validar plazo de respuesta opcional
    IF p_data->>'response_deadline' IS NOT NULL THEN
        v_deadline := (p_data->>'response_deadline')::timestamptz;
        IF v_deadline < now() THEN
             RETURN json_build_object('ok', false, 'error', 'deadline_in_past');
        END IF;
        
        -- El plazo debe ser menor a la primera opción propuesta (comparación en UTC o en el timezone que corresponda)
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
    
    v_mostrar_respuestas_a_invitados := COALESCE((p_data->>'mostrar_respuestas_a_invitados')::boolean, false);

    -- 6. Generación server-side estricta de identificadores
    v_enc_id := gen_random_uuid();
    v_token := gen_random_uuid();

    -- 7. Inserción Atómica del Encuentro
    INSERT INTO public.encuentros (
        id, titulo, descripcion, modalidad, lugar_texto, link_virtual,
        tipo_invitacion, host_id, public_token, estado, tema, tema_invitacion, invitation_template,
        date_mode, coordination_status, response_deadline, duration_minutes, fecha, hora, selected_option_id,
        mostrar_respuestas_a_invitados
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
        v_mostrar_respuestas_a_invitados
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
