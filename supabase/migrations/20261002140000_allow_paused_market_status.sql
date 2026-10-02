-- ============================================================
-- Migration: 20261002140000_allow_paused_market_status.sql
-- Module: Dynamic Coverage MVP — Permit 'paused' in coverage_markets status
-- ============================================================

BEGIN;

ALTER TABLE public.coverage_markets
DROP CONSTRAINT IF EXISTS coverage_markets_status_check;

ALTER TABLE public.coverage_markets
ADD CONSTRAINT coverage_markets_status_check
CHECK (status IN ('collecting', 'reviewing', 'planned', 'active', 'paused'));

COMMIT;
