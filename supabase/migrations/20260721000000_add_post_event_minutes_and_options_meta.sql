-- ============================================================
-- MIGRACIÓN: 20260721000000_add_post_event_minutes_and_options_meta.sql
-- Versión: v2 (corregida)
--
-- CAMBIOS vs v1:
--   - Casteo robusto de post_event_active_minutes (EXCEPTION interno)
--   - responder_participante_seguro: reemplaza interval '45 minutes'
--     por make_interval(mins => COALESCE(v_encuentro.post_event_active_minutes, 45))
--   - get_encuentros_participados_seguro: agrega link_virtual,
--     public_token, host_id, reemplaza_a (campos que ya tenía host_seguro
--     pero faltaban en participados)
--   - NOTIFY pgrst, 'reload schema' al final
--
-- NO MODIFICA: visibilidad_respuestas_invitados / hidden / summary / detail
-- NO USA: public.to_argentina_time
-- NO MODIFICA: cancelar_encuentro_seguro, eliminar_encuentro_seguro
-- ============================================================

BEGIN;

-- ============================================================
-- 1. NUEVA COLUMNA post_event_active_minutes
-- ============================================================

ALTER TABLE public.encuentros
ADD COLUMN IF NOT EXISTS post_event_active_minutes integer;

UPDATE public.encuentros
SET post_event_active_minutes = 45
WHERE post_event_active_minutes IS NULL;

ALTER TABLE public.encuentros
ALTER COLUMN post_event_active_minutes SET DEFAULT 45;

ALTER TABLE public.encuentros
ALTER COLUMN post_event_active_minutes SET NOT NULL;

ALTER TABLE public.encuentros
DROP CONSTRAINT IF EXISTS encuentros_post_event_active_minutes_check;

ALTER TABLE public.encuentros
ADD CONSTRAINT encuentros_post_event_active_minutes_check
CHECK (post_event_active_minutes BETWEEN 0 AND 1440);

