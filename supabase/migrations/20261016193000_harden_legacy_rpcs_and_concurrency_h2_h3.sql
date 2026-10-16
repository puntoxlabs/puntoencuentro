-- ==============================================================================
-- Migración: 20261016193000_harden_legacy_rpcs_and_concurrency_h2_h3.sql
-- Descripción:
--   Fase 2 (H2 — Seguridad de RPCs antiguos) y Fase 3 (H3 — Concurrencia y
--   orden canónico de bloqueos):
--
--   1. H2 — responder_participante_seguro:
--      - SET search_path = '' y referencias totalmente calificadas.
--      - Orden canónico de bloqueo: public.encuentros (FOR UPDATE) -> public.participantes (FOR UPDATE).
--      - Anti-bypass reforzado: rechaza encuentros con is_open = true, opened_at IS NOT NULL
--        (encuentros que fueron abiertos aunque actualmente tengan is_open = false) o participantes
--        vinculados a solicitudes_encuentro_abierto.
--      - Protección de estados terminales: impide reactivar o mutar participaciones en estado
--        'cancelado' o 'asistio', así como operar sobre encuentros no activos o cancelados.
--      - Preserva el flujo normal de encuentros privados por invitación.
--
--   2. H2 / H3 — eliminar_participante_seguro:
--      - Corrige inversión de orden de bloqueo: bloquea primero public.encuentros (FOR UPDATE),
--        luego public.solicitudes_encuentro_abierto (FOR UPDATE) y luego public.participantes (FOR UPDATE).
--      - Impide eliminar participantes sobre encuentros cancelados o no activos.
--      - Sincroniza cualquier solicitud activa ('approved') a 'cancelled' con token_participante = NULL,
--        incluso si is_open fue desactivado temporalmente.
--      - Recalcula cupos confirmados y mínimo de realización (min_participants), notificando
--        al host y a los participantes restantes si cae por debajo del mínimo.
--      - Emite comunicación coherente al participante confirmado afectado (Inbox + Outbox).
--
--   3. H3 — Orden canónico de bloqueos (encuentros -> solicitudes_encuentro_abierto -> participantes)
--      y revalidación post-lock en:
--      - aprobar_solicitud_encuentro_abierto
--      - rechazar_solicitud_encuentro_abierto
--      - cancelar_solicitud_encuentro_abierto
--      - cancelar_encuentro_seguro
--      - cerrar_encuentro_abierto_seguro
--      - reconfirmar_asistencia_seguro
--      - solicitar_sumarse_encuentro_abierto (manejo controlado de unique_violation concurrente)
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. H2 / H3: responder_participante_seguro
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
SET search_path = ''
AS $$
DECLARE
    v_encuentro public.encuentros%ROWTYPE;
    v_participante public.participantes%ROWTYPE;
    v_part_lookup record;
    v_token_uuid uuid;
    v_token_nuevo uuid;
    v_inicio_local timestamp;
    v_limite_local timestamp;
    v_ahora_local timestamp;
    v_nombre_limpio text;
    v_tipo_respuesta text;
