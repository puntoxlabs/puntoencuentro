-- =========================================================================
-- Migración: 20261107120000_domain_identity_bridge_v1.sql
-- Módulo: Puente Seguro de Identidad entre Dominios (Mini-Sprint 2B-1)
--
-- Objetivos:
--   1. Extender public.anonymous_transfer_tickets con soporte multi-modo
--      (oauth_upgrade, cross_origin_bridge, cross_origin_manual) y asociación
--      estricta a intended_target_user_id.
--   2. Implementar registro y helper server-side de identidad retirada:
--      public.is_retired_anonymous_source(UUID).
--   3. Implementar Kill Switch SQL configurable y apagado por defecto para
--      impedir emisión y canje cross-origin antes de su autorización.
--   4. Implementar políticas de rate limiting específicas.
--   5. Implementar el motor unificado privado de transferencia:
--      public._transfer_anonymous_resources_internal(UUID, UUID).
--   6. Implementar las RPCs del puente:
--      - public.create_domain_migration_ticket_seguro
--      - public.claim_domain_migration_ticket_seguro
--      - public.confirmar_migracion_dominio_completada_seguro
--      - public.vincular_tokens_participante_lote_seguro
--   7. Actualizar public.get_anonymous_upgrade_state() y delegar
--      public.claim_anonymous_transfer() en el motor unificado.
--   8. Blindar superficies de escritura alcanzables por anónimos ante
--      sesiones retiradas y carreras concurrentes (pe_identity_mutation).
-- =========================================================================

BEGIN;

-- =========================================================================
-- 1. EXTENSIÓN ADITIVA DE TABLA public.anonymous_transfer_tickets
-- =========================================================================
ALTER TABLE public.anonymous_transfer_tickets
    ADD COLUMN IF NOT EXISTS flow_mode TEXT NOT NULL DEFAULT 'oauth_upgrade'
        CHECK (flow_mode IN ('oauth_upgrade', 'cross_origin_bridge', 'cross_origin_manual')),
    ADD COLUMN IF NOT EXISTS intended_target_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_bridge_requires_intended_target'
    ) THEN
        ALTER TABLE public.anonymous_transfer_tickets
            ADD CONSTRAINT check_bridge_requires_intended_target
            CHECK (flow_mode <> 'cross_origin_bridge' OR intended_target_user_id IS NOT NULL);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_anonymous_transfer_source_completed
    ON public.anonymous_transfer_tickets (source_user_id_snapshot, used_at DESC)
    WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_anonymous_transfer_intended_target
    ON public.anonymous_transfer_tickets (intended_target_user_id)
    WHERE intended_target_user_id IS NOT NULL AND status = 'pending';


-- =========================================================================
-- 2. KILL SWITCH DEL SERVIDOR / CONFIGURACIÓN SQL (APAGADO POR DEFECTO)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.domain_migration_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value BOOLEAN NOT NULL DEFAULT false,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.domain_migration_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.domain_migration_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.domain_migration_settings TO postgres, service_role;

INSERT INTO public.domain_migration_settings (setting_key, setting_value, description)
VALUES
    ('cross_origin_bridge_enabled', false, 'Kill switch: Habilita emision y canje de tickets cross_origin_bridge'),
    ('cross_origin_manual_enabled', false, 'Kill switch: Habilita emision y canje de tickets cross_origin_manual')
ON CONFLICT (setting_key) DO UPDATE
SET description = EXCLUDED.description;

