-- ==============================================================================
-- Migración: Panel de Información y Mensajes del Encuentro V1
-- Timestamp: 20261020100000
-- Afecta: public.mensajes_encuentro, public.participante_rate_limit_buckets,
--         public.rate_limit_policies, RPCs de mensajería segura
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. TABLA: public.mensajes_encuentro
-- Almacena los mensajes de comunicación práctica de cada encuentro.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.mensajes_encuentro (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES public.mensajes_encuentro(id) ON DELETE CASCADE,
    autor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    autor_participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
    autor_nombre TEXT NOT NULL,
    es_organizador BOOLEAN NOT NULL DEFAULT false,
    contenido TEXT NOT NULL CONSTRAINT check_mensaje_contenido_len CHECK (
        pg_catalog.char_length(pg_catalog.btrim(contenido)) > 0 AND 
        pg_catalog.char_length(contenido) <= 500
    ),
    destacado BOOLEAN NOT NULL DEFAULT false,
    destacado_en TIMESTAMPTZ,
    destacado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    editado_en TIMESTAMPTZ,
    eliminado_en TIMESTAMPTZ,
    eliminado_por_tipo TEXT CONSTRAINT check_mensaje_eliminado_tipo CHECK (
        eliminado_por_tipo IS NULL OR eliminado_por_tipo IN ('autor', 'organizador')
    ),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Índices de consulta de alto rendimiento
CREATE INDEX IF NOT EXISTS idx_mensajes_encuentro_timeline
    ON public.mensajes_encuentro (encuentro_id, creado_en ASC);

CREATE INDEX IF NOT EXISTS idx_mensajes_encuentro_parent
    ON public.mensajes_encuentro (parent_id)
    WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mensajes_encuentro_destacados
    ON public.mensajes_encuentro (encuentro_id, destacado)
    WHERE destacado = true AND eliminado_en IS NULL;

-- RLS: Cerrada por defecto para clientes. Acceso exclusivo por RPCs SECURITY DEFINER.
ALTER TABLE public.mensajes_encuentro ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mensajes_encuentro FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.mensajes_encuentro TO service_role;

-- ==============================================================================
-- 2. TABLA: public.participante_rate_limit_buckets
-- Infraestructura duradera para rate limiting atómico de invitados sin sesión Supabase.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.participante_rate_limit_buckets (
    action TEXT NOT NULL REFERENCES public.rate_limit_policies(action) ON DELETE CASCADE,
    participante_id UUID NOT NULL REFERENCES public.participantes(id) ON DELETE CASCADE,
    scope_key TEXT NOT NULL DEFAULT '',
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    PRIMARY KEY (action, participante_id, scope_key, window_start),
    CONSTRAINT check_part_rate_limit_scope_key_len CHECK (pg_catalog.char_length(scope_key) <= 128)
);

CREATE INDEX IF NOT EXISTS idx_part_rate_limit_buckets_lookup
    ON public.participante_rate_limit_buckets (participante_id, window_start);

ALTER TABLE public.participante_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.participante_rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.participante_rate_limit_buckets TO service_role;

-- ==============================================================================
-- 3. POLÍTICA DE RATE LIMITING DURABLE
-- 10 mensajes cada 5 minutos (300 segundos)
-- ==============================================================================
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES ('publicar_mensaje_encuentro', 10, 300, true)
ON CONFLICT (action) DO UPDATE
SET max_requests = 10,
    window_seconds = 300,
    enabled = true,
    updated_at = pg_catalog.now();

-- ==============================================================================
-- 4. HELPER INTERNO: consumir_rate_limit_participante
-- Incremento atómico en ventana discreta para invitados identificados por participante_id.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.consumir_rate_limit_participante(
    p_participante_id UUID,
    p_action TEXT,
    p_scope_key TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_policy RECORD;
    v_window_start TIMESTAMPTZ;
    v_scope_key TEXT := COALESCE(p_scope_key, '');
    v_new_count INTEGER;
BEGIN
    IF p_participante_id IS NULL OR p_action IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'invalid_parameters');
    END IF;

    SELECT max_requests, window_seconds, enabled
    INTO v_policy
    FROM public.rate_limit_policies
    WHERE action = p_action;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'rate_limit_policy_not_found');
    END IF;

    IF v_policy.enabled = false THEN
        RETURN pg_catalog.jsonb_build_object('allowed', true, 'disabled', true);
    END IF;

    v_window_start := pg_catalog.to_timestamp(
        pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now()) / v_policy.window_seconds) * v_policy.window_seconds
    );

    -- Incremento atómico
    INSERT INTO public.participante_rate_limit_buckets (
        action,
        participante_id,
        scope_key,
        window_start,
        request_count,
        updated_at
    )
    VALUES (
        p_action,
        p_participante_id,
        v_scope_key,
        v_window_start,
        1,
        pg_catalog.now()
    )
    ON CONFLICT (action, participante_id, scope_key, window_start)
    DO UPDATE SET
        request_count = public.participante_rate_limit_buckets.request_count + 1,
        updated_at = pg_catalog.now()
    WHERE public.participante_rate_limit_buckets.request_count < v_policy.max_requests
    RETURNING request_count INTO v_new_count;

    IF v_new_count IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'allowed', false,
            'error', 'rate_limit_exceeded',
            'action', p_action
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'allowed', true,
        'remaining', v_policy.max_requests - v_new_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.consumir_rate_limit_participante(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumir_rate_limit_participante(UUID, TEXT, TEXT) TO postgres, service_role;

-- ==============================================================================
-- 5. HELPER INTERNO: resolver_actor_encuentro
-- Resuelve identidad, tipo de actor y autorizaciones de lectura/escritura fail-closed.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.resolver_actor_encuentro(
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
    v_part RECORD;
    v_is_host BOOLEAN := false;
    v_actor_type TEXT := NULL;
    v_user_id UUID := NULL;
    v_participante_id UUID := NULL;
    v_autor_nombre TEXT := NULL;
    v_can_write BOOLEAN := false;
    v_inicio_local TIMESTAMPTZ;
    v_limite_escritura TIMESTAMPTZ;
    v_ahora_local TIMESTAMPTZ;
BEGIN
    -- 1. Validar existencia del encuentro
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    SELECT id, host_id, titulo, estado, fecha, hora, date_mode
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_not_found');
    END IF;

    -- 2. Regla de activación: Coordinación de fechas
    -- Si está en modo coordinación y no tiene fecha/hora definitiva elegida, panel bloqueado
    IF v_encuentro.date_mode = 'coordination' AND (v_encuentro.fecha IS NULL OR v_encuentro.hora IS NULL) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'coordination_not_closed');
    END IF;

    -- Debe existir fecha y hora válidas para habilitar el panel
    IF v_encuentro.fecha IS NULL OR v_encuentro.hora IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'missing_schedule');
    END IF;

    -- 3. Calcular ventana temporal de escritura canónica (Hora de Argentina)
    v_inicio_local := (v_encuentro.fecha::date + v_encuentro.hora::time);
    v_limite_escritura := v_inicio_local + interval '24 hours';
    v_ahora_local := pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires';

    -- Se permite escribir antes, durante y hasta 24 hs después de la hora de inicio,
    -- siempre que el encuentro no esté cancelado.
    IF v_ahora_local <= v_limite_escritura AND v_encuentro.estado <> 'cancelado' THEN
        v_can_write := true;
    ELSE
        v_can_write := false;
    END IF;

    -- 4. Determinar si el actor es el Organizador (permanente o anónimo)
    IF v_auth_uid IS NOT NULL AND v_auth_uid = v_encuentro.host_id THEN
        v_is_host := true;
        v_user_id := v_auth_uid;
        v_autor_nombre := 'Organizador';
        
        -- Intentar resolver nombre visible de metadata
        BEGIN
            v_autor_nombre := COALESCE(
                NULLIF(pg_catalog.current_setting('request.jwt.claim.user_metadata', true)::jsonb->>'full_name', ''),
                NULLIF(pg_catalog.current_setting('request.jwt.claim.user_metadata', true)::jsonb->>'name', ''),
                'Organizador'
            );
        EXCEPTION WHEN OTHERS THEN
            v_autor_nombre := 'Organizador';
        END;

        IF pg_catalog.current_setting('request.jwt.claim.is_anonymous', true) = 'true' THEN
            v_actor_type := 'host_anon';
        ELSE
            v_actor_type := 'host_permanent';
        END IF;

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'actor_type', v_actor_type,
            'is_host', true,
            'user_id', v_user_id,
            'participante_id', NULL,
            'autor_nombre', v_autor_nombre,
            'can_write', v_can_write,
            'encuentro_estado', v_encuentro.estado,
            'writing_window_closed', (v_ahora_local > v_limite_escritura)
        );
    END IF;

    -- 5. Regla de cancelación para participantes
    -- Si el encuentro está cancelado, los participantes no pueden acceder ni al historial
    -- para proteger la logística y privacidad tras la cancelación.
    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_cancelled');
    END IF;

    -- 6. Participante con sesión Supabase (permanente o anónima registrada en participantes)
    IF v_auth_uid IS NOT NULL THEN
        -- Verificar bloqueo bilateral entre este usuario y el host
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_auth_uid AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_auth_uid)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        SELECT id, nombre_invitado, estado, user_id, token_invitacion
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_auth_uid
        ORDER BY (estado = 'confirmado') DESC, creado_en DESC
        LIMIT 1;

        IF FOUND THEN
            IF v_part.estado <> 'confirmado' THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
            END IF;

            RETURN pg_catalog.jsonb_build_object(
                'ok', true,
                'actor_type', 'participant_registered',
                'is_host', false,
                'user_id', v_auth_uid,
                'participante_id', v_part.id,
                'autor_nombre', v_part.nombre_invitado,
                'can_write', v_can_write,
                'encuentro_estado', v_encuentro.estado,
                'writing_window_closed', (v_ahora_local > v_limite_escritura)
            );
        END IF;
    END IF;

    -- 7. Invitado individual mediante token_invitacion
    IF p_token_invitacion IS NOT NULL THEN
        SELECT id, nombre_invitado, estado, user_id, token_invitacion
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND token_invitacion = p_token_invitacion;

        IF FOUND THEN
            -- Si el participante está vinculado a un user_id, verificar bloqueo bilateral con el host
            IF v_part.user_id IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1 FROM public.bloqueos_usuario
                    WHERE (blocker_id = v_part.user_id AND blocked_id = v_encuentro.host_id)
                       OR (blocker_id = v_encuentro.host_id AND blocked_id = v_part.user_id)
                ) THEN
                    RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
                END IF;
            END IF;

            IF v_part.estado <> 'confirmado' THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
            END IF;

            RETURN pg_catalog.jsonb_build_object(
                'ok', true,
                'actor_type', 'participant_guest',
                'is_host', false,
                'user_id', v_part.user_id,
                'participante_id', v_part.id,
                'autor_nombre', v_part.nombre_invitado,
                'can_write', v_can_write,
                'encuentro_estado', v_encuentro.estado,
                'writing_window_closed', (v_ahora_local > v_limite_escritura)
            );
        END IF;
    END IF;

    -- 8. Fail-closed: Sin autorización válida
    RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_actor_encuentro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_actor_encuentro(UUID, UUID) TO postgres, service_role;

