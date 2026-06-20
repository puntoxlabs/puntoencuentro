-- ============================================================
-- Etapa E: RPCs SECURITY DEFINER para INSERT seguro
-- Resuelve: "new row violates row-level security policy"
-- post-Etapa D al crear encuentros y participantes individuales
-- ============================================================

-- ============================================================
-- 1. crear_encuentro_seguro
--    Crea un encuentro y devuelve la fila completa como JSON.
--    No requiere SELECT policy sobre la tabla.
-- ============================================================
CREATE OR REPLACE FUNCTION crear_encuentro_seguro(p_data jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id          uuid;
    v_token       uuid;
    v_result      json;
BEGIN
    -- Usar id y public_token del payload si vienen, sino generar
    v_id    := COALESCE((p_data->>'id')::uuid,           gen_random_uuid());
    v_token := COALESCE((p_data->>'public_token')::uuid, gen_random_uuid());

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
        CASE WHEN p_data->>'reemplaza_a' IS NOT NULL AND p_data->>'reemplaza_a' != 'null'
             THEN (p_data->>'reemplaza_a')::uuid
             ELSE NULL
        END
    );

    SELECT json_build_object(
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
    INTO v_result
    FROM public.encuentros e
    WHERE e.id = v_id;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION crear_encuentro_seguro(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crear_encuentro_seguro(jsonb) TO anon;
GRANT EXECUTE ON FUNCTION crear_encuentro_seguro(jsonb) TO authenticated;

-- ============================================================
-- 2. crear_participante_individual_seguro
--    Crea un participante individual verificando ownership.
--    No requiere SELECT policy sobre participantes.
-- ============================================================
CREATE OR REPLACE FUNCTION crear_participante_individual_seguro(
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
    v_enc_exists  boolean;
    v_token       uuid;
    v_part_id     uuid;
    v_result      json;
BEGIN
    -- Verificar que el encuentro existe y que host_id coincide
    SELECT EXISTS(
        SELECT 1 FROM public.encuentros
        WHERE id = p_encuentro_id
          AND host_id = p_host_id
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

REVOKE ALL ON FUNCTION crear_participante_individual_seguro(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crear_participante_individual_seguro(uuid, uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION crear_participante_individual_seguro(uuid, uuid, text) TO authenticated;
