-- Migration: 20261009195000_fix_reportar_encuentro_rate_limit_call.sql
-- Conectar reportar_encuentro_publico_seguro con check_rate_limit_internal existente

BEGIN;

CREATE OR REPLACE FUNCTION public.reportar_encuentro_publico_seguro(
    p_encuentro_id UUID,
    p_reason TEXT,
    p_comment TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_reporter_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_clean_comment TEXT;
    v_rl JSONB;
    v_report_count INT := 0;
    v_threshold INT := public.get_moderation_auto_hide_threshold();
    v_auto_hidden BOOLEAN := false;
BEGIN
    -- 1. Control de autenticación y cuenta permanente
    IF v_reporter_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 2. Validación de encuentro
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_required');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    -- No permitir auto-reporte
    IF v_encuentro.host_id = v_reporter_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_report_own_encounter');
    END IF;

    -- 3. Validación de motivo
    IF p_reason IS NULL OR p_reason NOT IN ('spam', 'inappropriate_content', 'fraud_scam', 'harassment', 'other') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_report_reason');
    END IF;

    -- 4. Sanitización de comentario
    v_clean_comment := NULLIF(pg_catalog.btrim(p_comment), '');
    IF v_clean_comment IS NOT NULL THEN
        IF v_clean_comment ~* '<[^>]+>' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_comment_invalid');
        END IF;
        IF pg_catalog.length(v_clean_comment) > 500 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_comment_too_long');
        END IF;
    END IF;

    -- 5. Rate limit: reutilizar infraestructura durable check_rate_limit_internal
    v_rl := public.check_rate_limit_internal('public_content_report', '');
    IF NOT (v_rl ->> 'allowed')::boolean THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- 6. Inserción con deduplicación por (reporter_id, encuentro_id)
    BEGIN
        INSERT INTO public.public_content_reports (
            encuentro_id, reporter_id, reason, comment, status
        ) VALUES (
            p_encuentro_id, v_reporter_id, p_reason, v_clean_comment, 'pending'
        );
    EXCEPTION
        WHEN unique_violation THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_reported');
    END;

    -- 7. Evaluación de auto-ocultamiento (umbral centralizado de reportantes independientes)
    SELECT pg_catalog.count(DISTINCT reporter_id) INTO v_report_count
    FROM public.public_content_reports
    WHERE encuentro_id = p_encuentro_id AND status = 'pending';

    IF v_report_count >= v_threshold AND v_encuentro.moderation_status = 'approved' THEN
        UPDATE public.encuentros
        SET moderation_status = 'hidden_pending_review',
            is_open = false,
            closed_at = pg_catalog.clock_timestamp()
        WHERE id = p_encuentro_id;

        INSERT INTO public.public_content_moderation_audit (
            encuentro_id, moderator_id, action, previous_status, new_status,
            reason, categories, source, metadata
        ) VALUES (
            p_encuentro_id, NULL, 'auto_hide_threshold', 'approved', 'hidden_pending_review',
            'auto_hide_threshold_reached', ARRAY[p_reason]::TEXT[], 'auto_hide_threshold',
            pg_catalog.jsonb_build_object('report_count', v_report_count, 'threshold', v_threshold)
        );

        v_auto_hidden := true;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'report_count', v_report_count,
        'auto_hidden', v_auto_hidden
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reportar_encuentro_publico_seguro(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reportar_encuentro_publico_seguro(UUID, TEXT, TEXT) TO authenticated;

COMMIT;
