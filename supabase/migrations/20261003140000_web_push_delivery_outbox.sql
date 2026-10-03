-- ============================================================
-- Migración: 20261003140000_web_push_delivery_outbox.sql
-- Fase 3B: Pipeline de Despacho Web Push Concurrente y Resiliente
--
-- Componentes:
--   1. Tabla public.notification_delivery_outbox
--   2. Triggers de encolado automático desde inbox_notifications
--   3. Trigger de wake-up statement-level vía pg_net
--   4. RPCs seguras de resolución de worker config y wake-up
--   5. RPCs de procesamiento concurrente (claim con SKIP LOCKED, completar, fallar, revocar endpoint)
--   6. Reconciliación periódica (stuck workers, expirados, leídos)
--   7. Actualización de registrar/revocar de Fase 3A para cancelar entregas huérfanas
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLA: public.notification_delivery_outbox
-- Cola persistente de despacho de notificaciones a dispositivos.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.notification_delivery_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inbox_notification_id UUID NOT NULL REFERENCES public.inbox_notifications(id) ON DELETE CASCADE,
    recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'web_push' CHECK (channel IN ('web_push')),
    web_push_subscription_id UUID NOT NULL REFERENCES public.web_push_subscriptions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'cancelled')),
    
    -- Control de reintentos y concurrencia
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    available_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    processing_started_at TIMESTAMPTZ DEFAULT NULL,
    delivered_at TIMESTAMPTZ DEFAULT NULL,
    
    -- Diagnóstico sanitizado (sin claves ni tokens)
    last_error TEXT DEFAULT NULL,
    last_http_status INTEGER DEFAULT NULL,
    
    -- Trazabilidad y deduplicación
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    dedup_key TEXT NOT NULL,
    
    CONSTRAINT uq_delivery_inbox_sub_channel UNIQUE (inbox_notification_id, web_push_subscription_id, channel),
    CONSTRAINT uq_delivery_dedup UNIQUE (dedup_key)
);

-- Índices respaldados por consultas de cola y monitoreo
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_queue 
    ON public.notification_delivery_outbox (available_at, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_delivery_outbox_stuck 
    ON public.notification_delivery_outbox (processing_started_at)
    WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_delivery_outbox_recipient 
    ON public.notification_delivery_outbox (recipient_user_id);

CREATE INDEX IF NOT EXISTS idx_delivery_outbox_sub 
    ON public.notification_delivery_outbox (web_push_subscription_id);

CREATE INDEX IF NOT EXISTS idx_delivery_outbox_inbox 
    ON public.notification_delivery_outbox (inbox_notification_id);

-- Trigger de updated_at
DROP TRIGGER IF EXISTS trg_delivery_outbox_updated_at ON public.notification_delivery_outbox;
CREATE TRIGGER trg_delivery_outbox_updated_at
    BEFORE UPDATE ON public.notification_delivery_outbox
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS y Permisos estrictos: acceso directo denegado a clientes
ALTER TABLE public.notification_delivery_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_delivery_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.notification_delivery_outbox TO postgres, service_role;


-- ============================================================
-- 2. CONFIGURACIÓN Y WAKE-UP SEGURO VÍA pg_net
-- ============================================================

-- 2.1. get_web_push_worker_config
CREATE OR REPLACE FUNCTION public.get_web_push_worker_config(
    OUT o_url TEXT,
    OUT o_secret TEXT
)
RETURNS RECORD
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    o_url := NULL;
    o_secret := NULL;

    -- 1. Intentar leer desde Supabase Vault si existe
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') 
           OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'vault') THEN
            SELECT decrypted_secret INTO o_url 
            FROM vault.decrypted_secrets 
            WHERE name = 'web_push_worker_url' LIMIT 1;

            SELECT decrypted_secret INTO o_secret 
            FROM vault.decrypted_secrets 
            WHERE name = 'web_push_worker_secret' LIMIT 1;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- 2. Fallback a current_setting (app.settings.*)
    IF o_url IS NULL OR o_url = '' THEN
        BEGIN
            o_url := current_setting('app.settings.web_push_worker_url', true);
        EXCEPTION WHEN OTHERS THEN
            o_url := NULL;
        END;
    END IF;

    IF o_secret IS NULL OR o_secret = '' THEN
        BEGIN
            o_secret := current_setting('app.settings.web_push_worker_secret', true);
        EXCEPTION WHEN OTHERS THEN
            o_secret := NULL;
        END;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_web_push_worker_config() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_web_push_worker_config() TO service_role;


