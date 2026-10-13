-- ============================================================
-- Migración: 20261013160000_allow_cancelled_status_solicitudes.sql
-- Ampliación de check constraint para soportar 'cancelled'
-- en solicitudes_encuentro_abierto.
-- ============================================================

BEGIN;

ALTER TABLE public.solicitudes_encuentro_abierto
    DROP CONSTRAINT IF EXISTS solicitudes_encuentro_abierto_estado_check;

ALTER TABLE public.solicitudes_encuentro_abierto
    ADD CONSTRAINT solicitudes_encuentro_abierto_estado_check
    CHECK (estado IN ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled'));

COMMIT;
