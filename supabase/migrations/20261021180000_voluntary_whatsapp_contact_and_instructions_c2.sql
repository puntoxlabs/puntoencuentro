-- ==============================================================================
-- Migración: Contacto voluntario por WhatsApp e Instrucciones Definitivas (Mini-sprint C2)
-- Timestamp: 20261021180000
-- Afecta:
--   1. Nueva tabla: public.encuentros_contacto_whatsapp (RLS aislada de PostgREST)
--   2. Helper: public.normalizar_telefono_whatsapp(text)
--   3. RPC: public.guardar_contacto_whatsapp_host_seguro(uuid, text, boolean)
--   4. RPC: public.retirar_contacto_whatsapp_host_seguro(uuid)
--   5. RPC: public.obtener_contacto_whatsapp_seguro(uuid, uuid)
--   6. RPC endurecida: public.get_encuentro_participante_autorizado(uuid)
--   7. RPC endurecida: public.get_participante_seguro(text)
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. TABLA AISLADA PARA CONTACTO VOLUNTARIO DE WHATSAPP
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.encuentros_contacto_whatsapp (
    encuentro_id UUID PRIMARY KEY REFERENCES public.encuentros(id) ON DELETE CASCADE,
    host_id UUID NOT NULL,
    telefono_whatsapp TEXT NOT NULL,
    opt_in BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.encuentros_contacto_whatsapp ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.encuentros_contacto_whatsapp FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 2. HELPER: NORMALIZACIÓN Y VALIDACIÓN DE TELÉFONO INTERNACIONAL
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalizar_telefono_whatsapp(p_telefono TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_digits TEXT;
BEGIN
    IF p_telefono IS NULL THEN
        RETURN NULL;
    END IF;

    -- Eliminar espacios, guiones, paréntesis, signos + y todo caracter no numérico
    v_digits := pg_catalog.regexp_replace(p_telefono, '[^0-9]', '', 'g');

    -- Quitar prefijo de salida internacional '00' si estuviera presente
    IF pg_catalog.starts_with(v_digits, '00') THEN
        v_digits := pg_catalog.substring(v_digits, 3);
    END IF;

    -- Validar límites E.164 (estándar internacional: 8 a 15 dígitos)
    IF pg_catalog.length(v_digits) < 8 OR pg_catalog.length(v_digits) > 15 THEN
        RETURN NULL;
    END IF;

    -- Rechazar secuencias no válidas compuestas exclusivamente de ceros
    IF v_digits ~ '^0+$' THEN
        RETURN NULL;
    END IF;

    RETURN v_digits;
END;
$$;

REVOKE ALL ON FUNCTION public.normalizar_telefono_whatsapp(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalizar_telefono_whatsapp(TEXT) TO postgres, service_role, authenticated, anon;

-- ------------------------------------------------------------------------------
-- 3. RPC: GUARDAR O ACTUALIZAR CONTACTO WHATSAPP (HOST)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guardar_contacto_whatsapp_host_seguro(
    p_encuentro_id UUID,
    p_telefono TEXT,
    p_opt_in BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_encuentro RECORD;
    v_normalizado TEXT;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    SELECT id, host_id, estado
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_encuentro.host_id <> v_auth_uid THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_cancelled');
    END IF;

    -- Si el anfitrión desactiva el opt-in explícitamente
    IF p_opt_in IS NOT TRUE THEN
        UPDATE public.encuentros_contacto_whatsapp
        SET opt_in = false,
            actualizado_en = pg_catalog.now()
        WHERE encuentro_id = p_encuentro_id;

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'opt_in', false,
            'telefono', NULL
        );
    END IF;

    -- Validar y normalizar formato internacional
    v_normalizado := public.normalizar_telefono_whatsapp(p_telefono);
    IF v_normalizado IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_phone_number');
    END IF;

    INSERT INTO public.encuentros_contacto_whatsapp (
        encuentro_id,
        host_id,
        telefono_whatsapp,
        opt_in,
        creado_en,
        actualizado_en
    ) VALUES (
        p_encuentro_id,
        v_auth_uid,
        v_normalizado,
        true,
        pg_catalog.now(),
        pg_catalog.now()
    )
    ON CONFLICT (encuentro_id)
    DO UPDATE SET
        telefono_whatsapp = EXCLUDED.telefono_whatsapp,
        opt_in = true,
        actualizado_en = pg_catalog.now();

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'opt_in', true,
        'telefono', v_normalizado
    );
END;
$$;

REVOKE ALL ON FUNCTION public.guardar_contacto_whatsapp_host_seguro(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_contacto_whatsapp_host_seguro(UUID, TEXT, BOOLEAN) TO authenticated;

-- ------------------------------------------------------------------------------
-- 4. RPC: RETIRAR CONTACTO WHATSAPP (HOST)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retirar_contacto_whatsapp_host_seguro(
    p_encuentro_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_encuentro RECORD;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    SELECT id, host_id
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_encuentro.host_id <> v_auth_uid THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    DELETE FROM public.encuentros_contacto_whatsapp
    WHERE encuentro_id = p_encuentro_id;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.retirar_contacto_whatsapp_host_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retirar_contacto_whatsapp_host_seguro(UUID) TO authenticated;

-- ------------------------------------------------------------------------------
-- 5. RPC: OBTENER CONTACTO WHATSAPP SEGURO (HOST O PARTICIPANTE CONFIRMADO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obtener_contacto_whatsapp_seguro(
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
    v_contacto RECORD;
    v_part RECORD;
    v_is_authorized BOOLEAN := false;
BEGIN
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    SELECT id, host_id, estado, date_mode, coordination_status, fecha, hora
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    -- 1. Si el invocador es el anfitrión
    IF v_auth_uid IS NOT NULL AND v_auth_uid = v_encuentro.host_id THEN
        SELECT telefono_whatsapp, opt_in
        INTO v_contacto
        FROM public.encuentros_contacto_whatsapp
        WHERE encuentro_id = p_encuentro_id;

        IF FOUND THEN
            RETURN pg_catalog.jsonb_build_object(
                'ok', true,
                'is_host', true,
                'has_contact', (v_contacto.opt_in AND v_contacto.telefono_whatsapp IS NOT NULL),
                'opt_in', v_contacto.opt_in,
                'telefono', v_contacto.telefono_whatsapp,
                'wa_link', CASE WHEN v_contacto.opt_in THEN 'https://wa.me/' || v_contacto.telefono_whatsapp ELSE NULL END
            );
        ELSE
            RETURN pg_catalog.jsonb_build_object(
                'ok', true,
                'is_host', true,
                'has_contact', false,
                'opt_in', false,
                'telefono', NULL,
                'wa_link', NULL
            );
        END IF;
    END IF;

    -- 2. Reglas para participantes:
    -- Si el encuentro está cancelado, revocar acceso de inmediato
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_cancelled');
    END IF;

    -- Si es coordinación de fechas y aún no está cerrada con fecha y hora definitiva
    IF v_encuentro.date_mode = 'coordination' AND (
        v_encuentro.coordination_status IS DISTINCT FROM 'closed' OR
        v_encuentro.fecha IS NULL OR
        v_encuentro.hora IS NULL
    ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'coordination_not_closed');
    END IF;

    -- 3. Verificación de participante confirmado:
    -- A) Mediante sesión de usuario autenticada
    IF v_auth_uid IS NOT NULL THEN
        -- Verificar bloqueo bilateral entre este participante y el host
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_auth_uid AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_auth_uid)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        SELECT id, estado
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_auth_uid
        ORDER BY (estado = 'confirmado') DESC, creado_en DESC
        LIMIT 1;

        IF FOUND THEN
            IF v_part.estado = 'confirmado' THEN
                v_is_authorized := true;
            ELSE
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
            END IF;
        END IF;
    END IF;

    -- B) Mediante token de invitación personal (si no fue autorizado previamente por user_id)
    IF NOT v_is_authorized AND p_token_invitacion IS NOT NULL THEN
        SELECT id, estado, user_id
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND token_invitacion = p_token_invitacion;

        IF FOUND THEN
            IF v_part.user_id IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1 FROM public.bloqueos_usuario
                    WHERE (blocker_id = v_part.user_id AND blocked_id = v_encuentro.host_id)
                       OR (blocker_id = v_encuentro.host_id AND blocked_id = v_part.user_id)
                ) THEN
                    RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
                END IF;
            END IF;

            IF v_part.estado = 'confirmado' THEN
                v_is_authorized := true;
            ELSE
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
            END IF;
        END IF;
    END IF;

    IF NOT v_is_authorized THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 4. Obtener contacto configurado por el anfitrión
    SELECT telefono_whatsapp, opt_in
    INTO v_contacto
    FROM public.encuentros_contacto_whatsapp
    WHERE encuentro_id = p_encuentro_id;

    IF NOT FOUND OR v_contacto.opt_in IS NOT TRUE OR v_contacto.telefono_whatsapp IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'is_host', false,
            'has_contact', false,
            'opt_in', false,
            'telefono', NULL,
            'wa_link', NULL
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'is_host', false,
        'has_contact', true,
        'opt_in', true,
        'telefono', v_contacto.telefono_whatsapp,
        'wa_link', 'https://wa.me/' || v_contacto.telefono_whatsapp
    );
END;
$$;

REVOKE ALL ON FUNCTION public.obtener_contacto_whatsapp_seguro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.obtener_contacto_whatsapp_seguro(UUID, UUID) TO authenticated, anon;

-- ------------------------------------------------------------------------------
-- 6. ACTUALIZAR GET_ENCUENTRO_PARTICIPANTE_AUTORIZADO (BLOQUEO BILATERAL)
-- ------------------------------------------------------------------------------
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
    v_reconf_status TEXT := 'pending';
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
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id = v_user_id THEN
        v_is_host := true;
    ELSE
        -- Verificar bloqueo bilateral entre participante y anfitrión
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_user_id AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_user_id)
        ) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        SELECT EXISTS (
            SELECT 1 FROM public.participantes p
            WHERE p.encuentro_id = p_encuentro_id
              AND p.user_id = v_user_id
              AND p.estado IN ('confirmado', 'asistio')
        ) INTO v_is_participant;

        IF NOT v_is_participant THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        SELECT
            COALESCE(p.seat_count, 1),
            COALESCE(p.reconfirmation_status, 'pending')
        INTO
            v_part_seats,
            v_reconf_status
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
        'open_public_title', CASE
            WHEN v_is_host THEN COALESCE(v_encuentro.open_public_title, v_encuentro.titulo)
            ELSE COALESCE(v_encuentro.open_public_title, 'Encuentro')
        END,
        'open_description', CASE
            WHEN v_is_host THEN COALESCE(v_encuentro.open_description, v_encuentro.descripcion)
            ELSE COALESCE(v_encuentro.open_description, '')
        END,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'open_public_zone', v_encuentro.open_public_zone,
        'lugar_texto', CASE
            WHEN v_encuentro.estado = 'cancelado' THEN NULL
            WHEN v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto
            ELSE NULL
        END,
        'link_virtual', CASE
            WHEN v_encuentro.estado = 'cancelado' THEN NULL
            WHEN v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual
            ELSE NULL
        END,
        'seat_count', CASE WHEN v_is_host THEN NULL ELSE v_part_seats END,
        'estado', v_encuentro.estado,
        'cancellation_reason', CASE WHEN v_encuentro.estado = 'cancelado' THEN v_encuentro.cancellation_reason ELSE NULL END,
        'min_participants', v_encuentro.min_participants,
        'realization_status', COALESCE(v_encuentro.realization_status, 'pending'),
        'inscriptions_closed', COALESCE(v_encuentro.inscriptions_closed, false),
        'reconfirmation_status', CASE WHEN v_is_host THEN NULL ELSE v_reconf_status END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_participante_autorizado(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentro_participante_autorizado(UUID) TO authenticated;

-- ------------------------------------------------------------------------------
-- 7. ACTUALIZAR GET_PARTICIPANTE_SEGURO (PRIVACIDAD DE LOGÍSTICA TRAS CANCELACIÓN O RECHAZO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_participante_seguro(p_token text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_token_uuid   uuid;
    v_participante record;
    v_encuentro    record;
    v_auth_uid     uuid := auth.uid();
BEGIN
    BEGIN
        v_token_uuid := p_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN NULL;
    END;

    SELECT
        id,
        encuentro_id,
        nombre_invitado,
        tipo_invitacion,
        estado,
        creado_en,
        respondido_en,
        token_invitacion,
        mensaje_respuesta,
        user_id
    INTO v_participante
    FROM public.participantes
    WHERE token_invitacion = v_token_uuid;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT
        id,
        host_id,
        titulo,
        descripcion,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        estado,
        tema,
        tema_invitacion,
        invitation_template,
        creado_en,
        link_virtual
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_participante.encuentro_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Verificar bloqueo bilateral si hay usuario asociado
    IF v_participante.user_id IS NOT NULL OR v_auth_uid IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = COALESCE(v_participante.user_id, v_auth_uid) AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = COALESCE(v_participante.user_id, v_auth_uid))
        ) THEN
            RETURN NULL;
        END IF;
    END IF;

    RETURN pg_catalog.json_build_object(
        'id',                v_participante.id,
        'encuentro_id',      v_participante.encuentro_id,
        'nombre_invitado',   v_participante.nombre_invitado,
        'tipo_invitacion',   v_participante.tipo_invitacion,
        'estado',            v_participante.estado,
        'creado_en',         v_participante.creado_en,
        'respondido_en',     v_participante.respondido_en,
        'token_invitacion',  v_participante.token_invitacion,
        'mensaje_respuesta', v_participante.mensaje_respuesta,
        'encuentros', pg_catalog.json_build_object(
            'id',               v_encuentro.id,
            'titulo',           v_encuentro.titulo,
            'descripcion',      v_encuentro.descripcion,
            'fecha',            v_encuentro.fecha,
            'hora',             v_encuentro.hora,
            'modalidad',        v_encuentro.modalidad,
            'lugar_texto',      CASE
                WHEN v_encuentro.estado = 'cancelado' THEN NULL
                WHEN v_participante.estado IN ('rechazado', 'cancelado') THEN NULL
                ELSE v_encuentro.lugar_texto
            END,
            'estado',           v_encuentro.estado,
            'tema',             v_encuentro.tema,
            'tema_invitacion',  COALESCE(v_encuentro.tema_invitacion, 'classic'),
            'invitation_template', v_encuentro.invitation_template,
            'creado_en',        v_encuentro.creado_en,
            'link_virtual',     CASE
                WHEN v_encuentro.estado = 'cancelado' THEN NULL
                WHEN v_participante.estado = 'confirmado' AND v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual
                ELSE NULL
            END
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_participante_seguro(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_participante_seguro(text) TO anon, authenticated;

COMMIT;
