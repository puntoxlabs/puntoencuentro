-- =============================================================================
-- Correcciones posteriores al E2E-004
--   C1. Preservar invitados privados incorporados por enlace general ANTES de Discovery.
--   C2. Exponer en la proyección pública un estado de admisión de solicitudes (sin datos sensibles).
--
-- Diagnóstico C1 (origen real de las participaciones, verificado contra Staging):
--   * responder_participante_seguro (rama public_token) es el ÚNICO camino que crea participantes
--     con tipo_invitacion = 'generico', y se bloquea si el encuentro es o fue abierto (is_open /
--     opened_at). Por lo tanto, un participante 'generico' que existe en un encuentro hoy abierto
--     ingresó legítimamente por la modalidad privada ANTERIOR.
--   * Los participantes de Discovery se crean en aprobar_solicitud_encuentro_abierto con
--     tipo_invitacion = 'individual' y quedan vinculados en solicitudes_encuentro_abierto.
--   * La clasificación previa (20261022144000) trataba como "participante abierto" a cualquier
--     'generico' de un encuentro con is_open / opened_at / solicitudes, basándose en el estado
--     MUTABLE del encuentro: revocaba la logística de invitados privados legítimos.
--
-- Solución: procedencia estable e inmutable por participante.
--   * Nueva columna participantes.admission_source, estampada por trigger BEFORE INSERT en la misma
--     transacción de alta (el RPC mantiene FOR UPDATE sobre el encuentro, por lo que no hay carrera
--     con la apertura a Discovery):
--       - 'private_general_link': 'generico' creado cuando el encuentro NUNCA fue abierto
--         (is_open = false, opened_at IS NULL y sin solicitudes).
--       - 'post_open_generic'   : 'generico' creado con el encuentro ya abierto/históricamente
--         abierto (anomalía heredada; se trata como participante abierto, fail-closed).
--       - NULL                  : cualquier otro tipo; la procedencia Discovery sigue determinándose
--         por el vínculo con solicitudes_encuentro_abierto, sin cambios.
--   * El valor es inmutable (trigger BEFORE UPDATE) y no puede ser provisto por el cliente.
--   * Un participante 'generico' es "abierto" únicamente si admission_source es distinto de
--     'private_general_link'. NO se basa en is_open: un encuentro puede abrirse o cerrarse luego.
--   * Se preservan sin cambios: bloqueo bilateral, estados rechazado/cancelado, encuentro no activo,
--     reconfirmación de participantes de Discovery y proyecciones públicas sin logística.
--   * El enlace general público NO otorga acceso a información privada tras la apertura:
--     get_encuentro_por_public_token sigue proyectando solo campos públicos.
--
-- Limitación de backfill documentada: para filas 'generico' preexistentes se infiere la procedencia
-- comparando creado_en con opened_at (primera apertura). Filas con evidencia contradictoria o no
-- verificable quedan como 'post_open_generic' (fail-closed).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Columna de procedencia estable
-- -----------------------------------------------------------------------------
ALTER TABLE public.participantes
    ADD COLUMN IF NOT EXISTS admission_source text;

ALTER TABLE public.participantes
    DROP CONSTRAINT IF EXISTS participantes_admission_source_check;
ALTER TABLE public.participantes
    ADD CONSTRAINT participantes_admission_source_check
    CHECK (admission_source IS NULL OR admission_source IN ('private_general_link', 'post_open_generic'));

COMMENT ON COLUMN public.participantes.admission_source IS
    'Procedencia inmutable de participantes con tipo_invitacion = generico. private_general_link: ingresó por enlace general cuando el encuentro nunca había sido abierto a Discovery. post_open_generic: ingresó con el encuentro abierto o históricamente abierto. NULL: no aplica.';

-- -----------------------------------------------------------------------------
-- 2. Backfill de participantes 'generico' existentes (antes de crear el guard de inmutabilidad)
-- -----------------------------------------------------------------------------
UPDATE public.participantes p
SET admission_source = CASE
    WHEN EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
        WHERE sea.participante_id = p.id
           OR sea.token_participante = p.token_invitacion
    ) THEN 'post_open_generic'
    WHEN e.opened_at IS NOT NULL AND p.creado_en < e.opened_at THEN 'private_general_link'
    WHEN e.opened_at IS NULL
         AND COALESCE(e.is_open, false) = false
         AND NOT EXISTS (
             SELECT 1 FROM public.solicitudes_encuentro_abierto sea
             WHERE sea.encuentro_id = e.id
         ) THEN 'private_general_link'
    ELSE 'post_open_generic'
