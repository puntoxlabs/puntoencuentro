-- ============================================================
-- Migración: 20261002180000_notifications_inbox_and_outbox_base.sql
-- Módulo: Fase 1 — Infraestructura Base de Notificaciones e Inbox
-- Tablas: domain_events_outbox, inbox_notifications
-- RPCs: lectura, conteo, marcado, claim concurrente, completado, reconciliación
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLA: public.domain_events_outbox
-- Transaccional interna: almacena eventos de dominio generados
-- en la misma transacción que las mutaciones de negocio.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Identificación y Versión del Evento
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    aggregate_type TEXT NOT NULL,
    aggregate_id UUID NOT NULL,
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    -- Carga Útil y Deduplicación
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedup_key TEXT NOT NULL,
    
    -- Máquina de Estados del Procesamiento
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    
    -- Trazabilidad y Reintentos
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    available_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    processing_started_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    last_error TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    
    CONSTRAINT uq_domain_events_dedup UNIQUE (dedup_key)
);

-- Índices respaldados por consultas reales previstas
CREATE INDEX IF NOT EXISTS idx_outbox_queue 
    ON public.domain_events_outbox (available_at, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_outbox_stuck_workers 
    ON public.domain_events_outbox (processing_started_at)
    WHERE status = 'processing';

-- RLS y Permisos de domain_events_outbox
ALTER TABLE public.domain_events_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.domain_events_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.domain_events_outbox TO service_role;


-- ============================================================
-- 2. TABLA: public.inbox_notifications
-- Bandeja persistente de notificaciones destinadas al usuario.
-- Fuente de la verdad inmutable para la experiencia in-app.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inbox_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- Tipología y Enrutamiento Canónico
    notification_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id UUID NOT NULL,
    deep_link TEXT NOT NULL,
    
    -- Contenido Determinístico de Presentación
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    -- Ciclo de Lectura e Idempotencia
    read_at TIMESTAMPTZ,
    dedup_key TEXT NOT NULL,
    
    -- Expiración y Retención
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    
    CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
);

