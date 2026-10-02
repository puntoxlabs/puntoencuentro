-- ============================================================
-- Migration: 20261002150000_harden_coverage_catalog_exposure.sql
-- Module: Dynamic Coverage MVP — Harden catalog exposure
-- Purpose: Revoke direct Data API SELECT on coverage_markets and
--          coverage_location_aliases from anon and authenticated.
--          Geographic resolution is handled internally via SECURITY DEFINER.
-- ============================================================

BEGIN;

-- 1. Revocar lectura directa en candidate markets para anon/auth
DROP POLICY IF EXISTS "coverage_markets_read_policy" ON public.coverage_markets;
REVOKE SELECT ON TABLE public.coverage_markets FROM anon, authenticated;

-- 2. Revocar lectura directa en aliases territoriales para anon/auth
DROP POLICY IF EXISTS "coverage_aliases_read_policy" ON public.coverage_location_aliases;
REVOKE SELECT ON TABLE public.coverage_location_aliases FROM anon, authenticated;

COMMIT;
