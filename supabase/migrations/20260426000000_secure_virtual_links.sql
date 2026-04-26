-- Crear función RPC segura para obtener detalles de invitación
CREATE OR REPLACE FUNCTION get_participante_seguro(p_token text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_participante record;
    v_encuentro record;
    v_result json;
BEGIN
    -- Validar participante por token
    SELECT id, encuentro_id, nombre_invitado, tipo_invitacion, estado, creado_en, respondido_en, token_invitacion
    INTO v_participante
    FROM participantes
    WHERE token_invitacion = p_token;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Validar encuentro relacionado
    SELECT id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, host_id, creado_en, public_token, link_virtual
    INTO v_encuentro
    FROM encuentros
    WHERE id = v_participante.encuentro_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Construir la respuesta explícitamente y ocultar link_virtual si estado != 'confirmado'
    v_result := json_build_object(
        'id', v_participante.id,
        'encuentro_id', v_participante.encuentro_id,
        'nombre_invitado', v_participante.nombre_invitado,
        'tipo_invitacion', v_participante.tipo_invitacion,
        'estado', v_participante.estado,
        'creado_en', v_participante.creado_en,
        'respondido_en', v_participante.respondido_en,
        'token_invitacion', v_participante.token_invitacion,
        'encuentros', json_build_object(
            'id', v_encuentro.id,
            'titulo', v_encuentro.titulo,
            'descripcion', v_encuentro.descripcion,
            'fecha', v_encuentro.fecha,
            'hora', v_encuentro.hora,
            'modalidad', v_encuentro.modalidad,
            'lugar_texto', v_encuentro.lugar_texto,
            'host_id', v_encuentro.host_id,
            'creado_en', v_encuentro.creado_en,
            'public_token', v_encuentro.public_token,
            'link_virtual', CASE WHEN v_participante.estado = 'confirmado' THEN v_encuentro.link_virtual ELSE NULL END
        )
    );

    RETURN v_result;
END;
$$;
