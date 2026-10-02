-- ============================================================
-- Migración: 20261002210000_fase_2a_match_alert_subscriptions.sql
-- Módulo: Fase 2A — Backend de "Avisame" + Matching Determinístico
-- Suscripciones explícitas, lifecycle, matching determinístico sin IA
-- y emisión idempotente a transactional outbox (match.detected.v1).
-- ============================================================

BEGIN;

-- 1. TABLA: public.match_alert_subscriptions
CREATE TABLE IF NOT EXISTS public.match_alert_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'expired', 'cancelled')),
    modalidad TEXT DEFAULT NULL
        CHECK (modalidad IS NULL OR modalidad IN ('presencial', 'virtual', 'indistinto')),
    locality_id TEXT DEFAULT NULL REFERENCES public.localidades(id) ON DELETE SET NULL,
    fecha_desde DATE DEFAULT NULL,
    fecha_hasta DATE DEFAULT NULL,
    hora_desde TIME WITHOUT TIME ZONE DEFAULT NULL,
    hora_hasta TIME WITHOUT TIME ZONE DEFAULT NULL,
    expires_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    CONSTRAINT check_match_alert_fechas CHECK (
        fecha_desde IS NULL OR fecha_hasta IS NULL OR fecha_desde <= fecha_hasta
    ),
    CONSTRAINT check_match_alert_horas CHECK (
        hora_desde IS NULL OR hora_hasta IS NULL OR hora_desde <= hora_hasta
    )
);

-- Índices optimizados para candidate matching y administración
CREATE INDEX IF NOT EXISTS idx_match_alerts_candidate_search 
    ON public.match_alert_subscriptions (status, modalidad, locality_id) 
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_match_alerts_user_status 
    ON public.match_alert_subscriptions (user_id, status);

CREATE INDEX IF NOT EXISTS idx_match_alerts_expires_at 
    ON public.match_alert_subscriptions (expires_at) 
    WHERE status = 'active' AND expires_at IS NOT NULL;

-- Trigger automático de updated_at
DROP TRIGGER IF EXISTS trg_match_alert_subscriptions_updated_at ON public.match_alert_subscriptions;
CREATE TRIGGER trg_match_alert_subscriptions_updated_at
    BEFORE UPDATE ON public.match_alert_subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.match_alert_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.match_alert_subscriptions FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.match_alert_subscriptions TO authenticated;
GRANT ALL ON TABLE public.match_alert_subscriptions TO postgres, service_role;

DROP POLICY IF EXISTS match_alert_subscriptions_select_own ON public.match_alert_subscriptions;
CREATE POLICY match_alert_subscriptions_select_own ON public.match_alert_subscriptions
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id);


-- ============================================================
-- 2. RPCS PÚBLICAS: ADMINISTRACIÓN DE SUSCRIPCIONES
-- ============================================================

