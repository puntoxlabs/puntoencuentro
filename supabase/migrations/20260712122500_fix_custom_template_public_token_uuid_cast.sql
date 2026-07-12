CREATE OR REPLACE FUNCTION public.get_custom_invitation_template_public(p_public_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_encuentro record;
    v_template_id uuid;
    v_template_id_text text;
    v_design record;
    v_token_uuid uuid;
BEGIN
    -- Cast seguro del token recibido.
    -- En producción public_token y token_invitacion son uuid.
    BEGIN
        v_token_uuid := p_public_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN NULL;
    END;

    -- Buscar primero como public_token de encuentro general.
    SELECT id, tema_invitacion, invitation_template, estado
    INTO v_encuentro
    FROM public.encuentros
    WHERE public_token = v_token_uuid;

    -- Si no se encontró, buscar como token individual de participante.
    IF NOT FOUND THEN
        SELECT e.id, e.tema_invitacion, e.invitation_template, e.estado
        INTO v_encuentro
        FROM public.participantes p
        JOIN public.encuentros e ON e.id = p.encuentro_id
        WHERE p.token_invitacion = v_token_uuid;
    END IF;

    -- Si sigue sin encontrarse el encuentro o está cancelado, abortar.
    IF v_encuentro IS NULL OR v_encuentro.estado = 'cancelado' THEN
        RETURN NULL;
    END IF;

    -- Validar que el tema sea custom y tenga formato exacto custom_<uuid>.
    IF v_encuentro.tema_invitacion != 'custom'
       OR v_encuentro.invitation_template !~ '^custom_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN
        RETURN NULL;
    END IF;

    -- Extraer UUID real del diseño estrictamente.
    v_template_id_text := substring(v_encuentro.invitation_template from 8);

    BEGIN
        v_template_id := v_template_id_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN NULL;
    END;

    -- Buscar el diseño aunque esté is_active=false,
    -- siempre que el encuentro ya lo tenga referenciado.
    SELECT id, name, image_path, thumbnail_path, image_url, thumbnail_url, overlay_opacity
    INTO v_design
    FROM public.custom_invitation_templates
    WHERE id = v_template_id
      AND image_path IS NOT NULL;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN row_to_json(v_design);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_custom_invitation_template_public(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_custom_invitation_template_public(text) TO anon, authenticated;
