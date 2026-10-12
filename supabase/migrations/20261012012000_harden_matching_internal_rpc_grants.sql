-- ============================================================
-- Migración: 20261012012000_harden_matching_internal_rpc_grants.sql
-- Módulo: Hardening P0 de privilegios EXECUTE en funciones internas de matching
-- ============================================================

BEGIN;

-- 1. Funciones internas de evaluación de matching:
-- Sólo ejecutables por postgres y service_role (worker).
-- Revocadas estrictamente de PUBLIC, anon y authenticated.
REVOKE ALL ON FUNCTION public.evaluar_matching_encuentro_abierto(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluar_matching_encuentro_abierto(UUID) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.evaluar_matching_intencion_activa(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluar_matching_intencion_activa(UUID) TO postgres, service_role;

-- 2. Funciones de triggers de clasificación:
-- No deben ser invocables externamente como RPCs por roles cliente.
REVOKE ALL ON FUNCTION public.fn_trg_intenciones_classify_activity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trg_intenciones_classify_activity() TO postgres, service_role;

REVOKE ALL ON FUNCTION public.fn_trg_encuentros_classify_open_activity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trg_encuentros_classify_open_activity() TO postgres, service_role;

COMMIT;
