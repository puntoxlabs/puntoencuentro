-- ==============================================================================
-- Migración: 20261023183000_harden_web_push_claim_and_priority_v1.sql
-- Módulo: Mini-sprint P0 — Blindaje de Notificaciones Críticas y Prioridad Web Push
-- Propósito:
--   1. Actualizar public.claim_web_push_deliveries_seguro para proyectar
--      notification_type, is_critical y urgency de forma conservadora a partir de
--      metadatos confiables en el servidor (inbox_notifications).
--   2. Preservar íntegramente la firma pública existente, cerrojos SKIP LOCKED,
--      validación de suscripción activa, mitigación de dispositivo compartido,
--      cancelación de entregas expiradas o leídas in-app y políticas de seguridad.
-- ==============================================================================

BEGIN;

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
        -- - Cancelaciones para participantes y solicitantes
        -- - Reprogramaciones de fecha/horario para participantes confirmados
        -- - Notificaciones con metadata explícita 'priority' = 'critical'
        v_is_critical := COALESCE(
            v_claimed_rows.notification_type IN (
                'encounter_cancelled_for_participant',
                'open_encounter_request_cancelled_by_host'
            )
            OR (
                v_claimed_rows.notification_type = 'encounter_schedule_changed'
                AND COALESCE((v_claimed_rows.payload->>'is_applicant')::boolean, false) = false
            )
            OR (COALESCE(v_claimed_rows.payload->>'priority', '') = 'critical'),
            false
        );

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

COMMIT;
