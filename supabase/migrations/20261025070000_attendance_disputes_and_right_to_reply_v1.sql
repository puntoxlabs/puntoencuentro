-- ==============================================================================
-- Migración: 20261025070000_attendance_disputes_and_right_to_reply_v1.sql
-- Fase V1 Mini-Sprint C — Controversias, Derecho a Respuesta y Moderación de Asistencia
--
-- Objetivos:
-- 1. Máquina de estados completa para controversias de asistencia y realización:
--    - 'awaiting_response': Notificación registrada, esperando respuesta del participante.
--    - 'response_received' / 'in_human_review': Descargo recibido / en revisión humana.
--    - 'confirmed_by_participant': Aceptación expresa de inasistencia por el participante.
--    - 'resolved_justified': Moderación resuelve inasistencia justificada (aviso / fuerza mayor).
--    - 'resolved_unjustified': Moderación confirma inasistencia sin justificación válida.
--    - 'resolved_registration_error': Moderación rectifica asistencia efectiva por error del host.
--    - 'dismissed_insufficient_evidence': Evidencia insuficiente / salida neutral sin culpa.
--    - 'rectified': Rectificación formal administrativa.
--    - 'unverified_timeout': 7 días corridos sin respuesta -> Permanece 'unverified' (regla fundamental de no presunción).
-- 2. Notificación garantizada al participante mediante Inbox (y Web Push autorizado neutral).
-- 3. Derecho a respuesta del participante (aceptar, avisó antes, fuerza mayor, sí asistió, pedir moderación).
-- 4. Reclamos contextuales sobre el organizador (encuentro no realizado, host no se presentó, error de datos).
-- 5. Moderación humana independiente con prevención de conflicto de interés.
-- 6. Proyección factual de historial (sin rankings ni scores negativos).
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. ACTUALIZAR CONSTRAINT DE ESTADOS EN public.participantes
-- ------------------------------------------------------------------------------

DO $$
BEGIN
    -- 1. Primero remover el CHECK restrictivo anterior del Sprint A para permitir la migración segura
    ALTER TABLE public.participantes
        DROP CONSTRAINT IF EXISTS check_participantes_attendance_dispute_status;

    -- 2. Migrar datos preexistentes de Sprint A de forma segura sin pérdida de registros
    UPDATE public.participantes
    SET attendance_dispute_status = 'in_human_review'
    WHERE attendance_dispute_status = 'pending_review';

    -- 3. Crear el nuevo CHECK unificado con todos los estados del Sprint C y compatibilidad
    ALTER TABLE public.participantes
        ADD CONSTRAINT check_participantes_attendance_dispute_status
        CHECK (
            attendance_dispute_status IS NULL
            OR attendance_dispute_status IN (
                'none',
                'pending_review',
                'awaiting_response',
                'response_received',
                'in_human_review',
                'confirmed_by_participant',
                'resolved_justified',
                'resolved_unjustified',
                'resolved_registration_error',
                'dismissed_insufficient_evidence',
                'rectified',
                'unverified_timeout',
                'dismissed'
            )
        );
END $$;


