-- Migration: 20261022130000_open_encounters_reconfirmed_logistics_v1.sql
-- Descripción: Ubicación pública orientativa y logística privada condicionada a reconfirmación (V1).
--
-- Reglas esenciales:
-- 1. Se agrega public.participantes.reconfirmed_cycle_id (uuid) para asociar unívocamente la reconfirmación al ciclo vigente.
-- 2. Para participantes abiertos (solicitudes de encuentro abierto o incorporados tras apertura):
--    - El anfitrión legítimo siempre accede a sus datos privados.
--    - El participante solo accede a lugar_texto o link_virtual cuando de forma simultánea:
--      a) Encuentro activo (estado = 'activo').
--      b) Participación aprobada y vigente (estado IN ('confirmado', 'asistio')).
--      c) Realización confirmada o forzada (realization_status IN ('confirmed', 'forced')).
--      d) Inscripciones cerradas (inscriptions_closed = true).
--      e) Asistencia reconfirmada positivamente (reconfirmation_status = 'confirmed').
--      f) Reconfirmación perteneciente al ciclo vigente (reconfirmed_cycle_id = e.inscriptions_cycle_id).
--      g) Sin retiro, bloqueo bilateral o cancelación.
-- 3. Para invitados privados directos (invitación individual previa a la apertura o encuentro privado):
--    - Se preserva el contrato legítimo de invitación privada (lugar_texto visible).
--    - Enlaces virtuales privados: solo participantes confirmados/asistio ven link_virtual.
-- 4. Notificaciones, enlaces públicos y WhatsApp del anfitrión no exponen prematuramente la logística.
-- 5. Ciclos de reconfirmación endurecidos: validación server-side de cierre y realización confirmada antes de reconfirmar.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Esquema: columna reconfirmed_cycle_id en public.participantes
-- -----------------------------------------------------------------------------

ALTER TABLE public.participantes
    ADD COLUMN IF NOT EXISTS reconfirmed_cycle_id uuid;

