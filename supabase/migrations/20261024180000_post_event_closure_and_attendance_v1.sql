-- ==============================================================================
-- Migración: 20261024180000_post_event_closure_and_attendance_v1.sql
-- Fase V1 Mini-Sprint A: Cierre posterior, asistencia efectiva y reconocimiento responsable
--
-- Objetivos:
-- 1. Estado de cierre posterior independiente del estado de publicación:
--    - post_event_closure_status ('not_applicable', 'pending', 'completed', 'overdue', 'auto_closed')
--    - post_event_realization_status ('realized', 'not_realized', 'unconfirmed')
--    - post_event_unrealized_reason
--    - post_event_closed_at
--    - post_event_closure_deadline (calculado en zona America/Argentina/Buenos_Aires + COALESCE(duration, 0) + 48h)
--    - post_event_closed_responsibly (true para cierres voluntarios del host)
--    - post_event_closure_type ('within_deadline', 'overdue', 'administrative_auto')
-- 2. Registro granular de presencia efectiva en public.participantes:
--    - attendance_status ('unmarked', 'attended', 'advance_notice_absent', 'reported_absent', 'unverified')
--    - attendance_recorded_at
--    - attendance_dispute_status ('none', 'pending_review', 'resolved_justified', 'resolved_unjustified', 'dismissed')
--    - attendance_dispute_id (enlace futuro con módulo de controversias)
-- 3. Invariantes de seguridad:
--    - Preservar semántica de encuentros cancelados (no generan segunda obligación incompatible).
--    - No reutilizar ni alterar encuentros.closed_at (perteneciente a Discovery).
--    - Bloqueo server-side en abrir_encuentro_seguro ante cierres vencidos (>48h).
--    - Regularización administrativa neutral para encuentros sin participantes confirmados.
--    - Tabla de auditoría mínima: public.encuentro_post_event_closure_audit.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. MODIFICACIÓN DE ESQUEMA EN public.encuentros
-- ------------------------------------------------------------------------------

