-- 1. Actualizar get_encuentros_participados_seguro para incluir campos de coordinación
CREATE OR REPLACE FUNCTION public.get_encuentros_participados_seguro()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid;
    v_result  json;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('error', 'unauthenticated');
    END IF;

    SELECT json_agg(
        json_build_object(
            'id',                    e.id,
            'titulo',                e.titulo,
            'descripcion',           e.descripcion,
            'fecha',                 e.fecha,
            'hora',                  e.hora,
            'modalidad',             e.modalidad,
            'lugar_texto',           e.lugar_texto,
            'tipo_invitacion',       e.tipo_invitacion,
            'estado',                e.estado,
            'tema',                  e.tema,
            'tema_invitacion',       COALESCE(e.tema_invitacion, 'classic'),
            'invitation_template',   e.invitation_template,
            'creado_en',             e.creado_en,
            'date_mode',             e.date_mode,
            'coordination_status',   e.coordination_status,
            'response_deadline',     e.response_deadline,
            'duration_minutes',      e.duration_minutes,
            'selected_option_id',    e.selected_option_id,
            '_mi_estado',            p.estado,
            '_mi_mensaje',           p.mensaje_respuesta,
            '_mi_token_invitacion',  p.token_invitacion
        )
        ORDER BY e.creado_en DESC
    )
    INTO v_result
    FROM participantes p
    JOIN encuentros e ON e.id = p.encuentro_id
    WHERE p.user_id = v_user_id
      AND (
          p.estado IN ('confirmado', 'rechazado')
          OR (
              e.date_mode = 'coordination' 
              AND EXISTS (
                  SELECT 1 FROM public.participante_disponibilidades pd 
                  WHERE pd.participante_id = p.id
                    AND pd.encuentro_id = e.id
              )
          )
      );

    RETURN COALESCE(v_result, '[]'::json);
END;
$function$;

-- Reaplicar permisos para asegurar modelo de seguridad
REVOKE ALL ON FUNCTION public.get_encuentros_participados_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentros_participados_seguro() TO authenticated;