-- ------------------------------------------------------------------------------
-- 2. TABLA PRINCIPAL: public.asistencia_controversias
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.asistencia_controversias (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    participante_id UUID REFERENCES public.participantes(id) ON DELETE CASCADE,
    tipo_controversia TEXT NOT NULL CHECK (
        tipo_controversia IN (
            'absence_reported',        -- Host reportó inasistencia
            'encounter_not_realized',  -- Participante reclama que encuentro no se realizó
            'host_no_show',            -- Participante reclama que host no se presentó
            'closure_data_error'       -- Participante reclama error relevante en cierre
        )
    ),
    iniciado_por UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    involucrado_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    estado TEXT NOT NULL DEFAULT 'awaiting_response' CHECK (
        estado IN (
            'awaiting_response',
            'response_received',
            'in_human_review',
            'confirmed_by_participant',
            'resolved_justified',
            'resolved_unjustified',
            'resolved_registration_error',
            'dismissed_insufficient_evidence',
            'rectified',
            'unverified_timeout',
            'dismissed',
            'pending_review'
        )
    ),
    descargo_tipo TEXT CHECK (
        descargo_tipo IS NULL OR descargo_tipo IN (
            'accept_absence',
            'notified_prior',
            'force_majeure',
            'attended_present',
            'request_human_review',
            'encounter_not_realized',
            'host_no_show',
            'closure_data_error',
            'claimed_encounter_not_realized',
            'claimed_host_no_show',
            'registration_error'
        )
    ),
    descargo_texto TEXT,
    descargo_en TIMESTAMPTZ,
    explicacion_contraparte TEXT,
    explicacion_contraparte_en TIMESTAMPTZ,
    plazo_respuesta_vence_en TIMESTAMPTZ NOT NULL DEFAULT (timezone('utc'::text, now()) + INTERVAL '7 days'),
    resolucion_tipo TEXT CHECK (
        resolucion_tipo IS NULL OR resolucion_tipo IN (
            'justified',
            'confirmed',
            'registration_error',
            'insufficient_evidence',
            'rectified',
            'accepted_by_user'
        )
    ),
    resolucion_fundamentacion TEXT,
    resuelto_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    resuelto_en TIMESTAMPTZ,
    rectificado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    rectificado_en TIMESTAMPTZ,
    rectificado_motivo TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Deduplicación de controversia de inasistencia por participante
CREATE UNIQUE INDEX IF NOT EXISTS uq_controversia_asistencia_participante
    ON public.asistencia_controversias(encuentro_id, participante_id, tipo_controversia)
    WHERE tipo_controversia = 'absence_reported' AND participante_id IS NOT NULL;

-- Deduplicación de controversia de realización por usuario
CREATE UNIQUE INDEX IF NOT EXISTS uq_controversia_realizacion_iniciador
    ON public.asistencia_controversias(encuentro_id, iniciado_por, tipo_controversia)
    WHERE tipo_controversia IN ('encounter_not_realized', 'host_no_show', 'closure_data_error');

-- Índices de consulta frecuente y moderación
CREATE INDEX IF NOT EXISTS idx_asistencia_controversias_encuentro
    ON public.asistencia_controversias(encuentro_id, estado);

CREATE INDEX IF NOT EXISTS idx_asistencia_controversias_involucrado
    ON public.asistencia_controversias(involucrado_id, estado);

CREATE INDEX IF NOT EXISTS idx_asistencia_controversias_iniciado
    ON public.asistencia_controversias(iniciado_por, estado);

CREATE INDEX IF NOT EXISTS idx_asistencia_controversias_moderacion
    ON public.asistencia_controversias(estado, created_at)
    WHERE estado IN ('in_human_review', 'response_received');

CREATE INDEX IF NOT EXISTS idx_asistencia_controversias_timeout
    ON public.asistencia_controversias(estado, plazo_respuesta_vence_en)
    WHERE estado = 'awaiting_response';


-- ------------------------------------------------------------------------------
-- 3. TABLA DE AUDITORÍA: public.asistencia_controversia_auditoria
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.asistencia_controversia_auditoria (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    controversia_id UUID NOT NULL REFERENCES public.asistencia_controversias(id) ON DELETE CASCADE,
    accion TEXT NOT NULL CHECK (
        accion IN (
            'created',
            'response_submitted',
            'counterparty_clarification',
            'auto_timeout',
            'resolved_by_moderator',
            'rectified'
        )
    ),
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    estado_anterior TEXT,
    estado_nuevo TEXT NOT NULL,
    notas TEXT,
    detalles JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_controversia_auditoria_id
    ON public.asistencia_controversia_auditoria(controversia_id, created_at);


-- ------------------------------------------------------------------------------
-- 4. SEGURIDAD Y ROW LEVEL SECURITY (RLS)
-- ------------------------------------------------------------------------------

ALTER TABLE public.asistencia_controversias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asistencia_controversia_auditoria ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.asistencia_controversias FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.asistencia_controversia_auditoria FROM PUBLIC, anon;

-- Política de lectura de controversias: Solo partes involucradas o moderadores autorizados
DROP POLICY IF EXISTS asistencia_controversias_select_parties ON public.asistencia_controversias;
CREATE POLICY asistencia_controversias_select_parties
    ON public.asistencia_controversias
    FOR SELECT
    TO authenticated
    USING (
        iniciado_por = auth.uid()
        OR involucrado_id = auth.uid()
        OR public.is_moderation_authorized()
    );

GRANT SELECT ON TABLE public.asistencia_controversias TO authenticated, postgres, service_role;
GRANT ALL ON TABLE public.asistencia_controversias TO postgres, service_role;

-- Política de lectura de auditoría: Solo partes o moderadores
DROP POLICY IF EXISTS asistencia_auditoria_select_parties ON public.asistencia_controversia_auditoria;
CREATE POLICY asistencia_auditoria_select_parties
    ON public.asistencia_controversia_auditoria
    FOR SELECT
    TO authenticated
    USING (
        actor_id = auth.uid()
        OR public.is_moderation_authorized()
        OR EXISTS (
            SELECT 1 FROM public.asistencia_controversias c
            WHERE c.id = asistencia_controversia_auditoria.controversia_id
              AND (c.iniciado_por = auth.uid() OR c.involucrado_id = auth.uid())
        )
    );

GRANT SELECT ON TABLE public.asistencia_controversia_auditoria TO authenticated, postgres, service_role;
GRANT ALL ON TABLE public.asistencia_controversia_auditoria TO postgres, service_role;


-- ------------------------------------------------------------------------------
-- 5. ACTUALIZAR: cerrar_encuentro_post_evento_seguro
--    Crea controversia inicial y emite notificación a los reportados ausentes con cuenta
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cerrar_encuentro_post_evento_seguro(
    p_encuentro_id UUID,
    p_realization_status TEXT,
    p_unrealized_reason TEXT DEFAULT NULL,
    p_asistencias JSONB DEFAULT '[]'::jsonb,
    p_host_id UUID DEFAULT NULL
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
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_event_start TIMESTAMPTZ;
    v_deadline TIMESTAMPTZ;
    v_closure_type TEXT;
    v_new_status TEXT;
    v_closed_responsibly BOOLEAN := false;
    v_item JSONB;
    v_part_id UUID;
    v_att_status TEXT;
    v_att_notes TEXT;
    v_part_row public.participantes%ROWTYPE;
    v_attendees_count INT := 0;
    v_reported_absent_count INT := 0;
    v_advance_notice_count INT := 0;
    v_unverified_count INT := 0;
    v_previous_status TEXT;
    v_clean_reason TEXT;
    v_is_identical BOOLEAN := true;
    v_existing_att_status TEXT;
    v_dispute_id UUID;
    v_reply_deadline TIMESTAMPTZ := v_now + INTERVAL '7 days';
BEGIN
    -- 1. Control de autenticación e identidad permanente
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_realization_status IS NULL OR p_realization_status NOT IN ('realized', 'not_realized', 'unconfirmed') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_realization_status');
    END IF;

    -- 2. Bloqueo exclusivo FOR UPDATE sobre el encuentro
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_already_cancelled');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_active');
    END IF;

    IF v_encuentro.opened_at IS NULL AND COALESCE(v_encuentro.is_open, false) = false THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'only_open_encounters_require_closure',
            'message', 'El cierre posterior y registro de asistencia aplica exclusivamente a encuentros abiertos.'
        );
    END IF;

    v_event_start := ((v_encuentro.fecha::text || ' ' || v_encuentro.hora::text)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires';
    IF v_now < v_event_start THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'event_not_started_yet');
    END IF;

    v_previous_status := v_encuentro.post_event_closure_status;
    v_deadline := COALESCE(
        v_encuentro.post_event_closure_deadline,
        public.calcular_vencimiento_cierre_encuentro(v_encuentro.fecha, v_encuentro.hora, v_encuentro.duration_minutes)
    );

    IF v_now <= v_deadline THEN
        v_closure_type := 'within_deadline';
    ELSE
        v_closure_type := 'overdue';
    END IF;

    v_clean_reason := NULLIF(pg_catalog.btrim(p_unrealized_reason), '');
    IF v_clean_reason IS NOT NULL AND pg_catalog.length(v_clean_reason) > 500 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'reason_too_long');
    END IF;

    -- Idempotencia estricta
    IF v_encuentro.post_event_closure_status IN ('completed', 'auto_closed') THEN
        v_is_identical := (
            v_encuentro.post_event_realization_status = p_realization_status
            AND COALESCE(v_encuentro.post_event_unrealized_reason, '') = COALESCE(v_clean_reason, '')
        );

        IF v_is_identical AND p_realization_status = 'realized' AND p_asistencias IS NOT NULL AND pg_catalog.jsonb_array_length(p_asistencias) > 0 THEN
            FOR v_item IN SELECT * FROM pg_catalog.jsonb_array_elements(p_asistencias)
            LOOP
                v_part_id := NULLIF(COALESCE(v_item->>'participante_id', v_item->>'id'), '')::UUID;
                v_att_status := COALESCE(v_item->>'status', v_item->>'attendance_status', 'unverified');
                IF v_part_id IS NOT NULL THEN
                    SELECT attendance_status INTO v_existing_att_status
                    FROM public.participantes
                    WHERE id = v_part_id AND encuentro_id = p_encuentro_id;

                    IF FOUND AND v_existing_att_status <> v_att_status THEN
                        v_is_identical := false;
                        EXIT;
                    END IF;
                END IF;
            END LOOP;
        END IF;

        IF v_is_identical THEN
            RETURN pg_catalog.json_build_object(
                'ok', true,
                'no_change', true,
                'encuentro_id', p_encuentro_id,
                'closure_status', v_encuentro.post_event_closure_status,
                'post_event_closure_status', v_encuentro.post_event_closure_status,
                'realization_status', v_encuentro.post_event_realization_status,
                'post_event_realization_status', v_encuentro.post_event_realization_status,
                'closure_type', v_encuentro.post_event_closure_type,
                'closed_responsibly', v_encuentro.post_event_closed_responsibly
            );
        ELSE
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'closure_already_completed',
                'message', 'El encuentro ya cuenta con un cierre definitivo registrado y no puede ser modificado.'
            );
        END IF;
    END IF;

    -- 3. Procesar según resultado informado
    IF p_realization_status = 'unconfirmed' THEN
        v_new_status := 'completed';
        v_closed_responsibly := false;
        v_closure_type := CASE WHEN v_now <= v_deadline THEN 'within_deadline' ELSE 'overdue' END;

        UPDATE public.participantes
        SET attendance_status = 'unverified',
            attendance_recorded_at = v_now
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio');
    ELSIF p_realization_status = 'not_realized' THEN
        v_new_status := 'completed';
        v_closed_responsibly := true;

        UPDATE public.participantes
        SET attendance_status = 'unmarked',
            attendance_recorded_at = v_now
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio');
    ELSE
        -- p_realization_status = 'realized'
        v_new_status := 'completed';
        v_closed_responsibly := true;

        IF p_asistencias IS NOT NULL AND pg_catalog.jsonb_array_length(p_asistencias) > 0 THEN
            FOR v_item IN SELECT * FROM pg_catalog.jsonb_array_elements(p_asistencias)
            LOOP
                v_part_id := NULLIF(COALESCE(v_item->>'participante_id', v_item->>'id'), '')::UUID;
                v_att_status := COALESCE(v_item->>'status', v_item->>'attendance_status', 'unverified');
                v_att_notes := NULLIF(pg_catalog.btrim(COALESCE(v_item->>'notes', v_item->>'attendance_notes')), '');

                IF v_part_id IS NOT NULL AND v_att_status IN ('attended', 'advance_notice_absent', 'reported_absent', 'unverified') THEN
                    SELECT * INTO v_part_row
                    FROM public.participantes
                    WHERE id = v_part_id AND encuentro_id = p_encuentro_id
                    FOR UPDATE;

                    IF FOUND THEN
                        IF v_part_row.estado <> 'cancelado' THEN
                            -- Si se marca reported_absent y el participante tiene cuenta registrada:
                            IF v_att_status = 'reported_absent' AND v_part_row.user_id IS NOT NULL THEN
                                -- Insertar controversia de inasistencia en estado awaiting_response (idempotente)
                                INSERT INTO public.asistencia_controversias (
                                    encuentro_id,
                                    participante_id,
                                    tipo_controversia,
                                    iniciado_por,
                                    involucrado_id,
                                    estado,
                                    plazo_respuesta_vence_en,
                                    metadata,
                                    created_at,
                                    updated_at
                                ) VALUES (
                                    p_encuentro_id,
                                    v_part_id,
                                    'absence_reported',
                                    v_user_id,
                                    v_part_row.user_id,
                                    'awaiting_response',
                                    v_reply_deadline,
                                    pg_catalog.jsonb_build_object(
                                        'host_notes', v_att_notes,
                                        'encounter_title', v_encuentro.open_public_title
                                    ),
                                    v_now,
                                    v_now
                                )
                                ON CONFLICT (encuentro_id, participante_id, tipo_controversia)
                                WHERE tipo_controversia = 'absence_reported' AND participante_id IS NOT NULL
                                DO UPDATE SET updated_at = v_now
                                RETURNING id INTO v_dispute_id;

                                IF v_dispute_id IS NULL THEN
                                    SELECT id INTO v_dispute_id
                                    FROM public.asistencia_controversias
                                    WHERE encuentro_id = p_encuentro_id
                                      AND participante_id = v_part_id
                                      AND tipo_controversia = 'absence_reported';
                                END IF;

                                -- Registrar evento de auditoría inicial
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
                                    'awaiting_response',
                                    'Reporte de inasistencia registrado por organizador',
                                    pg_catalog.jsonb_build_object('reply_deadline', v_reply_deadline)
                                );

                                -- Actualizar participante con enlace a la controversia
                                UPDATE public.participantes
                                SET attendance_status = v_att_status,
                                    attendance_recorded_at = v_now,
                                    attendance_notes = v_att_notes,
                                    attendance_dispute_id = v_dispute_id,
                                    attendance_dispute_status = 'awaiting_response'
                                WHERE id = v_part_id;

                                -- Notificación al participante en Inbox
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
                                    v_part_row.user_id,
                                    'attendance_reported_absent',
                                    'attendance_dispute',
                                    v_dispute_id,
                                    '/solicitudes?dispute_id=' || v_dispute_id,
                                    'Declaración de inasistencia en revisión',
                                    'El organizador de "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '" registró una inasistencia. Tenés derecho a responder o solicitar revisión.',
                                    pg_catalog.json_build_object(
                                        'dispute_id', v_dispute_id,
                                        'encuentro_id', p_encuentro_id,
                                        'reply_deadline', v_reply_deadline
                                    ),
                                    'absence_dispute:' || p_encuentro_id || ':' || v_part_id,
                                    v_now + INTERVAL '30 days'
                                ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;

                            ELSE
                                -- Asistencia normal, aviso previo, sin cuenta, etc.
                                UPDATE public.participantes
                                SET attendance_status = v_att_status,
                                    attendance_recorded_at = v_now,
                                    attendance_notes = v_att_notes,
                                    attendance_dispute_status = 'none',
                                    estado = CASE WHEN v_att_status = 'attended' THEN 'asistio' ELSE estado END
                                WHERE id = v_part_id;
                            END IF;

                            IF v_att_status = 'attended' THEN
                                v_attendees_count := v_attendees_count + 1;
                            ELSIF v_att_status = 'reported_absent' THEN
                                v_reported_absent_count := v_reported_absent_count + 1;
                            ELSIF v_att_status = 'advance_notice_absent' THEN
                                v_advance_notice_count := v_advance_notice_count + 1;
                            ELSE
                                v_unverified_count := v_unverified_count + 1;
                            END IF;
                        END IF;
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END IF;

    -- 4. Actualizar tabla public.encuentros
    UPDATE public.encuentros
    SET post_event_closure_status = v_new_status,
        post_event_realization_status = p_realization_status,
        post_event_unrealized_reason = v_clean_reason,
        post_event_closed_at = CASE WHEN v_new_status = 'completed' THEN v_now ELSE post_event_closed_at END,
        post_event_closure_deadline = v_deadline,
        post_event_closure_type = CASE WHEN v_new_status = 'completed' THEN v_closure_type ELSE post_event_closure_type END,
        post_event_closed_responsibly = CASE WHEN v_new_status = 'completed' THEN v_closed_responsibly ELSE post_event_closed_responsibly END
    WHERE id = p_encuentro_id;

    -- 5. Registrar auditoría de cierre
    INSERT INTO public.encuentro_post_event_closure_audit (
        encuentro_id,
        host_id,
        previous_closure_status,
        new_closure_status,
        realization_status,
        unrealized_reason,
        closure_type,
        closed_responsibly,
        attendees_count,
        reported_absent_count,
        advance_notice_absent_count,
        unverified_count,
        created_at
    ) VALUES (
        p_encuentro_id,
        v_user_id,
        v_previous_status,
        v_new_status,
        p_realization_status,
        v_clean_reason,
        v_closure_type,
        v_closed_responsibly,
        v_attendees_count,
        v_reported_absent_count,
        v_advance_notice_count,
        v_unverified_count,
        v_now
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'closure_status', v_new_status,
        'post_event_closure_status', v_new_status,
        'realization_status', p_realization_status,
        'post_event_realization_status', p_realization_status,
        'closure_type', v_closure_type,
        'closed_responsibly', v_closed_responsibly,
        'attendees_count', v_attendees_count,
        'reported_absent_count', v_reported_absent_count,
        'advance_notice_absent_count', v_advance_notice_count,
        'unverified_count', v_unverified_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_encuentro_post_evento_seguro(UUID, TEXT, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cerrar_encuentro_post_evento_seguro(UUID, TEXT, TEXT, JSONB, UUID) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 6. RPC: responder_controversia_asistencia_seguro (DERECHO A RESPUESTA DEL PARTICIPANTE)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.responder_controversia_asistencia_seguro(
    p_dispute_id UUID,
    p_decision TEXT,
    p_descargo_texto TEXT DEFAULT NULL
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
    v_clean_descargo TEXT;
    v_new_dispute_status TEXT;
    v_new_attendance_status TEXT;
    v_resolucion_tipo TEXT := NULL;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_decision IS NULL OR p_decision NOT IN (
        'accept_absence',
        'notified_prior',
        'force_majeure',
        'attended_present',
        'request_human_review'
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_decision');
    END IF;

    v_clean_descargo := NULLIF(pg_catalog.btrim(p_descargo_texto), '');
    IF v_clean_descargo IS NOT NULL AND pg_catalog.length(v_clean_descargo) > 1000 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'descargo_too_long');
    END IF;

    -- Bloqueo exclusivo de la controversia
    SELECT * INTO v_dispute
    FROM public.asistencia_controversias
    WHERE id = p_dispute_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'dispute_not_found');
    END IF;

    -- Autorización: solo el participante reportado puede ejercer el derecho a respuesta
    IF v_dispute.involucrado_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    -- Solo se puede responder en estado awaiting_response o unverified_timeout
    IF v_dispute.estado NOT IN ('awaiting_response', 'unverified_timeout') THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'dispute_already_processed',
            'current_status', v_dispute.estado
        );
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_dispute.encuentro_id;

    -- Transición según decisión
    IF p_decision = 'accept_absence' THEN
        -- El participante reconoce expresamente la inasistencia
        v_new_dispute_status := 'confirmed_by_participant';
        v_new_attendance_status := 'reported_absent';
        v_resolucion_tipo := 'accepted_by_user';

        UPDATE public.asistencia_controversias
        SET estado = v_new_dispute_status,
            descargo_tipo = p_decision,
            descargo_texto = v_clean_descargo,
            descargo_en = v_now,
            resolucion_tipo = v_resolucion_tipo,
            resuelto_por = v_user_id,
            resuelto_en = v_now,
            updated_at = v_now
        WHERE id = p_dispute_id;

        IF v_dispute.participante_id IS NOT NULL THEN
            UPDATE public.participantes
            SET attendance_status = v_new_attendance_status,
                attendance_dispute_status = v_new_dispute_status,
                estado = CASE WHEN v_new_attendance_status = 'attended' THEN 'asistio' ELSE estado END
            WHERE id = v_dispute.participante_id;
        END IF;

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
            'response_submitted',
            v_user_id,
            v_dispute.estado,
            v_new_dispute_status,
            'Participante aceptó expresamente inasistencia',
            pg_catalog.jsonb_build_object('decision', p_decision)
        );

    ELSE
        -- Cualquier descargo o solicitud de revisión pasa a moderación humana
        -- INVARIANTE: El registro impugnado pasa a 'unverified' mientras esté en revisión
        v_new_dispute_status := 'in_human_review';
        v_new_attendance_status := 'unverified';

        UPDATE public.asistencia_controversias
        SET estado = v_new_dispute_status,
            descargo_tipo = p_decision,
            descargo_texto = v_clean_descargo,
            descargo_en = v_now,
            updated_at = v_now
        WHERE id = p_dispute_id;

        IF v_dispute.participante_id IS NOT NULL THEN
            UPDATE public.participantes
            SET attendance_status = v_new_attendance_status,
                attendance_dispute_status = v_new_dispute_status,
                estado = CASE WHEN v_new_attendance_status = 'attended' THEN 'asistio' ELSE estado END
            WHERE id = v_dispute.participante_id;
        END IF;

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
            'response_submitted',
            v_user_id,
            v_dispute.estado,
            v_new_dispute_status,
            'Descargo o solicitud de revisión enviada a moderación',
            pg_catalog.jsonb_build_object(
                'decision', p_decision,
                'has_descargo_text', (v_clean_descargo IS NOT NULL)
            )
        );

        -- Notificación informativa al organizador sobre el descargo recibido
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
            v_dispute.iniciado_por,
            'attendance_dispute_response',
            'attendance_dispute',
            p_dispute_id,
            '/meet/' || v_dispute.encuentro_id || '#controversia=' || p_dispute_id,
            'Descargo recibido sobre asistencia',
            'Un participante presentó su respuesta sobre el registro de asistencia en "' || COALESCE(v_encuentro.open_public_title, 'Encuentro') || '". El caso pasó a revisión.',
            pg_catalog.jsonb_build_object('dispute_id', p_dispute_id, 'encuentro_id', v_dispute.encuentro_id),
            'dispute_resp:' || p_dispute_id || ':' || v_now::text,
            v_now + INTERVAL '30 days'
        ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'dispute_id', p_dispute_id,
        'status', v_new_dispute_status,
        'attendance_status', v_new_attendance_status
    );
