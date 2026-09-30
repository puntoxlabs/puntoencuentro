-- ==============================================================================
-- Migración: 20260930140000_fix_fase_20c1_trust_preserve_reports_on_delete.sql
-- Fase 2.0-C1 (T2): Preservación de evidencia de moderación en reportes_encuentro
--
-- Reemplaza las cláusulas ON DELETE CASCADE de las foreign keys de reportes_encuentro
-- por ON DELETE RESTRICT para garantizar que la evidencia de moderación no sea
-- destruida por la eliminación física de encuentros, solicitudes o usuarios.
-- ==============================================================================

BEGIN;

-- 1. Modificar foreign key de solicitud_id
ALTER TABLE public.reportes_encuentro
    DROP CONSTRAINT IF EXISTS reportes_encuentro_solicitud_id_fkey;

ALTER TABLE public.reportes_encuentro
    ADD CONSTRAINT reportes_encuentro_solicitud_id_fkey
        FOREIGN KEY (solicitud_id) REFERENCES public.solicitudes_encuentro_abierto(id) ON DELETE RESTRICT;

-- 2. Modificar foreign key de encuentro_id
ALTER TABLE public.reportes_encuentro
    DROP CONSTRAINT IF EXISTS reportes_encuentro_encuentro_id_fkey;

ALTER TABLE public.reportes_encuentro
    ADD CONSTRAINT reportes_encuentro_encuentro_id_fkey
        FOREIGN KEY (encuentro_id) REFERENCES public.encuentros(id) ON DELETE RESTRICT;

-- 3. Modificar foreign key de reporter_id
ALTER TABLE public.reportes_encuentro
    DROP CONSTRAINT IF EXISTS reportes_encuentro_reporter_id_fkey;

ALTER TABLE public.reportes_encuentro
    ADD CONSTRAINT reportes_encuentro_reporter_id_fkey
        FOREIGN KEY (reporter_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- 4. Modificar foreign key de reported_id
ALTER TABLE public.reportes_encuentro
    DROP CONSTRAINT IF EXISTS reportes_encuentro_reported_id_fkey;

ALTER TABLE public.reportes_encuentro
    ADD CONSTRAINT reportes_encuentro_reported_id_fkey
        FOREIGN KEY (reported_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

COMMIT;
