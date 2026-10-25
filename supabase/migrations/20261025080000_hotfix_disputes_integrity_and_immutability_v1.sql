-- ==============================================================================
-- Migración: 20261025080000_hotfix_disputes_integrity_and_immutability_v1.sql
-- Fase V1 Mini-Sprint C — Hotfix de Integridad, Inmutabilidad y Elegibilidad
--
-- Objetivos:
-- 1. P0: No modificar la asistencia del denunciante en controversias contra el anfitrión.
--    - En 'encounter_not_realized', 'host_no_show' y 'closure_data_error', la resolución
--      nunca debe registrar como ausente (reported_absent) al participante denunciante.
--    - Se registran como hechos específicos del encuentro y del organizador.
-- 2. P0: Inmutabilidad estricta de resoluciones definitivas.
--    - Reintento idéntico: respuesta idempotente exitosa.
--    - Intento de resolución diferente sobre caso ya resuelto: rechazo explícito con
--      'dispute_already_resolved'.
-- 3. P1: Integridad de aclaraciones y descargos.
--    - Impedir aclaraciones o modificaciones una vez resuelta la controversia.
--    - Evitar sobrescrituras silenciosas de declaraciones previas, preservando
--      el historial de aclaraciones en el texto y en la auditoría.
--    - Restricción estricta de quién puede aportar aclaraciones según el tipo de caso.
-- 4. P1: Elegibilidad temporal y funcional en controversias sobre el anfitrión.
--    - Comprobar que el encuentro corresponda al ámbito de Encuentros Abiertos.
--    - Comprobar que el encuentro haya iniciado antes de admitir reclamos de no realización.
--    - Ventana temporal estructurada: plazo ordinario (14 días post-inicio) y plazo
--      extemporáneo con fundamento justificado (hasta 60 días).
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. ACTUALIZAR iniciar_controversia_realizacion_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.iniciar_controversia_realizacion_seguro(
    p_encuentro_id UUID,
    p_tipo_controversia TEXT,
    p_motivo TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_part_row public.participantes%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_event_start TIMESTAMPTZ;
    v_clean_motivo TEXT;
    v_dispute_id UUID;
    v_is_late BOOLEAN := false;
BEGIN
    -- 1. Autenticación e identidad
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_tipo_controversia IS NULL OR p_tipo_controversia NOT IN ('encounter_not_realized', 'host_no_show', 'closure_data_error') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_controversy_type');
    END IF;

    v_clean_motivo := NULLIF(pg_catalog.btrim(p_motivo), '');
    IF v_clean_motivo IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'reason_required');
    END IF;

    IF pg_catalog.length(v_clean_motivo) > 1000 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'reason_too_long');
    END IF;

    -- 2. Validar existencia del encuentro
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    -- 3. Elegibilidad funcional: ámbito exclusivo de Encuentros Abiertos
    IF v_encuentro.opened_at IS NULL AND COALESCE(v_encuentro.is_open, false) = false THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'only_open_encounters_supported',
            'message', 'Las controversias sobre realización aplican exclusivamente a encuentros abiertos.'
        );
    END IF;

    -- 4. Elegibilidad temporal: el encuentro debe haber iniciado para denunciar no realización o ausencia del host
    v_event_start := ((v_encuentro.fecha::text || ' ' || v_encuentro.hora::text)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires';
    IF v_now < v_event_start THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'event_not_started_yet',
            'message', 'No es posible iniciar un reclamo sobre realización antes del horario de inicio del encuentro.'
        );
    END IF;

    -- Ventana temporal: 14 días ordinarios, hasta 60 días justificado, después expirado
    IF v_now > (v_event_start + INTERVAL '60 days') THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'claim_window_expired',
            'message', 'El plazo para presentar observaciones sobre este encuentro ha vencido.'
        );
    ELSIF v_now > (v_event_start + INTERVAL '14 days') THEN
        v_is_late := true;
        IF pg_catalog.length(v_clean_motivo) < 20 THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'late_claim_insufficient_justification',
                'message', 'Para reclamos presentados luego de los 14 días del encuentro, se requiere un fundamento detallado (mínimo 20 caracteres).'
            );
        END IF;
    END IF;

    -- 5. El anfitrión no puede denunciarse a sí mismo
    IF v_encuentro.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_dispute_own_encounter');
    END IF;

    -- 6. Validar relación real: solo participantes confirmados o asistentes pueden iniciar controversia
    SELECT * INTO v_part_row
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id
      AND user_id = v_user_id
      AND estado IN ('confirmado', 'asistio')
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'only_confirmed_participants_allowed');
    END IF;

    -- 7. Comprobar si ya existe una controversia de este tipo iniciada por el mismo usuario
    IF EXISTS (
        SELECT 1 FROM public.asistencia_controversias
        WHERE encuentro_id = p_encuentro_id
          AND iniciado_por = v_user_id
          AND tipo_controversia = p_tipo_controversia
          AND estado NOT IN ('dismissed_insufficient_evidence', 'rectified')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'dispute_already_active');
    END IF;

    -- 8. Crear la controversia en cola de revisión humana
    INSERT INTO public.asistencia_controversias (
        encuentro_id,
        participante_id,
        tipo_controversia,
        iniciado_por,
        involucrado_id,
        estado,
        descargo_tipo,
        descargo_texto,
        descargo_en,
        plazo_respuesta_vence_en,
        metadata,
        created_at,
        updated_at
    ) VALUES (
        p_encuentro_id,
        v_part_row.id,
        p_tipo_controversia,
        v_user_id,
        v_encuentro.host_id,
        'in_human_review',
        p_tipo_controversia,
        v_clean_motivo,
        v_now,
        v_now + INTERVAL '7 days',
        pg_catalog.jsonb_build_object(
            'participant_name', v_part_row.nombre_invitado,
            'encounter_title', v_encuentro.open_public_title,
            'is_late_claim', v_is_late
        ),
        v_now,
        v_now
    ) RETURNING id INTO v_dispute_id;

    -- 9. Auditoría durable
    INSERT INTO public.asistencia_controversia_auditoria (
        controversia_id,
        accion,
        actor_id,
        estado_anterior,
        estado_nuevo,
        notas,
        detalles
    ) VALUES (
        v_dispute_id,
        'created',
        v_user_id,
        NULL,
        'in_human_review',
        'Participante inició controversia sobre realización/organizador',
        pg_catalog.jsonb_build_object('type', p_tipo_controversia, 'is_late_claim', v_is_late)
    );

    -- 10. Notificar al anfitrión en Inbox
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
        v_encuentro.host_id,
        'encounter_realization_dispute',
        'attendance_dispute',
        v_dispute_id,
        '/meet/' || p_encuentro_id || '#controversia=' || v_dispute_id,
        'Observación sobre realización de encuentro',
        'Un participante presentó una consulta sobre la realización de "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '". Podés presentar tu aclaración.',
        pg_catalog.jsonb_build_object('dispute_id', v_dispute_id, 'encuentro_id', p_encuentro_id),
        'realization_dispute:' || p_encuentro_id || ':' || v_user_id,
        v_now + INTERVAL '30 days'
    ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'dispute_id', v_dispute_id,
        'status', 'in_human_review'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.iniciar_controversia_realizacion_seguro(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.iniciar_controversia_realizacion_seguro(UUID, TEXT, TEXT) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 2. ACTUALIZAR aportar_aclaracion_controversia_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.aportar_aclaracion_controversia_seguro(
    p_dispute_id UUID,
    p_aclaracion_texto TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_dispute public.asistencia_controversias%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_clean TEXT;
    v_previous_clarif TEXT;
    v_updated_clarif TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_clean := NULLIF(pg_catalog.btrim(p_aclaracion_texto), '');
    IF v_clean IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'clarification_required');
    END IF;

    IF pg_catalog.length(v_clean) > 1000 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'clarification_too_long');
    END IF;

    -- Bloqueo FOR UPDATE
    SELECT * INTO v_dispute
    FROM public.asistencia_controversias
    WHERE id = p_dispute_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'dispute_not_found');
    END IF;

    -- INVARIANTE: Caso ya resuelto no permite modificaciones de partes
    IF v_dispute.estado IN ('resolved_justified', 'resolved_unjustified', 'resolved_registration_error', 'dismissed_insufficient_evidence', 'rectified', 'confirmed_by_participant') THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'dispute_already_resolved',
            'message', 'No es posible aportar aclaraciones sobre una controversia que ya cuenta con resolución definitiva.'
        );
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_dispute.encuentro_id;

    -- Restricción de legitimación según rol y tipo de controversia
    IF v_dispute.iniciado_por <> v_user_id AND v_dispute.involucrado_id <> v_user_id AND v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    -- Acumulación de aclaraciones sin sobrescritura destructiva
    v_previous_clarif := v_dispute.explicacion_contraparte;
    IF v_previous_clarif IS NULL THEN
        v_updated_clarif := v_clean;
    ELSE
        v_updated_clarif := v_previous_clarif || E'\n---\n[' || pg_catalog.to_char(v_now, 'YYYY-MM-DD HH24:MI:SS') || ']: ' || v_clean;
    END IF;

    IF pg_catalog.length(v_updated_clarif) > 4000 THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'clarification_history_full',
            'message', 'Se ha alcanzado el límite de texto para aclaraciones acumuladas en este caso.'
        );
    END IF;

    -- Actualizar controversia
    UPDATE public.asistencia_controversias
    SET explicacion_contraparte = v_updated_clarif,
        explicacion_contraparte_en = v_now,
        updated_at = v_now
    WHERE id = p_dispute_id;

    -- Auditoría con preservación histórica del texto previo y nuevo
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
        'counterparty_clarification',
        v_user_id,
        v_dispute.estado,
        v_dispute.estado,
        'Aclaración aportada: ' || pg_catalog.substr(v_clean, 1, 100),
        pg_catalog.jsonb_build_object(
            'actor_is_host', (v_user_id = v_encuentro.host_id),
            'is_additional', (v_previous_clarif IS NOT NULL),
            'new_entry', v_clean,
            'previous_text', v_previous_clarif,
            'submitted_at', v_now
        )
    );

    RETURN pg_catalog.json_build_object('ok', true, 'dispute_id', p_dispute_id);
