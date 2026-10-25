-- ==============================================================================
-- Migración: 20261025110000_open_encounters_reminders_and_absence_prevention_v1.sql
-- Módulo: Mini-Sprint E — Recordatorios 24 h / 2 h y Prevención de Inasistencias
--
-- Componentes:
--   1. Tabla durable public.encounter_reminders_log para deduplicación, idempotencia y auditoría.
--   2. Función public.is_user_in_quiet_hours para respeto de horarios de descanso en zona horaria de Buenos Aires.
--   3. Actualización de trigger_enqueue_web_push_deliveries para supresión push en horarios silenciosos y payload genérico en pantalla bloqueada.
--   4. Trigger trg_encuentros_reschedule_or_cancel_reminders para invalidar recordatorios obsoletos ante reprogramación o cancelación.
--   5. RPC durable public.procesar_recordatorios_encuentros_abiertos_seguro con advisory lock, orden canónico y control de anticipación.
--   6. RPC de consulta segura public.get_recordatorios_encuentro_seguro.
--   7. Scheduling periódico con pg_cron si está disponible.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. TABLA DURABLE DE REGISTRO Y DEDUPLICACIÓN DE RECORDATORIOS
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.encounter_reminders_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reminder_type TEXT NOT NULL CHECK (reminder_type IN ('reminder_24h', 'reminder_2h')),
    scheduled_for_date DATE NOT NULL,
    scheduled_for_time TIME NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    inbox_notification_id UUID REFERENCES public.inbox_notifications(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'invalidated', 'suppressed_quiet_hours')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    CONSTRAINT uq_encounter_reminder_user_schedule UNIQUE (encuentro_id, user_id, reminder_type, scheduled_for_date, scheduled_for_time)
);

CREATE INDEX IF NOT EXISTS idx_encounter_reminders_enc_user 
    ON public.encounter_reminders_log (encuentro_id, user_id);

CREATE INDEX IF NOT EXISTS idx_encounter_reminders_status 
    ON public.encounter_reminders_log (status);

CREATE INDEX IF NOT EXISTS idx_encounter_reminders_schedule 
    ON public.encounter_reminders_log (scheduled_for_date, scheduled_for_time);

ALTER TABLE public.encounter_reminders_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.encounter_reminders_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.encounter_reminders_log TO postgres, service_role;

DROP POLICY IF EXISTS p_select_own_reminders ON public.encounter_reminders_log;
CREATE POLICY p_select_own_reminders ON public.encounter_reminders_log
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id);