BEGIN
    IF p_token IS NULL OR pg_catalog.btrim(p_token) = '' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'missing_token');
    END IF;

    IF p_estado NOT IN ('confirmado', 'rechazado') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_estado');
    END IF;

    BEGIN
        v_token_uuid := p_token::uuid;
    EXCEPTION
        WHEN invalid_text_representation THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_token');
    END;

    v_nombre_limpio := NULLIF(pg_catalog.btrim(COALESCE(p_nombre, '')), '');

    -- RAMA 1: token es token_invitacion individual
    SELECT id, encuentro_id INTO v_part_lookup
    FROM public.participantes
    WHERE token_invitacion = v_token_uuid
    LIMIT 1;

    IF FOUND THEN
        -- Orden canónico de bloqueo: 1) encuentro, 2) participante
        SELECT * INTO v_encuentro
        FROM public.encuentros
        WHERE id = v_part_lookup.encuentro_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_not_found');
        END IF;

        SELECT * INTO v_participante
        FROM public.participantes
        WHERE id = v_part_lookup.id
          AND token_invitacion = v_token_uuid
        FOR UPDATE;

        IF NOT FOUND THEN
            -- El token fue rotado o el participante fue eliminado concurrentemente
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_found');
        END IF;

        -- INVARIANTE H2: En encuentros abiertos (actualmente abiertos, que hayan sido abiertos
        -- o cuyo participante provenga de una solicitud), prohibir el RPC legacy.
        IF COALESCE(v_encuentro.is_open, false) = true
           OR v_encuentro.opened_at IS NOT NULL
           OR EXISTS (
               SELECT 1
               FROM public.solicitudes_encuentro_abierto s
               WHERE s.encuentro_id = v_encuentro.id
                 AND (
                     s.participante_id = v_participante.id
                     OR (v_participante.user_id IS NOT NULL AND s.usuario_id = v_participante.user_id)
                 )
           ) THEN
            RETURN pg_catalog.jsonb_build_object(
                'ok', false,
                'error', 'open_encounter_requires_canonical_flow',
                'message', 'Los encuentros abiertos requieren el flujo canónico de solicitud o reconfirmación.'
            );
        END IF;

        IF v_encuentro.estado = 'cancelado' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cancelled');
        END IF;

        IF v_encuentro.estado <> 'activo' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_active');
        END IF;

        -- INVARIANTE H2: Estados terminales ('cancelado' tras baja o 'asistio') no pueden
        -- reactivarse ni alterarse con un token de invitación antiguo.
        IF v_participante.estado IN ('cancelado', 'asistio') THEN
            RETURN pg_catalog.jsonb_build_object(
                'ok', false,
                'error', 'terminal_participant_state',
                'message', 'No es posible modificar una participación dada de baja o finalizada.'
            );
        END IF;

        -- Permitir si es fixed, o si es coordination cerrada
        IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' AND
           NOT (v_encuentro.date_mode = 'coordination' AND v_encuentro.coordination_status = 'closed') THEN
            RETURN pg_catalog.jsonb_build_object(
                'ok', false,
                'error', 'invalid_date_mode'
            );
        END IF;

        v_inicio_local := v_encuentro.fecha + v_encuentro.hora;
        v_limite_local := v_inicio_local + pg_catalog.make_interval(mins => COALESCE(v_encuentro.post_event_active_minutes, 45));
        v_ahora_local := pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

        IF v_ahora_local > v_limite_local THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_expired');
        END IF;

        UPDATE public.participantes
        SET estado = p_estado,
            mensaje_respuesta = p_mensaje,
            respondido_en = pg_catalog.now(),
            nombre_invitado = COALESCE(v_nombre_limpio, nombre_invitado)
        WHERE id = v_participante.id
        RETURNING * INTO v_participante;

        v_tipo_respuesta := CASE WHEN v_participante.tipo_invitacion = 'generico' THEN 'general' ELSE v_participante.tipo_invitacion END;

        RETURN pg_catalog.jsonb_build_object(
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
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE public_token = v_token_uuid
    FOR UPDATE;

    IF FOUND THEN
        IF COALESCE(v_encuentro.is_open, false) = true OR v_encuentro.opened_at IS NOT NULL THEN
            RETURN pg_catalog.jsonb_build_object(
                'ok', false,
                'error', 'open_encounter_requires_canonical_flow',
                'message', 'Los encuentros abiertos requieren el flujo canónico de solicitud o reconfirmación.'
            );
        END IF;

        IF v_encuentro.estado = 'cancelado' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cancelled');
        END IF;

        IF v_encuentro.estado <> 'activo' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_active');
        END IF;

        -- Permitir si es fixed, o si es coordination cerrada
        IF v_encuentro.date_mode IS DISTINCT FROM 'fixed' AND
           NOT (v_encuentro.date_mode = 'coordination' AND v_encuentro.coordination_status = 'closed') THEN
            RETURN pg_catalog.jsonb_build_object(
                'ok', false,
                'error', 'invalid_date_mode'
            );
        END IF;

        v_inicio_local := v_encuentro.fecha + v_encuentro.hora;
        v_limite_local := v_inicio_local + pg_catalog.make_interval(mins => COALESCE(v_encuentro.post_event_active_minutes, 45));
        v_ahora_local := pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

        IF v_ahora_local > v_limite_local THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_expired');
        END IF;

        v_token_nuevo := pg_catalog.gen_random_uuid();

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
            pg_catalog.now()
        ) RETURNING * INTO v_participante;

        v_tipo_respuesta := CASE WHEN v_participante.tipo_invitacion = 'generico' THEN 'general' ELSE v_participante.tipo_invitacion END;

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'tipo', v_tipo_respuesta,
            'id', v_participante.id,
            'encuentro_id', v_participante.encuentro_id,
            'token_invitacion', v_participante.token_invitacion,
            'estado', v_participante.estado,
            'link_virtual', CASE WHEN v_participante.estado = 'confirmado' AND v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual ELSE NULL END
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_found');
END;
$$;

