-- ==============================================================================
-- Migración: 20261025110000_open_encounters_reminders_and_absence_prevention_v1.sql
-- Módulo: Mini-Sprint E — Recordatorios 24 h / 2 h y Prevención de Inasistencias
--
-- Componentes:
--   1. Tabla durable public.encounter_reminders_log para deduplicación, idempotencia y auditoría.
--   2. Función public.is_user_in_quiet_hours para respeto de horarios de descanso en zona horaria de Buenos Aires.
--   3. Pipeline de Web Push protegido: supresión server-side en trigger_enqueue_web_push_deliveries
--      y doble verificación en claim_web_push_deliveries_seguro con excepción para avisos críticos.
--   4. Trigger trg_encuentros_reschedule_or_cancel_reminders para invalidar recordatorios obsoletos
--      ante reprogramación o cancelación, renovando dedup_key en inbox para permitir ciclos A -> B -> A.
--   5. RPC durable public.procesar_recordatorios_encuentros_abiertos_seguro con advisory lock,
--      diferenciación de enlaces por rol (/meet/:id para anfitrión y /solicitudes?open_encounter=:id para participante)
--      y control estricto de anticipación y finalización de evento.
--   6. RPC de consulta segura public.get_recordatorios_encuentro_seguro con estados detallados de inbox y push outbox.
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
-- 3. ACTUALIZACIÓN DEL PIPELINE DE WEB PUSH: ENCOLADO Y CLAIM CON SUPRESIÓN Y EXCEPCIONES CRÍTICAS
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.trigger_enqueue_web_push_deliveries()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_is_critical BOOLEAN;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
BEGIN
    -- Clasificación conservadora server-side de prioridad crítica
    v_is_critical := COALESCE(
        NEW.notification_type IN (
            'encounter_cancelled_for_participant',
            'open_encounter_request_cancelled_by_host'
        )
        OR (
            NEW.notification_type IN ('encounter_schedule_changed', 'encounter_logistics_changed')
            AND (
                COALESCE(NEW.payload->>'is_applicant', '') NOT IN ('true', 't', '1', 'yes')
            )
        )
        OR (COALESCE(NEW.payload->>'priority', '') = 'critical'),
        false
    );

    -- Regla de Horarios Silenciosos y Supresión:
    -- Si la notificación NO es crítica y:
    -- 1. Indica supresión push explícita en payload (suppress_push = true)
    -- 2. O el usuario destinatario se encuentra en horario silencioso en America/Argentina/Buenos_Aires
    -- En ambos casos, Inbox se guarda normalmente y Web Push se suprime server-side.
    IF NOT v_is_critical AND (
        COALESCE(NEW.payload->>'suppress_push', '') IN ('true', 't', '1', 'yes')
        OR public.is_user_in_quiet_hours(NEW.recipient_user_id, v_now)
    ) THEN
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


