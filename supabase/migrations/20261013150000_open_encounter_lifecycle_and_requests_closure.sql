-- ============================================================
-- Migración: 20261013150000_open_encounter_lifecycle_and_requests_closure.sql
-- Cierre del flujo: SOLICITAR -> ACEPTAR/RECHAZAR -> PARTICIPAR
--
-- 1. Aprobación y Rechazo con generación atómica de notificaciones en Inbox y Outbox.
-- 2. Cancelación segura de solicitudes pendientes (cancelar_solicitud_encuentro_abierto).
-- 3. Fuente de verdad durable no sensible para Mis solicitudes (get_mis_solicitudes_seguro).
-- 4. Detalle privado autorizado para participantes confirmados (get_encuentro_participante_autorizado).
-- 5. Conteo server-side de solicitudes pendientes por encuentro para el host.
-- 6. Recordatorio durable a las 24 h para solicitudes pendientes con scheduling pg_cron.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Actualización de aprobar_solicitud_encuentro_abierto
-- ------------------------------------------------------------
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

    -- 4. Crear participante asignando seat_count aprobado
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
        seat_count
    ) VALUES (
        v_participante_id,
        v_encuentro.id,
        v_solicitud.nombre_solicitante,
        'individual',
        'confirmado',
        v_token_invitacion,
        v_solicitud.mensaje,
        v_solicitud.usuario_id,
        v_req_seats
    );

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

    -- 7. Notificación canónica inmediata e idempotente en Inbox del solicitante
    -- Deep link lleva a Mi espacio -> Mis encuentros -> Ver encuentro (flujo autenticado)
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

    v_nuevo_disponible := GREATEST(0, v_encuentro.max_participants - (v_confirmed_seats + v_req_seats));

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'request_id', p_request_id,
        'participante_id', v_participante_id,
        'token_invitacion', v_token_invitacion,
        'seat_count', v_req_seats,
        'nuevo_cupo_disponible', v_nuevo_disponible
    );
END;
$$;

REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) TO authenticated;


-- ------------------------------------------------------------
-- 2. Actualización de rechazar_solicitud_encuentro_abierto
-- ------------------------------------------------------------
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
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

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

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_solicitud.encuentro_id;

    IF NOT FOUND OR v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'rejected',
        resolved_at = v_now,
        updated_at = v_now
    WHERE id = p_request_id;

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


-- ------------------------------------------------------------
-- 3. RPC cancelar_solicitud_encuentro_abierto
-- ------------------------------------------------------------
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
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
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
    WHERE id = p_request_id;

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


-- ------------------------------------------------------------
-- 4. RPC get_mis_solicitudes_seguro (Listado NO sensible)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_mis_solicitudes_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_result JSON;
BEGIN
    IF v_user_id IS NULL OR v_is_anon THEN
        RETURN '[]'::json;
    END IF;

    SELECT pg_catalog.json_agg(
        pg_catalog.json_build_object(
            'request_id',        s.id,
            'encuentro_id',      s.encuentro_id,
            'estado',            s.estado,
            'seat_count',        COALESCE(s.seat_count, 1),
            'created_at',        s.created_at,
            'resolved_at',       s.resolved_at,
            'open_public_title', COALESCE(e.open_public_title, 'Encuentro'),
            'fecha',             e.fecha,
            'hora',              e.hora,
            'modalidad',         e.modalidad,
            'open_public_zone',  COALESCE(e.open_public_zone, 'Virtual'),
            'is_expired',        (e.fecha IS NOT NULL AND (e.fecha + COALESCE(e.hora, '23:59'::time)) < pg_catalog.now())
        )
        ORDER BY (s.estado = 'pending') DESC, s.created_at DESC
    )
    INTO v_result
    FROM public.solicitudes_encuentro_abierto s
    JOIN public.encuentros e ON e.id = s.encuentro_id
    WHERE s.usuario_id = v_user_id;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_mis_solicitudes_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mis_solicitudes_seguro() TO authenticated;


