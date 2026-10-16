-- ==============================================================================
-- Migración: 20261016150000_harden_actualizar_encuentro_and_critical_notifications.sql
-- Propósito:
--   1. Blindar actualizar_encuentro_seguro (H1) para impedir transiciones de estado
--      arbitrarias mediante p_data->>'estado', rechazando intentos no autorizados
--      con 'state_transition_not_allowed' y manteniendo estado = estado.
--   2. Extender actualizar_encuentro_seguro (H5) para emitir notificaciones
--      transaccionales ante cambios efectivos en fecha, hora, lugar_texto o link_virtual
--      en Encuentros Abiertos, preservando la privacidad estricta de solicitantes
--      pendientes y deduplicando con claves resilientes a reintentos.
--   3. Proveer RPC get_notificaciones_criticas_no_leidas_seguro (H8) para
--      recuperación directa y liviana de avisos urgentes sin requerir abrir la campana.
-- ==============================================================================

DROP FUNCTION IF EXISTS public.get_notificaciones_criticas_no_leidas_seguro();

CREATE OR REPLACE FUNCTION public.get_notificaciones_criticas_no_leidas_seguro()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_items JSONB := '[]'::jsonb;
    v_rows RECORD;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

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
            false AS is_read,
            expires_at,
            created_at
        FROM public.inbox_notifications
        WHERE recipient_user_id = v_user_id
          AND read_at IS NULL
          AND expires_at > v_now
          AND (
              notification_type IN (
                  'encounter_cancelled_for_participant',
                  'open_encounter_request_cancelled_by_host',
                  'encounter_schedule_changed'
              )
              OR (payload->>'priority' = 'critical')
          )
        ORDER BY created_at ASC, id ASC
        LIMIT 50
    LOOP
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
    END LOOP;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'data', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.get_notificaciones_criticas_no_leidas_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_notificaciones_criticas_no_leidas_seguro() TO authenticated;


