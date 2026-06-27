-- ============================================================
-- RPCs para visibilidad de respuestas a invitados
-- ============================================================
-- 1. set_visibilidad_respuestas_invitados  — host activa/desactiva
-- 2. get_visibilidad_invitados_host        — host lee estado actual
-- 3. get_respuestas_visibles_invitado      — invitado consulta lista
--    SOLO acepta token_invitacion personal.
--    NO acepta public_token (seguridad: cualquiera puede tener el link).
-- ============================================================

-- ============================================================
-- 1. set_visibilidad_respuestas_invitados
--    Activa/desactiva la visibilidad de respuestas para un encuentro.
--    Verifica ownership antes de actualizar.
-- ============================================================
CREATE OR REPLACE FUNCTION set_visibilidad_respuestas_invitados(
  p_encuentro_id uuid,
  p_host_id      uuid,
  p_visible      boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.encuentros
    WHERE id = p_encuentro_id
      AND host_id = p_host_id
  ) INTO v_exists;

  IF NOT v_exists THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  UPDATE public.encuentros
  SET mostrar_respuestas_a_invitados = p_visible
  WHERE id = p_encuentro_id
    AND host_id = p_host_id;

  RETURN jsonb_build_object('ok', true, 'visible', p_visible);
END;
$$;

REVOKE ALL ON FUNCTION set_visibilidad_respuestas_invitados(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_visibilidad_respuestas_invitados(uuid, uuid, boolean) TO anon;
GRANT EXECUTE ON FUNCTION set_visibilidad_respuestas_invitados(uuid, uuid, boolean) TO authenticated;

-- ============================================================
-- 2. get_visibilidad_invitados_host
--    Devuelve el estado actual de la opcion para el host.
--    Verifica ownership para no exponer datos de otros encuentros.
-- ============================================================
CREATE OR REPLACE FUNCTION get_visibilidad_invitados_host(
  p_encuentro_id uuid,
  p_host_id      uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_visible boolean;
BEGIN
  SELECT mostrar_respuestas_a_invitados
  INTO v_visible
  FROM public.encuentros
  WHERE id = p_encuentro_id
    AND host_id = p_host_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  RETURN jsonb_build_object('ok', true, 'visible', v_visible);
END;
$$;

REVOKE ALL ON FUNCTION get_visibilidad_invitados_host(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_visibilidad_invitados_host(uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION get_visibilidad_invitados_host(uuid, uuid) TO authenticated;

-- ============================================================
-- 3. get_respuestas_visibles_invitado
--    Permite a un invitado ver respuestas minimas si el host lo activo.
--
--    SEGURIDAD CRITICA:
--    - Solo acepta token_invitacion personal (participantes.token_invitacion).
--    - NO acepta public_token de encuentro.
--    - No devuelve id, token, user_id, host_id, public_token, mensaje_respuesta.
--    - Si el token no existe: { ok: true, visible: false, participantes: [] }
--    - Si visible=false: { ok: true, visible: false, participantes: [] }
--    - Solo muestra confirmados y rechazados. NO muestra pendientes.
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
  v_token_uuid  uuid;
  v_encuentro_id uuid;
  v_visible     boolean;
  v_result      jsonb;
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

  -- 4. Devolver solo confirmados y rechazados (no pendientes)
  --    Solo nombre_invitado y estado — sin ningun dato sensible
  SELECT jsonb_build_object(
    'ok', true,
    'visible', true,
    'participantes', COALESCE(jsonb_agg(
      jsonb_build_object(
        'nombre_invitado', p.nombre_invitado,
        'estado', p.estado
      )
      ORDER BY
        CASE p.estado WHEN 'confirmado' THEN 1 WHEN 'rechazado' THEN 2 ELSE 3 END,
        p.nombre_invitado
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM public.participantes p
  WHERE p.encuentro_id = v_encuentro_id
    AND p.estado IN ('confirmado', 'rechazado');

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION get_respuestas_visibles_invitado(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_respuestas_visibles_invitado(text) TO anon;
GRANT EXECUTE ON FUNCTION get_respuestas_visibles_invitado(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
