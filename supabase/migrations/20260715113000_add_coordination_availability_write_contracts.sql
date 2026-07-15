BEGIN;

-- 1. Índice requerido
CREATE INDEX IF NOT EXISTS idx_disp_encuentro_opcion
ON public.participante_disponibilidades (
    encuentro_id,
    opcion_fecha_id
);

-- 2. RPC Público
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

-- 3. RPC Individual
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

-- 4. get_coordinacion_host_seguro (Contract match)
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

-- 5. get_coordinacion_participante_seguro
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
            'derived_status', CASE 
                WHEN v_enc.coordination_status = 'closed' THEN 'closed'
                WHEN v_enc.coordination_status = 'open' AND v_enc.response_deadline IS NOT NULL AND now() >= v_enc.response_deadline THEN 'deadline_passed'
                ELSE 'open'
            END,
            'opciones', COALESCE((SELECT json_agg(json_build_object('id', id, 'fecha', fecha, 'hora_inicio', hora_inicio, 'orden', orden, 'selected', COALESCE(id = v_enc.selected_option_id, false)) ORDER BY orden ASC) FROM opc_base), '[]'::json),
            'mis_respuestas', COALESCE((
                SELECT json_agg(
                    json_build_object(
                        'opcion_fecha_id', pd.opcion_fecha_id,
                        'respuesta', pd.respuesta,
                        'es_preferida', pd.es_preferida
                    ) ORDER BY ob.orden ASC
                )
                FROM public.participante_disponibilidades pd
                JOIN opc_base ob ON ob.id = pd.opcion_fecha_id
                WHERE pd.participante_id = v_participante.id AND pd.encuentro_id = v_enc.id
            ), '[]'::json)
        )
    );
END;
$$;

-- 6. responder_participante_seguro (literal with guards)
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

    IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'invalid_date_mode'
      );
    END IF;

    v_inicio_local := v_encuentro.fecha + v_encuentro.hora;
    v_limite_local := v_inicio_local + interval '45 minutes';
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

  SELECT * INTO v_encuentro FROM public.encuentros WHERE public_token = v_token_uuid;

  IF FOUND THEN
    IF v_encuentro.estado = 'cancelado' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'cancelled');
    END IF;

    IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'invalid_date_mode'
      );
    END IF;

    v_inicio_local := v_encuentro.fecha + v_encuentro.hora;
    v_limite_local := v_inicio_local + interval '45 minutes';
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

-- 7. Grants Finales
REVOKE ALL ON FUNCTION public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_coordinacion_host_seguro(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_coordinacion_participante_seguro(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.responder_participante_seguro(text,text,text,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_participante_seguro(text) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_coordinacion_host_seguro(uuid) TO authenticated;

-- Restaurar grants requeridos a roles de admin para las modificadas
GRANT EXECUTE ON FUNCTION public.get_coordinacion_host_seguro(uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.get_coordinacion_participante_seguro(text) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.responder_participante_seguro(text,text,text,text) TO anon, authenticated, postgres, service_role;
GRANT EXECUTE ON FUNCTION public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb) TO postgres, service_role;

COMMIT;
