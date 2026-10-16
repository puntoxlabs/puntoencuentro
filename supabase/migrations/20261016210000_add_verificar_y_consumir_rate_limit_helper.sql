-- Migración aditiva: Helper verificar_y_consumir_rate_limit para interoperabilidad con check_rate_limit_internal
-- Timestamp: 20261016210000

BEGIN;

CREATE OR REPLACE FUNCTION public.verificar_y_consumir_rate_limit(
    p_user_id UUID,
    p_action TEXT,
    p_max INT DEFAULT 5,
    p_window INTERVAL DEFAULT INTERVAL '1 hour'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_action TEXT := p_action;
    v_res JSONB;
BEGIN
    -- Mapeo canónico de acciones de rate limiting
    IF v_action = 'join_request' THEN
        v_action := 'join_open_encounter';
    END IF;

    -- Si la política existe en la infraestructura durable de rate limiting, evaluarla
    IF EXISTS (SELECT 1 FROM public.rate_limit_policies WHERE action = v_action) THEN
        RETURN public.check_rate_limit_internal(v_action, '');
    END IF;

    -- Fallback permisivo por defecto para acciones sin política persistida
    RETURN pg_catalog.jsonb_build_object('allowed', true);
END;
$$;

-- Permisos
REVOKE ALL ON FUNCTION public.verificar_y_consumir_rate_limit(UUID, TEXT, INT, INTERVAL) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verificar_y_consumir_rate_limit(UUID, TEXT, INT, INTERVAL) TO authenticated, service_role;

COMMIT;
