-- Migration: 20261021235500_adjust_v1_privacy_and_logistics_by_encounter_type.sql
-- Descripción: Alinear privacidad y visibilidad de logística presencial/virtual según tipo de encuentro (V1).
-- Reglas:
-- 1. Encuentros privados con invitación individual: permiten ver lugar_texto al abrir el enlace (pendiente/confirmado/asistio), sin exigir confirmación previa.
-- 2. Encuentros privados con invitación general: permiten ver lugar_texto al abrir el enlace público.
-- 3. Encuentros abiertos (is_open = true): visitantes y solicitantes pendientes solo acceden a open_public_zone. lugar_texto se reserva a confirmados/asistio/host.
-- 4. Enlaces virtuales privados: mantienen control estricto de confirmación previa (link_virtual solo en estado confirmado/asistio).
-- 5. Encuentros cancelados / invitaciones rechazadas o canceladas: jamás exponen lugar_texto ni link_virtual.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Actualización de RPC: public.get_participante_seguro(text)
-- -----------------------------------------------------------------------------

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
        link_virtual,
        is_open,
        open_public_zone,
        open_description
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
                WHEN v_encuentro.estado <> 'activo' THEN NULL
                WHEN v_participante.estado IN ('rechazado', 'cancelado') THEN NULL
                WHEN v_encuentro.modalidad <> 'presencial' THEN NULL
                WHEN COALESCE(v_encuentro.is_open, false) = false AND v_participante.estado IN ('pendiente', 'confirmado', 'asistio') THEN v_encuentro.lugar_texto
                WHEN v_encuentro.is_open = true AND v_participante.estado IN ('confirmado', 'asistio') THEN v_encuentro.lugar_texto
                ELSE NULL
            END,
            'estado',           v_encuentro.estado,
            'tema',             v_encuentro.tema,
            'tema_invitacion',  COALESCE(v_encuentro.tema_invitacion, 'classic'),
            'invitation_template', v_encuentro.invitation_template,
            'creado_en',        v_encuentro.creado_en,
            'link_virtual',     CASE
                WHEN v_encuentro.estado <> 'activo' THEN NULL
                WHEN v_participante.estado IN ('rechazado', 'cancelado') THEN NULL
                WHEN v_encuentro.modalidad <> 'virtual' THEN NULL
                WHEN v_participante.estado IN ('confirmado', 'asistio') THEN v_encuentro.link_virtual
                ELSE NULL
            END,
            'is_open',          COALESCE(v_encuentro.is_open, false),
            'open_public_zone', v_encuentro.open_public_zone,
            'open_description', v_encuentro.open_description
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_participante_seguro(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_participante_seguro(text) TO anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 2. Actualización de RPC: public.get_encuentro_por_public_token(text)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_encuentro_por_public_token(
    p_public_token text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_encuentro RECORD;
    v_token_uuid UUID;
    v_priv_eval RECORD;
BEGIN
    BEGIN
        v_token_uuid := p_public_token::UUID;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;

    SELECT
        id,
        titulo,
        open_public_title,
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
        is_open,
        open_description,
        open_public_zone,
        locality_id,
        moderation_status,
        moderation_reason
    INTO v_encuentro
    FROM public.encuentros
    WHERE public_token = v_token_uuid;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN NULL;
    END IF;

    -- Piso mínimo antiabuso: evaluar contenido privado de la invitación compartible
    SELECT * INTO v_priv_eval FROM public.evaluar_antiabuso_privado_determinista(v_encuentro.titulo, v_encuentro.descripcion);
    IF NOT v_priv_eval.allowed THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'private_content_blocked',
            'reason', v_priv_eval.reason,
            'message', 'Este enlace de invitación no está disponible porque el contenido infringe las normas de seguridad de la comunidad.'
        );
    END IF;

    RETURN pg_catalog.json_build_object(
        'id',                  v_encuentro.id,
        'titulo',              CASE
                                   WHEN v_encuentro.is_open = true THEN v_encuentro.open_public_title
                                   ELSE v_encuentro.titulo
                               END,
        'open_public_title',   v_encuentro.open_public_title,
        'descripcion',         v_encuentro.descripcion,
        'fecha',               v_encuentro.fecha,
        'hora',                v_encuentro.hora,
        'modalidad',           v_encuentro.modalidad,
        'lugar_texto',         CASE
                                   WHEN v_encuentro.estado <> 'activo' THEN NULL
                                   WHEN COALESCE(v_encuentro.is_open, false) = true THEN NULL
                                   WHEN v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto
                                   ELSE NULL
                               END,
        'estado',              v_encuentro.estado,
        'tema',                v_encuentro.tema,
        'tema_invitacion',     v_encuentro.tema_invitacion,
        'invitation_template', v_encuentro.invitation_template,
        'creado_en',           v_encuentro.creado_en,
        'is_open',             v_encuentro.is_open,
        'open_description',    v_encuentro.open_description,
        'open_public_zone',    v_encuentro.open_public_zone,
        'locality_id',         v_encuentro.locality_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_por_public_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentro_por_public_token(text) TO anon, authenticated, postgres, service_role;

COMMIT;
