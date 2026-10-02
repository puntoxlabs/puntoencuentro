-- ============================================================
-- Migración: 20261002200000_harden_inbox_rpc_grants.sql
-- Módulo: Fase 1.5 — Hardening de permisos en RPCs públicas de Inbox
-- Revoca permisos de ejecución al rol anon en funciones que
-- requieren estrictamente identidad y sesión permanente.
-- Defensa en profundidad: denegación en capa de permisos de Postgres.
-- ============================================================

BEGIN;

-- 1. get_mis_notificaciones_inbox_seguro
REVOKE EXECUTE ON FUNCTION public.get_mis_notificaciones_inbox_seguro(INT, TIMESTAMPTZ, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_mis_notificaciones_inbox_seguro(INT, TIMESTAMPTZ, UUID) TO authenticated;

-- 2. get_contador_notificaciones_no_leidas_seguro
REVOKE EXECUTE ON FUNCTION public.get_contador_notificaciones_no_leidas_seguro() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_contador_notificaciones_no_leidas_seguro() TO authenticated;

-- 3. marcar_notificacion_leida_seguro
REVOKE EXECUTE ON FUNCTION public.marcar_notificacion_leida_seguro(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.marcar_notificacion_leida_seguro(UUID) TO authenticated;

-- 4. marcar_todas_notificaciones_leidas_seguro
REVOKE EXECUTE ON FUNCTION public.marcar_todas_notificaciones_leidas_seguro() FROM anon;
GRANT EXECUTE ON FUNCTION public.marcar_todas_notificaciones_leidas_seguro() TO authenticated;

COMMIT;
