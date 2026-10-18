-- ============================================================
-- Migración: 20261018180000_internal_invitations_v1.sql
-- Módulo: Invitaciones Internas V1 entre usuarios registrados
-- Tablas: invitaciones_internas
-- RPCs:
--   - enviar_invitacion_interna_seguro
--   - responder_invitacion_interna_seguro
--   - cancelar_invitacion_interna_seguro
--   - get_invitaciones_internas_encuentro_seguro
--   - get_mis_invitaciones_internas_seguro
--   - get_detalle_invitacion_interna_seguro
-- Trigger:
--   - trg_cancelar_invitaciones_on_encuentro_cancel
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLA: public.invitaciones_internas
-- ============================================================
CREATE TABLE IF NOT EXISTS public.invitaciones_internas (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    host_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    destinatario_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    destinatario_email TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'aceptada', 'rechazada', 'cancelada', 'expirada')),
    participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
    mensaje TEXT,
    respondido_en TIMESTAMPTZ,
    cancelado_en TIMESTAMPTZ,
    expira_en TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    CONSTRAINT chk_no_self_invitation CHECK (host_id <> destinatario_id)
);

-- ============================================================
-- 2. ÍNDICES
-- ============================================================
-- Evita invitaciones duplicadas pendientes para el mismo encuentro y destinatario
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitaciones_internas_unique_pending
    ON public.invitaciones_internas (encuentro_id, destinatario_id)
    WHERE estado = 'pendiente';