END;
$$;

REVOKE ALL ON FUNCTION public.responder_controversia_asistencia_seguro(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.responder_controversia_asistencia_seguro(UUID, TEXT, TEXT) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 7. RPC: iniciar_controversia_realizacion_seguro (RECLAMOS SOBRE EL ORGANIZADOR)
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
    v_clean_motivo TEXT;
    v_dispute_id UUID;
BEGIN
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

    -- Validar encuentro
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    -- El anfitrión no puede denunciarse a sí mismo
    IF v_encuentro.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_dispute_own_encounter');
    END IF;

    -- Validar relación real: solo participantes confirmados o asistentes pueden iniciar controversia
    SELECT * INTO v_part_row
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id
      AND user_id = v_user_id
      AND estado IN ('confirmado', 'asistio')
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'only_confirmed_participants_allowed');
    END IF;

    -- Comprobar si ya existe una controversia de este tipo iniciada por el mismo usuario
    IF EXISTS (
        SELECT 1 FROM public.asistencia_controversias
        WHERE encuentro_id = p_encuentro_id
          AND iniciado_por = v_user_id
          AND tipo_controversia = p_tipo_controversia
          AND estado NOT IN ('dismissed_insufficient_evidence', 'rectified')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'dispute_already_active');
    END IF;

    -- Crear la controversia en cola de revisión humana
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
            'encounter_title', v_encuentro.open_public_title
        ),
        v_now,
        v_now
    ) RETURNING id INTO v_dispute_id;

    -- Auditoría
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
        pg_catalog.jsonb_build_object('type', p_tipo_controversia)
    );

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
-- 8. RPC: aportar_aclaracion_controversia_seguro
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
    v_dispute public.asistencia_controversias%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_clean TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_clean := NULLIF(pg_catalog.btrim(p_aclaracion_texto), '');
    IF v_clean IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'clarification_required');
    END IF;

    IF pg_catalog.length(v_clean) > 1000 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'clarification_too_long');
    END IF;

    SELECT * INTO v_dispute
    FROM public.asistencia_controversias
    WHERE id = p_dispute_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'dispute_not_found');
    END IF;

    -- Solo la contraparte o el iniciador pueden aportar aclaraciones
    IF v_dispute.iniciado_por <> v_user_id AND v_dispute.involucrado_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    UPDATE public.asistencia_controversias
    SET explicacion_contraparte = v_clean,
        explicacion_contraparte_en = v_now,
        updated_at = v_now
    WHERE id = p_dispute_id;

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
        'Aclaración aportada por parte del encuentro',
        pg_catalog.jsonb_build_object('actor_is_host', (v_user_id = v_dispute.involucrado_id))
    );

    RETURN pg_catalog.json_build_object('ok', true, 'dispute_id', p_dispute_id);
