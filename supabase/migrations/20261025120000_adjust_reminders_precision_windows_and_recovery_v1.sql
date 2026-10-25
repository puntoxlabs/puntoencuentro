-- ==============================================================================
-- Migración: 20261025120000_adjust_reminders_precision_windows_and_recovery_v1.sql
-- Módulo: Mini-Sprint E — Ajuste de precisión de ventanas temporales y recuperación
--
-- Objetivos:
-- 1. Ventanas ordinarias sincronizadas con la cadencia real de 10 min de pg_cron:
--    - reminder_24h: [24h 10m .. 20h] (en lugar del prematuro 25h).
--    - reminder_2h: [2h 10m .. 10m] (en lugar del prematuro 2h 15m).
-- 2. Recuperación controlada ante demoras del cron sin mensajes temporalmente incorrectos:
--    - Si reminder_2h se ejecuta demorado (< 1h 45m), el copy dice "comienza pronto"
--      en lugar de "comienza en 2 horas".
--    - Si reminder_24h se ejecuta demorado en el mismo día del evento, el copy dice "hoy"
--      en lugar de "mañana".
-- 3. Cero avisos retrospectivos tras el inicio del evento.
-- 4. Preservación estricta de idempotencia, reprogramaciones, Inbox, Push y Horarios Silenciosos.
-- ==============================================================================