CREATE INDEX IF NOT EXISTS idx_participantes_reconfirmed_cycle
    ON public.participantes (encuentro_id, reconfirmed_cycle_id)
    WHERE reconfirmed_cycle_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 2. RPC: get_encuentro_participante_autorizado(uuid)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_encuentro_participante_autorizado(p_encuentro_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_is_host BOOLEAN := false;
    v_part public.participantes%ROWTYPE;
    v_is_open_participant BOOLEAN := false;
    v_is_authorized_logistics BOOLEAN := false;
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

        SELECT * INTO v_part
        FROM public.participantes p
        WHERE p.encuentro_id = p_encuentro_id
          AND p.user_id = v_user_id
          AND p.estado IN ('confirmado', 'asistio')
        ORDER BY (p.estado = 'confirmado') DESC, p.creado_en DESC
        LIMIT 1;

        IF NOT FOUND THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
        END IF;
    END IF;

    -- Evaluar autorización de logística
    IF v_is_host THEN
        v_is_authorized_logistics := (v_encuentro.estado <> 'cancelado');
    ELSE
        IF v_encuentro.estado <> 'activo' THEN
            v_is_authorized_logistics := false;
        ELSE
            -- Determinar si el participante participa bajo régimen abierto
            v_is_open_participant := (
                EXISTS (
                    SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                    WHERE sea.participante_id = v_part.id
                       OR (sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_user_id)
                )
                OR (
                    COALESCE(v_encuentro.is_open, false) = true
                    AND (v_encuentro.opened_at IS NULL OR v_part.creado_en >= v_encuentro.opened_at)
                )
            );

            IF v_is_open_participant THEN
                v_is_authorized_logistics := (
                    v_encuentro.realization_status IN ('confirmed', 'forced')
                    AND COALESCE(v_encuentro.inscriptions_closed, false) = true
                    AND v_encuentro.inscriptions_cycle_id IS NOT NULL
                    AND v_part.reconfirmation_status = 'confirmed'
                    AND v_part.reconfirmed_cycle_id = v_encuentro.inscriptions_cycle_id
                );
            ELSE
                -- Invitado privado legítimo
                v_is_authorized_logistics := true;
            END IF;
        END IF;
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
            WHEN NOT v_is_authorized_logistics THEN NULL
            WHEN v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto
            ELSE NULL
        END,
        'link_virtual', CASE
            WHEN NOT v_is_authorized_logistics THEN NULL
            WHEN v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual
            ELSE NULL
        END,
        'seat_count', CASE WHEN v_is_host THEN NULL ELSE COALESCE(v_part.seat_count, 1) END,
        'estado', v_encuentro.estado,
        'cancellation_reason', CASE WHEN v_encuentro.estado = 'cancelado' THEN v_encuentro.cancellation_reason ELSE NULL END,
        'min_participants', v_encuentro.min_participants,
        'realization_status', COALESCE(v_encuentro.realization_status, 'pending'),
        'inscriptions_closed', COALESCE(v_encuentro.inscriptions_closed, false),
        'reconfirmation_status', CASE WHEN v_is_host THEN NULL ELSE COALESCE(v_part.reconfirmation_status, 'pending') END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_participante_autorizado(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_encuentro_participante_autorizado(uuid) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. RPC: get_participante_seguro(text)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_participante_seguro(p_token text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_token_uuid   uuid;
    v_participante record;
    v_encuentro    record;
    v_auth_uid     uuid := auth.uid();
    v_is_open_participant boolean := false;
    v_is_authorized_logistics boolean := false;
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
        user_id,
        reconfirmation_status,
        reconfirmed_cycle_id
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
        opened_at,
        open_public_zone,
        open_description,
        realization_status,
        inscriptions_closed,
        inscriptions_cycle_id
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

    -- Determinar si el participante participa bajo régimen abierto
    v_is_open_participant := (
        EXISTS (
            SELECT 1 FROM public.solicitudes_encuentro_abierto sea
            WHERE sea.participante_id = v_participante.id
               OR (sea.encuentro_id = v_participante.encuentro_id AND sea.usuario_id = v_participante.user_id)
        )
        OR (
            COALESCE(v_encuentro.is_open, false) = true
            AND (v_encuentro.opened_at IS NULL OR v_participante.creado_en >= v_encuentro.opened_at)
        )
    );

    -- Evaluar autorización de logística
    IF v_encuentro.estado <> 'activo' OR v_participante.estado IN ('rechazado', 'cancelado') THEN
        v_is_authorized_logistics := false;
    ELSIF v_is_open_participant THEN
        v_is_authorized_logistics := (
            v_participante.estado IN ('confirmado', 'asistio')
            AND v_encuentro.realization_status IN ('confirmed', 'forced')
            AND COALESCE(v_encuentro.inscriptions_closed, false) = true
            AND v_encuentro.inscriptions_cycle_id IS NOT NULL
            AND v_participante.reconfirmation_status = 'confirmed'
            AND v_participante.reconfirmed_cycle_id = v_encuentro.inscriptions_cycle_id
        );
    ELSE
        -- Invitado privado legítimo
        v_is_authorized_logistics := true;
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
                WHEN NOT v_is_authorized_logistics THEN NULL
                WHEN v_encuentro.modalidad <> 'presencial' THEN NULL
                WHEN v_is_open_participant THEN v_encuentro.lugar_texto
                WHEN v_participante.estado IN ('pendiente', 'confirmado', 'asistio') THEN v_encuentro.lugar_texto
                ELSE NULL
            END,
            'estado',           v_encuentro.estado,
            'tema',             v_encuentro.tema,
            'tema_invitacion',  COALESCE(v_encuentro.tema_invitacion, 'classic'),
            'invitation_template', v_encuentro.invitation_template,
            'creado_en',        v_encuentro.creado_en,
            'link_virtual',     CASE
                WHEN NOT v_is_authorized_logistics THEN NULL
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
-- 4. RPC: get_encuentro_por_public_token(text)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_encuentro_por_public_token(
    p_public_token text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_encuentro RECORD;
    v_token_uuid UUID;
    v_priv_eval RECORD;
    v_is_open_enc BOOLEAN := false;
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
        opened_at,
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

    v_is_open_enc := (
        COALESCE(v_encuentro.is_open, false) = true
        OR v_encuentro.opened_at IS NOT NULL
        OR EXISTS (
            SELECT 1 FROM public.solicitudes_encuentro_abierto sea
            WHERE sea.encuentro_id = v_encuentro.id
        )
    );

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
                                   WHEN v_is_open_enc THEN NULL
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


-- -----------------------------------------------------------------------------
-- 5. RPC: get_encuentros_participados_seguro()
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_encuentros_participados_seguro()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid;
    v_result  json;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('error', 'unauthenticated');
    END IF;

    SELECT json_agg(
        json_build_object(
            'id',                    e.id,
            'titulo',                e.titulo,
            'descripcion',           e.descripcion,
            'fecha',                 e.fecha,
            'hora',                  e.hora,
            'modalidad',             e.modalidad,
            'lugar_texto',           CASE
                WHEN e.estado <> 'activo' THEN NULL
                WHEN p.estado NOT IN ('confirmado', 'asistio') THEN NULL
                WHEN e.modalidad <> 'presencial' THEN NULL
                WHEN (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = p.id
                           OR (sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        COALESCE(e.is_open, false) = true
                        AND (e.opened_at IS NULL OR p.creado_en >= e.opened_at)
                    )
                ) THEN
                    CASE
                        WHEN e.realization_status IN ('confirmed', 'forced')
                         AND COALESCE(e.inscriptions_closed, false) = true
                         AND p.reconfirmation_status = 'confirmed'
                         AND e.inscriptions_cycle_id IS NOT NULL
                         AND p.reconfirmed_cycle_id = e.inscriptions_cycle_id
                        THEN e.lugar_texto
                        ELSE NULL
                    END
                ELSE e.lugar_texto
            END,
            'link_virtual',          CASE
                WHEN e.estado <> 'activo' THEN NULL
                WHEN p.estado NOT IN ('confirmado', 'asistio') THEN NULL
                WHEN e.modalidad <> 'virtual' THEN NULL
                WHEN (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = p.id
                           OR (sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        COALESCE(e.is_open, false) = true
                        AND (e.opened_at IS NULL OR p.creado_en >= e.opened_at)
                    )
                ) THEN
                    CASE
                        WHEN e.realization_status IN ('confirmed', 'forced')
                         AND COALESCE(e.inscriptions_closed, false) = true
                         AND p.reconfirmation_status = 'confirmed'
                         AND e.inscriptions_cycle_id IS NOT NULL
                         AND p.reconfirmed_cycle_id = e.inscriptions_cycle_id
                        THEN e.link_virtual
                        ELSE NULL
                    END
                ELSE e.link_virtual
            END,
            'tipo_invitacion',       e.tipo_invitacion,
            'host_id',               e.host_id,
            'public_token',          e.public_token,
            'reemplaza_a',           e.reemplaza_a,
            'estado',                e.estado,
            'tema',                  e.tema,
            'tema_invitacion',       COALESCE(e.tema_invitacion, 'classic'),
            'invitation_template',   e.invitation_template,
            'creado_en',             e.creado_en,
            'date_mode',             e.date_mode,
            'coordination_status',   e.coordination_status,
            'response_deadline',     e.response_deadline,
            'duration_minutes',      e.duration_minutes,
            'selected_option_id',    e.selected_option_id,
            '_mi_estado',            p.estado,
            '_mi_mensaje',           p.mensaje_respuesta,
            '_mi_token_invitacion',  p.token_invitacion,
            'post_event_active_minutes', COALESCE(e.post_event_active_minutes, 45),
            'last_option_at',        (
                SELECT MAX(
                    (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                )
                FROM public.encuentro_opciones_fecha o
                WHERE o.encuentro_id = e.id
            ),
            'has_future_options',    (
                EXISTS (
                    SELECT 1
                    FROM public.encuentro_opciones_fecha o
                    WHERE o.encuentro_id = e.id
                      AND (
                          (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                          + make_interval(mins => COALESCE(e.duration_minutes, e.post_event_active_minutes, 45))
                      ) >= now()
                )
            )
        )
        ORDER BY e.creado_en DESC
    )
    INTO v_result
    FROM public.participantes p
    JOIN public.encuentros e ON e.id = p.encuentro_id
    WHERE p.user_id = v_user_id
      AND (
          p.estado IN ('confirmado', 'rechazado')
          OR (
              e.date_mode = 'coordination'
              AND EXISTS (
                  SELECT 1 FROM public.participante_disponibilidades pd
                  WHERE pd.participante_id = p.id
                    AND pd.encuentro_id = e.id
              )
          )
      );

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentros_participados_seguro() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_encuentros_participados_seguro() TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 6. RPC: get_encuentros_participados_por_tokens(text[])
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_encuentros_participados_por_tokens(p_tokens text[])
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_valid_tokens uuid[] := ARRAY[]::uuid[];
    v_token        text;
    v_uuid_token   uuid;
    v_result       json;
BEGIN
    IF p_tokens IS NOT NULL THEN
        FOREACH v_token IN ARRAY p_tokens LOOP
            BEGIN
                v_uuid_token := v_token::uuid;
                v_valid_tokens := pg_catalog.array_append(v_valid_tokens, v_uuid_token);
            EXCEPTION WHEN invalid_text_representation THEN
                NULL;
            END;
        END LOOP;
    END IF;

    IF pg_catalog.array_length(v_valid_tokens, 1) IS NULL THEN
        RETURN '[]'::json;
    END IF;

    IF pg_catalog.array_length(v_valid_tokens, 1) > 50 THEN
        v_valid_tokens := v_valid_tokens[1:50];
    END IF;

    SELECT pg_catalog.json_agg(
        pg_catalog.json_build_object(
            'id',                    e.id,
            'titulo',                e.titulo,
            'descripcion',           e.descripcion,
            'fecha',                 e.fecha,
            'hora',                  e.hora,
            'modalidad',             e.modalidad,
            'lugar_texto',           CASE
                WHEN e.estado <> 'activo' THEN NULL
                WHEN p.estado IN ('rechazado', 'cancelado') THEN NULL
                WHEN e.modalidad <> 'presencial' THEN NULL
                WHEN (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = p.id
                           OR (sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        COALESCE(e.is_open, false) = true
                        AND (e.opened_at IS NULL OR p.creado_en >= e.opened_at)
                    )
                ) THEN
                    CASE
                        WHEN p.estado IN ('confirmado', 'asistio')
                         AND e.realization_status IN ('confirmed', 'forced')
                         AND COALESCE(e.inscriptions_closed, false) = true
                         AND p.reconfirmation_status = 'confirmed'
                         AND e.inscriptions_cycle_id IS NOT NULL
                         AND p.reconfirmed_cycle_id = e.inscriptions_cycle_id
                        THEN e.lugar_texto
                        ELSE NULL
                    END
                WHEN p.estado IN ('pendiente', 'confirmado', 'asistio') THEN e.lugar_texto
                ELSE NULL
            END,
            'estado',                e.estado,
            'tema',                  e.tema,
            'tema_invitacion',       COALESCE(e.tema_invitacion, 'classic'),
            'invitation_template',   e.invitation_template,
            'creado_en',             e.creado_en,
            'date_mode',             e.date_mode,
            'coordination_status',   e.coordination_status,
            'tipo_invitacion',       e.tipo_invitacion,
            '_mi_estado',            p.estado,
            '_mi_mensaje',           p.mensaje_respuesta,
            '_mi_token_invitacion',  p.token_invitacion,
            'link_virtual', CASE
                WHEN e.estado <> 'activo' THEN NULL
                WHEN p.estado NOT IN ('confirmado', 'asistio') THEN NULL
                WHEN e.modalidad <> 'virtual' THEN NULL
                WHEN (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = p.id
                           OR (sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        COALESCE(e.is_open, false) = true
                        AND (e.opened_at IS NULL OR p.creado_en >= e.opened_at)
                    )
                ) THEN
                    CASE
                        WHEN e.realization_status IN ('confirmed', 'forced')
                         AND COALESCE(e.inscriptions_closed, false) = true
                         AND p.reconfirmation_status = 'confirmed'
                         AND e.inscriptions_cycle_id IS NOT NULL
                         AND p.reconfirmed_cycle_id = e.inscriptions_cycle_id
                        THEN e.link_virtual
                        ELSE NULL
                    END
                ELSE e.link_virtual
            END
        )
        ORDER BY e.creado_en DESC
    )
    INTO v_result
    FROM public.participantes p
    JOIN public.encuentros e ON e.id = p.encuentro_id
    WHERE p.token_invitacion = ANY(v_valid_tokens);

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentros_participados_por_tokens(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_encuentros_participados_por_tokens(text[]) TO anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 7. RPC: obtener_contacto_whatsapp_seguro(uuid, uuid)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.obtener_contacto_whatsapp_seguro(
    p_encuentro_id uuid,
    p_token_invitacion uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_encuentro RECORD;
    v_contacto RECORD;
    v_part RECORD;
    v_is_authorized BOOLEAN := false;
    v_is_open_participant BOOLEAN := false;
BEGIN
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    SELECT id, host_id, estado, date_mode, coordination_status, fecha, hora,
           is_open, opened_at, realization_status, inscriptions_closed, inscriptions_cycle_id
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
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_cancelled');
    END IF;

    IF v_encuentro.date_mode = 'coordination' AND (
        v_encuentro.coordination_status IS DISTINCT FROM 'closed' OR
        v_encuentro.fecha IS NULL OR
        v_encuentro.hora IS NULL
    ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'coordination_not_closed');
    END IF;

    -- 3. Verificación de participante:
    IF v_auth_uid IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_auth_uid AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_auth_uid)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        SELECT id, estado, reconfirmation_status, reconfirmed_cycle_id, creado_en
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_auth_uid
        ORDER BY (estado = 'confirmado') DESC, creado_en DESC
        LIMIT 1;

        IF FOUND THEN
            IF v_part.estado = 'confirmado' THEN
                v_is_open_participant := (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = v_part.id
                           OR (sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_auth_uid)
                    )
                    OR (
                        COALESCE(v_encuentro.is_open, false) = true
                        AND (v_encuentro.opened_at IS NULL OR v_part.creado_en >= v_encuentro.opened_at)
                    )
                );

                IF v_is_open_participant THEN
                    IF v_encuentro.realization_status IN ('confirmed', 'forced')
                       AND COALESCE(v_encuentro.inscriptions_closed, false) = true
                       AND v_encuentro.inscriptions_cycle_id IS NOT NULL
                       AND v_part.reconfirmation_status = 'confirmed'
                       AND v_part.reconfirmed_cycle_id = v_encuentro.inscriptions_cycle_id THEN
                        v_is_authorized := true;
                    ELSE
                        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'reconfirmation_required');
                    END IF;
                ELSE
                    v_is_authorized := true;
                END IF;
            ELSE
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
            END IF;
        END IF;
    END IF;

    IF NOT v_is_authorized AND p_token_invitacion IS NOT NULL THEN
        SELECT id, estado, user_id, reconfirmation_status, reconfirmed_cycle_id, creado_en
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
                v_is_open_participant := (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = v_part.id
                           OR (sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_part.user_id)
                    )
                    OR (
                        COALESCE(v_encuentro.is_open, false) = true
                        AND (v_encuentro.opened_at IS NULL OR v_part.creado_en >= v_encuentro.opened_at)
                    )
                );

                IF v_is_open_participant THEN
                    IF v_encuentro.realization_status IN ('confirmed', 'forced')
                       AND COALESCE(v_encuentro.inscriptions_closed, false) = true
                       AND v_encuentro.inscriptions_cycle_id IS NOT NULL
                       AND v_part.reconfirmation_status = 'confirmed'
                       AND v_part.reconfirmed_cycle_id = v_encuentro.inscriptions_cycle_id THEN
                        v_is_authorized := true;
                    ELSE
                        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'reconfirmation_required');
                    END IF;
                ELSE
                    v_is_authorized := true;
                END IF;
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

REVOKE ALL ON FUNCTION public.obtener_contacto_whatsapp_seguro(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_contacto_whatsapp_seguro(uuid, uuid) TO anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 8. RPC: resolver_actor_encuentro(uuid, uuid)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolver_actor_encuentro(
    p_encuentro_id uuid,
    p_token_invitacion uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_encuentro RECORD;
    v_part RECORD;
    v_is_host BOOLEAN := false;
    v_actor_type TEXT := NULL;
    v_user_id UUID := NULL;
    v_participante_id UUID := NULL;
    v_autor_nombre TEXT := NULL;
    v_can_write BOOLEAN := false;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_inicio_timestamptz TIMESTAMPTZ;
    v_limite_escritura TIMESTAMPTZ;
    v_limite_retencion_realizado TIMESTAMPTZ;
    v_limite_retencion_cancelado TIMESTAMPTZ;
    v_is_open_participant BOOLEAN := false;
BEGIN
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    SELECT id, host_id, titulo, estado, fecha, hora, date_mode, coordination_status, cancelled_at, messages_purged_at,
           is_open, opened_at, realization_status, inscriptions_closed, inscriptions_cycle_id
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_not_found');
    END IF;

    -- A. Organizador del encuentro
    IF v_auth_uid IS NOT NULL AND v_auth_uid = v_encuentro.host_id THEN
        v_is_host := true;
        v_user_id := v_auth_uid;
        
        BEGIN
            v_autor_nombre := COALESCE(
                NULLIF((auth.jwt()->'user_metadata'->>'full_name'), ''),
                NULLIF((auth.jwt()->'user_metadata'->>'name'), ''),
                NULLIF(pg_catalog.current_setting('request.jwt.claim.user_metadata', true)::jsonb->>'full_name', ''),
                NULLIF(pg_catalog.current_setting('request.jwt.claim.user_metadata', true)::jsonb->>'name', ''),
                'Organizador'
            );
        EXCEPTION WHEN OTHERS THEN
            v_autor_nombre := 'Organizador';
        END;

        IF COALESCE((auth.jwt()->>'is_anonymous')::boolean, false) OR pg_catalog.current_setting('request.jwt.claim.is_anonymous', true) = 'true' THEN
            v_actor_type := 'host_anon';
        ELSE
            v_actor_type := 'host_permanent';
        END IF;

    -- B. Participante registrado con sesión (user_id = auth.uid())
    ELSIF v_auth_uid IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_auth_uid AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_auth_uid)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        SELECT id, nombre_invitado, estado, user_id, token_invitacion, reconfirmation_status, reconfirmed_cycle_id, creado_en
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_auth_uid
        ORDER BY (estado = 'confirmado') DESC, creado_en DESC
        LIMIT 1;

        IF NOT FOUND THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        IF v_part.estado <> 'confirmado' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
        END IF;

        v_is_open_participant := (
            EXISTS (
                SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                WHERE sea.participante_id = v_part.id
                   OR (sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_auth_uid)
            )
            OR (
                COALESCE(v_encuentro.is_open, false) = true
                AND (v_encuentro.opened_at IS NULL OR v_part.creado_en >= v_encuentro.opened_at)
            )
        );

        IF v_is_open_participant THEN
            IF NOT (
                v_encuentro.realization_status IN ('confirmed', 'forced')
                AND COALESCE(v_encuentro.inscriptions_closed, false) = true
                AND v_encuentro.inscriptions_cycle_id IS NOT NULL
                AND v_part.reconfirmation_status = 'confirmed'
                AND v_part.reconfirmed_cycle_id = v_encuentro.inscriptions_cycle_id
            ) THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'reconfirmation_required');
            END IF;
        END IF;

        v_actor_type := 'participant_registered';
        v_user_id := v_auth_uid;
        v_participante_id := v_part.id;
        v_autor_nombre := v_part.nombre_invitado;

    -- C. Participante con token de invitación
    ELSIF p_token_invitacion IS NOT NULL THEN
        SELECT id, nombre_invitado, estado, user_id, token_invitacion, reconfirmation_status, reconfirmed_cycle_id, creado_en
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND token_invitacion = p_token_invitacion;

        IF NOT FOUND THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        IF v_part.estado <> 'confirmado' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
        END IF;

        IF v_part.user_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_part.user_id AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_part.user_id)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        v_is_open_participant := (
            EXISTS (
                SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                WHERE sea.participante_id = v_part.id
                   OR (sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_part.user_id)
            )
            OR (
                COALESCE(v_encuentro.is_open, false) = true
                AND (v_encuentro.opened_at IS NULL OR v_part.creado_en >= v_encuentro.opened_at)
            )
        );

        IF v_is_open_participant THEN
            IF NOT (
                v_encuentro.realization_status IN ('confirmed', 'forced')
                AND COALESCE(v_encuentro.inscriptions_closed, false) = true
                AND v_encuentro.inscriptions_cycle_id IS NOT NULL
                AND v_part.reconfirmation_status = 'confirmed'
                AND v_part.reconfirmed_cycle_id = v_encuentro.inscriptions_cycle_id
            ) THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'reconfirmation_required');
            END IF;
        END IF;

        v_actor_type := 'guest_token';
        v_user_id := v_part.user_id;
        v_participante_id := v_part.id;
        v_autor_nombre := v_part.nombre_invitado;

    ELSE
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 3. ESTADOS DE CICLO DE VIDA Y RETENCIÓN
    IF v_encuentro.messages_purged_at IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'history_purged',
            'purged_at', v_encuentro.messages_purged_at
        );
    END IF;

    IF v_encuentro.date_mode = 'coordination' AND (
        v_encuentro.coordination_status IS DISTINCT FROM 'closed' OR
        v_encuentro.fecha IS NULL OR
        v_encuentro.hora IS NULL
    ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'coordination_not_closed');
    END IF;

    IF v_encuentro.fecha IS NULL OR v_encuentro.hora IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'missing_schedule');
    END IF;

    v_inicio_timestamptz := ((v_encuentro.fecha::text || ' ' || v_encuentro.hora::text)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires';
    v_limite_escritura := v_inicio_timestamptz + interval '24 hours';
    v_limite_retencion_realizado := v_inicio_timestamptz + interval '90 days';

    IF v_encuentro.estado = 'cancelado' THEN
        IF NOT v_is_host THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_cancelled');
        END IF;

        IF v_encuentro.cancelled_at IS NOT NULL THEN
            v_limite_retencion_cancelado := v_encuentro.cancelled_at + interval '30 days';
            IF v_now > v_limite_retencion_cancelado THEN
                RETURN pg_catalog.jsonb_build_object(
                    'ok', false,
                    'error', 'history_retention_expired',
                    'retention_type', 'cancelled_30d'
                );
            END IF;
        END IF;

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'actor_type', v_actor_type,
            'is_host', true,
            'user_id', v_user_id,
            'participante_id', NULL,
            'autor_nombre', v_autor_nombre,
            'can_write', false,
            'encuentro_estado', v_encuentro.estado,
            'writing_window_closed', true,
            'retention_expired', false
        );
    END IF;

    IF v_now > v_limite_retencion_realizado THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'history_retention_expired',
            'retention_type', 'active_90d'
        );
    END IF;

    IF v_now <= v_limite_escritura THEN
        v_can_write := true;
    ELSE
        v_can_write := false;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'actor_type', v_actor_type,
        'is_host', v_is_host,
        'user_id', v_user_id,
        'participante_id', v_participante_id,
        'autor_nombre', v_autor_nombre,
        'can_write', v_can_write,
        'encuentro_estado', v_encuentro.estado,
        'writing_window_closed', (v_now > v_limite_escritura),
        'retention_expired', false
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_actor_encuentro(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolver_actor_encuentro(uuid, uuid) TO anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 9. RPC: reconfirmar_asistencia_seguro(uuid, text, text) y sobrecarga (uuid, text)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reconfirmar_asistencia_seguro(
    p_encuentro_id uuid,
    p_decision text,
    p_motivo text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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

    -- 1. Bloqueo exclusivo del encuentro
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'cannot_reconfirm_cancelled_encounter',
            'message', 'El encuentro ha sido cancelado.'
        );
    END IF;

    -- 2. Bloquear solicitudes activas del usuario en este encuentro
    PERFORM 1
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
      AND estado = 'approved'
    ORDER BY id
    FOR UPDATE;

    -- 3. Bloquear participante
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
        -- Validación estricta: realización confirmada y período de reconfirmación activo
        IF v_encuentro.realization_status NOT IN ('confirmed', 'forced')
           OR COALESCE(v_encuentro.inscriptions_closed, false) IS NOT TRUE
           OR v_encuentro.inscriptions_cycle_id IS NULL THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'reconfirmation_not_open',
                'message', 'El encuentro no se encuentra en período de reconfirmación activo.'
            );
        END IF;

        UPDATE public.participantes
        SET reconfirmation_status = 'confirmed',
            reconfirmed_at = v_now,
            reconfirmed_cycle_id = v_encuentro.inscriptions_cycle_id
        WHERE id = v_part.id;

        RETURN pg_catalog.json_build_object(
            'ok', true,
            'decision', 'confirm',
            'reconfirmation_status', 'confirmed',
            'cycle_id', v_encuentro.inscriptions_cycle_id
        );
    ELSE
        -- p_decision = 'decline' (Retiro voluntario / declinar asistencia)
        v_withdrawal_event_id := pg_catalog.gen_random_uuid();

        UPDATE public.participantes
        SET reconfirmation_status = 'declined',
            reconfirmed_at = v_now,
            reconfirmed_cycle_id = NULL,
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