-- 2.1. crear_alerta_suscripcion_seguro
CREATE OR REPLACE FUNCTION public.crear_alerta_suscripcion_seguro(
    p_modalidad TEXT DEFAULT NULL,
    p_locality_id TEXT DEFAULT NULL,
    p_fecha_desde DATE DEFAULT NULL,
    p_fecha_hasta DATE DEFAULT NULL,
    p_hora_desde TIME WITHOUT TIME ZONE DEFAULT NULL,
    p_hora_hasta TIME WITHOUT TIME ZONE DEFAULT NULL,
    p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_locality_exists BOOLEAN := false;
    v_new_id UUID;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_result RECORD;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- Validar modalidad
    IF p_modalidad IS NOT NULL AND p_modalidad NOT IN ('presencial', 'virtual', 'indistinto') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_modality');
    END IF;

    -- Validar localidad
    IF p_locality_id IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM public.localidades WHERE id = p_locality_id AND activo = true)
        INTO v_locality_exists;

        IF NOT v_locality_exists THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_locality');
        END IF;
    END IF;

    -- Validar coherencia de fechas
    IF p_fecha_desde IS NOT NULL AND p_fecha_hasta IS NOT NULL AND p_fecha_desde > p_fecha_hasta THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_date_range');
    END IF;

    -- Validar coherencia de horas
    IF p_hora_desde IS NOT NULL AND p_hora_hasta IS NOT NULL AND p_hora_desde > p_hora_hasta THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_time_range');
    END IF;

    -- Validar vigencia futura si se especificó
    IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_expiration');
    END IF;

    INSERT INTO public.match_alert_subscriptions (
        user_id,
        status,
        modalidad,
        locality_id,
        fecha_desde,
        fecha_hasta,
        hora_desde,
        hora_hasta,
        expires_at
    ) VALUES (
        v_user_id,
        'active',
        NULLIF(trim(p_modalidad), ''),
        NULLIF(trim(p_locality_id), ''),
        p_fecha_desde,
        p_fecha_hasta,
        p_hora_desde,
        p_hora_hasta,
        p_expires_at
    )
    RETURNING * INTO v_result;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'subscription', pg_catalog.jsonb_build_object(
            'id', v_result.id,
            'user_id', v_result.user_id,
            'status', v_result.status,
            'modalidad', v_result.modalidad,
            'locality_id', v_result.locality_id,
            'fecha_desde', v_result.fecha_desde,
            'fecha_hasta', v_result.fecha_hasta,
            'hora_desde', v_result.hora_desde,
            'hora_hasta', v_result.hora_hasta,
            'expires_at', v_result.expires_at,
            'created_at', v_result.created_at,
            'updated_at', v_result.updated_at
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.crear_alerta_suscripcion_seguro(TEXT, TEXT, DATE, DATE, TIME WITHOUT TIME ZONE, TIME WITHOUT TIME ZONE, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_alerta_suscripcion_seguro(TEXT, TEXT, DATE, DATE, TIME WITHOUT TIME ZONE, TIME WITHOUT TIME ZONE, TIMESTAMPTZ) TO authenticated;


-- 2.2. get_mis_alertas_suscripciones_seguro
CREATE OR REPLACE FUNCTION public.get_mis_alertas_suscripciones_seguro()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_items JSONB := '[]'::jsonb;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', s.id,
            'user_id', s.user_id,
            'status', CASE 
                WHEN s.status = 'active' AND s.expires_at IS NOT NULL AND s.expires_at <= v_now THEN 'expired'
                ELSE s.status
            END,
            'modalidad', s.modalidad,
            'locality_id', s.locality_id,
            'locality_nombre', l.nombre,
            'fecha_desde', s.fecha_desde,
            'fecha_hasta', s.fecha_hasta,
            'hora_desde', s.hora_desde,
            'hora_hasta', s.hora_hasta,
            'expires_at', s.expires_at,
            'created_at', s.created_at,
            'updated_at', s.updated_at
        ) ORDER BY s.created_at DESC
    ), '[]'::jsonb)
    INTO v_items
    FROM public.match_alert_subscriptions s
    LEFT JOIN public.localidades l ON s.locality_id = l.id
    WHERE s.user_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'subscriptions', v_items,
        'data', v_items
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_mis_alertas_suscripciones_seguro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mis_alertas_suscripciones_seguro() TO authenticated;


-- 2.3. pausar_alerta_suscripcion_seguro
CREATE OR REPLACE FUNCTION public.pausar_alerta_suscripcion_seguro(
    p_subscription_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_sub RECORD;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_subscription_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_subscription_id');
    END IF;

    SELECT id, user_id, status
    INTO v_sub
    FROM public.match_alert_subscriptions
    WHERE id = p_subscription_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'subscription_not_found');
    END IF;

    IF v_sub.user_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_sub.status = 'cancelled' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'already_cancelled');
    END IF;

    IF v_sub.status = 'paused' THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_subscription_id, 'status', 'paused');
    END IF;

    UPDATE public.match_alert_subscriptions
    SET status = 'paused',
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_subscription_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_subscription_id, 'status', 'paused');
END;
$$;

REVOKE ALL ON FUNCTION public.pausar_alerta_suscripcion_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pausar_alerta_suscripcion_seguro(UUID) TO authenticated;