-- Helper privado para consultar si cross-origin está habilitado
-- La única fuente de autorización es la tabla administrativa public.domain_migration_settings (sin bypass por GUC de cliente)
CREATE OR REPLACE FUNCTION public.is_cross_origin_migration_enabled(p_flow_mode TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_setting_val BOOLEAN := false;
BEGIN
    -- El flujo legacy oauth_upgrade a Google SIEMPRE está permitido (no afectado por kill switch cross-origin)
    IF p_flow_mode = 'oauth_upgrade' THEN
        RETURN true;
    END IF;

    IF p_flow_mode = 'cross_origin_bridge' THEN
        SELECT setting_value INTO v_setting_val
        FROM public.domain_migration_settings
        WHERE setting_key = 'cross_origin_bridge_enabled';

        RETURN COALESCE(v_setting_val, false);
    END IF;

    IF p_flow_mode = 'cross_origin_manual' THEN
        SELECT setting_value INTO v_setting_val
        FROM public.domain_migration_settings
        WHERE setting_key = 'cross_origin_manual_enabled';

        RETURN COALESCE(v_setting_val, false);
    END IF;

    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_cross_origin_migration_enabled(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_cross_origin_migration_enabled(TEXT) TO postgres, service_role;

-- Helper administrativo para activar o desactivar settings de migración
CREATE OR REPLACE FUNCTION public.set_domain_migration_setting(p_key TEXT, p_value BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.domain_migration_settings (setting_key, setting_value, updated_at)
    VALUES (p_key, p_value, pg_catalog.now())
    ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = EXCLUDED.setting_value,
        updated_at = pg_catalog.now();
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.set_domain_migration_setting(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_domain_migration_setting(TEXT, BOOLEAN) TO postgres, service_role;


-- =========================================================================
-- 3. HELPER SERVER-SIDE DE RETIRO DE IDENTIDAD ANÓNIMA
-- =========================================================================
CREATE OR REPLACE FUNCTION public.is_retired_anonymous_source(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM public.anonymous_transfer_tickets
        WHERE source_user_id_snapshot = p_user_id
          AND status = 'completed'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.is_retired_anonymous_source(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_retired_anonymous_source(UUID) TO authenticated, postgres, service_role;


-- =========================================================================
-- 4. POLÍTICAS DE RATE LIMITING SERVER-SIDE (FAIL-CLOSED)
-- =========================================================================
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES
    ('create_migration_ticket', 6, 900, true),
    ('claim_migration_ticket', 5, 900, true),
    ('link_guest_tokens_batch', 10, 900, true)
ON CONFLICT (action) DO UPDATE
SET max_requests = EXCLUDED.max_requests,
    window_seconds = EXCLUDED.window_seconds,
    enabled = EXCLUDED.enabled;


-- =========================================================================
-- 5. MOTOR UNIFICADO PRIVADO DE TRANSFERENCIA DE RECURSOS
--    public._transfer_anonymous_resources_internal(source_uid, target_uid)
--    Garantiza cero pérdidas silenciosas, resolución determinista de
--    conflictos, ordenamiento anti-deadlock y post-condiciones estrictas A..L.
-- =========================================================================
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
                ) OR respondio_disponibilidad = true) DESC,
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
                        respondio_disponibilidad = (COALESCE(v_can_part.respondio_disponibilidad, false) OR COALESCE(v_red_part.respondio_disponibilidad, false)),
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


-- =========================================================================
-- 6. RPC: public.vincular_tokens_participante_lote_seguro(TEXT[])
--    Pre-vincula tokens locales de participación sin sesión antes de migrar.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.vincular_tokens_participante_lote_seguro(
    p_tokens TEXT[]
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_rate_res JSONB;
    v_token_text TEXT;
    v_token_uuid UUID;
    v_part RECORD;
    v_linked_count INT := 0;
    v_already_linked_count INT := 0;
    v_skipped_count INT := 0;
    v_processed_count INT := 0;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- Guardia para sesiones anónimas retiradas
    IF v_is_anon THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('pe_identity_mutation:' || v_user_id::text)
        );
        IF public.is_retired_anonymous_source(v_user_id) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
        END IF;
    END IF;

    -- Rate limiting server-side
    v_rate_res := public.check_rate_limit_internal('link_guest_tokens_batch', '');
    IF v_rate_res IS NULL OR (v_rate_res->>'allowed')::boolean IS NOT TRUE THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    IF p_tokens IS NULL OR pg_catalog.cardinality(p_tokens) = 0 THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'linked_count', 0,
            'already_linked_count', 0,
            'skipped_count', 0
        );
    END IF;

    FOR v_token_text IN (SELECT DISTINCT t FROM pg_catalog.unnest(p_tokens) AS t LIMIT 50) LOOP
        v_processed_count := v_processed_count + 1;
        v_token_text := pg_catalog.lower(pg_catalog.btrim(v_token_text));

        IF v_token_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            v_skipped_count := v_skipped_count + 1;
            CONTINUE;
        END IF;

        v_token_uuid := v_token_text::UUID;

        SELECT p.id, p.user_id, p.encuentro_id, e.host_id
        INTO v_part
        FROM public.participantes p
        JOIN public.encuentros e ON e.id = p.encuentro_id
        WHERE p.token_invitacion = v_token_uuid;

        IF NOT FOUND THEN
            v_skipped_count := v_skipped_count + 1;
            CONTINUE;
        END IF;

        -- No vincular si el usuario actual es el host del encuentro
        IF v_part.host_id = v_user_id THEN
            v_skipped_count := v_skipped_count + 1;
            CONTINUE;
        END IF;

        IF v_part.user_id = v_user_id THEN
            v_already_linked_count := v_already_linked_count + 1;
            CONTINUE;
        END IF;

        IF v_part.user_id IS NOT NULL THEN
            -- Ya pertenece a otra identidad
            v_skipped_count := v_skipped_count + 1;
            CONTINUE;
        END IF;

        -- Vincular participación disponible
        UPDATE public.participantes
        SET user_id = v_user_id
        WHERE id = v_part.id
          AND user_id IS NULL;

        IF FOUND THEN
            v_linked_count := v_linked_count + 1;
        ELSE
            v_skipped_count := v_skipped_count + 1;
        END IF;
    END LOOP;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'linked_count', v_linked_count,
        'already_linked_count', v_already_linked_count,
        'skipped_count', v_skipped_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.vincular_tokens_participante_lote_seguro(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vincular_tokens_participante_lote_seguro(TEXT[]) TO authenticated;


-- =========================================================================
-- 7. RPC: public.create_domain_migration_ticket_seguro(flow_mode, intended_target)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.create_domain_migration_ticket_seguro(
    p_flow_mode TEXT DEFAULT 'cross_origin_bridge',
    p_intended_target_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_raw_token TEXT;
    v_token_hash TEXT;
    v_expires_at TIMESTAMPTZ;
    v_ttl INTERVAL;
    v_has_resources BOOLEAN := false;
    v_existing_ticket_id UUID;
    v_existing_expires_at TIMESTAMPTZ;
    v_rate_res JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF NOT v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_user_required');
    END IF;

    -- Lock de mutación de identidad
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('pe_identity_mutation:' || v_user_id::text)
    );

    IF public.is_retired_anonymous_source(v_user_id) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
    END IF;

    IF p_flow_mode NOT IN ('oauth_upgrade', 'cross_origin_bridge', 'cross_origin_manual') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_flow_mode');
    END IF;

    -- Kill Switch del servidor: verifica si el flujo cross-origin está habilitado
    IF NOT public.is_cross_origin_migration_enabled(p_flow_mode) THEN
        IF p_flow_mode = 'cross_origin_manual' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'manual_migration_disabled');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'cross_origin_migration_disabled');
        END IF;
    END IF;

    -- Validación estricta de target en flujo automático puente
    IF p_flow_mode = 'cross_origin_bridge' THEN
        IF p_intended_target_user_id IS NULL OR p_intended_target_user_id = v_user_id THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'intended_target_required');
        END IF;

        IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_intended_target_user_id) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'intended_target_required');
        END IF;
    END IF;

    -- Rate limiting server-side
    v_rate_res := public.check_rate_limit_internal('create_migration_ticket', '');
    IF v_rate_res IS NULL OR (v_rate_res->>'allowed')::boolean IS NOT TRUE THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- Verificación exhaustiva de recursos transferibles reales
    SELECT (
        EXISTS (SELECT 1 FROM public.encuentros WHERE host_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.usuario_localidades WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.participantes WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE usuario_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.custom_invitation_templates WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.creation_sessions WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.encuentros_contacto_whatsapp WHERE host_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.mensajes_encuentro WHERE autor_user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.coverage_requests WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.inbox_notifications WHERE recipient_user_id = v_user_id)
    ) INTO v_has_resources;

    IF NOT v_has_resources THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'no_transferable_resources');
    END IF;

    -- Verificar tickets pending previos
    SELECT id, expires_at INTO v_existing_ticket_id, v_existing_expires_at
    FROM public.anonymous_transfer_tickets
    WHERE source_user_id_snapshot = v_user_id
      AND status = 'pending';

    IF FOUND THEN
        IF v_existing_expires_at > pg_catalog.timezone('utc', pg_catalog.now()) THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'transfer_ticket_already_pending'
            );
        ELSE
            UPDATE public.anonymous_transfer_tickets
            SET status = 'expired'
            WHERE id = v_existing_ticket_id;
        END IF;
    END IF;

    -- TTL diferenciado por modo: 3m manual / 5m bridge / 15m oauth
    v_ttl := CASE
        WHEN p_flow_mode = 'cross_origin_manual' THEN interval '3 minutes'
        WHEN p_flow_mode = 'cross_origin_bridge' THEN interval '5 minutes'
        ELSE interval '15 minutes'
    END;

    v_expires_at := pg_catalog.timezone('utc', pg_catalog.now()) + v_ttl;
    v_raw_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
    v_token_hash := pg_catalog.encode(pg_catalog.sha256(v_raw_token::bytea), 'hex');

    INSERT INTO public.anonymous_transfer_tickets (
        source_user_id,
        source_user_id_snapshot,
        token_hash,
        expires_at,
        status,
        flow_mode,
        intended_target_user_id
    ) VALUES (
        v_user_id,
        v_user_id,
        v_token_hash,
        v_expires_at,
        'pending',
        p_flow_mode,
        CASE WHEN p_flow_mode = 'cross_origin_bridge' THEN p_intended_target_user_id ELSE NULL END
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'ticket_token', v_raw_token,
        'flow_mode', p_flow_mode,
        'intended_target_user_id', CASE WHEN p_flow_mode = 'cross_origin_bridge' THEN p_intended_target_user_id ELSE NULL END,
        'expires_at', v_expires_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.create_domain_migration_ticket_seguro(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_domain_migration_ticket_seguro(TEXT, UUID) TO authenticated;


-- =========================================================================
-- 8. RPC: public.claim_domain_migration_ticket_seguro(p_ticket_token)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.claim_domain_migration_ticket_seguro(
    p_ticket_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_target_user_id UUID := auth.uid();
    v_target_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_clean_token TEXT;
    v_token_hash TEXT;
    v_ticket public.anonymous_transfer_tickets%ROWTYPE;
    v_source_user_id UUID;
    v_source_is_anon BOOLEAN;
    v_rate_res JSONB;
    v_summary JSONB;
BEGIN
    IF v_target_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_target_is_anon AND public.is_retired_anonymous_source(v_target_user_id) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'target_session_retired');
    END IF;

    -- Normalizar guiones y espacios visuales
    v_clean_token := pg_catalog.lower(pg_catalog.regexp_replace(COALESCE(p_ticket_token, ''), '[\s-]+', '', 'g'));
    IF v_clean_token !~ '^[0-9a-f]{64}$' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_token_format');
    END IF;

    -- Rate limiting server-side evaluado ANTES de buscar el hash (fail-closed, anti-oráculo)
    v_rate_res := public.check_rate_limit_internal('claim_migration_ticket', '');
    IF v_rate_res IS NULL OR (v_rate_res->>'allowed')::boolean IS NOT TRUE THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    v_token_hash := pg_catalog.encode(pg_catalog.sha256(v_clean_token::bytea), 'hex');

    -- Bloqueo FOR UPDATE a nivel de fila
    SELECT * INTO v_ticket
    FROM public.anonymous_transfer_tickets
    WHERE token_hash = v_token_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_not_found');
    END IF;

    -- Aislamiento estricto de modo: claim_domain_migration_ticket_seguro SOLO admite transferencias entre dominios
    IF v_ticket.flow_mode NOT IN ('cross_origin_bridge', 'cross_origin_manual') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_flow_mode');
    END IF;

    IF v_ticket.status = 'completed' OR v_ticket.used_at IS NOT NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_already_used');
    END IF;

    IF v_ticket.status = 'revoked' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_revoked');
    END IF;

    IF v_ticket.expires_at <= pg_catalog.timezone('utc', pg_catalog.now()) THEN
        UPDATE public.anonymous_transfer_tickets
        SET status = 'expired'
        WHERE id = v_ticket.id;
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_expired');
    END IF;

    -- Kill Switch del servidor: verifica que el modo del ticket esté habilitado
    IF NOT public.is_cross_origin_migration_enabled(v_ticket.flow_mode) THEN
        IF v_ticket.flow_mode = 'cross_origin_manual' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'manual_migration_disabled');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'cross_origin_migration_disabled');
        END IF;
    END IF;

    -- Control anti-DoS por terceros en asociación a destinatario:
    -- El fallo no revoca ni gasta el ticket de la víctima; solo penaliza la cuota del atacante.
    IF v_ticket.flow_mode = 'cross_origin_bridge' THEN
        IF v_ticket.intended_target_user_id IS NOT NULL AND v_ticket.intended_target_user_id <> v_target_user_id THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_target_mismatch');
        END IF;
    END IF;

    -- Aislamiento estricto de modo: esta RPC es exclusiva para transferencias entre dominios
    IF v_ticket.flow_mode NOT IN ('cross_origin_bridge', 'cross_origin_manual') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_flow_mode');
    END IF;

    v_source_user_id := v_ticket.source_user_id_snapshot;

    -- Verificación de estado del source en auth.users
    SELECT is_anonymous INTO v_source_is_anon
    FROM auth.users
    WHERE id = v_source_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'source_user_not_found');
    END IF;

    IF v_source_is_anon IS NOT TRUE THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'source_no_longer_anonymous');
    END IF;

    IF public.is_retired_anonymous_source(v_source_user_id) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'source_already_migrated');
    END IF;

    IF v_source_user_id = v_target_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_transfer_to_same_user');
    END IF;

    -- Ejecución atómica en el motor transaccional unificado
    v_summary := public._transfer_anonymous_resources_internal(v_source_user_id, v_target_user_id);

    -- Marcar ticket completado (inicia inmediatamente el retiro de source)
    UPDATE public.anonymous_transfer_tickets
    SET status = 'completed',
        used_at = pg_catalog.timezone('utc', pg_catalog.now()),
        target_user_id = v_target_user_id,
        target_user_id_snapshot = v_target_user_id,
        resources_transferred = v_summary
    WHERE id = v_ticket.id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'target_is_anonymous', v_target_is_anon,
        'resources_transferred', v_summary
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_domain_migration_ticket_seguro(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_domain_migration_ticket_seguro(TEXT) TO authenticated;


-- =========================================================================
-- 9. RPC: public.confirmar_migracion_dominio_completada_seguro(p_ticket_token)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.confirmar_migracion_dominio_completada_seguro(
    p_ticket_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_target_user_id UUID := auth.uid();
    v_target_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_clean_token TEXT;
    v_token_hash TEXT;
    v_ticket public.anonymous_transfer_tickets%ROWTYPE;
BEGIN
    IF v_target_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_clean_token := pg_catalog.lower(pg_catalog.regexp_replace(COALESCE(p_ticket_token, ''), '[\s-]+', '', 'g'));
    IF v_clean_token !~ '^[0-9a-f]{64}$' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_token_format');
    END IF;

    v_token_hash := pg_catalog.encode(pg_catalog.sha256(v_clean_token::bytea), 'hex');

    SELECT * INTO v_ticket
    FROM public.anonymous_transfer_tickets
    WHERE token_hash = v_token_hash;

    IF FOUND
       AND v_ticket.status = 'completed'
       AND v_ticket.used_at IS NOT NULL
       AND (v_ticket.target_user_id_snapshot = v_target_user_id OR v_ticket.target_user_id = v_target_user_id)
       AND (v_ticket.flow_mode IN ('cross_origin_bridge', 'cross_origin_manual') OR NOT v_target_is_anon)
    THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'already_completed', true,
            'completed_at', v_ticket.used_at,
            'resources_transferred', v_ticket.resources_transferred
        );
    END IF;

    RETURN pg_catalog.json_build_object('ok', false, 'error', 'transfer_not_confirmed');
END;
$$;

REVOKE ALL ON FUNCTION public.confirmar_migracion_dominio_completada_seguro(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirmar_migracion_dominio_completada_seguro(TEXT) TO authenticated;


-- =========================================================================
-- 10. ACTUALIZACIÓN COMPATIBLE: public.get_anonymous_upgrade_state()
-- =========================================================================
CREATE OR REPLACE FUNCTION public.get_anonymous_upgrade_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_has_encounters BOOLEAN := false;
    v_has_zones BOOLEAN := false;
    v_has_participants BOOLEAN := false;
    v_has_requests BOOLEAN := false;
    v_has_templates BOOLEAN := false;
    v_has_ai_sessions BOOLEAN := false;
    v_has_creation_sessions BOOLEAN := false;
    v_has_whatsapp BOOLEAN := false;
    v_has_messages BOOLEAN := false;
    v_has_coverage BOOLEAN := false;
    v_has_inbox BOOLEAN := false;
    v_has_other BOOLEAN := false;
    v_has_transferable BOOLEAN := false;
    v_already_migrated BOOLEAN := false;
    v_last_migrated_at TIMESTAMPTZ := NULL;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    v_already_migrated := public.is_retired_anonymous_source(v_user_id);

    IF v_already_migrated THEN
        SELECT used_at INTO v_last_migrated_at
        FROM public.anonymous_transfer_tickets
        WHERE source_user_id_snapshot = v_user_id
          AND status = 'completed'
        ORDER BY used_at DESC
        LIMIT 1;
    END IF;

    IF NOT v_is_anon THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'is_anonymous', false,
            'has_owned_encounters', false,
            'has_server_zones', false,
            'has_participant_links', false,
            'has_open_requests', false,
            'has_custom_templates', false,
            'has_ai_sessions', false,
            'has_creation_sessions', false,
            'has_whatsapp_contacts', false,
            'has_messages', false,
            'has_coverage_requests', false,
            'has_inbox_notifications', false,
            'has_other_transferable_resources', false,
            'has_transferable_resources', false,
            'already_migrated', false,
            'last_migrated_at', NULL
        );
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.encuentros WHERE host_id = v_user_id LIMIT 1) INTO v_has_encounters;
    SELECT EXISTS (SELECT 1 FROM public.usuario_localidades WHERE user_id = v_user_id LIMIT 1) INTO v_has_zones;
    SELECT EXISTS (SELECT 1 FROM public.participantes WHERE user_id = v_user_id LIMIT 1) INTO v_has_participants;
    SELECT EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE usuario_id = v_user_id LIMIT 1) INTO v_has_requests;
    SELECT EXISTS (SELECT 1 FROM public.custom_invitation_templates WHERE user_id = v_user_id LIMIT 1) INTO v_has_templates;
    SELECT EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE user_id = v_user_id LIMIT 1) INTO v_has_ai_sessions;
    SELECT EXISTS (SELECT 1 FROM public.creation_sessions WHERE user_id = v_user_id LIMIT 1) INTO v_has_creation_sessions;
    SELECT EXISTS (SELECT 1 FROM public.encuentros_contacto_whatsapp WHERE host_id = v_user_id LIMIT 1) INTO v_has_whatsapp;
    SELECT EXISTS (SELECT 1 FROM public.mensajes_encuentro WHERE autor_user_id = v_user_id LIMIT 1) INTO v_has_messages;
    SELECT EXISTS (SELECT 1 FROM public.coverage_requests WHERE user_id = v_user_id LIMIT 1) INTO v_has_coverage;
    SELECT EXISTS (SELECT 1 FROM public.inbox_notifications WHERE recipient_user_id = v_user_id LIMIT 1) INTO v_has_inbox;

    v_has_other := (
        v_has_participants OR v_has_requests OR v_has_templates OR
        v_has_ai_sessions OR v_has_creation_sessions OR v_has_whatsapp OR
        v_has_messages OR v_has_coverage OR v_has_inbox
    );
    v_has_transferable := (v_has_encounters OR v_has_zones OR v_has_other);

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'is_anonymous', true,
        'has_owned_encounters', v_has_encounters,
        'has_server_zones', v_has_zones,
        'has_participant_links', v_has_participants,
        'has_open_requests', v_has_requests,
        'has_custom_templates', v_has_templates,
        'has_ai_sessions', v_has_ai_sessions,
        'has_creation_sessions', v_has_creation_sessions,
        'has_whatsapp_contacts', v_has_whatsapp,
        'has_messages', v_has_messages,
        'has_coverage_requests', v_has_coverage,
        'has_inbox_notifications', v_has_inbox,
        'has_other_transferable_resources', v_has_other,
        'has_transferable_resources', v_has_transferable,
        'already_migrated', v_already_migrated,
        'last_migrated_at', v_last_migrated_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_anonymous_upgrade_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_anonymous_upgrade_state() TO authenticated;


