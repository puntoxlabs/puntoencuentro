-- =============================================================================
-- Migration: 20261023193000_harden_logistics_priority_and_claim_safety_v2.sql
-- Description: Mini-sprint P0 Cierre Técnico:
--   1. Clasificar 'encounter_logistics_changed' para participantes confirmados como prioridad crítica ('urgency: high').
--   2. Robustecer la evaluación en 'claim_web_push_deliveries_seguro' eliminando casts frágiles (::boolean)
--      para tolerar campos ausentes, valores inesperados o tipos desconocidos sin abortar el lote.
--   3. Actualizar 'actualizar_encuentro_seguro' para incluir 'priority: critical' en cambios de logística
--      e 'is_applicant: true' en cambios de fecha para solicitantes.
-- Environment: Staging (wougfhfwqgmxhgvjqoua)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Actualizar RPC: claim_web_push_deliveries_seguro
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_web_push_deliveries_seguro(
    p_batch_size INT DEFAULT 10,
    p_worker_id TEXT DEFAULT 'web-push-worker'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_limit INT := LEAST(GREATEST(COALESCE(p_batch_size, 10), 1), 100);
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_claimed_rows RECORD;
    v_result JSONB := '[]'::jsonb;
    v_is_critical BOOLEAN;
    v_urgency TEXT;
BEGIN
    -- 1. Seleccionar IDs candidatos bajo cerrojo SKIP LOCKED
    FOR v_claimed_rows IN
        SELECT
            d.id AS delivery_id,
            d.inbox_notification_id,
            d.recipient_user_id AS delivery_recipient_id,
            d.web_push_subscription_id,
            d.attempt_count,
            s.id AS sub_id,
            s.user_id AS sub_user_id,
            s.status AS sub_status,
            s.endpoint,
            s.p256dh_key,
            s.auth_key,
            i.recipient_user_id AS inbox_recipient_id,
            i.notification_type,
            i.payload,
            i.title,
            i.body,
            i.deep_link,
            i.expires_at AS inbox_expires_at,
            i.read_at AS inbox_read_at
        FROM public.notification_delivery_outbox d
        JOIN public.web_push_subscriptions s ON s.id = d.web_push_subscription_id
        JOIN public.inbox_notifications i ON i.id = d.inbox_notification_id
        WHERE d.status = 'pending'
          AND d.available_at <= v_now
        ORDER BY d.created_at ASC
        LIMIT v_limit
        FOR UPDATE OF d SKIP LOCKED
    LOOP
        -- Regla crítica de privacidad: dispositivo compartido / reasignado
        IF v_claimed_rows.sub_status <> 'active' 
           OR v_claimed_rows.sub_user_id <> v_claimed_rows.delivery_recipient_id 
           OR v_claimed_rows.inbox_recipient_id <> v_claimed_rows.delivery_recipient_id THEN
            UPDATE public.notification_delivery_outbox
            SET status = 'cancelled',
                last_error = 'Device or user reassigned / subscription inactive',
                updated_at = v_now
            WHERE id = v_claimed_rows.delivery_id;
            CONTINUE;
        END IF;

        -- Regla de expiración: el Push no debe sobrevivir al Inbox
        IF v_claimed_rows.inbox_expires_at <= v_now THEN
            UPDATE public.notification_delivery_outbox
            SET status = 'cancelled',
                last_error = 'Notification expired before push delivery',
                updated_at = v_now
            WHERE id = v_claimed_rows.delivery_id;
            CONTINUE;
        END IF;

        -- Regla de obsolescencia: si ya fue leída en la app, cancelar el Push
        IF v_claimed_rows.inbox_read_at IS NOT NULL THEN
            UPDATE public.notification_delivery_outbox
            SET status = 'cancelled',
                last_error = 'Notification already read in-app',
                updated_at = v_now
            WHERE id = v_claimed_rows.delivery_id;
            CONTINUE;
        END IF;

        -- Clasificación conservadora server-side de prioridad crítica:
        -- - Cancelaciones para participantes y solicitantes
        -- - Reprogramaciones de fecha/horario para participantes confirmados
        -- - Modificaciones de logística (lugar/enlace) para participantes confirmados
        -- - Notificaciones con metadata explícita 'priority' = 'critical'
        --
        -- Robustez ante metadata inesperada o malformada:
        -- Se comparan strings sin casts explícitos a boolean ((payload->>'is_applicant')::boolean)
        -- para prevenir excepciones en tiempo de ejecución que aborten el lote completo.
        v_is_critical := COALESCE(
            v_claimed_rows.notification_type IN (
                'encounter_cancelled_for_participant',
                'open_encounter_request_cancelled_by_host'
            )
            OR (
                v_claimed_rows.notification_type IN ('encounter_schedule_changed', 'encounter_logistics_changed')
                AND (
                    COALESCE(v_claimed_rows.payload->>'is_applicant', '') NOT IN ('true', 't', '1', 'yes')
                )
            )
            OR (COALESCE(v_claimed_rows.payload->>'priority', '') = 'critical'),
            false
        );

        IF v_is_critical THEN
            v_urgency := 'high';
        ELSE
            v_urgency := 'normal';
        END IF;

        -- Marcar en procesamiento
        UPDATE public.notification_delivery_outbox
        SET status = 'processing',
            processing_started_at = v_now,
            attempt_count = attempt_count + 1,
            updated_at = v_now
        WHERE id = v_claimed_rows.delivery_id;

        -- Agregar al lote listo para envío con tipado y urgencia
        v_result := v_result || pg_catalog.jsonb_build_object(
            'delivery_id', v_claimed_rows.delivery_id,
            'inbox_notification_id', v_claimed_rows.inbox_notification_id,
            'recipient_user_id', v_claimed_rows.delivery_recipient_id,
            'web_push_subscription_id', v_claimed_rows.web_push_subscription_id,
            'attempt_count', v_claimed_rows.attempt_count + 1,
            'endpoint', v_claimed_rows.endpoint,
            'p256dh_key', v_claimed_rows.p256dh_key,
            'auth_key', v_claimed_rows.auth_key,
            'title', v_claimed_rows.title,
            'body', v_claimed_rows.body,
            'deep_link', v_claimed_rows.deep_link,
            'expires_at', v_claimed_rows.inbox_expires_at,
            'notification_type', v_claimed_rows.notification_type,
            'is_critical', v_is_critical,
            'urgency', v_urgency
        );
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'deliveries', v_result,
        'count', pg_catalog.jsonb_array_length(v_result)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_web_push_deliveries_seguro(INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_web_push_deliveries_seguro(INT, TEXT) TO service_role;


-- -----------------------------------------------------------------------------
-- 2. Actualizar RPC: actualizar_encuentro_seguro
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro(
    p_encuentro_id uuid,
    p_host_id uuid,
    p_data jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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
    v_new_cycle_id UUID;
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
        v_new_min_seats := v_encuentro.min_seats_per_request;
    END IF;

    IF v_new_allow_multi = false THEN
        v_new_min_seats := 1;
        v_new_max_seats := 1;
    ELSE
        IF v_new_min_seats IS NULL OR v_new_min_seats < 1 THEN v_new_min_seats := 1; END IF;
        IF v_new_max_seats IS NULL OR v_new_max_seats < 1 THEN v_new_max_seats := 3; END IF;
        IF v_new_max_seats > 5 THEN v_new_max_seats := 5; END IF;
        IF v_new_min_seats > v_new_max_seats THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_seat_range');
        END IF;
    END IF;

    IF v_new_modalidad = 'presencial' AND p_data ? 'locality_id' THEN
        IF v_new_locality_id IS NOT NULL THEN
            SELECT id, name INTO v_loc_record FROM public.localities WHERE id = v_new_locality_id;
            IF NOT FOUND THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_locality');
            END IF;
            v_new_public_zone := v_loc_record.name;
        ELSE
            v_new_public_zone := NULL;
        END IF;
    ELSIF v_new_modalidad = 'virtual' THEN
        v_new_locality_id := NULL;
        v_new_public_zone := 'Virtual';
    END IF;

    IF p_data ? 'titulo' AND v_new_title IS DISTINCT FROM v_encuentro.titulo THEN
        v_title_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'titulo');
    END IF;
    IF p_data ? 'open_public_title' AND v_new_open_title IS DISTINCT FROM v_encuentro.open_public_title THEN
        v_open_title_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_public_title');
    END IF;
    IF p_data ? 'open_description' AND v_new_open_desc IS DISTINCT FROM v_encuentro.open_description THEN
        v_open_desc_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_description');
    END IF;
    IF p_data ? 'modalidad' AND v_new_modalidad IS DISTINCT FROM v_encuentro.modalidad THEN
        v_modality_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'modalidad');
    END IF;
    IF p_data ? 'locality_id' AND v_new_locality_id IS DISTINCT FROM v_encuentro.locality_id THEN
        v_locality_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'locality_id');
    END IF;
    IF p_data ? 'open_public_zone' AND v_new_public_zone IS DISTINCT FROM v_encuentro.open_public_zone THEN
        v_zone_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_public_zone');
    END IF;

    v_final_fecha := CASE WHEN p_data ? 'fecha' THEN (p_data->>'fecha')::date ELSE v_encuentro.fecha END;
    v_final_hora := CASE WHEN p_data ? 'hora' THEN (p_data->>'hora')::time ELSE v_encuentro.hora END;
    v_final_lugar_texto := CASE WHEN p_data ? 'lugar_texto' THEN NULLIF(pg_catalog.btrim(p_data->>'lugar_texto'), '') ELSE v_encuentro.lugar_texto END;
    v_final_link_virtual := CASE WHEN p_data ? 'link_virtual' THEN NULLIF(pg_catalog.btrim(p_data->>'link_virtual'), '') ELSE v_encuentro.link_virtual END;

    IF (p_data ? 'fecha' AND v_final_fecha IS DISTINCT FROM v_encuentro.fecha)
       OR (p_data ? 'hora' AND v_final_hora IS DISTINCT FROM v_encuentro.hora) THEN
        v_schedule_changed := true;
    END IF;

    IF (p_data ? 'lugar_texto' AND v_final_lugar_texto IS DISTINCT FROM v_encuentro.lugar_texto)
       OR (p_data ? 'link_virtual' AND v_final_link_virtual IS DISTINCT FROM v_encuentro.link_virtual) THEN
        v_logistics_changed := true;
    END IF;

    v_is_open_encounter := (
        COALESCE(v_encuentro.is_open, false) = true
        OR v_encuentro.opened_at IS NOT NULL
        OR EXISTS (
            SELECT 1 FROM public.solicitudes_encuentro_abierto sea
            WHERE sea.encuentro_id = p_encuentro_id
        )
    );

    IF v_encuentro.is_open = true AND (v_title_changed OR v_open_title_changed OR v_open_desc_changed) THEN
        v_effective_eval_title := COALESCE(v_new_open_title, v_new_title, v_encuentro.open_public_title, v_encuentro.titulo);
        SELECT * INTO v_eval FROM public.evaluar_contenido_publico_determinista(
            v_effective_eval_title,
            COALESCE(v_new_open_desc, '')
        );

        IF NOT v_eval.allowed THEN
            v_moderation_invalidated := true;
            v_new_status := 'rejected';
            v_new_is_open := false;
            v_det_reason := v_eval.reason;
        ELSE
            v_moderation_invalidated := true;
            v_new_status := 'pending_review';
            v_new_is_open := false;
            v_det_reason := NULL;
        END IF;
    END IF;

    UPDATE public.encuentros
    SET
        titulo = COALESCE(v_new_title, titulo),
        open_public_title = CASE WHEN p_data ? 'open_public_title' THEN v_new_open_title ELSE open_public_title END,
        descripcion = CASE WHEN p_data ? 'descripcion' THEN p_data->>'descripcion' ELSE descripcion END,
        open_description = CASE WHEN p_data ? 'open_description' THEN v_new_open_desc ELSE open_description END,
        fecha = v_final_fecha,
        hora = v_final_hora,
        modalidad = v_new_modalidad,
        locality_id = v_new_locality_id,
        open_public_zone = v_new_public_zone,
        lugar_texto = v_final_lugar_texto,
        link_virtual = v_final_link_virtual,
        max_participants = v_new_max_participants,
        allow_multi_seat_requests = v_new_allow_multi,
        min_seats_per_request = v_new_min_seats,
        max_seats_per_request = v_new_max_seats,
        is_open = CASE WHEN v_moderation_invalidated THEN v_new_is_open ELSE is_open END,
        moderation_status = CASE WHEN v_moderation_invalidated THEN v_new_status ELSE moderation_status END,
        moderation_reason = CASE
            WHEN v_moderation_invalidated AND v_new_status = 'rejected' THEN v_det_reason
            WHEN v_moderation_invalidated THEN 'Public content modified by host; pending new moderation'
            ELSE moderation_reason
        END,
        moderated_at = CASE WHEN v_moderation_invalidated THEN v_now ELSE moderated_at END,
        moderation_decision_source = CASE
            WHEN v_moderation_invalidated AND v_new_status = 'rejected' THEN 'deterministic'
            WHEN v_moderation_invalidated THEN 'content_update'
            ELSE moderation_decision_source
        END,
        closed_at = CASE WHEN v_moderation_invalidated AND v_encuentro.is_open THEN v_now ELSE closed_at END
    WHERE id = p_encuentro_id
      AND host_id = v_user_id;

    -- Emisión de notificaciones y manejo de ciclos si es encuentro abierto
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
            v_new_cycle_id := pg_catalog.gen_random_uuid();

            -- Si inscripciones cerradas, reiniciar reconfirmación y rotar ciclo
            IF COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
                UPDATE public.encuentros
                SET inscriptions_cycle_id = v_new_cycle_id
                WHERE id = p_encuentro_id;

                UPDATE public.participantes
                SET reconfirmation_status = 'pending',
                    reconfirmed_at = NULL,
                    reconfirmed_cycle_id = NULL
                WHERE encuentro_id = p_encuentro_id
                  AND estado IN ('confirmado', 'asistio');
            END IF;

            -- 1. Notificar a cada participante confirmado (crítica)
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

            -- 2. Notificar a cada solicitante pendiente (informativa: is_applicant = true)
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
                        'change_type', 'schedule',
                        'is_applicant', true
                    ),
                    'sched_pending:' || v_schedule_mutation_id || ':' || v_sol.usuario_id
                );
            END LOOP;
        END IF;

        -- B. Cambio de logística (dirección o enlace virtual)
        -- Invariante: Notificar SIN exponer datos privados en el cuerpo de la notificación
        -- Participantes confirmados reciben prioridad 'critical' para garantizar Web Push high
        IF v_logistics_changed THEN
            v_logistics_mutation_id := pg_catalog.gen_random_uuid();

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
                    'Actualización de datos del encuentro',
                    'El organizador actualizó la información de ubicación o acceso del encuentro "' || v_title || '". Podés ver los detalles en la pantalla del encuentro.',
                    pg_catalog.jsonb_build_object(
                        'encounter_id', p_encuentro_id,
                        'title', v_title,
                        'priority', 'critical',
                        'change_type', 'logistics'
                    ),
                    'logistics:' || v_logistics_mutation_id || ':' || v_part.user_id
                );
            END LOOP;
        END IF;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'moderation_invalidated', v_moderation_invalidated,
        'new_moderation_status', CASE WHEN v_moderation_invalidated THEN v_new_status ELSE v_encuentro.moderation_status END,
        'is_open', CASE WHEN v_moderation_invalidated THEN v_new_is_open ELSE v_encuentro.is_open END,
        'changed_fields', v_changed_fields,
        'schedule_changed', v_schedule_changed,
        'logistics_changed', v_logistics_changed
    );
END;
$$;

REVOKE ALL ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) TO authenticated, service_role;

COMMIT;