END;
$$;

REVOKE ALL ON FUNCTION public.aportar_aclaracion_controversia_seguro(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aportar_aclaracion_controversia_seguro(UUID, TEXT) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 9. RPC: get_controversias_moderacion_seguro (COLA ADMINISTRATIVA DE CONTROVERSIAS)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_controversias_moderacion_seguro(
    p_status TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_mod BOOLEAN := public.is_moderation_authorized();
    v_result JSON;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF NOT v_is_mod THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT pg_catalog.json_agg(row_data) INTO v_result
    FROM (
        SELECT
            c.id,
            c.encuentro_id,
            e.open_public_title AS encuentro_title,
            e.fecha AS encuentro_fecha,
            e.hora AS encuentro_hora,
            e.modalidad AS encuentro_modalidad,
            c.participante_id,
            p.nombre_invitado AS participante_nombre,
            c.tipo_controversia,
            c.estado,
            c.descargo_tipo,
            c.descargo_texto,
            c.descargo_en,
            c.explicacion_contraparte,
            c.explicacion_contraparte_en,
            c.plazo_respuesta_vence_en,
            c.resolucion_tipo,
            c.resolucion_fundamentacion,
            c.resuelto_en,
            c.created_at,
            c.iniciado_por,
            c.involucrado_id,
            -- Detección de conflicto de interés: el moderador es parte interesada
            (v_user_id = c.iniciado_por OR v_user_id = c.involucrado_id OR v_user_id = e.host_id) AS has_conflict_of_interest
        FROM public.asistencia_controversias c
        JOIN public.encuentros e ON e.id = c.encuentro_id
        LEFT JOIN public.participantes p ON p.id = c.participante_id
        WHERE (
            p_status IS NULL
            OR (p_status = 'pending' AND c.estado IN ('in_human_review', 'response_received', 'awaiting_response'))
            OR (p_status = 'resolved' AND c.estado IN ('resolved_justified', 'resolved_unjustified', 'resolved_registration_error', 'dismissed_insufficient_evidence', 'confirmed_by_participant', 'rectified'))
            OR c.estado = p_status
        )
        ORDER BY
            CASE WHEN c.estado = 'in_human_review' THEN 0 ELSE 1 END ASC,
            c.created_at ASC
        LIMIT 100
    ) row_data;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'queue', COALESCE(v_result, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_controversias_moderacion_seguro(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_controversias_moderacion_seguro(TEXT) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 10. RPC: resolver_controversia_moderacion_seguro
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
    -- Ninguna parte involucrada ni el organizador pueden resolver su propia controversia
    IF v_user_id = v_dispute.iniciado_por OR v_user_id = v_dispute.involucrado_id OR v_user_id = v_encuentro.host_id THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'conflict_of_interest',
            'message', 'No podés moderar ni resolver una controversia en la que sos parte o anfitrión.'
        );
    END IF;

    -- Idempotencia: si ya está resuelta con la misma resolución, retornar ok
    IF v_dispute.estado IN ('resolved_justified', 'resolved_unjustified', 'resolved_registration_error', 'dismissed_insufficient_evidence', 'rectified')
       AND v_dispute.resolucion_tipo = p_resolucion THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'idempotent', true,
            'dispute_id', p_dispute_id,
            'status', v_dispute.estado,
            'resolution', v_dispute.resolucion_tipo
        );
    END IF;

    -- Mapeo de resolución a estados
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

    -- Actualizar controversia
    UPDATE public.asistencia_controversias
    SET estado = v_new_state,
        resolucion_tipo = p_resolucion,
        resolucion_fundamentacion = v_clean_fund,
        resuelto_por = v_user_id,
        resuelto_en = v_now,
        updated_at = v_now
    WHERE id = p_dispute_id;

    -- Actualizar participante asociado si corresponde
    IF v_dispute.participante_id IS NOT NULL THEN
        UPDATE public.participantes
        SET attendance_status = v_new_att_status,
            attendance_dispute_status = v_new_state,
            estado = CASE WHEN v_new_att_status = 'attended' THEN 'asistio' ELSE estado END
        WHERE id = v_dispute.participante_id;
    END IF;

    -- Auditoría durable
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
            'attendance_status', v_new_att_status
        )
    );

    v_participant_user_id := CASE WHEN v_dispute.tipo_controversia = 'absence_reported' THEN v_dispute.involucrado_id ELSE v_dispute.iniciado_por END;
    v_host_user_id := CASE WHEN v_dispute.tipo_controversia = 'absence_reported' THEN v_dispute.iniciado_por ELSE v_dispute.involucrado_id END;

    -- Notificar al participante (Deep link a la vista de solicitudes / controversia del participante)
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

    -- Notificar al organizador (Deep link a la gestión del encuentro del host)
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


