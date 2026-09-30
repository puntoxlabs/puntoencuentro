-- ==============================================================================
-- Migración: 20260930133000_fix_fase_20c1_trust_report_context_and_temporal.sql
-- Fase 2.0-C1 (T2-A Micro-fix): Robustez de pre_solicitud y semántica temporal post
--
-- Correcciones:
-- 1. Pre-solicitud: Permitir que el host reporte abuso en una solicitud sin
--    importar si su estado actual es pending, rejected, withdrawn o approved,
--    impidiendo que retirar la solicitud evite un reporte antes del inicio.
-- 2. Semántica temporal post-encuentro:
--    - Si duration_minutes IS NOT NULL: umbral basado en el fin estimado explícito.
--    - Si duration_minutes IS NULL: umbral canónico del proyecto (start + post_event_active_minutes / 45m)
--      tratado conceptualmente como post_report_threshold para clasificar el encuentro
--      como "pasado" en plataforma (sin afirmar duración física ni asistencia).
--    - La ventana de 72h se cuenta estrictamente desde dicho post_report_threshold.
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.crear_reporte_seguro(
    p_solicitud_id UUID,
    p_contexto TEXT,
    p_motivo TEXT,
    p_detalle TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_reporter UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_reported UUID;
    v_detalle TEXT;
    v_start_ts TIMESTAMPTZ;
    v_post_report_threshold TIMESTAMPTZ;
BEGIN
    -- 1. Control de autenticación y cuenta permanente
    IF v_reporter IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 2. Validación de parámetros de entrada
    IF p_solicitud_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_relationship_invalid');
    END IF;

    IF p_contexto IS NULL OR p_contexto NOT IN ('pre_solicitud', 'post_encuentro') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_context_invalid');
    END IF;

    -- 3. Sanitización y validación del detalle
    v_detalle := NULLIF(pg_catalog.btrim(p_detalle), '');
    IF v_detalle IS NOT NULL THEN
        IF v_detalle ~* '<[^>]+>' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_detail_invalid');
        END IF;
        IF pg_catalog.length(v_detalle) > 1000 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_detail_too_long');
        END IF;
    END IF;

    -- 4. Validación de motivos según contexto
    IF p_contexto = 'pre_solicitud' THEN
        IF p_motivo NOT IN ('commercial_spam', 'inappropriate_behavior', 'safety_concern') THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_reason_invalid');
        END IF;
    ELSIF p_contexto = 'post_encuentro' THEN
        IF p_motivo NOT IN ('inappropriate_behavior', 'commercial_spam', 'safety_concern', 'other') THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_reason_invalid');
        END IF;
        IF p_motivo = 'other' AND v_detalle IS NULL THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_detail_required');
        END IF;
    END IF;

    -- 5. Cargar la solicitud
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_solicitud_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_relationship_invalid');
    END IF;

    -- 6. Cargar el encuentro correspondiente
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_solicitud.encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_relationship_invalid');
    END IF;

    -- 7. Verificar que corresponda a un Encuentro Abierto
    IF v_encuentro.opened_at IS NULL AND v_encuentro.is_open <> true THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_relationship_invalid');
    END IF;

    -- 8. Derivación estricta de la relación y reported_id según contexto
    IF p_contexto = 'pre_solicitud' THEN
        -- Únicamente HOST -> SOLICITANTE
        IF v_encuentro.host_id <> v_reporter THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_relationship_invalid');
        END IF;

        -- Permitido independientemente del estado de la solicitud (pending, rejected, withdrawn, approved)
        -- para que el solicitante no pueda evadir el reporte retirando su solicitud.
        v_reported := v_solicitud.usuario_id;

    ELSIF p_contexto = 'post_encuentro' THEN
        -- Requiere solicitud 'approved'
        IF v_solicitud.estado <> 'approved' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_relationship_invalid');
        END IF;

        -- Direcciones permitidas: HOST -> PARTICIPANTE o PARTICIPANTE -> HOST
        IF v_reporter = v_encuentro.host_id THEN
            v_reported := v_solicitud.usuario_id;
        ELSIF v_reporter = v_solicitud.usuario_id THEN
            v_reported := v_encuentro.host_id;
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_relationship_invalid');
        END IF;
    END IF;

    -- 9. Invariante: Nunca permitir self-report
    IF v_reported IS NULL OR v_reported = v_reporter THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_relationship_invalid');
    END IF;

    -- 10. Ventanas temporales usando la lógica canónica del proyecto
    IF v_encuentro.fecha IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_window_closed');
    END IF;

    v_start_ts := (v_encuentro.fecha + COALESCE(v_encuentro.hora, '00:00:00'::time)) AT TIME ZONE 'America/Argentina/Buenos_Aires';

    -- Determinación del umbral post_report_threshold:
    -- A. Si duration_minutes IS NOT NULL: fin estimado explícito del encuentro.
    -- B. Si duration_minutes IS NULL: fallback canónico del proyecto (start + post_event_active_minutes/45m)
    --    para clasificar el encuentro como "pasado" en la plataforma.
    IF v_encuentro.duration_minutes IS NOT NULL THEN
        v_post_report_threshold := v_start_ts + (v_encuentro.duration_minutes * interval '1 minute');
    ELSE
        v_post_report_threshold := v_start_ts + (COALESCE(v_encuentro.post_event_active_minutes, 45) * interval '1 minute');
    END IF;

    IF p_contexto = 'pre_solicitud' THEN
        -- Permitir mientras el encuentro aún no haya comenzado
        IF pg_catalog.now() >= v_start_ts THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_window_closed');
        END IF;
    ELSIF p_contexto = 'post_encuentro' THEN
        -- Permitir únicamente a partir del umbral post_report_threshold y hasta 72h posteriores
        IF pg_catalog.now() <= v_post_report_threshold THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_window_closed');
        END IF;

        IF pg_catalog.now() > (v_post_report_threshold + interval '72 hours') THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_window_closed');
        END IF;
    END IF;

    -- 11. Deduplicación: no permitir reportes duplicados para la misma relación y contexto
    IF EXISTS (
        SELECT 1 FROM public.reportes_encuentro
        WHERE solicitud_id = p_solicitud_id
          AND reporter_id = v_reporter
          AND contexto = p_contexto
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_already_exists');
    END IF;

    -- 12. Insertar reporte con estado inicial 'pending'
    INSERT INTO public.reportes_encuentro (
        solicitud_id,
        encuentro_id,
        reporter_id,
        reported_id,
        contexto,
        motivo,
        detalle,
        estado
    ) VALUES (
        p_solicitud_id,
        v_encuentro.id,
        v_reporter,
        v_reported,
        p_contexto,
        p_motivo,
        v_detalle,
        'pending'
    );

    -- 13. Retorno mínimo sanitizado
    RETURN pg_catalog.json_build_object(
        'ok', true,
        'estado', 'pending'
    );
END;
$$;

-- Permisos mínimos
REVOKE ALL ON FUNCTION public.crear_reporte_seguro(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crear_reporte_seguro(UUID, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.crear_reporte_seguro(UUID, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;
