-- ============================================================
-- Migración: 20260929141500_harden_complete_ai_creation_session.sql
-- Módulo: Encuentros Abiertos 1.5-D — Hardening de complete_ai_creation_session
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.complete_ai_creation_session(
    p_session_id UUID,
    p_encounter_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_status TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF p_session_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_session_id');
    END IF;

    IF p_encounter_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_encounter_id');
    END IF;

    -- Validar que la sesión existe y pertenece al usuario
    SELECT status INTO v_status 
    FROM public.ai_creation_sessions 
    WHERE id = p_session_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'session_not_found');
    END IF;

    -- Validar que la sesión no esté ya en un estado terminal
    IF v_status IN ('completed', 'abandoned', 'error', 'fallback_manual') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'session_already_terminal');
    END IF;

    -- Validar que el encuentro existe y el usuario es su host
    IF NOT EXISTS (SELECT 1 FROM public.encuentros WHERE id = p_encounter_id AND host_id = v_user_id) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_ownership_mismatch');
    END IF;

    UPDATE public.ai_creation_sessions
    SET status = 'completed',
        encounter_id = p_encounter_id,
        completed_at = pg_catalog.timezone('utc', pg_catalog.now()),
        last_interaction_at = pg_catalog.timezone('utc', pg_catalog.now()),
        processing_lease_id = NULL,
        processing_expires_at = NULL
    WHERE id = p_session_id AND user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_ai_creation_session(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_ai_creation_session(UUID, UUID) TO authenticated;

COMMIT;
