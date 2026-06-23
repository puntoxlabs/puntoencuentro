-- ============================================================
-- Fix: responder_participante_seguro
-- Problema: la RPC no tenía rama de actualización por token_invitacion,
-- por lo que cada cambio de respuesta en Link General creaba un
-- participante nuevo en vez de actualizar el existente.
--
-- Solución: priorizar búsqueda por token_invitacion (UPDATE)
-- antes de buscar por public_token (INSERT).
--
-- Aplica tanto a participantes individuales como genericos.
-- ============================================================

CREATE OR REPLACE FUNCTION responder_participante_seguro(
  p_token  text,
  p_estado text,
  p_nombre text DEFAULT NULL,
  p_mensaje text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token_uuid       uuid;
  v_participante     participantes%ROWTYPE;
  v_encuentro        encuentros%ROWTYPE;
  v_new_part_id      uuid;
  v_new_token        uuid;
BEGIN

  -- ── 0. Validar formato UUID del token ───────────────────────
  BEGIN
    v_token_uuid := p_token::uuid;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END;

  -- ── 1. Buscar participante existente por token_invitacion ───
  --       Aplica tanto a invitaciones individuales como genericas.
  --       Si existe → actualizar, NO insertar nada nuevo.
  SELECT * INTO v_participante
  FROM participantes
  WHERE token_invitacion = v_token_uuid
  LIMIT 1;

  IF FOUND THEN
    -- Verificar que el encuentro asociado no esté cancelado ni haya expirado
    SELECT * INTO v_encuentro
    FROM encuentros
    WHERE id = v_participante.encuentro_id
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'meeting_not_found');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'meeting_cancelled');
    END IF;

    IF v_encuentro.fecha < CURRENT_DATE OR (
       v_encuentro.fecha = CURRENT_DATE AND v_encuentro.hora < CURRENT_TIME
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'meeting_expired');
    END IF;

    -- Actualizar la fila existente
    UPDATE participantes
    SET
      estado            = p_estado,
      nombre_invitado   = COALESCE(NULLIF(trim(p_nombre), ''), nombre_invitado),
      mensaje_respuesta = p_mensaje,
      respondido_en     = now()
    WHERE id = v_participante.id;

    RETURN jsonb_build_object(
      'ok',               true,
      'tipo',             v_participante.tipo_invitacion,
      'id',               v_participante.id,
      'token_invitacion', v_participante.token_invitacion,
      'estado',           p_estado
    );
  END IF;

  -- ── 2. No existe participante con ese token_invitacion.
  --       Tratar p_token como public_token de un encuentro (link general).
  SELECT * INTO v_encuentro
  FROM encuentros
  WHERE public_token = v_token_uuid
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_encuentro.estado = 'cancelado' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'meeting_cancelled');
  END IF;

  IF v_encuentro.fecha < CURRENT_DATE OR (
     v_encuentro.fecha = CURRENT_DATE AND v_encuentro.hora < CURRENT_TIME
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'meeting_expired');
  END IF;

  -- Crear nuevo participante desde link general
  v_new_part_id := gen_random_uuid();
  v_new_token   := gen_random_uuid();

  INSERT INTO participantes (
    id,
    encuentro_id,
    nombre_invitado,
    tipo_invitacion,
    token_invitacion,
    estado,
    mensaje_respuesta,
    respondido_en
  ) VALUES (
    v_new_part_id,
    v_encuentro.id,
    COALESCE(NULLIF(trim(p_nombre), ''), 'Invitado'),
    'generico',
    v_new_token,
    p_estado,
    p_mensaje,
    now()
  );

  RETURN jsonb_build_object(
    'ok',               true,
    'tipo',             'general',
    'id',               v_new_part_id,
    'token_invitacion', v_new_token,
    'estado',           p_estado
  );

END;
$$;

-- Permisos: accesible para usuarios anónimos y autenticados
REVOKE ALL ON FUNCTION responder_participante_seguro(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION responder_participante_seguro(text, text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION responder_participante_seguro(text, text, text, text) TO authenticated;