END
FROM public.encuentros e
WHERE e.id = p.encuentro_id
  AND p.tipo_invitacion = 'generico'
  AND p.admission_source IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Estampado en alta e inmutabilidad
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_participante_admission_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_enc RECORD;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- El valor jamás proviene del cliente: se recalcula siempre en el servidor.
        IF NEW.tipo_invitacion = 'generico' THEN
            SELECT e.is_open, e.opened_at
            INTO v_enc
            FROM public.encuentros e
            WHERE e.id = NEW.encuentro_id;

            IF FOUND
               AND COALESCE(v_enc.is_open, false) = false
               AND v_enc.opened_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                   WHERE sea.encuentro_id = NEW.encuentro_id
               ) THEN
                NEW.admission_source := 'private_general_link';
            ELSE
                NEW.admission_source := 'post_open_generic';
            END IF;
        ELSE
            NEW.admission_source := NULL;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.admission_source IS DISTINCT FROM OLD.admission_source THEN
            RAISE EXCEPTION 'admission_source_immutable' USING ERRCODE = '42501';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_participante_admission_source() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_participantes_stamp_admission_source ON public.participantes;
CREATE TRIGGER trg_participantes_stamp_admission_source
    BEFORE INSERT ON public.participantes
    FOR EACH ROW
    EXECUTE FUNCTION public.stamp_participante_admission_source();

DROP TRIGGER IF EXISTS trg_participantes_guard_admission_source ON public.participantes;
CREATE TRIGGER trg_participantes_guard_admission_source
    BEFORE UPDATE OF admission_source ON public.participantes
    FOR EACH ROW
    EXECUTE FUNCTION public.stamp_participante_admission_source();