END;
$$;

REVOKE ALL ON FUNCTION public.aportar_aclaracion_controversia_seguro(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aportar_aclaracion_controversia_seguro(UUID, TEXT) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 3. ACTUALIZAR resolver_controversia_moderacion_seguro
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
    -- Si el caso ya fue resuelto con la misma resolución: idempotencia exitosa
    -- Si el caso ya fue resuelto y se intenta aplicar una resolución diferente: rechazo estricto
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

    -- DISCRIMINACIÓN P0 POR TIPO DE CONTROVERSIA:
    -- Rama A: Inasistencia individual ('absence_reported')
    IF v_dispute.tipo_controversia = 'absence_reported' THEN

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

        -- Actualizar registro del participante involucrado
        IF v_dispute.participante_id IS NOT NULL THEN
            UPDATE public.participantes
            SET attendance_status = v_new_att_status,
                attendance_dispute_status = v_new_state,
                estado = CASE WHEN v_new_att_status = 'attended' THEN 'asistio' ELSE estado END
            WHERE id = v_dispute.participante_id;
        END IF;

    ELSE
        -- Rama B: Controversias sobre realización o anfitrión ('encounter_not_realized', 'host_no_show', 'closure_data_error')
        -- REGLA FUNDAMENTAL P0: La asistencia del participante denunciante NUNCA debe alterarse hacia una falta o reported_absent.
        -- Los hechos se registran como hechos del encuentro y del organizador.
        IF p_resolucion IN ('confirmed', 'justified') THEN
            v_new_state := 'resolved_justified';
            v_notif_title := 'Observación sobre el encuentro: Justificada';
            v_notif_body := 'La moderación dio por acreditada la observación sobre el encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '".';

            -- Hecho del encuentro: si se acreditó que no se realizó o que el host no asistió, actualizar el encuentro
            IF v_dispute.tipo_controversia IN ('encounter_not_realized', 'host_no_show') THEN
                UPDATE public.encuentros
                SET post_event_realization_status = 'not_realized',
                    post_event_unrealized_reason = COALESCE(post_event_unrealized_reason, 'No realización o ausencia de anfitrión acreditada por moderación: ' || v_clean_fund),
                    updated_at = v_now
                WHERE id = v_dispute.encuentro_id;
            END IF;

            -- Si el denunciante tenía indebidamente un estado reported_absent previo, neutralizarlo
            IF v_dispute.participante_id IS NOT NULL THEN
                UPDATE public.participantes
                SET attendance_status = CASE
                        WHEN attendance_status = 'reported_absent' THEN 'unmarked'
                        ELSE attendance_status
                    END,
                    attendance_dispute_status = 'resolved_justified'
                WHERE id = v_dispute.participante_id;
            END IF;

        ELSIF p_resolucion = 'registration_error' THEN
            v_new_state := 'resolved_registration_error';
            v_notif_title := 'Observación sobre el encuentro: Error de registro rectificado';
            v_notif_body := 'Se rectificaron los datos informados del encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '".';

            -- Si la queja denunciaba error de registro en la asistencia del participante, rectificar a attended
            IF v_dispute.participante_id IS NOT NULL THEN
                UPDATE public.participantes
                SET attendance_status = 'attended',
                    attendance_dispute_status = 'resolved_registration_error',
                    estado = 'asistio'
                WHERE id = v_dispute.participante_id;
            END IF;

        ELSIF p_resolucion = 'insufficient_evidence' THEN
            v_new_state := 'dismissed_insufficient_evidence';
            v_notif_title := 'Observación sobre el encuentro: Evidencia insuficiente';
            v_notif_body := 'La observación sobre el encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" concluyó por evidencia insuficiente sin atribuir falta.';

            -- La asistencia del denunciante permanece intacta sin penalización
            IF v_dispute.participante_id IS NOT NULL THEN
                UPDATE public.participantes
                SET attendance_dispute_status = 'dismissed_insufficient_evidence'
                WHERE id = v_dispute.participante_id;
            END IF;

        ELSE
            -- rectified
            v_new_state := 'rectified';
            v_notif_title := 'Observación sobre el encuentro: Rectificación administrativa';
            v_notif_body := 'El reclamo sobre el encuentro "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" concluyó con rectificación administrativa.';

            IF v_dispute.participante_id IS NOT NULL THEN
                UPDATE public.participantes
                SET attendance_dispute_status = 'rectified'
                WHERE id = v_dispute.participante_id;
            END IF;
        END IF;

    END IF;

    -- Actualizar controversia
    UPDATE public.asistencia_controversias
    SET estado = v_new_state,
        resolucion_tipo = p_resolucion,
        resolucion_fundamentacion = v_clean_fund,
        resuelto_por = v_user_id,
        resuelto_en = v_now,
        updated_at = v_now
    WHERE id = p_dispute_id;

    -- Auditoría durable con detalle del contexto y tipo de controversia
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
            'encuentro_id', v_dispute.encuentro_id
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

    -- Notificar al anfitrión
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
        'resolution', p_resolucion
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_controversia_moderacion_seguro(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolver_controversia_moderacion_seguro(UUID, TEXT, TEXT) TO authenticated, postgres, service_role;

COMMIT;