-- =========================================================================
-- 11. RUTAS LEGACY DE UPGRADE OAUTH: ACTUALIZACIÓN COMPATIBLE Y SEGURA
-- =========================================================================

-- 11.1 public.create_anonymous_transfer_ticket()
-- Asegura que tickets legacy se emitan exclusivamente como 'oauth_upgrade' y verifica que la sesión anónima no esté retirada
CREATE OR REPLACE FUNCTION public.create_anonymous_transfer_ticket()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_raw_token TEXT;
    v_token_hash TEXT;
    v_expires_at TIMESTAMPTZ;
    v_has_resources BOOLEAN := false;
    v_existing_ticket_id UUID;
    v_existing_expires_at TIMESTAMPTZ;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF NOT v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_user_required');
    END IF;

    -- Guardia obligatoria: rechazar si la sesión anónima ya fue retirada
    IF public.is_retired_anonymous_source(v_user_id) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
    END IF;

    -- Serialización transaccional estricta por source
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_user_id::text || '_transfer_ticket'));

    -- Verificación exhaustiva de recursos transferibles
    SELECT (
        EXISTS (SELECT 1 FROM public.encuentros WHERE host_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.usuario_localidades WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.participantes WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE usuario_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.custom_invitation_templates WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.creation_sessions WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.encuentros_contacto_whatsapp WHERE host_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.mensajes_encuentro WHERE autor_user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.coverage_requests WHERE user_id = v_user_id)
        OR EXISTS (SELECT 1 FROM public.inbox_notifications WHERE recipient_user_id = v_user_id)
    ) INTO v_has_resources;

    IF NOT v_has_resources THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'no_transferable_resources');
    END IF;

    -- Verificar si ya existe un ticket pending vigente
    SELECT id, expires_at INTO v_existing_ticket_id, v_existing_expires_at
    FROM public.anonymous_transfer_tickets
    WHERE source_user_id_snapshot = v_user_id
      AND status = 'pending';

    IF FOUND THEN
        IF v_existing_expires_at > pg_catalog.timezone('utc', pg_catalog.now()) THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'transfer_ticket_already_pending'
            );
        ELSE
            UPDATE public.anonymous_transfer_tickets
            SET status = 'expired'
            WHERE id = v_existing_ticket_id;
        END IF;
    END IF;

    v_raw_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
    v_token_hash := pg_catalog.encode(pg_catalog.sha256(v_raw_token::bytea), 'hex');
    v_expires_at := pg_catalog.timezone('utc', pg_catalog.now()) + interval '15 minutes';

    INSERT INTO public.anonymous_transfer_tickets (
        source_user_id,
        source_user_id_snapshot,
        token_hash,
        expires_at,
        status,
        flow_mode
    ) VALUES (
        v_user_id,
        v_user_id,
        v_token_hash,
        v_expires_at,
        'pending',
        'oauth_upgrade'
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'ticket_token', v_raw_token,
        'expires_at', v_expires_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.create_anonymous_transfer_ticket() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_anonymous_transfer_ticket() TO authenticated;


-- 11.2 DELEGACIÓN DE public.claim_anonymous_transfer(TEXT) EN MOTOR UNIFICADO
CREATE OR REPLACE FUNCTION public.claim_anonymous_transfer(
    p_transfer_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_target_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_clean_token TEXT;
    v_token_hash TEXT;
    v_ticket public.anonymous_transfer_tickets%ROWTYPE;
    v_source_user_id UUID;
    v_source_is_anon BOOLEAN;
    v_rate_res JSONB;
    v_summary JSONB;
BEGIN
    IF v_target_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- claim_anonymous_transfer es la ruta legacy OAuth: exige cuenta permanente obligatoria
    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_clean_token := pg_catalog.lower(pg_catalog.regexp_replace(COALESCE(p_transfer_token, ''), '[\s-]+', '', 'g'));
    IF v_clean_token !~ '^[0-9a-f]{64}$' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_token_format');
    END IF;

    v_rate_res := public.check_rate_limit_internal('claim_migration_ticket', '');
    IF v_rate_res IS NULL OR (v_rate_res->>'allowed')::boolean IS NOT TRUE THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    v_token_hash := pg_catalog.encode(pg_catalog.sha256(v_clean_token::bytea), 'hex');

    SELECT * INTO v_ticket
    FROM public.anonymous_transfer_tickets
    WHERE token_hash = v_token_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_not_found');
    END IF;

    -- Aislamiento estricto de modo: claim_anonymous_transfer SOLO admite tickets de upgrade OAuth legítimos
    IF v_ticket.flow_mode IS DISTINCT FROM 'oauth_upgrade' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_flow_mode');
    END IF;

    IF v_ticket.status = 'completed' OR v_ticket.used_at IS NOT NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_already_used');
    END IF;

    IF v_ticket.status = 'revoked' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_revoked');
    END IF;

    IF v_ticket.expires_at <= pg_catalog.timezone('utc', pg_catalog.now()) THEN
        UPDATE public.anonymous_transfer_tickets
        SET status = 'expired'
        WHERE id = v_ticket.id;
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'ticket_expired');
    END IF;

    v_source_user_id := v_ticket.source_user_id_snapshot;

    SELECT is_anonymous INTO v_source_is_anon
    FROM auth.users
    WHERE id = v_source_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'source_user_not_found');
    END IF;

    IF v_source_is_anon IS NOT TRUE THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'source_no_longer_anonymous');
    END IF;

    IF public.is_retired_anonymous_source(v_source_user_id) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'source_already_migrated');
    END IF;

    IF v_source_user_id = v_target_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_transfer_to_same_user');
    END IF;

    -- Motor unificado
    v_summary := public._transfer_anonymous_resources_internal(v_source_user_id, v_target_user_id);

    UPDATE public.anonymous_transfer_tickets
    SET status = 'completed',
        used_at = pg_catalog.timezone('utc', pg_catalog.now()),
        target_user_id = v_target_user_id,
        target_user_id_snapshot = v_target_user_id,
        resources_transferred = v_summary
    WHERE id = v_ticket.id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentros_transferred', COALESCE((v_summary->>'encuentros')::int, 0),
        'localidades_transferred', COALESCE((v_summary->>'localidades')::int, 0),
        'participantes_transferred', COALESCE((v_summary->>'participantes')::int, 0),
        'solicitudes_transferred', COALESCE((v_summary->>'solicitudes')::int, 0),
        'templates_transferred', COALESCE((v_summary->>'templates')::int, 0),
        'ai_sessions_transferred', COALESCE((v_summary->>'ai_sessions')::int, 0),
        'creation_sessions_transferred', COALESCE((v_summary->>'creation_sessions')::int, 0)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_anonymous_transfer(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_anonymous_transfer(TEXT) TO authenticated;


-- =========================================================================
-- 12. GUARDIA DE CONGELAMIENTO EN SUPERFICIES DE ESCRITURA ANÓNIMAS
-- =========================================================================

-- 12.1 crear_encuentro_seguro
-- Preserva 100% el contrato productivo (rate limiting, respuesta {'ok': true, 'id', 'public_token'}, columnas y defaults)
-- e incorpora exclusivamente el advisory lock y la guardia de sesión anónima retirada.
CREATE OR REPLACE FUNCTION public.crear_encuentro_seguro(p_data jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id          uuid := auth.uid();
    v_is_anon          boolean := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_id               uuid;
    v_token            uuid;
    v_result           json;
    v_tema_invitacion  text;
    v_post_minutes     integer;
    v_post_raw         text;
    v_rl               jsonb;
    v_priv_eval        record;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- Exclusión mutua y guardia para sesiones anónimas migradas
    IF v_is_anon THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('pe_identity_mutation:' || v_user_id::text)
        );
        IF public.is_retired_anonymous_source(v_user_id) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
        END IF;
    END IF;

    -- Validaciones determinísticas de payload
    v_id    := COALESCE((p_data->>'id')::uuid, gen_random_uuid());
    v_token := COALESCE((p_data->>'public_token')::uuid, gen_random_uuid());

    -- Piso mínimo antiabuso de plataforma para invitaciones compartibles por link
    IF p_data ? 'tipo_invitacion' AND (p_data->>'tipo_invitacion') = 'link_general' THEN
        SELECT * INTO v_priv_eval FROM public.evaluar_antiabuso_privado_determinista(p_data->>'titulo', p_data->>'descripcion');
        IF NOT v_priv_eval.allowed THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'private_content_blocked',
                'reason', v_priv_eval.reason,
                'message', 'El contenido de la invitación no cumple con las pautas de seguridad de la plataforma.'
            );
        END IF;
    END IF;

    v_tema_invitacion := CASE
        WHEN p_data->>'tema_invitacion' IN (
            'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
            'family', 'special', 'romantic', 'sports', 'entertainment',
            'learning', 'wellness', 'custom'
        )
        THEN p_data->>'tema_invitacion'
        ELSE 'classic'
    END;

    v_post_raw := p_data->>'post_event_active_minutes';
    IF v_post_raw IS NOT NULL THEN
        BEGIN
            v_post_minutes := v_post_raw::integer;
        EXCEPTION WHEN OTHERS THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END;
        IF v_post_minutes < 0 OR v_post_minutes > 1440 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END IF;
    ELSE
        v_post_minutes := 45;
    END IF;

    -- Rate limiter
    v_rl := public.check_rate_limit_internal('create_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- Mutación productiva
    INSERT INTO public.encuentros (
        id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, link_virtual,
        tipo_invitacion, host_id, public_token, estado, tema, tema_invitacion,
        invitation_template, post_event_active_minutes
    )
    VALUES (
        v_id,
        p_data->>'titulo',
        p_data->>'descripcion',
        (p_data->>'fecha')::date,
        (p_data->>'hora')::time,
        p_data->>'modalidad',
        p_data->>'lugar_texto',
        p_data->>'link_virtual',
        p_data->>'tipo_invitacion',
        v_user_id,
        v_token,
        'activo',
        'blue',
        v_tema_invitacion,
        p_data->>'invitation_template',
        v_post_minutes
    )
    RETURNING
        pg_catalog.json_build_object(
            'ok', true,
            'id', id,
            'public_token', public_token
        ) INTO v_result;

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.crear_encuentro_seguro(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_seguro(jsonb) TO anon, authenticated, postgres, service_role;


-- 12.2 vincular_usuario_participante_seguro
CREATE OR REPLACE FUNCTION public.vincular_usuario_participante_seguro(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_is_anon boolean := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_token_uuid uuid;
    v_participante public.participantes%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('pe_identity_mutation:' || v_user_id::text)
        );
        IF public.is_retired_anonymous_source(v_user_id) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
        END IF;
    END IF;

    IF NULLIF(pg_catalog.btrim(p_token), '') IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    BEGIN
        v_token_uuid := p_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_token');
    END;

    SELECT * INTO v_participante
    FROM public.participantes
    WHERE token_invitacion = v_token_uuid;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_participant_token');
    END IF;

    IF v_participante.user_id = v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'participante_id', v_participante.id, 'encuentro_id', v_participante.encuentro_id, 'already_linked', true);
    END IF;

    UPDATE public.participantes
    SET user_id = v_user_id
    WHERE token_invitacion = v_token_uuid
      AND user_id IS NULL
    RETURNING * INTO v_participante;

    IF NOT FOUND THEN
        SELECT * INTO v_participante
        FROM public.participantes
        WHERE token_invitacion = v_token_uuid;

        IF FOUND AND v_participante.user_id = v_user_id THEN
            RETURN pg_catalog.jsonb_build_object('ok', true, 'participante_id', v_participante.id, 'encuentro_id', v_participante.encuentro_id, 'already_linked', true);
        END IF;

        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_already_linked');
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'participante_id', v_participante.id, 'encuentro_id', v_participante.encuentro_id, 'already_linked', false);
END;
$$;

