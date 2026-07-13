BEGIN;

-- 1. ACTUALIZAR ENCUENTRO
CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro(
    p_encuentro_id uuid,
    p_host_id      uuid,
    p_data         jsonb
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.encuentros
        WHERE id = p_encuentro_id AND host_id = v_user_id
    ) THEN
        RETURN json_build_object('ok', false, 'error', 'Encuentro no encontrado o sin permisos');
    END IF;

    UPDATE public.encuentros
    SET
        titulo = COALESCE(p_data->>'titulo', titulo),
        descripcion = CASE
            WHEN p_data ? 'descripcion'
            THEN p_data->>'descripcion'
            ELSE descripcion
        END,
        fecha = CASE
            WHEN p_data ? 'fecha'
            THEN (p_data->>'fecha')::date
            ELSE fecha
        END,
        hora = CASE
            WHEN p_data ? 'hora'
            THEN (p_data->>'hora')::time
            ELSE hora
        END,
        modalidad = COALESCE(
            p_data->>'modalidad',
            modalidad
        ),
        lugar_texto = CASE WHEN p_data ? 'lugar_texto' THEN p_data->>'lugar_texto' ELSE lugar_texto END,
        link_virtual = CASE WHEN p_data ? 'link_virtual' THEN p_data->>'link_virtual' ELSE link_virtual END,
        tipo_invitacion = COALESCE(
            p_data->>'tipo_invitacion',
            tipo_invitacion
        ),
        estado = COALESCE(
            p_data->>'estado',
            estado
        ),
        tema = CASE WHEN p_data ? 'tema' THEN p_data->>'tema' ELSE tema END,
        tema_invitacion = CASE
            WHEN p_data ? 'tema_invitacion'
                 AND p_data->>'tema_invitacion' IN (
                    'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
                    'family', 'special', 'romantic', 'sports', 'entertainment',
                    'learning', 'wellness', 'custom'
                 )
            THEN p_data->>'tema_invitacion'
            ELSE tema_invitacion
        END,
        invitation_template = CASE WHEN p_data ? 'invitation_template' THEN p_data->>'invitation_template' ELSE invitation_template END,
        reemplaza_a = CASE
            WHEN p_data ? 'reemplaza_a'
                 AND p_data->>'reemplaza_a' IS NOT NULL
                 AND p_data->>'reemplaza_a' <> ''
            THEN (p_data->>'reemplaza_a')::uuid
            WHEN p_data ? 'reemplaza_a'
            THEN NULL
            ELSE reemplaza_a
        END
    WHERE id = p_encuentro_id
      AND host_id = v_user_id;

    RETURN json_build_object(
        'ok', true,
        'id', p_encuentro_id
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) TO authenticated;

-- 2. CANCELAR ENCUENTRO
CREATE OR REPLACE FUNCTION public.cancelar_encuentro_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'not_found'
        );
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'unauthorized'
        );
    END IF;

    UPDATE public.encuentros
    SET estado = 'cancelado'
    WHERE id = p_encuentro_id
      AND host_id = v_user_id;

    RETURN json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'estado', 'cancelado'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_encuentro_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_encuentro_seguro(uuid, uuid) TO authenticated;

