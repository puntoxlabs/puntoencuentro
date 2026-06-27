-- ============================================================
-- Actualiza get_respuestas_visibles_invitado para incluir
-- participantes con estado 'pendiente' ademas de confirmado/rechazado.
--
-- SEGURIDAD: mantiene todas las garantias anteriores:
--   - Solo acepta token_invitacion personal (NO public_token)
--   - No devuelve id, token, user_id, host_id, public_token,
--     encuentro_id ni mensaje_respuesta
--   - Solo visible si el host activo mostrar_respuestas_a_invitados
-- ============================================================
CREATE OR REPLACE FUNCTION get_respuestas_visibles_invitado(
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token_uuid   uuid;
  v_encuentro_id uuid;
  v_visible      boolean;
  v_result       jsonb;
BEGIN
  -- 1. Validar formato UUID
  BEGIN
    v_token_uuid := p_token::uuid;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('ok', true, 'visible', false, 'participantes', '[]'::jsonb);
  END;

  -- 2. Buscar SOLO por token_invitacion personal (NO public_token)
  SELECT p.encuentro_id
  INTO v_encuentro_id
  FROM public.participantes p
  WHERE p.token_invitacion = v_token_uuid
  LIMIT 1;

  IF NOT FOUND THEN
    -- Token no corresponde a ningun participante registrado
    RETURN jsonb_build_object('ok', true, 'visible', false, 'participantes', '[]'::jsonb);
  END IF;

  -- 3. Verificar que el host activo la opcion
  SELECT mostrar_respuestas_a_invitados
  INTO v_visible
  FROM public.encuentros
  WHERE id = v_encuentro_id;

  IF NOT FOUND OR NOT v_visible THEN
    RETURN jsonb_build_object('ok', true, 'visible', false, 'participantes', '[]'::jsonb);
  END IF;

  -- 4. Devolver confirmados, rechazados Y pendientes
  --    Orden: confirmado (1) > rechazado (2) > pendiente (3), alfabetico dentro de cada grupo
  --    Solo nombre_invitado y estado, sin ningun dato sensible
  SELECT jsonb_build_object(
    'ok', true,
    'visible', true,
    'participantes', COALESCE(jsonb_agg(
      jsonb_build_object(
        'nombre_invitado', p.nombre_invitado,
        'estado', p.estado
      )
      ORDER BY
        CASE p.estado
          WHEN 'confirmado' THEN 1
          WHEN 'rechazado'  THEN 2
          WHEN 'pendiente'  THEN 3
          ELSE 4
        END,
        p.nombre_invitado
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM public.participantes p
  WHERE p.encuentro_id = v_encuentro_id
    AND p.estado IN ('confirmado', 'rechazado', 'pendiente');

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION get_respuestas_visibles_invitado(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_respuestas_visibles_invitado(text) TO anon;
GRANT EXECUTE ON FUNCTION get_respuestas_visibles_invitado(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
