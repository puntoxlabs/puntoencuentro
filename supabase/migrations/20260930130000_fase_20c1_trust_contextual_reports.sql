-- ==============================================================================
-- Migración: 20260930130000_fase_20c1_trust_contextual_reports.sql
-- Fase 2.0-C1 (T2-A): Almacenamiento seguro de reportes contextuales (P0)
--
-- Principio crítico:
-- El cliente NO elige libremente a quién reportar.
-- Toda relación reportante/reportado se deriva server-side desde una solicitud
-- real y su correspondiente Encuentro Abierto.
--
-- Contextos soportados:
-- 1. pre_solicitud: Host reporta al solicitante antes de que inicie el encuentro.
-- 2. post_encuentro: Host o Participante Aprobado se reportan mutuamente dentro
--    de las 72h posteriores a la finalización efectiva del encuentro.
-- ==============================================================================

BEGIN;

-- 1. Crear tabla privada de reportes de encuentro
CREATE TABLE IF NOT EXISTS public.reportes_encuentro (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    solicitud_id UUID NOT NULL REFERENCES public.solicitudes_encuentro_abierto(id) ON DELETE CASCADE,
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reported_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    contexto TEXT NOT NULL CHECK (contexto IN ('pre_solicitud', 'post_encuentro')),
    motivo TEXT NOT NULL,
    detalle TEXT NULL,
    estado TEXT NOT NULL DEFAULT 'pending' CHECK (estado IN ('pending', 'reviewed', 'dismissed', 'actioned')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reportes_encuentro_unique_report UNIQUE (solicitud_id, reporter_id, contexto),
    CONSTRAINT reportes_encuentro_no_self_report CHECK (reporter_id <> reported_id),
    CONSTRAINT reportes_encuentro_motivo_contexto CHECK (
        (contexto = 'pre_solicitud' AND motivo IN ('commercial_spam', 'inappropriate_behavior', 'safety_concern'))
        OR
        (contexto = 'post_encuentro' AND motivo IN ('inappropriate_behavior', 'commercial_spam', 'safety_concern', 'other'))
    )
);

-- Índices de consulta administrativa y auditoría
CREATE INDEX IF NOT EXISTS idx_reportes_encuentro_solicitud ON public.reportes_encuentro(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_reportes_encuentro_encuentro ON public.reportes_encuentro(encuentro_id);
CREATE INDEX IF NOT EXISTS idx_reportes_encuentro_reporter ON public.reportes_encuentro(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reportes_encuentro_reported ON public.reportes_encuentro(reported_id);
CREATE INDEX IF NOT EXISTS idx_reportes_encuentro_estado ON public.reportes_encuentro(estado);

-- 2. Seguridad RLS: Tabla privada sin acceso directo a usuarios normales
ALTER TABLE public.reportes_encuentro ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.reportes_encuentro FROM PUBLIC, anon, authenticated;

-- 3. RPC: crear_reporte_seguro
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
    v_end_ts TIMESTAMPTZ;
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
    v_end_ts := v_start_ts + (COALESCE(v_encuentro.duration_minutes, v_encuentro.post_event_active_minutes, 45) * interval '1 minute');

    IF p_contexto = 'pre_solicitud' THEN
        -- Permitir mientras el encuentro aún no haya comenzado
        IF pg_catalog.now() >= v_start_ts THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_window_closed');
        END IF;
    ELSIF p_contexto = 'post_encuentro' THEN
        -- Permitir únicamente después de finalizado el encuentro y hasta 72h posteriores
        IF pg_catalog.now() <= v_end_ts THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_window_closed');
        END IF;

        IF pg_catalog.now() > (v_end_ts + interval '72 hours') THEN
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

-- 4. Permisos mínimos: solo usuarios autenticados pueden invocar la RPC
REVOKE ALL ON FUNCTION public.crear_reporte_seguro(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crear_reporte_seguro(UUID, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.crear_reporte_seguro(UUID, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;
