-- ==============================================================================
-- Migración: 20261024200000_hotfix_post_event_closure_security_and_idempotency.sql
-- Fase V1 Mini-Sprint A — Hotfix de Integridad y Seguridad
--
-- Objetivos:
-- 1. P0 — Regularización administrativa con aislamiento estricto de identidad:
--    - Invocación desde sesión de usuario (authenticated) limitada forzosamente a auth.uid().
--    - Prohibición de barridos globales o p_host_id ajenos desde authenticated.
--    - Operación global reservada exclusivamente a contextos internos (service_role, postgres).
--    - Preservar la llamada interna desde abrir_encuentro_seguro.
-- 2. P0 — Cierre no repetible y protección contra modificación de cierres definitivos:
--    - Idempotencia estricta para reintentos idénticos de red/interfaz (retorna éxito sin mutar ni duplicar auditoría).
--    - Rechazo con error 'closure_already_completed' ante cualquier intento de alterar un cierre definitivo existente.
-- 3. P1 — Alcance exclusivo de Encuentros Abiertos:
--    - Bloqueo server-side de cierre posterior en encuentros exclusivamente privados (opened_at IS NULL AND is_open = false).
--    - Preservar encuentros que nacieron privados y posteriormente fueron abiertos legítimamente.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. RPC: regularizar_cierres_administrativos_automaticos (AISLAMIENTO DE IDENTIDAD)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.regularizar_cierres_administrativos_automaticos(
    p_host_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_caller_role TEXT := COALESCE(auth.jwt() ->> 'role', '');
    -- Es contexto interno autorizado si no hay sesión de usuario (cron/mantenimiento)
    -- o si se autenticó explícitamente con service_role.
    v_is_internal BOOLEAN := (v_caller_id IS NULL OR v_caller_role = 'service_role');
    v_target_host_id UUID;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_count INT := 0;
    v_rec RECORD;
BEGIN
    IF v_is_internal THEN
        -- Contextos internos de mantenimiento, cron o service_role
        v_target_host_id := p_host_id;
    ELSE
        -- Sesión autenticada de usuario (authenticated):
        -- Aislamiento estricto: un usuario no puede regularizar organizadores ajenos
        IF p_host_id IS NOT NULL AND p_host_id <> v_caller_id THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden', 'message', 'No tienes permiso para regularizar encuentros ajenos.');
        END IF;

        -- Forzar scope al usuario autenticado (evita barrido global p_host_id = NULL)
        v_target_host_id := v_caller_id;
    END IF;

    -- Busca encuentros abiertos pasados de fecha límite de gracia sin ningún participante confirmado
    FOR v_rec IN
        SELECT e.id, e.host_id, e.post_event_closure_status
        FROM public.encuentros e
        WHERE e.estado = 'activo'
          AND e.opened_at IS NOT NULL
          AND e.post_event_closure_status IN ('pending', 'overdue')
          AND v_now > COALESCE(e.post_event_closure_deadline, public.calcular_vencimiento_cierre_encuentro(e.fecha, e.hora, e.duration_minutes))
          AND (v_target_host_id IS NULL OR e.host_id = v_target_host_id)
          AND NOT EXISTS (
              SELECT 1 FROM public.participantes p
              WHERE p.encuentro_id = e.id AND p.estado IN ('confirmado', 'asistio')
          )
        FOR UPDATE OF e
    LOOP
        UPDATE public.encuentros
        SET post_event_closure_status = 'auto_closed',
            post_event_closure_type = 'administrative_auto',
            post_event_closed_responsibly = false,
            post_event_realization_status = 'unconfirmed',
            post_event_closed_at = v_now
        WHERE id = v_rec.id;

        INSERT INTO public.encuentro_post_event_closure_audit (
            encuentro_id,
            host_id,
            previous_closure_status,
            new_closure_status,
            realization_status,
            closure_type,
            closed_responsibly,
            created_at
        ) VALUES (
            v_rec.id,
            v_rec.host_id,
            v_rec.post_event_closure_status,
            'auto_closed',
            'unconfirmed',
            'administrative_auto',
            false,
            v_now
        );

        v_count := v_count + 1;
    END LOOP;

    RETURN pg_catalog.json_build_object('ok', true, 'regularized_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.regularizar_cierres_administrativos_automaticos(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.regularizar_cierres_administrativos_automaticos(UUID) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 2. RPC: cerrar_encuentro_post_evento_seguro (PROTECCIÓN DE CIERRE DEFINITIVO E IDEMPOTENCIA)
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

    -- Validar que el usuario sea el organizador legítimo
    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    -- INVARIANTE: Los encuentros cancelados no admiten doble obligación incompatible
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_already_cancelled');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_active');
    END IF;

    -- INVARIANTE: El cierre posterior es exclusivo de Encuentros Abiertos
    -- Los encuentros exclusivamente privados (nunca abiertos) no generan obligación ni mérito abierto
    IF v_encuentro.opened_at IS NULL AND COALESCE(v_encuentro.is_open, false) = false THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'only_open_encounters_require_closure',
            'message', 'El cierre posterior y registro de asistencia aplica exclusivamente a encuentros abiertos.'
        );
    END IF;

    -- Validar que el encuentro haya comenzado al menos
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

    -- =========================================================================
    -- INVARIANTE P0: Protección de cierre definitivo e Idempotencia
    -- =========================================================================
    IF v_encuentro.post_event_closure_status IN ('completed', 'auto_closed') THEN
        -- Comprobar si es un reintento idéntico legítimo (idempotencia de red/UI)
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
            -- Idempotencia exitosa: no muta datos ni duplica auditoría
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
            -- Intento de alteración de un cierre definitivo ya registrado
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'closure_already_completed',
                'message', 'El encuentro ya cuenta con un cierre definitivo registrado y no puede ser modificado.'
            );
        END IF;
    END IF;

    -- 3. Procesar según resultado informado
    IF p_realization_status = 'unconfirmed' THEN
        -- Host declara formalmente que no es posible confirmar el resultado
        -- Salida neutral: completa cierre sin reconocer crédito responsable
        v_new_status := 'completed';
        v_closed_responsibly := false;
        v_closure_type := CASE WHEN v_now <= v_deadline THEN 'within_deadline' ELSE 'overdue' END;

        UPDATE public.participantes
        SET attendance_status = 'unverified',
            attendance_recorded_at = v_now
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio');
    ELSIF p_realization_status = 'not_realized' THEN
        -- El encuentro no se realizó: cierre voluntario responsable con motivo
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

        -- Procesar lista de asistencias proporcionada
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
                        -- Preservar historial de bajas
                        IF v_part_row.estado <> 'cancelado' THEN
                            UPDATE public.participantes
                            SET attendance_status = v_att_status,
                                attendance_recorded_at = v_now,
                                attendance_notes = v_att_notes,
                                estado = CASE WHEN v_att_status = 'attended' THEN 'asistio' ELSE estado END
                            WHERE id = v_part_id;

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
-- 3. RPC: get_detalle_cierre_post_evento_seguro (ALCANCE EXCLUSIVO ENCUENTROS ABIERTOS)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_detalle_cierre_post_evento_seguro(
    p_encuentro_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_deadline TIMESTAMPTZ;
    v_event_start TIMESTAMPTZ;
    v_has_started BOOLEAN;
    v_is_overdue BOOLEAN;
    v_participantes JSONB := '[]'::jsonb;
    v_confirmed_count INT := 0;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    -- INVARIANTE: El detalle de cierre posterior aplica exclusivamente a Encuentros Abiertos
    IF v_encuentro.opened_at IS NULL AND COALESCE(v_encuentro.is_open, false) = false THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'only_open_encounters_require_closure',
            'message', 'El encuentro es exclusivamente privado.'
        );
    END IF;

    v_event_start := ((v_encuentro.fecha::text || ' ' || v_encuentro.hora::text)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires';
    v_has_started := (v_now >= v_event_start);
    
    v_deadline := COALESCE(
        v_encuentro.post_event_closure_deadline,
        public.calcular_vencimiento_cierre_encuentro(v_encuentro.fecha, v_encuentro.hora, v_encuentro.duration_minutes)
    );
    v_is_overdue := (v_now > v_deadline);

    -- Cargar participantes confirmados o activos
    SELECT 
        COALESCE(
            pg_catalog.json_agg(
                pg_catalog.json_build_object(
                    'id', p.id,
                    'nombre_invitado', p.nombre_invitado,
                    'seat_count', COALESCE(p.seat_count, 1),
                    'user_id', p.user_id,
                    'tipo_invitacion', p.tipo_invitacion,
                    'reconfirmation_status', p.reconfirmation_status,
                    'attendance_status', p.attendance_status,
                    'attendance_notes', p.attendance_notes,
                    'is_multi_seat', (COALESCE(p.seat_count, 1) > 1)
                ) ORDER BY p.creado_en ASC
            ),
            '[]'::json
        )::jsonb,
        COALESCE(pg_catalog.sum(COALESCE(p.seat_count, 1)), 0)::int
    INTO v_participantes, v_confirmed_count
    FROM public.participantes p
    WHERE p.encuentro_id = p_encuentro_id
      AND p.estado IN ('confirmado', 'asistio');

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', v_encuentro.id,
        'titulo', v_encuentro.titulo,
        'open_public_title', v_encuentro.open_public_title,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'duration_minutes', v_encuentro.duration_minutes,
        'modalidad', v_encuentro.modalidad,
        'is_open', v_encuentro.is_open,
        'has_started', v_has_started,
        'post_event_closure_status', v_encuentro.post_event_closure_status,
        'post_event_realization_status', v_encuentro.post_event_realization_status,
        'post_event_unrealized_reason', v_encuentro.post_event_unrealized_reason,
        'post_event_closed_at', v_encuentro.post_event_closed_at,
        'post_event_closure_deadline', v_deadline,
        'post_event_closure_type', v_encuentro.post_event_closure_type,
        'post_event_closed_responsibly', v_encuentro.post_event_closed_responsibly,
        'is_overdue', v_is_overdue,
        'confirmed_seats_count', v_confirmed_count,
        'has_confirmed_participants', (v_confirmed_count > 0),
        'participantes', v_participantes
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_detalle_cierre_post_evento_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_detalle_cierre_post_evento_seguro(UUID) TO authenticated, postgres, service_role;

COMMIT;
