-- ============================================================
-- Migration: Enforce Generic Rate Limiting on Core Social Actions
-- Module: Fase 2.0-C1 Antiabuso Core — T5-B2
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. crear_encuentro_seguro (HARDENED + RATE LIMITED)
-- Action: 'create_encounter' (comparte bucket con con_opciones)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_encuentro_seguro(p_data jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id          uuid := auth.uid();
    v_id               uuid;
    v_token            uuid;
    v_result           json;
    v_tema_invitacion  text;
    v_post_minutes     integer;
    v_post_raw         text;
    v_rl               jsonb;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
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

    -- Leer post_event_active_minutes de forma robusta
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

    -- ENFORCEMENT DE RATE LIMITING SERVER-SIDE (action: create_encounter)
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
GRANT EXECUTE ON FUNCTION public.crear_encuentro_seguro(jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 2. crear_encuentro_con_opciones_seguro (HARDENED + RATE LIMITED)
-- Action: 'create_encounter' (comparte bucket con crear simple)
-- ------------------------------------------------------------
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
    v_rl jsonb;
BEGIN
    -- 1. Autenticación forzada por token JWT
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- Solo permitir a cuentas permanentes
    IF COALESCE((auth.jwt()->>'is_anonymous')::boolean, false) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 2. Validar estructura de p_data
    IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_data');
    END IF;

    -- 3. Validar estructura de opciones
    IF p_opciones IS NULL OR jsonb_typeof(p_opciones) <> 'array' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_options');
    END IF;

    v_opciones_count := jsonb_array_length(p_opciones);
    IF v_opciones_count < 2 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'minimum_two_options');
    END IF;
    IF v_opciones_count > 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'maximum_three_options');
    END IF;

    -- 4. Validar opciones individuales
    FOR v_idx IN 0..jsonb_array_length(p_opciones)-1 LOOP
        v_op_fecha := (p_opciones->v_idx->>'fecha')::date;
        v_op_hora := (p_opciones->v_idx->>'hora_inicio')::time;

        IF v_op_fecha IS NULL OR v_op_hora IS NULL THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_option_format');
        END IF;

        v_op_ts := (v_op_fecha + v_op_hora) AT TIME ZONE 'America/Argentina/Buenos_Aires';

        IF v_op_ts < pg_catalog.now() THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'option_in_past');
        END IF;

        IF v_min_opcion_ts IS NULL OR v_op_ts < v_min_opcion_ts THEN
            v_min_opcion_ts := v_op_ts;
        END IF;

        v_is_duplicate := false;
        IF v_arr_ts IS NOT NULL THEN
            FOR v_idx IN 1..array_length(v_arr_ts, 1) LOOP
                IF v_arr_ts[v_idx] = v_op_ts THEN
                    v_is_duplicate := true;
                    EXIT;
                END IF;
            END LOOP;
        END IF;

        IF v_is_duplicate THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'duplicate_options');
        END IF;

        v_arr_fechas := array_append(v_arr_fechas, v_op_fecha);
        v_arr_horas := array_append(v_arr_horas, v_op_hora);
        v_arr_ts := array_append(v_arr_ts, v_op_ts);
    END LOOP;

    -- 5. Validar deadline
    IF p_data->>'response_deadline' IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'deadline_required');
    END IF;

    BEGIN
        v_deadline := (p_data->>'response_deadline')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_deadline_format');
    END;

    IF v_deadline <= pg_catalog.now() THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'deadline_in_past');
    END IF;

    IF v_deadline > v_min_opcion_ts THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'deadline_after_earliest_option');
    END IF;

    v_titulo := NULLIF(btrim(p_data->>'titulo'), '');
    IF v_titulo IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_required');
    END IF;

    v_modalidad := p_data->>'modalidad';
    IF v_modalidad IS NULL OR v_modalidad NOT IN ('presencial', 'virtual') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_modality');
    END IF;

    v_lugar_texto := NULLIF(btrim(p_data->>'lugar_texto'), '');
    IF v_modalidad = 'presencial' AND v_lugar_texto IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'location_required');
    END IF;

    v_link_virtual := NULLIF(btrim(p_data->>'link_virtual'), '');
    IF v_modalidad = 'virtual' AND v_link_virtual IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'virtual_link_required');
    END IF;

    v_tipo_invitacion := p_data->>'tipo_invitacion';
    IF v_tipo_invitacion IS NULL OR v_tipo_invitacion NOT IN ('individual', 'link_general') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_invitation_type');
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

    -- ENFORCEMENT DE RATE LIMITING SERVER-SIDE (action: create_encounter)
    v_rl := public.check_rate_limit_internal('create_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
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

    -- 8. Inserción Atómica de Opciones de Fecha
    FOR v_idx IN 1..array_length(v_arr_fechas, 1) LOOP
        INSERT INTO public.encuentro_opciones_fecha (
            encuentro_id,
            fecha,
            hora_inicio,
            orden
        )
        VALUES (
            v_enc_id,
            v_arr_fechas[v_idx],
            v_arr_horas[v_idx],
            v_ord
        );
        v_ord := v_ord + 1;
    END LOOP;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', v_enc_id,
        'public_token', v_token,
        'date_mode', 'coordination',
        'opciones_count', v_opciones_count
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 3. crear_intencion_segura (HARDENED + RATE LIMITED)
-- Action: 'create_intention'
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_intencion_segura(
    p_titulo TEXT,
    p_descripcion TEXT DEFAULT NULL,
    p_temporalidad_texto TEXT DEFAULT NULL,
    p_fecha_desde DATE DEFAULT NULL,
    p_fecha_hasta DATE DEFAULT NULL,
    p_modalidad TEXT DEFAULT 'presencial',
    p_locality_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_titulo_clean TEXT;
    v_modalidad_clean TEXT;
    v_new_id UUID;
    v_rl JSONB;
BEGIN
    -- Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- Rechazar cuentas anónimas (se requiere cuenta permanente para intenciones persistentes)
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- Validar título
    v_titulo_clean := trim(COALESCE(p_titulo, ''));
    IF v_titulo_clean = '' OR length(p_titulo) > 120 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_title');
    END IF;

    -- Validar modalidad
    v_modalidad_clean := trim(COALESCE(p_modalidad, 'presencial'));
    IF v_modalidad_clean NOT IN ('presencial', 'virtual', 'indistinto') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_modality');
    END IF;

    -- Validar rango de fechas
    IF p_fecha_desde IS NOT NULL AND p_fecha_hasta IS NOT NULL AND p_fecha_desde > p_fecha_hasta THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_date_range');
    END IF;

    -- Validar localidad si fue provista
    IF p_locality_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.localidades WHERE id = p_locality_id AND activo = true) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_locality');
        END IF;
    END IF;

    -- ENFORCEMENT DE RATE LIMITING SERVER-SIDE (action: create_intention)
    v_rl := public.check_rate_limit_internal('create_intention', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- Inserción segura con user_id derivado exclusivamente de auth.uid()
    INSERT INTO public.intenciones (
        user_id,
        titulo,
        descripcion,
        temporalidad_texto,
        fecha_desde,
        fecha_hasta,
        modalidad,
        locality_id,
        estado
    ) VALUES (
        v_user_id,
        v_titulo_clean,
        NULLIF(trim(COALESCE(p_descripcion, '')), ''),
        NULLIF(trim(COALESCE(p_temporalidad_texto, '')), ''),
        p_fecha_desde,
        p_fecha_hasta,
        v_modalidad_clean,
        p_locality_id,
        'activa'
    )
    RETURNING id INTO v_new_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.crear_intencion_segura(TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_intencion_segura(TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 4. solicitar_sumarse_encuentro_abierto (HARDENED + COOLDOWN + RATE LIMITED)
-- Action: 'join_open_encounter'
-- Cooldown: 6 horas desde último rejected (resolved_at o fallback)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.solicitar_sumarse_encuentro_abierto(
    p_encuentro_id UUID,
    p_nombre TEXT,
    p_mensaje TEXT DEFAULT NULL,
    p_usuario_id UUID DEFAULT NULL  -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_solicitud_id UUID;
    v_clean_nombre TEXT;
    v_rejected_at TIMESTAMPTZ;
    v_rl JSONB;
BEGIN
    -- SEGURIDAD: identidad obligatoria y permanente
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_clean_nombre := trim(COALESCE(p_nombre, ''));
    IF length(v_clean_nombre) < 2 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_name');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    IF v_encuentro.is_open <> true THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_open');
    END IF;

    -- Validar que no sea el host
    IF v_encuentro.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_join_own_encounter');
    END IF;

    -- ENFORCEMENT DE BLOQUEO BILATERAL (Fail-closed silencioso)
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_encuentro.host_id)
           OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_open');
    END IF;

    -- Validar que no tenga ya una solicitud pendiente
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado = 'pending'
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'duplicate_pending_request');
    END IF;

    -- Validar que no sea ya un participante confirmado (por usuario_id en solicitudes aprobadas)
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado = 'approved'
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_participant');
    END IF;

    -- Validar cupo disponible
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado = 'confirmado';

    IF (v_confirmed_count + 1) >= v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_full');
    END IF;

    -- COOLDOWN POST-RECHAZO (6 horas desde el timestamp efectivo del último rejected para este encuentro)
    -- Fuente canónica: resolved_at. Tolerancia legacy: updated_at, created_at.
    SELECT COALESCE(resolved_at, updated_at, created_at)
    INTO v_rejected_at
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
      AND estado = 'rejected'
    ORDER BY COALESCE(resolved_at, updated_at, created_at) DESC
    LIMIT 1;

    IF v_rejected_at IS NOT NULL AND pg_catalog.now() < (v_rejected_at + interval '6 hours') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_available');
    END IF;

    -- ENFORCEMENT DE RATE LIMITING SERVER-SIDE (action: join_open_encounter)
    v_rl := public.check_rate_limit_internal('join_open_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- Insertar solicitud
    INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id,
        usuario_id,
        nombre_solicitante,
        mensaje,
        estado
    ) VALUES (
        p_encuentro_id,
        v_user_id,
        v_clean_nombre,
        NULLIF(trim(p_mensaje), ''),
        'pending'
    ) RETURNING id INTO v_solicitud_id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', v_solicitud_id,
        'estado', 'pending'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID)
    TO authenticated;

COMMIT;
