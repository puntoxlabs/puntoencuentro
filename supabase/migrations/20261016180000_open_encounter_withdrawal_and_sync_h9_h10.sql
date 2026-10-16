-- ==============================================================================
-- Migración: 20261016180000_open_encounter_withdrawal_and_sync_h9_h10.sql
-- Descripción:
--   Implementación integral y segura del flujo de baja voluntaria (H9 y H10):
--   1. Asegurar restricción CHECK en public.participantes (incluyendo 'cancelado').
--   2. Actualizar reconfirmar_asistencia_seguro(uuid, text, text) para:
--      - Permitir desistir ('decline') tanto con inscripciones abiertas como cerradas.
--      - Almacenar motivo opcional privado (máx 280 caracteres) en mensaje_respuesta.
--      - Sincronizar inmediatamente la fila en participantes (estado = 'cancelado',
--        reconfirmation_status = 'declined') y la solicitud asociada en
--        solicitudes_encuentro_abierto (estado = 'cancelled', resolved_at, updated_at).
--      - Liberar los cupos reservados reales (v_part.seat_count).
--      - Notificar al organizador en la misma transacción mediante
--        'encounter_participant_withdrawn' (incluyendo nombre, cupos liberados,
--        motivo opcional y alerta si cayó del mínimo). Notificación única.
--      - Idempotencia segura frente a doble invocación.
--   3. Wrapper reconfirmar_asistencia_seguro(uuid, text) y función canónica
--      desistir_encuentro_abierto_seguro(uuid, text).
--   4. Actualizar aprobar_solicitud_encuentro_abierto para re-postulaciones:
--      re-activar fila cancelada existente en participantes si existe.
--   5. Endurecer responder_participante_seguro y eliminar_participante_seguro
--      frente a reactivación no autorizada de tokens en encuentros abiertos.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. RESTRICCIÓN CHECK EN public.participantes.estado
-- ------------------------------------------------------------------------------
ALTER TABLE public.participantes
    DROP CONSTRAINT IF EXISTS participantes_estado_check;

ALTER TABLE public.participantes
    ADD CONSTRAINT participantes_estado_check
    CHECK (estado IN ('pendiente', 'confirmado', 'rechazado', 'cancelado', 'asistio'));

