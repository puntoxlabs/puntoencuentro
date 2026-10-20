-- ============================================================
-- Migración: 20261020133000_revoke_ai_internal_tables_public_privileges.sql
-- Módulo: Seguridad Preventiva Supabase 30/10/2026 (Mínimo Privilegio)
-- 
-- Regularización incremental de permisos en tablas internas de IA:
-- - public.ai_creation_sessions (RPC-only)
-- - public.ai_rate_limit_buckets (RPC-only)
-- - public.ai_burst_rate_limit_buckets (RPC-only)
--
-- Mecanismo de acceso confirmado:
-- Estas 3 tablas operan exclusivamente como infraestructura interna
-- mediante funciones SECURITY DEFINER (check_and_increment_ai_rate_limit,
-- check_and_increment_ai_burst_limit, complete_ai_creation_session,
-- registrar_sesion_ai_inicio, registrar_sesion_ai_fin, etc.).
-- No existe ningún acceso directo legítimo vía supabase.from() ni en el
-- frontend React ni en Edge Functions.
--
-- Acciones:
-- 1. REVOKE explícito de ALL ON TABLE para PUBLIC, anon y authenticated.
-- 2. GRANT explícito de ALL ON TABLE para postgres y service_role.
-- 3. Mantenimiento intacto de las políticas RLS existentes.
-- ============================================================

BEGIN;

-- 1. public.ai_creation_sessions (RPC-only)
REVOKE ALL ON TABLE public.ai_creation_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ai_creation_sessions TO postgres, service_role;

-- 2. public.ai_rate_limit_buckets (RPC-only)
REVOKE ALL ON TABLE public.ai_rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ai_rate_limit_buckets TO postgres, service_role;

-- 3. public.ai_burst_rate_limit_buckets (RPC-only)
REVOKE ALL ON TABLE public.ai_burst_rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ai_burst_rate_limit_buckets TO postgres, service_role;

COMMIT;