REVOKE ALL ON FUNCTION public.responder_participante_seguro(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.responder_participante_seguro(text, text, text, text) TO anon, authenticated;


-- ------------------------------------------------------------------------------
-- 2. H2 / H3: eliminar_participante_seguro
--    Orden de bloqueo: encuentros -> solicitudes_encuentro_abierto -> participantes
--    Sincronización, recálculo de cupos/mínimo y comunicación al usuario afectado
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eliminar_participante_seguro(p_participante_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro_id uuid;
    v_encuentro public.encuentros%ROWTYPE;
    v_part public.participantes%ROWTYPE;
    v_new_confirmed_seats int := 0;
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_was_confirmed boolean := false;
    v_fell_below_min boolean := false;
    v_freed_seats int := 0;
    v_title text;
    v_removal_event_id uuid;
    v_part_rec record;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- 1. Lookup sin bloqueo para obtener encuentro_id y respetar el orden canónico de locks
    SELECT encuentro_id INTO v_encuentro_id
    FROM public.participantes
    WHERE id = p_participante_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 2. Bloquear primero el encuentro (Orden canónico: 1. encuentros)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_encuentro_id
    FOR UPDATE;

    IF NOT FOUND OR v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- No permitir mutaciones administrativas sobre encuentros cancelados o no activos
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_modify_cancelled_encounter');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    -- 3. Bloquear solicitudes activas asociadas (Orden canónico: 2. solicitudes_encuentro_abierto)
    PERFORM 1
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = v_encuentro.id
      AND estado = 'approved'
    ORDER BY id
    FOR UPDATE;

    -- 4. Bloquear participante y revalidar existencia (Orden canónico: 3. participantes)
    SELECT * INTO v_part
    FROM public.participantes
    WHERE id = p_participante_id
      AND encuentro_id = v_encuentro.id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    v_was_confirmed := (v_part.estado IN ('confirmado', 'asistio'));
    IF v_was_confirmed THEN
        v_freed_seats := GREATEST(1, COALESCE(v_part.seat_count, 1));
    END IF;

    -- 5. Sincronizar solicitud activa ('approved') a 'cancelled' (incluso si is_open fue apagado temporalmente)
    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'cancelled',
        token_participante = NULL,
        resolved_at = v_now,
        updated_at = v_now
    WHERE encuentro_id = v_encuentro.id
      AND estado = 'approved'
      AND (
          participante_id = p_participante_id
          OR (v_part.user_id IS NOT NULL AND usuario_id = v_part.user_id)
      );

    -- 6. Eliminar disponibilidades y fila de participante
    DELETE FROM public.participante_disponibilidades WHERE participante_id = p_participante_id;
    DELETE FROM public.participantes WHERE id = p_participante_id;

    -- 7. Recalcular cupos confirmados restantes
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_new_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id
      AND estado IN ('confirmado', 'asistio');

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');
    v_removal_event_id := pg_catalog.gen_random_uuid();

    -- 8. Si estaba confirmado y el encuentro cae por debajo del mínimo, revertir a pending y notificar
    IF v_was_confirmed
       AND v_encuentro.min_participants IS NOT NULL
       AND v_encuentro.realization_status = 'confirmed'
       AND v_new_confirmed_seats < v_encuentro.min_participants THEN

        v_fell_below_min := true;

        UPDATE public.encuentros
        SET realization_status = 'pending',
            min_confirmed_notified_at = NULL
        WHERE id = v_encuentro.id;

        -- Notificar al host
        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_encuentro.host_id,
            p_notification_type := 'encounter_below_min_participants',
            p_target_type := 'encounter',
            p_target_id := v_encuentro.id,
            p_deep_link := '/meet/' || v_encuentro.id,
            p_title := 'Mínimo de participantes',
            p_body := 'El encuentro volvió a quedar por debajo del mínimo de participantes.',
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', v_encuentro.id,
                'title', v_title
            ),
            p_dedup_key := 'below_min_host:' || v_encuentro.id || ':' || v_removal_event_id
        );

        -- Notificar a participantes restantes confirmados
        FOR v_part_rec IN
            SELECT DISTINCT user_id
            FROM public.participantes
            WHERE encuentro_id = v_encuentro.id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_encuentro.host_id
        LOOP
            PERFORM public.insertar_inbox_notification_seguro(
                p_recipient_user_id := v_part_rec.user_id,
                p_notification_type := 'encounter_below_min_participants',
                p_target_type := 'encounter',
                p_target_id := v_encuentro.id,
                p_deep_link := '/?tab=encuentros&open_detail=' || v_encuentro.id,
                p_title := 'Mínimo de participantes',
                p_body := 'El encuentro volvió a quedar por debajo del mínimo de participantes.',
                p_payload := pg_catalog.jsonb_build_object(
                    'encounter_id', v_encuentro.id,
                    'title', v_title
                ),
                p_dedup_key := 'below_min_part:' || v_encuentro.id || ':' || v_removal_event_id || ':' || v_part_rec.user_id
            );
        END LOOP;
    END IF;

    -- 9. Comunicación coherente al usuario afectado (si tenía cuenta y participación confirmada)
    IF v_was_confirmed AND v_part.user_id IS NOT NULL AND v_part.user_id <> v_user_id THEN
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
            'encounter.participant.removed_by_host.v1',
            1,
            'encounter',
            v_encuentro.id,
            v_user_id,
            pg_catalog.jsonb_build_object(
                'removal_event_id', v_removal_event_id,
                'encounter_id', v_encuentro.id,
                'participant_id', p_participante_id,
                'participant_user_id', v_part.user_id,
                'host_id', v_user_id,
                'freed_seats', v_freed_seats
            ),
            pg_catalog.format('encounter:%s:participant_removed:%s', v_encuentro.id, v_removal_event_id),
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;

        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_part.user_id,
            p_notification_type := 'encounter_participant_removed_by_host',
            p_target_type := 'encounter',
            p_target_id := v_encuentro.id,
            p_deep_link := '/?tab=encuentros',
            p_title := 'Actualización de tu participación',
            p_body := 'El anfitrión actualizó la lista de participantes y ya no formás parte de ' || v_title || '.',
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', v_encuentro.id,
                'removal_event_id', v_removal_event_id,
                'title', v_title,
                'freed_seats', v_freed_seats
            ),
            p_dedup_key := 'part_removed_by_host:' || v_encuentro.id || ':' || v_removal_event_id
        );
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_participante_id,
        'released_seats', v_freed_seats,
        'confirmed_seats', v_new_confirmed_seats,
        'available_slots', CASE
            WHEN v_encuentro.max_participants IS NOT NULL THEN GREATEST(0, v_encuentro.max_participants - v_new_confirmed_seats)
            ELSE NULL
        END,
        'fell_below_min', v_fell_below_min
    );
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_participante_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_participante_seguro(uuid, uuid) TO authenticated;