-- ------------------------------------------------------------------------------
-- 2. RECONFIRMAR_ASISTENCIA_SEGURO (3 PARÁMETROS, CON MOTIVO OPCIONAL)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconfirmar_asistencia_seguro(
    p_encuentro_id uuid,
    p_decision text,
    p_motivo text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_part public.participantes%ROWTYPE;
    v_new_confirmed_seats int := 0;
    v_part_rec record;
    v_title text;
    v_now timestamptz := pg_catalog.now();
    v_clean_motivo text := NULL;
    v_fell_below_min boolean := false;
    v_notif_body text;
    v_participant_name text;
    v_freed_seats int := 1;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF p_decision NOT IN ('confirm', 'decline') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_decision');
    END IF;

    -- Validar motivo opcional (máximo 280 caracteres limpios)
    IF p_motivo IS NOT NULL THEN
        v_clean_motivo := pg_catalog.btrim(p_motivo);
        IF v_clean_motivo = '' THEN
            v_clean_motivo := NULL;
        ELSIF pg_catalog.length(v_clean_motivo) > 280 THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'motivo_too_long',
                'message', 'El motivo de baja no puede superar los 280 caracteres.'
            );
        END IF;
    END IF;

    -- Bloqueo exclusivo del encuentro
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- INVARIANTE: Un encuentro cancelado no admite confirmación ni baja voluntaria activa
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'cannot_reconfirm_cancelled_encounter',
            'message', 'El encuentro ha sido cancelado.'
        );
    END IF;

    -- Buscar participante con bloqueo exclusivo
    SELECT * INTO v_part
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id
      AND user_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'participant_not_found');
    END IF;

    -- Manejo de idempotencia si ya había desistido / cancelado
    IF v_part.estado = 'cancelado' THEN
        IF p_decision = 'decline' THEN
            RETURN pg_catalog.json_build_object(
                'ok', true,
                'already_withdrawn', true,
                'decision', 'decline',
                'reconfirmation_status', COALESCE(v_part.reconfirmation_status, 'declined'),
                'released_seats', 0
            );
        ELSE
            -- No puede auto-confirmarse si ya fue cancelado sin pasar por postulación
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'participant_withdrawn',
                'message', 'No podés reconfirmar una participación que ya fue dada de baja.'
            );
        END IF;
    END IF;

    -- Solo participantes confirmados (o asistio) pueden operar
    IF v_part.estado NOT IN ('confirmado', 'asistio') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'participant_not_confirmed');
    END IF;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');
    v_participant_name := COALESCE(NULLIF(pg_catalog.btrim(v_part.nombre_invitado), ''), 'Un participante');
    v_freed_seats := GREATEST(1, COALESCE(v_part.seat_count, 1));

    IF p_decision = 'confirm' THEN
        UPDATE public.participantes
        SET reconfirmation_status = 'confirmed',
            reconfirmed_at = v_now
        WHERE id = v_part.id;

        RETURN pg_catalog.json_build_object(
            'ok', true,
            'decision', 'confirm',
            'reconfirmation_status', 'confirmed'
        );
    ELSE
        -- Decision = 'decline' (Baja voluntaria H9/H10):
        -- 1. Actualizar participante a cancelado
        UPDATE public.participantes
        SET reconfirmation_status = 'declined',
            reconfirmed_at = v_now,
            estado = 'cancelado',
            mensaje_respuesta = COALESCE(v_clean_motivo, mensaje_respuesta)
        WHERE id = v_part.id;

        -- 2. Sincronizar solicitud de encuentro abierto si existe (H9)
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'cancelled',
            resolved_at = v_now,
            updated_at = v_now
        WHERE encuentro_id = p_encuentro_id
          AND (participante_id = v_part.id OR (usuario_id = v_user_id AND estado = 'approved'));

        -- 3. Recalcular cupos confirmados restantes
        SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
        INTO v_new_confirmed_seats
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio');

        -- 4. Evaluar si cayó por debajo del mínimo de realización
        IF v_encuentro.min_participants IS NOT NULL
           AND v_encuentro.realization_status = 'confirmed'
           AND v_new_confirmed_seats < v_encuentro.min_participants THEN

            v_fell_below_min := true;

            UPDATE public.encuentros
            SET realization_status = 'pending',
                min_confirmed_notified_at = NULL
            WHERE id = p_encuentro_id;

            -- Notificar a participantes restantes confirmados de la caída de mínimo
            FOR v_part_rec IN
                SELECT DISTINCT user_id
                FROM public.participantes
                WHERE encuentro_id = p_encuentro_id
                  AND estado IN ('confirmado', 'asistio')
                  AND user_id IS NOT NULL
                  AND user_id <> v_encuentro.host_id
                  AND user_id <> v_user_id
            LOOP
                PERFORM public.insertar_inbox_notification_seguro(
                    p_recipient_user_id := v_part_rec.user_id,
                    p_notification_type := 'encounter_below_min_participants',
                    p_target_type := 'encounter',
                    p_target_id := p_encuentro_id,
                    p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
                    p_title := 'Mínimo de participantes',
                    p_body := 'El encuentro volvió a quedar por debajo del mínimo de participantes.',
                    p_payload := pg_catalog.jsonb_build_object(
                        'encounter_id', p_encuentro_id,
                        'title', v_title
                    ),
                    p_dedup_key := 'below_min_part:' || p_encuentro_id || ':' || v_part_rec.user_id || ':' || pg_catalog.to_char(v_now, 'YYYYMMDDHH24MISS')
                );
            END LOOP;
        END IF;

        -- 5. Notificación obligatoria al organizador (H9/H10)
        -- Si v_fell_below_min es true, se unifica en este único aviso al anfitrión
        -- para evitar duplicados molestos.
        IF v_encuentro.host_id IS NOT NULL AND v_encuentro.host_id <> v_user_id THEN
            IF v_fell_below_min THEN
                v_notif_body := v_participant_name || ' se bajó del encuentro. Se liberaron ' ||
                                (CASE WHEN v_freed_seats > 1 THEN v_freed_seats || ' lugares.' ELSE '1 lugar.' END) ||
                                ' El encuentro volvió a quedar por debajo del mínimo de participantes.';
            ELSE
                v_notif_body := v_participant_name || ' se bajó del encuentro. Se liberaron ' ||
                                (CASE WHEN v_freed_seats > 1 THEN v_freed_seats || ' lugares.' ELSE '1 lugar.' END);
            END IF;

            PERFORM public.insertar_inbox_notification_seguro(
                p_recipient_user_id := v_encuentro.host_id,
                p_notification_type := 'encounter_participant_withdrawn',
                p_target_type := 'encounter',
                p_target_id := p_encuentro_id,
                p_deep_link := '/meet/' || p_encuentro_id,
                p_title := 'Baja de participante',
                p_body := v_notif_body,
                p_payload := pg_catalog.jsonb_build_object(
                    'encounter_id', p_encuentro_id,
                    'title', v_title,
                    'participant_user_id', v_user_id,
                    'participant_name', v_participant_name,
                    'freed_seats', v_freed_seats,
                    'cancellation_reason', v_clean_motivo,
                    'fell_below_min', v_fell_below_min
                ),
                p_dedup_key := 'part_withdrawn:' || p_encuentro_id || ':' || v_user_id || ':' || pg_catalog.to_char(v_now, 'YYYYMMDDHH24MISS')
            );
        END IF;

        RETURN pg_catalog.json_build_object(
            'ok', true,
            'decision', 'decline',
            'reconfirmation_status', 'declined',
            'released_seats', v_freed_seats,
            'fell_below_min', v_fell_below_min
        );
    END IF;