-- ============================================================
-- 2. crear_encuentro_seguro
--    Base: 20260713145000_harden_host_auth_and_data_access.sql (L481)
--    Cambio: agrega lectura robusta y escritura de post_event_active_minutes
-- ============================================================
CREATE OR REPLACE FUNCTION public.crear_encuentro_seguro(p_data jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id          uuid := auth.uid();
    v_id               uuid;
    v_token            uuid;
    v_result           json;
    v_tema_invitacion  text;
    v_post_minutes     integer;
    v_post_raw         text;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    v_id    := COALESCE((p_data->>'id')::uuid, gen_random_uuid());
    v_token := COALESCE((p_data->>'public_token')::uuid, gen_random_uuid());

    v_tema_invitacion := CASE
        WHEN p_data->>'tema_invitacion' IN (
            'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
            'family', 'special', 'romantic', 'sports', 'entertainment',
            'learning', 'wellness', 'custom'
        )
        THEN p_data->>'tema_invitacion'
        ELSE 'classic'
    END;

    -- Leer post_event_active_minutes de forma robusta:
    -- si no viene → 45
    -- si viene no numérico → error controlado
    -- si viene fuera de rango → error controlado
    v_post_raw := p_data->>'post_event_active_minutes';
    IF v_post_raw IS NOT NULL THEN
        BEGIN
            v_post_minutes := v_post_raw::integer;
        EXCEPTION WHEN OTHERS THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END;
        IF v_post_minutes < 0 OR v_post_minutes > 1440 THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END IF;
    ELSE
        v_post_minutes := 45;
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
        json_build_object(
            'ok', true,
            'id', id,
            'public_token', public_token
        ) INTO v_result;

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.crear_encuentro_seguro(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_seguro(jsonb) TO authenticated;

-- ============================================================
-- 3. crear_encuentro_con_opciones_seguro
--    Base: 20260720000001_update_rpcs_coordination_visibility_mode.sql (L107)
--    Cambio: agrega lectura robusta y escritura de post_event_active_minutes
--    PRESERVA: visibilidad_respuestas_invitados, mostrar_respuestas_a_invitados,
--              toda la lógica existente de validación de opciones y deadline
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
    v_post_minutes integer;
    v_post_raw text;
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

        -- Conversión inline segura — sin public.to_argentina_time
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

    -- Visibilidad: preservar lógica existente en producción sin cambios
    v_visibilidad_respuestas := CASE
        WHEN p_data->>'visibilidad_respuestas_invitados' IN ('hidden', 'summary', 'detail')
            THEN p_data->>'visibilidad_respuestas_invitados'
        WHEN COALESCE((p_data->>'mostrar_respuestas_a_invitados')::boolean, false) = true
            THEN 'summary'
        ELSE 'hidden'
    END;

    v_mostrar_respuestas_a_invitados := (v_visibilidad_respuestas <> 'hidden');

    -- Leer post_event_active_minutes de forma robusta
    v_post_raw := p_data->>'post_event_active_minutes';
    IF v_post_raw IS NOT NULL THEN
        BEGIN
            v_post_minutes := v_post_raw::integer;
        EXCEPTION WHEN OTHERS THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END;
        IF v_post_minutes < 0 OR v_post_minutes > 1440 THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END IF;
    ELSE
        v_post_minutes := 45;
    END IF;

    -- 6. Generación server-side de identificadores
    v_enc_id := gen_random_uuid();
    v_token := gen_random_uuid();

    -- 7. Inserción Atómica del Encuentro
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
-- 4. get_encuentros_host_seguro
--    Base: 20260714165000_add_coordination_backend_read_contracts.sql (L592)
--    Cambio: agrega post_event_active_minutes, last_option_at, has_future_options
--    PRESERVA: todos los campos existentes, filtros, orden
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
            -- NUEVO: margen post-evento por encuentro
            'post_event_active_minutes', COALESCE(e.post_event_active_minutes, 45),
            -- NUEVO: timestamp de la última opción (timestamptz normalizado a Argentina)
            'last_option_at',            (
                SELECT MAX(
                    (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                )
                FROM public.encuentro_opciones_fecha o
                WHERE o.encuentro_id = e.id
            ),
            -- NUEVO: ¿existe alguna opción aún no vencida (con margen)?
            'has_future_options',        (
                EXISTS (
                    SELECT 1
                    FROM public.encuentro_opciones_fecha o
                    WHERE o.encuentro_id = e.id
                      AND (
                          (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                          + make_interval(mins => COALESCE(e.post_event_active_minutes, 45))
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
-- 5. get_encuentros_participados_seguro
--    Base: 20260719140000_update_participados_coordination.sql
--    Cambio: agrega post_event_active_minutes, last_option_at, has_future_options
--    CORRIGE: agrega link_virtual, public_token, host_id, reemplaza_a
--             (campos que existían en host_seguro pero faltaban aquí)
--    PRESERVA: _mi_estado, _mi_mensaje, _mi_token_invitacion,
--              lógica WHERE de participados coordinados por disponibilidad,
--              todos los demás campos existentes
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
            'link_virtual',          e.link_virtual,         -- CORREGIDO: faltaba
            'tipo_invitacion',       e.tipo_invitacion,
            'host_id',               e.host_id,              -- CORREGIDO: faltaba
            'public_token',          e.public_token,         -- CORREGIDO: faltaba
            'reemplaza_a',           e.reemplaza_a,          -- CORREGIDO: faltaba
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
            -- NUEVO: margen post-evento por encuentro
            'post_event_active_minutes', COALESCE(e.post_event_active_minutes, 45),
            -- NUEVO: timestamp de la última opción
            'last_option_at',            (
                SELECT MAX(
                    (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                )
                FROM public.encuentro_opciones_fecha o
                WHERE o.encuentro_id = e.id
            ),
            -- NUEVO: ¿existe alguna opción aún no vencida (con margen)?
            'has_future_options',        (
                EXISTS (
                    SELECT 1
                    FROM public.encuentro_opciones_fecha o
                    WHERE o.encuentro_id = e.id
                      AND (
                          (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                          + make_interval(mins => COALESCE(e.post_event_active_minutes, 45))
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
-- 6. responder_participante_seguro
--    Base: 20260718130000_allow_closed_coordination_response.sql
--    Cambio: reemplaza interval '45 minutes' (hardcodeado) por
--            make_interval(mins => COALESCE(v_encuentro.post_event_active_minutes, 45))
--    PRESERVA: toda la lógica existente (fecha_mode, coordination_status,
--              cancelado, INSERT/UPDATE, link_virtual condicional,
--              grants a anon/authenticated/postgres/service_role)
-- ============================================================
CREATE OR REPLACE FUNCTION public.responder_participante_seguro(
    p_token text,
    p_estado text,
    p_nombre text DEFAULT NULL::text,
    p_mensaje text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_encuentro encuentros%ROWTYPE;
  v_participante participantes%ROWTYPE;
  v_token_uuid uuid;
  v_token_nuevo uuid;
  v_inicio_local timestamp;
  v_limite_local timestamp;
  v_ahora_local timestamp;
  v_nombre_limpio text;
  v_tipo_respuesta text;
BEGIN
  IF p_token IS NULL OR trim(p_token) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_token');
  END IF;

  IF p_estado NOT IN ('confirmado', 'rechazado') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_estado');
  END IF;

  BEGIN
    v_token_uuid := p_token::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END;

  v_nombre_limpio := NULLIF(trim(p_nombre), '');

  -- RAMA 1: token es token_invitacion individual
  SELECT * INTO v_participante
  FROM public.participantes
  WHERE token_invitacion = v_token_uuid;

  IF FOUND THEN
    SELECT * INTO v_encuentro FROM public.encuentros WHERE id = v_participante.encuentro_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'meeting_not_found');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'cancelled');
    END IF;

    -- Permitir si es fixed, o si es coordination cerrada
    IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' AND
       NOT (v_encuentro.date_mode = 'coordination' AND v_encuentro.coordination_status = 'closed') THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'invalid_date_mode'
      );
    END IF;

    v_inicio_local := v_encuentro.fecha + v_encuentro.hora;
    -- CORREGIDO: usa post_event_active_minutes del encuentro en vez de '45 minutes' fijo
    v_limite_local := v_inicio_local + make_interval(mins => COALESCE(v_encuentro.post_event_active_minutes, 45));
    v_ahora_local := now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

    IF v_ahora_local > v_limite_local THEN
      RETURN jsonb_build_object('ok', false, 'error', 'meeting_expired');
    END IF;

    UPDATE public.participantes
    SET estado = p_estado,
        mensaje_respuesta = p_mensaje,
        respondido_en = now(),
        nombre_invitado = COALESCE(v_nombre_limpio, nombre_invitado)
    WHERE id = v_participante.id
    RETURNING * INTO v_participante;

    v_tipo_respuesta := CASE WHEN v_participante.tipo_invitacion = 'generico' THEN 'general' ELSE v_participante.tipo_invitacion END;

    RETURN jsonb_build_object(
      'ok', true,
      'tipo', v_tipo_respuesta,
      'id', v_participante.id,
      'encuentro_id', v_participante.encuentro_id,
      'token_invitacion', v_participante.token_invitacion,
      'estado', v_participante.estado,
      'link_virtual', CASE WHEN v_participante.estado = 'confirmado' AND v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual ELSE NULL END
    );
  END IF;

  -- RAMA 2: token es public_token (respuesta general al encuentro)
  SELECT * INTO v_encuentro FROM public.encuentros WHERE public_token = v_token_uuid;

  IF FOUND THEN
    IF v_encuentro.estado = 'cancelado' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'cancelled');
    END IF;

    -- Permitir si es fixed, o si es coordination cerrada
    IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' AND
       NOT (v_encuentro.date_mode = 'coordination' AND v_encuentro.coordination_status = 'closed') THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'invalid_date_mode'
      );
    END IF;

    v_inicio_local := v_encuentro.fecha + v_encuentro.hora;
    -- CORREGIDO: usa post_event_active_minutes del encuentro en vez de '45 minutes' fijo
    v_limite_local := v_inicio_local + make_interval(mins => COALESCE(v_encuentro.post_event_active_minutes, 45));
    v_ahora_local := now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

    IF v_ahora_local > v_limite_local THEN
      RETURN jsonb_build_object('ok', false, 'error', 'meeting_expired');
    END IF;

    v_token_nuevo := gen_random_uuid();

    INSERT INTO public.participantes (
      encuentro_id,
      nombre_invitado,
      tipo_invitacion,
      estado,
      mensaje_respuesta,
      token_invitacion,
      respondido_en
    ) VALUES (
      v_encuentro.id,
      v_nombre_limpio,
      'generico',
      p_estado,
      p_mensaje,
      v_token_nuevo,
      now()
    ) RETURNING * INTO v_participante;

    v_tipo_respuesta := CASE WHEN v_participante.tipo_invitacion = 'generico' THEN 'general' ELSE v_participante.tipo_invitacion END;

    RETURN jsonb_build_object(
      'ok', true,
      'tipo', v_tipo_respuesta,
      'id', v_participante.id,
      'encuentro_id', v_participante.encuentro_id,
      'token_invitacion', v_participante.token_invitacion,
      'estado', v_participante.estado,
      'link_virtual', CASE WHEN v_participante.estado = 'confirmado' AND v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual ELSE NULL END
    );
  END IF;

  RETURN jsonb_build_object('ok', false, 'error', 'not_found');
END;
$$;

-- Preservar grants exactos de la versión anterior
REVOKE ALL ON FUNCTION public.responder_participante_seguro(text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.responder_participante_seguro(text,text,text,text) TO anon, authenticated, postgres, service_role;

COMMIT;

-- Recargar schema de PostgREST/Supabase para que tome los nuevos contratos
NOTIFY pgrst, 'reload schema';
