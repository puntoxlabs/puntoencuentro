-- ==============================================================================
-- Migración: 20261025083000_differentiate_host_claims_and_preserve_closure_v1.sql
-- Fase V1 Mini-Sprint C — Ajuste Final: Diferenciación de Reclamos contra Host
--                           y Preservación del Cierre Histórico del Sprint A
--
-- Objetivos:
-- 1. Diferenciar estrictamente las tres controversias contra el organizador:
--    - 'encounter_not_realized': El encuentro no ocurrió.
--    - 'host_no_show': El anfitrión no asistió, aunque el encuentro pudo realizarse.
--    - 'closure_data_error': Existe un error documentado en el cierre.
-- 2. Preservar intacto el cierre histórico del Sprint A:
--    - NO modificar directamente los campos de cierre en public.encuentros:
--      post_event_realization_status, post_event_closed_at, post_event_closure_status,
--      post_event_closure_type, post_event_closed_responsibly, ni su auditoría.
--    - Registrar la resolución humana como un hecho posterior, separado y auditable.
-- 3. NO alterar la asistencia del participante denunciante:
--    - No mutar participantes.attendance_status ni participantes.estado.
--    - Confirmar una falta o ausencia del anfitrión no prejuzga si el denunciante asistió o faltó.
--    - Los reclamos de asistencia individual deben tramitarse por su circuito propio ('absence_reported').
-- 4. Proyección factual detallada en get_historial_asistencia_factual_seguro:
--    - Diferenciar los tres tipos de controversias contra el anfitrión de forma granular y neutral.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. ACTUALIZAR resolver_controversia_moderacion_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolver_controversia_moderacion_seguro(
    p_dispute_id UUID,
    p_resolucion TEXT,
    p_fundamentacion TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_mod BOOLEAN := public.is_moderation_authorized();
    v_dispute public.asistencia_controversias%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_clean_fund TEXT;
    v_new_state TEXT;
    v_new_att_status TEXT;
    v_notif_title TEXT;
    v_notif_body TEXT;
    v_participant_user_id UUID;
    v_host_user_id UUID;
    v_confirmed_fact TEXT := NULL;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF NOT v_is_mod THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF p_resolucion IS NULL OR p_resolucion NOT IN (
        'justified',
        'confirmed',
        'registration_error',
        'insufficient_evidence',
        'rectified'
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_resolution_type');
    END IF;

    v_clean_fund := NULLIF(pg_catalog.btrim(p_fundamentacion), '');
    IF v_clean_fund IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'fundamentacion_required');
    END IF;

    IF pg_catalog.length(v_clean_fund) > 1000 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'fundamentacion_too_long');
    END IF;

    -- Bloqueo exclusivo de la controversia
    SELECT * INTO v_dispute
    FROM public.asistencia_controversias
    WHERE id = p_dispute_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'dispute_not_found');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_dispute.encuentro_id;

    -- INVARIANTE: Protección estricta contra conflicto de interés
    IF v_user_id = v_dispute.iniciado_por OR v_user_id = v_dispute.involucrado_id OR v_user_id = v_encuentro.host_id THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'conflict_of_interest',
            'message', 'No podés moderar ni resolver una controversia en la que sos parte o anfitrión.'
        );
    END IF;

    -- INVARIANTE P0: Inmutabilidad de decisiones definitivas
    IF v_dispute.estado IN ('resolved_justified', 'resolved_unjustified', 'resolved_registration_error', 'dismissed_insufficient_evidence', 'rectified', 'confirmed_by_participant') THEN
        IF v_dispute.resolucion_tipo = p_resolucion THEN
            RETURN pg_catalog.json_build_object(
                'ok', true,
                'idempotent', true,
                'dispute_id', p_dispute_id,
                'status', v_dispute.estado,
                'resolution', v_dispute.resolucion_tipo
            );
        ELSE
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'dispute_already_resolved',
                'message', 'La controversia ya cuenta con una resolución definitiva registrada y no puede ser sobrescrita directamente.'
            );
        END IF;
    END IF;

    -- DISCRIMINACIÓN POR TIPO DE CONTROVERSIA:
    IF v_dispute.tipo_controversia = 'absence_reported' THEN
        -- =====================================================================
        -- Rama A: Inasistencia individual del participante
        -- =====================================================================
        IF p_resolucion = 'justified' THEN
            v_new_state := 'resolved_justified';
            v_new_att_status := 'advance_notice_absent';
            v_notif_title := 'Revisión de inasistencia: Justificada';
            v_notif_body := 'La revisión sobre "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" concluyó como inasistencia justificada.';
        ELSIF p_resolucion = 'confirmed' THEN
            v_new_state := 'resolved_unjustified';
            v_new_att_status := 'reported_absent';
            v_notif_title := 'Revisión de inasistencia: Confirmada';
            v_notif_body := 'La revisión sobre "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" concluyó confirmando la inasistencia reportada.';
        ELSIF p_resolucion = 'registration_error' THEN
            v_new_state := 'resolved_registration_error';
            v_new_att_status := 'attended';
            v_notif_title := 'Revisión de inasistencia: Error de registro corregido';
            v_notif_body := 'Se rectificó tu asistencia efectiva en "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '".';
        ELSIF p_resolucion = 'insufficient_evidence' THEN
            v_new_state := 'dismissed_insufficient_evidence';
            v_new_att_status := 'unverified';
            v_notif_title := 'Revisión de asistencia: Evidencia insuficiente';
            v_notif_body := 'El caso sobre "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" fue desestimado por evidencia insuficiente sin atribuir falta.';
        ELSE
            -- rectified
            v_new_state := 'rectified';
            v_new_att_status := 'unverified';
            v_notif_title := 'Revisión de asistencia: Rectificación administrativa';
            v_notif_body := 'El reporte sobre "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" fue rectificado administrativamente.';
        END IF;

        -- Actualizar registro del participante reportado
        IF v_dispute.participante_id IS NOT NULL THEN
            UPDATE public.participantes
            SET attendance_status = v_new_att_status,
                attendance_dispute_status = v_new_state,
                estado = CASE WHEN v_new_att_status = 'attended' THEN 'asistio' ELSE estado END
            WHERE id = v_dispute.participante_id;
        END IF;

    ELSE
        -- =====================================================================
        -- Rama B: Controversias sobre el organizador o el encuentro
        --         ('encounter_not_realized', 'host_no_show', 'closure_data_error')
        --
        -- REGLAS INVARIANTES:
        -- 1. PRESERVAR EL CIERRE HISTÓRICO DE SPRINT A:
        --    NO mutar public.encuentros (post_event_realization_status, post_event_closure_status, etc.).
        --    La declaración original del host permanece inalterada como registro histórico.
        -- 2. NO MUTAR LA ASISTENCIA DEL DENUNCIANTE:
        --    NO alterar participantes.attendance_status ni participantes.estado.
        --    Confirmar o desestimar una queja contra el host no demuestra si el denunciante asistió o faltó.
        --    Cualquier error de asistencia individual debe resolverse por su propio circuito.
        -- 3. DIFERENCIAR LOS TRES HECHOS CONCRETOS:
        -- =====================================================================
        IF p_resolucion IN ('confirmed', 'justified') THEN
            v_new_state := 'resolved_justified';

            IF v_dispute.tipo_controversia = 'host_no_show' THEN
                v_confirmed_fact := 'host_absence_confirmed';
                v_notif_title := 'Observación de encuentro: Ausencia de anfitrión acreditada';
                v_notif_body := 'La moderación dio por acreditada la ausencia del anfitrión en el encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '".';
            ELSIF v_dispute.tipo_controversia = 'encounter_not_realized' THEN
                v_confirmed_fact := 'encounter_not_realized_confirmed';
                v_notif_title := 'Observación de encuentro: No realización acreditada';
                v_notif_body := 'La moderación dio por acreditada la no realización del encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '".';
            ELSE
                -- closure_data_error
                v_confirmed_fact := 'closure_data_error_confirmed';
                v_notif_title := 'Observación de encuentro: Error en cierre acreditado';
                v_notif_body := 'La moderación dio por acreditado el error en los datos de cierre del encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '".';
            END IF;

        ELSIF p_resolucion = 'registration_error' THEN
            v_new_state := 'resolved_registration_error';
            v_confirmed_fact := 'closure_data_error_rectified';
            v_notif_title := 'Observación de encuentro: Error rectificado';
            v_notif_body := 'Se rectificó la observación sobre datos de registro del encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '".';

        ELSIF p_resolucion = 'insufficient_evidence' THEN
            v_new_state := 'dismissed_insufficient_evidence';
            v_confirmed_fact := 'claim_dismissed_insufficient_evidence';
            v_notif_title := 'Observación de encuentro: Evidencia insuficiente';
            v_notif_body := 'La observación sobre el encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" concluyó por evidencia insuficiente sin atribuir falta.';

        ELSE
            -- rectified
            v_new_state := 'rectified';
            v_confirmed_fact := 'administrative_rectification';
            v_notif_title := 'Observación de encuentro: Rectificación administrativa';
            v_notif_body := 'El caso sobre el encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" fue resuelto administrativamente.';
        END IF;

        -- Actualizar metadatos de la controversia con el hecho concreto acreditado
        -- SIN tocar public.encuentros ni public.participantes
        v_dispute.metadata := COALESCE(v_dispute.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
            'confirmed_fact', v_confirmed_fact,
            'historical_closure_preserved', true,
            'complainant_attendance_preserved', true
        );

    END IF;

    -- Actualizar controversia
    UPDATE public.asistencia_controversias
    SET estado = v_new_state,
        resolucion_tipo = p_resolucion,
        resolucion_fundamentacion = v_clean_fund,
        resuelto_por = v_user_id,
        resuelto_en = v_now,
        metadata = COALESCE(v_dispute.metadata, metadata),
        updated_at = v_now
    WHERE id = p_dispute_id;

    -- Auditoría durable con detalle del contexto y hecho confirmado
    INSERT INTO public.asistencia_controversia_auditoria (
        controversia_id,
        accion,
        actor_id,
        estado_anterior,
        estado_nuevo,
        notas,
        detalles
    ) VALUES (
        p_dispute_id,
        'resolved_by_moderator',
        v_user_id,
        v_dispute.estado,
        v_new_state,
        v_clean_fund,
        pg_catalog.jsonb_build_object(
            'resolution', p_resolucion,
            'tipo_controversia', v_dispute.tipo_controversia,
            'encuentro_id', v_dispute.encuentro_id,
            'confirmed_fact', v_confirmed_fact,
            'historical_closure_preserved', true
        )
    );

    v_participant_user_id := CASE WHEN v_dispute.tipo_controversia = 'absence_reported' THEN v_dispute.involucrado_id ELSE v_dispute.iniciado_por END;
    v_host_user_id := CASE WHEN v_dispute.tipo_controversia = 'absence_reported' THEN v_dispute.iniciado_por ELSE v_dispute.involucrado_id END;

    -- Notificar al participante
    INSERT INTO public.inbox_notifications (
        recipient_user_id,
        notification_type,
        target_type,
        target_id,
        deep_link,
        title,
        body,
        payload,
        dedup_key,
        expires_at
    ) VALUES (
        v_participant_user_id,
        'attendance_dispute_resolved',
        'attendance_dispute',
        p_dispute_id,
        '/solicitudes?dispute_id=' || p_dispute_id,
        v_notif_title,
        v_notif_body,
        pg_catalog.jsonb_build_object('dispute_id', p_dispute_id, 'resolution', p_resolucion),
        'dispute_res:' || p_dispute_id || ':' || v_participant_user_id || ':' || v_now::text,
        v_now + INTERVAL '30 days'
    ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;

    -- Notificar al organizador
    INSERT INTO public.inbox_notifications (
        recipient_user_id,
        notification_type,
        target_type,
        target_id,
        deep_link,
        title,
        body,
        payload,
        dedup_key,
        expires_at
    ) VALUES (
        v_host_user_id,
        'attendance_dispute_resolved',
        'attendance_dispute',
        p_dispute_id,
        '/meet/' || v_dispute.encuentro_id || '#controversia=' || p_dispute_id,
        'Resolución de controversia de asistencia',
        'La moderación concluyó la revisión del caso en "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '".',
        pg_catalog.jsonb_build_object('dispute_id', p_dispute_id, 'resolution', p_resolucion),
        'dispute_res:' || p_dispute_id || ':' || v_host_user_id || ':' || v_now::text,
        v_now + INTERVAL '30 days'
    ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'dispute_id', p_dispute_id,
        'status', v_new_state,
        'resolution', p_resolucion,
        'confirmed_fact', v_confirmed_fact
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_controversia_moderacion_seguro(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolver_controversia_moderacion_seguro(UUID, TEXT, TEXT) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 2. ACTUALIZAR get_historial_asistencia_factual_seguro
-- ------------------------------------------------------------------------------

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
    v_is_mod BOOLEAN := public.is_moderation_authorized();
    v_target_id UUID;
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

    IF p_user_id IS NOT NULL AND p_user_id <> v_caller_id THEN
        IF NOT v_is_mod THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
        END IF;
        v_target_id := p_user_id;
    ELSE
        v_target_id := v_caller_id;
    END IF;

    -- Conteo factual desde participantes
    SELECT
        COALESCE(pg_catalog.count(*), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN attendance_status = 'attended' AND (attendance_dispute_status IS NULL OR attendance_dispute_status IN ('none', 'pending_review')) THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN attendance_status = 'attended' AND attendance_dispute_status IN ('resolved_registration_error', 'rectified') THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN attendance_status = 'reported_absent' AND attendance_dispute_status = 'awaiting_response' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN attendance_dispute_status = 'confirmed_by_participant' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN attendance_dispute_status = 'resolved_unjustified' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN attendance_dispute_status IN ('unverified_timeout', 'dismissed_insufficient_evidence', 'dismissed') OR attendance_status = 'unverified' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN attendance_dispute_status IN ('dismissed', 'dismissed_insufficient_evidence', 'rectified', 'resolved_registration_error', 'resolved_justified') THEN 1 ELSE 0 END), 0)::int
    INTO
        v_total_participados,
        v_asistencias_declaradas_host,
        v_asistencias_verificadas,
        v_inasistencias_pendientes,
        v_inasistencias_reconocidas,
        v_inasistencias_moderadas,
        v_registros_no_verificados,
        v_reportes_rectificados
    FROM public.participantes
    WHERE user_id = v_target_id
      AND estado IN ('confirmado', 'asistio');

    -- Conteo diferenciado de controversias del organizador
    SELECT
        COALESCE(pg_catalog.sum(CASE WHEN involucrado_id = v_target_id AND tipo_controversia IN ('encounter_not_realized', 'host_no_show', 'closure_data_error') THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN involucrado_id = v_target_id AND tipo_controversia = 'encounter_not_realized' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN involucrado_id = v_target_id AND tipo_controversia = 'host_no_show' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN involucrado_id = v_target_id AND tipo_controversia = 'closure_data_error' THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN iniciado_por = v_target_id AND tipo_controversia IN ('encounter_not_realized', 'host_no_show', 'closure_data_error') THEN 1 ELSE 0 END), 0)::int
    INTO
        v_controversias_host_recibidas,
        v_reclamos_no_realizacion,
        v_reclamos_ausencia_host,
        v_reclamos_error_cierre,
        v_controversias_host_iniciadas
    FROM public.asistencia_controversias;

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
        'controversias_organizador_iniciadas', v_controversias_host_iniciadas
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_historial_asistencia_factual_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_historial_asistencia_factual_seguro(UUID) TO authenticated, postgres, service_role;

COMMIT;