-- ------------------------------------------------------------------------------
-- 11. RPC: procesar_vencimientos_controversias_seguro (VENCIMIENTO 7 DÍAS SIN RESPUESTA)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.procesar_vencimientos_controversias_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_jwt_claims JSONB := auth.jwt();
    v_has_jwt BOOLEAN := (v_jwt_claims IS NOT NULL AND v_jwt_claims <> '{}'::jsonb);
    v_caller_role TEXT := COALESCE(
        v_jwt_claims ->> 'role',
        NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
        ''
    );
    v_is_internal BOOLEAN := (
        v_caller_role = 'service_role'
        OR (
            session_user IN ('postgres', 'service_role')
            AND v_caller_role = ''
            AND NOT v_has_jwt
            AND v_caller_id IS NULL
        )
    );
    v_rec RECORD;
    v_count INT := 0;
    v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
    -- Protección contra llamadas no autorizadas: requiere contexto interno verificado (cron o service_role)
    IF NOT v_is_internal THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    -- REGLA FUNDAMENTAL:
    -- Tras 7 días sin respuesta, el registro se marca unverified_timeout
    -- y el estado de asistencia pasa a 'unverified' (NO CONFIRMADO / SALIDA NEUTRAL).
    FOR v_rec IN
        SELECT id, participante_id, involucrado_id, encuentro_id
        FROM public.asistencia_controversias
        WHERE tipo_controversia = 'absence_reported'
          AND estado = 'awaiting_response'
          AND plazo_respuesta_vence_en < v_now
        FOR UPDATE
    LOOP
        UPDATE public.asistencia_controversias
        SET estado = 'unverified_timeout',
            updated_at = v_now
        WHERE id = v_rec.id;

        IF v_rec.participante_id IS NOT NULL THEN
            UPDATE public.participantes
            SET attendance_status = 'unverified',
                attendance_dispute_status = 'unverified_timeout'
            WHERE id = v_rec.participante_id;
        END IF;

        INSERT INTO public.asistencia_controversia_auditoria (
            controversia_id,
            accion,
            actor_id,
            estado_anterior,
            estado_nuevo,
            notas,
            detalles
        ) VALUES (
            v_rec.id,
            'auto_timeout',
            NULL,
            'awaiting_response',
            'unverified_timeout',
            'Plazo de respuesta vencido sin declaración: estado neutral no verificado',
            pg_catalog.jsonb_build_object('timeout_at', v_now)
        );

        v_count := v_count + 1;
    END LOOP;

    RETURN pg_catalog.json_build_object('ok', true, 'processed_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.procesar_vencimientos_controversias_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.procesar_vencimientos_controversias_seguro() TO postgres, service_role;


-- ------------------------------------------------------------------------------
-- 12. RPC: get_mis_controversias_asistencia_seguro (CONSULTA DEL USUARIO)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_mis_controversias_asistencia_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_result JSON;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    SELECT pg_catalog.json_agg(row_data) INTO v_result
    FROM (
        SELECT
            c.id,
            c.encuentro_id,
            e.open_public_title AS encuentro_title,
            e.fecha AS encuentro_fecha,
            e.hora AS encuentro_hora,
            c.participante_id,
            c.tipo_controversia,
            c.estado,
            c.descargo_tipo,
            c.descargo_texto,
            c.descargo_en,
            c.explicacion_contraparte,
            c.plazo_respuesta_vence_en,
            c.resolucion_tipo,
            c.resolucion_fundamentacion,
            c.resuelto_en,
            c.created_at,
            (c.iniciado_por = v_user_id) AS is_initiator,
            (c.involucrado_id = v_user_id) AS is_involved,
            (c.involucrado_id = v_user_id AND c.estado IN ('awaiting_response', 'unverified_timeout')) AS can_respond
        FROM public.asistencia_controversias c
        JOIN public.encuentros e ON e.id = c.encuentro_id
        WHERE c.iniciado_por = v_user_id OR c.involucrado_id = v_user_id
        ORDER BY c.created_at DESC
        LIMIT 50
    ) row_data;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'controversias', COALESCE(v_result, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_mis_controversias_asistencia_seguro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mis_controversias_asistencia_seguro() TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 13. RPC: get_detalle_controversia_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_detalle_controversia_seguro(
    p_dispute_id UUID
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
    v_part public.participantes%ROWTYPE;
    v_audit JSON;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    SELECT * INTO v_dispute
    FROM public.asistencia_controversias
    WHERE id = p_dispute_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'dispute_not_found');
    END IF;

    -- Aislamiento de privacidad: solo partes o moderadores
    IF v_dispute.iniciado_por <> v_user_id AND v_dispute.involucrado_id <> v_user_id AND NOT v_is_mod THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_encuentro FROM public.encuentros WHERE id = v_dispute.encuentro_id;
    IF v_dispute.participante_id IS NOT NULL THEN
        SELECT * INTO v_part FROM public.participantes WHERE id = v_dispute.participante_id;
    END IF;

    -- Historial de auditoría
    SELECT pg_catalog.json_agg(a_row) INTO v_audit
    FROM (
        SELECT accion, estado_anterior, estado_nuevo, notas, created_at
        FROM public.asistencia_controversia_auditoria
        WHERE controversia_id = p_dispute_id
        ORDER BY created_at ASC
    ) a_row;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', v_dispute.id,
        'encuentro_id', v_dispute.encuentro_id,
        'encuentro_title', v_encuentro.open_public_title,
        'encuentro_fecha', v_encuentro.fecha,
        'encuentro_hora', v_encuentro.hora,
        'tipo_controversia', v_dispute.tipo_controversia,
        'estado', v_dispute.estado,
        'descargo_tipo', v_dispute.descargo_tipo,
        'descargo_texto', v_dispute.descargo_texto,
        'descargo_en', v_dispute.descargo_en,
        'explicacion_contraparte', v_dispute.explicacion_contraparte,
        'explicacion_contraparte_en', v_dispute.explicacion_contraparte_en,
        'plazo_respuesta_vence_en', v_dispute.plazo_respuesta_vence_en,
        'resolucion_tipo', v_dispute.resolucion_tipo,
        'resolucion_fundamentacion', v_dispute.resolucion_fundamentacion,
        'resuelto_en', v_dispute.resuelto_en,
        'participante_nombre', v_part.nombre_invitado,
        'attendance_status', v_part.attendance_status,
        'is_initiator', (v_dispute.iniciado_por = v_user_id),
        'is_involved', (v_dispute.involucrado_id = v_user_id),
        'can_respond', (v_dispute.involucrado_id = v_user_id AND v_dispute.estado IN ('awaiting_response', 'unverified_timeout')),
        'has_conflict_of_interest', (v_is_mod AND (v_user_id = v_dispute.iniciado_por OR v_user_id = v_dispute.involucrado_id OR v_user_id = v_encuentro.host_id)),
        'auditoria', COALESCE(v_audit, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_detalle_controversia_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_detalle_controversia_seguro(UUID) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 14. RPC: get_historial_asistencia_factual_seguro (PROYECCIÓN FACTUAL DE CONFIANZA)
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
BEGIN
    IF v_caller_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- Aislamiento de privacidad: un usuario solo puede consultar sus propios hechos,
    -- salvo moderador autorizado
    IF p_user_id IS NOT NULL AND p_user_id <> v_caller_id THEN
        IF NOT v_is_mod THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
        END IF;
        v_target_id := p_user_id;
    ELSE
        v_target_id := v_caller_id;
    END IF;

    -- Conteo factual desde participantes (diferenciando declaraciones unilaterales del host de hechos verificados)
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

    -- Conteo de controversias sobre rol de organizador
    SELECT
        COALESCE(pg_catalog.sum(CASE WHEN involucrado_id = v_target_id AND tipo_controversia IN ('encounter_not_realized', 'host_no_show', 'closure_data_error') THEN 1 ELSE 0 END), 0)::int,
        COALESCE(pg_catalog.sum(CASE WHEN iniciado_por = v_target_id AND tipo_controversia IN ('encounter_not_realized', 'host_no_show', 'closure_data_error') THEN 1 ELSE 0 END), 0)::int
    INTO
        v_controversias_host_recibidas,
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
        'controversias_organizador_iniciadas', v_controversias_host_iniciadas
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_historial_asistencia_factual_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_historial_asistencia_factual_seguro(UUID) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 15. PROGRAMACIÓN CRON DE VENCIMIENTOS (7 DÍAS SIN RESPUESTA)
-- ------------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('vencimiento_controversias_asistencia_job');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        PERFORM cron.schedule(
            'vencimiento_controversias_asistencia_job',
            '0 * * * *',
            'SELECT public.procesar_vencimientos_controversias_seguro();'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

COMMIT;