CREATE OR REPLACE FUNCTION public.claim_web_push_deliveries_seguro(
    p_batch_size INT DEFAULT 10,
    p_worker_id TEXT DEFAULT 'web-push-worker'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_limit INT := LEAST(GREATEST(COALESCE(p_batch_size, 10), 1), 100);
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_claimed_rows RECORD;
    v_result JSONB := '[]'::jsonb;
    v_is_critical BOOLEAN;
    v_urgency TEXT;
BEGIN
    -- 1. Seleccionar IDs candidatos bajo cerrojo SKIP LOCKED
    FOR v_claimed_rows IN
        SELECT
            d.id AS delivery_id,
            d.inbox_notification_id,
            d.recipient_user_id AS delivery_recipient_id,
            d.web_push_subscription_id,
            d.attempt_count,
            s.id AS sub_id,
            s.user_id AS sub_user_id,
            s.status AS sub_status,
            s.endpoint,
            s.p256dh_key,
            s.auth_key,
            i.recipient_user_id AS inbox_recipient_id,
            i.notification_type,
            i.payload,
            i.title,
            i.body,
            i.deep_link,
            i.expires_at AS inbox_expires_at,
            i.read_at AS inbox_read_at
        FROM public.notification_delivery_outbox d
        JOIN public.web_push_subscriptions s ON s.id = d.web_push_subscription_id
        JOIN public.inbox_notifications i ON i.id = d.inbox_notification_id
        WHERE d.status = 'pending'
          AND d.available_at <= v_now
        ORDER BY d.created_at ASC
        LIMIT v_limit
        FOR UPDATE OF d SKIP LOCKED
    LOOP
        -- Regla crítica de privacidad: dispositivo compartido / reasignado
        IF v_claimed_rows.sub_status <> 'active' 
           OR v_claimed_rows.sub_user_id <> v_claimed_rows.delivery_recipient_id 
           OR v_claimed_rows.inbox_recipient_id <> v_claimed_rows.delivery_recipient_id THEN
            UPDATE public.notification_delivery_outbox
            SET status = 'cancelled',
                last_error = 'Device or user reassigned / subscription inactive',
                updated_at = v_now
            WHERE id = v_claimed_rows.delivery_id;
            CONTINUE;
        END IF;

        -- Regla de expiración: el Push no debe sobrevivir al Inbox
        IF v_claimed_rows.inbox_expires_at <= v_now THEN
            UPDATE public.notification_delivery_outbox
            SET status = 'cancelled',
                last_error = 'Notification expired before push delivery',
                updated_at = v_now
            WHERE id = v_claimed_rows.delivery_id;
            CONTINUE;
        END IF;

        -- Regla de obsolescencia: si ya fue leída en la app, cancelar el Push
        IF v_claimed_rows.inbox_read_at IS NOT NULL THEN
            UPDATE public.notification_delivery_outbox
            SET status = 'cancelled',
                last_error = 'Notification already read in-app',
                updated_at = v_now
            WHERE id = v_claimed_rows.delivery_id;
            CONTINUE;
        END IF;

        -- Clasificación conservadora server-side de prioridad crítica:
        v_is_critical := COALESCE(
            v_claimed_rows.notification_type IN (
                'encounter_cancelled_for_participant',
                'open_encounter_request_cancelled_by_host'
            )
            OR (
                v_claimed_rows.notification_type IN ('encounter_schedule_changed', 'encounter_logistics_changed')
                AND (
                    COALESCE(v_claimed_rows.payload->>'is_applicant', '') NOT IN ('true', 't', '1', 'yes')
                )
            )
            OR (COALESCE(v_claimed_rows.payload->>'priority', '') = 'critical'),
            false
        );

        -- Regla de Horarios Silenciosos / Supresión Push en Claim:
        -- Si la notificación NO es crítica y:
        -- 1. Indica supresión push explícita en payload (suppress_push = true)
        -- 2. O el usuario destinatario se encuentra en horario silencioso en America/Argentina/Buenos_Aires
        -- En ambos casos, Inbox se preserva y la entrega Web Push se cancela server-side.
        IF NOT v_is_critical AND (
            COALESCE(v_claimed_rows.payload->>'suppress_push', '') IN ('true', 't', '1', 'yes')
            OR public.is_user_in_quiet_hours(v_claimed_rows.delivery_recipient_id, v_now)
        ) THEN
            UPDATE public.notification_delivery_outbox
            SET status = 'cancelled',
                last_error = 'Suppressed by quiet hours',
                updated_at = v_now
            WHERE id = v_claimed_rows.delivery_id;
            CONTINUE;
        END IF;

        IF v_is_critical THEN
            v_urgency := 'high';
        ELSE
            v_urgency := 'normal';
        END IF;

        -- Marcar en procesamiento
        UPDATE public.notification_delivery_outbox
        SET status = 'processing',
            processing_started_at = v_now,
            attempt_count = attempt_count + 1,
            updated_at = v_now
        WHERE id = v_claimed_rows.delivery_id;

        -- Agregar al lote listo para envío con tipado y urgencia
        v_result := v_result || pg_catalog.jsonb_build_object(
            'delivery_id', v_claimed_rows.delivery_id,
            'inbox_notification_id', v_claimed_rows.inbox_notification_id,
            'recipient_user_id', v_claimed_rows.delivery_recipient_id,
            'web_push_subscription_id', v_claimed_rows.web_push_subscription_id,
            'attempt_count', v_claimed_rows.attempt_count + 1,
            'endpoint', v_claimed_rows.endpoint,
            'p256dh_key', v_claimed_rows.p256dh_key,
            'auth_key', v_claimed_rows.auth_key,
            'title', v_claimed_rows.title,
            'body', v_claimed_rows.body,
            'deep_link', v_claimed_rows.deep_link,
            'expires_at', v_claimed_rows.inbox_expires_at,
            'notification_type', v_claimed_rows.notification_type,
            'is_critical', v_is_critical,
            'urgency', v_urgency
        );
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'deliveries', v_result,
        'count', pg_catalog.jsonb_array_length(v_result)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_web_push_deliveries_seguro(INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_web_push_deliveries_seguro(INT, TEXT) TO service_role;


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
        -- y renombrar dedup_key para permitir nuevo aviso limpio si se regresa a este horario (ciclo A -> B -> A)
        UPDATE public.inbox_notifications
        SET expires_at = v_now,
            dedup_key = dedup_key || ':invalidated:' || extract(epoch from v_now)::text
        WHERE target_type = 'encounter'
          AND target_id = NEW.id
          AND notification_type IN ('encounter_reminder_24h', 'encounter_reminder_2h')
          AND NOT dedup_key LIKE '%:invalidated:%';

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

        -- Expirar notificaciones de recordatorio en Inbox
        UPDATE public.inbox_notifications
        SET expires_at = v_now,
            dedup_key = dedup_key || ':invalidated:' || extract(epoch from v_now)::text
        WHERE target_type = 'encounter'
          AND target_id = NEW.id
          AND notification_type IN ('encounter_reminder_24h', 'encounter_reminder_2h')
          AND NOT dedup_key LIKE '%:invalidated:%';

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
    v_recipient RECORD;
    v_reminder_type TEXT;
    v_time_to_event INTERVAL;
    v_event_starts_at TIMESTAMPTZ;
    v_is_quiet BOOLEAN;
    v_inbox_id UUID;
    v_title TEXT;
    v_body TEXT;
    v_generic_push_title TEXT;
    v_generic_push_body TEXT;
    v_deep_link TEXT;
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

        -- Invariante: Nunca enviar recordatorios una vez iniciado el encuentro
        IF v_event_starts_at <= v_now THEN
            CONTINUE;
        END IF;

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

        -- 4. Iterar sobre destinatarios válidos: Anfitrión y Participantes confirmados
        FOR v_recipient IN
            -- A. Anfitrión del encuentro
            SELECT v_encuentro.host_id AS user_id,
                   'host'::text AS recipient_role,
                   v_encuentro.enc_created_at AS joined_at,
                   1 AS seat_count
            WHERE v_encuentro.host_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM public.encounter_reminders_log r
                  WHERE r.encuentro_id = v_encuentro.id
                    AND r.user_id = v_encuentro.host_id
                    AND r.reminder_type = v_reminder_type
                    AND r.scheduled_for_date = v_encuentro.fecha
                    AND r.scheduled_for_time = v_encuentro.hora
                    AND r.status IN ('sent', 'suppressed_quiet_hours')
              )
            UNION ALL
            -- B. Participantes confirmados de Encuentros Abiertos
            SELECT p.user_id,
                   'participant'::text AS recipient_role,
                   p.creado_en AS joined_at,
                   COALESCE(p.seat_count, 1) AS seat_count
            FROM public.participantes p
            WHERE p.encuentro_id = v_encuentro.id
              AND p.estado = 'confirmado'
              AND p.user_id IS NOT NULL
              AND p.user_id <> v_encuentro.host_id
              AND p.reconfirmation_status IS DISTINCT FROM 'declined'
              AND (
                  p.creado_en >= v_encuentro.opened_at
                  OR p.admission_source = 'post_open_generic'
                  OR EXISTS (
                      SELECT 1 FROM public.solicitudes_encuentro_abierto s
                      WHERE s.participante_id = p.id AND s.estado = 'approved'
                  )
              )
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
            -- Control de anticipación de registro para participantes
            IF v_recipient.recipient_role = 'participant' THEN
                IF v_reminder_type = 'reminder_24h' AND v_recipient.joined_at > (v_event_starts_at - INTERVAL '20 hours') THEN
                    v_skipped := v_skipped + 1;
                    CONTINUE;
                END IF;

                IF v_reminder_type = 'reminder_2h' AND v_recipient.joined_at > (v_event_starts_at - INTERVAL '15 minutes') THEN
                    v_skipped := v_skipped + 1;
                    CONTINUE;
                END IF;
            END IF;

            -- Invariante 14: Verificación de Horarios Silenciosos del destinatario
            v_is_quiet := public.is_user_in_quiet_hours(v_recipient.user_id, v_now);

            -- Enlaces y textos contextuales según rol
            IF v_recipient.recipient_role = 'host' THEN
                v_deep_link := '/meet/' || v_encuentro.id;
                IF v_reminder_type = 'reminder_24h' THEN
                    v_title := 'Recordatorio: mañana organizás tu encuentro';
                    v_body := 'Mañana sos anfitrión de "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '". Revisá las solicitudes, participantes o instrucciones del lugar.';
                    v_generic_push_title := 'Recordatorio de tu encuentro';
                    v_generic_push_body := 'Mañana sos anfitrión de un encuentro abierto. Ingresá para gestionar detalles.';
                ELSE
                    v_title := 'Recordatorio: tu encuentro organizado comienza en 2 horas';
                    v_body := 'Tu encuentro organizado "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '" empieza en 2 horas. Podés consultar la lista de participantes o datos de ingreso.';
                    v_generic_push_title := 'Recordatorio de tu encuentro';
                    v_generic_push_body := 'Tu encuentro organizado comienza en 2 horas.';
                END IF;
            ELSE
                -- Para participantes: enlace a solicitudes con apertura directa de detalle o retiro
                v_deep_link := '/solicitudes?open_encounter=' || v_encuentro.id;
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
            END IF;

            v_dedup_key := 'reminder:' || v_reminder_type || ':' || v_encuentro.id || ':' || v_recipient.user_id || ':' || v_encuentro.fecha || '_' || v_encuentro.hora;
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
                v_recipient.user_id,
                CASE WHEN v_reminder_type = 'reminder_24h' THEN 'encounter_reminder_24h' ELSE 'encounter_reminder_2h' END,
                'encounter',
                v_encuentro.id,
                v_deep_link,
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
                    'role', v_recipient.recipient_role,
                    'can_withdraw', (v_recipient.recipient_role = 'participant'),
                    'withdrawal_route', '/solicitudes',
                    'detail_route', v_deep_link
                ),
                v_dedup_key,
                v_expires_at
            )
            ON CONFLICT (recipient_user_id, dedup_key) DO UPDATE
            SET title = EXCLUDED.title,
                body = EXCLUDED.body,
                payload = EXCLUDED.payload,
                expires_at = EXCLUDED.expires_at,
                read_at = NULL
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
                v_recipient.user_id,
                v_reminder_type,
                v_encuentro.fecha,
                v_encuentro.hora,
                v_now,
                v_inbox_id,
                CASE WHEN v_is_quiet THEN 'suppressed_quiet_hours' ELSE 'sent' END,
                pg_catalog.jsonb_build_object(
                    'worker_id', p_worker_id,
                    'is_quiet_hours', v_is_quiet,
                    'seat_count', v_recipient.seat_count,
                    'role', v_recipient.recipient_role
                )
            )
            ON CONFLICT (encuentro_id, user_id, reminder_type, scheduled_for_date, scheduled_for_time)
            DO UPDATE SET
                status = EXCLUDED.status,
                sent_at = EXCLUDED.sent_at,
                inbox_notification_id = EXCLUDED.inbox_notification_id,
                metadata = public.encounter_reminders_log.metadata || EXCLUDED.metadata;

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
    v_encuentro_host_id UUID;
    v_reminders JSON;