-- ==============================================================================
-- 2. EVALUACIÓN SERVER-SIDE DE HORARIOS SILENCIOSOS
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.is_user_in_quiet_hours(
    p_user_id UUID,
    p_check_time TIMESTAMPTZ DEFAULT pg_catalog.now()
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_meta JSONB;
    v_qh JSONB;
    v_enabled BOOLEAN;
    v_start TEXT;
    v_end TEXT;
    v_tz_time TIME;
    v_start_time TIME;
    v_end_time TIME;
BEGIN
    SELECT raw_user_meta_data INTO v_meta
    FROM auth.users
    WHERE id = p_user_id;

    IF v_meta IS NULL THEN
        RETURN false;
    END IF;

    v_qh := v_meta -> 'quiet_hours';
    IF v_qh IS NULL THEN
        RETURN false;
    END IF;

    v_enabled := COALESCE((v_qh ->> 'enabled')::boolean, false);
    IF NOT v_enabled THEN
        RETURN false;
    END IF;

    v_start := COALESCE(v_qh ->> 'startTime', '22:00');
    v_end := COALESCE(v_qh ->> 'endTime', '08:00');

    -- Extraer la hora local canónica de Argentina ('America/Argentina/Buenos_Aires')
    v_tz_time := (p_check_time AT TIME ZONE 'America/Argentina/Buenos_Aires')::time;
    v_start_time := v_start::time;
    v_end_time := v_end::time;

    IF v_start_time = v_end_time THEN
        RETURN false;
    END IF;

    IF v_start_time < v_end_time THEN
        RETURN v_tz_time >= v_start_time AND v_tz_time < v_end_time;
    ELSE
        RETURN v_tz_time >= v_start_time OR v_tz_time < v_end_time;
    END IF;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_user_in_quiet_hours(UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_user_in_quiet_hours(UUID, TIMESTAMPTZ) TO authenticated, postgres, service_role;


-- ==============================================================================
-- 3. ACTUALIZACIÓN DEL PIPELINE DE WEB PUSH PARA SUPRESIÓN Y PAYLOAD GENÉRICO
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.trigger_enqueue_web_push_deliveries()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Regla de Horarios Silenciosos y Supresión: si la notificación indica supresión push, no se encola en outbox
    IF COALESCE((NEW.payload ->> 'suppress_push')::boolean, false) THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.notification_delivery_outbox (
        inbox_notification_id,
        recipient_user_id,
        channel,
        web_push_subscription_id,
        status,
        dedup_key
    )
    SELECT
        NEW.id,
        NEW.recipient_user_id,
        'web_push',
        s.id,
        'pending',
        NEW.id || ':' || s.id || ':web_push'
    FROM public.web_push_subscriptions s
    WHERE s.user_id = NEW.recipient_user_id
      AND s.status = 'active'
    ON CONFLICT (dedup_key) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_web_push_deliveries ON public.inbox_notifications;
CREATE TRIGGER trg_enqueue_web_push_deliveries
    AFTER INSERT ON public.inbox_notifications
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_enqueue_web_push_deliveries();


-- ==============================================================================
-- 4. INVALIDACIÓN DE RECORDATORIOS ANTE REPROGRAMACIÓN O CANCELACIÓN
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.trigger_encuentros_reschedule_or_cancel_reminders()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
    -- Caso 1: Reprogramación de fecha u hora
    IF (OLD.fecha IS DISTINCT FROM NEW.fecha OR OLD.hora IS DISTINCT FROM NEW.hora) THEN
        -- Invalidar registros en log para la fecha/hora anterior
        UPDATE public.encounter_reminders_log
        SET status = 'invalidated',
            metadata = metadata || jsonb_build_object('invalidated_reason', 'rescheduled', 'invalidated_at', v_now, 'new_date', NEW.fecha, 'new_time', NEW.hora)
        WHERE encuentro_id = NEW.id
          AND scheduled_for_date = OLD.fecha
          AND scheduled_for_time = OLD.hora;

        -- Expirar notificaciones de recordatorio en Inbox correspondientes a la fecha antigua
        UPDATE public.inbox_notifications
        SET expires_at = v_now
        WHERE target_type = 'encounter'
          AND target_id = NEW.id
          AND notification_type IN ('encounter_reminder_24h', 'encounter_reminder_2h');

        -- Cancelar entregas Web Push pendientes asociadas al recordatorio obsoleto
        UPDATE public.notification_delivery_outbox d
        SET status = 'cancelled',
            last_error = 'Encounter rescheduled to new date/time',
            updated_at = v_now
        FROM public.inbox_notifications i
        WHERE i.id = d.inbox_notification_id
          AND i.target_type = 'encounter'
          AND i.target_id = NEW.id
          AND i.notification_type IN ('encounter_reminder_24h', 'encounter_reminder_2h')
          AND d.status IN ('pending', 'processing');
    END IF;

    -- Caso 2: Cancelación del encuentro
    IF NEW.estado = 'cancelado' AND OLD.estado <> 'cancelado' THEN
        -- Invalidar todos los recordatorios activos del encuentro
        UPDATE public.encounter_reminders_log
        SET status = 'invalidated',
            metadata = metadata || jsonb_build_object('invalidated_reason', 'cancelled', 'invalidated_at', v_now)
        WHERE encuentro_id = NEW.id;

        -- Cancelar entregas Web Push pendientes de recordatorios
        UPDATE public.notification_delivery_outbox d
        SET status = 'cancelled',
            last_error = 'Encounter cancelled',
            updated_at = v_now
        FROM public.inbox_notifications i
        WHERE i.id = d.inbox_notification_id
          AND i.target_type = 'encounter'
          AND i.target_id = NEW.id
          AND i.notification_type IN ('encounter_reminder_24h', 'encounter_reminder_2h')
          AND d.status IN ('pending', 'processing');
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_encuentros_reschedule_or_cancel_reminders ON public.encuentros;
CREATE TRIGGER trg_encuentros_reschedule_or_cancel_reminders
    AFTER UPDATE OF fecha, hora, estado ON public.encuentros
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_encuentros_reschedule_or_cancel_reminders();


-- ==============================================================================
-- 5. RPC DURABLE: PROCESAMIENTO DE RECORDATORIOS (24h Y 2h)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.procesar_recordatorios_encuentros_abiertos_seguro(
    p_worker_id TEXT DEFAULT 'reminder-worker'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_locked BOOLEAN;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_reminders_24h_sent INT := 0;
    v_reminders_2h_sent INT := 0;
    v_skipped INT := 0;
    v_suppressed_quiet INT := 0;

    v_encuentro RECORD;
    v_part RECORD;
    v_reminder_type TEXT;
    v_time_to_event INTERVAL;
    v_event_starts_at TIMESTAMPTZ;
    v_is_quiet BOOLEAN;
    v_inbox_id UUID;
    v_title TEXT;
    v_body TEXT;
    v_generic_push_title TEXT;
    v_generic_push_body TEXT;
    v_dedup_key TEXT;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- 1. Protección de concurrencia: Advisory Transaction Lock
    SELECT pg_try_advisory_xact_lock(hashtext('procesar_recordatorios_encuentros_abiertos')) INTO v_locked;
    IF NOT v_locked THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'status', 'locked',
            'message', 'Proceso concurrente en ejecución, omitiendo ejecución simultánea.'
        );
    END IF;

    -- 2. Iterar sobre encuentros abiertos activos cuya realización ocurra en las próximas 26 horas
    FOR v_encuentro IN
        SELECT e.id,
               e.host_id,
               e.titulo,
               e.open_public_title,
               e.modalidad,
               e.fecha,
               e.hora,
               e.duration_minutes,
               e.created_at AS enc_created_at,
               e.opened_at,
               ((e.fecha::text || ' ' || e.hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') AS event_starts_at
        FROM public.encuentros e
        WHERE e.is_open = true
          AND e.estado = 'activo'
          AND e.fecha IS NOT NULL
          AND e.hora IS NOT NULL
          AND ((e.fecha::text || ' ' || e.hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') > v_now
          AND ((e.fecha::text || ' ' || e.hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') <= v_now + INTERVAL '26 hours'
        ORDER BY e.fecha ASC, e.hora ASC, e.id ASC
    LOOP
        v_event_starts_at := v_encuentro.event_starts_at;
        v_time_to_event := v_event_starts_at - v_now;

        -- 3. Determinar qué recordatorio corresponde según ventanas y tiempo de anticipación de creación
        v_reminder_type := NULL;

        -- Ventana 24h: entre 25h y 20h antes del evento
        IF v_time_to_event <= INTERVAL '25 hours' AND v_time_to_event >= INTERVAL '20 hours' THEN
            -- Invariante 9: El evento NO debe haber sido creado con menos de 24 h de anticipación
            IF v_encuentro.enc_created_at <= (v_event_starts_at - INTERVAL '23 hours 30 minutes') THEN
                v_reminder_type := 'reminder_24h';
            ELSE
                v_skipped := v_skipped + 1;
            END IF;
        -- Ventana 2h: entre 2h 15m y 15m antes del evento
        ELSIF v_time_to_event <= INTERVAL '2 hours 15 minutes' AND v_time_to_event >= INTERVAL '15 minutes' THEN
            -- Invariante 10: El evento NO debe haber sido creado con menos de 2 h de anticipación
            IF v_encuentro.enc_created_at <= (v_event_starts_at - INTERVAL '1 hour 45 minutes') THEN
                v_reminder_type := 'reminder_2h';
            ELSE
                v_skipped := v_skipped + 1;
            END IF;
        END IF;

        IF v_reminder_type IS NULL THEN
            CONTINUE;
        END IF;

        -- 4. Iterar sobre participantes confirmados y vigentes (excluyendo acompañantes sin cuenta y host)
        FOR v_part IN
            SELECT p.id AS participante_id,
                   p.user_id,
                   p.creado_en AS part_creado_en,
                   p.seat_count,
                   p.reconfirmation_status
            FROM public.participantes p
            WHERE p.encuentro_id = v_encuentro.id
              AND p.estado = 'confirmado'
              AND p.user_id IS NOT NULL
              AND p.user_id <> v_encuentro.host_id
              AND p.reconfirmation_status IS DISTINCT FROM 'declined'
              AND (
                  -- Procedencia en Encuentros Abiertos
                  p.creado_en >= v_encuentro.opened_at
                  OR p.admission_source = 'post_open_generic'
                  OR EXISTS (
                      SELECT 1 FROM public.solicitudes_encuentro_abierto s
                      WHERE s.participante_id = p.id AND s.estado = 'approved'
                  )
              )
              -- Invariante 3: No duplicación de aviso previamente enviado
              AND NOT EXISTS (
                  SELECT 1 FROM public.encounter_reminders_log r
                  WHERE r.encuentro_id = v_encuentro.id
                    AND r.user_id = p.user_id
                    AND r.reminder_type = v_reminder_type
                    AND r.scheduled_for_date = v_encuentro.fecha
                    AND r.scheduled_for_time = v_encuentro.hora
                    AND r.status IN ('sent', 'suppressed_quiet_hours')
              )
        LOOP
            -- Invariante: Participación confirmada debe haber sido generada con debida anticipación a la ventana
            IF v_reminder_type = 'reminder_24h' AND v_part.part_creado_en > (v_event_starts_at - INTERVAL '20 hours') THEN
                v_skipped := v_skipped + 1;
                CONTINUE;
            END IF;

            IF v_reminder_type = 'reminder_2h' AND v_part.part_creado_en > (v_event_starts_at - INTERVAL '15 minutes') THEN
                v_skipped := v_skipped + 1;
                CONTINUE;
            END IF;

            -- Invariante 14: Verificación de Horarios Silenciosos del destinatario
            v_is_quiet := public.is_user_in_quiet_hours(v_part.user_id, v_now);

            -- Contenido de presentación: Inbox durable contextual + Web Push genérico en pantalla bloqueada
            IF v_reminder_type = 'reminder_24h' THEN
                v_title := 'Recordatorio: mañana es el encuentro';
                v_body := 'Mañana tenés el encuentro "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '". Podés revisar los detalles o avisar con anticipación si no podés asistir.';
                v_generic_push_title := 'Recordatorio de encuentro';
                v_generic_push_body := 'Mañana tenés un encuentro programado. Ingresá para ver detalles e instrucciones.';
            ELSE
                v_title := 'Recordatorio: tu encuentro comienza en 2 horas';
                v_body := 'Tu encuentro "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '" empieza en 2 horas. Verificá cómo llegar o las instrucciones de ingreso.';
                v_generic_push_title := 'Recordatorio de encuentro';
                v_generic_push_body := 'Tu encuentro comienza en 2 horas. Ingresá para ver ubicación e instrucciones.';
            END IF;

            v_dedup_key := 'reminder:' || v_reminder_type || ':' || v_encuentro.id || ':' || v_part.user_id || ':' || v_encuentro.fecha || '_' || v_encuentro.hora;
            v_expires_at := v_event_starts_at + (COALESCE(v_encuentro.duration_minutes, 120) || ' minutes')::interval + INTERVAL '24 hours';

            -- Insertar notificación durable en Inbox
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
                v_part.user_id,
                CASE WHEN v_reminder_type = 'reminder_24h' THEN 'encounter_reminder_24h' ELSE 'encounter_reminder_2h' END,
                'encounter',
                v_encuentro.id,
                '/meet/' || v_encuentro.id,
                v_title,
                v_body,
                pg_catalog.jsonb_build_object(
                    'encuentro_id', v_encuentro.id,
                    'reminder_type', v_reminder_type,
                    'fecha', v_encuentro.fecha,
                    'hora', v_encuentro.hora,
                    'modalidad', v_encuentro.modalidad,
                    'suppress_push', v_is_quiet,
                    'generic_push_title', v_generic_push_title,
                    'generic_push_body', v_generic_push_body,
                    'can_withdraw', true,
                    'withdrawal_route', '/solicitudes',
                    'detail_route', '/meet/' || v_encuentro.id
                ),
                v_dedup_key,
                v_expires_at
            )
            ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING
            RETURNING id INTO v_inbox_id;

            -- Registrar en tabla durable de log
            INSERT INTO public.encounter_reminders_log (
                encuentro_id,
                user_id,
                reminder_type,
                scheduled_for_date,
                scheduled_for_time,
                sent_at,
                inbox_notification_id,
                status,
                metadata
            ) VALUES (
                v_encuentro.id,
                v_part.user_id,
                v_reminder_type,
                v_encuentro.fecha,
                v_encuentro.hora,
                v_now,
                v_inbox_id,
                CASE WHEN v_is_quiet THEN 'suppressed_quiet_hours' ELSE 'sent' END,
                pg_catalog.jsonb_build_object(
                    'worker_id', p_worker_id,
                    'is_quiet_hours', v_is_quiet,
                    'seat_count', COALESCE(v_part.seat_count, 1)
                )
            )
            ON CONFLICT (encuentro_id, user_id, reminder_type, scheduled_for_date, scheduled_for_time) DO NOTHING;

            IF v_reminder_type = 'reminder_24h' THEN
                v_reminders_24h_sent := v_reminders_24h_sent + 1;
            ELSE
                v_reminders_2h_sent := v_reminders_2h_sent + 1;
            END IF;

            IF v_is_quiet THEN
                v_suppressed_quiet := v_suppressed_quiet + 1;
            END IF;
        END LOOP;
    END LOOP;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'reminders_24h_sent', v_reminders_24h_sent,
        'reminders_2h_sent', v_reminders_2h_sent,
        'suppressed_quiet_hours', v_suppressed_quiet,
        'skipped', v_skipped,
        'processed_at', v_now
    );
END;
$$;

REVOKE ALL ON FUNCTION public.procesar_recordatorios_encuentros_abiertos_seguro(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.procesar_recordatorios_encuentros_abiertos_seguro(TEXT) TO service_role;


-- ==============================================================================
-- 6. RPC DE CONSULTA DE ESTADO DE RECORDATORIOS PARA ANFITRIÓN O PARTICIPANTE
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.get_recordatorios_encuentro_seguro(
    p_encuentro_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_is_mod BOOLEAN := public.is_moderation_authorized();
    v_is_host BOOLEAN;
    v_is_participant BOOLEAN;
    v_reminders JSON;
BEGIN
    IF v_caller_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    SELECT (host_id = v_caller_id) INTO v_is_host
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    SELECT EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id AND user_id = v_caller_id
    ) INTO v_is_participant;

    IF NOT (COALESCE(v_is_host, false) OR COALESCE(v_is_participant, false) OR v_is_mod) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_is_host OR v_is_mod THEN
        -- Anfitrión o moderador ve el resumen global de recordatorios enviados para su encuentro
        SELECT COALESCE(pg_catalog.json_agg(
            pg_catalog.json_build_object(
                'id', r.id,
                'reminder_type', r.reminder_type,
                'sent_at', r.sent_at,
                'status', r.status,
                'scheduled_for_date', r.scheduled_for_date,
                'scheduled_for_time', r.scheduled_for_time
            ) ORDER BY r.sent_at DESC
        ), '[]'::json) INTO v_reminders
        FROM public.encounter_reminders_log r
        WHERE r.encuentro_id = p_encuentro_id;
    ELSE
        -- Participante solo ve los recordatorios emitidos para su propia identidad
        SELECT COALESCE(pg_catalog.json_agg(
            pg_catalog.json_build_object(
                'id', r.id,
                'reminder_type', r.reminder_type,
                'sent_at', r.sent_at,
                'status', r.status,
                'scheduled_for_date', r.scheduled_for_date,
                'scheduled_for_time', r.scheduled_for_time
            ) ORDER BY r.sent_at DESC
        ), '[]'::json) INTO v_reminders
        FROM public.encounter_reminders_log r
        WHERE r.encuentro_id = p_encuentro_id
          AND r.user_id = v_caller_id;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'reminders', v_reminders
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_recordatorios_encuentro_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_recordatorios_encuentro_seguro(UUID) TO authenticated, postgres, service_role;


-- ==============================================================================
-- 7. PROGRAMACIÓN DURABLE CON pg_cron
-- ==============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
        BEGIN
            PERFORM cron.unschedule('recordatorios_encuentros_abiertos_job');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        BEGIN
            -- Ejecutar cada 10 minutos para evaluar recordatorios 24h y 2h
            PERFORM cron.schedule(
                'recordatorios_encuentros_abiertos_job',
                '*/10 * * * *',
                'SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();'
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;
END;
$$;

COMMIT;
