-- ============================================================
-- Update: responder_participante_seguro
-- Propósito: Devolver link_virtual cuando un participante confirma asistencia a un encuentro virtual.
-- Preservando la lógica vigente en producción de vencimiento de 45 minutos (Hora Argentina).
-- ============================================================

CREATE OR REPLACE FUNCTION public.responder_participante_seguro(p_token text, p_estado text, p_nombre text DEFAULT NULL::text, p_mensaje text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_token_uuid uuid;

  v_participante participantes%ROWTYPE;
  v_participante_actualizado participantes%ROWTYPE;
  v_participante_nuevo participantes%ROWTYPE;
  v_encuentro encuentros%ROWTYPE;

  v_nombre_limpio text;
  v_token_nuevo uuid;

  v_inicio_local timestamp;
  v_limite_local timestamp;
  v_ahora_local timestamp;
  v_tipo_respuesta text;
BEGIN
  -- Validaciones básicas
  IF p_token IS NULL OR trim(p_token) = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'missing_token'
    );
  END IF;

  IF p_estado NOT IN ('confirmado', 'rechazado') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_estado'
    );
  END IF;

  -- Los tokens reales son UUID, aunque llegan como text desde RPC/PostgREST.
  BEGIN
    v_token_uuid := p_token::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_token'
    );
  END;

  v_nombre_limpio := NULLIF(trim(COALESCE(p_nombre, '')), '');

  --------------------------------------------------------------------
  -- 1) PRIMERO: intentar actualizar participante existente
  --    Sirve tanto para invitación individual como para participante
  --    creado desde link general.
  --------------------------------------------------------------------
  SELECT *
  INTO v_participante
  FROM participantes
  WHERE token_invitacion = v_token_uuid
  LIMIT 1;

  IF FOUND THEN
    SELECT *
    INTO v_encuentro
    FROM encuentros
    WHERE id = v_participante.encuentro_id
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'meeting_not_found'
      );
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'cancelled'
      );
    END IF;

    -- fecha + hora se interpretan como hora local Argentina.
    v_inicio_local := (v_encuentro.fecha::date + v_encuentro.hora::time);
    v_limite_local := v_inicio_local + interval '45 minutes';
    v_ahora_local  := now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

    IF v_ahora_local > v_limite_local THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'meeting_expired'
      );
    END IF;

    UPDATE participantes
    SET
      estado = p_estado,
      nombre_invitado = COALESCE(v_nombre_limpio, nombre_invitado),
      mensaje_respuesta = p_mensaje,
      respondido_en = now()
    WHERE id = v_participante.id
    RETURNING *
    INTO v_participante_actualizado;

    v_tipo_respuesta :=
      CASE
        WHEN v_participante_actualizado.tipo_invitacion = 'generico' THEN 'general'
        ELSE v_participante_actualizado.tipo_invitacion
      END;

    RETURN jsonb_build_object(
      'ok', true,
      'tipo', v_tipo_respuesta,
      'id', v_participante_actualizado.id,
      'encuentro_id', v_participante_actualizado.encuentro_id,
      'token_invitacion', v_participante_actualizado.token_invitacion,
      'estado', v_participante_actualizado.estado,
      'link_virtual',
      CASE
        WHEN p_estado = 'confirmado'
             AND v_encuentro.modalidad = 'virtual'
        THEN v_encuentro.link_virtual
        ELSE NULL
      END
    );
  END IF;

  --------------------------------------------------------------------
  -- 2) SEGUNDO: si no era token_invitacion, tratar como public_token
  --    de un encuentro y crear participante general.
  --------------------------------------------------------------------
  SELECT *
  INTO v_encuentro
  FROM encuentros
  WHERE public_token = v_token_uuid
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'not_found'
    );
  END IF;

  IF v_encuentro.estado = 'cancelado' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'cancelled'
    );
  END IF;

  -- fecha + hora se interpretan como hora local Argentina.
  v_inicio_local := (v_encuentro.fecha::date + v_encuentro.hora::time);
  v_limite_local := v_inicio_local + interval '45 minutes';
  v_ahora_local  := now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

  IF v_ahora_local > v_limite_local THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'meeting_expired'
    );
  END IF;

  -- token propio del participante, tipo uuid.
  v_token_nuevo := gen_random_uuid();

  INSERT INTO participantes (
    encuentro_id,
    nombre_invitado,
    estado,
    tipo_invitacion,
    token_invitacion,
    mensaje_respuesta,
    respondido_en
  )
  VALUES (
    v_encuentro.id,
    v_nombre_limpio,
    p_estado,
    'generico',
    v_token_nuevo,
    p_mensaje,
    now()
  )
  RETURNING *
  INTO v_participante_nuevo;

  RETURN jsonb_build_object(
    'ok', true,
    'tipo', 'general',
    'id', v_participante_nuevo.id,
    'encuentro_id', v_participante_nuevo.encuentro_id,
    'token_invitacion', v_participante_nuevo.token_invitacion,
    'estado', v_participante_nuevo.estado,
    'link_virtual',
    CASE
      WHEN p_estado = 'confirmado'
           AND v_encuentro.modalidad = 'virtual'
      THEN v_encuentro.link_virtual
      ELSE NULL
    END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.responder_participante_seguro(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.responder_participante_seguro(text, text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.responder_participante_seguro(text, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
