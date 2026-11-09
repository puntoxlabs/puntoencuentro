-- ==============================================================================
-- MIGRACIÓN ADITIVA: Desacople de Mensajería Interna de Reconfirmación Logística (DIF-17)
-- Fecha: 2026-11-09
-- Objetivo:
--   Permitir a los participantes legítimamente aprobados y confirmados en Encuentros
--   Abiertos acceder a la lectura y escritura del panel de mensajes internos
--   antes del cierre de inscripciones y la reconfirmación final de asistencia.
--
-- Invariantes de Seguridad Preservados:
--   1. get_participante_seguro permanece inalterada: la logística privada
--      (lugar_texto, link_virtual) continúa estrictamente protegida y nula hasta que
--      el encuentro alcance estado confirmado/forzado, cierre inscripciones y el
--      participante reconfirme en el ciclo actual.
--   2. obtener_contacto_whatsapp_seguro permanece inalterada: el teléfono personal
--      del anfitrión continúa requiriendo reconfirmación final.
--   3. resolver_actor_encuentro continúa exigiendo participante en estado = 'confirmado'.
--      Solicitantes pendientes o rechazados continúan denegados (unauthorized / participant_not_confirmed).
--   4. Bloqueos bilaterales (public.bloqueos_usuario) continúan denegando el acceso (blocked_user).
--   5. Sesiones anónimas migradas / retiradas continúan bloqueadas (is_retired_anonymous_source).
--   6. Ventanas de retención (30 días realizado / 7 días cancelado) y ventana de escritura
--      (48 horas post-inicio) permanecen estrictamente vigentes.
-- ==============================================================================

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
BEGIN
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    -- Guardia: Sesión anónima retirada por migración de dominio
    IF v_auth_uid IS NOT NULL THEN
        IF public.is_retired_anonymous_source(v_auth_uid) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
        END IF;
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

        -- DIF-17: Se permite la comunicación de mensajes a participantes confirmados
        -- sin exigir reconfirmación previa de asistencia. La privacidad física
        -- y virtual continúa protegida por get_participante_seguro.

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

        IF v_part.user_id IS NOT NULL THEN
            IF public.is_retired_anonymous_source(v_part.user_id) THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
            END IF;

            IF EXISTS (
                SELECT 1 FROM public.bloqueos_usuario
                WHERE (blocker_id = v_part.user_id AND blocked_id = v_encuentro.host_id)
                   OR (blocker_id = v_encuentro.host_id AND blocked_id = v_part.user_id)
            ) THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
            END IF;
        END IF;

        -- DIF-17: Se permite la comunicación de mensajes a participantes con token confirmado.

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

    -- Encuentro cancelado: solo lectura durante ventana de retención (7 días)
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

REVOKE ALL ON FUNCTION public.resolver_actor_encuentro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_actor_encuentro(uuid, uuid) TO anon, authenticated, service_role;