-- ------------------------------------------------------------------------------
-- 3. H3: aprobar_solicitud_encuentro_abierto
--    Orden canónico de bloqueo:
--      1. public.encuentros (FOR UPDATE)
--      2. public.solicitudes_encuentro_abierto (FOR UPDATE)
--      3. public.participantes (FOR UPDATE)
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
    v_encuentro_id UUID;
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats INT := 0;
    v_participante_id UUID;
    v_token_invitacion UUID;
    v_req_seats INT := 1;
    v_nuevo_disponible INT;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
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

    -- 1. Lookup sin bloqueo del encuentro_id asociado a la solicitud
    SELECT encuentro_id INTO v_encuentro_id
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    -- 2. Bloquear primero el encuentro (Orden canónico: 1. encuentros)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- Revalidar que el encuentro siga activo tras adquirir el lock del encuentro
    -- (si cancelar_encuentro_seguro se ejecutó antes, aquí se rechaza limpiamente)
    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    -- 3. Bloquear y revalidar la solicitud (Orden canónico: 2. solicitudes_encuentro_abierto)
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
      AND encuentro_id = v_encuentro.id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    IF v_solicitud.estado <> 'pending' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_already_processed');
    END IF;

    -- Guard bilateral de bloqueo
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_solicitud.usuario_id)
           OR (b.blocker_id = v_solicitud.usuario_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_available');
    END IF;

    -- Verificar que el usuario no esté ya confirmado en el encuentro
    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = v_encuentro.id
          AND user_id = v_solicitud.usuario_id
          AND estado IN ('confirmado', 'asistio')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_joined');
    END IF;

    -- 4. Validar cupo real bajo bloqueo exclusivo del encuentro
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id AND estado IN ('confirmado', 'asistio');

    v_req_seats := COALESCE(v_solicitud.seat_count, 1);

    IF (v_confirmed_seats + v_req_seats) > v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    -- 5. Crear o reactivar participante asignando seat_count aprobado (Orden canónico: 3. participantes)
    SELECT id INTO v_existing_part_id
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id
      AND user_id = v_solicitud.usuario_id
    ORDER BY creado_en DESC, id DESC
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

    -- 6. Actualizar solicitud a approved
    BEGIN
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'approved',
            participante_id = v_participante_id,
            token_participante = v_token_invitacion,
            resolved_at = v_now,
            updated_at = v_now
        WHERE id = p_request_id
          AND estado = 'pending';
    EXCEPTION
        WHEN unique_violation THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_already_processed');
    END;

    -- 7. Insertar Domain Event en Outbox (auditoría / replay)
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

    -- 8. Notificación en Inbox del solicitante
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

    -- 9. Verificación de realización y mínimo de participantes
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
                            'request_id', p_request_id,
                            'title', v_title
                        ),
                        p_dedup_key := 'min_reached:' || v_encuentro.id || ':' || p_request_id || ':' || v_part.user_id
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
        'seat_count', v_req_seats,
        'confirmed_seats', v_confirmed_seats + v_req_seats,
        'available_slots', v_nuevo_disponible,
        'nuevo_cupo_disponible', v_nuevo_disponible,
        'is_full', (v_nuevo_disponible = 0)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) TO authenticated;


