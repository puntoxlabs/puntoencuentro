-- ============================================================
-- Migración: 20260930163000_fase_20c1_trust_enforce_bilateral_blocking.sql
-- Módulo: Fase 2.0-C1 Seguridad y Confianza — T3-A2
-- Enforcement bilateral de bloqueos en Discovery e Interacciones
-- ============================================================

BEGIN;

-- ============================================================
-- 1. get_discovery_encuentros_abiertos
-- Excluye encuentros de hosts con bloqueo bilateral hacia/desde el viewer autenticado.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_discovery_encuentros_abiertos(
    p_locality_ids TEXT[] DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_viewer_id UUID := auth.uid();
    v_result JSON;
BEGIN
    SELECT json_agg(enc_row) INTO v_result
    FROM (
        SELECT
            e.id,
            e.titulo AS title,
            CASE
                WHEN e.tema_invitacion = 'sports' THEN '🎾'
                WHEN e.tema_invitacion = 'friends' THEN '🍻'
                WHEN e.tema_invitacion = 'celebration' THEN '🎉'
                WHEN e.tema_invitacion = 'family' THEN '👨‍👩‍👦'
                WHEN e.tema_invitacion = 'learning' THEN '📚'
                WHEN e.tema_invitacion = 'wellness' THEN '🧘'
                WHEN e.tema_invitacion = 'romantic' THEN '🍷'
                ELSE '✨'
            END AS emoji,
            COALESCE(e.tema_invitacion, 'social') AS activity_type,
            CASE
                WHEN e.fecha IS NOT NULL AND e.hora IS NOT NULL THEN
                    to_char(e.fecha, 'YYYY-MM-DD') || 'T' || to_char(e.hora, 'HH24:MI:SS')
                ELSE
                    to_char(e.creado_en, 'YYYY-MM-DD"T"HH24:MI:SS')
            END AS starts_at,
            CASE
                WHEN e.fecha IS NOT NULL AND e.hora IS NOT NULL THEN
                    to_char(e.fecha, 'DD/MM') || ' · ' || to_char(e.hora, 'HH24:MI') || ' hs'
                WHEN e.date_mode = 'coordination' THEN
                    'Fecha por coordinar'
                ELSE
                    'A convenir'
            END AS date_label,
            COALESCE(e.open_public_zone, l.nombre, 'Zona aproximada') AS approximate_zone,
            e.locality_id,
            GREATEST(0, e.max_participants - (1 + COALESCE(part_counts.confirmed, 0))) AS open_slots,
            (1 + COALESCE(part_counts.confirmed, 0)) AS confirmed_count,
            'es' AS language,
            e.open_description AS description,
            COALESCE(e.opened_at, e.creado_en) AS opened_at
        FROM public.encuentros e
        JOIN public.localidades l ON e.locality_id = l.id
        LEFT JOIN (
            SELECT encuentro_id, COUNT(*) AS confirmed
            FROM public.participantes
            WHERE estado = 'confirmado'
            GROUP BY encuentro_id
        ) part_counts ON part_counts.encuentro_id = e.id
        WHERE e.is_open = true
          AND e.estado = 'activo'
          -- Filtrar si venció
          AND (
              e.fecha IS NULL
              OR e.hora IS NULL
              OR (e.fecha + e.hora) >= (CURRENT_DATE - INTERVAL '1 day')
          )
          -- Filtrar por localidades si se proveyeron
          AND (
              p_locality_ids IS NULL
              OR array_length(p_locality_ids, 1) IS NULL
              OR e.locality_id = ANY(p_locality_ids)
          )
          -- Filtrar bloqueos bilaterales si el viewer está autenticado
          AND (
              v_viewer_id IS NULL
              OR NOT EXISTS (
                  SELECT 1 FROM public.bloqueos_usuario b
                  WHERE (b.blocker_id = v_viewer_id AND b.blocked_id = e.host_id)
                     OR (b.blocker_id = e.host_id AND b.blocked_id = v_viewer_id)
              )
          )
        ORDER BY e.opened_at DESC, e.creado_en DESC
    ) enc_row;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) TO anon, authenticated;