-- 2.4. reactivar_alerta_suscripcion_seguro
CREATE OR REPLACE FUNCTION public.reactivar_alerta_suscripcion_seguro(
    p_subscription_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_sub RECORD;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_subscription_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_subscription_id');
    END IF;

    SELECT id, user_id, status, expires_at
    INTO v_sub
    FROM public.match_alert_subscriptions
    WHERE id = p_subscription_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'subscription_not_found');
    END IF;

    IF v_sub.user_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_sub.status = 'cancelled' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'already_cancelled');
    END IF;

    IF v_sub.expires_at IS NOT NULL AND v_sub.expires_at <= v_now THEN
        UPDATE public.match_alert_subscriptions
        SET status = 'expired',
            updated_at = v_now
        WHERE id = p_subscription_id;

        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF v_sub.status = 'active' THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_subscription_id, 'status', 'active');
    END IF;

    UPDATE public.match_alert_subscriptions
    SET status = 'active',
        updated_at = v_now
    WHERE id = p_subscription_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_subscription_id, 'status', 'active');
END;
$$;

REVOKE ALL ON FUNCTION public.reactivar_alerta_suscripcion_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reactivar_alerta_suscripcion_seguro(UUID) TO authenticated;


-- 2.5. cancelar_alerta_suscripcion_seguro
CREATE OR REPLACE FUNCTION public.cancelar_alerta_suscripcion_seguro(
    p_subscription_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_sub RECORD;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_subscription_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_subscription_id');
    END IF;

    SELECT id, user_id, status
    INTO v_sub
    FROM public.match_alert_subscriptions
    WHERE id = p_subscription_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'subscription_not_found');
    END IF;

    IF v_sub.user_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_sub.status = 'cancelled' THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_subscription_id, 'status', 'cancelled');
    END IF;

    UPDATE public.match_alert_subscriptions
    SET status = 'cancelled',
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_subscription_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_subscription_id, 'status', 'cancelled');
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_alerta_suscripcion_seguro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_alerta_suscripcion_seguro(UUID) TO authenticated;


-- ============================================================
-- 3. MOTOR DE MATCHING DETERMINÍSTICO Y EMISIÓN DE EVENTOS
-- ============================================================

