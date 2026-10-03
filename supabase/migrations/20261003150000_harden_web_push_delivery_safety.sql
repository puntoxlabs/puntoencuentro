-- ============================================================
-- Migración: 20261003150000_harden_web_push_delivery_safety.sql
-- Fase 3B Hardening: Mitigación de carrera de dispositivo compartido,
-- verificación pre-despacho atómica y protección estricta de privacidad.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. RPC: verificar_delivery_activo_seguro
-- Verifica inmediatamente antes del despacho HTTP que la entrega
-- sigue en estado 'processing' y que el dispositivo continúa activo
-- y pertenece legítimamente al destinatario original.
-- ============================================================
CREATE OR REPLACE FUNCTION public.verificar_delivery_activo_seguro(
    p_delivery_id UUID,
    p_expected_recipient_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_is_valid BOOLEAN := false;
BEGIN
    IF p_delivery_id IS NULL OR p_expected_recipient_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.notification_delivery_outbox d
        JOIN public.web_push_subscriptions s ON s.id = d.web_push_subscription_id
        WHERE d.id = p_delivery_id
          AND d.status = 'processing'
          AND d.recipient_user_id = p_expected_recipient_id
          AND s.user_id = p_expected_recipient_id
          AND s.status = 'active'
    ) INTO v_is_valid;

    RETURN v_is_valid;
END;
$$;

REVOKE ALL ON FUNCTION public.verificar_delivery_activo_seguro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verificar_delivery_activo_seguro(UUID, UUID) TO service_role;


-- ============================================================
-- 2. Actualización de registrar_web_push_subscription_seguro
-- Previene la adopción silenciosa de un endpoint ajeno en dispositivos compartidos.
-- Si el endpoint pertenecía a otro usuario:
--   1. Revoca la suscripción previa;
--   2. Cancela inmediatamente todas sus entregas pendientes Y en procesamiento;
--   3. Rechaza la reasignación para obligar al cliente a crear una PushSubscription fresca.
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
    v_prev_user_id UUID;
    v_prev_sub_id UUID;
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

    -- Obtener si existía un dueño anterior para detectar dispositivo compartido
    SELECT id, user_id INTO v_prev_sub_id, v_prev_user_id
    FROM public.web_push_subscriptions
    WHERE endpoint = p_endpoint;

    -- Si el endpoint pertenece a otro usuario en un dispositivo compartido:
    -- NO mutar silenciosamente user_id. Revocar el anterior, cancelar sus entregas
    -- y requerir al cliente una suscripción fresca con nuevas claves.
    IF v_prev_user_id IS NOT NULL AND v_prev_user_id <> v_user_id THEN
        -- 1. Revocar la suscripción física del usuario anterior
        UPDATE public.web_push_subscriptions
        SET status = 'revoked',
            revoked_at = v_now
        WHERE id = v_prev_sub_id;

        -- 2. Cancelar inmediatamente todas las entregas (pending Y processing)
        UPDATE public.notification_delivery_outbox
        SET status = 'cancelled',
            last_error = 'Device ownership transfer - cancelled for privacy',
            updated_at = v_now
        WHERE web_push_subscription_id = v_prev_sub_id
          AND status IN ('pending', 'processing');

        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'device_reassigned_needs_new_subscription'
        );
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
-- 3. Actualización de revocar_web_push_subscription_seguro
-- Cancela entregas tanto en 'pending' como en 'processing'
-- cuando el usuario revoca o cierra sesión.
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

        -- Cancelar entregas pendientes y en procesamiento de este dispositivo
        UPDATE public.notification_delivery_outbox
        SET status = 'cancelled',
            last_error = 'Device revoked by user',
            updated_at = v_now
        WHERE web_push_subscription_id = v_sub_id
          AND status IN ('pending', 'processing');
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.revocar_web_push_subscription_seguro(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revocar_web_push_subscription_seguro(TEXT) TO authenticated;

COMMIT;