-- 2.2. enviar_web_push_wakeup
CREATE OR REPLACE FUNCTION public.enviar_web_push_wakeup(
    p_source TEXT DEFAULT 'direct'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_url TEXT;
    v_secret TEXT;
    v_has_pg_net BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_net'
    ) INTO v_has_pg_net;

    IF NOT v_has_pg_net THEN
        RETURN false;
    END IF;

    SELECT o_url, o_secret INTO v_url, v_secret 
    FROM public.get_web_push_worker_config();

    IF v_url IS NULL OR v_url = '' THEN
        RETURN false;
    END IF;

    BEGIN
        PERFORM net.http_post(
            url := v_url,
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-worker-secret', COALESCE(v_secret, '')
            ),
            body := jsonb_build_object(
                'source', p_source,
                'timestamp', pg_catalog.timezone('utc', pg_catalog.now())
            ),
            timeout_milliseconds := 5000
        );
        RETURN true;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'enviar_web_push_wakeup (%) failed: %', p_source, SQLERRM;
        RETURN false;
    END;
END;
$$;

REVOKE ALL ON FUNCTION public.enviar_web_push_wakeup(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enviar_web_push_wakeup(TEXT) TO service_role;


-- ============================================================
-- 3. ENCOLADO AUTOMÁTICO DE ENTREGAS
-- ============================================================

-- 3.1. trigger_enqueue_web_push_deliveries
-- Al insertarse una notificación en el Inbox, genera automáticamente una entrega
-- por cada suscripción activa del destinatario.
CREATE OR REPLACE FUNCTION public.trigger_enqueue_web_push_deliveries()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
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


-- 3.2. trigger_web_push_delivery_wakeup
-- Dispara a nivel de sentencia (statement-level) un único wake-up por lote de entregas.
CREATE OR REPLACE FUNCTION public.trigger_web_push_delivery_wakeup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.enviar_web_push_wakeup('delivery_insert');
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_web_push_delivery_wakeup ON public.notification_delivery_outbox;
CREATE TRIGGER trg_web_push_delivery_wakeup
    AFTER INSERT ON public.notification_delivery_outbox
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.trigger_web_push_delivery_wakeup();


-- ============================================================
-- 4. RPCS INTERNAS DE PROCESAMIENTO DEL DELIVERY OUTBOX (service_role)
-- ============================================================

-- 4.1. claim_web_push_deliveries_seguro
-- Reclama atómicamente un lote usando FOR UPDATE SKIP LOCKED.
-- Aplica las compuertas críticas de privacidad y vigencia:
--  - Valida que la suscripción siga 'active' y pertenezca al mismo recipient_user_id.
--  - Valida que la notificación no haya expirado ni haya sido leída.
-- Si alguna validación de vigencia o privacidad falla, transiciona a 'cancelled' de inmediato
-- y NO retorna la fila para despacho.
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

        -- Marcar en procesamiento
        UPDATE public.notification_delivery_outbox
        SET status = 'processing',
            processing_started_at = v_now,
            attempt_count = attempt_count + 1,
            updated_at = v_now
        WHERE id = v_claimed_rows.delivery_id;

        -- Agregar al lote listo para envío
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
            'expires_at', v_claimed_rows.inbox_expires_at
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


-- 4.2. completar_web_push_delivery_seguro
CREATE OR REPLACE FUNCTION public.completar_web_push_delivery_seguro(
    p_delivery_id UUID,
    p_http_status INT DEFAULT 201
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_sub_id UUID;
    v_updated INT;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
BEGIN
    IF p_delivery_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_delivery_id');
    END IF;

    UPDATE public.notification_delivery_outbox
    SET status = 'delivered',
        delivered_at = v_now,
        last_http_status = p_http_status,
        last_error = NULL,
        updated_at = v_now
    WHERE id = p_delivery_id
    RETURNING web_push_subscription_id INTO v_sub_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'delivery_not_found');
    END IF;

    -- Actualizar last_seen_at en la suscripción activa
    IF v_sub_id IS NOT NULL THEN
        UPDATE public.web_push_subscriptions
        SET last_seen_at = v_now
        WHERE id = v_sub_id;
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'delivery_id', p_delivery_id);
END;
$$;

