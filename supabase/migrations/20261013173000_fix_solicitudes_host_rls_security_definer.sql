-- ============================================================
-- Migración: 20261013173000_fix_solicitudes_host_rls_security_definer.sql
-- Microcheck B:
-- Permitir que el Host evalúe la propiedad de sus encuentros en RLS
-- de solicitudes_encuentro_abierto mediante una función SECURITY DEFINER,
-- dado que public.encuentros tiene permisos directos revocados para authenticated.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.is_encounter_host(
    p_encuentro_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.encuentros e
        WHERE e.id = p_encuentro_id
          AND e.host_id = auth.uid()
    );
$$;

REVOKE ALL ON FUNCTION public.is_encounter_host(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_encounter_host(UUID) TO authenticated;

-- Actualizar política de lectura del Host
DROP POLICY IF EXISTS solicitudes_host_read_policy ON public.solicitudes_encuentro_abierto;

CREATE POLICY solicitudes_host_read_policy
    ON public.solicitudes_encuentro_abierto
    FOR SELECT
    TO authenticated
    USING (
        public.is_encounter_host(solicitudes_encuentro_abierto.encuentro_id)
        AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    );

COMMIT;
