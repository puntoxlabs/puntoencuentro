-- ============================================================
-- Migracion: Ampliar tema_invitacion (constraint + RPCs)
-- 20260710000000_expand_tema_invitacion_check.sql
-- ============================================================
-- Alcance:
--   1. CHECK constraint encuentros_tema_invitacion_check
--   2. RPC crear_encuentro_seguro (lista interna de temas validos)
--   3. RPC actualizar_encuentro_seguro (lista interna de temas validos)
--
-- Nuevos temas habilitados: sports, entertainment, learning, wellness, custom
-- Temas anteriores: classic, formal, friends, celebration, kids_birthday,
--                   family, special, romantic  (sin cambios, todos conservados)
--
-- NO modifica: otras constraints, RLS, tablas, storage, frontend.
-- ============================================================

BEGIN;

-- 1.1 Actualizar CHECK constraint
ALTER TABLE public.encuentros
  DROP CONSTRAINT IF EXISTS encuentros_tema_invitacion_check;

ALTER TABLE public.encuentros
  ADD CONSTRAINT encuentros_tema_invitacion_check
  CHECK (
    tema_invitacion = ANY (ARRAY[
      'classic'::text,
      'formal'::text,
      'friends'::text,
      'celebration'::text,
      'kids_birthday'::text,
      'family'::text,
      'special'::text,
      'romantic'::text,
      'sports'::text,
      'entertainment'::text,
      'learning'::text,
      'wellness'::text,
      'custom'::text
    ])
  );

-- 1.2 Actualizar RPC crear_encuentro_seguro
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
        (p_data->>'host_id')::uuid,
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

-- 1.3 Actualizar RPC actualizar_encuentro_seguro
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
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.encuentros
        WHERE id = p_encuentro_id AND host_id = p_host_id
    ) THEN
        RETURN json_build_object('ok', false, 'error', 'Encuentro no encontrado o sin permisos');
    END IF;

    UPDATE public.encuentros
    SET
        titulo = COALESCE(p_data->>'titulo', titulo),
        descripcion = CASE WHEN p_data ? 'descripcion' THEN p_data->>'descripcion' ELSE descripcion END,
        fecha = CASE WHEN p_data ? 'fecha' THEN (p_data->>'fecha')::date ELSE fecha END,
        hora = CASE WHEN p_data ? 'hora' THEN (p_data->>'hora')::time ELSE hora END,
        modalidad = COALESCE(p_data->>'modalidad', modalidad),
        lugar_texto = CASE WHEN p_data ? 'lugar_texto' THEN p_data->>'lugar_texto' ELSE lugar_texto END,
        link_virtual = CASE WHEN p_data ? 'link_virtual' THEN p_data->>'link_virtual' ELSE link_virtual END,
        tipo_invitacion = COALESCE(p_data->>'tipo_invitacion', tipo_invitacion),
        estado = COALESCE(p_data->>'estado', estado),
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
            WHEN p_data ? 'reemplaza_a' AND p_data->>'reemplaza_a' IS NOT NULL AND p_data->>'reemplaza_a' <> ''
                THEN (p_data->>'reemplaza_a')::uuid
            WHEN p_data ? 'reemplaza_a' THEN NULL
            ELSE reemplaza_a
        END
    WHERE id = p_encuentro_id;

    RETURN json_build_object('ok', true, 'id', p_encuentro_id);
END;
$function$;

COMMIT;