-- ------------------------------------------------------------------------------
-- 2. RPC: actualizar_encuentro_seguro (HARDENED CON NOTIFICACIONES CRÍTICAS)
-- ------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.actualizar_encuentro_seguro(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.actualizar_encuentro_seguro(UUID, UUID, JSON);

CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,
    p_data JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());

    v_title_changed BOOLEAN := false;
    v_open_title_changed BOOLEAN := false;
    v_open_desc_changed BOOLEAN := false;
    v_modality_changed BOOLEAN := false;
    v_locality_changed BOOLEAN := false;
    v_zone_changed BOOLEAN := false;

    v_moderation_invalidated BOOLEAN := false;
    v_new_status TEXT := NULL;
    v_new_is_open BOOLEAN := NULL;
    v_det_reason TEXT := NULL;

    v_new_title TEXT;
    v_new_open_title TEXT;
    v_new_open_desc TEXT;
    v_new_modalidad TEXT;
    v_new_locality_id TEXT;
    v_new_public_zone TEXT;
    v_new_max_participants INT;
    v_new_allow_multi BOOLEAN;
    v_new_max_seats INT;
    v_new_min_seats INT;
    v_confirmed_seats INT := 0;

    v_loc_record RECORD;
    v_eval RECORD;
    v_effective_eval_title TEXT;
    v_changed_fields TEXT[] := ARRAY[]::TEXT[];

    -- Variables para detección de agenda y logística
    v_final_fecha DATE;
    v_final_hora TIME;
    v_final_lugar_texto TEXT;
    v_final_link_virtual TEXT;
    v_schedule_changed BOOLEAN := false;
    v_logistics_changed BOOLEAN := false;
    v_is_open_encounter BOOLEAN := false;
    v_title TEXT;
    v_datetime_label TEXT;
    v_part RECORD;
    v_sol RECORD;
    v_schedule_mutation_id UUID;
    v_logistics_mutation_id UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_user_id <> p_host_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_not_active');
    END IF;

    -- H1: Prohibir transiciones de estado a través de actualizar_encuentro_seguro
    IF p_data ? 'estado' AND (p_data->>'estado') IS DISTINCT FROM v_encuentro.estado THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'state_transition_not_allowed');
    END IF;

    IF v_encuentro.is_open = true AND p_data ? 'modalidad' AND (p_data->>'modalidad') <> v_encuentro.modalidad THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_change_modality_while_open');
    END IF;

    v_new_title := CASE WHEN p_data ? 'titulo' THEN NULLIF(pg_catalog.btrim(p_data->>'titulo'), '') ELSE v_encuentro.titulo END;
    v_new_open_title := CASE WHEN p_data ? 'open_public_title' THEN NULLIF(pg_catalog.btrim(p_data->>'open_public_title'), '') ELSE v_encuentro.open_public_title END;
    v_new_open_desc := CASE WHEN p_data ? 'open_description' THEN NULLIF(pg_catalog.btrim(p_data->>'open_description'), '') ELSE v_encuentro.open_description END;
    v_new_modalidad := COALESCE(p_data->>'modalidad', v_encuentro.modalidad);
    v_new_locality_id := CASE WHEN p_data ? 'locality_id' THEN p_data->>'locality_id' ELSE v_encuentro.locality_id END;
    v_new_public_zone := CASE WHEN p_data ? 'open_public_zone' THEN p_data->>'open_public_zone' ELSE v_encuentro.open_public_zone END;

    IF p_data ? 'open_public_title' THEN
        IF v_new_open_title IS NULL OR pg_catalog.length(v_new_open_title) < 3 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'title_too_short');
        END IF;
        IF pg_catalog.length(v_new_open_title) > 80 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'title_too_long');
        END IF;
    END IF;

    IF p_data ? 'max_participants' THEN
        v_new_max_participants := (p_data->>'max_participants')::int;
        IF v_new_max_participants IS NULL OR v_new_max_participants < 1 OR v_new_max_participants > 40 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_slots');
        END IF;

        SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

        IF v_new_max_participants < v_confirmed_seats THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'max_participants_too_low');
        END IF;
    ELSE
        v_new_max_participants := v_encuentro.max_participants;
    END IF;

    IF p_data ? 'allow_multi_seat_requests' THEN
        v_new_allow_multi := (p_data->>'allow_multi_seat_requests')::boolean;
    ELSE
        v_new_allow_multi := v_encuentro.allow_multi_seat_requests;
    END IF;

    IF p_data ? 'max_seats_per_request' THEN
        v_new_max_seats := (p_data->>'max_seats_per_request')::int;
    ELSE
        v_new_max_seats := v_encuentro.max_seats_per_request;
    END IF;

    IF p_data ? 'min_seats_per_request' THEN
        v_new_min_seats := (p_data->>'min_seats_per_request')::int;
    ELSE
        v_new_min_seats := COALESCE(v_encuentro.min_seats_per_request, 1);
    END IF;

    IF COALESCE(v_new_allow_multi, false) THEN
        IF v_new_max_seats IS NULL OR v_new_max_seats < 2 OR (v_new_max_participants IS NOT NULL AND v_new_max_seats > v_new_max_participants) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_max_seats_per_request');
        END IF;
        IF v_new_min_seats IS NOT NULL AND (v_new_min_seats < 1 OR v_new_min_seats > v_new_max_seats) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_min_seats_per_request');
        END IF;
    ELSE
        v_new_max_seats := 1;
        v_new_min_seats := 1;
    END IF;

    IF p_data ? 'locality_id' AND v_new_locality_id IS NOT NULL AND NOT (p_data ? 'open_public_zone') THEN
        SELECT * INTO v_loc_record FROM public.localidades WHERE id = v_new_locality_id AND activo = true;
        IF FOUND THEN
            v_new_public_zone := v_loc_record.nombre;
        END IF;
    END IF;

    -- Detectar cambios en campos moderables públicos
    IF p_data ? 'titulo' AND COALESCE(v_new_title, '') <> COALESCE(v_encuentro.titulo, '') THEN
        v_title_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'titulo');
    END IF;

    IF p_data ? 'open_public_title' AND COALESCE(v_new_open_title, '') <> COALESCE(v_encuentro.open_public_title, '') THEN
        v_open_title_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_public_title');
    END IF;

    IF p_data ? 'open_description' AND COALESCE(v_new_open_desc, '') <> COALESCE(v_encuentro.open_description, '') THEN
        v_open_desc_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_description');
    END IF;

    IF p_data ? 'modalidad' AND COALESCE(v_new_modalidad, '') <> COALESCE(v_encuentro.modalidad, '') THEN
        v_modality_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'modalidad');
    END IF;

    IF p_data ? 'locality_id' AND COALESCE(v_new_locality_id, '') <> COALESCE(v_encuentro.locality_id, '') THEN
        v_locality_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'locality_id');
    END IF;

    IF p_data ? 'open_public_zone' AND COALESCE(v_new_public_zone, '') <> COALESCE(v_encuentro.open_public_zone, '') THEN
        v_zone_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_public_zone');
    END IF;

    -- Si el encuentro alguna vez fue abierto/moderado y se modificó algún campo público
    IF v_encuentro.moderation_status IN ('approved', 'rejected') AND (v_open_title_changed OR v_open_desc_changed OR v_modality_changed OR v_locality_changed OR v_zone_changed) THEN
        v_effective_eval_title := COALESCE(v_new_open_title, v_encuentro.open_public_title, v_new_title, v_encuentro.titulo);

        -- Invariante de privacidad: solo evaluar campos públicos
        SELECT * INTO v_eval FROM public.evaluar_contenido_publico_determinista(
            v_effective_eval_title,
            COALESCE(v_new_open_desc, v_encuentro.open_description, '')
        );

        v_moderation_invalidated := true;

        IF v_eval.decision = 'block' THEN
            v_new_status := 'rejected';
            v_new_is_open := false;
            v_det_reason := v_eval.reason;
        ELSE
            v_new_status := 'review_pending';
            v_new_is_open := false;
        END IF;
    END IF;

    -- H5: Cálculo seguro de valores finales de agenda y logística
    v_final_fecha := CASE
        WHEN p_data ? 'fecha' THEN (p_data->>'fecha')::date
        ELSE v_encuentro.fecha
    END;

    v_final_hora := CASE
        WHEN p_data ? 'hora' THEN (p_data->>'hora')::time
        ELSE v_encuentro.hora
    END;

    v_final_lugar_texto := CASE
        WHEN p_data ? 'lugar_texto' THEN NULLIF(pg_catalog.btrim(p_data->>'lugar_texto'), '')
        ELSE v_encuentro.lugar_texto
    END;

    v_final_link_virtual := CASE
        WHEN p_data ? 'link_virtual' THEN NULLIF(pg_catalog.btrim(p_data->>'link_virtual'), '')
        ELSE v_encuentro.link_virtual
    END;

    v_schedule_changed := (v_final_fecha IS DISTINCT FROM v_encuentro.fecha) OR (v_final_hora IS DISTINCT FROM v_encuentro.hora);
    v_logistics_changed := (v_final_lugar_texto IS DISTINCT FROM v_encuentro.lugar_texto) OR (v_final_link_virtual IS DISTINCT FROM v_encuentro.link_virtual);

    v_is_open_encounter := (v_encuentro.is_open OR v_encuentro.opened_at IS NOT NULL OR EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = p_encuentro_id
    ));

    -- Actualización atómica en base de datos
    UPDATE public.encuentros
    SET
        titulo = v_new_title,
        open_public_title = v_new_open_title,
        descripcion = CASE
            WHEN p_data ? 'descripcion'
            THEN p_data->>'descripcion'
            ELSE descripcion
        END,
        open_description = v_new_open_desc,
        max_participants = v_new_max_participants,
        allow_multi_seat_requests = COALESCE(v_new_allow_multi, false),
        max_seats_per_request = COALESCE(v_new_max_seats, 1),
        min_seats_per_request = COALESCE(v_new_min_seats, 1),
        fecha = v_final_fecha,
        hora = v_final_hora,
        modalidad = v_new_modalidad,
        locality_id = v_new_locality_id,
        open_public_zone = v_new_public_zone,
        lugar_texto = v_final_lugar_texto,
        link_virtual = v_final_link_virtual,
        tipo_invitacion = COALESCE(
            p_data->>'tipo_invitacion',
            tipo_invitacion
        ),
        -- H1: Mantener estado actual, nunca permitir transición mediante p_data
        estado = estado,
        tema = CASE WHEN p_data ? 'tema' THEN p_data->>'tema' ELSE tema END,
        tema_invitacion = CASE
            WHEN p_data ? 'tema_invitacion'
                 AND p_data->>'tema_invitacion' IN (
                    'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
                    'family', 'special', 'romantic', 'sports', 'entertainment',
                    'learning', 'wellness', 'custom'
                 )
            THEN p_data->>'tema_invitacion'
            ELSE tema_invitacion
        END,
        invitation_template = CASE WHEN p_data ? 'invitation_template' THEN p_data->>'invitation_template' ELSE invitation_template END,
        reemplaza_a = CASE
            WHEN p_data ? 'reemplaza_a'
                 AND p_data->>'reemplaza_a' IS NOT NULL
                 AND p_data->>'reemplaza_a' <> ''
            THEN (p_data->>'reemplaza_a')::uuid
            WHEN p_data ? 'reemplaza_a'
            THEN NULL
            ELSE reemplaza_a
        END,
        moderation_status = COALESCE(v_new_status, moderation_status),
        is_open = COALESCE(v_new_is_open, is_open),
        moderated_at = CASE WHEN v_moderation_invalidated THEN v_now ELSE moderated_at END,
        moderation_reason = CASE
            WHEN v_moderation_invalidated AND v_new_status = 'rejected' THEN v_det_reason
            WHEN v_moderation_invalidated THEN 'content_updated'
            ELSE moderation_reason
        END,
        moderation_decision_source = CASE
            WHEN v_moderation_invalidated AND v_new_status = 'rejected' THEN 'deterministic'
            WHEN v_moderation_invalidated THEN 'content_update'
            ELSE moderation_decision_source
        END,
        closed_at = CASE WHEN v_moderation_invalidated AND v_encuentro.is_open THEN v_now ELSE closed_at END
    WHERE id = p_encuentro_id
      AND host_id = v_user_id;

    -- H5: Emisión de notificaciones transaccionales para Encuentros Abiertos
    IF v_is_open_encounter THEN
        v_title := COALESCE(v_new_open_title, v_encuentro.open_public_title, v_new_title, v_encuentro.titulo, 'Encuentro');
        v_datetime_label := CASE
            WHEN v_final_fecha IS NOT NULL AND v_final_hora IS NOT NULL THEN
                pg_catalog.to_char(v_final_fecha, 'DD/MM/YYYY') || ' ' || pg_catalog.to_char(v_final_hora, 'HH24:MI')
            WHEN v_final_fecha IS NOT NULL THEN
                pg_catalog.to_char(v_final_fecha, 'DD/MM/YYYY')
            ELSE 'Fecha a coordinar'
        END;

        -- A. Cambio de fecha u horario
        IF v_schedule_changed THEN
            v_schedule_mutation_id := pg_catalog.gen_random_uuid();

            -- Si inscripciones cerradas, reiniciar reconfirmación de confirmados sin alterar participación
            IF COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
                UPDATE public.participantes
                SET reconfirmation_status = 'pending',
                    reconfirmed_at = NULL
                WHERE encuentro_id = p_encuentro_id
                  AND estado = 'confirmado';
            END IF;

            -- 1. Notificar a cada participante confirmado (crítica, para modal)
            FOR v_part IN
                SELECT DISTINCT user_id
                FROM public.participantes
                WHERE encuentro_id = p_encuentro_id
                  AND estado IN ('confirmado', 'asistio')
                  AND user_id IS NOT NULL
                  AND user_id <> v_user_id
            LOOP
                PERFORM public.insertar_inbox_notification_seguro(
                    v_part.user_id,
                    'encounter_schedule_changed',
                    'encounter',
                    p_encuentro_id,
                    '/?open_detail=' || p_encuentro_id,
                    'Cambio de fecha u horario',
                    'El organizador modificó la fecha u horario del encuentro "' || v_title || '". Nueva fecha: ' || v_datetime_label || '.',
                    pg_catalog.jsonb_build_object(
                        'encounter_id', p_encuentro_id,
                        'title', v_title,
                        'fecha', v_final_fecha,
                        'hora', v_final_hora,
                        'date_label', v_datetime_label,
                        'priority', 'critical',
                        'change_type', 'schedule'
                    ),
                    'sched:' || v_schedule_mutation_id || ':' || v_part.user_id
                );
            END LOOP;

            -- 2. Notificar a cada solicitante pendiente (datos públicos exclusivamente)
            FOR v_sol IN
                SELECT DISTINCT usuario_id
                FROM public.solicitudes_encuentro_abierto
                WHERE encuentro_id = p_encuentro_id
                  AND estado = 'pending'
                  AND usuario_id IS NOT NULL
                  AND usuario_id <> v_user_id
            LOOP
                PERFORM public.insertar_inbox_notification_seguro(
                    v_sol.usuario_id,
                    'encounter_schedule_changed',
                    'encounter',
                    p_encuentro_id,
                    '/?open_detail=' || p_encuentro_id,
                    'Cambio de fecha u horario',
                    'El organizador modificó la fecha u horario del encuentro "' || v_title || '". Nueva fecha: ' || v_datetime_label || COALESCE(' (Zona: ' || v_new_public_zone || ')', '') || '.',
                    pg_catalog.jsonb_build_object(
                        'encounter_id', p_encuentro_id,
                        'title', v_title,
                        'fecha', v_final_fecha,
                        'hora', v_final_hora,
                        'date_label', v_datetime_label,
                        'public_zone', v_new_public_zone,
                        'change_type', 'schedule',
                        'is_applicant', true
                    ),
                    'sched_req:' || v_schedule_mutation_id || ':' || v_sol.usuario_id
                );
            END LOOP;
        END IF;

        -- B. Cambio de punto de encuentro o enlace virtual
        IF v_logistics_changed THEN
            v_logistics_mutation_id := pg_catalog.gen_random_uuid();

            -- Notificar ÚNICAMENTE a participantes confirmados (sin modal, dirige al detalle)
            FOR v_part IN
                SELECT DISTINCT user_id
                FROM public.participantes
                WHERE encuentro_id = p_encuentro_id
                  AND estado IN ('confirmado', 'asistio')
                  AND user_id IS NOT NULL
                  AND user_id <> v_user_id
            LOOP
                PERFORM public.insertar_inbox_notification_seguro(
                    v_part.user_id,
                    'encounter_logistics_changed',
                    'encounter',
                    p_encuentro_id,
                    '/?open_detail=' || p_encuentro_id,
                    'Actualización de punto de encuentro',
                    'Se actualizó la información de ubicación/acceso del encuentro "' || v_title || '". Revisá el detalle seguro para ver los datos actualizados.',
                    pg_catalog.jsonb_build_object(
                        'encounter_id', p_encuentro_id,
                        'title', v_title,
                        'change_type', 'logistics'
                    ),
                    'logistics:' || v_logistics_mutation_id || ':' || v_part.user_id
                );
            END LOOP;
        END IF;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'moderation_invalidated', v_moderation_invalidated,
        'moderation_status', COALESCE(v_new_status, v_encuentro.moderation_status),
        'is_open', COALESCE(v_new_is_open, v_encuentro.is_open),
        'max_participants', v_new_max_participants,
        'allow_multi_seat_requests', COALESCE(v_new_allow_multi, false),
        'max_seats_per_request', COALESCE(v_new_max_seats, 1),
        'min_seats_per_request', COALESCE(v_new_min_seats, 1),
        'open_public_title', v_new_open_title
    );
END;
$$;

REVOKE ALL ON FUNCTION public.actualizar_encuentro_seguro(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.actualizar_encuentro_seguro(UUID, UUID, JSONB) TO authenticated, postgres, service_role;
