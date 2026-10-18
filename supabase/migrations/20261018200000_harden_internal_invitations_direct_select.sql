-- ============================================================
-- Migración: 20261018200000_harden_internal_invitations_direct_select.sql
-- Módulo: Corrección P0 de privacidad contra enumeración residual
-- Restringe la lectura directa (SELECT) de public.solicitudes_invitacion_interna
-- y public.invitaciones_internas por roles clientes (authenticated, anon, PUBLIC).
--
-- Toda lectura e interacción de los usuarios (tanto organizadores como invitados)
-- debe realizarse exclusivamente a través de las RPCs autorizadas con SECURITY DEFINER:
--   - public.enviar_invitacion_interna_seguro
--   - public.responder_invitacion_interna_seguro
--   - public.cancelar_invitacion_interna_seguro
--   - public.get_invitaciones_internas_encuentro_seguro
--   - public.get_mis_invitaciones_internas_seguro
--   - public.get_detalle_invitacion_interna_seguro
--   - public.purgar_solicitudes_invitaciones_antiguas_seguro
--
-- Se mantiene el acceso interno de service_role y postgres.
-- ============================================================

BEGIN;

-- 1. Eliminar políticas permisivas de lectura directa para authenticated
DROP POLICY IF EXISTS solicitudes_invitacion_interna_select_host ON public.solicitudes_invitacion_interna;
DROP POLICY IF EXISTS invitaciones_internas_select_parties ON public.invitaciones_internas;

-- 2. Revocar privilegios de lectura (SELECT) y cualquier otro permiso a clientes directos
REVOKE ALL ON TABLE public.solicitudes_invitacion_interna FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.invitaciones_internas FROM PUBLIC, anon, authenticated;

-- 3. Garantizar acceso administrativo y de workers exclusivamente para service_role y postgres
GRANT ALL ON TABLE public.solicitudes_invitacion_interna TO postgres, service_role;
GRANT ALL ON TABLE public.invitaciones_internas TO postgres, service_role;

-- 4. Validar y reafirmar permisos EXECUTE en las RPCs seguras para authenticated
GRANT EXECUTE ON FUNCTION public.enviar_invitacion_interna_seguro(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.responder_invitacion_interna_seguro(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_invitacion_interna_seguro(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invitaciones_internas_encuentro_seguro(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_mis_invitaciones_internas_seguro() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_detalle_invitacion_interna_seguro(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purgar_solicitudes_invitaciones_antiguas_seguro(INTERVAL) TO authenticated;

COMMIT;
