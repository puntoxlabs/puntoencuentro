-- ============================================================
-- Migración: 20261014193000_qa_web_push_test_and_diagnostics.sql
-- Propósito:
--   Acción segura de QA interno para enviar notificaciones de prueba
--   y consultar la trazabilidad del delivery outbox sin exponer secretos
--   ni datos sensibles. Solo ejecutable por operadores QA autorizados
--   hacia sus propios dispositivos activos.
-- ============================================================

BEGIN;

-- 1. RPC ENVIAR_QA_WEB_PUSH_PRUEBA_SEGURO
CREATE OR REPLACE FUNCTION public.enviar_qa_web_push_prueba_seguro()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_is_qa boolean := false;
    v_active_subs int := 0;
    v_rl jsonb;
    v_inbox_res jsonb;
    v_inbox_id uuid;
    v_outbox_rec record;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- Validar autorización QA
    SELECT public.is_qa_authorized() INTO v_is_qa;
    IF NOT COALESCE(v_is_qa, false) THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'unauthorized',
            'message', 'Acción reservada para operadores de QA autorizados.'
        );
    END IF;

    -- Rate limit defensivo: máximo 10 pruebas por minuto por operador QA
    v_rl := public.verificar_y_consumir_rate_limit(v_user_id, 'qa_push_test', 10, INTERVAL '1 minute');
    IF (v_rl->>'allowed')::boolean = false THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'rate_limit_exceeded',
            'message', 'Demasiadas pruebas consecutivas. Esperá unos segundos.'
        );
    END IF;

    -- Verificar si el operador tiene al menos un dispositivo activo
    SELECT pg_catalog.count(*)::int INTO v_active_subs
    FROM public.web_push_subscriptions
    WHERE user_id = v_user_id AND status = 'active';

    IF v_active_subs = 0 THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'no_active_device',
            'message', 'No tenés ningún dispositivo con notificaciones activas en esta cuenta. Activá Web Push en este dispositivo primero.'
        );
    END IF;

    -- Insertar notificación de prueba genérica usando la función canónica
    v_inbox_res := public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_user_id,
        p_notification_type := 'qa_push_test',
        p_target_type := 'qa',
        p_target_id := v_user_id,
        p_deep_link := '/internal/qa',
        p_title := 'PuntoEncuentro',
        p_body := 'Notificación de prueba',
        p_payload := pg_catalog.jsonb_build_object('qa_test', true, 'priority', 'high'),
        p_dedup_key := 'qa_push_test:' || v_user_id || ':' || pg_catalog.gen_random_uuid()::text
    );

    v_inbox_id := (v_inbox_res->>'notification_id')::uuid;

    -- Buscar el outbox recién generado por el trigger trg_enqueue_web_push_deliveries
    SELECT d.id, d.status, d.attempt_count, d.created_at, substring(s.endpoint from '^https://[^/]+') as origin
    INTO v_outbox_rec
    FROM public.notification_delivery_outbox d
    JOIN public.web_push_subscriptions s ON s.id = d.web_push_subscription_id
    WHERE d.inbox_notification_id = v_inbox_id
      AND d.recipient_user_id = v_user_id
    ORDER BY d.created_at DESC
    LIMIT 1;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'inbox_notification_id', v_inbox_id,
        'active_devices_count', v_active_subs,
        'outbox_id', v_outbox_rec.id,
        'outbox_status', COALESCE(v_outbox_rec.status, 'pending'),
        'endpoint_origin', v_outbox_rec.origin,
        'created_at', v_outbox_rec.created_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.enviar_qa_web_push_prueba_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enviar_qa_web_push_prueba_seguro() TO authenticated;


-- 2. RPC GET_QA_WEB_PUSH_DELIVERY_STATUS_SEGURO
CREATE OR REPLACE FUNCTION public.get_qa_web_push_delivery_status_seguro(p_inbox_notification_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_is_qa boolean := false;
    v_deliveries jsonb;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT public.is_qa_authorized() INTO v_is_qa;
    IF NOT COALESCE(v_is_qa, false) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'outbox_id', d.id,
        'status', d.status,
        'attempt_count', d.attempt_count,
        'created_at', d.created_at,
        'processing_started_at', d.processing_started_at,
        'delivered_at', d.delivered_at,
        'last_error', d.last_error,
        'endpoint_origin', substring(s.endpoint from '^https://[^/]+'),
        'subscription_status', s.status,
        'device_last_seen', s.last_seen_at
    )) INTO v_deliveries
    FROM public.notification_delivery_outbox d
    JOIN public.web_push_subscriptions s ON s.id = d.web_push_subscription_id
    WHERE d.inbox_notification_id = p_inbox_notification_id
      AND d.recipient_user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'inbox_notification_id', p_inbox_notification_id,
        'deliveries', COALESCE(v_deliveries, '[]'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_qa_web_push_delivery_status_seguro(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_qa_web_push_delivery_status_seguro(uuid) TO authenticated;

COMMIT;