CREATE INDEX IF NOT EXISTS idx_invitaciones_internas_destinatario
    ON public.invitaciones_internas (destinatario_id, estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invitaciones_internas_encuentro
    ON public.invitaciones_internas (encuentro_id, estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invitaciones_internas_expiradas
    ON public.invitaciones_internas (expira_en)
    WHERE estado = 'pendiente';

-- ============================================================
-- 3. RLS Y PERMISOS
-- ============================================================
ALTER TABLE public.invitaciones_internas ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.invitaciones_internas FROM PUBLIC, anon;

-- Solo el anfitrión o el destinatario autenticados pueden ver la invitación
DROP POLICY IF EXISTS invitaciones_internas_select_parties ON public.invitaciones_internas;
CREATE POLICY invitaciones_internas_select_parties
    ON public.invitaciones_internas
    FOR SELECT
    TO authenticated
    USING (
        (auth.uid() = host_id OR auth.uid() = destinatario_id)
        AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    );

GRANT SELECT ON TABLE public.invitaciones_internas TO authenticated;
GRANT ALL ON TABLE public.invitaciones_internas TO service_role;

-- ============================================================
-- 4. POLÍTICA DE RATE LIMIT DURABLE
-- ============================================================
INSERT INTO public.rate_limit_policies (action, max_tokens, refill_rate_per_second, bucket_capacity, window_seconds)
VALUES ('internal_invitation', 20, 0.005555, 20, 3600)
ON CONFLICT (action) DO NOTHING;

-- ============================================================
-- 5. TRIGGER: Cancelar invitaciones pendientes al cancelar encuentro
-- ============================================================
CREATE OR REPLACE FUNCTION public.trigger_cancelar_invitaciones_on_encuentro_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.estado = 'cancelado' AND OLD.estado <> 'cancelado' THEN
        UPDATE public.invitaciones_internas
        SET estado = 'cancelada',
            cancelado_en = pg_catalog.timezone('utc', pg_catalog.now()),
            updated_at = pg_catalog.timezone('utc', pg_catalog.now())
        WHERE encuentro_id = NEW.id
          AND estado = 'pendiente';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cancelar_invitaciones_on_encuentro_cancel ON public.encuentros;
CREATE TRIGGER trg_cancelar_invitaciones_on_encuentro_cancel
    AFTER UPDATE OF estado ON public.encuentros
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_cancelar_invitaciones_on_encuentro_cancel();

-- ============================================================
-- 6. RPC: enviar_invitacion_interna_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.enviar_invitacion_interna_seguro(
    p_encuentro_id UUID,
    p_email TEXT,
    p_mensaje TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_clean_email TEXT;
    v_encuentro public.encuentros%ROWTYPE;
    v_target_user RECORD;
    v_target_name TEXT;
    v_host_name TEXT;
    v_host_user RECORD;
    v_confirmed_count INT;
    v_expira TIMESTAMPTZ;
    v_encounter_time TIMESTAMPTZ;
    v_inv_id UUID;
    v_part_id UUID;
    v_token UUID;
    v_rl JSONB;
BEGIN
    -- 1. Verificación de identidad y permanencia
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated', 'message', 'Debés iniciar sesión.');
    END IF;

    IF v_is_anon IS TRUE THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed', 'message', 'Las invitaciones internas requieren una cuenta permanente.');
    END IF;

    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'missing_encuentro_id', 'message', 'ID de encuentro requerido.');
    END IF;

    v_clean_email := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
    IF v_clean_email = '' OR pg_catalog.strpos(v_clean_email, '@') < 2 OR pg_catalog.strpos(v_clean_email, '.') = 0 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_email', 'message', 'Ingresá un correo electrónico válido.');
    END IF;

    -- 2. Propiedad y estado del encuentro (FOR UPDATE)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND OR v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_found_or_not_owner', 'message', 'Encuentro no encontrado o no tenés permiso de organizador.');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_active', 'message', 'El encuentro no se encuentra activo.');
    END IF;

    -- 3. Verificar vigencia del encuentro
    IF v_encuentro.date_mode = 'fixed' AND v_encuentro.fecha IS NOT NULL AND v_encuentro.hora IS NOT NULL THEN
        v_encounter_time := (v_encuentro.fecha + v_encuentro.hora) AT TIME ZONE 'America/Argentina/Buenos_Aires';
        IF v_encounter_time <= (pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires') THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_passed', 'message', 'El encuentro ya se realizó.');
        END IF;
    END IF;

    -- 4. Verificar cupos disponibles (si aplica)
    IF v_encuentro.spots IS NOT NULL THEN
        SELECT pg_catalog.count(*) INTO v_confirmed_count
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND estado = 'confirmado';

        IF v_confirmed_count >= v_encuentro.spots THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'no_spots_available', 'message', 'El encuentro ya no cuenta con cupos disponibles.');
        END IF;
    END IF;

    -- 5. Rate limiting defensivo
    v_rl := public.verificar_y_consumir_rate_limit(v_user_id, 'internal_invitation', 20, INTERVAL '1 hour');
    IF NOT COALESCE((v_rl ->> 'allowed')::boolean, true) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded', 'message', 'Superaste el límite de envíos de invitaciones. Por favor esperá unos minutos.');
    END IF;

    -- 6. Resolución del destinatario en auth.users (sin enumeración)
    SELECT id, is_anonymous, raw_user_meta_data, email
    INTO v_target_user
    FROM auth.users
    WHERE pg_catalog.lower(email) = v_clean_email
    LIMIT 1;

    -- Si no existe o es anónimo, responder respuesta exitosa genérica sin revelar su existencia
    IF NOT FOUND OR v_target_user.is_anonymous IS TRUE THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'sent', false,
            'message', 'Si el correo corresponde a una cuenta registrada en PuntoEncuentro, recibirá la notificación.'
        );
    END IF;

    -- 7. Prevenir auto-invitación
    IF v_target_user.id = v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'self_invitation_not_allowed', 'message', 'No podés invitarte a vos mismo.');
    END IF;

    -- 8. Prevenir invitaciones si existe bloqueo mutuo
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario
        WHERE (blocker_id = v_user_id AND blocked_id = v_target_user.id)
           OR (blocker_id = v_target_user.id AND blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'sent', false,
            'message', 'Si el correo corresponde a una cuenta registrada en PuntoEncuentro, recibirá la notificación.'
        );
    END IF;

    -- 9. Verificar si el usuario ya es participante confirmado
    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_target_user.id
          AND estado = 'confirmado'
    ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'user_already_participant', 'message', 'El usuario ya es un participante confirmado de este encuentro.');
    END IF;

    -- 10. Verificar si ya tiene invitación pendiente
    IF EXISTS (
        SELECT 1 FROM public.invitaciones_internas
        WHERE encuentro_id = p_encuentro_id
          AND destinatario_id = v_target_user.id
          AND estado = 'pendiente'
          AND expira_en > pg_catalog.timezone('utc', pg_catalog.now())
    ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invitation_already_pending', 'message', 'Ya enviaste una invitación pendiente a este usuario.');
    END IF;

    -- 11. Calcular expiración
    IF v_encuentro.date_mode = 'fixed' AND v_encuentro.fecha IS NOT NULL AND v_encuentro.hora IS NOT NULL THEN
        IF v_encounter_time < (pg_catalog.now() + INTERVAL '14 days') THEN
            v_expira := v_encounter_time;
        ELSE
            v_expira := pg_catalog.now() + INTERVAL '14 days';
        END IF;
    ELSE
        v_expira := pg_catalog.now() + INTERVAL '14 days';
    END IF;

    -- 12. Generar identificadores y nombres
    v_inv_id := pg_catalog.gen_random_uuid();
    v_part_id := pg_catalog.gen_random_uuid();
    v_token := pg_catalog.gen_random_uuid();

    v_target_name := COALESCE(
        v_target_user.raw_user_meta_data ->> 'full_name',
        v_target_user.raw_user_meta_data ->> 'name',
        pg_catalog.split_part(v_target_user.email, '@', 1)
    );

    SELECT raw_user_meta_data, email INTO v_host_user FROM auth.users WHERE id = v_user_id;
    v_host_name := COALESCE(
        v_host_user.raw_user_meta_data ->> 'full_name',
        v_host_user.raw_user_meta_data ->> 'name',
        pg_catalog.split_part(COALESCE(v_host_user.email, 'Organizador'), '@', 1)
    );

    -- 13. Crear registro de participante individual vinculado (estado 'pendiente')
    INSERT INTO public.participantes (
        id,
        encuentro_id,
        nombre_invitado,
        tipo_invitacion,
        token_invitacion,
        estado,
        user_id,
        creado_en
    ) VALUES (
        v_part_id,
        p_encuentro_id,
        v_target_name,
        'individual',
        v_token,
        'pendiente',
        v_target_user.id,
        pg_catalog.timezone('utc', pg_catalog.now())
    );

    -- 14. Crear la invitación interna
    INSERT INTO public.invitaciones_internas (
        id,
        encuentro_id,
        host_id,
        destinatario_id,
        destinatario_email,
        estado,
        participante_id,
        mensaje,
        expira_en,
        created_at,
        updated_at
    ) VALUES (
        v_inv_id,
        p_encuentro_id,
        v_user_id,
        v_target_user.id,
        v_clean_email,
        'pendiente',
        v_part_id,
        NULLIF(pg_catalog.btrim(COALESCE(p_mensaje, '')), ''),
        v_expira,
        pg_catalog.timezone('utc', pg_catalog.now()),
        pg_catalog.timezone('utc', pg_catalog.now())
    );

    -- 15. Transactional Outbox: Evento de dominio
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
        'internal_invitation.created.v1',
        1,
        'invitation',
        v_inv_id,
        v_user_id,
        pg_catalog.jsonb_build_object(
            'invitation_id', v_inv_id,
            'encuentro_id', p_encuentro_id,
            'host_id', v_user_id,
            'destinatario_id', v_target_user.id,
            'encounter_title', v_encuentro.titulo,
            'modality', v_encuentro.modalidad
        ),
        'internal_invitation:created:' || v_inv_id,
        'pending'
    ) ON CONFLICT (dedup_key) DO NOTHING;

    -- 16. Inserción atómica en Inbox del destinatario (alimenta Push sin filtrar datos privados)
    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_target_user.id,
        p_notification_type := 'internal_invitation',
        p_target_type := 'invitation',
        p_target_id := v_inv_id,
        p_deep_link := '/invitation/' || v_inv_id,
        p_title := 'Nueva invitación',
        p_body := 'Te invitaron a: ' || v_encuentro.titulo,
        p_payload := pg_catalog.jsonb_build_object(
            'invitation_id', v_inv_id,
            'encuentro_id', v_encuentro.id,
            'encounter_title', v_encuentro.titulo,
            'sender_name', v_host_name,
            'modality', v_encuentro.modalidad
        ),
        p_dedup_key := 'internal_invitation:' || v_inv_id,
        p_expires_at := v_expira
    );

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'sent', true,
        'invitation_id', v_inv_id,
        'message', 'Invitación enviada exitosamente.'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.enviar_invitacion_interna_seguro(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enviar_invitacion_interna_seguro(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 7. RPC: responder_invitacion_interna_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.responder_invitacion_interna_seguro(
    p_invitacion_id UUID,
    p_respuesta TEXT,
    p_mensaje TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_inv public.invitaciones_internas%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_responder_user RECORD;
    v_responder_name TEXT;
    v_confirmed_count INT;
    v_token_invitacion UUID;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
BEGIN
    -- 1. Verificación de identidad
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated', 'message', 'Debés iniciar sesión.');
    END IF;

    IF v_is_anon IS TRUE THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed', 'message', 'Las invitaciones internas requieren una cuenta permanente.');
    END IF;

    IF p_respuesta NOT IN ('aceptada', 'rechazada') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_respuesta', 'message', 'Respuesta debe ser aceptada o rechazada.');
    END IF;

    -- 2. Bloqueo de la invitación (FOR UPDATE)
    SELECT * INTO v_inv
    FROM public.invitaciones_internas
    WHERE id = p_invitacion_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invitation_not_found', 'message', 'Invitación no encontrada.');
    END IF;

    IF v_inv.destinatario_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized_recipient', 'message', 'No tenés permiso para responder a esta invitación.');
    END IF;

    -- 3. Verificación de estado pendiente
    IF v_inv.estado <> 'pendiente' THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'invitation_not_pending',
            'current_estado', v_inv.estado,
            'message', 'Esta invitación ya fue ' || v_inv.estado || '.'
        );
    END IF;

    -- 4. Expiración
    IF v_now >= v_inv.expira_en THEN
        UPDATE public.invitaciones_internas
        SET estado = 'expirada',
            updated_at = v_now
        WHERE id = p_invitacion_id;

        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invitation_expired', 'message', 'La invitación ha expirado.');
    END IF;

    -- 5. Bloqueo y verificación de encuentro (FOR UPDATE)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_inv.encuentro_id
    FOR UPDATE;

    IF NOT FOUND OR v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_active', 'message', 'El encuentro ha sido cancelado o ya no está disponible.');
    END IF;

    -- 6. Obtener nombre del destinatario
    SELECT raw_user_meta_data, email INTO v_responder_user FROM auth.users WHERE id = v_user_id;
    v_responder_name := COALESCE(
        v_responder_user.raw_user_meta_data ->> 'full_name',
        v_responder_user.raw_user_meta_data ->> 'name',
        pg_catalog.split_part(v_responder_user.email, '@', 1)
    );

    -- 7. RAMA: RECHAZADA
    IF p_respuesta = 'rechazada' THEN
        UPDATE public.invitaciones_internas
        SET estado = 'rechazada',
            respondido_en = v_now,
            mensaje = NULLIF(pg_catalog.btrim(COALESCE(p_mensaje, '')), ''),
            updated_at = v_now
        WHERE id = p_invitacion_id;

        IF v_inv.participante_id IS NOT NULL THEN
            UPDATE public.participantes
            SET estado = 'rechazado',
                respondido_en = v_now,
                mensaje_respuesta = NULLIF(pg_catalog.btrim(COALESCE(p_mensaje, '')), '')
            WHERE id = v_inv.participante_id;
        END IF;

        -- Outbox event
        INSERT INTO public.domain_events_outbox (
            event_type, event_version, aggregate_type, aggregate_id, actor_user_id, payload, dedup_key, status
        ) VALUES (
            'internal_invitation.declined.v1', 1, 'invitation', v_inv.id, v_user_id,
            pg_catalog.jsonb_build_object(
                'invitation_id', v_inv.id,
                'encuentro_id', v_encuentro.id,
                'responder_id', v_user_id,
                'responder_name', v_responder_name
            ),
            'internal_invitation:declined:' || v_inv.id,
            'pending'
        ) ON CONFLICT (dedup_key) DO NOTHING;

        -- Notificación al anfitrión
        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_encuentro.host_id,
            p_notification_type := 'invitation_declined',
            p_target_type := 'invitation',
            p_target_id := v_inv.id,
            p_deep_link := (CASE WHEN v_encuentro.date_mode = 'coordination' THEN '/coordination/' ELSE '/meet/' END) || v_encuentro.id,
            p_title := 'Invitación rechazada',
            p_body := v_responder_name || ' rechazó la invitación a ' || v_encuentro.titulo,
            p_payload := pg_catalog.jsonb_build_object(
                'invitation_id', v_inv.id,
                'encuentro_id', v_encuentro.id,
                'responder_name', v_responder_name,
                'status', 'rechazada'
            ),
            p_dedup_key := 'invitation_declined:' || v_inv.id
        );

        RETURN pg_catalog.jsonb_build_object('ok', true, 'estado', 'rechazada', 'message', 'Has rechazado la invitación.');
    END IF;

    -- 8. RAMA: ACEPTADA
    -- Si es fecha fija: verificar cupos y marcar confirmado
    IF v_encuentro.date_mode = 'fixed' THEN
        IF v_encuentro.spots IS NOT NULL THEN
            SELECT pg_catalog.count(*) INTO v_confirmed_count
            FROM public.participantes
            WHERE encuentro_id = v_encuentro.id
              AND estado = 'confirmado';

            IF v_confirmed_count >= v_encuentro.spots THEN
                RETURN pg_catalog.jsonb_build_object(
                    'ok', false,
                    'error', 'quota_exceeded',
                    'message', 'El encuentro ya no cuenta con cupos disponibles.'
                );
            END IF;
        END IF;

        IF v_inv.participante_id IS NOT NULL THEN
            UPDATE public.participantes
            SET estado = 'confirmado',
                respondido_en = v_now,
                mensaje_respuesta = NULLIF(pg_catalog.btrim(COALESCE(p_mensaje, '')), ''),
                user_id = v_user_id
            WHERE id = v_inv.participante_id
            RETURNING token_invitacion INTO v_token_invitacion;
        END IF;
    ELSE
        -- Coordinación: mantener pendiente y retornar token para que envíe disponibilidad
        IF v_inv.participante_id IS NOT NULL THEN
            UPDATE public.participantes
            SET user_id = v_user_id
            WHERE id = v_inv.participante_id
            RETURNING token_invitacion INTO v_token_invitacion;
        END IF;
    END IF;

    -- Actualizar invitación a 'aceptada'
    UPDATE public.invitaciones_internas
    SET estado = 'aceptada',
        respondido_en = v_now,
        mensaje = NULLIF(pg_catalog.btrim(COALESCE(p_mensaje, '')), ''),
        updated_at = v_now
    WHERE id = p_invitacion_id;

    -- Outbox event
    INSERT INTO public.domain_events_outbox (
        event_type, event_version, aggregate_type, aggregate_id, actor_user_id, payload, dedup_key, status
    ) VALUES (
        'internal_invitation.accepted.v1', 1, 'invitation', v_inv.id, v_user_id,
        pg_catalog.jsonb_build_object(
            'invitation_id', v_inv.id,
            'encuentro_id', v_encuentro.id,
            'responder_id', v_user_id,
            'responder_name', v_responder_name,
            'date_mode', v_encuentro.date_mode
        ),
        'internal_invitation:accepted:' || v_inv.id,
        'pending'
    ) ON CONFLICT (dedup_key) DO NOTHING;

    -- Notificación al anfitrión
    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_encuentro.host_id,
        p_notification_type := 'invitation_accepted',
        p_target_type := 'invitation',
        p_target_id := v_inv.id,
        p_deep_link := (CASE WHEN v_encuentro.date_mode = 'coordination' THEN '/coordination/' ELSE '/meet/' END) || v_encuentro.id,
        p_title := 'Invitación aceptada',
        p_body := v_responder_name || ' aceptó la invitación a ' || v_encuentro.titulo,
        p_payload := pg_catalog.jsonb_build_object(
            'invitation_id', v_inv.id,
            'encuentro_id', v_encuentro.id,
            'responder_name', v_responder_name,
            'status', 'aceptada'
        ),
        p_dedup_key := 'invitation_accepted:' || v_inv.id
    );

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'estado', 'aceptada',
        'encuentro_id', v_encuentro.id,
        'date_mode', v_encuentro.date_mode,
        'token_invitacion', v_token_invitacion,
        'message', 'Has aceptado la invitación.'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.responder_invitacion_interna_seguro(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.responder_invitacion_interna_seguro(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 8. RPC: cancelar_invitacion_interna_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancelar_invitacion_interna_seguro(
    p_invitacion_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_inv public.invitaciones_internas%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon IS TRUE THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    SELECT * INTO v_inv
    FROM public.invitaciones_internas
    WHERE id = p_invitacion_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invitation_not_found');
    END IF;

    IF v_inv.host_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_host');
    END IF;

    IF v_inv.estado <> 'pendiente' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invitation_not_pending', 'current_estado', v_inv.estado);
    END IF;

    UPDATE public.invitaciones_internas
    SET estado = 'cancelada',
        cancelado_en = v_now,
        updated_at = v_now
    WHERE id = p_invitacion_id;

    -- Eliminar registro de participante si continuaba pendiente
    IF v_inv.participante_id IS NOT NULL THEN
        DELETE FROM public.participantes
        WHERE id = v_inv.participante_id
          AND estado = 'pendiente';
    END IF;

    -- Domain event
    INSERT INTO public.domain_events_outbox (
        event_type, event_version, aggregate_type, aggregate_id, actor_user_id, payload, dedup_key, status
    ) VALUES (
        'internal_invitation.cancelled.v1', 1, 'invitation', v_inv.id, v_user_id,
        pg_catalog.jsonb_build_object(
            'invitation_id', v_inv.id,
            'encuentro_id', v_inv.encuentro_id,
            'host_id', v_user_id,
            'destinatario_id', v_inv.destinatario_id
        ),
        'internal_invitation:cancelled:' || v_inv.id,
        'pending'
    ) ON CONFLICT (dedup_key) DO NOTHING;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'estado', 'cancelada');
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_invitacion_interna_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_invitacion_interna_seguro(UUID) TO authenticated;

-- ============================================================
-- 9. RPC: get_invitaciones_internas_encuentro_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_invitaciones_internas_encuentro_seguro(
    p_encuentro_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_invs JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.encuentros
        WHERE id = p_encuentro_id AND host_id = v_user_id
    ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_owner_or_not_found');
    END IF;

    -- Reconciliar expiradas
    UPDATE public.invitaciones_internas
    SET estado = 'expirada',
        updated_at = v_now
    WHERE encuentro_id = p_encuentro_id
      AND estado = 'pendiente'
      AND expira_en <= v_now;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', i.id,
                'destinatario_email', i.destinatario_email,
                'estado', i.estado,
                'mensaje', i.mensaje,
                'respondido_en', i.respondido_en,
                'cancelado_en', i.cancelado_en,
                'expira_en', i.expira_en,
                'created_at', i.created_at
            ) ORDER BY i.created_at DESC
        ), '[]'::jsonb
    ) INTO v_invs
    FROM public.invitaciones_internas i
    WHERE i.encuentro_id = p_encuentro_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'invitaciones', v_invs);