REVOKE ALL ON FUNCTION public.vincular_usuario_participante_seguro(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vincular_usuario_participante_seguro(text) TO authenticated;


-- 12.3 submit_coverage_request
CREATE OR REPLACE FUNCTION public.submit_coverage_request(
    p_location_text TEXT,
    p_intent_text TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_raw_location TEXT;
    v_intent TEXT;
    v_normalized TEXT;
    v_alias RECORD;
    v_locality RECORD;
    v_dedupe_key TEXT;
    v_req_type TEXT;
    v_req_id UUID;
    v_rl JSONB;
    v_is_insert BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('pe_identity_mutation:' || v_user_id::text)
        );
        IF public.is_retired_anonymous_source(v_user_id) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
        END IF;
    END IF;

    v_raw_location := pg_catalog.btrim(COALESCE(p_location_text, ''));
    IF v_raw_location = '' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'location_required');
    END IF;

    IF pg_catalog.length(v_raw_location) > 100 THEN
        v_raw_location := pg_catalog.substr(v_raw_location, 1, 100);
    END IF;

    v_intent := pg_catalog.btrim(COALESCE(p_intent_text, ''));
    IF v_intent = '' THEN
        v_intent := NULL;
    ELSIF pg_catalog.length(v_intent) > 500 THEN
        v_intent := pg_catalog.substr(v_intent, 1, 500);
    END IF;

    v_rl := public.check_rate_limit_internal('submit_coverage_request', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    v_normalized := pg_catalog.lower(pg_catalog.regexp_replace(v_raw_location, '\s+', ' ', 'g'));
    v_normalized := pg_catalog.translate(v_normalized, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU');

    SELECT a.id, a.alias_normalized, a.market_key, a.existing_locality_id,
           m.label AS market_label, m.status AS market_status
    INTO v_alias
    FROM public.coverage_location_aliases a
    JOIN public.coverage_markets m ON m.market_key = a.market_key
    WHERE a.alias_normalized = v_normalized
      AND a.active = true
    LIMIT 1;

    IF v_alias.id IS NOT NULL AND v_alias.market_status = 'active' AND v_alias.existing_locality_id IS NOT NULL THEN
        SELECT id, nombre INTO v_locality
        FROM public.localidades
        WHERE id = v_alias.existing_locality_id AND activo = true;

        IF v_locality.id IS NOT NULL THEN
            RETURN pg_catalog.jsonb_build_object(
                'ok', true,
                'result_type', 'existing_locality',
                'existing_locality_id', v_locality.id,
                'existing_locality_name', v_locality.nombre,
                'market_key', v_alias.market_key,
                'market_label', v_alias.market_label
            );
        END IF;
    END IF;

    IF v_alias.id IS NOT NULL AND v_alias.market_status != 'active' THEN
        v_req_type := 'new_market';
        v_dedupe_key := 'market:' || v_alias.market_key;

        INSERT INTO public.coverage_requests (
            user_id, market_key, request_type, raw_location_text, normalized_input,
            dedupe_key, existing_locality_id, intent_text, status, last_requested_at
        ) VALUES (
            v_user_id, v_alias.market_key, v_req_type, v_raw_location, v_normalized,
            v_dedupe_key, NULL, v_intent, 'pending', pg_catalog.now()
        )
        ON CONFLICT (user_id, dedupe_key) DO UPDATE
        SET last_requested_at = pg_catalog.now(),
            intent_text = COALESCE(EXCLUDED.intent_text, public.coverage_requests.intent_text),
            updated_at = pg_catalog.now()
        RETURNING id, (xmax = 0) INTO v_req_id, v_is_insert;

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'result_type', CASE WHEN v_is_insert THEN 'request_created' ELSE 'request_updated' END,
            'market_key', v_alias.market_key,
            'market_label', v_alias.market_label
        );
    END IF;

    IF v_alias.id IS NOT NULL AND v_alias.market_status = 'active' AND v_alias.existing_locality_id IS NULL THEN
        v_req_type := 'catalog_gap';
        v_dedupe_key := 'gap:' || v_alias.market_key || ':' || v_normalized;

        INSERT INTO public.coverage_requests (
            user_id, market_key, request_type, raw_location_text, normalized_input,
            dedupe_key, existing_locality_id, intent_text, status, last_requested_at
        ) VALUES (
            v_user_id, v_alias.market_key, v_req_type, v_raw_location, v_normalized,
            v_dedupe_key, NULL, v_intent, 'pending', pg_catalog.now()
        )
        ON CONFLICT (user_id, dedupe_key) DO UPDATE
        SET last_requested_at = pg_catalog.now(),
            intent_text = COALESCE(EXCLUDED.intent_text, public.coverage_requests.intent_text),
            updated_at = pg_catalog.now()
        RETURNING id, (xmax = 0) INTO v_req_id, v_is_insert;

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'result_type', CASE WHEN v_is_insert THEN 'request_created' ELSE 'request_updated' END,
            'market_key', v_alias.market_key,
            'market_label', v_alias.market_label
        );
    END IF;

    v_req_type := 'unknown';
    v_dedupe_key := 'unknown:' || v_normalized;

    INSERT INTO public.coverage_requests (
        user_id, market_key, request_type, raw_location_text, normalized_input,
        dedupe_key, existing_locality_id, intent_text, status, last_requested_at
    ) VALUES (
        v_user_id, NULL, v_req_type, v_raw_location, v_normalized,
        v_dedupe_key, NULL, v_intent, 'pending', pg_catalog.now()
    )
    ON CONFLICT (user_id, dedupe_key) DO UPDATE
    SET last_requested_at = pg_catalog.now(),
        intent_text = COALESCE(EXCLUDED.intent_text, public.coverage_requests.intent_text),
        updated_at = pg_catalog.now()
    RETURNING id, (xmax = 0) INTO v_req_id, v_is_insert;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'result_type', CASE WHEN v_is_insert THEN 'unknown_created' ELSE 'unknown_updated' END,
        'raw_location', v_raw_location
    );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_coverage_request(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_coverage_request(TEXT, TEXT) TO anon, authenticated;


-- 12.4 set_user_localidades_seguro
CREATE OR REPLACE FUNCTION public.set_user_localidades_seguro(
    p_locality_ids TEXT[],
    p_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_loc TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_user_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('pe_identity_mutation:' || v_user_id::text)
        );
        IF public.is_retired_anonymous_source(v_user_id) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
        END IF;
    END IF;

    DELETE FROM public.usuario_localidades WHERE user_id = v_user_id;

    IF p_locality_ids IS NOT NULL AND pg_catalog.cardinality(p_locality_ids) > 0 THEN
        FOREACH v_loc IN ARRAY p_locality_ids LOOP
            IF EXISTS (SELECT 1 FROM public.localidades WHERE id = v_loc AND activo = true) THEN
                INSERT INTO public.usuario_localidades (user_id, locality_id)
                VALUES (v_user_id, v_loc)
                ON CONFLICT (user_id, locality_id) DO NOTHING;
            END IF;
        END LOOP;
    END IF;

    RETURN pg_catalog.json_build_object('ok', true, 'locality_ids', p_locality_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.set_user_localidades_seguro(TEXT[], UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_localidades_seguro(TEXT[], UUID) TO anon, authenticated;


-- 12.5 publicar_mensaje_encuentro_seguro
-- Bloquea inmediatamente a sesiones anónimas retiradas
CREATE OR REPLACE FUNCTION public.publicar_mensaje_encuentro_seguro(
    p_encuentro_id UUID,
    p_contenido TEXT,
    p_parent_id UUID DEFAULT NULL,
    p_token_invitacion UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor JSONB;
    v_is_host BOOLEAN;
    v_user_id UUID;
    v_part_id UUID;
    v_autor_nombre TEXT;
    v_can_write BOOLEAN;
    v_parent RECORD;
    v_clean_contenido TEXT;
    v_rate_res JSONB;
    v_nuevo_id UUID;
BEGIN
    -- Guardia para sesiones anónimas migradas / retiradas
    IF auth.uid() IS NOT NULL AND public.is_retired_anonymous_source(auth.uid()) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
    END IF;

    -- 1. Validar contenido
    v_clean_contenido := pg_catalog.btrim(COALESCE(p_contenido, ''));
    IF pg_catalog.char_length(v_clean_contenido) = 0 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'empty_content');
    END IF;

    IF pg_catalog.char_length(v_clean_contenido) > 500 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'content_too_long');
    END IF;

    -- 2. Resolver identidad y permisos
    v_actor := public.resolver_actor_encuentro(p_encuentro_id, p_token_invitacion);
    IF (v_actor->>'ok')::boolean IS NOT true THEN
        RETURN v_actor;
    END IF;

    v_can_write := (v_actor->>'can_write')::boolean;
    IF NOT v_can_write THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'writing_window_closed');
    END IF;

    v_is_host := (v_actor->>'is_host')::boolean;
    v_user_id := (v_actor->>'user_id')::uuid;
    v_part_id := (v_actor->>'participante_id')::uuid;
    v_autor_nombre := v_actor->>'autor_nombre';

    -- 3. Validar parent_id (máximo 1 nivel de profundidad y mismo encuentro)
    IF p_parent_id IS NOT NULL THEN
        SELECT id, encuentro_id, parent_id, eliminado_en
        INTO v_parent
        FROM public.mensajes_encuentro
        WHERE id = p_parent_id;

        IF NOT FOUND THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'parent_message_not_found');
        END IF;

        IF v_parent.encuentro_id <> p_encuentro_id THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'parent_cross_encounter_rejected');
        END IF;

        IF v_parent.eliminado_en IS NOT NULL THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_reply_to_deleted_message');
        END IF;

        IF v_parent.parent_id IS NOT NULL THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'nested_reply_depth_exceeded');
        END IF;
    END IF;

    -- 4. Rate Limiting Multi-Vía Atómico
    IF v_user_id IS NOT NULL THEN
        IF auth.uid() IS NOT NULL THEN
            v_rate_res := public.check_rate_limit_internal('publicar_mensaje_encuentro', p_encuentro_id::text);
            IF v_rate_res IS NULL OR (v_rate_res->>'allowed')::boolean IS NOT true THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limited');
            END IF;
        END IF;
    END IF;

    IF v_part_id IS NOT NULL THEN
        v_rate_res := public.consumir_rate_limit_participante(v_part_id, 'publicar_mensaje_encuentro', p_encuentro_id::text);
        IF v_rate_res IS NULL OR (v_rate_res->>'allowed')::boolean IS NOT true THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limited');
        END IF;
    END IF;

    -- 5. Inserción del mensaje
    INSERT INTO public.mensajes_encuentro (
        encuentro_id,
        parent_id,
        autor_user_id,
        autor_participante_id,
        autor_nombre,
        es_organizador,
        contenido
    )
    VALUES (
        p_encuentro_id,
        p_parent_id,
        v_user_id,
        v_part_id,
        v_autor_nombre,
        v_is_host,
        v_clean_contenido
    )
    RETURNING id INTO v_nuevo_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'mensaje_id', v_nuevo_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.publicar_mensaje_encuentro_seguro(UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publicar_mensaje_encuentro_seguro(UUID, TEXT, UUID, UUID) TO anon, authenticated, service_role;


-- 12.6 RLS y trigger en public.custom_invitation_templates
DROP POLICY IF EXISTS "custom_templates_insert_authenticated" ON public.custom_invitation_templates;
DROP POLICY IF EXISTS "custom_templates_insert_own" ON public.custom_invitation_templates;
CREATE POLICY "custom_templates_insert_authenticated"
    ON public.custom_invitation_templates
    FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() IS NOT NULL
        AND auth.uid() = user_id
        AND NOT public.is_retired_anonymous_source(auth.uid())
    );