-- ============================================================
-- 2. get_discovery_intenciones_activas
-- Excluye intenciones de autores con bloqueo bilateral hacia/desde el viewer autenticado.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_discovery_intenciones_activas(
    p_locality_ids TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_viewer_id UUID := auth.uid();
    v_is_anon BOOLEAN := (v_viewer_id IS NULL) OR COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_result JSONB;
BEGIN
    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', i.id,
            'titulo', i.titulo,
            'descripcion', i.descripcion,
            'temporalidad_texto', i.temporalidad_texto,
            'fecha_desde', i.fecha_desde,
            'fecha_hasta', i.fecha_hasta,
            'modalidad', i.modalidad,
            'locality_id', i.locality_id,
            'approximate_zone', COALESCE(l.nombre, 'Zona aproximada'),
            'interested_count', COALESCE((
                SELECT pg_catalog.count(*)::int
                FROM public.intencion_intereses ii
                WHERE ii.intencion_id = i.id
            ), 0),
            'created_at', i.created_at,
            'is_own', CASE WHEN v_is_anon THEN false ELSE (i.user_id = v_viewer_id) END,
            'viewer_interested', CASE WHEN v_is_anon THEN false ELSE EXISTS(
                SELECT 1
                FROM public.intencion_intereses ii
                WHERE ii.intencion_id = i.id AND ii.user_id = v_viewer_id
            ) END
        ) ORDER BY i.created_at DESC
    ), '[]'::jsonb)
    INTO v_result
    FROM public.intenciones i
    LEFT JOIN public.localidades l ON l.id = i.locality_id
    WHERE i.estado = 'activa'
      AND (
          i.fecha_hasta IS NULL
          OR i.fecha_hasta >= (pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      )
      AND (
          p_locality_ids IS NULL
          OR pg_catalog.array_length(p_locality_ids, 1) IS NULL
          OR i.modalidad = 'virtual'
          OR i.locality_id = ANY(p_locality_ids)
      )
      -- Filtrar bloqueos bilaterales si el viewer está autenticado
      AND (
          v_viewer_id IS NULL
          OR NOT EXISTS (
              SELECT 1 FROM public.bloqueos_usuario b
              WHERE (b.blocker_id = v_viewer_id AND b.blocked_id = i.user_id)
                 OR (b.blocker_id = i.user_id AND b.blocked_id = v_viewer_id)
          )
      );

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) TO anon, authenticated;

-- ============================================================
-- 3. solicitar_sumarse_encuentro_abierto
-- Rechaza fail-closed si existe bloqueo bilateral entre solicitante y host.
-- Error genérico y silencioso: 'encuentro_not_open'.
-- ============================================================
CREATE OR REPLACE FUNCTION public.solicitar_sumarse_encuentro_abierto(
    p_encuentro_id UUID,
    p_nombre TEXT,
    p_mensaje TEXT DEFAULT NULL,
    p_usuario_id UUID DEFAULT NULL  -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_solicitud_id UUID;
    v_clean_nombre TEXT;
BEGIN
    -- SEGURIDAD: identidad obligatoria y permanente
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- Nota: p_usuario_id no se usa bajo ninguna circunstancia para identificación.

    v_clean_nombre := trim(COALESCE(p_nombre, ''));
    IF length(v_clean_nombre) < 2 THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_name');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    IF v_encuentro.is_open <> true THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_open');
    END IF;

    -- Validar que no sea el host
    IF v_encuentro.host_id = v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'cannot_join_own_encounter');
    END IF;

    -- ENFORCEMENT DE BLOQUEO BILATERAL (Fail-closed silencioso)
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_encuentro.host_id)
           OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_open');
    END IF;

    -- Validar que no tenga ya una solicitud pendiente
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado = 'pending'
    ) THEN
        RETURN json_build_object('ok', false, 'error', 'duplicate_pending_request');
    END IF;

    -- Validar que no sea ya un participante confirmado (por usuario_id en solicitudes aprobadas)
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado = 'approved'
    ) THEN
        RETURN json_build_object('ok', false, 'error', 'already_participant');
    END IF;

    -- Validar cupo disponible
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado = 'confirmado';

    IF (v_confirmed_count + 1) >= v_encuentro.max_participants THEN
        RETURN json_build_object('ok', false, 'error', 'encounter_full');
    END IF;

    -- Insertar solicitud
    INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id,
        usuario_id,
        nombre_solicitante,
        mensaje,
        estado
    ) VALUES (
        p_encuentro_id,
        v_user_id,
        v_clean_nombre,
        NULLIF(trim(p_mensaje), ''),
        'pending'
    ) RETURNING id INTO v_solicitud_id;

    RETURN json_build_object(
        'ok', true,
        'request_id', v_solicitud_id,
        'estado', 'pending'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID)
    TO authenticated;