END;
$$;

REVOKE ALL ON FUNCTION public.get_invitaciones_internas_encuentro_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_invitaciones_internas_encuentro_seguro(UUID) TO authenticated;

-- ============================================================
-- 10. RPC: get_mis_invitaciones_internas_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_mis_invitaciones_internas_seguro()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_invs JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- Reconciliar expiradas del usuario
    UPDATE public.invitaciones_internas
    SET estado = 'expirada',
        updated_at = v_now
    WHERE destinatario_id = v_user_id
      AND estado = 'pendiente'
      AND expira_en <= v_now;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', i.id,
                'encuentro_id', e.id,
                'encuentro_titulo', e.titulo,
                'encuentro_fecha', e.fecha,
                'encuentro_hora', e.hora,
                'encuentro_modalidad', e.modalidad,
                'encuentro_date_mode', e.date_mode,
                'encuentro_estado', e.estado,
                'host_id', i.host_id,
                'estado', i.estado,
                'mensaje', i.mensaje,
                'expira_en', i.expira_en,
                'created_at', i.created_at
            ) ORDER BY i.created_at DESC
        ), '[]'::jsonb
    ) INTO v_invs
    FROM public.invitaciones_internas i
    JOIN public.encuentros e ON e.id = i.encuentro_id
    WHERE i.destinatario_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'invitaciones', v_invs);
