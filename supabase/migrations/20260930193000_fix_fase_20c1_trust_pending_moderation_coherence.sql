-- ==============================================================================
-- Migración: 20260930193000_fix_fase_20c1_trust_pending_moderation_coherence.sql
-- Fase 2.0-C1 (T4-B1.1): Coherencia estricta para reportes en estado pending
--
-- Exige que todo reporte con estado = 'pending' tenga estrictamente NULL
-- en reviewed_at, reviewed_by, resolved_at y resolved_by.
-- ==============================================================================

BEGIN;

ALTER TABLE public.reportes_encuentro
    ADD CONSTRAINT reportes_encuentro_pending_unreviewed
        CHECK (
            estado <> 'pending'
            OR (
                reviewed_at IS NULL
                AND reviewed_by IS NULL
                AND resolved_at IS NULL
                AND resolved_by IS NULL
            )
        );

COMMIT;