-- ------------------------------------------------------------------------------
-- 4. H3: rechazar_solicitud_encuentro_abierto
--    Orden canónico de bloqueo:
--      1. public.encuentros (FOR UPDATE)
--      2. public.solicitudes_encuentro_abierto (FOR UPDATE)
--    Impide rechazar solicitudes de un encuentro ya cancelado o no activo.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rechazar_solicitud_encuentro_abierto(
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
    v_encuentro_id UUID;
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 1. Lookup sin bloqueo del encuentro_id asociado a la solicitud
    SELECT encuentro_id INTO v_encuentro_id
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    -- 2. Bloquear primero el encuentro (Orden canónico: 1. encuentros)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_encuentro_id
    FOR UPDATE;

    IF NOT FOUND OR v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- INVARIANTE H3: No permitir rechazar solicitudes de un encuentro cancelado o no activo
    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    -- 3. Bloquear y revalidar la solicitud (Orden canónico: 2. solicitudes_encuentro_abierto)
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
      AND encuentro_id = v_encuentro.id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    IF v_solicitud.estado <> 'pending' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_already_processed');
    END IF;

    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'rejected',
        resolved_at = v_now,
        updated_at = v_now
    WHERE id = p_request_id
      AND estado = 'pending';

    -- Domain Event en Outbox
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
        'encounter.join_request.rejected.v1',
        1,
        'encounter',
        v_encuentro.id,
        v_user_id,
        pg_catalog.jsonb_build_object(
            'request_id', p_request_id,
            'encounter_id', v_encuentro.id,
            'applicant_id', v_solicitud.usuario_id,
            'host_id', v_user_id
        ),
        pg_catalog.format('encounter:%s:join_request_rejected:%s', v_encuentro.id, p_request_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    -- Notificación en Inbox del solicitante (copy no punitivo)
    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_solicitud.usuario_id,
        p_notification_type := 'open_encounter_request_rejected',
        p_target_type := 'encounter',
        p_target_id := v_encuentro.id,
        p_deep_link := '/?tab=solicitudes',
        p_title := 'Actualización de tu solicitud',
        p_body := 'Tu solicitud para sumarte no fue aceptada.',
        p_payload := pg_catalog.jsonb_build_object(
            'encounter_id', v_encuentro.id,
            'request_id', p_request_id,
            'open_public_title', COALESCE(v_encuentro.open_public_title, 'Encuentro')
        ),
        p_dedup_key := 'join_request_rejected:' || p_request_id
    );

    RETURN pg_catalog.json_build_object('ok', true, 'request_id', p_request_id, 'estado', 'rejected');
END;
$$;

REVOKE ALL ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID) TO authenticated;


