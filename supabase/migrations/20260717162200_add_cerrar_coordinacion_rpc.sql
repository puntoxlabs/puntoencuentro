-- ============================================================
-- Migración: add_cerrar_coordinacion_rpc
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cerrar_coordinacion_seguro(
    p_encuentro_id uuid,
    p_selected_option_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid;
    v_encuentro record;
    v_opcion record;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); 
    END IF;

    SELECT * INTO v_encuentro FROM public.encuentros WHERE id = p_encuentro_id FOR UPDATE;
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'not_found'); 
    END IF;
    
    IF v_encuentro.host_id IS DISTINCT FROM v_user_id THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); 
    END IF;
    
    IF v_encuentro.date_mode IS DISTINCT FROM 'coordination' THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_date_mode'); 
    END IF;
    
    IF v_encuentro.coordination_status IS DISTINCT FROM 'open' THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'already_closed'); 
    END IF;

    SELECT * INTO v_opcion FROM public.encuentro_opciones_fecha
    WHERE id = p_selected_option_id AND encuentro_id = p_encuentro_id;
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_option'); 
    END IF;

    UPDATE public.encuentros
    SET 
        coordination_status = 'closed',
        selected_option_id = p_selected_option_id,
        fecha = v_opcion.fecha,
        hora = v_opcion.hora_inicio,
        estado = 'programado'
    WHERE id = p_encuentro_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_coordinacion_seguro(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cerrar_coordinacion_seguro(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.cerrar_coordinacion_seguro(uuid, uuid) TO authenticated;

COMMIT;