-- -----------------------------------------------------------------------------
-- 4. Proyecciones y autorizaciones: un 'generico' es abierto salvo procedencia privada verificada
--    (get_coordinacion_participante_seguro, get_encuentro_participante_autorizado,
--     get_encuentros_participados_por_tokens, get_encuentros_participados_seguro,
--     get_participante_seguro, obtener_contacto_whatsapp_seguro, resolver_actor_encuentro)
--    y estado público de solicitudes (get_encuentro_por_public_token).
--    Las ACL vigentes se conservan (CREATE OR REPLACE).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_coordinacion_participante_seguro(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_token_uuid uuid;
    v_participante record;
    v_enc record;
    v_auth_uid uuid := auth.uid();
    v_is_open_participant boolean := false;
    v_is_authorized_logistics boolean := false;
BEGIN
    IF p_token IS NULL OR pg_catalog.btrim(p_token) = '' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    BEGIN
        v_token_uuid := p_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_token');
    END;

    SELECT * INTO v_participante FROM public.participantes WHERE token_invitacion = v_token_uuid;
    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_token');
    END IF;

    SELECT * INTO v_enc FROM public.encuentros WHERE id = v_participante.encuentro_id;
    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_found');
    END IF;

    IF v_enc.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_cancelled');
    END IF;

    IF v_enc.date_mode IS DISTINCT FROM 'coordination' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_date_mode');
    END IF;

    -- Bloqueo bilateral si hay identidad
    IF v_participante.user_id IS NOT NULL OR v_auth_uid IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = COALESCE(v_participante.user_id, v_auth_uid) AND blocked_id = v_enc.host_id)
               OR (blocker_id = v_enc.host_id AND blocked_id = COALESCE(v_participante.user_id, v_auth_uid))
        ) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'blocked_user');
        END IF;
    END IF;

    -- Determinar inequívocamente la procedencia del participante
    v_is_open_participant := (
        EXISTS (
            SELECT 1 FROM public.solicitudes_encuentro_abierto sea
            WHERE sea.participante_id = v_participante.id
               OR sea.token_participante = v_participante.token_invitacion
               OR (v_participante.user_id IS NOT NULL AND sea.encuentro_id = v_enc.id AND sea.usuario_id = v_participante.user_id)
        )
        OR (
            (v_participante.tipo_invitacion = 'generico' AND v_participante.admission_source IS DISTINCT FROM 'private_general_link')
            AND (
                COALESCE(v_enc.is_open, false) = true
                OR v_enc.opened_at IS NOT NULL
                OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = v_enc.id)
            )
        )
    );

    -- Evaluar autorización de logística privada
    IF v_enc.estado <> 'activo' OR v_participante.estado IN ('rechazado', 'cancelado') THEN
        v_is_authorized_logistics := false;
    ELSIF v_is_open_participant THEN
        v_is_authorized_logistics := (
            v_participante.estado IN ('confirmado', 'asistio')
            AND v_enc.realization_status IN ('confirmed', 'forced')
            AND COALESCE(v_enc.inscriptions_closed, false) = true
            AND v_enc.inscriptions_cycle_id IS NOT NULL
            AND v_participante.reconfirmation_status = 'confirmed'
            AND v_participante.reconfirmed_cycle_id = v_enc.inscriptions_cycle_id
        );
    ELSE
        -- Invitado privado individual legítimo
        v_is_authorized_logistics := true;
    END IF;

    RETURN (
        WITH opc_base AS (
            SELECT id, fecha, hora_inicio, orden
            FROM public.encuentro_opciones_fecha
            WHERE encuentro_id = v_enc.id
        ),
        opc_count AS (
            SELECT pg_catalog.count(*) as c FROM opc_base
        ),
        resp_count AS (
            SELECT pg_catalog.count(DISTINCT pd.opcion_fecha_id) as c
            FROM public.participante_disponibilidades pd
            JOIN opc_base ob ON ob.id = pd.opcion_fecha_id
            WHERE pd.participante_id = v_participante.id
              AND pd.encuentro_id = v_enc.id
        )
        SELECT pg_catalog.json_build_object(
            'ok', true,
            'encuentro', pg_catalog.json_build_object(
                'id', v_enc.id,
                'titulo', CASE
                    WHEN v_is_open_participant THEN COALESCE(v_enc.open_public_title, 'Encuentro')
                    ELSE v_enc.titulo
                END,
                'open_public_title', v_enc.open_public_title,
                'descripcion', CASE
                    WHEN v_is_open_participant THEN COALESCE(v_enc.open_description, '')
                    ELSE v_enc.descripcion
                END,
                'open_description', v_enc.open_description,
                'estado', v_enc.estado,
                'modalidad', v_enc.modalidad,
                'lugar_texto', CASE
                    WHEN NOT v_is_authorized_logistics THEN NULL
                    WHEN v_enc.modalidad <> 'presencial' THEN NULL
                    WHEN v_is_open_participant THEN v_enc.lugar_texto
                    WHEN v_participante.estado IN ('pendiente', 'confirmado', 'asistio') THEN v_enc.lugar_texto
                    ELSE NULL
                END,
                'link_virtual', CASE
                    WHEN NOT v_is_authorized_logistics THEN NULL
                    WHEN v_enc.modalidad <> 'virtual' THEN NULL
                    WHEN v_participante.estado IN ('confirmado', 'asistio') THEN v_enc.link_virtual
                    ELSE NULL
                END,
                'tema', v_enc.tema,
                'tipo_invitacion', v_enc.tipo_invitacion,
                'tema_invitacion', COALESCE(v_enc.tema_invitacion, 'classic'),
                'invitation_template', v_enc.invitation_template,
                'duration_minutes', v_enc.duration_minutes,
                'public_token', v_enc.public_token,
                'is_open', COALESCE(v_enc.is_open, false),
                'open_public_zone', v_enc.open_public_zone,
                'locality_id', v_enc.locality_id
            ),
            'participante', pg_catalog.json_build_object(
                'id', v_participante.id,
                'nombre_invitado', v_participante.nombre_invitado,
                'tipo_invitacion', v_participante.tipo_invitacion,
                'estado', v_participante.estado,
                'mensaje_respuesta', v_participante.mensaje_respuesta,
                'respondio_disponibilidad', (
                    (SELECT c FROM opc_count) > 0
                    AND (SELECT c FROM resp_count) = (SELECT c FROM opc_count)
                    AND (SELECT pg_catalog.count(*) FROM public.participante_disponibilidades pd JOIN opc_base ob ON ob.id = pd.opcion_fecha_id WHERE pd.participante_id = v_participante.id AND pd.encuentro_id = v_enc.id) = (SELECT c FROM opc_count)
                )
            ),
            'coordination_status', v_enc.coordination_status,
            'response_deadline', v_enc.response_deadline,
            'selected_option_id', v_enc.selected_option_id,
            'fecha', v_enc.fecha,
            'hora', v_enc.hora,
            'mostrar_respuestas_a_invitados', v_enc.mostrar_respuestas_a_invitados,
            'visibilidad_respuestas_invitados', v_enc.visibilidad_respuestas_invitados,
            'derived_status', CASE
                WHEN v_enc.coordination_status = 'closed'
                    THEN 'closed'
                WHEN v_enc.coordination_status = 'open'
                  AND EXISTS (SELECT 1 FROM public.encuentro_opciones_fecha WHERE encuentro_id = v_enc.id)
                  AND NOT EXISTS (
                      SELECT 1 FROM public.encuentro_opciones_fecha o
                      WHERE o.encuentro_id = v_enc.id
                        AND (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                            + pg_catalog.make_interval(mins => COALESCE(v_enc.duration_minutes, v_enc.post_event_active_minutes, 45))
                            >= pg_catalog.now()
                  )
                    THEN 'expired_unconfirmed'
                WHEN v_enc.coordination_status = 'open'
                  AND v_enc.response_deadline IS NOT NULL
                  AND pg_catalog.now() >= v_enc.response_deadline
                    THEN 'deadline_passed'
                ELSE 'open'
            END,
            'opciones', (
                SELECT COALESCE(pg_catalog.json_agg(pg_catalog.json_build_object(
                    'id', o.id,
                    'fecha', o.fecha,
                    'hora_inicio', o.hora_inicio,
                    'orden', o.orden,
                    'selected', COALESCE(o.id = v_enc.selected_option_id, false),
                    'respuesta', pd.respuesta,
                    'es_preferida', pd.es_preferida,
                    'available_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.available_count, 0) ELSE 0 END,
                    'maybe_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.maybe_count, 0) ELSE 0 END,
                    'unavailable_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.unavailable_count, 0) ELSE 0 END,
                    'preferred_count', CASE WHEN v_enc.visibilidad_respuestas_invitados IN ('summary', 'detail') THEN COALESCE(agg.preferred_count, 0) ELSE 0 END,
                    'is_confirmable', CASE
                        WHEN v_enc.coordination_status = 'open'
                         AND (o.fecha + o.hora_inicio) AT TIME ZONE 'America/Argentina/Buenos_Aires'
                             + pg_catalog.make_interval(mins => COALESCE(v_enc.duration_minutes, v_enc.post_event_active_minutes, 45))
                             >= pg_catalog.now()
                        THEN true
                        ELSE false
                    END,
                    'respuestas_detalle', CASE
                        WHEN v_enc.visibilidad_respuestas_invitados = 'detail' THEN (
                            SELECT pg_catalog.json_agg(
                                pg_catalog.json_build_object(
                                    'nombre_invitado', COALESCE(NULLIF(pg_catalog.btrim(p2.nombre_invitado), ''), 'Invitado'),
                                    'respuesta', pd2.respuesta,
                                    'es_preferida', COALESCE(pd2.es_preferida, false)
                                ) ORDER BY pg_catalog.lower(COALESCE(NULLIF(pg_catalog.btrim(p2.nombre_invitado), ''), 'Invitado'))
                            )
                            FROM public.participante_disponibilidades pd2
                            JOIN public.participantes p2 ON p2.id = pd2.participante_id
                            WHERE pd2.opcion_fecha_id = o.id
                              AND pd2.encuentro_id = v_enc.id
                        )
                        ELSE NULL
                    END
                ) ORDER BY o.orden), '[]'::json)
                FROM opc_base o
                LEFT JOIN public.participante_disponibilidades pd 
                  ON pd.opcion_fecha_id = o.id AND pd.participante_id = v_participante.id AND pd.encuentro_id = v_enc.id
                LEFT JOIN (
                    SELECT
                        pd_agg.opcion_fecha_id,
                        pg_catalog.count(*) FILTER (WHERE pd_agg.respuesta = 'available') AS available_count,
                        pg_catalog.count(*) FILTER (WHERE pd_agg.respuesta = 'maybe') AS maybe_count,
                        pg_catalog.count(*) FILTER (WHERE pd_agg.respuesta = 'unavailable') AS unavailable_count,
                        pg_catalog.count(*) FILTER (WHERE pd_agg.es_preferida = true) AS preferred_count
                    FROM public.participante_disponibilidades pd_agg
                    WHERE pd_agg.encuentro_id = v_enc.id
                    GROUP BY pd_agg.opcion_fecha_id
                ) agg ON agg.opcion_fecha_id = o.id
            )
        )
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_encuentro_participante_autorizado(p_encuentro_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro RECORD;
    v_part RECORD;
    v_is_host BOOLEAN := false;
    v_is_open_participant BOOLEAN := false;
    v_is_authorized_logistics BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT
        id,
        host_id,
        titulo,
        open_public_title,
        descripcion,
        open_description,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        link_virtual,
        estado,
        cancellation_reason,
        is_open,
        opened_at,
        min_participants,
        max_participants,
        realization_status,
        inscriptions_closed,
        inscriptions_cycle_id,
        open_public_zone,
        locality_id
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 1. Si es el anfitrión: acceso total
    IF v_encuentro.host_id = v_user_id THEN
        v_is_host := true;
        v_is_authorized_logistics := true;
    ELSE
        -- 2. Si es participante registrado
        SELECT
            id,
            estado,
            seat_count,
            reconfirmation_status,
            reconfirmed_cycle_id,
            tipo_invitacion,
            admission_source,
            token_invitacion,
            creado_en
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_user_id
        ORDER BY (estado IN ('confirmado', 'asistio')) DESC, creado_en DESC
        LIMIT 1;

        IF NOT FOUND THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
        END IF;

        -- Bloqueo bilateral
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_user_id AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_user_id)
        ) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        IF v_encuentro.estado <> 'activo' OR v_part.estado IN ('rechazado', 'cancelado') THEN
            v_is_authorized_logistics := false;
        ELSIF v_part.estado IN ('confirmado', 'asistio') THEN
            v_is_open_participant := (
                EXISTS (
                    SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                    WHERE sea.participante_id = v_part.id
                       OR sea.token_participante = v_part.token_invitacion
                       OR (sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_user_id)
                )
                OR (
                    (v_part.tipo_invitacion = 'generico' AND v_part.admission_source IS DISTINCT FROM 'private_general_link')
                    AND (
                        COALESCE(v_encuentro.is_open, false) = true
                        OR v_encuentro.opened_at IS NOT NULL
                        OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = p_encuentro_id)
                    )
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
                -- Invitado privado individual legítimo
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
$function$;

CREATE OR REPLACE FUNCTION public.get_encuentros_participados_por_tokens(p_tokens text[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
            'titulo',                CASE
                WHEN (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = p.id
                           OR sea.token_participante = p.token_invitacion
                           OR (p.user_id IS NOT NULL AND sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        (p.tipo_invitacion = 'generico' AND p.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(e.is_open, false) = true
                            OR e.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = e.id)
                        )
                    )
                ) THEN COALESCE(e.open_public_title, 'Encuentro')
                ELSE e.titulo
            END,
            'open_public_title',     e.open_public_title,
            'descripcion',           CASE
                WHEN (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = p.id
                           OR sea.token_participante = p.token_invitacion
                           OR (p.user_id IS NOT NULL AND sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        (p.tipo_invitacion = 'generico' AND p.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(e.is_open, false) = true
                            OR e.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = e.id)
                        )
                    )
                ) THEN COALESCE(e.open_description, '')
                ELSE e.descripcion
            END,
            'open_description',      e.open_description,
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
                           OR sea.token_participante = p.token_invitacion
                           OR (p.user_id IS NOT NULL AND sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        (p.tipo_invitacion = 'generico' AND p.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(e.is_open, false) = true
                            OR e.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = e.id)
                        )
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
                WHEN p.estado IN ('pendiente', 'confirmado', 'asistio') THEN e.lugar_texto
                ELSE NULL
            END,
            'link_virtual',          CASE
                WHEN e.estado <> 'activo' THEN NULL
                WHEN p.estado NOT IN ('confirmado', 'asistio') THEN NULL
                WHEN e.modalidad <> 'virtual' THEN NULL
                WHEN (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = p.id
                           OR sea.token_participante = p.token_invitacion
                           OR (p.user_id IS NOT NULL AND sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        (p.tipo_invitacion = 'generico' AND p.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(e.is_open, false) = true
                            OR e.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = e.id)
                        )
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
                WHEN p.estado IN ('confirmado', 'asistio') THEN e.link_virtual
                ELSE NULL
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
            '_mi_nombre',            p.nombre_invitado,
            '_mi_token',             p.token_invitacion,
            '_mi_mensaje',           p.mensaje_respuesta,
            'is_open',               COALESCE(e.is_open, false),
            'open_public_zone',      e.open_public_zone,
            'realization_status',    COALESCE(e.realization_status, 'pending'),
            'inscriptions_closed',   COALESCE(e.inscriptions_closed, false),
            'reconfirmation_status', p.reconfirmation_status
        )
    ) INTO v_result
    FROM public.participantes p
    JOIN public.encuentros e ON e.id = p.encuentro_id
    WHERE p.token_invitacion = ANY(v_valid_tokens)
      AND p.estado NOT IN ('rechazado', 'cancelado')
      AND e.estado <> 'cancelado';

    RETURN COALESCE(v_result, '[]'::json);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_encuentros_participados_seguro()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            'titulo',                CASE
                WHEN (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = p.id
                           OR sea.token_participante = p.token_invitacion
                           OR (sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        (p.tipo_invitacion = 'generico' AND p.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(e.is_open, false) = true
                            OR e.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = e.id)
                        )
                    )
                ) THEN COALESCE(e.open_public_title, 'Encuentro')
                ELSE e.titulo
            END,
            'open_public_title',     e.open_public_title,
            'descripcion',           CASE
                WHEN (
                    EXISTS (
                        SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                        WHERE sea.participante_id = p.id
                           OR sea.token_participante = p.token_invitacion
                           OR (sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        (p.tipo_invitacion = 'generico' AND p.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(e.is_open, false) = true
                            OR e.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = e.id)
                        )
                    )
                ) THEN COALESCE(e.open_description, '')
                ELSE e.descripcion
            END,
            'open_description',      e.open_description,
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
                           OR sea.token_participante = p.token_invitacion
                           OR (sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        (p.tipo_invitacion = 'generico' AND p.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(e.is_open, false) = true
                            OR e.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = e.id)
                        )
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
                           OR sea.token_participante = p.token_invitacion
                           OR (sea.encuentro_id = e.id AND sea.usuario_id = p.user_id)
                    )
                    OR (
                        (p.tipo_invitacion = 'generico' AND p.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(e.is_open, false) = true
                            OR e.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = e.id)
                        )
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
            '_mi_nombre',            p.nombre_invitado,
            '_mi_token',             p.token_invitacion,
            '_mi_mensaje',           p.mensaje_respuesta,
            'is_open',               COALESCE(e.is_open, false),
            'open_public_zone',      e.open_public_zone,
            'realization_status',    COALESCE(e.realization_status, 'pending'),
            'inscriptions_closed',   COALESCE(e.inscriptions_closed, false),
            'reconfirmation_status', p.reconfirmation_status
        )
    ) INTO v_result
    FROM public.participantes p
    JOIN public.encuentros e ON e.id = p.encuentro_id
    WHERE p.user_id = v_user_id
      AND p.estado NOT IN ('rechazado', 'cancelado')
      AND e.estado <> 'cancelado'
      AND NOT EXISTS (
          SELECT 1 FROM public.bloqueos_usuario
          WHERE (blocker_id = v_user_id AND blocked_id = e.host_id)
             OR (blocker_id = e.host_id AND blocked_id = v_user_id)
      );

    RETURN COALESCE(v_result, '[]'::json);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_participante_seguro(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_token_uuid UUID;
    v_participante RECORD;
    v_encuentro RECORD;
    v_auth_uid UUID := auth.uid();
    v_is_authorized_logistics BOOLEAN := false;
    v_is_open_participant BOOLEAN := false;
BEGIN
    BEGIN
        v_token_uuid := p_token::UUID;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;

    SELECT
        id,
        encuentro_id,
        nombre_invitado,
        tipo_invitacion,
        estado,
        token_invitacion,
        mensaje_respuesta,
        respondido_en,
        creado_en,
        user_id,
        reconfirmation_status,
        reconfirmed_at,
        reconfirmed_cycle_id,
        admission_source
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
        open_public_title,
        descripcion,
        open_description,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        link_virtual,
        estado,
        tema,
        tema_invitacion,
        invitation_template,
        creado_en,
        is_open,
        opened_at,
        realization_status,
        inscriptions_closed,
        inscriptions_cycle_id,
        open_public_zone,
        locality_id
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

    -- Determinar inequívocamente la procedencia del participante
    v_is_open_participant := (
        EXISTS (
            SELECT 1 FROM public.solicitudes_encuentro_abierto sea
            WHERE sea.participante_id = v_participante.id
               OR sea.token_participante = v_participante.token_invitacion
               OR (v_participante.user_id IS NOT NULL AND sea.encuentro_id = v_participante.encuentro_id AND sea.usuario_id = v_participante.user_id)
        )
        OR (
            (v_participante.tipo_invitacion = 'generico' AND v_participante.admission_source IS DISTINCT FROM 'private_general_link')
            AND (
                COALESCE(v_encuentro.is_open, false) = true
                OR v_encuentro.opened_at IS NOT NULL
                OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = v_participante.encuentro_id)
            )
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
        -- Invitado privado individual legítimo
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
            'titulo',           CASE
                WHEN v_is_open_participant THEN COALESCE(v_encuentro.open_public_title, 'Encuentro')
                ELSE v_encuentro.titulo
            END,
            'open_public_title', v_encuentro.open_public_title,
            'descripcion',      CASE
                WHEN v_is_open_participant THEN COALESCE(v_encuentro.open_description, '')
                ELSE v_encuentro.descripcion
            END,
            'open_description', v_encuentro.open_description,
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
            'locality_id',      v_encuentro.locality_id
        )
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.obtener_contacto_whatsapp_seguro(p_encuentro_id uuid, p_token_invitacion uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

        SELECT id, estado, reconfirmation_status, reconfirmed_cycle_id, creado_en, tipo_invitacion, token_invitacion, admission_source
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
                           OR sea.token_participante = v_part.token_invitacion
                           OR (sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_auth_uid)
                    )
                    OR (
                        (v_part.tipo_invitacion = 'generico' AND v_part.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(v_encuentro.is_open, false) = true
                            OR v_encuentro.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = p_encuentro_id)
                        )
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
        SELECT id, estado, user_id, reconfirmation_status, reconfirmed_cycle_id, creado_en, tipo_invitacion, token_invitacion, admission_source
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
                           OR sea.token_participante = v_part.token_invitacion
                           OR (v_part.user_id IS NOT NULL AND sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_part.user_id)
                    )
                    OR (
                        (v_part.tipo_invitacion = 'generico' AND v_part.admission_source IS DISTINCT FROM 'private_general_link')
                        AND (
                            COALESCE(v_encuentro.is_open, false) = true
                            OR v_encuentro.opened_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = p_encuentro_id)
                        )
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

    SELECT telefono_whatsapp, opt_in
    INTO v_contacto
    FROM public.encuentros_contacto_whatsapp
    WHERE encuentro_id = p_encuentro_id;

    IF FOUND AND v_contacto.opt_in AND v_contacto.telefono_whatsapp IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'is_host', false,
            'has_contact', true,
            'opt_in', true,
            'telefono', v_contacto.telefono_whatsapp,
            'wa_link', 'https://wa.me/' || v_contacto.telefono_whatsapp
        );
    ELSE
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'is_host', false,
            'has_contact', false,
            'opt_in', false,
            'telefono', NULL,
            'wa_link', NULL
        );
    END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolver_actor_encuentro(p_encuentro_id uuid, p_token_invitacion uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

        SELECT id, nombre_invitado, estado, user_id, token_invitacion, reconfirmation_status, reconfirmed_cycle_id, creado_en, tipo_invitacion, admission_source
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
                   OR sea.token_participante = v_part.token_invitacion
                   OR (sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_auth_uid)
            )
            OR (
                (v_part.tipo_invitacion = 'generico' AND v_part.admission_source IS DISTINCT FROM 'private_general_link')
                AND (
                    COALESCE(v_encuentro.is_open, false) = true
                    OR v_encuentro.opened_at IS NOT NULL
                    OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = p_encuentro_id)
                )
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
        SELECT id, nombre_invitado, estado, user_id, token_invitacion, reconfirmation_status, reconfirmed_cycle_id, creado_en, tipo_invitacion, admission_source
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
                   OR sea.token_participante = v_part.token_invitacion
                   OR (v_part.user_id IS NOT NULL AND sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_part.user_id)
            )
            OR (
                (v_part.tipo_invitacion = 'generico' AND v_part.admission_source IS DISTINCT FROM 'private_general_link')
                AND (
                    COALESCE(v_encuentro.is_open, false) = true
                    OR v_encuentro.opened_at IS NOT NULL
                    OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = p_encuentro_id)
                )
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

    -- Encuentro cancelado: solo lectura durante ventana de retención
    IF v_encuentro.estado = 'cancelado' THEN
        v_limite_retencion_cancelado := COALESCE(v_encuentro.cancelled_at, v_now) + pg_catalog.interval '7 days';
        IF v_now > v_limite_retencion_cancelado THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_cancelled_expired');
        END IF;
        v_can_write := false;
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'is_host', v_is_host,
            'actor_type', v_actor_type,
            'user_id', v_user_id,
            'participante_id', v_participante_id,
            'autor_nombre', v_autor_nombre,
            'can_write', false,
            'is_cancelled', true
        );
    END IF;

    -- Encuentro activo o finalizado:
    IF v_encuentro.fecha IS NOT NULL AND v_encuentro.hora IS NOT NULL THEN
        v_inicio_timestamptz := (v_encuentro.fecha::text || ' ' || v_encuentro.hora::text)::timestamptz;
        v_limite_escritura := v_inicio_timestamptz + pg_catalog.interval '48 hours';
        v_limite_retencion_realizado := v_inicio_timestamptz + pg_catalog.interval '30 days';

        IF v_now > v_limite_retencion_realizado THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'history_expired');
        END IF;

        IF v_now <= v_limite_escritura THEN
            v_can_write := true;
        ELSE
            v_can_write := false;
        END IF;
    ELSE
        v_can_write := true;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'is_host', v_is_host,
        'actor_type', v_actor_type,
        'user_id', v_user_id,
        'participante_id', v_participante_id,
        'autor_nombre', v_autor_nombre,
        'can_write', v_can_write,
        'is_cancelled', false
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_encuentro_por_public_token(p_public_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_encuentro RECORD;
    v_token_uuid UUID;
    v_priv_eval RECORD;
    v_is_open_enc BOOLEAN := false;
    v_open_slots INTEGER := 0;
    v_open_request_state TEXT := NULL;
    v_today DATE := (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::date;
    v_now_time TIME := (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::time;
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
        moderation_reason,
        max_participants,
        inscriptions_closed
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
        RETURN pg_catalog.jsonb_build_object(
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

    -- Estado de admisión de solicitudes Discovery: solo banderas derivadas, jamás logística ni contenido privado.
    -- Mismos criterios de elegibilidad que get_discovery_encuentros_abiertos.
    IF v_is_open_enc THEN
        SELECT GREATEST(0, COALESCE(v_encuentro.max_participants, 0) - COALESCE(pg_catalog.sum(p.seat_count), 0))::int
        INTO v_open_slots
        FROM public.participantes p
        WHERE p.encuentro_id = v_encuentro.id
          AND p.estado IN ('confirmado', 'asistio');

        v_open_request_state := CASE
            WHEN v_encuentro.fecha IS NOT NULL AND (
                v_encuentro.fecha < v_today
                OR (v_encuentro.fecha = v_today AND v_encuentro.hora IS NOT NULL AND v_encuentro.hora < v_now_time)
            ) THEN 'expired'
            WHEN COALESCE(v_encuentro.is_open, false) = false
                 OR COALESCE(v_encuentro.moderation_status, '') <> 'approved' THEN 'not_accepting'
            WHEN COALESCE(v_encuentro.inscriptions_closed, false) = true THEN 'inscriptions_closed'
            WHEN v_open_slots <= 0 THEN 'full'
            ELSE 'accepting'
        END;
    END IF;

    RETURN pg_catalog.json_build_object(
        'id',                  v_encuentro.id,
        'titulo',              CASE
                                   WHEN v_is_open_enc THEN COALESCE(v_encuentro.open_public_title, 'Encuentro')
                                   ELSE v_encuentro.titulo
                               END,
        'open_public_title',   v_encuentro.open_public_title,
        'descripcion',         CASE
                                   WHEN v_is_open_enc THEN COALESCE(v_encuentro.open_description, '')
                                   ELSE v_encuentro.descripcion
                               END,
        'open_description',    v_encuentro.open_description,
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
        'is_open',             COALESCE(v_encuentro.is_open, false),
        'open_public_zone',    v_encuentro.open_public_zone,
        'locality_id',         v_encuentro.locality_id,
        'was_open',            v_is_open_enc,
        'open_request_state',  v_open_request_state,
        'accepting_open_requests', (v_open_request_state = 'accepting')
    );
END;
$function$;

COMMIT;