-- ------------------------------------------------------------------------------
-- 5. H3: cancelar_solicitud_encuentro_abierto
--    Orden canónico de bloqueo:
--      1. public.encuentros (FOR SHARE)
--      2. public.solicitudes_encuentro_abierto (FOR UPDATE)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancelar_solicitud_encuentro_abierto(
    p_request_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro_id UUID;
    v_encuentro public.encuentros%ROWTYPE;
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT encuentro_id INTO v_encuentro_id
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    -- 1. Bloquear encuentro primero (FOR SHARE serializa con FOR UPDATE de host)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_encuentro_id
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    -- 2. Bloquear solicitud y revalidar estado
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
      AND encuentro_id = v_encuentro.id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    IF v_solicitud.usuario_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_solicitud.estado <> 'pending' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_cancel_non_pending');
    END IF;

    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'cancelled',
        resolved_at = v_now,
        updated_at = v_now
    WHERE id = p_request_id
      AND estado = 'pending';

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
        'encounter.join_request.cancelled.v1',
        1,
        'encounter',
        v_solicitud.encuentro_id,
        v_user_id,
        pg_catalog.jsonb_build_object(
            'request_id', p_request_id,
            'encounter_id', v_solicitud.encuentro_id,
            'applicant_id', v_user_id
        ),
        pg_catalog.format('encounter:%s:join_request_cancelled:%s', v_solicitud.encuentro_id, p_request_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', p_request_id,
        'estado', 'cancelled'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_solicitud_encuentro_abierto(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_solicitud_encuentro_abierto(UUID) TO authenticated;


-- ------------------------------------------------------------------------------
-- 6. H3: cancelar_encuentro_seguro
--    Orden canónico de bloqueo:
--      1. public.encuentros (FOR UPDATE)
--      2. public.solicitudes_encuentro_abierto (FOR UPDATE ORDER BY id)
--      3. public.participantes (FOR UPDATE ORDER BY id)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancelar_encuentro_seguro(
    p_encuentro_id uuid,
    p_host_id uuid,
    p_cancellation_reason text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_title text;
    v_datetime_label text;
    v_clean_reason text;
    v_has_affected boolean := false;
    v_sol record;
    v_part record;
    v_notif_body text;
    v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- 1. Bloquear encuentro primero (Orden canónico: 1. encuentros)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- Idempotencia: si ya está cancelado, retornar éxito sin repetir efectos
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'id', p_encuentro_id,
            'estado', 'cancelado',
            'cancellation_reason', v_encuentro.cancellation_reason
        );
    END IF;

    -- 2. Bloquear solicitudes pendientes en orden determinista (Orden canónico: 2. solicitudes_encuentro_abierto)
    PERFORM 1
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND estado = 'pending'
    ORDER BY id
    FOR UPDATE;

    -- 3. Bloquear participantes confirmados en orden determinista (Orden canónico: 3. participantes)
    PERFORM 1
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id
      AND estado IN ('confirmado', 'asistio')
    ORDER BY id
    FOR UPDATE;

    v_clean_reason := NULLIF(pg_catalog.btrim(COALESCE(p_cancellation_reason, '')), '');

    -- 4. Revalidar usuarios afectados bajo los bloqueos adquiridos
    SELECT (
        EXISTS (
            SELECT 1 FROM public.participantes
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_user_id
        ) OR EXISTS (
            SELECT 1 FROM public.solicitudes_encuentro_abierto
            WHERE encuentro_id = p_encuentro_id
              AND estado = 'pending'
        )
    ) INTO v_has_affected;

    -- Si hay usuarios afectados, el motivo es OBLIGATORIO (mínimo 3 caracteres)
    IF v_has_affected AND (v_clean_reason IS NULL OR pg_catalog.length(v_clean_reason) < 3) THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'cancellation_reason_required',
            'message', 'Debés indicar un motivo de cancelación para avisar a los participantes o solicitantes.'
        );
    END IF;

    -- 5. Marcar encuentro como cancelado e inmediatamente cerrar Discovery e inscripciones
    UPDATE public.encuentros
    SET estado = 'cancelado',
        is_open = false,
        inscriptions_closed = true,
        inscriptions_closed_at = COALESCE(inscriptions_closed_at, v_now),
        cancelled_at = v_now,
        cancelled_by = v_user_id,
        cancellation_reason = v_clean_reason
    WHERE id = p_encuentro_id;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');
    v_datetime_label := CASE
        WHEN v_encuentro.fecha IS NOT NULL AND v_encuentro.hora IS NOT NULL THEN
            pg_catalog.to_char(v_encuentro.fecha, 'DD/MM/YYYY') || ' ' || pg_catalog.to_char(v_encuentro.hora, 'HH24:MI')
        WHEN v_encuentro.fecha IS NOT NULL THEN
            pg_catalog.to_char(v_encuentro.fecha, 'DD/MM/YYYY')
        ELSE 'Fecha a coordinar'
    END;

    -- 6. Transicionar solicitudes pendientes a 'cancelled' y notificar a cada solicitante
    FOR v_sol IN
        SELECT id, usuario_id, nombre_solicitante
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND estado = 'pending'
        ORDER BY id
    LOOP
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'cancelled',
            resolved_at = v_now,
            updated_at = v_now
        WHERE id = v_sol.id
          AND estado = 'pending';

        v_notif_body := 'Tu solicitud quedó sin efecto porque el encuentro fue cancelado' ||
            CASE WHEN v_clean_reason IS NOT NULL THEN ': ' || v_clean_reason ELSE '.' END;

        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_sol.usuario_id,
            p_notification_type := 'open_encounter_request_cancelled_by_host',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/?tab=solicitudes',
            p_title := 'Encuentro cancelado',
            p_body := v_notif_body,
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'request_id', v_sol.id,
                'title', v_title,
                'cancellation_reason', v_clean_reason,
                'priority', 'critical'
            ),
            p_dedup_key := 'cancelled_req:' || v_sol.id
        );
    END LOOP;

    -- 7. Notificar a los participantes confirmados
    FOR v_part IN
        SELECT DISTINCT user_id
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio')
          AND user_id IS NOT NULL
          AND user_id <> v_user_id
    LOOP
        v_notif_body := v_title || ' (' || v_datetime_label || ') fue cancelado' ||
            CASE WHEN v_clean_reason IS NOT NULL THEN ': ' || v_clean_reason ELSE '.' END;

        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_part.user_id,
            p_notification_type := 'encounter_cancelled_for_participant',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/?tab=encuentros',
            p_title := 'Encuentro cancelado',
            p_body := v_notif_body,
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'title', v_title,
                'original_date_label', v_datetime_label,
                'cancellation_reason', v_clean_reason,
                'priority', 'critical'
            ),
            p_dedup_key := 'cancelled_part:' || p_encuentro_id || ':' || v_part.user_id
        );
    END LOOP;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'estado', 'cancelado',
        'cancellation_reason', v_clean_reason
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_encuentro_seguro(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_encuentro_seguro(uuid, uuid, text) TO authenticated;


-- ------------------------------------------------------------------------------
-- 7. H3: cerrar_encuentro_abierto_seguro
--    Bloqueo FOR UPDATE y protección frente a encuentros cancelados o no activos
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cerrar_encuentro_abierto_seguro(
    p_encuentro_id UUID,
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
    v_encuentro public.encuentros%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- Bloqueo exclusivo FOR UPDATE para serializar con solicitar_sumarse_encuentro_abierto
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_modify_cancelled_encounter');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    UPDATE public.encuentros
    SET is_open = false,
        closed_at = COALESCE(closed_at, v_now)
    WHERE id = p_encuentro_id;

    RETURN pg_catalog.json_build_object('ok', true, 'encuentro_id', p_encuentro_id, 'is_open', false);
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_encuentro_abierto_seguro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cerrar_encuentro_abierto_seguro(UUID, UUID) TO authenticated;


-- ------------------------------------------------------------------------------
-- 8. H3: reconfirmar_asistencia_seguro
--    Orden canónico de bloqueo:
--      1. public.encuentros (FOR UPDATE)
--      2. public.solicitudes_encuentro_abierto (FOR UPDATE)
--      3. public.participantes (FOR UPDATE)
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
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_clean_motivo text := NULL;
    v_fell_below_min boolean := false;
    v_notif_body text;
    v_participant_name text;
    v_freed_seats int := 1;
    v_withdrawal_event_id uuid;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF p_decision NOT IN ('confirm', 'decline') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_decision');
    END IF;

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

    -- 1. Bloqueo exclusivo del encuentro (Orden canónico: 1. encuentros)
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

    -- 2. Bloquear solicitudes activas del usuario en este encuentro (Orden canónico: 2. solicitudes_encuentro_abierto)
    PERFORM 1
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
      AND estado = 'approved'
    ORDER BY id
    FOR UPDATE;

    -- 3. Bloquear participante (Orden canónico: 3. participantes)
    SELECT * INTO v_part
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id
      AND user_id = v_user_id
    ORDER BY (estado IN ('confirmado', 'asistio')) DESC, creado_en DESC, id DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'participant_not_found');
    END IF;

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
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'participant_withdrawn',
                'message', 'No podés reconfirmar una participación que ya fue dada de baja.'
            );
        END IF;
    END IF;

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
        v_withdrawal_event_id := pg_catalog.gen_random_uuid();

        UPDATE public.participantes
        SET reconfirmation_status = 'declined',
            reconfirmed_at = v_now,
            estado = 'cancelado',
            mensaje_respuesta = COALESCE(v_clean_motivo, mensaje_respuesta),
            token_invitacion = CASE
                WHEN COALESCE(v_encuentro.is_open, false) = true OR v_encuentro.opened_at IS NOT NULL THEN pg_catalog.gen_random_uuid()
                ELSE token_invitacion
            END
        WHERE id = v_part.id;

        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'cancelled',
            token_participante = NULL,
            motivo_baja = v_clean_motivo,
            resolved_at = v_now,
            updated_at = v_now
        WHERE encuentro_id = p_encuentro_id
          AND estado = 'approved'
          AND (participante_id = v_part.id OR usuario_id = v_user_id);

        SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
        INTO v_new_confirmed_seats
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio');

        IF v_encuentro.min_participants IS NOT NULL
           AND v_encuentro.realization_status = 'confirmed'
           AND v_new_confirmed_seats < v_encuentro.min_participants THEN

            v_fell_below_min := true;

            UPDATE public.encuentros
            SET realization_status = 'pending',
                min_confirmed_notified_at = NULL
            WHERE id = p_encuentro_id;

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
                    p_dedup_key := 'below_min_part:' || p_encuentro_id || ':' || v_withdrawal_event_id || ':' || v_part_rec.user_id
                );
            END LOOP;
        END IF;

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
            'encounter.participant.withdrawn.v1',
            1,
            'encounter',
            p_encuentro_id,
            v_user_id,
            pg_catalog.jsonb_build_object(
                'withdrawal_event_id', v_withdrawal_event_id,
                'encounter_id', p_encuentro_id,
                'participant_id', v_part.id,
                'participant_user_id', v_user_id,
                'host_id', v_encuentro.host_id,
                'freed_seats', v_freed_seats,
                'fell_below_min', v_fell_below_min
            ),
            pg_catalog.format('encounter:%s:participant_withdrawn:%s', p_encuentro_id, v_withdrawal_event_id),
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;

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
                    'withdrawal_event_id', v_withdrawal_event_id,
                    'title', v_title,
                    'participant_user_id', v_user_id,
                    'participant_name', v_participant_name,
                    'freed_seats', v_freed_seats,
                    'cancellation_reason', v_clean_motivo,
                    'fell_below_min', v_fell_below_min
                ),
                p_dedup_key := 'part_withdrawn:' || p_encuentro_id || ':' || v_withdrawal_event_id
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