END;
$$;

-- Wrapper de 2 parámetros para compatibilidad hacia atrás
CREATE OR REPLACE FUNCTION public.reconfirmar_asistencia_seguro(
    p_encuentro_id uuid,
    p_decision text
)
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.reconfirmar_asistencia_seguro(p_encuentro_id, p_decision, NULL::text);
$$;

-- Función explícita canónica para baja voluntaria de encuentros abiertos
CREATE OR REPLACE FUNCTION public.desistir_encuentro_abierto_seguro(
    p_encuentro_id uuid,
    p_motivo text DEFAULT NULL
)
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.reconfirmar_asistencia_seguro(p_encuentro_id, 'decline', p_motivo);
$$;

-- Permisos estrictos
REVOKE ALL ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.desistir_encuentro_abierto_seguro(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desistir_encuentro_abierto_seguro(uuid, text) TO authenticated;

-- ------------------------------------------------------------------------------
-- 3. APROBAR_SOLICITUD_ENCUENTRO_ABIERTO (SOPORTE DE RE-POSTULACIÓN)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aprobar_solicitud_encuentro_abierto(
    p_request_id UUID,
    p_host_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats INT := 0;
    v_participante_id UUID;
    v_token_invitacion UUID;
    v_req_seats INT := 1;
    v_nuevo_disponible INT;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_part record;
    v_title text;
    v_existing_part_id UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 1. Bloquear y verificar la solicitud
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    IF v_solicitud.estado <> 'pending' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_already_processed');
    END IF;

    -- 2. Bloquear y verificar el encuentro atómicamente
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_solicitud.encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    -- Guard bilateral de bloqueo
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_solicitud.usuario_id)
           OR (b.blocker_id = v_solicitud.usuario_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_available');
    END IF;

    -- 3. Validar cupo real bajo bloqueo exclusivo de fila
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id AND estado IN ('confirmado', 'asistio');

    v_req_seats := COALESCE(v_solicitud.seat_count, 1);

    IF (v_confirmed_seats + v_req_seats) > v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    -- 4. Crear o reactivar participante asignando seat_count aprobado
    -- Si el usuario ya tenía una fila previa cancelada (por haber desistido), reutilizarla.
    SELECT id INTO v_existing_part_id
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id
      AND user_id = v_solicitud.usuario_id
    LIMIT 1
    FOR UPDATE;

    IF v_existing_part_id IS NOT NULL THEN
        v_participante_id := v_existing_part_id;
        v_token_invitacion := pg_catalog.gen_random_uuid();

        UPDATE public.participantes
        SET nombre_invitado = v_solicitud.nombre_solicitante,
            estado = 'confirmado',
            seat_count = v_req_seats,
            reconfirmation_status = 'pending',
            reconfirmed_at = NULL,
            mensaje_respuesta = v_solicitud.mensaje,
            token_invitacion = v_token_invitacion
        WHERE id = v_participante_id;
    ELSE
        v_token_invitacion := pg_catalog.gen_random_uuid();
        v_participante_id := pg_catalog.gen_random_uuid();

        INSERT INTO public.participantes (
            id,
            encuentro_id,
            nombre_invitado,
            tipo_invitacion,
            estado,
            token_invitacion,
            mensaje_respuesta,
            user_id,
            seat_count,
            reconfirmation_status
        ) VALUES (
            v_participante_id,
            v_encuentro.id,
            v_solicitud.nombre_solicitante,
            'individual',
            'confirmado',
            v_token_invitacion,
            v_solicitud.mensaje,
            v_solicitud.usuario_id,
            v_req_seats,
            'pending'
        );
    END IF;

    -- 5. Actualizar solicitud a approved
    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'approved',
        participante_id = v_participante_id,
        token_participante = v_token_invitacion,
        resolved_at = v_now,
        updated_at = v_now
    WHERE id = p_request_id;

    -- 6. Insertar Domain Event en Outbox (auditoría / replay)
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
        'encounter.join_request.approved.v1',
        1,
        'encounter',
        v_encuentro.id,
        v_user_id,
        pg_catalog.jsonb_build_object(
            'request_id', p_request_id,
            'encounter_id', v_encuentro.id,
            'applicant_id', v_solicitud.usuario_id,
            'host_id', v_user_id,
            'seat_count', v_req_seats
        ),
        pg_catalog.format('encounter:%s:join_request_approved:%s', v_encuentro.id, p_request_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    -- 7. Notificación en Inbox del solicitante
    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_solicitud.usuario_id,
        p_notification_type := 'open_encounter_request_accepted',
        p_target_type := 'encounter',
        p_target_id := v_encuentro.id,
        p_deep_link := '/?tab=encuentros&open_detail=' || v_encuentro.id,
        p_title := '¡Te aceptaron!',
        p_body := 'Ya formás parte del encuentro.',
        p_payload := pg_catalog.jsonb_build_object(
            'encounter_id', v_encuentro.id,
            'request_id', p_request_id,
            'open_public_title', COALESCE(v_encuentro.open_public_title, 'Encuentro abierto')
        ),
        p_dedup_key := 'join_request_approved:' || p_request_id
    );

    -- 8. Verificación de realización y mínimo de participantes
    IF v_encuentro.min_participants IS NOT NULL THEN
        IF v_encuentro.realization_status = 'pending' AND (v_confirmed_seats + v_req_seats) >= v_encuentro.min_participants THEN
            UPDATE public.encuentros
            SET realization_status = 'confirmed',
                min_confirmed_notified_at = COALESCE(min_confirmed_notified_at, v_now)
            WHERE id = v_encuentro.id;

            IF v_encuentro.min_confirmed_notified_at IS NULL THEN
                v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');
                FOR v_part IN
                    SELECT DISTINCT user_id
                    FROM public.participantes
                    WHERE encuentro_id = v_encuentro.id
                      AND estado IN ('confirmado', 'asistio')
                      AND user_id IS NOT NULL
                      AND user_id <> v_user_id
                LOOP
                    PERFORM public.insertar_inbox_notification_seguro(
                        p_recipient_user_id := v_part.user_id,
                        p_notification_type := 'encounter_min_participants_reached',
                        p_target_type := 'encounter',
                        p_target_id := v_encuentro.id,
                        p_deep_link := '/?tab=encuentros&open_detail=' || v_encuentro.id,
                        p_title := '¡Se hace!',
                        p_body := '¡Se hace! El encuentro alcanzó el mínimo de participantes.',
                        p_payload := pg_catalog.jsonb_build_object(
                            'encounter_id', v_encuentro.id,
                            'title', v_title
                        ),
                        p_dedup_key := 'min_reached:' || v_encuentro.id || ':' || v_part.user_id
                    );
                END LOOP;
            END IF;
        END IF;
    END IF;

    v_nuevo_disponible := GREATEST(0, v_encuentro.max_participants - (v_confirmed_seats + v_req_seats));

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', p_request_id,
        'participante_id', v_participante_id,
        'token_invitacion', v_token_invitacion,
        'confirmed_seats', v_confirmed_seats + v_req_seats,
        'available_slots', v_nuevo_disponible,
        'is_full', (v_nuevo_disponible = 0)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) TO authenticated;

-- ------------------------------------------------------------------------------
-- 4. HARDENING DE responder_participante_seguro (ANTI-BYPASS EN ENCUENTROS ABIERTOS)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.responder_participante_seguro(
    p_token text,
    p_estado text,
    p_nombre text DEFAULT NULL::text,
    p_mensaje text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_encuentro encuentros%ROWTYPE;
  v_participante participantes%ROWTYPE;
  v_token_uuid uuid;
  v_token_nuevo uuid;
  v_inicio_local timestamp;
  v_limite_local timestamp;
  v_ahora_local timestamp;
  v_nombre_limpio text;
  v_tipo_respuesta text;
BEGIN
  IF p_token IS NULL OR trim(p_token) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_token');
  END IF;

  IF p_estado NOT IN ('confirmado', 'rechazado') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_estado');
  END IF;

  BEGIN
    v_token_uuid := p_token::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END;

  v_nombre_limpio := NULLIF(trim(p_nombre), '');

  -- RAMA 1: token es token_invitacion individual
  SELECT * INTO v_participante
  FROM public.participantes
  WHERE token_invitacion = v_token_uuid;

  IF FOUND THEN
    SELECT * INTO v_encuentro FROM public.encuentros WHERE id = v_participante.encuentro_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'meeting_not_found');
    END IF;

    -- INVARIANTE: En encuentros abiertos, participantes confirmados o dados de baja
    -- no pueden usar este RPC legacy para saltear la re-postulación canónica.
    IF COALESCE(v_encuentro.is_open, false) = true THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'open_encounter_requires_canonical_flow',
        'message', 'Los encuentros abiertos requieren el flujo canónico de solicitud o reconfirmación.'
      );
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'cancelled');
    END IF;

    -- Permitir si es fixed, o si es coordination cerrada
    IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' AND
       NOT (v_encuentro.date_mode = 'coordination' AND v_encuentro.coordination_status = 'closed') THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'invalid_date_mode'
      );
    END IF;

    v_inicio_local := v_encuentro.fecha + v_encuentro.hora;
    v_limite_local := v_inicio_local + make_interval(mins => COALESCE(v_encuentro.post_event_active_minutes, 45));
    v_ahora_local := now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

    IF v_ahora_local > v_limite_local THEN
      RETURN jsonb_build_object('ok', false, 'error', 'meeting_expired');
    END IF;

    UPDATE public.participantes
    SET estado = p_estado,
        mensaje_respuesta = p_mensaje,
        respondido_en = now(),
        nombre_invitado = COALESCE(v_nombre_limpio, nombre_invitado)
    WHERE id = v_participante.id
    RETURNING * INTO v_participante;

    v_tipo_respuesta := CASE WHEN v_participante.tipo_invitacion = 'generico' THEN 'general' ELSE v_participante.tipo_invitacion END;

    RETURN jsonb_build_object(
      'ok', true,
      'tipo', v_tipo_respuesta,
      'id', v_participante.id,
      'encuentro_id', v_participante.encuentro_id,
      'token_invitacion', v_participante.token_invitacion,
      'estado', v_participante.estado,
      'link_virtual', CASE WHEN v_participante.estado = 'confirmado' AND v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual ELSE NULL END
    );
  END IF;

  -- RAMA 2: token es public_token (respuesta general al encuentro privado)
  SELECT * INTO v_encuentro FROM public.encuentros WHERE public_token = v_token_uuid;

  IF FOUND THEN
    IF COALESCE(v_encuentro.is_open, false) = true THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'open_encounter_requires_canonical_flow',
        'message', 'Los encuentros abiertos requieren el flujo canónico de solicitud o reconfirmación.'
      );
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'cancelled');
    END IF;

    -- Permitir si es fixed, o si es coordination cerrada
    IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' AND
       NOT (v_encuentro.date_mode = 'coordination' AND v_encuentro.coordination_status = 'closed') THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'invalid_date_mode'
      );
    END IF;

    v_inicio_local := v_encuentro.fecha + v_encuentro.hora;
    v_limite_local := v_inicio_local + make_interval(mins => COALESCE(v_encuentro.post_event_active_minutes, 45));
    v_ahora_local := now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

    IF v_ahora_local > v_limite_local THEN
      RETURN jsonb_build_object('ok', false, 'error', 'meeting_expired');
    END IF;

    v_token_nuevo := gen_random_uuid();

    INSERT INTO public.participantes (
      encuentro_id,
      nombre_invitado,
      tipo_invitacion,
      estado,
      mensaje_respuesta,
      token_invitacion,
      respondido_en
    ) VALUES (
      v_encuentro.id,
      v_nombre_limpio,
      'generico',
      p_estado,
      p_mensaje,
      v_token_nuevo,
      now()
    ) RETURNING * INTO v_participante;

    v_tipo_respuesta := CASE WHEN v_participante.tipo_invitacion = 'generico' THEN 'general' ELSE v_participante.tipo_invitacion END;

    RETURN jsonb_build_object(
      'ok', true,
      'tipo', v_tipo_respuesta,
      'id', v_participante.id,
      'encuentro_id', v_participante.encuentro_id,
      'token_invitacion', v_participante.token_invitacion,
      'estado', v_participante.estado,
      'link_virtual', CASE WHEN v_participante.estado = 'confirmado' AND v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual ELSE NULL END
    );
  END IF;

  RETURN jsonb_build_object('ok', false, 'error', 'not_found');