ALTER TABLE public.encuentros
    ADD COLUMN IF NOT EXISTS post_event_closure_status TEXT NOT NULL DEFAULT 'not_applicable',
    ADD COLUMN IF NOT EXISTS post_event_realization_status TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS post_event_unrealized_reason TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS post_event_closed_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS post_event_closure_deadline TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS post_event_closed_responsibly BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS post_event_closure_type TEXT DEFAULT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_encuentros_post_event_closure_status'
    ) THEN
        ALTER TABLE public.encuentros
            ADD CONSTRAINT check_encuentros_post_event_closure_status
            CHECK (post_event_closure_status IN ('not_applicable', 'pending', 'completed', 'overdue', 'auto_closed'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_encuentros_post_event_realization_status'
    ) THEN
        ALTER TABLE public.encuentros
            ADD CONSTRAINT check_encuentros_post_event_realization_status
            CHECK (post_event_realization_status IS NULL OR post_event_realization_status IN ('realized', 'not_realized', 'unconfirmed'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_encuentros_post_event_closure_type'
    ) THEN
        ALTER TABLE public.encuentros
            ADD CONSTRAINT check_encuentros_post_event_closure_type
            CHECK (post_event_closure_type IS NULL OR post_event_closure_type IN ('within_deadline', 'overdue', 'administrative_auto'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_encuentros_host_post_event_closure
    ON public.encuentros(host_id, post_event_closure_status, post_event_closure_deadline)
    WHERE estado = 'activo' AND opened_at IS NOT NULL;


-- ------------------------------------------------------------------------------
-- 2. MODIFICACIÓN DE ESQUEMA EN public.participantes
-- ------------------------------------------------------------------------------

ALTER TABLE public.participantes
    ADD COLUMN IF NOT EXISTS attendance_status TEXT NOT NULL DEFAULT 'unmarked',
    ADD COLUMN IF NOT EXISTS attendance_recorded_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS attendance_notes TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS attendance_dispute_status TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS attendance_dispute_id UUID DEFAULT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_participantes_attendance_status'
    ) THEN
        ALTER TABLE public.participantes
            ADD CONSTRAINT check_participantes_attendance_status
            CHECK (attendance_status IN ('unmarked', 'attended', 'advance_notice_absent', 'reported_absent', 'unverified'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_participantes_attendance_dispute_status'
    ) THEN
        ALTER TABLE public.participantes
            ADD CONSTRAINT check_participantes_attendance_dispute_status
            CHECK (attendance_dispute_status IS NULL OR attendance_dispute_status IN ('none', 'pending_review', 'resolved_justified', 'resolved_unjustified', 'dismissed'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_participantes_attendance
    ON public.participantes(encuentro_id, attendance_status);

CREATE INDEX IF NOT EXISTS idx_participantes_user_attendance
    ON public.participantes(user_id, attendance_status)
    WHERE user_id IS NOT NULL;


-- ------------------------------------------------------------------------------
-- 3. TABLA DE AUDITORÍA: public.encuentro_post_event_closure_audit
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.encuentro_post_event_closure_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    host_id UUID NOT NULL,
    previous_closure_status TEXT,
    new_closure_status TEXT,
    realization_status TEXT,
    unrealized_reason TEXT,
    closure_type TEXT,
    closed_responsibly BOOLEAN,
    attendees_count INT DEFAULT 0,
    reported_absent_count INT DEFAULT 0,
    advance_notice_absent_count INT DEFAULT 0,
    unverified_count INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.encuentro_post_event_closure_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.encuentro_post_event_closure_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.encuentro_post_event_closure_audit TO postgres, service_role;


-- ------------------------------------------------------------------------------
-- 4. FUNCIÓN HELPER: calcular_vencimiento_cierre_encuentro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.calcular_vencimiento_cierre_encuentro(
    p_fecha DATE,
    p_hora TIME,
    p_duration_minutes INT DEFAULT NULL
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    v_start TIMESTAMPTZ;
    v_end TIMESTAMPTZ;
BEGIN
    IF p_fecha IS NULL OR p_hora IS NULL THEN
        RETURN NULL;
    END IF;

    -- Timestamp en zona horaria oficial del evento
    v_start := ((p_fecha::text || ' ' || p_hora::text)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires';
    
    IF p_duration_minutes IS NOT NULL AND p_duration_minutes > 0 THEN
        v_end := v_start + (p_duration_minutes * INTERVAL '1 minute');
    ELSE
        v_end := v_start;
    END IF;

    -- Plazo de gracia de 48 horas desde la finalización prevista (o inicio si no hay duración)
    RETURN v_end + INTERVAL '48 hours';
END;
$$;

REVOKE ALL ON FUNCTION public.calcular_vencimiento_cierre_encuentro(DATE, TIME, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calcular_vencimiento_cierre_encuentro(DATE, TIME, INT) TO anon, authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 5. RPC: cerrar_encuentro_post_evento_seguro
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

    -- 3. Procesar según resultado informado
    IF p_realization_status = 'unconfirmed' THEN
        -- El host declara provisionalmente que no puede confirmarlo todavía
        IF v_now <= v_deadline THEN
            v_new_status := 'pending';
        ELSE
            v_new_status := 'overdue';
        END IF;
        v_closed_responsibly := false;
        v_closure_type := NULL;
    ELSIF p_realization_status = 'not_realized' THEN
        -- El encuentro no se realizó: cierre voluntario responsable con motivo
        v_new_status := 'completed';
        v_closed_responsibly := true;

        -- No marcar inasistencias a los participantes ya que el encuentro no tuvo lugar
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
                    -- Bloquear y validar participante
                    SELECT * INTO v_part_row
                    FROM public.participantes
                    WHERE id = v_part_id AND encuentro_id = p_encuentro_id
                    FOR UPDATE;

                    IF FOUND THEN
                        -- Preservar historial: Si el participante ya había cancelado / desistido previamente,
                        -- no sobreescribir su estado histórico a asistió.
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
-- 6. RPC: get_detalle_cierre_post_evento_seguro
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


-- ------------------------------------------------------------------------------
-- 7. RPC: get_cierres_pendientes_host_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_cierres_pendientes_host_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_result JSON;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    SELECT COALESCE(
        pg_catalog.json_agg(
            pg_catalog.json_build_object(
                'id', e.id,
                'titulo', e.titulo,
                'open_public_title', e.open_public_title,
                'fecha', e.fecha,
                'hora', e.hora,
                'duration_minutes', e.duration_minutes,
                'closure_deadline', COALESCE(e.post_event_closure_deadline, public.calcular_vencimiento_cierre_encuentro(e.fecha, e.hora, e.duration_minutes)),
                'is_overdue', (v_now > COALESCE(e.post_event_closure_deadline, public.calcular_vencimiento_cierre_encuentro(e.fecha, e.hora, e.duration_minutes))),
                'post_event_closure_status', e.post_event_closure_status,
                'confirmed_count', (
                    SELECT COALESCE(pg_catalog.sum(p.seat_count), 0)::int
                    FROM public.participantes p
                    WHERE p.encuentro_id = e.id AND p.estado IN ('confirmado', 'asistio')
                )
            ) ORDER BY e.fecha ASC, e.hora ASC
        ),
        '[]'::json
    ) INTO v_result
    FROM public.encuentros e
    WHERE e.host_id = v_user_id
      AND e.estado = 'activo'
      AND e.opened_at IS NOT NULL
      AND e.post_event_closure_status IN ('pending', 'overdue')
      AND v_now >= (((e.fecha::text || ' ' || e.hora::text)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires');

    RETURN pg_catalog.json_build_object('ok', true, 'pending_closures', v_result);
END;
$$;

REVOKE ALL ON FUNCTION public.get_cierres_pendientes_host_seguro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cierres_pendientes_host_seguro() TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 8. RPC: regularizar_cierres_administrativos_automaticos
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
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_count INT := 0;
    v_rec RECORD;
BEGIN
    -- Busca encuentros abiertos pasados de fecha límite de gracia sin ningún participante confirmado
    FOR v_rec IN
        SELECT e.id, e.host_id, e.post_event_closure_status
        FROM public.encuentros e
        WHERE e.estado = 'activo'
          AND e.opened_at IS NOT NULL
          AND e.post_event_closure_status IN ('pending', 'overdue')
          AND v_now > COALESCE(e.post_event_closure_deadline, public.calcular_vencimiento_cierre_encuentro(e.fecha, e.hora, e.duration_minutes))
          AND (p_host_id IS NULL OR e.host_id = p_host_id)
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

REVOKE ALL ON FUNCTION public.regularizar_cierres_administrativos_automaticos(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.regularizar_cierres_administrativos_automaticos(UUID) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 9. ACTUALIZACIÓN DE abrir_encuentro_seguro (COMPUERTA SERVER-SIDE DE PUBLICACIÓN)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT DEFAULT NULL,
    p_open_public_zone TEXT DEFAULT NULL,
    p_open_public_title TEXT DEFAULT NULL,
    p_allow_multi_seat_requests BOOLEAN DEFAULT false,
    p_max_seats_per_request INT DEFAULT 1,
    p_min_seats_per_request INT DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro RECORD;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_was_open BOOLEAN;
    v_eval RECORD;
    v_loc_record RECORD;
    v_final_public_zone TEXT;
    v_final_locality_id TEXT;
    v_final_public_title TEXT;
    v_confirmed_seats INT := 0;
    v_final_multi_seat BOOLEAN := false;
    v_final_max_seats INT := 1;
    v_final_min_seats INT := 1;
    v_pending_enc_id UUID;
    v_pending_enc_title TEXT;
    v_new_deadline TIMESTAMPTZ;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_user_id <> p_host_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_active');
    END IF;

    -- =========================================================================
    -- COMPUERTA OBLIGATORIA: Regularización y verificación de cierres pendientes
    -- =========================================================================
    -- 1. Regularizar administrativamente de forma automática cualquier encuentro
    --    anterior sin participantes confirmados que haya vencido su plazo de 48h.
    PERFORM public.regularizar_cierres_administrativos_automaticos(v_user_id);

    -- 2. Verificar si el organizador adeuda cierres vencidos de encuentros con participantes
    SELECT e.id, COALESCE(e.open_public_title, e.titulo, 'Encuentro')
    INTO v_pending_enc_id, v_pending_enc_title
    FROM public.encuentros e
    WHERE e.host_id = v_user_id
      AND e.id <> p_encuentro_id
      AND e.opened_at IS NOT NULL
      AND e.estado = 'activo'
      AND e.post_event_closure_status IN ('pending', 'overdue')
      AND pg_catalog.now() > COALESCE(e.post_event_closure_deadline, public.calcular_vencimiento_cierre_encuentro(e.fecha, e.hora, e.duration_minutes))
      AND EXISTS (
          SELECT 1 FROM public.participantes p
          WHERE p.encuentro_id = e.id AND p.estado IN ('confirmado', 'asistio')
      )
    ORDER BY e.fecha ASC, e.hora ASC
    LIMIT 1;

    IF v_pending_enc_id IS NOT NULL THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'pending_closure_required',
            'message', 'Tenés al menos un encuentro abierto anterior pendiente de cierre posterior.',
            'pending_encuentro_id', v_pending_enc_id,
            'pending_encuentro_title', v_pending_enc_title
        );
    END IF;

    -- Validar cupo
    IF p_max_participants IS NULL OR p_max_participants < 1 OR p_max_participants > 40 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_slots');
    END IF;

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    IF p_max_participants < v_confirmed_seats THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    -- Validar multi-seat
    IF COALESCE(p_allow_multi_seat_requests, false) THEN
        v_final_multi_seat := true;
        IF p_max_seats_per_request IS NULL OR p_max_seats_per_request < 2 OR p_max_seats_per_request > p_max_participants THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_max_seats_per_request');
        END IF;
        v_final_max_seats := p_max_seats_per_request;

        v_final_min_seats := COALESCE(p_min_seats_per_request, 1);
        IF v_final_min_seats < 1 OR v_final_min_seats > v_final_max_seats THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_min_seats_per_request');
        END IF;
    ELSE
        v_final_multi_seat := false;
        v_final_max_seats := 1;
        v_final_min_seats := 1;
    END IF;

    -- Resolver título público
    IF p_open_public_title IS NOT NULL AND pg_catalog.btrim(p_open_public_title) <> '' THEN
        v_final_public_title := pg_catalog.btrim(p_open_public_title);
    ELSIF v_encuentro.open_public_title IS NOT NULL AND pg_catalog.btrim(v_encuentro.open_public_title) <> '' THEN
        v_final_public_title := pg_catalog.btrim(v_encuentro.open_public_title);
    ELSE
        v_final_public_title := pg_catalog.btrim(v_encuentro.titulo);
    END IF;

    IF pg_catalog.length(v_final_public_title) < 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_short');
    END IF;
    IF pg_catalog.length(v_final_public_title) > 80 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_long');
    END IF;

    -- Validar logística privada preexistente
    IF v_encuentro.modalidad = 'presencial' THEN
        IF v_encuentro.lugar_texto IS NULL OR pg_catalog.btrim(v_encuentro.lugar_texto) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'private_location_required');
        END IF;
    ELSIF v_encuentro.modalidad = 'virtual' THEN
        IF v_encuentro.link_virtual IS NULL OR pg_catalog.btrim(v_encuentro.link_virtual) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'virtual_link_required');
        END IF;
    END IF;

    -- Resolver localidad y zona según modalidad
    IF v_encuentro.modalidad = 'virtual' THEN
        v_final_locality_id := NULL;
        v_final_public_zone := 'Online';
    ELSE
        v_final_locality_id := p_locality_id;
        v_final_public_zone := NULLIF(pg_catalog.btrim(p_open_public_zone), '');

        IF v_final_locality_id IS NULL AND v_final_public_zone IS NULL THEN
            IF v_encuentro.locality_id IS NOT NULL THEN
                v_final_locality_id := v_encuentro.locality_id;
                v_final_public_zone := v_encuentro.open_public_zone;
            ELSE
                v_final_locality_id := 'guemes';
            END IF;
        END IF;

        IF v_final_locality_id IS NOT NULL AND v_final_public_zone IS NULL THEN
            SELECT * INTO v_loc_record FROM public.localidades WHERE id = v_final_locality_id AND activo = true;
            IF FOUND THEN
                v_final_public_zone := v_loc_record.nombre;
            ELSE
                v_final_locality_id := 'guemes';
                v_final_public_zone := 'Güemes';
            END IF;
        END IF;
    END IF;

    v_was_open := COALESCE(v_encuentro.is_open, false);
    v_new_deadline := public.calcular_vencimiento_cierre_encuentro(v_encuentro.fecha, v_encuentro.hora, v_encuentro.duration_minutes);

    -- EVALUACIÓN DETERMINISTA SERVER-SIDE (Estricta privacidad: solo campos públicos)
    SELECT * INTO v_eval FROM public.evaluar_contenido_publico_determinista(
        v_final_public_title,
        p_open_description
    );

    -- CASO 1: BLOQUEO DETERMINISTA INMEDIATO (CHOKE POINT)
    IF v_eval.decision = 'block' THEN
        UPDATE public.encuentros
        SET moderation_status = 'rejected',
            moderation_reason = v_eval.reason,
            moderated_at = v_now,
            moderation_decision_source = 'deterministic',
            moderation_categories = v_eval.categories,
            open_public_title = v_final_public_title,
            open_description = p_open_description,
            is_open = false,
            closed_at = CASE WHEN v_was_open THEN v_now ELSE closed_at END,
            max_participants = p_max_participants,
            allow_multi_seat_requests = v_final_multi_seat,
            max_seats_per_request = v_final_max_seats,
            min_seats_per_request = v_final_min_seats,
            locality_id = v_final_locality_id,
            open_public_zone = v_final_public_zone,
            post_event_closure_status = 'pending',
            post_event_closure_deadline = v_new_deadline
        WHERE id = p_encuentro_id;

        INSERT INTO public.public_content_moderation_audit (
            encuentro_id, moderator_id, action, previous_status, new_status,
            reason, categories, source, metadata
        ) VALUES (
            p_encuentro_id, v_user_id, 'deterministic_block', v_encuentro.moderation_status, 'rejected',
            v_eval.reason, v_eval.categories, 'deterministic',
            pg_catalog.jsonb_build_object('title', v_final_public_title, 'open_description', p_open_description)
        );

        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'content_moderation_blocked',
            'moderation_status', 'rejected',
            'reason', v_eval.reason,
            'message', 'El contenido no cumple las normas de seguridad comunitaria.'
        );
    END IF;

    -- CASO 2: NO BLOQUEADO -> Deja en review_pending e is_open = false para resolución de pipeline
    UPDATE public.encuentros
    SET is_open = false,
        open_public_title = v_final_public_title,
        open_description = p_open_description,
        max_participants = p_max_participants,
        allow_multi_seat_requests = v_final_multi_seat,
        max_seats_per_request = v_final_max_seats,
        min_seats_per_request = v_final_min_seats,
        locality_id = v_final_locality_id,
        open_public_zone = v_final_public_zone,
        moderation_status = 'review_pending',
        moderated_at = NULL,
        moderation_reason = v_eval.reason,
        moderation_categories = v_eval.categories,
        opened_at = COALESCE(v_encuentro.opened_at, v_now),
        post_event_closure_status = 'pending',
        post_event_closure_deadline = v_new_deadline
    WHERE id = p_encuentro_id;

    INSERT INTO public.public_content_moderation_audit (
        encuentro_id, moderator_id, action, previous_status, new_status,
        reason, categories, source, metadata
    ) VALUES (
        p_encuentro_id, v_user_id, 'publish_requested', v_encuentro.moderation_status, 'review_pending',
        v_eval.reason, v_eval.categories, 'user_request',
        pg_catalog.jsonb_build_object('title', v_final_public_title, 'open_description', p_open_description)
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'is_open', false,
        'moderation_status', 'review_pending',
        'open_public_title', v_final_public_title,
        'max_participants', p_max_participants,
        'allow_multi_seat_requests', v_final_multi_seat,
        'max_seats_per_request', v_final_max_seats,
        'min_seats_per_request', v_final_min_seats,
        'locality_id', v_final_locality_id,
        'open_public_zone', v_final_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, INT) TO authenticated, postgres, service_role;


-- ------------------------------------------------------------------------------
-- 10. RECALCULAR PLAZO ANTE REPROGRAMACIÓN EN actualizar_encuentro_seguro
-- ------------------------------------------------------------------------------

-- Si el anfitrión reprograma la fecha o la hora, actualizamos post_event_closure_deadline
-- para garantizar que el nuevo plazo refleje con precisión la nueva fecha.
CREATE OR REPLACE FUNCTION public.trg_actualizar_closure_deadline_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF (NEW.fecha IS DISTINCT FROM OLD.fecha) OR (NEW.hora IS DISTINCT FROM OLD.hora) OR (NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes) THEN
        IF NEW.opened_at IS NOT NULL THEN
            NEW.post_event_closure_deadline := public.calcular_vencimiento_cierre_encuentro(NEW.fecha, NEW.hora, NEW.duration_minutes);
        END IF;
    END IF;

    -- Si se cancela el encuentro, anular la obligación de cierre posterior
    IF NEW.estado = 'cancelado' AND OLD.estado <> 'cancelado' THEN
        NEW.post_event_closure_status := 'not_applicable';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_actualizar_closure_deadline ON public.encuentros;
CREATE TRIGGER trg_actualizar_closure_deadline
    BEFORE UPDATE ON public.encuentros
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_actualizar_closure_deadline_fn();


-- ------------------------------------------------------------------------------
-- 11. BACKFILL SEGURO PARA ENCUENTROS EXISTENTES
-- ------------------------------------------------------------------------------

-- Encuentros abiertos activos preexistentes
UPDATE public.encuentros
SET post_event_closure_status = 'pending',
    post_event_closure_deadline = public.calcular_vencimiento_cierre_encuentro(fecha, hora, duration_minutes)
WHERE opened_at IS NOT NULL
  AND estado = 'activo'
  AND post_event_closure_status = 'not_applicable';

-- Auto-cerrar administrativamente aquellos preexistentes ya pasados sin participantes
UPDATE public.encuentros e
SET post_event_closure_status = 'auto_closed',
    post_event_closure_type = 'administrative_auto',
    post_event_closed_responsibly = false,
    post_event_realization_status = 'unconfirmed',
    post_event_closed_at = pg_catalog.now()
WHERE e.opened_at IS NOT NULL
  AND e.estado = 'activo'
  AND e.post_event_closure_status = 'pending'
  AND pg_catalog.now() > COALESCE(e.post_event_closure_deadline, public.calcular_vencimiento_cierre_encuentro(e.fecha, e.hora, e.duration_minutes))
  AND NOT EXISTS (
      SELECT 1 FROM public.participantes p
      WHERE p.encuentro_id = e.id AND p.estado IN ('confirmado', 'asistio')
  );


-- ------------------------------------------------------------------------------
-- 12. ACTUALIZACIÓN DE get_detalle_host_seguro (PROYECCIÓN DE CIERRE POSTERIOR)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_detalle_host_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats INT := 0;
    v_confirmed_requests INT := 0;
    v_pending_requests INT := 0;
    v_has_affected BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('error', 'unauthorized');
    END IF;

    SELECT
        COALESCE(pg_catalog.sum(seat_count), 0)::int,
        pg_catalog.count(*)::int
    INTO
        v_confirmed_seats,
        v_confirmed_requests
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    SELECT pg_catalog.count(*)::int
    INTO v_pending_requests
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id AND estado = 'pending';

    -- Regla canónica de usuarios afectados
    v_has_affected := (
        EXISTS (
            SELECT 1 FROM public.participantes
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_user_id
        ) OR v_pending_requests > 0
    );

    RETURN pg_catalog.json_build_object(
        'id', v_encuentro.id,
        'titulo', v_encuentro.titulo,
        'open_public_title', v_encuentro.open_public_title,
        'descripcion', v_encuentro.descripcion,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'lugar_texto', v_encuentro.lugar_texto,
        'link_virtual', v_encuentro.link_virtual,
        'tipo_invitacion', v_encuentro.tipo_invitacion,
        'host_id', v_encuentro.host_id,
        'public_token', v_encuentro.public_token,
        'estado', v_encuentro.estado,
        'tema', v_encuentro.tema,
        'tema_invitacion', COALESCE(v_encuentro.tema_invitacion, 'classic'),
        'invitation_template', v_encuentro.invitation_template,
        'reemplaza_a', v_encuentro.reemplaza_a,
        'creado_en', v_encuentro.creado_en,
        'is_open', COALESCE(v_encuentro.is_open, false),
        'open_description', v_encuentro.open_description,
        'max_participants', v_encuentro.max_participants,
        'public_capacity', v_encuentro.max_participants,
        'allow_multi_seat_requests', COALESCE(v_encuentro.allow_multi_seat_requests, false),
        'max_seats_per_request', COALESCE(v_encuentro.max_seats_per_request, 1),
        'min_seats_per_request', COALESCE(v_encuentro.min_seats_per_request, 1),
        'min_participants', v_encuentro.min_participants,
        'realization_status', COALESCE(v_encuentro.realization_status, 'pending'),
        'inscriptions_closed', COALESCE(v_encuentro.inscriptions_closed, false),
        'inscriptions_closed_at', v_encuentro.inscriptions_closed_at,
        'cancelled_at', v_encuentro.cancelled_at,
        'cancelled_by', v_encuentro.cancelled_by,
        'cancellation_reason', v_encuentro.cancellation_reason,
        'confirmed_seats', v_confirmed_seats,
        'confirmed_requests', v_confirmed_requests,
        'pending_requests_count', v_pending_requests,
        'has_affected_users', v_has_affected,
        'available_slots', GREATEST(0, COALESCE(v_encuentro.max_participants, 0) - v_confirmed_seats),
        'locality_id', v_encuentro.locality_id,
        'open_public_zone', v_encuentro.open_public_zone,
        'opened_at', v_encuentro.opened_at,
        'closed_at', v_encuentro.closed_at,
        'moderation_status', v_encuentro.moderation_status,
        'post_event_closure_status', COALESCE(v_encuentro.post_event_closure_status, 'not_applicable'),
        'post_event_realization_status', v_encuentro.post_event_realization_status,
        'post_event_unrealized_reason', v_encuentro.post_event_unrealized_reason,
        'post_event_closed_at', v_encuentro.post_event_closed_at,
        'post_event_closure_deadline', COALESCE(v_encuentro.post_event_closure_deadline, public.calcular_vencimiento_cierre_encuentro(v_encuentro.fecha, v_encuentro.hora, v_encuentro.duration_minutes)),
        'post_event_closed_responsibly', COALESCE(v_encuentro.post_event_closed_responsibly, false),
        'post_event_closure_type', v_encuentro.post_event_closure_type
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) TO authenticated, postgres, service_role;

COMMIT;

