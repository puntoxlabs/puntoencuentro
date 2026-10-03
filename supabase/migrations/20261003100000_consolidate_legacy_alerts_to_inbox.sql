-- ============================================================
-- Migración: 20261003100000_consolidate_legacy_alerts_to_inbox.sql
-- Módulo: Consolidación de alertas legacy en Inbox de Notificaciones
-- Reemplaza alertas_compatibilidad por domain_events_outbox -> inbox_notifications
-- ============================================================

BEGIN;

-- ============================================================
-- 1. BACKFILL IDEMPOTENTE: alertas_compatibilidad -> inbox_notifications
-- Migra alertas históricas de Caso C preservando estado de lectura,
-- created_at y aplicando política de retención de 14 días.
-- ============================================================
INSERT INTO public.inbox_notifications (
    recipient_user_id,
    notification_type,
    target_type,
    target_id,
    deep_link,
    title,
    body,
    payload,
    read_at,
    dedup_key,
    expires_at,
    created_at
)
SELECT
    a.user_id,
    'interes_convertido',
    'encounter',
    a.target_encuentro_id,
    pg_catalog.format('/?open_encounter=%s', a.target_encuentro_id),
    'Intención convertida en encuentro',
    COALESCE(
        'Una intención que te interesaba se convirtió en un encuentro abierto: ' || e.titulo,
        'Una intención que te interesaba se convirtió en un encuentro abierto.'
    ),
    pg_catalog.jsonb_build_object(
        'source_intencion_id', a.source_intencion_id,
        'target_encuentro_id', a.target_encuentro_id,
        'legacy_alert_id', a.id
    ),
    CASE WHEN a.leida THEN a.created_at ELSE NULL END,
    pg_catalog.format('intention:%s:encounter:%s', a.source_intencion_id, a.target_encuentro_id),
    a.created_at + INTERVAL '14 days',
    a.created_at
FROM public.alertas_compatibilidad a
LEFT JOIN public.encuentros e ON e.id = a.target_encuentro_id
WHERE a.created_at >= (pg_catalog.clock_timestamp() - INTERVAL '14 days')
ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;

-- Documentar deprecación de tabla legacy
COMMENT ON TABLE public.alertas_compatibilidad IS 
    'DEPRECATED: Alertas migradas a public.inbox_notifications. Conservada solo lectura/histórico hasta 14 días post-consolidación.';

COMMENT ON FUNCTION public.get_mis_alertas_seguro() IS 
    'DEPRECATED: Utilizar public.get_mis_notificaciones_inbox_seguro(). Conservada para rollback e histórico.';

COMMENT ON FUNCTION public.marcar_alerta_leida_seguro(UUID) IS 
    'DEPRECATED: Utilizar public.marcar_notificacion_leida_seguro(). Conservada para rollback e histórico.';


