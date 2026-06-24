-- ============================================================
-- Update: get_participantes_host_seguro
-- Añadir mensaje_respuesta al retorno.
-- ============================================================

CREATE OR REPLACE FUNCTION get_participantes_host_seguro(
  p_encuentro_id uuid,
  p_host_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enc_exists boolean;
  v_result json;
BEGIN
  -- Verificar que el encuentro pertenece al host solicitado
  SELECT EXISTS(
    SELECT 1 FROM public.encuentros
    WHERE id = p_encuentro_id AND host_id = p_host_id
  ) INTO v_enc_exists;

  IF NOT v_enc_exists THEN
    RETURN json_build_object('error', 'encuentro_not_found_or_not_owner');
  END IF;

  -- Devolver los participantes de forma segura incluyendo mensaje_respuesta
  SELECT COALESCE(json_agg(
    json_build_object(
      'id', p.id,
      'nombre_invitado', p.nombre_invitado,
      'estado', p.estado,
      'tipo_invitacion', p.tipo_invitacion,
      'token_invitacion', p.token_invitacion,
      'user_id', p.user_id,
      'mensaje_respuesta', p.mensaje_respuesta,
      'creado_en', p.creado_en
    ) ORDER BY p.creado_en ASC
  ), '[]'::json)
  INTO v_result
  FROM public.participantes p
  WHERE p.encuentro_id = p_encuentro_id;

  RETURN v_result;
END;
$$;

NOTIFY pgrst, 'reload schema';

REVOKE ALL ON FUNCTION get_participantes_host_seguro(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_participantes_host_seguro(uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION get_participantes_host_seguro(uuid, uuid) TO authenticated;
