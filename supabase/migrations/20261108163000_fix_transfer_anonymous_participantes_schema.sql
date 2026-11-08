-- Migration: 20261108163000_fix_transfer_anonymous_participantes_schema.sql
-- Description: Corrige referencia a columna inexistente respondio_disponibilidad en public.participantes
--              dentro de public._transfer_anonymous_resources_internal(UUID, UUID).
--              En el esquema canónico, respondio_disponibilidad no es una columna de la tabla public.participantes;
--              la verificación relacional estricta se realiza sobre public.participante_disponibilidades.

BEGIN;

CREATE OR REPLACE FUNCTION public._transfer_anonymous_resources_internal(
    p_source_user_id UUID,
    p_target_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    -- Contadores de auditoría y resumen
    v_encuentros_count INT := 0;
    v_localidades_count INT := 0;
    v_participantes_count INT := 0;
    v_solicitudes_count INT := 0;
    v_templates_count INT := 0;
    v_ai_sessions_count INT := 0;
    v_creation_sessions_count INT := 0;
    v_whatsapp_count INT := 0;
    v_mensajes_count INT := 0;
    v_coverage_count INT := 0;
    v_inbox_count INT := 0;
    v_controversias_count INT := 0;
    v_feedback_count INT := 0;

    -- Scopes de trabajo
    v_source_owned_enc_ids UUID[];
    v_affected_external_enc_ids UUID[];

    -- Variables de loop
    v_enc_id UUID;
    v_canonical_part_id UUID;
    v_canonical_token UUID;
    v_canonical_estado TEXT;
    v_canonical_sol_id UUID;
    v_redundant_part_id UUID;
    v_redundant_sol_mensaje TEXT;

    -- Variables para consolidación de boletas de disponibilidad
    v_can_disp_updated TIMESTAMPTZ;
    v_red_disp_updated TIMESTAMPTZ;
    v_has_can_disp BOOLEAN;
    v_has_red_disp BOOLEAN;
    v_can_part RECORD;
    v_red_part RECORD;
BEGIN
    IF p_source_user_id IS NULL OR p_target_user_id IS NULL THEN
        RAISE EXCEPTION 'source_and_target_required';
    END IF;

    IF p_source_user_id = p_target_user_id THEN
        RAISE EXCEPTION 'cannot_transfer_to_same_user';
    END IF;

    -- 1. Exclusión mutua anti-deadlock: ordenamiento lexicográfico estricto
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('pe_identity_mutation:' || LEAST(p_source_user_id, p_target_user_id)::text)
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('pe_identity_mutation:' || GREATEST(p_source_user_id, p_target_user_id)::text)
    );

    -- Bloqueo FOR NO KEY UPDATE sobre la fila del emisor en auth.users
    PERFORM 1 FROM auth.users WHERE id = p_source_user_id FOR NO KEY UPDATE;

    -- 2. Captura explícita del scope afectado
    SELECT COALESCE(pg_catalog.array_agg(id ORDER BY id), ARRAY[]::UUID[])
    INTO v_source_owned_enc_ids
    FROM public.encuentros
    WHERE host_id = p_source_user_id;

    SELECT COALESCE(pg_catalog.array_agg(DISTINCT sub.encuentro_id ORDER BY sub.encuentro_id), ARRAY[]::UUID[])
    INTO v_affected_external_enc_ids
    FROM (
        SELECT encuentro_id FROM public.participantes WHERE user_id IN (p_source_user_id, p_target_user_id)
        UNION
        SELECT encuentro_id FROM public.solicitudes_encuentro_abierto WHERE usuario_id IN (p_source_user_id, p_target_user_id)
        UNION
        SELECT encuentro_id FROM public.asistencia_controversias WHERE involucrado_id IN (p_source_user_id, p_target_user_id) OR iniciado_por IN (p_source_user_id, p_target_user_id)
    ) sub
    WHERE sub.encuentro_id NOT IN (SELECT id FROM public.encuentros WHERE host_id = p_target_user_id)
      AND (pg_catalog.cardinality(v_source_owned_enc_ids) = 0 OR sub.encuentro_id <> ALL(v_source_owned_enc_ids));

    -- =====================================================================
    -- 3. PROCESAMIENTO DE ENCUENTROS PROPIOS DEL SOURCE (v_source_owned_enc_ids)
    -- =====================================================================
    IF pg_catalog.cardinality(v_source_owned_enc_ids) > 0 THEN
        -- Retirar solicitudes del target en estos encuentros preservando intacto el mensaje del usuario
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'withdrawn',
            resolved_at = COALESCE(resolved_at, pg_catalog.timezone('utc', pg_catalog.now())),
            participante_id = NULL,
            token_participante = NULL
        WHERE usuario_id = p_target_user_id
          AND encuentro_id = ANY(v_source_owned_enc_ids);

        -- En mensajes_encuentro: si el target tenía una fila de participante en este encuentro propio,
        -- preservar su autor_user_id = target antes de borrar la participación
        UPDATE public.mensajes_encuentro
        SET autor_user_id = p_target_user_id
        WHERE encuentro_id = ANY(v_source_owned_enc_ids)
          AND autor_participante_id IN (
              SELECT id FROM public.participantes
              WHERE user_id = p_target_user_id
                AND encuentro_id = ANY(v_source_owned_enc_ids)
          );

        -- Remover participación previa del target para no figurar como anfitrión e invitado simultáneamente
        DELETE FROM public.participantes
        WHERE user_id = p_target_user_id
          AND encuentro_id = ANY(v_source_owned_enc_ids);

        -- Reasignar mensajes escritos por el source en sus propios encuentros
        UPDATE public.mensajes_encuentro
        SET autor_user_id = p_target_user_id
        WHERE encuentro_id = ANY(v_source_owned_enc_ids)
          AND autor_user_id = p_source_user_id;

        -- Traspaso de titularidad del encuentro
        UPDATE public.encuentros
        SET host_id = p_target_user_id
        WHERE host_id = p_source_user_id;
        GET DIAGNOSTICS v_encuentros_count = ROW_COUNT;

        -- Traspaso de cancelled_by si el source había cancelado su propio encuentro
        UPDATE public.encuentros
        SET cancelled_by = p_target_user_id
        WHERE cancelled_by = p_source_user_id
          AND id = ANY(v_source_owned_enc_ids);

        -- Traspaso de contacto WhatsApp voluntario del anfitrión
        UPDATE public.encuentros_contacto_whatsapp
        SET host_id = p_target_user_id
        WHERE host_id = p_source_user_id
           OR encuentro_id = ANY(v_source_owned_enc_ids);
        GET DIAGNOSTICS v_whatsapp_count = ROW_COUNT;
    END IF;

    -- =====================================================================
    -- 4. ENCUENTROS EXTERNOS: FUSIÓN DE PARTICIPANTES, BOLETAS Y SOLICITUDES
    -- =====================================================================
    IF pg_catalog.cardinality(v_affected_external_enc_ids) > 0 THEN
        FOR v_enc_id IN (SELECT pg_catalog.unnest(v_affected_external_enc_ids)) LOOP
            -- Paso 4.1: Seleccionar Participante Canónico en v_enc_id
            SELECT id, token_invitacion,
                   CASE
                       WHEN EXISTS (
                           SELECT 1 FROM public.participantes
                           WHERE encuentro_id = v_enc_id AND user_id IN (p_source_user_id, p_target_user_id) AND estado = 'confirmado'
                       ) THEN 'confirmado'
                       WHEN EXISTS (
                           SELECT 1 FROM public.participantes
                           WHERE encuentro_id = v_enc_id AND user_id IN (p_source_user_id, p_target_user_id) AND estado = 'pendiente'
                       ) THEN 'pendiente'
                       ELSE 'rechazado'
                   END
            INTO v_canonical_part_id, v_canonical_token, v_canonical_estado
            FROM public.participantes
            WHERE encuentro_id = v_enc_id
              AND user_id IN (p_source_user_id, p_target_user_id)
            ORDER BY
                (EXISTS (
                    SELECT 1 FROM public.solicitudes_encuentro_abierto s
                    WHERE s.participante_id = public.participantes.id
                      AND s.estado = 'approved'
                      AND s.token_participante IS NOT DISTINCT FROM public.participantes.token_invitacion
                      AND public.participantes.token_invitacion IS NOT NULL
                )) DESC,
                (tipo_invitacion = 'individual') DESC,
                CASE estado WHEN 'confirmado' THEN 3 WHEN 'pendiente' THEN 2 ELSE 1 END DESC,
                (EXISTS (
                    SELECT 1 FROM public.participante_disponibilidades d
                    WHERE d.participante_id = public.participantes.id
                )) DESC,
                (token_invitacion IS NOT NULL) DESC,
                (user_id = p_target_user_id) DESC,
                creado_en ASC,
                id ASC
            LIMIT 1;

            IF v_canonical_part_id IS NOT NULL THEN
                -- Identificar si existe participante redundante
                SELECT id INTO v_redundant_part_id
                FROM public.participantes
                WHERE encuentro_id = v_enc_id
                  AND user_id IN (p_source_user_id, p_target_user_id)
                  AND id <> v_canonical_part_id
                LIMIT 1;

                IF v_redundant_part_id IS NOT NULL THEN
                    SELECT * INTO v_can_part FROM public.participantes WHERE id = v_canonical_part_id;
                    SELECT * INTO v_red_part FROM public.participantes WHERE id = v_redundant_part_id;

                    -- Consolidación de campos hacia canonical antes de borrar redundante
                    UPDATE public.participantes
                    SET
                        user_id = p_target_user_id,
                        estado = v_canonical_estado,
                        nombre_invitado = COALESCE(
                            NULLIF(pg_catalog.btrim(v_can_part.nombre_invitado), ''),
                            NULLIF(pg_catalog.btrim(v_red_part.nombre_invitado), ''),
                            v_can_part.nombre_invitado
                        ),
                        reconfirmation_status = CASE
                            WHEN v_can_part.reconfirmation_status = 'confirmed' OR v_red_part.reconfirmation_status = 'confirmed' THEN 'confirmed'
                            WHEN v_can_part.reconfirmation_status = 'pending'   OR v_red_part.reconfirmation_status = 'pending'   THEN 'pending'
                            WHEN v_can_part.reconfirmation_status = 'cant_attend' OR v_red_part.reconfirmation_status = 'cant_attend' THEN 'cant_attend'
                            ELSE v_can_part.reconfirmation_status
                        END,
                        reconfirmed_at = CASE
                            WHEN (v_can_part.reconfirmation_status = 'confirmed' OR v_red_part.reconfirmation_status = 'confirmed') THEN
                                COALESCE(
                                    CASE WHEN v_can_part.reconfirmation_status = 'confirmed' THEN v_can_part.reconfirmed_at END,
                                    CASE WHEN v_red_part.reconfirmation_status = 'confirmed' THEN v_red_part.reconfirmed_at END
                                )
                            ELSE COALESCE(v_can_part.reconfirmed_at, v_red_part.reconfirmed_at)
                        END,
                        attendance_status = CASE
                            WHEN v_can_part.attendance_status IS NOT NULL AND v_can_part.attendance_status <> 'unmarked' THEN v_can_part.attendance_status
                            WHEN v_red_part.attendance_status IS NOT NULL AND v_red_part.attendance_status <> 'unmarked' THEN v_red_part.attendance_status
                            ELSE COALESCE(v_can_part.attendance_status, v_red_part.attendance_status)
                        END,
                        attendance_dispute_status = CASE
                            WHEN v_can_part.attendance_dispute_status IS NOT NULL THEN v_can_part.attendance_dispute_status
                            ELSE v_red_part.attendance_dispute_status
                        END
                    WHERE id = v_canonical_part_id;

                    -- Consolidación de boletas en participante_disponibilidades
                    SELECT EXISTS(SELECT 1 FROM public.participante_disponibilidades WHERE participante_id = v_canonical_part_id) INTO v_has_can_disp;
                    SELECT EXISTS(SELECT 1 FROM public.participante_disponibilidades WHERE participante_id = v_redundant_part_id) INTO v_has_red_disp;

                    IF v_has_red_disp AND NOT v_has_can_disp THEN
                        -- Caso A: solo redundante votó -> transferir íntegro a canonical
                        UPDATE public.participante_disponibilidades
                        SET participante_id = v_canonical_part_id
                        WHERE participante_id = v_redundant_part_id;
                    ELSIF v_has_red_disp AND v_has_can_disp THEN
                        -- Caso B: ambos votaron -> comparar MAX(updated_at)
                        SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) INTO v_can_disp_updated FROM public.participante_disponibilidades WHERE participante_id = v_canonical_part_id;
                        SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) INTO v_red_disp_updated FROM public.participante_disponibilidades WHERE participante_id = v_redundant_part_id;

                        IF v_red_disp_updated > v_can_disp_updated THEN
                            -- Boleta redundante es más reciente: gana redundante completa
                            DELETE FROM public.participante_disponibilidades
                            WHERE participante_id = v_canonical_part_id
                              AND opcion_fecha_id IN (
                                  SELECT opcion_fecha_id FROM public.participante_disponibilidades WHERE participante_id = v_redundant_part_id
                              );

                            UPDATE public.participante_disponibilidades
                            SET es_preferida = false
                            WHERE participante_id = v_canonical_part_id;

                            UPDATE public.participante_disponibilidades
                            SET participante_id = v_canonical_part_id
                            WHERE participante_id = v_redundant_part_id;
                        ELSE
                            -- Boleta canónica es más reciente: canonical prevalece; insertar opciones faltantes de redundant con es_preferida = false
                            INSERT INTO public.participante_disponibilidades (
                                participante_id, opcion_fecha_id, encuentro_id, respuesta, es_preferida, created_at, updated_at
                            )
                            SELECT
                                v_canonical_part_id, r.opcion_fecha_id, r.encuentro_id, r.respuesta, false, r.created_at, r.updated_at
                            FROM public.participante_disponibilidades r
                            WHERE r.participante_id = v_redundant_part_id
                              AND r.opcion_fecha_id NOT IN (
                                  SELECT c.opcion_fecha_id FROM public.participante_disponibilidades c WHERE c.participante_id = v_canonical_part_id
                              )
                            ON CONFLICT (participante_id, opcion_fecha_id) DO NOTHING;

                            DELETE FROM public.participante_disponibilidades
                            WHERE participante_id = v_redundant_part_id;
                        END IF;
                    END IF;

                    -- En mensajes_encuentro: re-apuntar mensajes del participante redundante ANTES de borrarlo
                    UPDATE public.mensajes_encuentro
                    SET autor_participante_id = v_canonical_part_id,
                        autor_user_id = p_target_user_id
                    WHERE encuentro_id = v_enc_id
                      AND autor_participante_id = v_redundant_part_id;

                    -- En asistencia_controversias: re-vincular controversias de inasistencia antes de borrar redundante
                    IF EXISTS (
                        SELECT 1 FROM public.asistencia_controversias
                        WHERE participante_id = v_redundant_part_id AND tipo_controversia = 'absence_reported'
                    ) THEN
                        IF NOT EXISTS (
                            SELECT 1 FROM public.asistencia_controversias
                            WHERE participante_id = v_canonical_part_id AND tipo_controversia = 'absence_reported'
                        ) THEN
                            UPDATE public.asistencia_controversias
                            SET participante_id = v_canonical_part_id,
                                involucrado_id = p_target_user_id
                            WHERE participante_id = v_redundant_part_id
                              AND tipo_controversia = 'absence_reported';
                        ELSE
                            -- Si ambas tenían controversia, preservar descargo si redundante lo tenía y canonical no
                            UPDATE public.asistencia_controversias can
                            SET
                                descargo_tipo = COALESCE(can.descargo_tipo, red.descargo_tipo),
                                descargo_texto = COALESCE(can.descargo_texto, red.descargo_texto),
                                descargo_en = COALESCE(can.descargo_en, red.descargo_en)
                            FROM public.asistencia_controversias red
                            WHERE can.participante_id = v_canonical_part_id
                              AND red.participante_id = v_redundant_part_id
                              AND can.tipo_controversia = 'absence_reported'
                              AND red.tipo_controversia = 'absence_reported';

                            DELETE FROM public.asistencia_controversias
                            WHERE participante_id = v_redundant_part_id
                              AND tipo_controversia = 'absence_reported';
                        END IF;
                    END IF;

                    -- Re-vincular solicitudes approved hacia canonical_part_id ANTES de borrar redundante
                    UPDATE public.solicitudes_encuentro_abierto
                    SET participante_id = v_canonical_part_id,
                        token_participante = v_canonical_token
                    WHERE encuentro_id = v_enc_id
                      AND usuario_id IN (p_source_user_id, p_target_user_id)
                      AND estado = 'approved';

                    -- Eliminar participante redundante
                    DELETE FROM public.participantes
                    WHERE id = v_redundant_part_id;
                ELSE
                    -- Solo había una fila de participante en este encuentro: asegurar target_user
                    UPDATE public.participantes
                    SET user_id = p_target_user_id
                    WHERE id = v_canonical_part_id;
                END IF;

                v_participantes_count := v_participantes_count + 1;
            END IF;

            -- Paso 4.2: Solicitud Canónica en v_enc_id (Jerarquía determinista de 9 niveles)
            SELECT id INTO v_canonical_sol_id
            FROM public.solicitudes_encuentro_abierto
            WHERE encuentro_id = v_enc_id
              AND usuario_id IN (p_source_user_id, p_target_user_id)
            ORDER BY
                CASE estado
                    WHEN 'approved'           THEN 9
                    WHEN 'waitlist_confirmed' THEN 8
                    WHEN 'waitlist_offered'   THEN 7
                    WHEN 'pending'            THEN 6
                    WHEN 'waitlist_waiting'   THEN 5
                    WHEN 'waitlist_expired'   THEN 4
                    WHEN 'rejected'           THEN 3
                    WHEN 'cancelled'          THEN 2
                    WHEN 'withdrawn'          THEN 1
                    ELSE 0
                END DESC,
                CASE WHEN estado = 'waitlist_waiting' THEN created_at END ASC NULLS LAST,
                resolved_at DESC NULLS LAST,
                updated_at DESC,
                id ASC
            LIMIT 1;

            IF v_canonical_sol_id IS NOT NULL THEN
                -- Rescatar mensaje del solicitante redundante si canonical estaba vacío
                SELECT mensaje INTO v_redundant_sol_mensaje
                FROM public.solicitudes_encuentro_abierto
                WHERE encuentro_id = v_enc_id
                  AND usuario_id IN (p_source_user_id, p_target_user_id)
                  AND id <> v_canonical_sol_id
                  AND NULLIF(pg_catalog.btrim(mensaje), '') IS NOT NULL
                LIMIT 1;

                IF v_redundant_sol_mensaje IS NOT NULL THEN
                    UPDATE public.solicitudes_encuentro_abierto
                    SET mensaje = COALESCE(NULLIF(pg_catalog.btrim(mensaje), ''), v_redundant_sol_mensaje)
                    WHERE id = v_canonical_sol_id;
                END IF;

                -- Eliminar solicitudes no canónicas PRIMERO para despejar índice parcial único
                DELETE FROM public.solicitudes_encuentro_abierto
                WHERE encuentro_id = v_enc_id
                  AND usuario_id IN (p_source_user_id, p_target_user_id)
                  AND id <> v_canonical_sol_id;

                -- Asignar canonical solicitud al target_user
                UPDATE public.solicitudes_encuentro_abierto
                SET usuario_id = p_target_user_id
                WHERE id = v_canonical_sol_id;

                v_solicitudes_count := v_solicitudes_count + 1;
            END IF;
        END LOOP;
    END IF;

    -- Paso 4.3: Mover cualquier participante o solicitud restante del source (en encuentros donde target no interactuó)
    UPDATE public.participantes
    SET user_id = p_target_user_id
    WHERE user_id = p_source_user_id;

    UPDATE public.solicitudes_encuentro_abierto
    SET usuario_id = p_target_user_id
    WHERE usuario_id = p_source_user_id;

    -- =====================================================================
    -- 5. MENSAJES Y DESTACADOS (mensajes_encuentro)
    -- =====================================================================
    UPDATE public.mensajes_encuentro
    SET autor_user_id = p_target_user_id
    WHERE autor_user_id = p_source_user_id;
    GET DIAGNOSTICS v_mensajes_count = ROW_COUNT;

    UPDATE public.mensajes_encuentro
    SET destacado_por = p_target_user_id
    WHERE destacado_por = p_source_user_id;

    -- =====================================================================
    -- 6. ASISTENCIA Y CONTROVERSIAS (asistencia_controversias)
    -- =====================================================================
    -- Involucrado
    UPDATE public.asistencia_controversias
    SET involucrado_id = p_target_user_id
    WHERE involucrado_id = p_source_user_id;
    GET DIAGNOSTICS v_controversias_count = ROW_COUNT;

    -- Iniciador: si target ya inició el mismo tipo de controversia en ese encuentro, descartar duplicado sin descargo
    DELETE FROM public.asistencia_controversias s
    WHERE s.iniciado_por = p_source_user_id
      AND EXISTS (
          SELECT 1 FROM public.asistencia_controversias t
          WHERE t.iniciado_por = p_target_user_id
            AND t.encuentro_id = s.encuentro_id
            AND t.tipo_controversia = s.tipo_controversia
      );

    UPDATE public.asistencia_controversias
    SET iniciado_por = p_target_user_id
    WHERE iniciado_por = p_source_user_id;

    -- =====================================================================
    -- 7. PREFERENCIAS ZONALES (usuario_localidades)
    -- =====================================================================
    INSERT INTO public.usuario_localidades (user_id, locality_id, created_at)
    SELECT p_target_user_id, locality_id, created_at
    FROM public.usuario_localidades
    WHERE user_id = p_source_user_id
    ON CONFLICT (user_id, locality_id) DO NOTHING;
    GET DIAGNOSTICS v_localidades_count = ROW_COUNT;

    DELETE FROM public.usuario_localidades WHERE user_id = p_source_user_id;

    -- =====================================================================
    -- 8. SOLICITUDES DE COBERTURA TERRITORIAL (coverage_requests)
    -- =====================================================================
    -- En colisión (user_id, dedupe_key), actualizar la fila existente del target
    UPDATE public.coverage_requests t
    SET
        created_at = LEAST(t.created_at, s.created_at),
        last_requested_at = GREATEST(t.last_requested_at, s.last_requested_at),
        intent_text = COALESCE(NULLIF(pg_catalog.btrim(t.intent_text), ''), s.intent_text),
        status = CASE
            WHEN t.status = 'merged' OR s.status = 'merged' THEN 'merged'
            WHEN t.status = 'reviewed' OR s.status = 'reviewed' THEN 'reviewed'
            WHEN t.status = 'pending' OR s.status = 'pending' THEN 'pending'
            ELSE t.status
        END,
        updated_at = pg_catalog.now()
    FROM public.coverage_requests s
    WHERE s.user_id = p_source_user_id
      AND t.user_id = p_target_user_id
      AND t.dedupe_key = s.dedupe_key;

    -- Eliminar filas de source ya integradas en target
    DELETE FROM public.coverage_requests s
    WHERE s.user_id = p_source_user_id
      AND EXISTS (
          SELECT 1 FROM public.coverage_requests t
          WHERE t.user_id = p_target_user_id
            AND t.dedupe_key = s.dedupe_key
      );

    -- Transferir las restantes
    UPDATE public.coverage_requests
    SET user_id = p_target_user_id
    WHERE user_id = p_source_user_id;
    GET DIAGNOSTICS v_coverage_count = ROW_COUNT;

    -- =====================================================================
    -- 9. NOTIFICACIONES INBOX Y OUTBOX (inbox_notifications / outbox)
    -- =====================================================================
    -- En colisión (recipient_user_id, dedup_key), si cualquiera estaba no leída, permanece no leída
    UPDATE public.inbox_notifications t
    SET
        read_at = CASE
            WHEN t.read_at IS NULL OR s.read_at IS NULL THEN NULL
            ELSE LEAST(t.read_at, s.read_at)
        END,
        expires_at = GREATEST(t.expires_at, s.expires_at)
    FROM public.inbox_notifications s
    WHERE s.recipient_user_id = p_source_user_id
      AND t.recipient_user_id = p_target_user_id
      AND t.dedup_key = s.dedup_key;

    DELETE FROM public.inbox_notifications s
    WHERE s.recipient_user_id = p_source_user_id
      AND EXISTS (
          SELECT 1 FROM public.inbox_notifications t
          WHERE t.recipient_user_id = p_target_user_id
            AND t.dedup_key = s.dedup_key
      );

    UPDATE public.inbox_notifications
    SET recipient_user_id = p_target_user_id
    WHERE recipient_user_id = p_source_user_id;
    GET DIAGNOSTICS v_inbox_count = ROW_COUNT;

    UPDATE public.notification_delivery_outbox
    SET recipient_user_id = p_target_user_id
    WHERE recipient_user_id = p_source_user_id;

    -- =====================================================================
    -- 10. CUSTOM INVITATION TEMPLATES (CON GUC BYPASS LOCAL A TRANSACCIÓN)
    -- =====================================================================
    PERFORM pg_catalog.set_config('puntoencuentro.skip_template_limit', 'on', true);

    UPDATE public.custom_invitation_templates
    SET user_id = p_target_user_id
    WHERE user_id = p_source_user_id;
    GET DIAGNOSTICS v_templates_count = ROW_COUNT;

    -- =====================================================================
    -- 11. SESIONES IA, OBSERVABILIDAD QA Y USER FEEDBACK
    -- =====================================================================
    UPDATE public.ai_creation_sessions
    SET user_id = p_target_user_id
    WHERE user_id = p_source_user_id;
    GET DIAGNOSTICS v_ai_sessions_count = ROW_COUNT;

    UPDATE public.creation_sessions
    SET user_id = p_target_user_id
    WHERE user_id = p_source_user_id;
    GET DIAGNOSTICS v_creation_sessions_count = ROW_COUNT;

    UPDATE public.user_feedback
    SET user_id = p_target_user_id
    WHERE user_id = p_source_user_id;
    GET DIAGNOSTICS v_feedback_count = ROW_COUNT;

    -- =====================================================================
    -- 12. VERIFICACIÓN OBLIGATORIA DE POST-CONDICIONES (A..L)
    -- =====================================================================
    -- Post-condición A: Cero encuentros donde host_id = source
    IF EXISTS (SELECT 1 FROM public.encuentros WHERE host_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_encounters_remain';
    END IF;

    -- Post-condición B: Cero localidades asociadas a source
    IF EXISTS (SELECT 1 FROM public.usuario_localidades WHERE user_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_localities_remain';
    END IF;

    -- Post-condición C: Cero participantes o solicitudes de source
    IF EXISTS (SELECT 1 FROM public.participantes WHERE user_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_participantes_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE usuario_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_solicitudes_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.custom_invitation_templates WHERE user_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_templates_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE user_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_ai_sessions_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.creation_sessions WHERE user_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_creation_sessions_remain';
    END IF;

    -- Post-condición D: Target no es host y participante simultáneamente en encuentros transferidos
    IF pg_catalog.cardinality(v_source_owned_enc_ids) > 0 THEN
        IF EXISTS (
            SELECT 1 FROM public.participantes p
            WHERE p.encuentro_id = ANY(v_source_owned_enc_ids)
              AND p.user_id = p_target_user_id
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_target_is_host_and_participant';
        END IF;
    END IF;

    -- Post-condición E y F: En encuentros afectados, solicitudes approved corresponden exactamente a participante existente
    IF pg_catalog.cardinality(v_affected_external_enc_ids) > 0 THEN
        IF EXISTS (
            SELECT 1
            FROM public.solicitudes_encuentro_abierto s
            LEFT JOIN public.participantes p ON p.id = s.participante_id
            WHERE s.encuentro_id = ANY(v_affected_external_enc_ids)
              AND s.usuario_id = p_target_user_id
              AND s.estado = 'approved'
              AND (s.participante_id IS NULL OR p.id IS NULL)
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_approved_solicitud_missing_participant';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.solicitudes_encuentro_abierto s
            JOIN public.participantes p ON p.id = s.participante_id
            WHERE s.encuentro_id = ANY(v_affected_external_enc_ids)
              AND s.usuario_id = p_target_user_id
              AND s.estado = 'approved'
              AND (s.token_participante IS NULL OR s.token_participante IS DISTINCT FROM p.token_invitacion OR p.token_invitacion IS NULL)
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_token_mismatch_in_approved_solicitud';
        END IF;

        -- Post-condición G: Sin solicitudes activas duplicadas para el target
        IF EXISTS (
            SELECT encuentro_id
            FROM public.solicitudes_encuentro_abierto
            WHERE usuario_id = p_target_user_id
              AND estado IN ('pending', 'approved', 'waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
              AND encuentro_id = ANY(v_affected_external_enc_ids)
            GROUP BY encuentro_id
            HAVING COUNT(*) > 1
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_duplicate_active_solicitudes';
        END IF;
    END IF;

    -- Post-condición H: Templates asociados a encuentros transferidos siguen renderizables
    IF pg_catalog.cardinality(v_source_owned_enc_ids) > 0 THEN
        IF EXISTS (
            SELECT 1
            FROM public.encuentros e
            WHERE e.id = ANY(v_source_owned_enc_ids)
              AND e.tema_invitacion = 'custom'
              AND e.invitation_template ~ '^custom_[0-9a-fA-F-]{36}$'
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.custom_invitation_templates t
                  WHERE t.id = (pg_catalog.substr(e.invitation_template, 8))::uuid
                    AND t.image_path IS NOT NULL
              )
        ) THEN
            RAISE EXCEPTION 'postcondition_failed_custom_template_unrenderable';
        END IF;
    END IF;

    -- Post-condición I: Cero filas en encuentros_contacto_whatsapp para source
    IF EXISTS (SELECT 1 FROM public.encuentros_contacto_whatsapp WHERE host_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_whatsapp_contacts_remain';
    END IF;

    -- Post-condición J: Cero autoría huérfana en mensajes_encuentro para source
    IF EXISTS (
        SELECT 1 FROM public.mensajes_encuentro
        WHERE autor_user_id = p_source_user_id OR destacado_por = p_source_user_id
    ) THEN
        RAISE EXCEPTION 'postcondition_failed_source_messages_remain';
    END IF;

    -- Post-condición K: Cero solicitudes de cobertura o notificaciones de source
    IF EXISTS (SELECT 1 FROM public.coverage_requests WHERE user_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_coverage_requests_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.inbox_notifications WHERE recipient_user_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_inbox_notifications_remain';
    END IF;
    IF EXISTS (SELECT 1 FROM public.notification_delivery_outbox WHERE recipient_user_id = p_source_user_id) THEN
        RAISE EXCEPTION 'postcondition_failed_source_outbox_notifications_remain';
    END IF;

    -- Post-condición L: Cero controversias donde source figure como involucrado o iniciador
    IF EXISTS (
        SELECT 1 FROM public.asistencia_controversias
        WHERE involucrado_id = p_source_user_id OR iniciado_por = p_source_user_id
    ) THEN
        RAISE EXCEPTION 'postcondition_failed_source_controversies_remain';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'encuentros', v_encuentros_count,
        'localidades', v_localidades_count,
        'participantes', v_participantes_count,
        'solicitudes', v_solicitudes_count,
        'templates', v_templates_count,
        'ai_sessions', v_ai_sessions_count,
        'creation_sessions', v_creation_sessions_count,
        'whatsapp_contacts', v_whatsapp_count,
        'mensajes', v_mensajes_count,
        'coverage_requests', v_coverage_count,
        'inbox_notifications', v_inbox_count,
        'controversias', v_controversias_count,
        'feedback', v_feedback_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public._transfer_anonymous_resources_internal(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._transfer_anonymous_resources_internal(UUID, UUID) TO postgres, service_role;

COMMIT;