-- Índices de consulta ultra-rápida de bandeja y badge
CREATE INDEX IF NOT EXISTS idx_inbox_unread_count 
    ON public.inbox_notifications (recipient_user_id, created_at DESC)
    WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_user_list 
    ON public.inbox_notifications (recipient_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_cleanup 
    ON public.inbox_notifications (expires_at);

-- RLS y Permisos de inbox_notifications
ALTER TABLE public.inbox_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inbox_notifications FROM PUBLIC, anon;

-- El usuario autenticado solo puede leer sus propias notificaciones
DROP POLICY IF EXISTS inbox_notifications_select_own ON public.inbox_notifications;
CREATE POLICY inbox_notifications_select_own 
    ON public.inbox_notifications 
    FOR SELECT 
    TO authenticated 
    USING (recipient_user_id = auth.uid());

GRANT SELECT ON TABLE public.inbox_notifications TO authenticated;
GRANT ALL ON TABLE public.inbox_notifications TO service_role;


-- ============================================================
-- 3. RPCS PÚBLICAS DEL INBOX (Consumidas por la aplicación cliente)
-- ============================================================

-- 3.1. get_mis_notificaciones_inbox_seguro
-- Devuelve las notificaciones del usuario con paginación basada en cursor estable (created_at, id).
CREATE OR REPLACE FUNCTION public.get_mis_notificaciones_inbox_seguro(
    p_limit INT DEFAULT 20,
    p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
    v_rows RECORD;
    v_items JSONB := '[]'::jsonb;
    v_has_more BOOLEAN := false;
    v_count INT := 0;
    v_next_cursor_created_at TIMESTAMPTZ := NULL;
    v_next_cursor_id UUID := NULL;
    v_now TIMESTAMPTZ := timezone('utc', now());
BEGIN
    -- Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- Rechazar cuentas anónimas
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- Consultar filas (+ 1 para detectar si hay siguiente página)
    FOR v_rows IN
        SELECT 
            id,
            notification_type,
            target_type,
            target_id,
            deep_link,
            title,
            body,
            payload,
            read_at,
            (read_at IS NOT NULL) AS is_read,
            expires_at,
            created_at
        FROM public.inbox_notifications
        WHERE recipient_user_id = v_user_id
          AND expires_at > v_now
          AND (
              p_cursor_created_at IS NULL 
              OR (created_at < p_cursor_created_at)
              OR (created_at = p_cursor_created_at AND id < p_cursor_id)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT v_limit + 1
    LOOP
        v_count := v_count + 1;
        IF v_count <= v_limit THEN
            v_items := v_items || pg_catalog.jsonb_build_object(
                'id', v_rows.id,
                'notification_type', v_rows.notification_type,
                'target_type', v_rows.target_type,
                'target_id', v_rows.target_id,
                'deep_link', v_rows.deep_link,
                'title', v_rows.title,
                'body', v_rows.body,
                'payload', v_rows.payload,
                'read_at', v_rows.read_at,
                'is_read', v_rows.is_read,
                'expires_at', v_rows.expires_at,
                'created_at', v_rows.created_at
            );
            v_next_cursor_created_at := v_rows.created_at;
            v_next_cursor_id := v_rows.id;
        ELSE
            v_has_more := true;
        END IF;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'data', v_items,
        'has_more', v_has_more,
        'next_cursor', CASE 
            WHEN v_has_more THEN pg_catalog.jsonb_build_object(
                'created_at', v_next_cursor_created_at,
                'id', v_next_cursor_id
            )
            ELSE NULL 
        END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_mis_notificaciones_inbox_seguro(INT, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mis_notificaciones_inbox_seguro(INT, TIMESTAMPTZ, UUID) TO anon, authenticated;


-- 3.2. get_contador_notificaciones_no_leidas_seguro
-- Devuelve el conteo de notificaciones activas no leídas del usuario llamador.
CREATE OR REPLACE FUNCTION public.get_contador_notificaciones_no_leidas_seguro()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_count INT := 0;
    v_now TIMESTAMPTZ := timezone('utc', now());
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.inbox_notifications
    WHERE recipient_user_id = v_user_id
      AND read_at IS NULL
      AND expires_at > v_now;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'unread_count', v_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_contador_notificaciones_no_leidas_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_contador_notificaciones_no_leidas_seguro() TO anon, authenticated;


-- 3.3. marcar_notificacion_leida_seguro
-- Marca una notificación individual como leída de forma idempotente.
CREATE OR REPLACE FUNCTION public.marcar_notificacion_leida_seguro(
    p_notification_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_read_at TIMESTAMPTZ;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_notification_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_notification_id');
    END IF;

    -- Actualizar si existe y pertenece al usuario
    UPDATE public.inbox_notifications
    SET read_at = COALESCE(read_at, timezone('utc', now()))
    WHERE id = p_notification_id
      AND recipient_user_id = v_user_id
    RETURNING read_at INTO v_read_at;

    IF v_read_at IS NULL THEN
        -- Si no hubo fila actualizada, verificar si existe de otro usuario o no existe
        IF EXISTS (SELECT 1 FROM public.inbox_notifications WHERE id = p_notification_id) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
        ELSE
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'notification_not_found');
        END IF;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'notification_id', p_notification_id,
        'read_at', v_read_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.marcar_notificacion_leida_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marcar_notificacion_leida_seguro(UUID) TO anon, authenticated;


-- 3.4. marcar_todas_notificaciones_leidas_seguro
-- Marca todas las notificaciones no leídas del usuario como leídas.
CREATE OR REPLACE FUNCTION public.marcar_todas_notificaciones_leidas_seguro()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_now TIMESTAMPTZ := timezone('utc', now());
    v_updated_count INT := 0;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    WITH updated AS (
        UPDATE public.inbox_notifications
        SET read_at = v_now
        WHERE recipient_user_id = v_user_id
          AND read_at IS NULL
          AND expires_at > v_now
        RETURNING id
    )
    SELECT COUNT(*) INTO v_updated_count FROM updated;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'updated_count', v_updated_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.marcar_todas_notificaciones_leidas_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marcar_todas_notificaciones_leidas_seguro() TO anon, authenticated;


-- ============================================================
-- 4. RPCS INTERNAS DE PROCESAMIENTO DEL OUTBOX (service_role)
-- ============================================================

-- 4.1. claim_domain_events_seguro
-- Reclama atómicamente un lote de eventos listos usando FOR UPDATE SKIP LOCKED.
CREATE OR REPLACE FUNCTION public.claim_domain_events_seguro(
    p_batch_size INT DEFAULT 10,
    p_worker_id TEXT DEFAULT 'worker-default'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_limit INT := LEAST(GREATEST(COALESCE(p_batch_size, 10), 1), 100);
    v_now TIMESTAMPTZ := timezone('utc', now());
    v_claimed_events JSONB := '[]'::jsonb;
BEGIN
    WITH claimed AS (
        SELECT id
        FROM public.domain_events_outbox
        WHERE status = 'pending'
          AND available_at <= v_now
        ORDER BY created_at ASC
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
    ),
    updated AS (
        UPDATE public.domain_events_outbox o
        SET status = 'processing',
            processing_started_at = v_now,
            attempt_count = attempt_count + 1
        FROM claimed c
        WHERE o.id = c.id
        RETURNING 
            o.id,
            o.event_type,
            o.event_version,
            o.aggregate_type,
            o.aggregate_id,
            o.actor_user_id,
            o.payload,
            o.dedup_key,
            o.attempt_count,
            o.created_at
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', u.id,
                'event_type', u.event_type,
                'event_version', u.event_version,
                'aggregate_type', u.aggregate_type,
                'aggregate_id', u.aggregate_id,
                'actor_user_id', u.actor_user_id,
                'payload', u.payload,
                'dedup_key', u.dedup_key,
                'attempt_count', u.attempt_count,
                'created_at', u.created_at
            )
        ), '[]'::jsonb
    )
    INTO v_claimed_events
    FROM updated u;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'events', v_claimed_events,
        'count', jsonb_array_length(v_claimed_events)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_domain_events_seguro(INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_domain_events_seguro(INT, TEXT) TO service_role;


-- 4.2. completar_domain_event_seguro
-- Marca un evento como procesado exitosamente.
CREATE OR REPLACE FUNCTION public.completar_domain_event_seguro(
    p_event_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_updated INT;
BEGIN
    IF p_event_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_event_id');
    END IF;

    UPDATE public.domain_events_outbox
    SET status = 'processed',
        processed_at = timezone('utc', now()),
        last_error = NULL
    WHERE id = p_event_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'event_not_found');
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'event_id', p_event_id);
END;
$$;

REVOKE ALL ON FUNCTION public.completar_domain_event_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.completar_domain_event_seguro(UUID) TO service_role;


-- 4.3. fallar_domain_event_seguro
-- Registra fallo en el procesamiento de un evento. Si es retryable y no superó intentos, aplica backoff exponencial.
CREATE OR REPLACE FUNCTION public.fallar_domain_event_seguro(
    p_event_id UUID,
    p_error_message TEXT,
    p_is_retryable BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_event RECORD;
    v_new_status TEXT;
    v_next_available TIMESTAMPTZ;
    v_backoff_seconds INT;
    v_clean_error TEXT;
BEGIN
    IF p_event_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_event_id');
    END IF;

    SELECT id, attempt_count, max_attempts
    INTO v_event
    FROM public.domain_events_outbox
    WHERE id = p_event_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'event_not_found');
    END IF;

    -- Sanitizar mensaje de error (máximo 500 caracteres, sin stack traces sensibles)
    v_clean_error := SUBSTRING(COALESCE(p_error_message, 'Unknown processing error'), 1, 500);

    IF p_is_retryable AND v_event.attempt_count < v_event.max_attempts THEN
        v_new_status := 'pending';
        -- Backoff exponencial: 5 * (2 ^ attempt_count) segundos
        v_backoff_seconds := 5 * (2 ^ LEAST(v_event.attempt_count, 10));
        v_next_available := timezone('utc', now()) + (v_backoff_seconds || ' seconds')::INTERVAL;
    ELSE
        v_new_status := 'failed';
        v_next_available := timezone('utc', now());
    END IF;

    UPDATE public.domain_events_outbox
    SET status = v_new_status,
        available_at = v_next_available,
        last_error = v_clean_error
    WHERE id = p_event_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'event_id', p_event_id,
        'status', v_new_status,
        'attempt_count', v_event.attempt_count,
        'available_at', v_next_available
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fallar_domain_event_seguro(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fallar_domain_event_seguro(UUID, TEXT, BOOLEAN) TO service_role;


-- 4.4. insertar_inbox_notification_seguro
-- Helper interno seguro para insertar en el inbox con idempotencia estricta.
CREATE OR REPLACE FUNCTION public.insertar_inbox_notification_seguro(
    p_recipient_user_id UUID,
    p_notification_type TEXT,
    p_target_type TEXT,
    p_target_id UUID,
    p_deep_link TEXT,
    p_title TEXT,
    p_body TEXT,
    p_payload JSONB DEFAULT '{}'::jsonb,
    p_dedup_key TEXT DEFAULT NULL,
    p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_dedup TEXT := COALESCE(p_dedup_key, p_notification_type || ':' || p_target_id);
    v_expires TIMESTAMPTZ := COALESCE(p_expires_at, timezone('utc', now()) + INTERVAL '14 days');
    v_inserted_id UUID;
BEGIN
    IF p_recipient_user_id IS NULL OR p_notification_type IS NULL OR p_target_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

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
        p_recipient_user_id,
        p_notification_type,
        p_target_type,
        p_target_id,
        p_deep_link,
        p_title,
        p_body,
        COALESCE(p_payload, '{}'::jsonb),
        v_dedup,
        v_expires
    )
    ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING
    RETURNING id INTO v_inserted_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'inserted', (v_inserted_id IS NOT NULL),
        'notification_id', v_inserted_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.insertar_inbox_notification_seguro(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insertar_inbox_notification_seguro(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ) TO service_role;


-- ============================================================
-- 5. RECONCILIACIÓN Y MANTENIMIENTO: reconciliar_domain_events_seguro
-- Recupera eventos en 'processing' abandonados y purga notificaciones expiradas.
-- ============================================================
CREATE OR REPLACE FUNCTION public.reconciliar_domain_events_seguro()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_stuck_threshold TIMESTAMPTZ := timezone('utc', now()) - INTERVAL '5 minutes';
    v_recovered_count INT := 0;
    v_purged_count INT := 0;
    v_retention_threshold TIMESTAMPTZ := timezone('utc', now()) - INTERVAL '30 days';
BEGIN
    -- 1. Recuperar eventos 'processing' colgados hace más de 5 minutos
    WITH recovered AS (
        UPDATE public.domain_events_outbox
        SET status = 'pending',
            available_at = timezone('utc', now()),
            last_error = 'Recovered from abandoned worker'
        WHERE status = 'processing'
          AND processing_started_at < v_stuck_threshold
        RETURNING id
    )
    SELECT COUNT(*) INTO v_recovered_count FROM recovered;

    -- 2. Purgar físicamente notificaciones expiradas que superaron la retención técnica (30 días)
    WITH purged AS (
        DELETE FROM public.inbox_notifications
        WHERE expires_at < v_retention_threshold
        RETURNING id
    )
    SELECT COUNT(*) INTO v_purged_count FROM purged;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'recovered_events_count', v_recovered_count,
        'purged_notifications_count', v_purged_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reconciliar_domain_events_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliar_domain_events_seguro() TO service_role;


-- ============================================================
-- 6. WAKE-UP ASÍNCRONO VIA pg_net (No bloqueante)
-- Dispara una señal HTTP POST asíncrona hacia el worker Edge Function
-- El fallo de red o la falta de configuración NUNCA aborta la transacción principal.
-- ============================================================
CREATE OR REPLACE FUNCTION public.trigger_domain_events_outbox_wakeup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_url TEXT;
    v_secret TEXT;
    v_has_pg_net BOOLEAN;
BEGIN
    -- 1. Verificar si pg_net está instalado en la base de datos
    SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_net'
    ) INTO v_has_pg_net;

    IF NOT v_has_pg_net THEN
        RETURN NEW;
    END IF;

    -- 2. Obtener URL y Secret desde variables de configuración o vault de forma segura
    BEGIN
        v_url := current_setting('app.settings.domain_events_worker_url', true);
        v_secret := current_setting('app.settings.domain_events_worker_secret', true);
    EXCEPTION WHEN OTHERS THEN
        v_url := NULL;
        v_secret := NULL;
    END;

    IF v_url IS NULL OR v_url = '' THEN
        RETURN NEW;
    END IF;

    -- 3. Despachar petición HTTP asíncrona no bloqueante
    BEGIN
        PERFORM net.http_post(
            url := v_url,
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-worker-secret', COALESCE(v_secret, '')
            ),
            body := jsonb_build_object(
                'source', 'domain_events_outbox_wakeup',
                'timestamp', timezone('utc', now())
            ),
            timeout_milliseconds := 5000
        );
    EXCEPTION WHEN OTHERS THEN
        -- Fail-safe: error en wake-up NUNCA debe comprometer la transacción de dominio
        RAISE WARNING 'trigger_domain_events_outbox_wakeup failed: %', SQLERRM;
    END;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_domain_events_outbox_wakeup ON public.domain_events_outbox;
CREATE TRIGGER trg_domain_events_outbox_wakeup
    AFTER INSERT ON public.domain_events_outbox
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.trigger_domain_events_outbox_wakeup();


-- ============================================================
-- 7. RECONCILIACIÓN PERIÓDICA VIA pg_cron (Si está disponible)
-- ============================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        -- Desprogramar trabajo previo si existiera para garantizar idempotencia
        BEGIN
            PERFORM cron.unschedule('reconciliar_domain_events_job');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        -- Programar reconciliación cada 2 minutos
        PERFORM cron.schedule(
            'reconciliar_domain_events_job',
            '*/2 * * * *',
            'SELECT public.reconciliar_domain_events_seguro();'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    -- No fallar la migración si pg_cron no está disponible en este entorno
    NULL;
END $$;

COMMIT;