-- 3. ELIMINAR ENCUENTRO
CREATE OR REPLACE FUNCTION public.eliminar_encuentro_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'not_found'
        );
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'unauthorized'
        );
    END IF;

    DELETE FROM public.participante_disponibilidades WHERE encuentro_id = p_encuentro_id;
    DELETE FROM public.encuentro_opciones_fecha WHERE encuentro_id = p_encuentro_id;
    DELETE FROM public.participantes WHERE encuentro_id = p_encuentro_id;
    DELETE FROM public.encuentros WHERE id = p_encuentro_id;

    RETURN json_build_object(
        'ok', true,
        'id', p_encuentro_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_encuentro_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_encuentro_seguro(uuid, uuid) TO authenticated;

-- 4. CREAR PARTICIPANTE
CREATE OR REPLACE FUNCTION public.crear_participante_individual_seguro(
    p_encuentro_id uuid,
    p_host_id      uuid,
    p_nombre       text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_enc_exists  boolean;
    v_token       uuid;
    v_part_id     uuid;
    v_result      json;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.encuentros
        WHERE id = p_encuentro_id
          AND host_id = v_user_id
    ) INTO v_enc_exists;

    IF NOT v_enc_exists THEN
        RAISE EXCEPTION 'encuentro_not_found_or_not_owner';
    END IF;

    v_token   := gen_random_uuid();
    v_part_id := gen_random_uuid();

    INSERT INTO public.participantes (
        id,
        encuentro_id,
        nombre_invitado,
        tipo_invitacion,
        token_invitacion,
        estado
    ) VALUES (
        v_part_id,
        p_encuentro_id,
        p_nombre,
        'individual',
        v_token,
        'pendiente'
    );

    SELECT json_build_object(
        'id',               p.id,
        'encuentro_id',     p.encuentro_id,
        'nombre_invitado',  p.nombre_invitado,
        'tipo_invitacion',  p.tipo_invitacion,
        'token_invitacion', p.token_invitacion,
        'estado',           p.estado,
        'creado_en',        p.creado_en
    )
    INTO v_result
    FROM public.participantes p
    WHERE p.id = v_part_id;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.crear_participante_individual_seguro(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_participante_individual_seguro(uuid, uuid, text) TO authenticated;

-- 5. ELIMINAR PARTICIPANTE
CREATE OR REPLACE FUNCTION public.eliminar_participante_seguro(p_participante_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro_id uuid;
    v_host_id uuid;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT encuentro_id INTO v_encuentro_id
    FROM public.participantes
    WHERE id = p_participante_id;
    
    IF v_encuentro_id IS NULL THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'not_found'
        );
    END IF;

    SELECT host_id INTO v_host_id
    FROM public.encuentros
    WHERE id = v_encuentro_id;

    IF v_host_id <> v_user_id THEN
        RETURN json_build_object(
            'ok', false,
            'error', 'unauthorized'
        );
    END IF;

    DELETE FROM public.participante_disponibilidades WHERE participante_id = p_participante_id;
    DELETE FROM public.participantes WHERE id = p_participante_id;

    RETURN json_build_object(
        'ok', true,
        'id', p_participante_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_participante_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_participante_seguro(uuid, uuid) TO authenticated;

-- 6. GET DETALLE HOST SEGURO
CREATE OR REPLACE FUNCTION public.get_detalle_host_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('error', 'unauthorized');
    END IF;

    RETURN json_build_object(
        'id', v_encuentro.id,
        'titulo', v_encuentro.titulo,
        'descripcion', v_encuentro.descripcion,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'lugar_texto', v_encuentro.lugar_texto,
        'link_virtual', v_encuentro.link_virtual,
        'tipo_invitacion', v_encuentro.tipo_invitacion,
        'host_id', v_encuentro.host_id,
        'public_token', v_encuentro.public_token,
        'estado', v_encuentro.estado,
        'tema', v_encuentro.tema,
        'tema_invitacion', COALESCE(v_encuentro.tema_invitacion, 'classic'),
        'invitation_template', v_encuentro.invitation_template,
        'reemplaza_a', v_encuentro.reemplaza_a,
        'creado_en', v_encuentro.creado_en
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) TO authenticated;

-- 7. GET PARTICIPANTES HOST SEGURO
CREATE OR REPLACE FUNCTION public.get_participantes_host_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_result json;
    v_enc_exists boolean;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.encuentros
        WHERE id = p_encuentro_id AND host_id = v_user_id
    ) INTO v_enc_exists;

    IF NOT v_enc_exists THEN
        RETURN json_build_object('error', 'encuentro_not_found_or_not_owner');
    END IF;

    SELECT json_agg(json_build_object(
        'id', p.id,
        'nombre_invitado', p.nombre_invitado,
        'estado', p.estado,
        'tipo_invitacion', p.tipo_invitacion,
        'token_invitacion', p.token_invitacion,
        'user_id', p.user_id,
        'mensaje_respuesta', p.mensaje_respuesta,
        'creado_en', p.creado_en
    ) ORDER BY p.creado_en ASC) INTO v_result
    FROM public.participantes p
    WHERE p.encuentro_id = p_encuentro_id;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_participantes_host_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_participantes_host_seguro(uuid, uuid) TO authenticated;

-- 8. GET ENCUENTROS HOST SEGURO
CREATE OR REPLACE FUNCTION public.get_encuentros_host_seguro(
    p_host_ids uuid[]
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

    -- Parámetro preservado exclusivamente por compatibilidad contractual.
    -- Nunca se utiliza para determinar ownership.
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
            'creado_en',       e.creado_en
        )
        ORDER BY e.creado_en DESC
    )
    INTO v_result
    FROM public.encuentros e
    WHERE e.host_id = v_user_id;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL
ON FUNCTION public.get_encuentros_host_seguro(uuid[])
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.get_encuentros_host_seguro(uuid[])
TO authenticated;

-- 9. CREAR ENCUENTRO SEGURO
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

    INSERT INTO public.encuentros (
        id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, link_virtual,
        tipo_invitacion, host_id, public_token, estado, tema, tema_invitacion, invitation_template
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
        p_data->>'invitation_template'
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

-- 10. VISIBILIDAD INVITADOS
CREATE OR REPLACE FUNCTION public.get_visibilidad_invitados_host(p_encuentro_id uuid, p_host_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_visibilidad boolean;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT mostrar_respuestas_a_invitados INTO v_visibilidad
    FROM public.encuentros
    WHERE id = p_encuentro_id AND host_id = v_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'unauthorized'
        );
    END IF;

    RETURN jsonb_build_object('ok', true, 'visible', v_visibilidad);
END;
$$;

REVOKE ALL ON FUNCTION public.get_visibilidad_invitados_host(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_visibilidad_invitados_host(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_visibilidad_respuestas_invitados(p_encuentro_id uuid, p_host_id uuid, p_visible boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    UPDATE public.encuentros
    SET mostrar_respuestas_a_invitados = p_visible
    WHERE id = p_encuentro_id AND host_id = v_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'unauthorized'
        );
    END IF;

    RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_visibilidad_respuestas_invitados(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_visibilidad_respuestas_invitados(uuid, uuid, boolean) TO authenticated;

-- 11. REVOCAR TRANSFERENCIA LEGACY
REVOKE ALL ON FUNCTION public.transferir_encuentros_anonimos_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.transferir_encuentros_anonimos_seguro(uuid, uuid);

-- 12. TABLAS Y POLÍTICAS
REVOKE ALL ON TABLE public.encuentros FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.participantes FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS encuentros_insert_anyone ON public.encuentros;
DROP POLICY IF EXISTS participantes_insert_anyone ON public.participantes;
DROP POLICY IF EXISTS participantes_select_own_authenticated ON public.participantes;
DROP POLICY IF EXISTS participantes_update_own_authenticated ON public.participantes;

ALTER TABLE public.encuentros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participantes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.custom_invitation_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.custom_invitation_templates TO authenticated;

DROP POLICY IF EXISTS custom_templates_insert_own ON public.custom_invitation_templates;
DROP POLICY IF EXISTS custom_templates_insert_authenticated ON public.custom_invitation_templates;
DROP POLICY IF EXISTS custom_templates_select_own ON public.custom_invitation_templates;
DROP POLICY IF EXISTS custom_templates_update_own ON public.custom_invitation_templates;

ALTER TABLE public.custom_invitation_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY custom_templates_insert_authenticated
ON public.custom_invitation_templates
FOR INSERT TO authenticated
WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);

CREATE POLICY custom_templates_select_own
ON public.custom_invitation_templates
FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);

CREATE POLICY custom_templates_update_own
ON public.custom_invitation_templates
FOR UPDATE TO authenticated
USING (auth.uid() IS NOT NULL AND auth.uid() = user_id)
WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);

-- 13. REVOCAR EJECUCIÓN DIRECTA DE FUNCIONES TRIGGER
REVOKE ALL ON FUNCTION public.enforce_custom_templates_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;

-- 14. PARTICIPACIONES DEL USUARIO
REVOKE ALL ON FUNCTION public.get_encuentros_participados_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentros_participados_seguro() TO authenticated;

-- 15. GET_COUNTS_PARTICIPANTES_HOST_SEGURO
CREATE OR REPLACE FUNCTION public.get_counts_participantes_host_seguro(p_encuentro_ids uuid[])
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_counts json;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN '{}'::json;
    END IF;

    IF p_encuentro_ids IS NULL OR array_length(p_encuentro_ids, 1) = 0 THEN
        RETURN '{}'::json;
    END IF;

    SELECT COALESCE(json_object_agg(
        encuentro_id,
        json_build_object(
            'total', total,
            'confirmados', confirmados
        )
    ), '{}'::json) INTO v_counts
    FROM (
        SELECT 
            p.encuentro_id,
            COUNT(*) as total,
            SUM(CASE WHEN p.estado = 'confirmado' THEN 1 ELSE 0 END) as confirmados
        FROM public.participantes p
        JOIN public.encuentros e ON p.encuentro_id = e.id
        WHERE p.encuentro_id = ANY(p_encuentro_ids)
          AND e.host_id = v_user_id
        GROUP BY p.encuentro_id
    ) counts_agrupados;

    RETURN v_counts;
END;
$$;

REVOKE ALL ON FUNCTION public.get_counts_participantes_host_seguro(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_counts_participantes_host_seguro(uuid[]) TO authenticated;

-- 16. VINCULAR_USUARIO_PARTICIPANTE_SEGURO
CREATE OR REPLACE FUNCTION public.vincular_usuario_participante_seguro(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_token_uuid uuid;
    v_participante public.participantes%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF NULLIF(btrim(p_token), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    BEGIN
        v_token_uuid := p_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
    END;

    SELECT * INTO v_participante
    FROM public.participantes
    WHERE token_invitacion = v_token_uuid;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_participant_token');
    END IF;

    IF v_participante.user_id = v_user_id THEN
        RETURN jsonb_build_object('ok', true, 'participante_id', v_participante.id, 'encuentro_id', v_participante.encuentro_id, 'already_linked', true);
    END IF;

    UPDATE public.participantes
    SET user_id = v_user_id
    WHERE token_invitacion = v_token_uuid
      AND user_id IS NULL
    RETURNING * INTO v_participante;

    IF NOT FOUND THEN
        SELECT * INTO v_participante
        FROM public.participantes
        WHERE token_invitacion = v_token_uuid;

        IF FOUND AND v_participante.user_id = v_user_id THEN
            RETURN jsonb_build_object('ok', true, 'participante_id', v_participante.id, 'encuentro_id', v_participante.encuentro_id, 'already_linked', true);
        END IF;

        RETURN jsonb_build_object('ok', false, 'error', 'participant_already_linked');
    END IF;

    RETURN jsonb_build_object('ok', true, 'participante_id', v_participante.id, 'encuentro_id', v_participante.encuentro_id, 'already_linked', false);
END;
$$;

REVOKE ALL ON FUNCTION public.vincular_usuario_participante_seguro(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vincular_usuario_participante_seguro(text) TO authenticated;

COMMIT;
