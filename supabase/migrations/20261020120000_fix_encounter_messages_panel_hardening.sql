-- ==============================================================================
-- Migración: Microcorrecciones y Hardening Panel de Información y Mensajes V1
-- Timestamp: 20261020120000
-- Afecta: public.resolver_actor_encuentro, public.destacar_mensaje_encuentro_seguro
-- Invariantes:
--   1. Excluir de notificaciones de destacados a usuarios con bloqueo bilateral.
--   2. Bloqueo transaccional FOR UPDATE sobre public.encuentros para concurrencia real desde 0 destacados.
--   3. Impedir destacar mensajes cuando el encuentro esté cancelado o fuera de ventana temporal.
--   4. Deep link canónico seguro para participantes: '/?tab=encuentros&open_detail=' || v_encuentro.id
--   5. Coordinaciones exigen coordination_status = 'closed' además de fecha y hora.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. HELPER INTERNO: resolver_actor_encuentro
-- Endurece la validación de coordinación de fechas: exige coordination_status = 'closed'
-- además de fecha y hora definitivas no nulas.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.resolver_actor_encuentro(
    p_encuentro_id UUID,
    p_token_invitacion UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_encuentro RECORD;
    v_part RECORD;
    v_is_host BOOLEAN := false;
    v_actor_type TEXT := NULL;
    v_user_id UUID := NULL;
    v_participante_id UUID := NULL;
    v_autor_nombre TEXT := NULL;
    v_can_write BOOLEAN := false;
    v_inicio_local TIMESTAMPTZ;
    v_limite_escritura TIMESTAMPTZ;
    v_ahora_local TIMESTAMPTZ;
BEGIN
    -- 1. Validar existencia del encuentro
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    SELECT id, host_id, titulo, estado, fecha, hora, date_mode, coordination_status
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_not_found');
    END IF;

    -- 2. Regla de activación: Coordinación de fechas
    -- Exige estado 'closed' y fecha/hora definitivas
    IF v_encuentro.date_mode = 'coordination' AND (
        v_encuentro.coordination_status IS DISTINCT FROM 'closed' OR
        v_encuentro.fecha IS NULL OR
        v_encuentro.hora IS NULL
    ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'coordination_not_closed');
    END IF;

    -- Debe existir fecha y hora válidas para habilitar el panel
    IF v_encuentro.fecha IS NULL OR v_encuentro.hora IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'missing_schedule');
    END IF;

    -- 3. Calcular ventana temporal de escritura canónica (Hora de Argentina)
    v_inicio_local := (v_encuentro.fecha::date + v_encuentro.hora::time);
    v_limite_escritura := v_inicio_local + interval '24 hours';
    v_ahora_local := pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

    -- Se permite escribir antes, durante y hasta 24 hs después de la hora de inicio,
    -- siempre que el encuentro no esté cancelado.
    IF v_ahora_local <= v_limite_escritura AND v_encuentro.estado <> 'cancelado' THEN
        v_can_write := true;
    ELSE
        v_can_write := false;
    END IF;

    -- 4. Determinar si el actor es el Organizador (permanente o anónimo)
    IF v_auth_uid IS NOT NULL AND v_auth_uid = v_encuentro.host_id THEN
        v_is_host := true;
        v_user_id := v_auth_uid;
        v_autor_nombre := 'Organizador';
        
        -- Intentar resolver nombre visible de metadata
        BEGIN
            v_autor_nombre := COALESCE(
                NULLIF(pg_catalog.current_setting('request.jwt.claim.user_metadata', true)::jsonb->>'full_name', ''),
                NULLIF(pg_catalog.current_setting('request.jwt.claim.user_metadata', true)::jsonb->>'name', ''),
                'Organizador'
            );
        EXCEPTION WHEN OTHERS THEN
            v_autor_nombre := 'Organizador';
        END;

        IF pg_catalog.current_setting('request.jwt.claim.is_anonymous', true) = 'true' THEN
            v_actor_type := 'host_anon';
        ELSE
            v_actor_type := 'host_permanent';
        END IF;

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'actor_type', v_actor_type,
            'is_host', true,
            'user_id', v_user_id,
            'participante_id', NULL,
            'autor_nombre', v_autor_nombre,
            'can_write', v_can_write,
            'encuentro_estado', v_encuentro.estado,
            'writing_window_closed', (v_ahora_local > v_limite_escritura)
        );
    END IF;

    -- 5. Regla de cancelación para participantes
    -- Si el encuentro está cancelado, los participantes no pueden acceder ni al historial
    -- para proteger la logística y privacidad tras la cancelación.
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_cancelled');
    END IF;

    -- 6. Participante con sesión Supabase (permanente o anónima registrada en participantes)
    IF v_auth_uid IS NOT NULL THEN
        -- Verificar bloqueo bilateral entre este usuario y el host
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_auth_uid AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_auth_uid)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        SELECT id, nombre_invitado, estado, user_id, token_invitacion
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_auth_uid
        ORDER BY (estado = 'confirmado') DESC, creado_en DESC
        LIMIT 1;

        IF FOUND THEN
            IF v_part.estado <> 'confirmado' THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
            END IF;

            RETURN pg_catalog.jsonb_build_object(
                'ok', true,
                'actor_type', 'participant_registered',
                'is_host', false,
                'user_id', v_auth_uid,
                'participante_id', v_part.id,
                'autor_nombre', v_part.nombre_invitado,
                'can_write', v_can_write,
                'encuentro_estado', v_encuentro.estado,
                'writing_window_closed', (v_ahora_local > v_limite_escritura)
            );
        END IF;
    END IF;

    -- 7. Invitado individual mediante token_invitacion
    IF p_token_invitacion IS NOT NULL THEN
        SELECT id, nombre_invitado, estado, user_id, token_invitacion
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND token_invitacion = p_token_invitacion;

        IF FOUND THEN
            -- Si el participante está vinculado a un user_id, verificar bloqueo bilateral con el host
            IF v_part.user_id IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1 FROM public.bloqueos_usuario
                    WHERE (blocker_id = v_part.user_id AND blocked_id = v_encuentro.host_id)
                       OR (blocker_id = v_encuentro.host_id AND blocked_id = v_part.user_id)
                ) THEN
                    RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
                END IF;
            END IF;

            IF v_part.estado <> 'confirmado' THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
            END IF;

            RETURN pg_catalog.jsonb_build_object(
                'ok', true,
                'actor_type', 'participant_guest',
                'is_host', false,
                'user_id', v_part.user_id,
                'participante_id', v_part.id,
                'autor_nombre', v_part.nombre_invitado,
                'can_write', v_can_write,
                'encuentro_estado', v_encuentro.estado,
                'writing_window_closed', (v_ahora_local > v_limite_escritura)
            );
        END IF;
    END IF;

    -- 8. Fail-closed: Sin autorización válida
    RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_actor_encuentro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_actor_encuentro(UUID, UUID) TO postgres, service_role;

