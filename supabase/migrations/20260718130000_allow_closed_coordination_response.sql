-- ============================================================
-- Migración: allow_closed_coordination_response
-- Descripción: Actualiza responder_participante_seguro para 
-- aceptar respuestas cuando la coordinación está cerrada.
-- ============================================================

BEGIN;

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

    -- [MODIFICADO]: Permitir si es fixed, o si es coordination cerrada
    IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' AND 
       NOT (v_encuentro.date_mode = 'coordination' AND v_encuentro.coordination_status = 'closed') THEN
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

    -- [MODIFICADO]: Permitir si es fixed, o si es coordination cerrada
    IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' AND 
       NOT (v_encuentro.date_mode = 'coordination' AND v_encuentro.coordination_status = 'closed') THEN
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

-- Restaurar grants
REVOKE ALL ON FUNCTION public.responder_participante_seguro(text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.responder_participante_seguro(text,text,text,text) TO anon, authenticated, postgres, service_role;

COMMIT;
