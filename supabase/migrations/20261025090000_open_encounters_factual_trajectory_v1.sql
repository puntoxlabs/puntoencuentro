-- ==============================================================================
-- Migración: 20261025090000_open_encounters_factual_trajectory_v1.sql
-- Fase V1 Mini-Sprint D — Confianza Bidireccional: Base Factual y Trayectoria
--                         en Encuentros Abiertos
--
-- Principios Arquitecturales e Invariantes:
-- 1. Ámbito exclusivo de Encuentros Abiertos:
--    - Los encuentros exclusivamente privados (opened_at IS NULL) quedan 100% excluidos.
--    - En encuentros convertidos de privados a abiertos, la actividad previa de invitados
--      privados no se incorpora al historial reputacional abierto.
-- 2. Diferenciación estricta de tres capas:
--    A. Datos objetivos de la plataforma (encuentros organizados, confirmaciones, cancelaciones, retiros).
--    B. Declaraciones individuales (asistencia declarada por host, reclamos presentados).
--    C. Hechos corroborados (reconocimientos expresos del usuario, resoluciones definitivas de moderación).
-- 3. Historial bidireccional segregado:
--    - Trayectoria como Anfitrión vs Trayectoria como Participante.
-- 4. Neutralidad y tamaño de muestra:
--    - Tratamiento neutral sin penalizaciones automáticas ni scoring negativo.
--    - Conteo de experiencias únicas e identificación de muestra suficiente/insuficiente.
-- 5. Privacidad y seguridad server-side:
--    - Solo el propio usuario y moderadores autorizados pueden consultar la trayectoria.
--    - Acompañantes multi-seat sin cuenta (user_id IS NULL) no generan historial personal.
-- ==============================================================================

BEGIN;

-- Asegurar existencia de columna de trazabilidad de admisión (idempotente)
ALTER TABLE public.participantes ADD COLUMN IF NOT EXISTS admission_source TEXT;