-- 3.1. evaluar_matching_encuentro_abierto
-- Compara un Encuentro Abierto elegible contra suscripciones activas
-- utilizando exclusivamente reglas determinísticas normalizadas.
-- Emite 'match.detected.v1' al transactional outbox con dedup_key idempotente.
CREATE OR REPLACE FUNCTION public.evaluar_matching_encuentro_abierto(
    p_encuentro_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_encuentro RECORD;
    v_candidate RECORD;
    v_matched_count INT := 0;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_dedup_key TEXT;
    v_payload JSONB;
    v_expires_at TIMESTAMPTZ;
BEGIN
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_encuentro_id');
    END IF;

    -- Obtener encuentro abierto activo
    SELECT 
        e.id,
        e.titulo,
        e.descripcion,
        e.fecha,
        e.hora,
        e.modalidad,
        e.locality_id,
        e.host_id,
        COALESCE(e.open_public_zone, l.nombre, 'Zona aproximada') AS zone_text
    INTO v_encuentro
    FROM public.encuentros e
    LEFT JOIN public.localidades l ON e.locality_id = l.id
    WHERE e.id = p_encuentro_id
      AND e.is_open = true
      AND e.estado = 'activo';

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'matches_count', 0, 'reason', 'encuentro_not_eligible');
    END IF;

    -- Buscar alertas activas compatibles
    FOR v_candidate IN
        SELECT 
            s.id AS subscription_id,
            s.user_id,
            s.modalidad,
            s.locality_id,
            s.fecha_desde,
            s.fecha_hasta,
            s.hora_desde,
            s.hora_hasta
        FROM public.match_alert_subscriptions s
        WHERE s.status = 'active'
          AND (s.expires_at IS NULL OR s.expires_at > v_now)
          -- 1. No notificar al propio host del encuentro
          AND (v_encuentro.host_id IS NULL OR s.user_id <> v_encuentro.host_id)
          -- 2. Bloqueo bilateral
          AND NOT EXISTS (
              SELECT 1 FROM public.bloqueos_usuario b
              WHERE (b.blocker_id = s.user_id AND b.blocked_id = v_encuentro.host_id)
                 OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = s.user_id)
          )
          -- 3. Modalidad: coincidencia exacta o wildcard si la suscripción no especifica o es 'indistinto'
          AND (s.modalidad IS NULL OR s.modalidad = 'indistinto' OR s.modalidad = v_encuentro.modalidad)
          -- 4. Localidad/Zona: para virtual es wildcard geográfico; para presencial, exact match si s.locality_id está definida, wildcard si NULL
          AND (v_encuentro.modalidad = 'virtual' OR s.locality_id IS NULL OR s.locality_id = v_encuentro.locality_id)
          -- 5. Rango de Fechas: wildcard si extremos están ausentes
          AND (s.fecha_desde IS NULL OR v_encuentro.fecha IS NULL OR v_encuentro.fecha >= s.fecha_desde)
          AND (s.fecha_hasta IS NULL OR v_encuentro.fecha IS NULL OR v_encuentro.fecha <= s.fecha_hasta)
          -- 6. Rango Horario: wildcard si extremos están ausentes
          AND (s.hora_desde IS NULL OR v_encuentro.hora IS NULL OR v_encuentro.hora >= s.hora_desde)
          AND (s.hora_hasta IS NULL OR v_encuentro.hora IS NULL OR v_encuentro.hora <= s.hora_hasta)
    LOOP
        v_dedup_key := pg_catalog.format('match:%s:%s:v1', v_candidate.subscription_id, v_encuentro.id);

        -- Expiración de la notificación: día posterior al encuentro, o 30 días si no tiene fecha
        IF v_encuentro.fecha IS NOT NULL THEN
            v_expires_at := (v_encuentro.fecha + INTERVAL '1 day')::timestamptz;
        ELSE
            v_expires_at := v_now + INTERVAL '30 days';
        END IF;

        v_payload := pg_catalog.jsonb_build_object(
            'subscription_id', v_candidate.subscription_id,
            'recipient_user_id', v_candidate.user_id,
            'encounter_id', v_encuentro.id,
            'encounter_title', v_encuentro.titulo,
            'modality', v_encuentro.modalidad,
            'date', v_encuentro.fecha,
            'time', v_encuentro.hora,
            'locality_id', v_encuentro.locality_id,
            'zone', v_encuentro.zone_text,
            'title', 'Nuevo encuentro compatible',
            'body', 'Se publicó un encuentro que coincide con tu alerta: ' || v_encuentro.titulo,
            'deep_link', pg_catalog.format('/?open_encounter=%s', v_encuentro.id),
            'dedup_key', v_dedup_key,
            'expires_at', v_expires_at
        );

        -- Inserción idempotente en el outbox transaccional
        INSERT INTO public.domain_events_outbox (
            event_type,
            event_version,
            aggregate_type,
            aggregate_id,
            actor_user_id,
            payload,
            dedup_key,
            status
        ) VALUES (
            'match.detected.v1',
            1,
            'encounter',
            v_encuentro.id,
            v_encuentro.host_id,
            v_payload,
            v_dedup_key,
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;

        IF FOUND THEN
            v_matched_count := v_matched_count + 1;
        END IF;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'encuentro_id', v_encuentro.id,
        'matches_count', v_matched_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluar_matching_encuentro_abierto(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.evaluar_matching_encuentro_abierto(UUID) TO authenticated, service_role;


-- ============================================================
-- 4. INTEGRACIÓN DE PRODUCTOR: abrir_encuentro_seguro
-- Emite encounter.opened.v1 y evalúa matching determinístico en el mismo commit.
-- ============================================================
CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT,
    p_open_public_zone TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_locality_exists BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_inactive');
    END IF;

    -- Validar localidad
    SELECT EXISTS (SELECT 1 FROM public.localidades WHERE id = p_locality_id AND activo = true)
    INTO v_locality_exists;

    IF NOT v_locality_exists THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_locality');
    END IF;

    -- Validar cupo
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado = 'confirmado';

    IF p_max_participants < (v_confirmed_count + 1) THEN
        RETURN json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    IF p_max_participants < 2 THEN
        RETURN json_build_object('ok', false, 'error', 'min_two_participants');
    END IF;

    -- Publicar/abrir el encuentro
    UPDATE public.encuentros
    SET is_open = true,
        open_description = NULLIF(trim(p_open_description), ''),
        max_participants = p_max_participants,
        locality_id = p_locality_id,
        open_public_zone = NULLIF(trim(p_open_public_zone), ''),
        opened_at = now(),
        closed_at = NULL
    WHERE id = p_encuentro_id;

    -- Disparar alertas para usuarios interesados en intenciones convertidas (Fase 2.0-C1 compatibilidad)
    INSERT INTO public.alertas_compatibilidad (
        user_id,
        tipo,
        source_intencion_id,
        target_encuentro_id
    )
    SELECT
        ii.user_id,
        'interes_convertido',
        i.id,
        p_encuentro_id
    FROM public.intenciones i
    JOIN public.intencion_intereses ii ON ii.intencion_id = i.id
    WHERE i.encuentro_id = p_encuentro_id
      AND ii.user_id <> v_user_id
    ON CONFLICT (user_id, tipo, source_intencion_id, target_encuentro_id) DO NOTHING;

    -- Emisión del Domain Event: encounter.opened.v1 (Transactional Outbox)
    INSERT INTO public.domain_events_outbox (
        event_type,
        event_version,
        aggregate_type,
        aggregate_id,
        actor_user_id,
        payload,
        dedup_key,
        status
    ) VALUES (
        'encounter.opened.v1',
        1,
        'encounter',
        p_encuentro_id,
        v_user_id,
        jsonb_build_object(
            'encounter_id', p_encuentro_id,
            'host_id', v_user_id,
            'locality_id', p_locality_id,
            'max_participants', p_max_participants
        ),
        format('encounter:opened:%s:v1', p_encuentro_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    RETURN json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'is_open', true,
        'max_participants', p_max_participants,
        'locality_id', p_locality_id,
        'open_public_zone', p_open_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    TO authenticated;


-- ============================================================
-- 4. TRIGGER: encounter.updated.v1 (Transactional Outbox)
-- Emite evento al cambiar criterios relevantes de matching en
-- encuentros que continúan abiertos.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_trg_encounter_updated_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Solo aplica si el encuentro ya estaba abierto y continúa abierto y activo
    IF OLD.is_open = true AND NEW.is_open = true AND NEW.estado = 'activo' THEN
        -- Evaluar si cambió algún criterio relevante de matching determinístico
        IF (OLD.fecha IS DISTINCT FROM NEW.fecha)
           OR (OLD.hora IS DISTINCT FROM NEW.hora)
           OR (OLD.modalidad IS DISTINCT FROM NEW.modalidad)
           OR (OLD.locality_id IS DISTINCT FROM NEW.locality_id) THEN

            INSERT INTO public.domain_events_outbox (
                event_type,
                event_version,
                aggregate_type,
                aggregate_id,
                actor_user_id,
                payload,
                dedup_key,
                status
            ) VALUES (
                'encounter.updated.v1',
                1,
                'encounter',
                NEW.id,
                NEW.host_id,
                pg_catalog.jsonb_build_object(
                    'encounter_id', NEW.id,
                    'host_id', NEW.host_id,
                    'fecha', NEW.fecha,
                    'hora', NEW.hora,
                    'modalidad', NEW.modalidad,
                    'locality_id', NEW.locality_id,
                    'changes', pg_catalog.jsonb_build_object(
                        'fecha', (OLD.fecha IS DISTINCT FROM NEW.fecha),
                        'hora', (OLD.hora IS DISTINCT FROM NEW.hora),
                        'modalidad', (OLD.modalidad IS DISTINCT FROM NEW.modalidad),
                        'locality_id', (OLD.locality_id IS DISTINCT FROM NEW.locality_id)
                    )
                ),
                pg_catalog.format('encounter:%s:updated:%s', NEW.id, pg_catalog.gen_random_uuid()),
                'pending'
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_encounter_updated_outbox ON public.encuentros;
CREATE TRIGGER trg_encounter_updated_outbox
    AFTER UPDATE ON public.encuentros
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_encounter_updated_outbox();

COMMIT;
