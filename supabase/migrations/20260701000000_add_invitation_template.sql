-- ============================================================
-- Migración para Templates de Celebraciones Infantiles
-- ============================================================

-- 1. Aseguramos que existan las columnas en la tabla encuentros
ALTER TABLE public.encuentros
ADD COLUMN IF NOT EXISTS tema_invitacion text;

ALTER TABLE public.encuentros
ADD COLUMN IF NOT EXISTS invitation_template text;

-- ============================================================
-- RPCs DE ESCRITURA
-- ============================================================

-- 2. Actualizar rpc_crear_seguro para incluir invitation_template
CREATE OR REPLACE FUNCTION public.crear_encuentro_seguro(p_data jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_id               uuid;
    v_token            uuid;
    v_result           json;
    v_tema_invitacion  text;
BEGIN
    v_id    := COALESCE((p_data->>'id')::uuid, gen_random_uuid());
    v_token := COALESCE((p_data->>'public_token')::uuid, gen_random_uuid());

    v_tema_invitacion := CASE
        WHEN p_data->>'tema_invitacion' IN (
            'classic',
            'formal',
            'friends',
            'celebration',
            'kids_birthday',
            'family',
            'special'
        )
        THEN p_data->>'tema_invitacion'
        ELSE 'classic'
    END;

    INSERT INTO public.encuentros (
        id,
        titulo,
        descripcion,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        link_virtual,
        tipo_invitacion,
        host_id,
        public_token,
        estado,
        tema,
        tema_invitacion,
        invitation_template,
        reemplaza_a
    ) VALUES (
        v_id,
        p_data->>'titulo',
        p_data->>'descripcion',
        (p_data->>'fecha')::date,
        (p_data->>'hora')::time,
        p_data->>'modalidad',
        p_data->>'lugar_texto',
        p_data->>'link_virtual',
        p_data->>'tipo_invitacion',
        (p_data->>'host_id')::uuid,
        v_token,
        COALESCE(p_data->>'estado', 'activo'),
        COALESCE(p_data->>'tema', 'blue'),
        v_tema_invitacion,
        p_data->>'invitation_template',
        CASE
            WHEN p_data->>'reemplaza_a' IS NOT NULL
             AND p_data->>'reemplaza_a' != 'null'
            THEN (p_data->>'reemplaza_a')::uuid
            ELSE NULL
        END
    );

    SELECT json_build_object(
        'id',               e.id,
        'titulo',           e.titulo,
        'descripcion',      e.descripcion,
        'fecha',            e.fecha,
        'hora',             e.hora,
        'modalidad',        e.modalidad,
        'lugar_texto',      e.lugar_texto,
        'link_virtual',     e.link_virtual,
        'tipo_invitacion',  e.tipo_invitacion,
        'host_id',          e.host_id,
        'public_token',     e.public_token,
        'estado',           e.estado,
        'tema',             e.tema,
        'tema_invitacion',  COALESCE(e.tema_invitacion, 'classic'),
        'invitation_template', e.invitation_template,
        'reemplaza_a',      e.reemplaza_a,
        'creado_en',        e.creado_en
    )
    INTO v_result
    FROM public.encuentros e
    WHERE e.id = v_id;

    RETURN v_result;
END;
$function$;

-- 3. Actualizar actualizar_encuentro_seguro para incluir invitation_template y tema_invitacion
CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro(p_encuentro_id uuid, p_host_id uuid, p_data jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_encuentro record;
BEGIN
    SELECT id, host_id
    INTO v_encuentro
    FROM encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> p_host_id THEN
        RETURN json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    UPDATE encuentros
    SET
        titulo = COALESCE(p_data->>'titulo', titulo),
        descripcion = CASE
            WHEN p_data ? 'descripcion' THEN p_data->>'descripcion'
            ELSE descripcion
        END,
        fecha = CASE
            WHEN p_data ? 'fecha' THEN (p_data->>'fecha')::date
            ELSE fecha
        END,
        hora = CASE
            WHEN p_data ? 'hora' THEN (p_data->>'hora')::time
            ELSE hora
        END,
        modalidad = COALESCE(p_data->>'modalidad', modalidad),
        lugar_texto = CASE
            WHEN p_data ? 'lugar_texto' THEN p_data->>'lugar_texto'
            ELSE lugar_texto
        END,
        link_virtual = CASE
            WHEN p_data ? 'link_virtual' THEN p_data->>'link_virtual'
            ELSE link_virtual
        END,
        tipo_invitacion = COALESCE(p_data->>'tipo_invitacion', tipo_invitacion),
        estado = COALESCE(p_data->>'estado', estado),
        tema = CASE
            WHEN p_data ? 'tema' THEN p_data->>'tema'
            ELSE tema
        END,
        tema_invitacion = CASE
            WHEN p_data ? 'tema_invitacion' THEN p_data->>'tema_invitacion'
            ELSE tema_invitacion
        END,
        invitation_template = CASE
            WHEN p_data ? 'invitation_template' THEN p_data->>'invitation_template'
            ELSE invitation_template
        END,
        reemplaza_a = CASE
            WHEN p_data ? 'reemplaza_a' AND p_data->>'reemplaza_a' IS NOT NULL AND p_data->>'reemplaza_a' <> ''
                THEN (p_data->>'reemplaza_a')::uuid
            WHEN p_data ? 'reemplaza_a'
                THEN NULL
            ELSE reemplaza_a
        END
    WHERE id = p_encuentro_id;

    RETURN json_build_object(
        'ok', true,
        'id', p_encuentro_id
    );
END;
$function$;


-- ============================================================
-- RPCs DE LECTURA
-- ============================================================

-- 4. Actualizar get_detalle_host_seguro
CREATE OR REPLACE FUNCTION public.get_detalle_host_seguro(p_encuentro_id uuid, p_host_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_encuentro record;
BEGIN
    SELECT
        id,
        titulo,
        descripcion,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        link_virtual,
        tipo_invitacion,
        host_id,
        public_token,
        estado,
        tema,
        tema_invitacion,
        invitation_template,
        reemplaza_a,
        creado_en
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> p_host_id THEN
        RETURN json_build_object('error', 'unauthorized');
    END IF;

    RETURN json_build_object(
        'id',               v_encuentro.id,
        'titulo',           v_encuentro.titulo,
        'descripcion',      v_encuentro.descripcion,
        'fecha',            v_encuentro.fecha,
        'hora',             v_encuentro.hora,
        'modalidad',        v_encuentro.modalidad,
        'lugar_texto',      v_encuentro.lugar_texto,
        'link_virtual',     v_encuentro.link_virtual,
        'tipo_invitacion',  v_encuentro.tipo_invitacion,
        'host_id',          v_encuentro.host_id,
        'public_token',     v_encuentro.public_token,
        'estado',           v_encuentro.estado,
        'tema',             v_encuentro.tema,
        'tema_invitacion',  COALESCE(v_encuentro.tema_invitacion, 'classic'),
        'invitation_template', v_encuentro.invitation_template,
        'reemplaza_a',      v_encuentro.reemplaza_a,
        'creado_en',        v_encuentro.creado_en
    );
END;
$function$;

-- 5. Actualizar get_encuentro_por_public_token
CREATE OR REPLACE FUNCTION public.get_encuentro_por_public_token(p_public_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_token_uuid uuid;
    v_encuentro  record;
BEGIN
    BEGIN
        v_token_uuid := p_public_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN NULL;
    END;

    SELECT
        id,
        titulo,
        descripcion,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        estado,
        tema,
        tema_invitacion,
        invitation_template,
        creado_en
    INTO v_encuentro
    FROM public.encuentros
    WHERE public_token = v_token_uuid;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN json_build_object(
        'id',               v_encuentro.id,
        'titulo',           v_encuentro.titulo,
        'descripcion',      v_encuentro.descripcion,
        'fecha',            v_encuentro.fecha,
        'hora',             v_encuentro.hora,
        'modalidad',        v_encuentro.modalidad,
        'lugar_texto',      v_encuentro.lugar_texto,
        'estado',           v_encuentro.estado,
        'tema',             v_encuentro.tema,
        'tema_invitacion',  COALESCE(v_encuentro.tema_invitacion, 'classic'),
        'invitation_template', v_encuentro.invitation_template,
        'creado_en',        v_encuentro.creado_en
    );
END;
$function$;

-- 6. Actualizar get_participante_seguro
CREATE OR REPLACE FUNCTION public.get_participante_seguro(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_token_uuid   uuid;
    v_participante record;
    v_encuentro    record;
BEGIN
    BEGIN
        v_token_uuid := p_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN NULL;
    END;

    SELECT
        id,
        encuentro_id,
        nombre_invitado,
        tipo_invitacion,
        estado,
        creado_en,
        respondido_en,
        token_invitacion,
        mensaje_respuesta
    INTO v_participante
    FROM public.participantes
    WHERE token_invitacion = v_token_uuid;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT
        id,
        titulo,
        descripcion,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        estado,
        tema,
        tema_invitacion,
        invitation_template,
        creado_en,
        link_virtual
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_participante.encuentro_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN json_build_object(
        'id',                v_participante.id,
        'encuentro_id',      v_participante.encuentro_id,
        'nombre_invitado',   v_participante.nombre_invitado,
        'tipo_invitacion',   v_participante.tipo_invitacion,
        'estado',            v_participante.estado,
        'creado_en',         v_participante.creado_en,
        'respondido_en',     v_participante.respondido_en,
        'token_invitacion',  v_participante.token_invitacion,
        'mensaje_respuesta', v_participante.mensaje_respuesta,
        'encuentros', json_build_object(
            'id',               v_encuentro.id,
            'titulo',           v_encuentro.titulo,
            'descripcion',      v_encuentro.descripcion,
            'fecha',            v_encuentro.fecha,
            'hora',             v_encuentro.hora,
            'modalidad',        v_encuentro.modalidad,
            'lugar_texto',      v_encuentro.lugar_texto,
            'estado',           v_encuentro.estado,
            'tema',             v_encuentro.tema,
            'tema_invitacion',  COALESCE(v_encuentro.tema_invitacion, 'classic'),
            'invitation_template', v_encuentro.invitation_template,
            'creado_en',        v_encuentro.creado_en,
            'link_virtual', CASE
                WHEN v_participante.estado = 'confirmado'
                 AND v_encuentro.modalidad = 'virtual'
                THEN v_encuentro.link_virtual
                ELSE NULL
            END
        )
    );
END;
$function$;

-- 7. Actualizar get_encuentros_participados_seguro
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
            'tipo_invitacion',       e.tipo_invitacion,
            'estado',                e.estado,
            'tema',                  e.tema,
            'tema_invitacion',       COALESCE(e.tema_invitacion, 'classic'),
            'invitation_template',   e.invitation_template,
            'creado_en',             e.creado_en,
            '_mi_estado',            p.estado,
            '_mi_mensaje',           p.mensaje_respuesta,
            '_mi_token_invitacion',  p.token_invitacion
        )
        ORDER BY e.creado_en DESC
    )
    INTO v_result
    FROM participantes p
    JOIN encuentros e ON e.id = p.encuentro_id
    WHERE p.user_id = v_user_id
      AND p.estado IN ('confirmado', 'rechazado');

    RETURN COALESCE(v_result, '[]'::json);
END;
$function$;

-- Reaplicar permisos
REVOKE ALL ON FUNCTION crear_encuentro_seguro(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crear_encuentro_seguro(jsonb) TO anon, authenticated;

REVOKE ALL ON FUNCTION actualizar_encuentro_seguro(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION actualizar_encuentro_seguro(uuid, uuid, jsonb) TO anon, authenticated;

REVOKE ALL ON FUNCTION get_detalle_host_seguro(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_detalle_host_seguro(uuid, uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION get_encuentro_por_public_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_encuentro_por_public_token(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION get_participante_seguro(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_participante_seguro(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION get_encuentros_participados_seguro() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_encuentros_participados_seguro() TO anon, authenticated;
