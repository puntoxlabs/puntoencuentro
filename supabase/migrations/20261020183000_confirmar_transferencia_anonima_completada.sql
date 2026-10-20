-- =========================================================================
-- Migración: Confirmación segura e idempotente de Transfer Tickets completados
-- Timestamp: 20261020183000
-- Objetivo: Permitir verificación de idempotencia cuando un claim se completó
-- en PostgreSQL pero la respuesta HTTP se perdió por corte de red.
-- =========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.confirmar_transferencia_anonima_completada_seguro(
    p_transfer_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_target_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_clean_token TEXT;
    v_token_hash TEXT;
    v_ticket public.anonymous_transfer_tickets%ROWTYPE;
BEGIN
    -- 1. Validaciones de Identidad y Rol del Target
    IF v_target_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 2. Limpieza y validación de formato del token (hex 64 caracteres)
    v_clean_token := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_transfer_token, '')));
    IF v_clean_token !~ '^[0-9a-f]{64}$' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_token_format');
    END IF;

    -- 3. Cálculo de hash sha256 idéntico al de claim_anonymous_transfer
    v_token_hash := pg_catalog.encode(pg_catalog.sha256(v_clean_token::bytea), 'hex');

    -- 4. Consulta del ticket
    SELECT * INTO v_ticket
    FROM public.anonymous_transfer_tickets
    WHERE token_hash = v_token_hash;

    -- 5. Confirmación estricta de idempotencia:
    -- Solo retorna true si el ticket ya fue completado Y su destinatario coincide exactamente con auth.uid()
    IF FOUND
       AND v_ticket.status = 'completed'
       AND v_ticket.used_at IS NOT NULL
       AND (v_ticket.target_user_id_snapshot = v_target_user_id OR v_ticket.target_user_id = v_target_user_id)
    THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'already_completed', true,
            'completed_at', v_ticket.used_at
        );
    END IF;

    -- 6. Fallo genérico: no revela si el ticket pertenece a otro usuario, si está pendiente, revocado o si no existe
    RETURN pg_catalog.json_build_object('ok', false, 'error', 'transfer_not_confirmed');
END;
$$;

REVOKE ALL ON FUNCTION public.confirmar_transferencia_anonima_completada_seguro(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirmar_transferencia_anonima_completada_seguro(TEXT) TO authenticated;

COMMIT;