DROP POLICY IF EXISTS "custom_templates_update_own" ON public.custom_invitation_templates;
CREATE POLICY "custom_templates_update_own"
    ON public.custom_invitation_templates
    FOR UPDATE
    TO authenticated
    USING (
        auth.uid() IS NOT NULL
        AND auth.uid() = user_id
        AND NOT public.is_retired_anonymous_source(auth.uid())
    )
    WITH CHECK (
        auth.uid() IS NOT NULL
        AND auth.uid() = user_id
        AND NOT public.is_retired_anonymous_source(auth.uid())
    );

CREATE OR REPLACE FUNCTION public.enforce_custom_templates_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_active_count integer;
BEGIN
    IF pg_catalog.current_setting('puntoencuentro.skip_template_limit', true) = 'on' THEN
        RETURN NEW;
    END IF;

    IF public.is_retired_anonymous_source(NEW.user_id) THEN
        RAISE EXCEPTION 'anonymous_session_already_migrated'
            USING HINT = 'La sesión anónima ha sido transferida y retirada para nuevas operaciones.';
    END IF;

    IF NEW.is_active IS DISTINCT FROM true THEN
        RETURN NEW;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(NEW.user_id::text));

    SELECT COUNT(*)
    INTO v_active_count
    FROM public.custom_invitation_templates
    WHERE user_id = NEW.user_id
      AND is_active = true
      AND id IS DISTINCT FROM NEW.id;

    IF v_active_count >= 3 THEN
        RAISE EXCEPTION 'custom_templates_limit_exceeded'
            USING HINT = 'El usuario ya tiene 3 diseños personalizados activos.';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_custom_templates_limit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_custom_templates_limit ON public.custom_invitation_templates;
