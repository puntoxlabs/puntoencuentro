-- ==============================================================================
-- Migración: 20261019180000_fix_crear_encuentro_con_opciones_seguro.sql
-- Descripción:
--   Corrección P0 de public.crear_encuentro_con_opciones_seguro(jsonb, jsonb).
--   La migración 20261015150000_moderation_v1_1_quality_and_anti_spam.sql
--   introdujo regresiones al redefinir esta RPC:
--     1. Referencia a columna inexistente `visibilidad_respuestas` en lugar de
--        `visibilidad_respuestas_invitados`.
--     2. Inserción en tabla inexistente `public.coordinacion_fase` y omisión de
--        `coordination_status`, `response_deadline` y `selected_option_id` en
--        `public.encuentros`.
--     3. Invocación a `pg_catalog.least(...)` (inexistente como función).
--     4. Lectura de `deadline` e invención de plazo automático en lugar de
--        respetar `response_deadline` opcional (`NULL` cuando no se define).
--     5. Aceptación de `id` y `public_token` provistos por el cliente en lugar
--        de generarlos exclusivamente server-side con `gen_random_uuid()`.
--     6. Pérdida de validaciones de `duration_minutes` (`invalid_duration_minutes`),
--        `tipo_invitacion` (`invalid_invitation_type`), `tema` (`invalid_theme`),
--        código `duplicate_options` y ordenamiento cronológico de opciones.
--
--   Esta migración restaura el contrato íntegro de coordinación y conserva:
--     - SECURITY DEFINER y SET search_path = ''
--     - Restricción a cuentas permanentes (permanent_account_required)
--     - Piso mínimo antiabuso privado para link_general (evaluar_antiabuso_privado_determinista)
--     - Rate limiting server-side (check_rate_limit_internal('create_encounter', ''))
--       evaluado inmediatamente antes de la mutación productiva
--     - Generación exclusivamente server-side de id y public_token
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.crear_encuentro_con_opciones_seguro(
    p_data jsonb,
    p_opciones jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id uuid;
    v_enc_id uuid;
    v_token uuid;
    v_tema_invitacion text;
    v_deadline_raw text;
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
    v_dup_idx int;
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
    v_post_minutes integer;
    v_post_raw text;
    v_rl jsonb;
    v_priv_eval record;
BEGIN
    -- 1. Autenticación y exigencia de cuenta permanente
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF COALESCE((auth.jwt()->>'is_anonymous')::boolean, false) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 2. Validaciones estructurales de entrada
    IF p_data IS NULL OR pg_catalog.jsonb_typeof(p_data) <> 'object' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_data');
    END IF;

    IF p_opciones IS NULL OR pg_catalog.jsonb_typeof(p_opciones) <> 'array' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_options');
    END IF;

    v_opciones_count := pg_catalog.jsonb_array_length(p_opciones);
    IF v_opciones_count < 2 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'minimum_two_options');
    END IF;
    IF v_opciones_count > 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'maximum_three_options');
    END IF;

    -- 3. Validar opciones individuales, vigencia futura y duplicados
    FOR v_idx IN 0..v_opciones_count - 1 LOOP
        IF pg_catalog.jsonb_typeof(p_opciones->v_idx) <> 'object'
           OR NULLIF(pg_catalog.btrim(p_opciones->v_idx->>'fecha'), '') IS NULL
           OR NULLIF(pg_catalog.btrim(p_opciones->v_idx->>'hora_inicio'), '') IS NULL
        THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_option_format');
        END IF;

        BEGIN
            v_op_fecha := (p_opciones->v_idx->>'fecha')::date;
        EXCEPTION WHEN OTHERS THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_option_date');
        END;

        BEGIN
            v_op_hora := (p_opciones->v_idx->>'hora_inicio')::time;
        EXCEPTION WHEN OTHERS THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_option_time');
        END;

        v_op_ts := (v_op_fecha + v_op_hora) AT TIME ZONE 'America/Argentina/Buenos_Aires';

        IF v_op_ts <= pg_catalog.now() THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'option_in_past');
        END IF;

        IF v_min_opcion_ts IS NULL OR v_op_ts < v_min_opcion_ts THEN
            v_min_opcion_ts := v_op_ts;
        END IF;

        v_is_duplicate := false;
        IF v_arr_ts IS NOT NULL AND pg_catalog.array_length(v_arr_ts, 1) > 0 THEN
            FOR v_dup_idx IN 1..pg_catalog.array_length(v_arr_ts, 1) LOOP
                IF v_arr_ts[v_dup_idx] = v_op_ts THEN
                    v_is_duplicate := true;
                    EXIT;
                END IF;
            END LOOP;
        END IF;

        IF v_is_duplicate THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'duplicate_options');
        END IF;

        v_arr_fechas := pg_catalog.array_append(v_arr_fechas, v_op_fecha);
        v_arr_horas := pg_catalog.array_append(v_arr_horas, v_op_hora);
        v_arr_ts := pg_catalog.array_append(v_arr_ts, v_op_ts);
    END LOOP;

    -- 4. Validar plazo de respuesta opcional (response_deadline)
    v_deadline_raw := COALESCE(
        NULLIF(pg_catalog.btrim(p_data->>'response_deadline'), ''),
        NULLIF(pg_catalog.btrim(p_data->>'deadline'), '')
    );
    IF v_deadline_raw IS NOT NULL THEN
        BEGIN
            v_deadline := v_deadline_raw::timestamptz;
        EXCEPTION WHEN OTHERS THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_deadline');
        END;

        IF v_deadline <= pg_catalog.now() THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'deadline_in_past');
        END IF;

        IF v_deadline >= v_min_opcion_ts THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'deadline_after_options');
        END IF;
    ELSE
        v_deadline := NULL;
    END IF;

    -- 5. Validar duration_minutes opcional
    IF NULLIF(pg_catalog.btrim(p_data->>'duration_minutes'), '') IS NOT NULL THEN
        BEGIN
            v_duration_numeric := (p_data->>'duration_minutes')::numeric;
        EXCEPTION WHEN OTHERS THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_duration_minutes');
        END;

        IF pg_catalog.trunc(v_duration_numeric) <> v_duration_numeric
           OR v_duration_numeric < 15
           OR v_duration_numeric > 1440
        THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_duration_minutes');
        END IF;

        v_duration_minutes := v_duration_numeric::integer;
    ELSE
        v_duration_minutes := NULL;
    END IF;

    -- 6. Validar campos del encuentro
    v_titulo := NULLIF(pg_catalog.btrim(p_data->>'titulo'), '');
    IF v_titulo IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_required');
    END IF;

    v_modalidad := p_data->>'modalidad';
    IF v_modalidad IS NULL OR v_modalidad NOT IN ('presencial', 'virtual') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_modality');
    END IF;

    v_lugar_texto := NULLIF(pg_catalog.btrim(p_data->>'lugar_texto'), '');
    IF v_modalidad = 'presencial' AND v_lugar_texto IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'location_required');
    END IF;

    v_link_virtual := NULLIF(pg_catalog.btrim(p_data->>'link_virtual'), '');
    IF v_modalidad = 'virtual' AND v_link_virtual IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'virtual_link_required');
    END IF;

    v_tipo_invitacion := p_data->>'tipo_invitacion';
    IF v_tipo_invitacion IS NULL OR v_tipo_invitacion NOT IN ('individual', 'link_general') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_invitation_type');
    END IF;

    -- 7. Piso mínimo antiabuso para invitaciones coordinadas compartibles
    IF v_tipo_invitacion = 'link_general' THEN
        SELECT * INTO v_priv_eval
        FROM public.evaluar_antiabuso_privado_determinista(v_titulo, p_data->>'descripcion');
        IF NOT COALESCE(v_priv_eval.allowed, true) THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'private_content_blocked',
                'reason', v_priv_eval.reason,
                'message', 'El contenido de la invitación no cumple con las pautas de seguridad de la plataforma.'
            );
        END IF;
    END IF;

    v_tema := COALESCE(p_data->>'tema', 'blue');
    IF v_tema NOT IN ('blue', 'green', 'orange', 'purple') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_theme');
    END IF;

    v_tema_invitacion := CASE
        WHEN p_data->>'tema_invitacion' IN (
            'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
            'family', 'special', 'romantic', 'sports', 'entertainment',
            'learning', 'wellness', 'custom'
        ) THEN p_data->>'tema_invitacion'
        ELSE 'classic'
    END;

    v_visibilidad_respuestas := CASE
        WHEN p_data->>'visibilidad_respuestas_invitados' IN ('hidden', 'summary', 'detail')
            THEN p_data->>'visibilidad_respuestas_invitados'
        WHEN COALESCE((p_data->>'mostrar_respuestas_a_invitados')::boolean, false) = true
            THEN 'summary'
        ELSE 'hidden'
    END;

    v_mostrar_respuestas_a_invitados := (v_visibilidad_respuestas <> 'hidden');

    v_post_raw := NULLIF(pg_catalog.btrim(p_data->>'post_event_active_minutes'), '');
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

    -- 8. Rate limiter inmediatamente ANTES de la mutación productiva
    v_rl := public.check_rate_limit_internal('create_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- 9. Generación exclusivamente server-side de identificadores (ignora id / public_token del cliente)
    v_enc_id := gen_random_uuid();
    v_token := gen_random_uuid();

    -- 10. Inserción atómica del encuentro y sus opciones ordenadas cronológicamente
    INSERT INTO public.encuentros (
        id, titulo, descripcion, modalidad, lugar_texto, link_virtual,
        tipo_invitacion, host_id, public_token, estado, tema, tema_invitacion, invitation_template,
        date_mode, coordination_status, response_deadline, duration_minutes, fecha, hora, selected_option_id,
        mostrar_respuestas_a_invitados, visibilidad_respuestas_invitados,
        post_event_active_minutes
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
        v_visibilidad_respuestas,
        v_post_minutes
    );

    FOR v_op IN (
        SELECT f, h
        FROM unnest(v_arr_fechas, v_arr_horas, v_arr_ts) AS t(f, h, ts)
        ORDER BY ts ASC
    ) LOOP
        INSERT INTO public.encuentro_opciones_fecha (
            encuentro_id,
            fecha,
            hora_inicio,
            orden
        )
        VALUES (
            v_enc_id,
            v_op.f,
            v_op.h,
            v_ord
        );
        v_ord := v_ord + 1;
    END LOOP;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', v_enc_id,
        'public_token', v_token,
        'date_mode', 'coordination',
        'opciones_count', v_opciones_count,
        'encuentro', pg_catalog.json_build_object(
            'id', v_enc_id,
            'public_token', v_token
        )
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) TO authenticated, postgres, service_role;

COMMIT;