-- ==============================================================================
-- 6. RPC: get_mensajes_encuentro_seguro
-- Lectura cronológica paginada, destacados y control de capacidades.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.get_mensajes_encuentro_seguro(
    p_encuentro_id UUID,
    p_token_invitacion UUID DEFAULT NULL,
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0
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
    v_can_write BOOLEAN;
    v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
    v_offset INT := GREATEST(COALESCE(p_offset, 0), 0);
    v_mensajes JSONB;
    v_destacados JSONB;
    v_total INTEGER;
    v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
    v_actor := public.resolver_actor_encuentro(p_encuentro_id, p_token_invitacion);

    IF (v_actor->>'ok')::boolean IS NOT true THEN
        RETURN v_actor;
    END IF;

    v_is_host := (v_actor->>'is_host')::boolean;
    v_user_id := (v_actor->>'user_id')::uuid;
    v_part_id := (v_actor->>'participante_id')::uuid;
    v_can_write := (v_actor->>'can_write')::boolean;

    -- Conteo total de mensajes visibles
    SELECT pg_catalog.count(*)
    INTO v_total
    FROM public.mensajes_encuentro m
    WHERE m.encuentro_id = p_encuentro_id;

    -- Mensajes destacados activos (máximo 3)
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', d.id,
                'parent_id', d.parent_id,
                'autor_nombre', d.autor_nombre,
                'es_organizador', d.es_organizador,
                'contenido', d.contenido,
                'destacado', true,
                'destacado_en', d.destacado_en,
                'creado_en', d.creado_en,
                'editado_en', d.editado_en,
                'es_propio', (
                    (d.es_organizador AND v_is_host) OR
                    (v_user_id IS NOT NULL AND d.autor_user_id = v_user_id) OR
                    (v_part_id IS NOT NULL AND d.autor_participante_id = v_part_id)
                )
            )
            ORDER BY d.destacado_en DESC, d.creado_en DESC
        ),
        '[]'::jsonb
    )
    INTO v_destacados
    FROM (
        SELECT * FROM public.mensajes_encuentro
        WHERE encuentro_id = p_encuentro_id
          AND destacado = true
          AND eliminado_en IS NULL
        LIMIT 3
    ) d;

    -- Lista paginada cronológica
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', m.id,
                'parent_id', m.parent_id,
                'autor_nombre', m.autor_nombre,
                'es_organizador', m.es_organizador,
                'contenido', (
                    CASE 
                        WHEN m.eliminado_en IS NOT NULL THEN ''
                        ELSE m.contenido 
                    END
                ),
                'destacado', m.destacado,
                'destacado_en', m.destacado_en,
                'creado_en', m.creado_en,
                'editado_en', m.editado_en,
                'eliminado', (m.eliminado_en IS NOT NULL),
                'eliminado_por_tipo', m.eliminado_por_tipo,
                'es_propio', (
                    (m.es_organizador AND v_is_host) OR
                    (v_user_id IS NOT NULL AND m.autor_user_id = v_user_id) OR
                    (v_part_id IS NOT NULL AND m.autor_participante_id = v_part_id)
                ),
                'puede_editar', (
                    m.eliminado_en IS NULL AND
                    v_can_write AND
                    (v_now - m.creado_en <= interval '15 minutes') AND
                    -- Si está destacado por el organizador, solo el organizador puede editarlo
                    (m.destacado = false OR v_is_host) AND
                    (
                        (m.es_organizador AND v_is_host) OR
                        (v_user_id IS NOT NULL AND m.autor_user_id = v_user_id) OR
                        (v_part_id IS NOT NULL AND m.autor_participante_id = v_part_id)
                    )
                ),
                'puede_eliminar', (
                    m.eliminado_en IS NULL AND
                    (
                        v_is_host OR
                        (
                            v_can_write AND
                            (
                                (v_user_id IS NOT NULL AND m.autor_user_id = v_user_id) OR
                                (v_part_id IS NOT NULL AND m.autor_participante_id = v_part_id)
                            )
                        )
                    )
                )
            )
            ORDER BY m.creado_en ASC
        ),
        '[]'::jsonb
    )
    INTO v_mensajes
    FROM (
        SELECT * FROM public.mensajes_encuentro
        WHERE encuentro_id = p_encuentro_id
        ORDER BY creado_en ASC
        LIMIT v_limit
        OFFSET v_offset
    ) m;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'is_host', v_is_host,
        'can_write', v_can_write,
        'writing_window_closed', (v_actor->>'writing_window_closed')::boolean,
        'destacados', v_destacados,
        'mensajes', v_mensajes,
        'total_count', v_total,
        'has_more', ((v_offset + v_limit) < v_total)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_mensajes_encuentro_seguro(UUID, UUID, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mensajes_encuentro_seguro(UUID, UUID, INT, INT) TO anon, authenticated, service_role;

-- ==============================================================================
-- 7. RPC: publicar_mensaje_encuentro_seguro
-- Publicación de mensajes con rate limiting y verificación de anidamiento máximo 1.
-- ==============================================================================
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

        -- Regla estricta: No permitir respuestas a una respuesta (máximo 1 nivel)
        IF v_parent.parent_id IS NOT NULL THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'nested_reply_depth_exceeded');
        END IF;
    END IF;

    -- 4. Rate Limiting Multi-Vía Atómico
    -- Vía A: Si el actor tiene user_id, evaluar y consumir rate limit canónico de sesión
    IF v_user_id IS NOT NULL THEN
        -- Si auth.uid() está activo, consume via check_rate_limit_internal
        IF auth.uid() IS NOT NULL THEN
            v_rate_res := public.check_rate_limit_internal('publicar_mensaje_encuentro', p_encuentro_id::text);
            IF v_rate_res IS NULL OR (v_rate_res->>'allowed')::boolean IS NOT true THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limited');
            END IF;
        END IF;
    END IF;

    -- Vía B: Si el actor es participante (con o sin sesión), consumir su bucket de participante
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