-- ------------------------------------------------------------
-- 5. RPC get_encuentro_participante_autorizado
-- Autorización server-side: host_id = auth.uid() OR participante confirmado/asistió.
-- Para participante de encuentro abierto NO expone titulo ni descripcion privados.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_encuentro_participante_autorizado(
    p_encuentro_id UUID
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
    v_is_host BOOLEAN := false;
    v_is_participant BOOLEAN := false;
    v_part_seats INT := 1;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    v_is_host := (v_encuentro.host_id = v_user_id);

    IF NOT v_is_host THEN
        SELECT EXISTS (
            SELECT 1 FROM public.participantes p
            WHERE p.encuentro_id = p_encuentro_id
              AND p.user_id = v_user_id
              AND p.estado IN ('confirmado', 'asistio')
        ) INTO v_is_participant;

        IF NOT v_is_participant THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        SELECT COALESCE(p.seat_count, 1) INTO v_part_seats
        FROM public.participantes p
        WHERE p.encuentro_id = p_encuentro_id
          AND p.user_id = v_user_id
          AND p.estado IN ('confirmado', 'asistio')
        LIMIT 1;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', v_encuentro.id,
        'is_host', v_is_host,
        'open_public_title', COALESCE(v_encuentro.open_public_title, v_encuentro.titulo),
        'open_description', v_encuentro.open_description,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'open_public_zone', v_encuentro.open_public_zone,
        'lugar_texto', CASE WHEN v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto ELSE NULL END,
        'link_virtual', CASE WHEN v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual ELSE NULL END,
        'seat_count', CASE WHEN v_is_host THEN NULL ELSE v_part_seats END,
        'estado', v_encuentro.estado
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_participante_autorizado(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentro_participante_autorizado(UUID) TO authenticated;


-- ------------------------------------------------------------
-- 6. Actualización de get_encuentros_host_seguro (conteo pending_requests_count)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_encuentros_host_seguro(
    p_host_ids uuid[] DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid;
    v_result  json;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('error', 'unauthenticated');
    END IF;

    SELECT pg_catalog.json_agg(
        pg_catalog.json_build_object(
            'id',              e.id,
            'titulo',          e.titulo,
            'open_public_title', e.open_public_title,
            'descripcion',     e.descripcion,
            'open_description', e.open_description,
            'fecha',           e.fecha,
            'hora',            e.hora,
            'modalidad',       e.modalidad,
            'lugar_texto',     e.lugar_texto,
            'link_virtual',    e.link_virtual,
            'tipo_invitacion', e.tipo_invitacion,
            'host_id',         e.host_id,
            'public_token',    e.public_token,
            'estado',          e.estado,
            'tema',            e.tema,
            'reemplaza_a',     e.reemplaza_a,
            'creado_en',       e.creado_en,
            'tema_invitacion',     e.tema_invitacion,
            'invitation_template', e.invitation_template,
            'date_mode',           e.date_mode,
            'coordination_status', e.coordination_status,
            'response_deadline',   e.response_deadline,
            'duration_minutes',    e.duration_minutes,
            'selected_option_id',  e.selected_option_id,
            'is_open',             COALESCE(e.is_open, false),
            'max_participants',    e.max_participants,
            'pending_requests_count', (
                SELECT pg_catalog.count(*)::int
                FROM public.solicitudes_encuentro_abierto s
                WHERE s.encuentro_id = e.id AND s.estado = 'pending'
            ),
            'option_count',        (
                SELECT pg_catalog.count(*)
                FROM public.encuentro_opciones_fecha o
                WHERE o.encuentro_id = e.id
            ),
            'post_event_active_minutes', COALESCE(e.post_event_active_minutes, 45),
            'last_option_at',            (
                SELECT MAX(
                    (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                )
                FROM public.encuentro_opciones_fecha o
                WHERE o.encuentro_id = e.id
            ),
            'has_future_options',        (
                EXISTS (
                    SELECT 1
                    FROM public.encuentro_opciones_fecha o
                    WHERE o.encuentro_id = e.id
                      AND (
                          (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                          + pg_catalog.make_interval(mins => COALESCE(e.duration_minutes, e.post_event_active_minutes, 45))
                      ) >= pg_catalog.now()
                )
            )
        )
        ORDER BY e.creado_en DESC
    )
    INTO v_result
    FROM public.encuentros e
    WHERE e.host_id = v_user_id;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentros_host_seguro(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentros_host_seguro(uuid[]) TO authenticated;


-- ------------------------------------------------------------
-- 7. Recordatorio durable a las 24 h para solicitudes pendientes
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.procesar_recordatorio_solicitudes_pendientes()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_threshold TIMESTAMPTZ := v_now - interval '24 hours';
    v_row RECORD;
    v_reminded_count INT := 0;
BEGIN
    FOR v_row IN
        SELECT
            s.id AS request_id,
            s.encuentro_id,
            s.nombre_solicitante,
            s.seat_count,
            e.host_id,
            COALESCE(e.open_public_title, e.titulo, 'tu encuentro') AS title
        FROM public.solicitudes_encuentro_abierto s
        JOIN public.encuentros e ON e.id = s.encuentro_id
        WHERE s.estado = 'pending'
          AND s.created_at <= v_threshold
          AND e.estado = 'activo'
          AND e.is_open = true
          AND (e.fecha IS NULL OR (e.fecha + COALESCE(e.hora, '23:59'::time)) >= v_now)
          AND NOT EXISTS (
              SELECT 1 FROM public.inbox_notifications n
              WHERE n.recipient_user_id = e.host_id
                AND n.dedup_key = 'join_request_reminder:' || s.id
          )
    LOOP
        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_row.host_id,
            p_notification_type := 'open_encounter_pending_request_reminder',
            p_target_type := 'encounter',
            p_target_id := v_row.encuentro_id,
            p_deep_link := '/meet/' || v_row.encuentro_id || '#solicitudes',
            p_title := 'Recordatorio: solicitud pendiente',
            p_body := 'Tenés una solicitud de ' || v_row.nombre_solicitante || ' pendiente en ' || v_row.title || '.',
            p_payload := pg_catalog.jsonb_build_object(
                'encounter_id', v_row.encuentro_id,
                'request_id', v_row.request_id,
                'seat_count', v_row.seat_count
            ),
            p_dedup_key := 'join_request_reminder:' || v_row.request_id
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
            'encounter.join_request.reminder.v1',
            1,
            'encounter',
            v_row.encuentro_id,
            v_row.host_id,
            pg_catalog.jsonb_build_object(
                'request_id', v_row.request_id,
                'encounter_id', v_row.encuentro_id
            ),
            pg_catalog.format('encounter:%s:reminder:%s', v_row.encuentro_id, v_row.request_id),
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;

        v_reminded_count := v_reminded_count + 1;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'reminded_count', v_reminded_count);
END;
$$;

REVOKE ALL ON FUNCTION public.procesar_recordatorio_solicitudes_pendientes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.procesar_recordatorio_solicitudes_pendientes() TO service_role;

-- Programar en pg_cron si está disponible
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('recordatorio_solicitudes_pendientes_job');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        PERFORM cron.schedule(
            'recordatorio_solicitudes_pendientes_job',
            '0 * * * *',
            'SELECT public.procesar_recordatorio_solicitudes_pendientes();'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

COMMIT;