-- ============================================================
-- 2. HELPER: emitir_alertas_intencion_convertida_outbox
-- Emite eventos 'intention.converted_to_encounter.v1' al Transactional Outbox
-- para todos los usuarios con interés previo en la intención,
-- excluyendo al host, autor de intención y usuarios con bloqueo bilateral.
-- ============================================================
CREATE OR REPLACE FUNCTION public.emitir_alertas_intencion_convertida_outbox(
    p_intencion_id UUID,
    p_encuentro_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_encuentro RECORD;
    v_intencion RECORD;
    v_interested RECORD;
    v_emitted_count INTEGER := 0;
    v_dedup_key TEXT;
    v_payload JSONB;
BEGIN
    IF p_intencion_id IS NULL OR p_encuentro_id IS NULL THEN
        RETURN 0;
    END IF;

    -- Obtener encuentro (debe existir, estar activo y abierto)
    SELECT id, host_id, titulo, is_open, estado
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND OR NOT v_encuentro.is_open OR v_encuentro.estado <> 'activo' THEN
        RETURN 0;
    END IF;

    -- Obtener intención (debe existir y estar convertida a este encuentro)
    SELECT id, user_id, estado, encuentro_id
    INTO v_intencion
    FROM public.intenciones
    WHERE id = p_intencion_id;

    IF NOT FOUND OR v_intencion.estado <> 'convertida' OR v_intencion.encuentro_id IS DISTINCT FROM p_encuentro_id THEN
        RETURN 0;
    END IF;

    -- Iterar sobre interesados válidos (excluyendo host, autor de intención y bloqueos bilaterales)
    FOR v_interested IN
        SELECT DISTINCT ii.user_id
        FROM public.intencion_intereses ii
        WHERE ii.intencion_id = p_intencion_id
          AND ii.user_id <> v_encuentro.host_id
          AND ii.user_id <> v_intencion.user_id
          AND NOT EXISTS (
              SELECT 1 FROM public.bloqueos_usuario b
              WHERE (b.blocker_id = ii.user_id AND b.blocked_id = v_encuentro.host_id)
                 OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = ii.user_id)
          )
    LOOP
        v_dedup_key := pg_catalog.format(
            'intention_conversion:intention:%s:encounter:%s:user:%s',
            p_intencion_id,
            p_encuentro_id,
            v_interested.user_id
        );

        v_payload := pg_catalog.jsonb_build_object(
            'recipient_user_id', v_interested.user_id,
            'intencion_id', p_intencion_id,
            'encounter_id', p_encuentro_id,
            'encounter_title', v_encuentro.titulo,
            'title', 'Intención convertida en encuentro',
            'body', 'Una intención que te interesaba se convirtió en un encuentro abierto: ' || v_encuentro.titulo,
            'deep_link', pg_catalog.format('/?open_encounter=%s', p_encuentro_id),
            'dedup_key', pg_catalog.format('intention:%s:encounter:%s', p_intencion_id, p_encuentro_id)
        );

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
            'intention.converted_to_encounter.v1',
            1,
            'encounter',
            p_encuentro_id,
            v_encuentro.host_id,
            v_payload,
            v_dedup_key,
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;

        IF FOUND THEN
            v_emitted_count := v_emitted_count + 1;
        END IF;
    END LOOP;

    RETURN v_emitted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.emitir_alertas_intencion_convertida_outbox(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emitir_alertas_intencion_convertida_outbox(UUID, UUID) TO authenticated, service_role;


-- ============================================================
-- 3. ACTUALIZACIÓN DE RPC: convertir_intencion_a_encuentro
-- Reemplaza la inserción en alertas_compatibilidad por emisión Outbox moderna.
-- Solo emite si el encuentro ya está abierto al público (is_open = true).
-- ============================================================
CREATE OR REPLACE FUNCTION public.convertir_intencion_a_encuentro(
    p_intencion_id UUID,
    p_encuentro_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_intencion RECORD;
    v_encuentro RECORD;
BEGIN
    -- 1. Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- 2. Rechazar cuentas anónimas (se requiere cuenta permanente)
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 3. Validar parámetros requeridos
    IF p_intencion_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_intencion_id');
    END IF;

    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_encuentro_id');
    END IF;

    -- 4. Obtener y bloquear intención para concurrencia atómica
    SELECT id, user_id, estado, encuentro_id
    INTO v_intencion
    FROM public.intenciones
    WHERE id = p_intencion_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 5. Validar propiedad de la intención
    IF v_intencion.user_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 6. Idempotencia: si ya está convertida a este mismo encuentro
    IF v_intencion.estado = 'convertida' AND v_intencion.encuentro_id = p_encuentro_id THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'id', p_intencion_id,
            'encuentro_id', p_encuentro_id,
            'estado', 'convertida',
            'idempotent', true
        );
    END IF;

    -- 7. Si está convertida a otro encuentro, rechazar
    IF v_intencion.estado = 'convertida' AND v_intencion.encuentro_id IS DISTINCT FROM p_encuentro_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'already_converted');
    END IF;

    -- 8. Si está cerrada, rechazar
    IF v_intencion.estado = 'cerrada' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intention_closed');
    END IF;

    -- 9. Sólo se puede convertir si está 'activa' o 'pausada'
    IF v_intencion.estado NOT IN ('activa', 'pausada') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_state');
    END IF;

    -- 10. Validar existencia y propiedad del encuentro
    SELECT id, host_id, is_open
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized_encounter');
    END IF;

    -- 11. Actualización atómica de la intención
    UPDATE public.intenciones
    SET estado = 'convertida',
        encuentro_id = p_encuentro_id,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_intencion_id AND user_id = v_user_id;

    -- 12. Generación atómica de eventos en Outbox para usuarios interesados (Fase Consolidación Inbox)
    -- ÚNICAMENTE si el encuentro vinculado ya está abierto al público (is_open = true).
    -- Si es privado, los eventos se diferirán hasta su apertura formal vía abrir_encuentro_seguro.
    IF v_encuentro.is_open = true THEN
        PERFORM public.emitir_alertas_intencion_convertida_outbox(p_intencion_id, p_encuentro_id);
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'id', p_intencion_id,
        'encuentro_id', p_encuentro_id,
        'estado', 'convertida'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.convertir_intencion_a_encuentro(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_intencion_a_encuentro(UUID, UUID) TO authenticated;


-- ============================================================
-- 4. ACTUALIZACIÓN DE RPC: abrir_encuentro_seguro
-- Cuando un encuentro pasa de false a true, emite encounter.opened.v1
-- y además emite eventos de intención convertida para intenciones vinculadas.
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
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_conv_intencion RECORD;
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

    IF NOT v_encuentro.is_open THEN
        -- Transición real cerrado -> abierto (false -> true)
        UPDATE public.encuentros
        SET is_open = true,
            open_description = NULLIF(trim(p_open_description), ''),
            max_participants = p_max_participants,
            locality_id = p_locality_id,
            open_public_zone = NULLIF(trim(p_open_public_zone), ''),
            opened_at = v_now,
            closed_at = NULL
        WHERE id = p_encuentro_id;

        -- Emitir eventos outbox para usuarios interesados en intenciones convertidas previamente (Fase Consolidación Inbox)
        FOR v_conv_intencion IN
            SELECT id
            FROM public.intenciones
            WHERE encuentro_id = p_encuentro_id
              AND estado = 'convertida'
        LOOP
            PERFORM public.emitir_alertas_intencion_convertida_outbox(v_conv_intencion.id, p_encuentro_id);
        END LOOP;

        -- Emisión del Domain Event: encounter.opened.v1 (Transactional Outbox)
        -- Dedup key vinculada al timestamp específico de esta apertura (ciclo concreto)
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
                'max_participants', p_max_participants,
                'opened_at', v_now
            ),
            format('encounter:%s:opened:%s', p_encuentro_id, extract(epoch from v_now)::text),
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;
    ELSE
        -- Ya está abierto: actualizar configuración sin alterar opened_at ni emitir encounter.opened.v1
        UPDATE public.encuentros
        SET open_description = NULLIF(trim(p_open_description), ''),
            max_participants = p_max_participants,
            locality_id = p_locality_id,
            open_public_zone = NULLIF(trim(p_open_public_zone), '')
        WHERE id = p_encuentro_id;
    END IF;

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

COMMIT;