-- ==============================================================================
-- 8. RPC: editar_mensaje_encuentro_seguro
-- Edición de mensajes propios durante los primeros 15 minutos.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.editar_mensaje_encuentro_seguro(
    p_mensaje_id UUID,
    p_contenido TEXT,
    p_token_invitacion UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_mensaje RECORD;
    v_actor JSONB;
    v_is_host BOOLEAN;
    v_user_id UUID;
    v_part_id UUID;
    v_can_write BOOLEAN;
    v_clean_contenido TEXT;
    v_is_owner BOOLEAN := false;
BEGIN
    v_clean_contenido := pg_catalog.btrim(COALESCE(p_contenido, ''));
    IF pg_catalog.char_length(v_clean_contenido) = 0 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'empty_content');
    END IF;

    IF pg_catalog.char_length(v_clean_contenido) > 500 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'content_too_long');
    END IF;

    SELECT id, encuentro_id, autor_user_id, autor_participante_id, es_organizador,
           destacado, creado_en, eliminado_en
    INTO v_mensaje
    FROM public.mensajes_encuentro
    WHERE id = p_mensaje_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'message_not_found');
    END IF;

    IF v_mensaje.eliminado_en IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_edit_deleted_message');
    END IF;

    v_actor := public.resolver_actor_encuentro(v_mensaje.encuentro_id, p_token_invitacion);
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

    -- Validar autoría
    IF v_mensaje.es_organizador AND v_is_host THEN
        v_is_owner := true;
    ELSIF v_user_id IS NOT NULL AND v_mensaje.autor_user_id = v_user_id THEN
        v_is_owner := true;
    ELSIF v_part_id IS NOT NULL AND v_mensaje.autor_participante_id = v_part_id THEN
        v_is_owner := true;
    END IF;

    IF NOT v_is_owner THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized_edit');
    END IF;

    -- Ventana de 15 minutos desde creado_en
    IF pg_catalog.now() - v_mensaje.creado_en > interval '15 minutes' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'edit_window_expired');
    END IF;

    -- Evitar que una edición altere silenciosamente información destacada por el organizador
    IF v_mensaje.destacado = true AND NOT v_is_host THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_edit_highlighted_message');
    END IF;

    UPDATE public.mensajes_encuentro
    SET contenido = v_clean_contenido,
        editado_en = pg_catalog.now()
    WHERE id = p_mensaje_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'mensaje_id', p_mensaje_id);