BEGIN;

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

    v_event_date DATE;
    v_current_date DATE;
    v_hora_str TEXT;
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

    -- 2. Iterar sobre encuentros abiertos activos cuya realización ocurra en las próximas 25 horas
    FOR v_encuentro IN
        SELECT e.id,
               e.host_id,
               e.titulo,
               e.open_public_title,
               e.modalidad,
               e.fecha,
               e.hora,
               e.duration_minutes,
               e.creado_en AS enc_created_at,
               e.opened_at,
               ((e.fecha::text || ' ' || e.hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') AS event_starts_at
        FROM public.encuentros e
        WHERE e.is_open = true
          AND e.estado = 'activo'
          AND e.fecha IS NOT NULL
          AND e.hora IS NOT NULL
          AND ((e.fecha::text || ' ' || e.hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') > v_now
          AND ((e.fecha::text || ' ' || e.hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') <= v_now + INTERVAL '25 hours'
        ORDER BY e.fecha ASC, e.hora ASC, e.id ASC
    LOOP
        v_event_starts_at := v_encuentro.event_starts_at;
        v_time_to_event := v_event_starts_at - v_now;

        -- Invariante: Nunca enviar recordatorios una vez iniciado el encuentro (Cero retrospectivos)
        IF v_event_starts_at <= v_now THEN
            CONTINUE;
        END IF;

        -- 3. Determinar qué recordatorio corresponde según ventanas precisas y cadencia pg_cron (10 min)
        v_reminder_type := NULL;

        -- Ventana 24h: [24h 10m .. 10h] antes del evento (permite recuperación demorada matutina del día del evento)
        IF v_time_to_event <= INTERVAL '24 hours 10 minutes' AND v_time_to_event >= INTERVAL '10 hours' THEN
            -- Invariante 9: El evento NO debe haber sido creado con menos de 24 h de anticipación
            IF v_encuentro.enc_created_at <= (v_event_starts_at - INTERVAL '23 hours 30 minutes') THEN
                v_reminder_type := 'reminder_24h';
            ELSE
                v_skipped := v_skipped + 1;
            END IF;
        -- Ventana 2h: [2h 10m .. 10m] antes del evento
        ELSIF v_time_to_event <= INTERVAL '2 hours 10 minutes' AND v_time_to_event >= INTERVAL '10 minutes' THEN
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

        -- Fechas para adaptación contextual de textos
        v_event_date := (v_event_starts_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
        v_current_date := (v_now AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
        v_hora_str := pg_catalog.to_char(v_encuentro.hora, 'HH24:MI');

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
                IF v_reminder_type = 'reminder_24h' AND v_recipient.joined_at > (v_event_starts_at - INTERVAL '10 hours') THEN
                    v_skipped := v_skipped + 1;
                    CONTINUE;
                END IF;

                IF v_reminder_type = 'reminder_2h' AND v_recipient.joined_at > (v_event_starts_at - INTERVAL '10 minutes') THEN
                    v_skipped := v_skipped + 1;
                    CONTINUE;
                END IF;
            END IF;

            -- Invariante 14: Verificación de Horarios Silenciosos del destinatario
            v_is_quiet := public.is_user_in_quiet_hours(v_recipient.user_id, v_now);

            -- Enlaces y textos contextuales temporalmente precisos según rol y ventana
            IF v_recipient.recipient_role = 'host' THEN
                v_deep_link := '/meet/' || v_encuentro.id;
                IF v_reminder_type = 'reminder_24h' THEN
                    IF v_event_date > v_current_date THEN
                        v_title := 'Recordatorio: mañana organizás tu encuentro';
                        v_body := 'Mañana sos anfitrión de "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '". Revisá las solicitudes, participantes o instrucciones del lugar.';
                        v_generic_push_title := 'Recordatorio de tu encuentro';
                        v_generic_push_body := 'Mañana sos anfitrión de un encuentro abierto. Ingresá para gestionar detalles.';
                    ELSE
                        v_title := 'Recordatorio: hoy organizás tu encuentro';
                        v_body := 'Hoy sos anfitrión de "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '" (a las ' || v_hora_str || '). Revisá las solicitudes, participantes o instrucciones del lugar.';
                        v_generic_push_title := 'Recordatorio de tu encuentro';
                        v_generic_push_body := 'Hoy sos anfitrión de un encuentro abierto. Ingresá para gestionar detalles.';
                    END IF;
                ELSE
                    -- reminder_2h
                    IF v_time_to_event >= INTERVAL '105 minutes' THEN
                        v_title := 'Recordatorio: tu encuentro organizado comienza en 2 horas';
                        v_body := 'Tu encuentro organizado "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '" empieza en 2 horas. Podés consultar la lista de participantes o datos de ingreso.';
                        v_generic_push_title := 'Recordatorio de tu encuentro';
                        v_generic_push_body := 'Tu encuentro organizado comienza en 2 horas.';
                    ELSE
                        -- Ejecución demorada recuperada: copy adaptativo para evitar mensaje temporalmente erróneo
                        v_title := 'Recordatorio: tu encuentro organizado comienza pronto';
                        v_body := 'Tu encuentro organizado "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '" empieza pronto (a las ' || v_hora_str || '). Podés consultar la lista de participantes o datos de ingreso.';
                        v_generic_push_title := 'Recordatorio de tu encuentro';
                        v_generic_push_body := 'Tu encuentro organizado comienza pronto.';
                    END IF;
                END IF;
            ELSE
                -- Para participantes: enlace a solicitudes con apertura directa de detalle o retiro
                v_deep_link := '/solicitudes?open_encounter=' || v_encuentro.id;
                IF v_reminder_type = 'reminder_24h' THEN
                    IF v_event_date > v_current_date THEN
                        v_title := 'Recordatorio: mañana es el encuentro';
                        v_body := 'Mañana tenés el encuentro "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '". Podés revisar los detalles o avisar con anticipación si no podés asistir.';
                        v_generic_push_title := 'Recordatorio de encuentro';
                        v_generic_push_body := 'Mañana tenés un encuentro programado. Ingresá para ver detalles e instrucciones.';
                    ELSE
                        v_title := 'Recordatorio: hoy es el encuentro';
                        v_body := 'Hoy tenés el encuentro "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '" (a las ' || v_hora_str || '). Podés revisar los detalles o avisar con anticipación si no podés asistir.';
                        v_generic_push_title := 'Recordatorio de encuentro';
                        v_generic_push_body := 'Hoy tenés un encuentro programado. Ingresá para ver detalles e instrucciones.';
                    END IF;
                ELSE
                    -- reminder_2h
                    IF v_time_to_event >= INTERVAL '105 minutes' THEN
                        v_title := 'Recordatorio: tu encuentro comienza en 2 horas';
                        v_body := 'Tu encuentro "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '" empieza en 2 horas. Verificá cómo llegar o las instrucciones de ingreso.';
                        v_generic_push_title := 'Recordatorio de encuentro';
                        v_generic_push_body := 'Tu encuentro comienza en 2 horas. Ingresá para ver ubicación e instrucciones.';
                    ELSE
                        -- Ejecución demorada recuperada: copy adaptativo para evitar mensaje temporalmente erróneo
                        v_title := 'Recordatorio: tu encuentro comienza pronto';
                        v_body := 'Tu encuentro "' || COALESCE(v_encuentro.open_public_title, v_encuentro.titulo) || '" empieza pronto (a las ' || v_hora_str || '). Verificá cómo llegar o las instrucciones de ingreso.';
                        v_generic_push_title := 'Recordatorio de encuentro';
                        v_generic_push_body := 'Tu encuentro comienza pronto. Ingresá para ver ubicación e instrucciones.';
                    END IF;
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
                    'role', v_recipient.recipient_role,
                    'worker_id', p_worker_id,
                    'is_quiet_hours', v_is_quiet,
                    'seat_count', v_recipient.seat_count
                )
            )
            ON CONFLICT (encuentro_id, user_id, reminder_type, scheduled_for_date, scheduled_for_time) DO UPDATE
            SET sent_at = EXCLUDED.sent_at,
                inbox_notification_id = EXCLUDED.inbox_notification_id,
                status = EXCLUDED.status,
                metadata = EXCLUDED.metadata;

            -- Contabilizar según resultado y tipo
            IF v_is_quiet THEN
                v_suppressed_quiet := v_suppressed_quiet + 1;
            END IF;

            IF v_reminder_type = 'reminder_24h' THEN
                v_reminders_24h_sent := v_reminders_24h_sent + 1;
            ELSE
                v_reminders_2h_sent := v_reminders_2h_sent + 1;
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

COMMENT ON FUNCTION public.procesar_recordatorios_encuentros_abiertos_seguro(TEXT) IS
'Procesamiento durable de recordatorios 24h y 2h para Encuentros Abiertos con ventanas de precisión adaptadas a cadencia de 10 min de pg_cron, recuperación demorada contextual y protección anti-mensajes extemporáneos.';

COMMIT;
