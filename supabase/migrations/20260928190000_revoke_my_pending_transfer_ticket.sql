-- ============================================================
-- PuntoEncuentro 1.5-C.1: Revocación Segura de Pending Transfer Ticket
--
-- Permite al usuario anónimo revocar su propio transfer ticket pendiente
-- en caso de pérdida local del secret (p. ej. sessionStorage borrado)
-- sin filtrar secretos ni permitir revocaciones ajenas.
-- ============================================================

DROP FUNCTION IF EXISTS public.revoke_my_pending_transfer_ticket();

CREATE OR REPLACE FUNCTION public.revoke_my_pending_transfer_ticket()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID;
    v_is_anon BOOLEAN;
    v_revoked_count INT := 0;
BEGIN
    v_user_id := auth.uid();
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);

    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'authentication_required'
        );
    END IF;

    IF NOT v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'anonymous_user_required'
        );
    END IF;

    UPDATE public.anonymous_transfer_tickets
    SET status = 'revoked'
    WHERE source_user_id = v_user_id
      AND status = 'pending';

    GET DIAGNOSTICS v_revoked_count = ROW_COUNT;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'revoked_count', v_revoked_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_my_pending_transfer_ticket() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_my_pending_transfer_ticket() TO authenticated;