BEGIN
    IF v_caller_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    SELECT host_id INTO v_encuentro_host_id
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    v_is_host := (v_encuentro_host_id = v_caller_id);

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
                'scheduled_for_time', r.scheduled_for_time,
                'recipient_role', COALESCE(r.metadata->>'role', CASE WHEN r.user_id = v_encuentro_host_id THEN 'host' ELSE 'participant' END),
                'inbox_status', CASE WHEN i.read_at IS NOT NULL THEN 'read' ELSE 'delivered' END,
                'push_delivery_status', COALESCE(
                    (SELECT d.status FROM public.notification_delivery_outbox d WHERE d.inbox_notification_id = r.inbox_notification_id LIMIT 1),
                    CASE WHEN r.status = 'suppressed_quiet_hours' THEN 'suppressed_quiet_hours' ELSE 'not_enqueued' END
                )
            ) ORDER BY r.sent_at DESC
        ), '[]'::json) INTO v_reminders
        FROM public.encounter_reminders_log r
        LEFT JOIN public.inbox_notifications i ON i.id = r.inbox_notification_id
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
                'scheduled_for_time', r.scheduled_for_time,
                'recipient_role', COALESCE(r.metadata->>'role', 'participant'),
                'inbox_status', CASE WHEN i.read_at IS NOT NULL THEN 'read' ELSE 'delivered' END,
                'push_delivery_status', COALESCE(
                    (SELECT d.status FROM public.notification_delivery_outbox d WHERE d.inbox_notification_id = r.inbox_notification_id LIMIT 1),
                    CASE WHEN r.status = 'suppressed_quiet_hours' THEN 'suppressed_quiet_hours' ELSE 'not_enqueued' END
                )
            ) ORDER BY r.sent_at DESC
        ), '[]'::json) INTO v_reminders
        FROM public.encounter_reminders_log r
        LEFT JOIN public.inbox_notifications i ON i.id = r.inbox_notification_id
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