END;
$$;

REVOKE ALL ON FUNCTION public.editar_mensaje_encuentro_seguro(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.editar_mensaje_encuentro_seguro(UUID, TEXT, UUID) TO anon, authenticated, service_role;

-- ==============================================================================
-- 9. RPC: eliminar_mensaje_encuentro_seguro
-- Borrado lógico por el autor o moderación por el organizador.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.eliminar_mensaje_encuentro_seguro(
    p_mensaje_id UUID,
    p_token_invitacion UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_mensaje RECORD;
    v_actor JSONB;
    v_is_host BOOLEAN;
    v_user_id UUID;
    v_part_id UUID;
    v_can_write BOOLEAN;
    v_tipo_eliminacion TEXT := NULL;
BEGIN
    SELECT id, encuentro_id, autor_user_id, autor_participante_id, es_organizador, eliminado_en
    INTO v_mensaje
    FROM public.mensajes_encuentro
    WHERE id = p_mensaje_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'message_not_found');
    END IF;

    IF v_mensaje.eliminado_en IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'already_deleted', true);
    END IF;

    v_actor := public.resolver_actor_encuentro(v_mensaje.encuentro_id, p_token_invitacion);
    IF (v_actor->>'ok')::boolean IS NOT true THEN
        RETURN v_actor;
    END IF;

    v_is_host := (v_actor->>'is_host')::boolean;
    v_user_id := (v_actor->>'user_id')::uuid;
    v_part_id := (v_actor->>'participante_id')::uuid;
    v_can_write := (v_actor->>'can_write')::boolean;

    -- Moderación por el organizador (incluso fuera de la ventana de escritura del encuentro)
    IF v_is_host THEN
        v_tipo_eliminacion := 'organizador';
    -- Eliminación de mensaje propio por el autor (requiere ventana activa de escritura)
    ELSIF v_can_write AND (
        (v_user_id IS NOT NULL AND v_mensaje.autor_user_id = v_user_id) OR
        (v_part_id IS NOT NULL AND v_mensaje.autor_participante_id = v_part_id)
    ) THEN
        v_tipo_eliminacion := 'autor';
    ELSE
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized_delete');
    END IF;

    UPDATE public.mensajes_encuentro
    SET eliminado_en = pg_catalog.now(),
        eliminado_por_tipo = v_tipo_eliminacion,
        destacado = false,
        destacado_en = NULL,
        destacado_por = NULL
    WHERE id = p_mensaje_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'mensaje_id', p_mensaje_id,
        'tipo', v_tipo_eliminacion
    );
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_mensaje_encuentro_seguro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_mensaje_encuentro_seguro(UUID, UUID) TO anon, authenticated, service_role;