REVOKE ALL ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text, text) TO authenticated;


-- ------------------------------------------------------------------------------
-- 9. H3: solicitar_sumarse_encuentro_abierto
--    Respuesta controlada ante unique_violation concurrente
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.solicitar_sumarse_encuentro_abierto(
    p_encuentro_id UUID,
    p_nombre TEXT,
    p_mensaje TEXT DEFAULT NULL,
    p_usuario_id UUID DEFAULT NULL,
    p_seat_count INT DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats INT := 0;
    v_solicitud_id UUID;
    v_clean_nombre TEXT;
    v_rejected_at TIMESTAMPTZ;
    v_rl JSONB;
    v_effective_seat_count INT := 1;
    v_available_seats INT;
    v_notif_body TEXT;
    v_min_seats INT := 1;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_clean_nombre := pg_catalog.btrim(COALESCE(p_nombre, ''));
    IF pg_catalog.length(v_clean_nombre) < 2 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_name');
    END IF;

    -- Concurrencia: FOR SHARE bloquea lectura stale si una transacción concurrente está
    -- cerrando inscripciones (cerrar_inscripciones_seguro), cerrando publicación (cerrar_encuentro_abierto_seguro),
    -- aprobando cupos o cancelando con FOR UPDATE.
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.is_open <> true OR v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_available');
    END IF;

    IF COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'inscriptions_closed',
            'message', 'Las inscripciones para este encuentro están cerradas.'
        );
    END IF;

    IF v_encuentro.moderation_status <> 'approved' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'content_not_approved');
    END IF;

    IF v_encuentro.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_request_own_encounter');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_encuentro.host_id)
           OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_available');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado = 'pending'
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_requested');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_user_id
          AND estado IN ('confirmado', 'asistio')
    ) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_joined');
    END IF;

    SELECT COALESCE(resolved_at, updated_at, created_at)
    INTO v_rejected_at
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
      AND estado = 'rejected'
    ORDER BY COALESCE(resolved_at, updated_at, created_at) DESC
    LIMIT 1;

    IF v_rejected_at IS NOT NULL AND v_rejected_at > (v_now - INTERVAL '24 hours') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cooldown_active');
    END IF;

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    v_available_seats := GREATEST(0, v_encuentro.max_participants - v_confirmed_seats);

    IF v_available_seats <= 0 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    v_min_seats := COALESCE(v_encuentro.min_seats_per_request, 1);

    IF v_available_seats < v_min_seats THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    IF COALESCE(v_encuentro.allow_multi_seat_requests, false) = true THEN
        v_effective_seat_count := GREATEST(1, COALESCE(p_seat_count, 1));
        IF v_effective_seat_count < v_min_seats THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'below_min_seats_per_request');
        END IF;
        IF v_effective_seat_count > COALESCE(v_encuentro.max_seats_per_request, 1) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'exceeds_max_seats_per_request');
        END IF;
        IF v_effective_seat_count > v_available_seats THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'quota_exceeded');
        END IF;
    ELSE
        IF p_seat_count IS NOT NULL AND p_seat_count > 1 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'multi_seat_disabled');
        END IF;
        v_effective_seat_count := 1;
    END IF;

    v_rl := public.verificar_y_consumir_rate_limit(v_user_id, 'join_request', 5, INTERVAL '1 hour');
    IF (v_rl->>'allowed')::boolean = false THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'rate_limit_exceeded',
            'reset_at', v_rl->>'reset_at'
        );
    END IF;

    BEGIN
        INSERT INTO public.solicitudes_encuentro_abierto (
            encuentro_id,
            usuario_id,
            nombre_solicitante,
            mensaje,
            estado,
            seat_count,
            created_at,
            updated_at
        ) VALUES (
            p_encuentro_id,
            v_user_id,
            v_clean_nombre,
            NULLIF(pg_catalog.btrim(COALESCE(p_mensaje, '')), ''),
            'pending',
            v_effective_seat_count,
            v_now,
            v_now
        )
        RETURNING id INTO v_solicitud_id;
    EXCEPTION
        WHEN unique_violation THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_requested');
    END;

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
        'encounter.join_request.created.v1',
        1,
        'encounter',
        p_encuentro_id,
        v_user_id,
        pg_catalog.jsonb_build_object(
            'request_id', v_solicitud_id,
            'encounter_id', p_encuentro_id,
            'applicant_id', v_user_id,
            'host_id', v_encuentro.host_id,
            'seat_count', v_effective_seat_count
        ),
        pg_catalog.format('encounter:%s:join_request:%s', p_encuentro_id, v_solicitud_id),
        'pending'
    )
    ON CONFLICT (dedup_key) DO NOTHING;

    v_notif_body := CASE
        WHEN v_effective_seat_count > 1 THEN v_clean_nombre || ' solicitó ' || v_effective_seat_count || ' lugares.'
        ELSE v_clean_nombre || ' solicitó 1 lugar.'
    END;

    PERFORM public.insertar_inbox_notification_seguro(
        p_recipient_user_id := v_encuentro.host_id,
        p_notification_type := 'open_encounter_join_requested',
        p_target_type := 'encounter',
        p_target_id := p_encuentro_id,
        p_deep_link := '/meet/' || p_encuentro_id || '#solicitudes',
        p_title := 'Nueva solicitud para sumarse',
        p_body := v_notif_body,
        p_payload := pg_catalog.jsonb_build_object(
            'encounter_id', p_encuentro_id,
            'request_id', v_solicitud_id,
            'applicant_id', v_user_id,
            'applicant_name', v_clean_nombre,
            'seat_count', v_effective_seat_count
        ),
        p_dedup_key := 'join_requested:' || v_solicitud_id
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', v_solicitud_id,
        'solicitud_id', v_solicitud_id,
        'encuentro_id', p_encuentro_id,
        'estado', 'pending',
        'seat_count', v_effective_seat_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) TO authenticated;

COMMIT;