-- ============================================================
-- 4. aprobar_solicitud_encuentro_abierto
-- Defensa en profundidad: rechaza aprobación si surgió un bloqueo bilateral concurrente.
-- Error genérico: 'request_not_available'.
-- Preserva asignación de user_id al participante aprobado (de T2-B2-P).
-- ============================================================
CREATE OR REPLACE FUNCTION public.aprobar_solicitud_encuentro_abierto(
    p_request_id UUID,
    p_host_id UUID DEFAULT NULL  -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_participante_id UUID;
    v_token_invitacion UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 1. Bloquear y verificar la solicitud
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    IF v_solicitud.estado <> 'pending' THEN
        RETURN json_build_object('ok', false, 'error', 'request_already_processed');
    END IF;

    -- 2. Bloquear y verificar el encuentro
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_solicitud.encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_active');
    END IF;

    -- GUARD CONCURRENTE DE BLOQUEO BILATERAL (Defensa en profundidad)
    IF EXISTS (
        SELECT 1 FROM public.bloqueos_usuario b
        WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_solicitud.usuario_id)
           OR (b.blocker_id = v_solicitud.usuario_id AND b.blocked_id = v_user_id)
    ) THEN
        RETURN json_build_object('ok', false, 'error', 'request_not_available');
    END IF;

    -- 3. Validar cupo real bajo bloqueo
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id AND estado = 'confirmado';

    IF (v_confirmed_count + 1) >= v_encuentro.max_participants THEN
        RETURN json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    -- 4. Crear participante regular asignando user_id del solicitante
    v_token_invitacion := gen_random_uuid();
    v_participante_id := gen_random_uuid();

    INSERT INTO public.participantes (
        id,
        encuentro_id,
        nombre_invitado,
        tipo_invitacion,
        estado,
        token_invitacion,
        mensaje_respuesta,
        user_id
    ) VALUES (
        v_participante_id,
        v_encuentro.id,
        v_solicitud.nombre_solicitante,
        'individual',
        'confirmado',
        v_token_invitacion,
        v_solicitud.mensaje,
        v_solicitud.usuario_id
    );

    -- 5. Actualizar solicitud a approved
    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'approved',
        participante_id = v_participante_id,
        token_participante = v_token_invitacion,
        resolved_at = now(),
        updated_at = now()
    WHERE id = p_request_id;

    RETURN json_build_object(
        'ok', true,
        'request_id', p_request_id,
        'participante_id', v_participante_id,
        'token_invitacion', v_token_invitacion,
        'nuevo_cupo_disponible', GREATEST(0, v_encuentro.max_participants - (v_confirmed_count + 2))
    );
END;
$$;

REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID)
    TO authenticated;

-- ============================================================
-- 5. set_interes_intencion
-- Rechaza fail-closed al marcar interés (p_interesado = true) si existe bloqueo bilateral.
-- Error genérico y silencioso: 'intention_not_found_or_inactive'.
-- Desmarcar interés (p_interesado = false) permanece idempotente sin filtrar por bloqueo.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_interes_intencion(
    p_intencion_id UUID,
    p_interesado BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_intencion RECORD;
    v_count INT;
BEGIN
    -- 1. Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- 2. Rechazar cuentas anónimas (se requiere cuenta permanente para interactuar socialmente)
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 3. Validar parámetros requeridos
    IF p_intencion_id IS NULL OR p_interesado IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    -- 4. Verificar intención objetivo (existencia, estado y vigencia temporal según Argentina)
    SELECT id, user_id, estado, fecha_hasta
    INTO v_intencion
    FROM public.intenciones
    WHERE id = p_intencion_id;

    IF NOT FOUND 
       OR v_intencion.estado <> 'activa'
       OR NOT (
           v_intencion.fecha_hasta IS NULL 
           OR v_intencion.fecha_hasta >= (pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
       ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intention_not_found_or_inactive');
    END IF;

    -- 5. Interés propio: El autor no puede marcar interés en su propia intención
    IF v_intencion.user_id = v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_interest_own_intention');
    END IF;

    -- 6. Operación con enforcement de bloqueo bilateral
    IF p_interesado = true THEN
        -- ENFORCEMENT DE BLOQUEO BILATERAL (Fail-closed silencioso)
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario b
            WHERE (b.blocker_id = v_user_id AND b.blocked_id = v_intencion.user_id)
               OR (b.blocker_id = v_intencion.user_id AND b.blocked_id = v_user_id)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intention_not_found_or_inactive');
        END IF;

        INSERT INTO public.intencion_intereses (
            intencion_id,
            user_id
        )
        VALUES (
            p_intencion_id,
            v_user_id
        )
        ON CONFLICT (intencion_id, user_id)
        DO NOTHING;
    ELSE
        DELETE FROM public.intencion_intereses
        WHERE intencion_id = p_intencion_id
          AND user_id = v_user_id;
    END IF;

    -- 7. Calcular conteo final posterior a la operación
    SELECT COALESCE(pg_catalog.count(*)::int, 0)
    INTO v_count
    FROM public.intencion_intereses
    WHERE intencion_id = p_intencion_id;

    -- 8. Retorno estructurado
    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'interesado', p_interesado,
        'interested_count', v_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_interes_intencion(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_interes_intencion(UUID, BOOLEAN) TO authenticated;

COMMIT;