CREATE TRIGGER trg_custom_templates_limit
    BEFORE INSERT OR UPDATE OF is_active, user_id
    ON public.custom_invitation_templates
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_custom_templates_limit();


-- 12.7 RLS en storage.objects para el bucket de plantillas personalizadas
-- Bloquea subida, edición o eliminación de assets por identidades anónimas retiradas
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
        DROP POLICY IF EXISTS "custom_storage_owner_insert" ON storage.objects;
        CREATE POLICY "custom_storage_owner_insert"
        ON storage.objects FOR INSERT
        TO authenticated
        WITH CHECK (
            bucket_id = 'custom-invitation-templates'
            AND auth.uid()::text = (storage.foldername(name))[1]
            AND NOT public.is_retired_anonymous_source(auth.uid())
        );

        DROP POLICY IF EXISTS "custom_storage_owner_update" ON storage.objects;
        CREATE POLICY "custom_storage_owner_update"
        ON storage.objects FOR UPDATE
        TO authenticated
        USING (
            bucket_id = 'custom-invitation-templates'
            AND auth.uid()::text = (storage.foldername(name))[1]
            AND NOT public.is_retired_anonymous_source(auth.uid())
        )
        WITH CHECK (
            bucket_id = 'custom-invitation-templates'
            AND auth.uid()::text = (storage.foldername(name))[1]
            AND NOT public.is_retired_anonymous_source(auth.uid())
        );

        DROP POLICY IF EXISTS "custom_storage_owner_delete" ON storage.objects;
        CREATE POLICY "custom_storage_owner_delete"
        ON storage.objects FOR DELETE
        TO authenticated
        USING (
            bucket_id = 'custom-invitation-templates'
            AND auth.uid()::text = (storage.foldername(name))[1]
            AND NOT public.is_retired_anonymous_source(auth.uid())
        );
    END IF;
END $$;

COMMIT;