END;
$$;

REVOKE ALL ON FUNCTION public.responder_participante_seguro(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.responder_participante_seguro(text, text, text, text) TO anon, authenticated;

-- ------------------------------------------------------------------------------
-- 5. HARDENING DE eliminar_participante_seguro (SINCRONIZACIÓN Y RECALCULO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eliminar_participante_seguro(p_participante_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_part public.participantes%ROWTYPE;
    v_new_confirmed_seats int := 0;
    v_now timestamptz := pg_catalog.now();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_part
    FROM public.participantes
    WHERE id = p_participante_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'not_found'
        );
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_part.encuentro_id
    FOR UPDATE;

    IF NOT FOUND OR v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'unauthorized'
        );
    END IF;

    -- Si el encuentro es abierto, sincronizar su solicitud a cancelled si existiera
    IF COALESCE(v_encuentro.is_open, false) = true THEN
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'cancelled',
            resolved_at = v_now,
            updated_at = v_now
        WHERE encuentro_id = v_encuentro.id
          AND (participante_id = p_participante_id OR (usuario_id = v_part.user_id AND estado = 'approved'));
    END IF;

    DELETE FROM public.participante_disponibilidades WHERE participante_id = p_participante_id;
    DELETE FROM public.participantes WHERE id = p_participante_id;

    -- Si el encuentro es abierto o tiene mínimo de participantes, recalcular realización
    IF v_encuentro.min_participants IS NOT NULL AND v_encuentro.realization_status = 'confirmed' THEN
        SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
        INTO v_new_confirmed_seats
        FROM public.participantes
        WHERE encuentro_id = v_encuentro.id
          AND estado IN ('confirmado', 'asistio');

        IF v_new_confirmed_seats < v_encuentro.min_participants THEN
            UPDATE public.encuentros
            SET realization_status = 'pending',
                min_confirmed_notified_at = NULL
            WHERE id = v_encuentro.id;
        END IF;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_participante_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_participante_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_participante_seguro(uuid, uuid) TO authenticated;

COMMIT;
