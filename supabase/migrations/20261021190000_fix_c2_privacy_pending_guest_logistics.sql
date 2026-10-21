-- Migration: 20261021190000_fix_c2_privacy_pending_guest_logistics.sql
-- Descripción: Ocultar logística privada (dirección exacta / link virtual) a invitados
-- con estado pendiente, rechazado, cancelado o en encuentros cancelados/inactivos en get_participante_seguro.
-- Revelar dirección exacta y link virtual exclusivamente a participantes con asistencia confirmada mientras el encuentro esté activo.

BEGIN;

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
                WHEN v_encuentro.estado <> 'activo' THEN NULL
                WHEN v_participante.estado IN ('confirmado', 'asistio') AND v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto
                ELSE NULL
            END,
            'estado',           v_encuentro.estado,
            'tema',             v_encuentro.tema,
            'tema_invitacion',  COALESCE(v_encuentro.tema_invitacion, 'classic'),
            'invitation_template', v_encuentro.invitation_template,
            'creado_en',        v_encuentro.creado_en,
            'link_virtual',     CASE
                WHEN v_encuentro.estado <> 'activo' THEN NULL
                WHEN v_participante.estado IN ('confirmado', 'asistio') AND v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual
                ELSE NULL
            END
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_participante_seguro(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_participante_seguro(text) TO anon, authenticated;

COMMIT;