-- ==============================================================================
-- 10. RPC: destacar_mensaje_encuentro_seguro
-- Destacado de mensajes por el organizador (hasta 3 simultáneos bajo concurrencia).
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.destacar_mensaje_encuentro_seguro(
    p_mensaje_id UUID,
    p_destacado BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_mensaje RECORD;
    v_encuentro RECORD;
    v_auth_uid UUID := auth.uid();
    v_count_destacados INTEGER;
    v_part RECORD;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    SELECT id, encuentro_id, contenido, eliminado_en, destacado
    INTO v_mensaje
    FROM public.mensajes_encuentro
    WHERE id = p_mensaje_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'message_not_found');
    END IF;

    IF v_mensaje.eliminado_en IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_highlight_deleted_message');
    END IF;

    SELECT id, host_id, titulo, estado
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_mensaje.encuentro_id;

    IF NOT FOUND OR v_encuentro.host_id <> v_auth_uid THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF p_destacado = true THEN
        -- Bloqueo pesimista para concurrencia sobre los destacados del encuentro
        PERFORM 1
        FROM public.mensajes_encuentro
        WHERE encuentro_id = v_encuentro.id
          AND destacado = true
          AND eliminado_en IS NULL
        FOR UPDATE;

        SELECT pg_catalog.count(*)
        INTO v_count_destacados
        FROM public.mensajes_encuentro
        WHERE encuentro_id = v_encuentro.id
          AND destacado = true
          AND eliminado_en IS NULL
          AND id <> p_mensaje_id;

        IF v_count_destacados >= 3 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'max_highlights_reached');
        END IF;

        UPDATE public.mensajes_encuentro
        SET destacado = true,
            destacado_en = pg_catalog.now(),
            destacado_por = v_auth_uid
        WHERE id = p_mensaje_id;

        -- Notificaciones: Crear notificación en Inbox para participantes registrados confirmados
        -- No incluye direcciones ni enlaces privados en el payload de notificación
        FOR v_part IN
            SELECT DISTINCT user_id
            FROM public.participantes
            WHERE encuentro_id = v_encuentro.id
              AND user_id IS NOT NULL
              AND user_id <> v_auth_uid
              AND estado = 'confirmado'
        LOOP
            INSERT INTO public.inbox_notifications (
                recipient_user_id,
                notification_type,
                target_type,
                target_id,
                deep_link,
                title,
                body,
                payload,
                dedup_key,
                expires_at
            )
            VALUES (
                v_part.user_id,
                'encounter_message_highlighted',
                'encuentro',
                v_encuentro.id,
                '/meet/' || v_encuentro.id::text,
                'Mensaje destacado en ' || v_encuentro.titulo,
                'El organizador destacó un mensaje importante en el encuentro.',
                pg_catalog.jsonb_build_object(
                    'encuentro_id', v_encuentro.id,
                    'mensaje_id', p_mensaje_id
                ),
                'highlight_msg_' || p_mensaje_id::text || '_' || v_part.user_id::text,
                pg_catalog.now() + interval '7 days'
            )
            ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;
        END LOOP;

    ELSE
        UPDATE public.mensajes_encuentro
        SET destacado = false,
            destacado_en = NULL,
            destacado_por = NULL
        WHERE id = p_mensaje_id;
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'destacado', p_destacado);
END;
$$;

REVOKE ALL ON FUNCTION public.destacar_mensaje_encuentro_seguro(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.destacar_mensaje_encuentro_seguro(UUID, BOOLEAN) TO authenticated, service_role;

COMMIT;