-- ------------------------------------------------------------------------------
-- 1. RPC: get_trayectoria_encuentros_abiertos_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_trayectoria_encuentros_abiertos_seguro(
    p_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_is_mod BOOLEAN := public.is_moderation_authorized();
    v_target_id UUID;

    -- Contexto general y muestra
    v_antiguedad_primer_encuentro TIMESTAMPTZ := NULL;
    v_recencia_ultimo_encuentro TIMESTAMPTZ := NULL;
    v_total_experiencias_unicas INT := 0;
    v_anfitriones_distintos_interactuados INT := 0;

    -- Trayectoria Anfitrión: Objetivos
    v_host_encuentros_organizados INT := 0;
    v_host_encuentros_completados_declarados INT := 0;
    v_host_encuentros_no_realizados_declarados INT := 0;
    v_host_encuentros_cancelados INT := 0;
    v_host_participantes_recibidos_total INT := 0;
    v_host_cierres_a_tiempo INT := 0;
    v_host_cierres_tardios INT := 0;
    v_host_cierres_auto_regularizados INT := 0;
    v_host_cierres_pendientes INT := 0;

    -- Trayectoria Anfitrión: Reclamos y Moderación recibida
    v_host_reclamos_pendientes INT := 0;
    v_host_ausencias_acreditadas INT := 0;
    v_host_no_realizaciones_acreditadas INT := 0;
    v_host_errores_cierre_acreditados INT := 0;
    v_host_reclamos_desestimados INT := 0;
    v_host_reclamos_rectificados INT := 0;

    -- Trayectoria Participante: Objetivos
    v_part_encuentros_confirmados INT := 0;
    v_part_reconfirmaciones_completadas INT := 0;
    v_part_retiros_voluntarios INT := 0;

    -- Trayectoria Participante: Declaraciones del host
    v_part_asistencias_declaradas_host INT := 0;
    v_part_inasistencias_reportadas_host INT := 0;
    v_part_asistencias_sin_verificar INT := 0;

    -- Trayectoria Participante: Hechos corroborados
    v_part_asistencias_corroboradas INT := 0;
    v_part_inasistencias_reconocidas INT := 0;
    v_part_inasistencias_confirmadas_moderacion INT := 0;
    v_part_inasistencias_justificadas INT := 0;
    v_part_inasistencias_timeout_neutral INT := 0;

    v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
    -- 1. Control de acceso e identidad
    IF v_caller_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_user_id IS NOT NULL AND p_user_id <> v_caller_id THEN
        IF NOT v_is_mod THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
        END IF;
        v_target_id := p_user_id;
    ELSE
        v_target_id := v_caller_id;
    END IF;

    -- =========================================================================
    -- A. TRAYECTORIA COMO ANFITRIÓN (Exclusivamente Encuentros Abiertos)
    --    Criterio: e.host_id = v_target_id AND e.opened_at IS NOT NULL
    -- =========================================================================
    SELECT
        COALESCE(pg_catalog.count(DISTINCT e.id), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN e.post_event_realization_status = 'realized' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN e.post_event_realization_status = 'not_realized' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN e.estado = 'cancelado' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN (e.post_event_closure_status = 'completed' AND (e.post_event_closure_type = 'within_deadline' OR e.post_event_closure_type IS NULL)) OR e.post_event_closure_status = 'closed_on_time' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN e.post_event_closure_type = 'overdue' OR e.post_event_closure_status = 'overdue' OR e.post_event_closure_status = 'closed_late' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN e.post_event_closure_status = 'auto_closed' OR e.post_event_closure_type = 'administrative_auto' OR e.post_event_closure_type = 'auto_empty_regularization' OR e.post_event_closure_status = 'expired_unconfirmed' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN (e.post_event_closure_status = 'pending' OR (e.post_event_closed_at IS NULL AND e.estado <> 'cancelado' AND ((e.fecha::text || ' ' || e.hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') < v_now)) THEN 1 ELSE 0 END), 0)::int
    INTO
        v_host_encuentros_organizados,
        v_host_encuentros_completados_declarados,
        v_host_encuentros_no_realizados_declarados,
        v_host_encuentros_cancelados,
        v_host_cierres_a_tiempo,
        v_host_cierres_tardios,
        v_host_cierres_auto_regularizados,
        v_host_cierres_pendientes
    FROM public.encuentros e
    WHERE e.host_id = v_target_id
      AND e.opened_at IS NOT NULL;

    -- Participantes confirmados/asistieron en sus encuentros abiertos (excluyendo al anfitrión)
    SELECT COALESCE(pg_catalog.count(*), 0)::int
    INTO v_host_participantes_recibidos_total
    FROM public.participantes p
    JOIN public.encuentros e ON e.id = p.encuentro_id
    WHERE e.host_id = v_target_id
      AND e.opened_at IS NOT NULL
      AND p.user_id IS NOT NULL
      AND p.user_id <> v_target_id
      AND p.estado IN ('confirmado', 'asistio')
      AND p.admission_source IS DISTINCT FROM 'private_general_link';

    -- Reclamos y resoluciones de moderación recibidos por el anfitrión (Sprint C)
    SELECT
        COALESCE(pg_catalog.sum(CASE WHEN c.estado IN ('awaiting_response', 'in_human_review') THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN c.tipo_controversia = 'host_no_show' AND (c.resolucion_tipo = 'confirmed' OR (c.metadata ->> 'confirmed_fact') = 'host_absence_confirmed') THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN c.tipo_controversia = 'encounter_not_realized' AND (c.resolucion_tipo = 'confirmed' OR (c.metadata ->> 'confirmed_fact') = 'encounter_not_realized_confirmed') THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN c.tipo_controversia = 'closure_data_error' AND (c.resolucion_tipo = 'confirmed' OR (c.metadata ->> 'confirmed_fact') = 'closure_data_error_confirmed') THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN c.resolucion_tipo = 'insufficient_evidence' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN c.resolucion_tipo = 'rectified' THEN 1 ELSE 0 END), 0)::int
    INTO
        v_host_reclamos_pendientes,
        v_host_ausencias_acreditadas,
        v_host_no_realizaciones_acreditadas,
        v_host_errores_cierre_acreditados,
        v_host_reclamos_desestimados,
        v_host_reclamos_rectificados
    FROM public.asistencia_controversias c
    JOIN public.encuentros e ON e.id = c.encuentro_id
    WHERE c.involucrado_id = v_target_id
      AND e.opened_at IS NOT NULL
      AND c.tipo_controversia IN ('encounter_not_realized', 'host_no_show', 'closure_data_error');

    -- =========================================================================
    -- B. TRAYECTORIA COMO PARTICIPANTE (Exclusivamente Encuentros Abiertos)
    --    Criterio:
    --      p.user_id = v_target_id AND p.user_id <> e.host_id
    --      AND e.opened_at IS NOT NULL
    --      AND p.admission_source IS DISTINCT FROM 'private_general_link'
    --      AND (p.creado_en >= e.opened_at OR p.admission_source = 'post_open_generic' OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto s WHERE s.participante_id = p.id))
    -- =========================================================================
    SELECT
        -- Encuentros confirmados únicos
        COALESCE(pg_catalog.count(DISTINCT e.id), 0)::int,
        -- Reconfirmaciones completadas
        COALESCE(pg_catalog.sum(CASE WHEN p.reconfirmation_status = 'reconfirmed' THEN 1 ELSE 0 END), 0)::int,
        -- Declaración individual: asistencia declarada por host
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_status = 'attended' AND (p.attendance_dispute_status IS NULL OR p.attendance_dispute_status IN ('none', 'pending_review')) THEN 1 ELSE 0 END), 0)::int,
        -- Declaración individual: inasistencia reportada por host
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_status = 'reported_absent' AND p.attendance_dispute_status = 'awaiting_response' THEN 1 ELSE 0 END), 0)::int,
        -- Declaración individual: salida neutral sin verificar
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_status = 'unverified' AND (p.attendance_dispute_status IS NULL OR p.attendance_dispute_status = 'none') THEN 1 ELSE 0 END), 0)::int,
        -- Hecho corroborado: asistencia verificada o rectificada por moderación
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_status = 'attended' AND p.attendance_dispute_status IN ('resolved_registration_error', 'rectified') THEN 1 ELSE 0 END), 0)::int,
        -- Hecho corroborado: inasistencia expresamente reconocida por el usuario
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_dispute_status = 'confirmed_by_participant' THEN 1 ELSE 0 END), 0)::int,
        -- Hecho corroborado: inasistencia confirmada por moderador independiente
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_dispute_status = 'resolved_unjustified' THEN 1 ELSE 0 END), 0)::int,
        -- Hecho corroborado: inasistencia justificada por moderador
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_dispute_status = 'resolved_justified' THEN 1 ELSE 0 END), 0)::int,
        -- Hecho corroborado: silencio tras 7 días (unverified_timeout, salida neutral no penalizable)
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_dispute_status = 'unverified_timeout' THEN 1 ELSE 0 END), 0)::int
    INTO
        v_part_encuentros_confirmados,
        v_part_reconfirmaciones_completadas,
        v_part_asistencias_declaradas_host,
        v_part_inasistencias_reportadas_host,
        v_part_asistencias_sin_verificar,
        v_part_asistencias_corroboradas,
        v_part_inasistencias_reconocidas,
        v_part_inasistencias_confirmadas_moderacion,
        v_part_inasistencias_justificadas,
        v_part_inasistencias_timeout_neutral
    FROM public.participantes p
    JOIN public.encuentros e ON e.id = p.encuentro_id
    WHERE p.user_id = v_target_id
      AND p.user_id <> e.host_id
      AND e.opened_at IS NOT NULL
      AND p.estado IN ('confirmado', 'asistio')
      AND p.admission_source IS DISTINCT FROM 'private_general_link'
      AND (
          p.creado_en >= e.opened_at
          OR p.admission_source = 'post_open_generic'
          OR EXISTS (
              SELECT 1 FROM public.solicitudes_encuentro_abierto s
              WHERE s.participante_id = p.id
          )
      );

    -- Retiros voluntarios registrados de solicitudes en encuentros abiertos
    SELECT COALESCE(pg_catalog.count(DISTINCT s.encuentro_id), 0)::int
    INTO v_part_retiros_voluntarios
    FROM public.solicitudes_encuentro_abierto s
    JOIN public.encuentros e ON e.id = s.encuentro_id
    WHERE s.usuario_id = v_target_id
      AND e.opened_at IS NOT NULL
      AND s.estado = 'withdrawn';

    -- Cantidad de anfitriones distintos con los que ha participado en encuentros abiertos
    SELECT COALESCE(pg_catalog.count(DISTINCT e.host_id), 0)::int
    INTO v_anfitriones_distintos_interactuados
    FROM public.participantes p
    JOIN public.encuentros e ON e.id = p.encuentro_id
    WHERE p.user_id = v_target_id
      AND p.user_id <> e.host_id
      AND e.opened_at IS NOT NULL
      AND p.estado IN ('confirmado', 'asistio')
      AND p.admission_source IS DISTINCT FROM 'private_general_link';

    -- =========================================================================
    -- C. CONTEXTO FACTUAL, TAMAÑO DE MUESTRA Y NEUTRALIDAD
    -- =========================================================================
    -- Total de experiencias únicas abiertas (como anfitrión o como participante)
    SELECT
        COALESCE(pg_catalog.count(DISTINCT exp.encuentro_id), 0)::int,
        pg_catalog.min(exp.created_at),
        pg_catalog.max(exp.event_date)
    INTO
        v_total_experiencias_unicas,
        v_antiguedad_primer_encuentro,
        v_recencia_ultimo_encuentro
    FROM (
        -- Como Anfitrión abierto
        SELECT e.id AS encuentro_id, e.opened_at AS created_at, ((e.fecha::text || ' ' || e.hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') AS event_date
        FROM public.encuentros e
        WHERE e.host_id = v_target_id
          AND e.opened_at IS NOT NULL

        UNION

        -- Como Participante abierto
        SELECT p.encuentro_id, p.creado_en AS created_at, ((e.fecha::text || ' ' || e.hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') AS event_date
        FROM public.participantes p
        JOIN public.encuentros e ON e.id = p.encuentro_id
        WHERE p.user_id = v_target_id
          AND p.user_id <> e.host_id
          AND e.opened_at IS NOT NULL
          AND p.estado IN ('confirmado', 'asistio')
          AND p.admission_source IS DISTINCT FROM 'private_general_link'
          AND (
              p.creado_en >= e.opened_at
              OR p.admission_source = 'post_open_generic'
              OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto s WHERE s.participante_id = p.id)
          )
    ) exp;

    -- Estructura de respuesta rica y neutral
    RETURN pg_catalog.json_build_object(
        'ok', true,
        'user_id', v_target_id,
        'consultado_en', v_now,

        -- 1. Contexto y tamaño de muestra
        'contexto_factual', pg_catalog.json_build_object(
            'total_experiencias_unicas', v_total_experiencias_unicas,
            'anfitriones_distintos_interactuados', v_anfitriones_distintos_interactuados,
            'antiguedad_primer_encuentro', v_antiguedad_primer_encuentro,
            'recencia_ultimo_encuentro', v_recencia_ultimo_encuentro,
            'muestra_suficiente', (v_total_experiencias_unicas >= 3),
            'estado_muestra', CASE
                WHEN v_total_experiencias_unicas = 0 THEN 'sin_antecedentes'
                WHEN v_total_experiencias_unicas < 3 THEN 'preliminar'
                ELSE 'establecida'
            END,
            'tratamiento_neutral', true,
            'scoring_publico_habilitado', false
        ),

        -- 2. Trayectoria como Anfitrión
        'trayectoria_anfitrion', pg_catalog.json_build_object(
            'datos_objetivos', pg_catalog.json_build_object(
                'encuentros_abiertos_organizados', v_host_encuentros_organizados,
                'encuentros_abiertos_cancelados', v_host_encuentros_cancelados,
                'participantes_recibidos_total', v_host_participantes_recibidos_total,
                'cierres_a_tiempo', v_host_cierres_a_tiempo,
                'cierres_tardios', v_host_cierres_tardios,
                'cierres_auto_regularizados', v_host_cierres_auto_regularizados,
                'cierres_pendientes', v_host_cierres_pendientes
            ),
            'declaraciones_host', pg_catalog.json_build_object(
                'encuentros_declarados_realizados', v_host_encuentros_completados_declarados,
                'encuentros_declarados_no_realizados', v_host_encuentros_no_realizados_declarados
            ),
            'observaciones_y_moderacion', pg_catalog.json_build_object(
                'reclamos_recibidos_pendientes', v_host_reclamos_pendientes,
                'ausencias_anfitrion_acreditadas', v_host_ausencias_acreditadas,
                'no_realizaciones_acreditadas', v_host_no_realizaciones_acreditadas,
                'errores_cierre_acreditados', v_host_errores_cierre_acreditados,
                'reclamos_desestimados_insuficientes', v_host_reclamos_desestimados,
                'reclamos_rectificados', v_host_reclamos_rectificados
            )
        ),

        -- 3. Trayectoria como Participante
        'trayectoria_participante', pg_catalog.json_build_object(
            'datos_objetivos', pg_catalog.json_build_object(
                'encuentros_abiertos_confirmados', v_part_encuentros_confirmados,
                'reconfirmaciones_completadas', v_part_reconfirmaciones_completadas,
                'retiros_voluntarios_registrados', v_part_retiros_voluntarios
            ),
            'declaraciones_anfitrion', pg_catalog.json_build_object(
                'asistencias_declaradas_host', v_part_asistencias_declaradas_host,
                'inasistencias_reportadas_host', v_part_inasistencias_reportadas_host,
                'asistencias_sin_verificar', v_part_asistencias_sin_verificar
            ),
            'hechos_corroborados', pg_catalog.json_build_object(
                'asistencias_corroboradas', v_part_asistencias_corroboradas,
                'inasistencias_reconocidas_expresamente', v_part_inasistencias_reconocidas,
                'inasistencias_confirmadas_moderacion', v_part_inasistencias_confirmadas_moderacion,
                'inasistencias_justificadas', v_part_inasistencias_justificadas,
                'inasistencias_no_verificadas_timeout', v_part_inasistencias_timeout_neutral
            )
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_trayectoria_encuentros_abiertos_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trayectoria_encuentros_abiertos_seguro(UUID) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 2. ACTUALIZAR get_historial_asistencia_factual_seguro (Aislamiento de Privados)
-- ------------------------------------------------------------------------------
-- Se mantiene 100% retrocompatible con la firma previa y sus campos planos,
-- agregando el aislamiento de encuentros privados y proyectando los nuevos
-- campos estructurados.

CREATE OR REPLACE FUNCTION public.get_historial_asistencia_factual_seguro(
    p_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_is_mod BOOLEAN := public.is_moderation_authorized();
    v_target_id UUID;
    v_trayectoria JSON;

    v_total_participados INT := 0;
    v_asistencias_declaradas_host INT := 0;
    v_asistencias_verificadas INT := 0;
    v_inasistencias_pendientes INT := 0;
    v_inasistencias_reconocidas INT := 0;
    v_inasistencias_moderadas INT := 0;
    v_registros_no_verificados INT := 0;
    v_reportes_rectificados INT := 0;
    v_controversias_host_recibidas INT := 0;
    v_controversias_host_iniciadas INT := 0;
    v_reclamos_no_realizacion INT := 0;
    v_reclamos_ausencia_host INT := 0;
    v_reclamos_error_cierre INT := 0;
BEGIN
    IF v_caller_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_user_id IS NOT NULL AND p_user_id <> v_caller_id THEN
        IF NOT v_is_mod THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
        END IF;
        v_target_id := p_user_id;
    ELSE
        v_target_id := v_caller_id;
    END IF;

    -- Conteo factual desde participantes AISLADO de encuentros privados
    SELECT
        COALESCE(pg_catalog.count(*), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_status = 'attended' AND (p.attendance_dispute_status IS NULL OR p.attendance_dispute_status IN ('none', 'pending_review')) THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_status = 'attended' AND p.attendance_dispute_status IN ('resolved_registration_error', 'rectified') THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_status = 'reported_absent' AND p.attendance_dispute_status = 'awaiting_response' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_dispute_status = 'confirmed_by_participant' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_dispute_status = 'resolved_unjustified' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_dispute_status IN ('unverified_timeout', 'dismissed_insufficient_evidence', 'dismissed') OR p.attendance_status = 'unverified' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN p.attendance_dispute_status IN ('dismissed', 'dismissed_insufficient_evidence', 'rectified', 'resolved_registration_error', 'resolved_justified') THEN 1 ELSE 0 END), 0)::int
    INTO
        v_total_participados,
        v_asistencias_declaradas_host,
        v_asistencias_verificadas,
        v_inasistencias_pendientes,
        v_inasistencias_reconocidas,
        v_inasistencias_moderadas,
        v_registros_no_verificados,
        v_reportes_rectificados
    FROM public.participantes p
    JOIN public.encuentros e ON e.id = p.encuentro_id
    WHERE p.user_id = v_target_id
      AND p.estado IN ('confirmado', 'asistio')
      AND e.opened_at IS NOT NULL
      AND p.admission_source IS DISTINCT FROM 'private_general_link'
      AND (
          p.creado_en >= e.opened_at
          OR p.admission_source = 'post_open_generic'
          OR EXISTS (
              SELECT 1 FROM public.solicitudes_encuentro_abierto s
              WHERE s.participante_id = p.id
          )
      );

    -- Conteo diferenciado de controversias del organizador (aislado a abiertos)
    SELECT
        COALESCE(pg_catalog.sum(CASE WHEN c.involucrado_id = v_target_id AND c.tipo_controversia IN ('encounter_not_realized', 'host_no_show', 'closure_data_error') THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN c.involucrado_id = v_target_id AND c.tipo_controversia = 'encounter_not_realized' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN c.involucrado_id = v_target_id AND c.tipo_controversia = 'host_no_show' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN c.involucrado_id = v_target_id AND c.tipo_controversia = 'closure_data_error' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN c.iniciado_por = v_target_id AND c.tipo_controversia IN ('encounter_not_realized', 'host_no_show', 'closure_data_error') THEN 1 ELSE 0 END), 0)::int
    INTO
        v_controversias_host_recibidas,
        v_reclamos_no_realizacion,
        v_reclamos_ausencia_host,
        v_reclamos_error_cierre,
        v_controversias_host_iniciadas
    FROM public.asistencia_controversias c
    JOIN public.encuentros e ON e.id = c.encuentro_id
    WHERE e.opened_at IS NOT NULL;

    -- Invocar la trayectoria rica para incluirla en el retorno
    v_trayectoria := public.get_trayectoria_encuentros_abiertos_seguro(v_target_id);

    -- Proyección estrictamente factual y neutral: sin puntuaciones ni badges públicos
    RETURN pg_catalog.json_build_object(
        'ok', true,
        'user_id', v_target_id,
        'total_encuentros_participados', v_total_participados,
        'asistencias_declaradas_host', v_asistencias_declaradas_host,
        'asistencias_declaradas', v_asistencias_declaradas_host,
        'asistencias_verificadas', v_asistencias_verificadas,
        'inasistencias_reportadas_pendientes', v_inasistencias_pendientes,
        'inasistencias_reconocidas', v_inasistencias_reconocidas,
        'inasistencias_moderadas', v_inasistencias_moderadas,
        'registros_no_verificados', v_registros_no_verificados,
        'reportes_rectificados_o_desestimados', v_reportes_rectificados,
        'controversias_organizador_recibidas', v_controversias_host_recibidas,
        'reclamos_no_realizacion_recibidos', v_reclamos_no_realizacion,
        'reclamos_ausencia_anfitrion_recibidos', v_reclamos_ausencia_host,
        'reclamos_error_cierre_recibidos', v_reclamos_error_cierre,
        'controversias_organizador_iniciadas', v_controversias_host_iniciadas,

        -- Subestructuras de trayectoria Sprint D
        'contexto_factual', v_trayectoria -> 'contexto_factual',
        'trayectoria_anfitrion', v_trayectoria -> 'trayectoria_anfitrion',
        'trayectoria_participante', v_trayectoria -> 'trayectoria_participante'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_historial_asistencia_factual_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_historial_asistencia_factual_seguro(UUID) TO authenticated, postgres, service_role;

COMMIT;