CREATE OR REPLACE FUNCTION public.reconfirmar_asistencia_seguro(
    p_encuentro_id uuid,
    p_decision text
)
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT public.reconfirmar_asistencia_seguro(p_encuentro_id, p_decision, NULL::text);
$$;

REVOKE ALL ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconfirmar_asistencia_seguro(uuid, text) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 10. RPC: cerrar_inscripciones_seguro(uuid, uuid)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cerrar_inscripciones_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_part record;
    v_title text;
    v_now timestamptz := pg_catalog.now();
    v_is_confirmed boolean := false;
    v_close_cycle_id uuid;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

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

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_modify_cancelled_encounter');
    END IF;

    -- IDEMPOTENCIA: Si ya está cerrado, retornar éxito sin repetir avisos
    IF COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
        RETURN pg_catalog.json_build_object(
            'ok', true,
            'inscriptions_closed', true,
            'final_confirmation_sent', false,
            'no_change', true
        );
    END IF;

    v_is_confirmed := (v_encuentro.realization_status IN ('confirmed', 'forced'));
    v_close_cycle_id := pg_catalog.gen_random_uuid();

    UPDATE public.encuentros
    SET inscriptions_closed = true,
        inscriptions_closed_at = v_now,
        inscriptions_cycle_id = v_close_cycle_id,
        final_confirmation_notified_at = CASE
            WHEN v_is_confirmed THEN v_now
            ELSE final_confirmation_notified_at
        END
    WHERE id = p_encuentro_id;

    -- Reiniciar estado de reconfirmación de todos los confirmados al nuevo ciclo
    UPDATE public.participantes
    SET reconfirmation_status = 'pending',
        reconfirmed_cycle_id = NULL
    WHERE encuentro_id = p_encuentro_id
      AND estado IN ('confirmado', 'asistio');

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

    -- Si el encuentro está confirmado o forzado, enviar notificación de confirmación final con dedup por ciclo
    IF v_is_confirmed THEN
        FOR v_part IN
            SELECT DISTINCT user_id
            FROM public.participantes
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_user_id
        LOOP
            PERFORM public.insertar_inbox_notification_seguro(
                p_recipient_user_id := v_part.user_id,
                p_notification_type := 'encounter_final_confirmation',
                p_target_type := 'encounter',
                p_target_id := p_encuentro_id,
                p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
                p_title := 'Encuentro confirmado',
                p_body := 'El encuentro está confirmado. ¿Seguís viniendo?',
                p_payload := pg_catalog.jsonb_build_object(
                    'encounter_id', p_encuentro_id,
                    'title', v_title,
                    'action_required', 'reconfirm'
                ),
                p_dedup_key := 'final_conf:' || p_encuentro_id || ':' || v_close_cycle_id || ':' || v_part.user_id
            );
        END LOOP;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'inscriptions_closed', true,
        'final_confirmation_sent', v_is_confirmed
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_inscripciones_seguro(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cerrar_inscripciones_seguro(uuid, uuid) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 11. RPC: reabrir_inscripciones_seguro(uuid, uuid)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reabrir_inscripciones_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

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

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_reopen_cancelled_encounter');
    END IF;

    -- IDEMPOTENCIA: Si ya está abierto, retornar éxito sin cambios
    IF COALESCE(v_encuentro.inscriptions_closed, false) = false THEN
        RETURN pg_catalog.json_build_object('ok', true, 'inscriptions_closed', false, 'no_change', true);
    END IF;

    UPDATE public.encuentros
    SET inscriptions_closed = false,
        inscriptions_closed_at = NULL,
        final_confirmation_notified_at = NULL
    WHERE id = p_encuentro_id;

    -- Invalidar cualquier reconfirmación previa porque las inscripciones se reabrieron
    UPDATE public.participantes
    SET reconfirmation_status = 'pending',
        reconfirmed_cycle_id = NULL
    WHERE encuentro_id = p_encuentro_id
      AND estado IN ('confirmado', 'asistio');

    RETURN pg_catalog.json_build_object('ok', true, 'inscriptions_closed', false);
END;
$$;

REVOKE ALL ON FUNCTION public.reabrir_inscripciones_seguro(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reabrir_inscripciones_seguro(uuid, uuid) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 12. RPC: hacerlo_igual_seguro(uuid, uuid)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hacerlo_igual_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_part record;
    v_title text;
    v_forced_event_id uuid;
    v_now timestamptz := pg_catalog.now();
    v_close_cycle_id uuid;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

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

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_modify_cancelled_encounter');
    END IF;

    -- IDEMPOTENCIA: Si ya está forzado, retornar sin reenviar avisos
    IF v_encuentro.realization_status = 'forced' THEN
        RETURN pg_catalog.json_build_object('ok', true, 'realization_status', 'forced', 'no_change', true);
    END IF;

    v_forced_event_id := pg_catalog.gen_random_uuid();

    -- Si las inscripciones ya estaban cerradas, forzar la realización abre de inmediato
    -- el período de reconfirmación activa para los participantes.
    IF COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
        v_close_cycle_id := COALESCE(v_encuentro.inscriptions_cycle_id, pg_catalog.gen_random_uuid());

        UPDATE public.encuentros
        SET realization_status = 'forced',
            inscriptions_cycle_id = v_close_cycle_id,
            final_confirmation_notified_at = v_now
        WHERE id = p_encuentro_id;

        UPDATE public.participantes
        SET reconfirmation_status = 'pending',
            reconfirmed_cycle_id = NULL
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio');
    ELSE
        UPDATE public.encuentros
        SET realization_status = 'forced'
        WHERE id = p_encuentro_id;
    END IF;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

    -- Notificar a participantes confirmados del evento de realización forzada
    FOR v_part IN
        SELECT DISTINCT user_id
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND estado IN ('confirmado', 'asistio')
          AND user_id IS NOT NULL
          AND user_id <> v_user_id
    LOOP
        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_part.user_id,
            p_notification_type := 'encounter_realization_forced',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
            p_title := 'El encuentro se realizará',
            p_body := 'El anfitrión confirmó que el encuentro se realizará.',
            p_payload := pg_catalog.jsonb_build_object('encounter_id', p_encuentro_id, 'title', v_title),
            p_dedup_key := 'forced_realization:' || p_encuentro_id || ':' || v_forced_event_id || ':' || v_part.user_id
        );

        -- Si las inscripciones ya estaban cerradas, emitir también aviso de reconfirmación
        IF COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
            PERFORM public.insertar_inbox_notification_seguro(
                p_recipient_user_id := v_part.user_id,
                p_notification_type := 'encounter_final_confirmation',
                p_target_type := 'encounter',
                p_target_id := p_encuentro_id,
                p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
                p_title := 'Encuentro confirmado',
                p_body := 'El encuentro está confirmado. ¿Seguís viniendo?',
                p_payload := pg_catalog.jsonb_build_object(
                    'encounter_id', p_encuentro_id,
                    'title', v_title,
                    'action_required', 'reconfirm'
                ),
                p_dedup_key := 'final_conf:' || p_encuentro_id || ':' || v_close_cycle_id || ':' || v_part.user_id
            );
        END IF;
    END LOOP;

    RETURN pg_catalog.json_build_object('ok', true, 'realization_status', 'forced');
END;
$$;

REVOKE ALL ON FUNCTION public.hacerlo_igual_seguro(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hacerlo_igual_seguro(uuid, uuid) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 13. RPC: set_min_participants_seguro(uuid, uuid, integer, boolean)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_min_participants_seguro(
    p_encuentro_id uuid,
    p_host_id uuid,
    p_min_participants integer,
    p_confirm_reversion boolean DEFAULT false
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_seats int := 0;
    v_old_status text;
    v_new_status text;
    v_part record;
    v_title text;
    v_now timestamptz := pg_catalog.now();
    v_cycle_id uuid;
    v_below_min_id uuid;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

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

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_modify_cancelled_encounter');
    END IF;

    IF p_min_participants IS NOT NULL AND p_min_participants < 1 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_min_participants');
    END IF;

    IF p_min_participants IS NOT NULL AND v_encuentro.max_participants IS NOT NULL AND p_min_participants > v_encuentro.max_participants THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'min_participants_exceeds_max');
    END IF;

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int
    INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    v_old_status := v_encuentro.realization_status;

    -- Invariante: Si ya fue forzado por el anfitrión, se preserva 'forced'
    IF v_encuentro.realization_status = 'forced' THEN
        v_new_status := 'forced';
    ELSIF p_min_participants IS NULL THEN
        v_new_status := 'pending';
    ELSIF v_confirmed_seats >= p_min_participants THEN
        v_new_status := 'confirmed';
    ELSE
        v_new_status := 'pending';
    END IF;

    -- Si pasaría de confirmed a pending y no confirmó reversión, requerir confirmación
    IF v_old_status = 'confirmed' AND v_new_status = 'pending' AND NOT p_confirm_reversion THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'requires_reversion_confirmation', true,
            'old_status', v_old_status,
            'new_status', v_new_status,
            'confirmed_seats', v_confirmed_seats,
            'new_min', p_min_participants
        );
    END IF;

    v_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo, 'Encuentro');

    UPDATE public.encuentros
    SET min_participants = p_min_participants,
        realization_status = v_new_status,
        min_confirmed_notified_at = CASE
            WHEN v_new_status = 'confirmed' AND v_old_status <> 'confirmed' THEN v_now
            WHEN v_new_status = 'pending' THEN NULL
            ELSE min_confirmed_notified_at
        END
    WHERE id = p_encuentro_id;

    -- Transición a confirmado: notificar si inscripciones cerradas
    IF v_new_status = 'confirmed' AND v_old_status <> 'confirmed' THEN
        IF COALESCE(v_encuentro.inscriptions_closed, false) = true THEN
            v_cycle_id := COALESCE(v_encuentro.inscriptions_cycle_id, pg_catalog.gen_random_uuid());

            UPDATE public.encuentros
            SET inscriptions_cycle_id = v_cycle_id,
                final_confirmation_notified_at = v_now
            WHERE id = p_encuentro_id;

            UPDATE public.participantes
            SET reconfirmation_status = 'pending',
                reconfirmed_cycle_id = NULL
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio');

            FOR v_part IN
                SELECT DISTINCT user_id
                FROM public.participantes
                WHERE encuentro_id = p_encuentro_id
                  AND estado IN ('confirmado', 'asistio')
                  AND user_id IS NOT NULL
                  AND user_id <> v_user_id
            LOOP
                PERFORM public.insertar_inbox_notification_seguro(
                    p_recipient_user_id := v_part.user_id,
                    p_notification_type := 'encounter_final_confirmation',
                    p_target_type := 'encounter',
                    p_target_id := p_encuentro_id,
                    p_deep_link := '/?tab=encuentros&open_detail=' || p_encuentro_id,
                    p_title := 'Encuentro confirmado',
                    p_body := 'El encuentro está confirmado. ¿Seguís viniendo?',
                    p_payload := pg_catalog.jsonb_build_object(
                        'encounter_id', p_encuentro_id,
                        'title', v_title,
                        'action_required', 'reconfirm'
                    ),
                    p_dedup_key := 'final_conf:' || p_encuentro_id || ':' || v_cycle_id || ':' || v_part.user_id
                );
            END LOOP;
        END IF;
    ELSIF v_new_status = 'pending' AND v_old_status = 'confirmed' THEN
        v_below_min_id := pg_catalog.gen_random_uuid();
        FOR v_part IN
            SELECT DISTINCT user_id
            FROM public.participantes
            WHERE encuentro_id = p_encuentro_id
              AND estado IN ('confirmado', 'asistio')
              AND user_id IS NOT NULL
              AND user_id <> v_user_id
        LOOP
            PERFORM public.insertar_inbox_notification_seguro(
                p_recipient_user_id := v_part.user_id,
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
                p_dedup_key := 'below_min:' || p_encuentro_id || ':' || v_below_min_id || ':' || v_part.user_id
            );
        END LOOP;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'min_participants', p_min_participants,
        'realization_status', v_new_status,
        'confirmed_seats', v_confirmed_seats
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_min_participants_seguro(uuid, uuid, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_min_participants_seguro(uuid, uuid, integer, boolean) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 14. RPC: actualizar_encuentro_seguro(uuid, uuid, jsonb)
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
        tema = CASE WHEN p_data ? 'tema' THEN p_data->>'tema' ELSE tema END,
        tema_invitacion = CASE WHEN p_data ? 'tema_invitacion' THEN p_data->>'tema_invitacion' ELSE tema_invitacion END,
        invitation_template = CASE WHEN p_data ? 'invitation_template' THEN p_data->>'invitation_template' ELSE invitation_template END,
        max_participants = v_new_max_participants,
        allow_multi_seat_requests = v_new_allow_multi,
        max_seats_per_request = v_new_max_seats,
        min_seats_per_request = v_new_min_seats,
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

            -- 1. Notificar a cada participante confirmado
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

            -- 2. Notificar a cada solicitante pendiente
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
                        'change_type', 'schedule'
                    ),
                    'sched_pending:' || v_schedule_mutation_id || ':' || v_sol.usuario_id
                );
            END LOOP;
        END IF;

        -- B. Cambio de logística (dirección o enlace virtual)
        -- Invariante: Notificar SIN exponer datos privados en el cuerpo
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