END;
$$;

REVOKE ALL ON FUNCTION public.get_mis_invitaciones_internas_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mis_invitaciones_internas_seguro() TO authenticated;

-- ============================================================
-- 11. RPC: get_detalle_invitacion_interna_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_detalle_invitacion_interna_seguro(
    p_invitacion_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_inv public.invitaciones_internas%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_host_user RECORD;
    v_host_name TEXT;
    v_part public.participantes%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_inv
    FROM public.invitaciones_internas
    WHERE id = p_invitacion_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invitation_not_found');
    END IF;

    -- Solo el destinatario o el host pueden consultar el detalle
    IF v_inv.destinatario_id <> v_user_id AND v_inv.host_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- Reconciliar expiración si aplica
    IF v_now >= v_inv.expira_en AND v_inv.estado = 'pendiente' THEN
        UPDATE public.invitaciones_internas
        SET estado = 'expirada',
            updated_at = v_now
        WHERE id = p_invitacion_id;
        v_inv.estado := 'expirada';
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_inv.encuentro_id;

    SELECT raw_user_meta_data, email INTO v_host_user
    FROM auth.users
    WHERE id = v_inv.host_id;

    v_host_name := COALESCE(
        v_host_user.raw_user_meta_data ->> 'full_name',
        v_host_user.raw_user_meta_data ->> 'name',
        pg_catalog.split_part(COALESCE(v_host_user.email, 'Organizador'), '@', 1)
    );

    IF v_inv.participante_id IS NOT NULL THEN
        SELECT * INTO v_part FROM public.participantes WHERE id = v_inv.participante_id;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'invitacion', pg_catalog.jsonb_build_object(
            'id', v_inv.id,
            'estado', v_inv.estado,
            'mensaje', v_inv.mensaje,
            'respondido_en', v_inv.respondido_en,
            'cancelado_en', v_inv.cancelado_en,
            'expira_en', v_inv.expira_en,
            'created_at', v_inv.created_at,
            'is_host', (v_inv.host_id = v_user_id),
            'token_invitacion', v_part.token_invitacion
        ),
        'encuentro', pg_catalog.jsonb_build_object(
            'id', v_encuentro.id,
            'titulo', v_encuentro.titulo,
            'descripcion', v_encuentro.descripcion,
            'fecha', v_encuentro.fecha,
            'hora', v_encuentro.hora,
            'modalidad', v_encuentro.modalidad,
            'lugar_texto', v_encuentro.lugar_texto,
            'date_mode', v_encuentro.date_mode,
            'estado', v_encuentro.estado,
            'tema', v_encuentro.tema,
            'host_name', v_host_name
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_detalle_invitacion_interna_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_detalle_invitacion_interna_seguro(UUID) TO authenticated;

COMMIT;
