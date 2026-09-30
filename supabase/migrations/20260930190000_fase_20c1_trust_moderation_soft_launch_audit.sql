-- ==============================================================================
-- Migración: 20260930190000_fase_20c1_trust_moderation_soft_launch_audit.sql
-- Fase 2.0-C1 (T4-B1): Trazabilidad mínima de moderación para Soft Launch
--
-- Agrega columnas de auditoría y restricciones de consistencia a
-- public.reportes_encuentro para permitir revisión y resolución manual
-- auditable desde Supabase Dashboard durante el Soft Launch.
-- ==============================================================================

BEGIN;

-- 1. Agregar columnas de trazabilidad
ALTER TABLE public.reportes_encuentro
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS reviewed_by UUID NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS resolved_by UUID NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS resolution_note TEXT NULL;

-- 2. Constraints de consistencia
ALTER TABLE public.reportes_encuentro
    ADD CONSTRAINT reportes_encuentro_resolution_note_length
        CHECK (resolution_note IS NULL OR pg_catalog.length(resolution_note) <= 2000),
    ADD CONSTRAINT reportes_encuentro_reviewed_pair
        CHECK (
            (reviewed_at IS NULL AND reviewed_by IS NULL) OR
            (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
        ),
    ADD CONSTRAINT reportes_encuentro_resolved_pair
        CHECK (
            (resolved_at IS NULL AND resolved_by IS NULL) OR
            (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
        ),
    ADD CONSTRAINT reportes_encuentro_temporal_coherence
        CHECK (
            reviewed_at IS NULL OR resolved_at IS NULL OR reviewed_at <= resolved_at
        ),
    ADD CONSTRAINT reportes_encuentro_estado_coherence
        CHECK (
            (estado = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL)
            OR
            (estado = 'reviewed' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND resolved_at IS NULL AND resolved_by IS NULL)
            OR
            (estado IN ('dismissed', 'actioned') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
        );

-- 3. Índice para cola operativa de moderación manual (pending ordenado cronológicamente)
CREATE INDEX IF NOT EXISTS idx_reportes_encuentro_estado_created
    ON public.reportes_encuentro (estado, created_at ASC);

-- 4. Mantener aislamiento estricto de privacidad (privada sin acceso a usuarios normales)
REVOKE ALL ON TABLE public.reportes_encuentro FROM PUBLIC, anon, authenticated;

COMMIT;