-- ==============================================================================
-- 2. RPC: destacar_mensaje_encuentro_seguro
-- Hardening:
-- - Bloqueo transaccional FOR UPDATE sobre public.encuentros para concurrencia real desde 0 destacados.
-- - Impide destacar mensajes si el encuentro está cancelado o fuera de ventana temporal.
-- - Conserva acciones de moderación (p_destacado = false) en todo estado.
-- - Excluye de notificaciones a participantes con bloqueo bilateral con el organizador.
-- - Usa deep_link canónico seguro para participantes: '/?tab=encuentros&open_detail=' || v_encuentro.id
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.destacar_mensaje_encuentro_seguro(
    p_mensaje_id UUID,
    p_destacado BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_mensaje RECORD;
    v_encuentro RECORD;
    v_auth_uid UUID := auth.uid();
    v_count_destacados INTEGER;
    v_part RECORD;
    v_inicio_local TIMESTAMPTZ;
    v_limite_escritura TIMESTAMPTZ;
    v_ahora_local TIMESTAMPTZ;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    SELECT id, encuentro_id, contenido, eliminado_en, destacado
    INTO v_mensaje
    FROM public.mensajes_encuentro
    WHERE id = p_mensaje_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'message_not_found');
    END IF;

    IF v_mensaje.eliminado_en IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_highlight_deleted_message');
    END IF;

    -- Bloqueo pesimista sobre la fila del encuentro para serializar transacciones concurrentes
    -- incluso cuando inicialmente existen cero mensajes destacados.
    SELECT id, host_id, titulo, estado, fecha, hora, date_mode, coordination_status
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_mensaje.encuentro_id
    FOR UPDATE;

    IF NOT FOUND OR v_encuentro.host_id <> v_auth_uid THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF p_destacado = true THEN
        -- Validar ciclo de vida y estado terminal
        IF v_encuentro.estado = 'cancelado' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_cancelled');
        END IF;

        IF v_encuentro.date_mode = 'coordination' AND (
            v_encuentro.coordination_status IS DISTINCT FROM 'closed' OR
            v_encuentro.fecha IS NULL OR
            v_encuentro.hora IS NULL
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'coordination_not_closed');
        END IF;

        IF v_encuentro.fecha IS NULL OR v_encuentro.hora IS NULL THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'missing_schedule');
        END IF;

        -- Ventana temporal de escritura (antes, durante y hasta 24 hs después de la hora de inicio)
        v_inicio_local := (v_encuentro.fecha::date + v_encuentro.hora::time);
        v_limite_escritura := v_inicio_local + interval '24 hours';
        v_ahora_local := pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

        IF v_ahora_local > v_limite_escritura THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'writing_window_closed');
        END IF;

        -- Conteo de destacados activos (serializado por el lock de encuentros)
        SELECT pg_catalog.count(*)
        INTO v_count_destacados
        FROM public.mensajes_encuentro
        WHERE encuentro_id = v_encuentro.id
          AND destacado = true
          AND eliminado_en IS NULL
          AND id <> p_mensaje_id;

        IF v_count_destacados >= 3 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'max_highlights_reached');
        END IF;

        UPDATE public.mensajes_encuentro
        SET destacado = true,
            destacado_en = pg_catalog.now(),
            destacado_por = v_auth_uid
        WHERE id = p_mensaje_id;

        -- Notificaciones: Crear notificación en Inbox para participantes registrados confirmados
        -- 1. Excluye a participantes con bloqueo bilateral con el organizador
        -- 2. Usa el deep_link canónico seguro para participantes (/?tab=encuentros&open_detail=:id)
        -- 3. No incluye direcciones ni enlaces privados en el payload de notificación
        FOR v_part IN
            SELECT DISTINCT p.user_id
            FROM public.participantes p
            WHERE p.encuentro_id = v_encuentro.id
              AND p.user_id IS NOT NULL
              AND p.user_id <> v_auth_uid
              AND p.estado = 'confirmado'
              AND NOT EXISTS (
                  SELECT 1 FROM public.bloqueos_usuario b
                  WHERE (b.blocker_id = v_auth_uid AND b.blocked_id = p.user_id)
                     OR (b.blocker_id = p.user_id AND b.blocked_id = v_auth_uid)
              )
        LOOP
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
            )
            VALUES (
                v_part.user_id,
                'encounter_message_highlighted',
                'encuentro',
                v_encuentro.id,
                '/?tab=encuentros&open_detail=' || v_encuentro.id::text,
                'Mensaje destacado en ' || v_encuentro.titulo,
                'El organizador destacó un mensaje importante en el encuentro.',
                pg_catalog.jsonb_build_object(
                    'encuentro_id', v_encuentro.id,
                    'mensaje_id', p_mensaje_id
                ),
                'highlight_msg_' || p_mensaje_id::text || '_' || v_part.user_id::text,
                pg_catalog.now() + interval '7 days'
            )
            ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;
        END LOOP;

    ELSE
        -- Moderación: Desmarcar destacado (permitido en cualquier estado del encuentro)
        UPDATE public.mensajes_encuentro
        SET destacado = false,
            destacado_en = NULL,
            destacado_por = NULL
        WHERE id = p_mensaje_id;
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'destacado', p_destacado);
END;
$$;

REVOKE ALL ON FUNCTION public.destacar_mensaje_encuentro_seguro(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.destacar_mensaje_encuentro_seguro(UUID, BOOLEAN) TO authenticated, service_role;

COMMIT;
