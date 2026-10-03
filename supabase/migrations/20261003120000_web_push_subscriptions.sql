-- ============================================================
-- Migración: 20261003120000_web_push_subscriptions.sql
-- Fase 3A: Fundación PWA + Web Push — destinos de entrega por dispositivo
--
-- Alcance: SOLO persiste y gestiona suscripciones Web Push (multidispositivo).
-- NO envía notificaciones y NO se conecta a la bandeja de notificaciones ni a
-- colas de eventos (eso pertenece a Fase 3B).
--
-- Modelo:
--   * Una fila por suscripción física del navegador (endpoint único global).
--   * Un usuario puede tener N dispositivos activos simultáneamente.
--   * El endpoint + claves son datos privados: la tabla NO es accesible
--     directamente por anon/authenticated; solo mediante RPCs SECURITY DEFINER
--     que usan auth.uid() como única identidad.
--   * Si el mismo endpoint se registra desde otra cuenta (dispositivo
--     compartido tras un logout cuya revocación falló), el registro reasigna
--     la fila: quien presenta endpoint + claves posee la suscripción física.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.web_push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh_key TEXT NOT NULL,
    auth_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    revoked_at TIMESTAMPTZ DEFAULT NULL,

    CONSTRAINT check_web_push_status CHECK (status IN ('active', 'revoked')),
    CONSTRAINT check_web_push_endpoint CHECK (
        endpoint ~ '^https://' AND pg_catalog.length(endpoint) <= 2048
    ),
    CONSTRAINT check_web_push_p256dh CHECK (
        p256dh_key ~ '^[A-Za-z0-9_-]+={0,2}$' AND pg_catalog.length(p256dh_key) BETWEEN 16 AND 256
    ),
    CONSTRAINT check_web_push_auth CHECK (
        auth_key ~ '^[A-Za-z0-9_-]+={0,2}$' AND pg_catalog.length(auth_key) BETWEEN 8 AND 128
    ),
    CONSTRAINT check_web_push_revoked_at CHECK (
        (status = 'revoked' AND revoked_at IS NOT NULL) OR (status = 'active' AND revoked_at IS NULL)
    )
);

-- Un endpoint identifica una única suscripción física
CREATE UNIQUE INDEX IF NOT EXISTS uq_web_push_subscriptions_endpoint
    ON public.web_push_subscriptions (endpoint);

-- Consulta futura de destinos activos por usuario (Fase 3B)
CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user_active
    ON public.web_push_subscriptions (user_id)
    WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_web_push_subscriptions_updated_at ON public.web_push_subscriptions;
CREATE TRIGGER trg_web_push_subscriptions_updated_at
    BEFORE UPDATE ON public.web_push_subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS activa y SIN policies para anon/authenticated: acceso directo denegado.
ALTER TABLE public.web_push_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.web_push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.web_push_subscriptions TO postgres, service_role;


-- ============================================================
-- RPC 1: registrar_web_push_subscription_seguro
-- Idempotente por endpoint. Reactiva revocadas. Actualiza last_seen_at.
-- No devuelve endpoint ni claves.
-- ============================================================
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


-- ============================================================
-- RPC 2: revocar_web_push_subscription_seguro
-- Solo opera sobre la suscripción del usuario autenticado. Idempotente.
-- ============================================================
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
    v_count INTEGER := 0;
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

    UPDATE public.web_push_subscriptions
    SET status = 'revoked',
        revoked_at = v_now
    WHERE endpoint = p_endpoint
      AND user_id = v_user_id
      AND status = 'active';

    GET DIAGNOSTICS v_count = ROW_COUNT;

    -- Idempotente: ok=true aunque no hubiese nada que revocar o el endpoint sea ajeno.
    RETURN pg_catalog.jsonb_build_object('ok', true, 'revoked', v_count > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.revocar_web_push_subscription_seguro(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revocar_web_push_subscription_seguro(TEXT) TO authenticated;


-- ============================================================
-- RPC 3: get_web_push_device_status_seguro
-- Estado seguro: sin endpoint/claves en la respuesta.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_web_push_device_status_seguro(
    p_endpoint TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_subscribed BOOLEAN := false;
    v_count INTEGER := 0;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_endpoint IS NOT NULL AND pg_catalog.length(p_endpoint) > 0 THEN
        SELECT EXISTS (
            SELECT 1 FROM public.web_push_subscriptions
            WHERE endpoint = p_endpoint
              AND user_id = v_user_id
              AND status = 'active'
        ) INTO v_subscribed;
    END IF;

    SELECT pg_catalog.count(*)::INTEGER INTO v_count
    FROM public.web_push_subscriptions
    WHERE user_id = v_user_id AND status = 'active';

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'subscribed', v_subscribed,
        'active_device_count', v_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_web_push_device_status_seguro(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_web_push_device_status_seguro(TEXT) TO authenticated;

COMMIT;