REVOKE ALL ON FUNCTION public.completar_web_push_delivery_seguro(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.completar_web_push_delivery_seguro(UUID, INT) TO service_role;


-- 4.3. fallar_web_push_delivery_seguro
-- Registra fallo con retry y backoff exponencial si aplica.
CREATE OR REPLACE FUNCTION public.fallar_web_push_delivery_seguro(
    p_delivery_id UUID,
    p_error_message TEXT,
    p_http_status INT DEFAULT NULL,
    p_is_retryable BOOLEAN DEFAULT true,
    p_base_backoff_seconds INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_delivery RECORD;
    v_new_status TEXT;
    v_next_available TIMESTAMPTZ;
    v_backoff_base INT := GREATEST(COALESCE(p_base_backoff_seconds, 5), 1);
    v_backoff_seconds INT;
    v_clean_error TEXT;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
BEGIN
    IF p_delivery_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_delivery_id');
    END IF;

    SELECT id, attempt_count, max_attempts
    INTO v_delivery
    FROM public.notification_delivery_outbox
    WHERE id = p_delivery_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'delivery_not_found');
    END IF;

    -- Sanitizar mensaje de error (máximo 500 caracteres, sin stack traces ni secretos)
    v_clean_error := pg_catalog.substring(COALESCE(p_error_message, 'Unknown delivery error'), 1, 500);

    IF p_is_retryable AND v_delivery.attempt_count < v_delivery.max_attempts THEN
        v_new_status := 'pending';
        v_backoff_seconds := v_backoff_base * (2 ^ LEAST(v_delivery.attempt_count, 10));
        v_next_available := v_now + (v_backoff_seconds || ' seconds')::INTERVAL;
    ELSE
        v_new_status := 'failed';
        v_next_available := v_now;
    END IF;

    UPDATE public.notification_delivery_outbox
    SET status = v_new_status,
        available_at = v_next_available,
        last_error = v_clean_error,
        last_http_status = p_http_status,
        updated_at = v_now
    WHERE id = p_delivery_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'delivery_id', p_delivery_id,
        'status', v_new_status,
        'attempt_count', v_delivery.attempt_count,
        'available_at', v_next_available
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fallar_web_push_delivery_seguro(UUID, TEXT, INT, BOOLEAN, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fallar_web_push_delivery_seguro(UUID, TEXT, INT, BOOLEAN, INT) TO service_role;


-- 4.4. revocar_endpoint_invalido_seguro
-- Maneja respuestas 404 / 410 (Gone): revoca la suscripción física y cancela
-- cualquier entrega pendiente asociada a ella.
CREATE OR REPLACE FUNCTION public.revocar_endpoint_invalido_seguro(
    p_subscription_id UUID,
    p_delivery_id UUID,
    p_http_status INT DEFAULT 410
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_cancelled_count INT := 0;
BEGIN
    IF p_subscription_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_subscription_id');
    END IF;

    -- 1. Revocar la suscripción física del dispositivo
    UPDATE public.web_push_subscriptions
    SET status = 'revoked',
        revoked_at = v_now
    WHERE id = p_subscription_id;

    -- 2. Marcar la entrega actual como fallo terminal
    IF p_delivery_id IS NOT NULL THEN
        UPDATE public.notification_delivery_outbox
        SET status = 'failed',
            last_http_status = p_http_status,
            last_error = 'Endpoint revoked by provider (HTTP ' || p_http_status || ')',
            updated_at = v_now
        WHERE id = p_delivery_id;
    END IF;

    -- 3. Cancelar otras entregas pendientes asociadas a este mismo endpoint
    WITH cancelled AS (
        UPDATE public.notification_delivery_outbox
        SET status = 'cancelled',
            last_error = 'Device subscription revoked (HTTP ' || p_http_status || ')',
            updated_at = v_now
        WHERE web_push_subscription_id = p_subscription_id
          AND status = 'pending'
          AND id <> COALESCE(p_delivery_id, '00000000-0000-0000-0000-000000000000'::uuid)
        RETURNING id
    )
    SELECT COUNT(*) INTO v_cancelled_count FROM cancelled;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'subscription_id', p_subscription_id,
        'cancelled_other_deliveries_count', v_cancelled_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.revocar_endpoint_invalido_seguro(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revocar_endpoint_invalido_seguro(UUID, UUID, INT) TO service_role;


-- ============================================================
-- 5. RECONCILIACIÓN PERIÓDICA DE DELIVERIES
-- ============================================================

-- 5.1. reconciliar_web_push_deliveries_seguro
CREATE OR REPLACE FUNCTION public.reconciliar_web_push_deliveries_seguro(
    p_stuck_interval INTERVAL DEFAULT INTERVAL '5 minutes'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_stuck_interval INTERVAL := COALESCE(p_stuck_interval, INTERVAL '5 minutes');
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_stuck_threshold TIMESTAMPTZ := v_now - v_stuck_interval;
    v_recovered_count INT := 0;
    v_cancelled_expired_count INT := 0;
    v_cancelled_read_count INT := 0;
    v_pending_count INT := 0;
    v_wakeup_dispatched BOOLEAN := false;
BEGIN
    -- 1. Recuperar entregas 'processing' colgadas hace más de stuck_interval
    WITH recovered AS (
        UPDATE public.notification_delivery_outbox
        SET status = 'pending',
            available_at = v_now,
            last_error = 'Recovered from abandoned worker',
            updated_at = v_now
        WHERE status = 'processing'
          AND processing_started_at < v_stuck_threshold
        RETURNING id
    )
    SELECT COUNT(*) INTO v_recovered_count FROM recovered;

    -- 2. Cancelar entregas pendientes cuyo Inbox ya expiró
    WITH cancelled_exp AS (
        UPDATE public.notification_delivery_outbox d
        SET status = 'cancelled',
            last_error = 'Inbox notification expired before push delivery',
            updated_at = v_now
        FROM public.inbox_notifications i
        WHERE d.inbox_notification_id = i.id
          AND d.status = 'pending'
          AND i.expires_at <= v_now
        RETURNING d.id
    )
    SELECT COUNT(*) INTO v_cancelled_expired_count FROM cancelled_exp;

    -- 3. Cancelar entregas pendientes cuya notificación ya fue leída en la app
    WITH cancelled_read AS (
        UPDATE public.notification_delivery_outbox d
        SET status = 'cancelled',
            last_error = 'Notification already read in-app',
            updated_at = v_now
        FROM public.inbox_notifications i
        WHERE d.inbox_notification_id = i.id
          AND d.status = 'pending'
          AND i.read_at IS NOT NULL
        RETURNING d.id
    )
    SELECT COUNT(*) INTO v_cancelled_read_count FROM cancelled_read;

    -- 4. Contar pendientes listas para procesar
    SELECT COUNT(*) INTO v_pending_count
    FROM public.notification_delivery_outbox
    WHERE status = 'pending'
      AND available_at <= v_now;

    -- 5. Disparar wake-up de contingencia si hay trabajo
    IF v_pending_count > 0 OR v_recovered_count > 0 THEN
        v_wakeup_dispatched := public.enviar_web_push_wakeup('reconciliation_cron');
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'recovered_count', v_recovered_count,
        'cancelled_expired_count', v_cancelled_expired_count,
        'cancelled_read_count', v_cancelled_read_count,
        'pending_count', v_pending_count,
        'wakeup_dispatched', v_wakeup_dispatched
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reconciliar_web_push_deliveries_seguro(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliar_web_push_deliveries_seguro(INTERVAL) TO service_role;


-- 5.2. Programar reconciliación en pg_cron si está disponible
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('reconciliar_web_push_deliveries_job');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        PERFORM cron.schedule(
            'reconciliar_web_push_deliveries_job',
            '*/2 * * * *',
            'SELECT public.reconciliar_web_push_deliveries_seguro();'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;


-- ============================================================
-- 6. ACTUALIZACIÓN DE SEGURIDAD EN REGISTRO Y REVOCACIÓN (FASE 3A)
-- Cancela automáticamente entregas pendientes incompatibles
-- al reasignar endpoint o al revocar un dispositivo.
-- ============================================================

-- 6.1. Extensión de registrar_web_push_subscription_seguro
CREATE OR REPLACE FUNCTION public.registrar_web_push_subscription_seguro(
    p_endpoint TEXT,
    p_p256dh TEXT,
    p_auth TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_row RECORD;
    v_created BOOLEAN;
    v_prev_user_id UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_endpoint IS NULL OR p_endpoint !~ '^https://' OR pg_catalog.length(p_endpoint) > 2048 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_endpoint');
    END IF;

    IF p_p256dh IS NULL
       OR p_p256dh !~ '^[A-Za-z0-9_-]+={0,2}$'
       OR pg_catalog.length(p_p256dh) NOT BETWEEN 16 AND 256
       OR p_auth IS NULL
       OR p_auth !~ '^[A-Za-z0-9_-]+={0,2}$'
       OR pg_catalog.length(p_auth) NOT BETWEEN 8 AND 128 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_keys');
    END IF;

    -- Obtener si existía un dueño anterior para detectar reasignación
    SELECT user_id INTO v_prev_user_id
    FROM public.web_push_subscriptions
    WHERE endpoint = p_endpoint;

    INSERT INTO public.web_push_subscriptions (
        user_id, endpoint, p256dh_key, auth_key, status, last_seen_at, revoked_at
    ) VALUES (
        v_user_id, p_endpoint, p_p256dh, p_auth, 'active', v_now, NULL
    )
    ON CONFLICT (endpoint) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        p256dh_key = EXCLUDED.p256dh_key,
        auth_key = EXCLUDED.auth_key,
        status = 'active',
        revoked_at = NULL,
        last_seen_at = v_now
    RETURNING id, status, last_seen_at, (xmax = 0) AS was_created
    INTO v_row;

    v_created := v_row.was_created;

    -- Si el endpoint fue reasignado desde otro usuario en un dispositivo compartido:
    -- cancelar inmediatamente cualquier entrega pendiente del usuario anterior
    IF v_prev_user_id IS NOT NULL AND v_prev_user_id <> v_user_id THEN
        UPDATE public.notification_delivery_outbox
        SET status = 'cancelled',
            last_error = 'Endpoint reassigned to another user',
            updated_at = v_now
        WHERE web_push_subscription_id = v_row.id
          AND recipient_user_id <> v_user_id
          AND status = 'pending';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'device', pg_catalog.jsonb_build_object(
            'id', v_row.id,
            'status', v_row.status,
            'last_seen_at', v_row.last_seen_at,
            'created', v_created
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_web_push_subscription_seguro(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_web_push_subscription_seguro(TEXT, TEXT, TEXT) TO authenticated;


-- 6.2. Extensión de revocar_web_push_subscription_seguro
CREATE OR REPLACE FUNCTION public.revocar_web_push_subscription_seguro(
    p_endpoint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_sub_id UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_endpoint IS NULL OR pg_catalog.length(p_endpoint) = 0 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_endpoint');
    END IF;

    -- Obtener ID de suscripción del usuario
    SELECT id INTO v_sub_id
    FROM public.web_push_subscriptions
    WHERE endpoint = p_endpoint
      AND user_id = v_user_id
      AND status = 'active';

    IF v_sub_id IS NOT NULL THEN
        UPDATE public.web_push_subscriptions
        SET status = 'revoked',
            revoked_at = v_now
        WHERE id = v_sub_id;

        -- Cancelar entregas pendientes de este dispositivo revocado
        UPDATE public.notification_delivery_outbox
        SET status = 'cancelled',
            last_error = 'Device revoked by user',
            updated_at = v_now
        WHERE web_push_subscription_id = v_sub_id
          AND status = 'pending';
    END IF;

    -- Idempotente: ok=true aunque no hubiese nada que revocar o el endpoint sea ajeno
    RETURN pg_catalog.jsonb_build_object('ok', true, 'revoked', v_sub_id IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.revocar_web_push_subscription_seguro(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revocar_web_push_subscription_seguro(TEXT) TO authenticated;

COMMIT;
