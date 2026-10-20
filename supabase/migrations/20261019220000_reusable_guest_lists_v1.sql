-- ==============================================================================
-- Migración: 20261019220000_reusable_guest_lists_v1.sql
-- Módulo: Listas reutilizables de invitados V1
--
-- Diseño de datos, seguridad y privacidad:
--   * Tabla `public.listas_invitados_usuario` privada por propietario (`owner_id = auth.uid()`).
--   * Exclusivo para usuarios con cuenta permanente (`is_anonymous = false`).
--   * Destinatarios almacenados como arreglo de correos normalizados (`TEXT[]`),
--     independientes de `public.contactos_usuario`: editar o eliminar un contacto
--     no altera silenciosamente los destinatarios guardados en una lista.
--   * Límites V1 en servidor:
--       - Hasta 30 listas por usuario.
--       - Entre 1 y 50 destinatarios únicos normalizados por lista.
--       - Nombre de lista entre 1 y 80 caracteres.
--   * RLS estricta: solo SELECT para el propietario permanente; escrituras directas
--     desde cliente revocadas (`REVOKE ALL`).
--   * RPCs `SECURITY DEFINER` con `SET search_path = ''`, validación server-side,
--     rate limiting (`manage_guest_list`) y bloqueo transaccional por propietario
--     (`pg_advisory_xact_lock`) frente a solicitudes concurrentes.
--   * Sugerencias de grupos implícitos derivadas exclusivamente de
--     `public.solicitudes_invitacion_interna` enviadas por el propio organizador
--     (conjuntos de 2 o más destinatarios válidos por encuentro), excluyendo
--     invitados rechazados, cancelados y bloqueados, sin tocar participantes por
--     enlace ni Discovery, y sin revelar si un correo pertenece a una cuenta registrada.
--   * Guardar, editar o seleccionar una lista NUNCA envía invitaciones.
--
-- RPCs:
--   - guardar_lista_invitados_seguro
--   - renombrar_lista_invitados_seguro
--   - eliminar_lista_invitados_seguro
--   - listar_listas_invitados_seguro
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. TABLA: public.listas_invitados_usuario
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.listas_invitados_usuario (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    destinatarios_emails TEXT[] NOT NULL DEFAULT '{}'::text[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    CONSTRAINT chk_listas_invitados_usuario_nombre_len
        CHECK (pg_catalog.char_length(pg_catalog.btrim(nombre)) BETWEEN 1 AND 80),
    CONSTRAINT chk_listas_invitados_usuario_emails_bounds
        CHECK (pg_catalog.cardinality(destinatarios_emails) BETWEEN 1 AND 50)
);

-- Nombre único por propietario (insensible a mayúsculas y espacios extremos)
CREATE UNIQUE INDEX IF NOT EXISTS idx_listas_invitados_usuario_owner_nombre
    ON public.listas_invitados_usuario (owner_id, (pg_catalog.lower(pg_catalog.btrim(nombre))));

CREATE INDEX IF NOT EXISTS idx_listas_invitados_usuario_owner_updated
    ON public.listas_invitados_usuario (owner_id, updated_at DESC);

-- ==============================================================================
-- 2. RLS Y PRIVILEGIOS
-- ==============================================================================
ALTER TABLE public.listas_invitados_usuario ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.listas_invitados_usuario FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS listas_invitados_usuario_select_owner ON public.listas_invitados_usuario;
CREATE POLICY listas_invitados_usuario_select_owner
    ON public.listas_invitados_usuario
    FOR SELECT
    TO authenticated
    USING (
        owner_id = auth.uid()
        AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    );

GRANT SELECT ON TABLE public.listas_invitados_usuario TO authenticated;
GRANT ALL ON TABLE public.listas_invitados_usuario TO postgres, service_role;

-- ==============================================================================
-- 3. POLÍTICA DE RATE LIMIT DURABLE
-- ==============================================================================
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES ('manage_guest_list', 40, 3600, true)
ON CONFLICT (action) DO NOTHING;

-- ==============================================================================
-- 4. RPC: guardar_lista_invitados_seguro
--    Crea o edita una lista privada de invitados (nombre + destinatarios).
--    Normaliza y deduplica correos en servidor. No consulta auth.users ni
--    envía invitaciones.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.guardar_lista_invitados_seguro(
    p_nombre TEXT,
    p_emails TEXT[],
    p_lista_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_clean_nombre TEXT := pg_catalog.btrim(COALESCE(p_nombre, ''));
    v_raw_email TEXT;
    v_clean_email TEXT;
    v_clean_emails TEXT[] := '{}'::text[];
    v_at_pos INT;
    v_domain_part TEXT;
    v_count INT;
    v_rl JSONB;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_row public.listas_invitados_usuario%ROWTYPE;
BEGIN
    -- 1. Identidad y cuenta permanente
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    -- 2. Validación de nombre de lista (1..80 caracteres)
    IF pg_catalog.char_length(v_clean_nombre) < 1 OR pg_catalog.char_length(v_clean_nombre) > 80 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_list_name');
    END IF;

    -- 3. Validación, normalización y deduplicación de correos en servidor
    IF p_emails IS NULL OR pg_catalog.cardinality(p_emails) = 0 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_empty_recipients');
    END IF;

    IF pg_catalog.cardinality(p_emails) > 500 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_recipient_limit_reached');
    END IF;

    FOREACH v_raw_email IN ARRAY p_emails LOOP
        v_clean_email := pg_catalog.lower(pg_catalog.btrim(COALESCE(v_raw_email, '')));
        IF v_clean_email = '' THEN
            CONTINUE;
        END IF;

        v_at_pos := pg_catalog.strpos(v_clean_email, '@');
        IF pg_catalog.char_length(v_clean_email) < 3
           OR pg_catalog.char_length(v_clean_email) > 254
           OR pg_catalog.strpos(v_clean_email, ' ') > 0
           OR v_at_pos < 2
        THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_email');
        END IF;

        v_domain_part := pg_catalog.substr(v_clean_email, v_at_pos + 1);
        IF pg_catalog.strpos(v_domain_part, '.') < 2
           OR pg_catalog.strpos(v_domain_part, '@') > 0
           OR pg_catalog.substr(v_domain_part, pg_catalog.char_length(v_domain_part), 1) = '.'
        THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_email');
        END IF;

        IF NOT (v_clean_email = ANY(v_clean_emails)) THEN
            v_clean_emails := pg_catalog.array_append(v_clean_emails, v_clean_email);
        END IF;
    END LOOP;

    IF pg_catalog.cardinality(v_clean_emails) < 1 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_empty_recipients');
    END IF;

    IF pg_catalog.cardinality(v_clean_emails) > 50 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_recipient_limit_reached');
    END IF;

    -- 4. Rate limit antes de mutar
    v_rl := public.verificar_y_consumir_rate_limit(
        v_user_id, 'manage_guest_list', 40, INTERVAL '1 hour'
    );
    IF COALESCE((v_rl ->> 'allowed')::boolean, true) = false THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- 5. Serializar operaciones por usuario para evitar superar el límite en paralelo
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('listas_invitados_usuario:' || v_user_id::text, 0)
    );

    -- 6. Edición vs. Creación
    IF p_lista_id IS NOT NULL THEN
        SELECT * INTO v_row
        FROM public.listas_invitados_usuario
        WHERE id = p_lista_id
          AND owner_id = v_user_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_not_found');
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.listas_invitados_usuario l
            WHERE l.owner_id = v_user_id
              AND pg_catalog.lower(pg_catalog.btrim(l.nombre)) = pg_catalog.lower(v_clean_nombre)
              AND l.id <> p_lista_id
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_name_taken');
        END IF;

        BEGIN
            UPDATE public.listas_invitados_usuario
            SET nombre = v_clean_nombre,
                destinatarios_emails = v_clean_emails,
                updated_at = v_now
            WHERE id = p_lista_id
              AND owner_id = v_user_id
            RETURNING * INTO v_row;
        EXCEPTION
            WHEN unique_violation THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_name_taken');
        END;
    ELSE
        IF EXISTS (
            SELECT 1
            FROM public.listas_invitados_usuario l
            WHERE l.owner_id = v_user_id
              AND pg_catalog.lower(pg_catalog.btrim(l.nombre)) = pg_catalog.lower(v_clean_nombre)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_name_taken');
        END IF;

        SELECT pg_catalog.count(*)::int INTO v_count
        FROM public.listas_invitados_usuario
        WHERE owner_id = v_user_id;

        IF v_count >= 30 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_limit_reached');
        END IF;

        BEGIN
            INSERT INTO public.listas_invitados_usuario (
                owner_id, nombre, destinatarios_emails, created_at, updated_at
            ) VALUES (
                v_user_id, v_clean_nombre, v_clean_emails, v_now, v_now
            )
            RETURNING * INTO v_row;
        EXCEPTION
            WHEN unique_violation THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_name_taken');
        END;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'lista', pg_catalog.jsonb_build_object(
            'id', v_row.id,
            'nombre', v_row.nombre,
            'destinatarios_emails', pg_catalog.to_jsonb(v_row.destinatarios_emails),
            'destinatarios_count', pg_catalog.cardinality(v_row.destinatarios_emails),
            'created_at', v_row.created_at,
            'updated_at', v_row.updated_at
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.guardar_lista_invitados_seguro(TEXT, TEXT[], UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_lista_invitados_seguro(TEXT, TEXT[], UUID) TO authenticated, postgres, service_role;

-- ==============================================================================
-- 5. RPC: renombrar_lista_invitados_seguro
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.renombrar_lista_invitados_seguro(
    p_lista_id UUID,
    p_nombre TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_clean_nombre TEXT := pg_catalog.btrim(COALESCE(p_nombre, ''));
    v_rl JSONB;
    v_row public.listas_invitados_usuario%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    IF p_lista_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_not_found');
    END IF;

    IF pg_catalog.char_length(v_clean_nombre) < 1 OR pg_catalog.char_length(v_clean_nombre) > 80 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_list_name');
    END IF;

    v_rl := public.verificar_y_consumir_rate_limit(
        v_user_id, 'manage_guest_list', 40, INTERVAL '1 hour'
    );
    IF COALESCE((v_rl ->> 'allowed')::boolean, true) = false THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('listas_invitados_usuario:' || v_user_id::text, 0)
    );

    SELECT * INTO v_row
    FROM public.listas_invitados_usuario
    WHERE id = p_lista_id
      AND owner_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_not_found');
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.listas_invitados_usuario l
        WHERE l.owner_id = v_user_id
          AND pg_catalog.lower(pg_catalog.btrim(l.nombre)) = pg_catalog.lower(v_clean_nombre)
          AND l.id <> p_lista_id
    ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_name_taken');
    END IF;

    BEGIN
        UPDATE public.listas_invitados_usuario
        SET nombre = v_clean_nombre,
            updated_at = pg_catalog.timezone('utc', pg_catalog.now())
        WHERE id = p_lista_id
          AND owner_id = v_user_id
        RETURNING * INTO v_row;
    EXCEPTION
        WHEN unique_violation THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_name_taken');
    END;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'lista', pg_catalog.jsonb_build_object(
            'id', v_row.id,
            'nombre', v_row.nombre,
            'destinatarios_emails', pg_catalog.to_jsonb(v_row.destinatarios_emails),
            'destinatarios_count', pg_catalog.cardinality(v_row.destinatarios_emails),
            'created_at', v_row.created_at,
            'updated_at', v_row.updated_at
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.renombrar_lista_invitados_seguro(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renombrar_lista_invitados_seguro(UUID, TEXT) TO authenticated, postgres, service_role;

-- ==============================================================================
-- 6. RPC: eliminar_lista_invitados_seguro
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.eliminar_lista_invitados_seguro(
    p_lista_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_rl JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    IF p_lista_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_not_found');
    END IF;

    v_rl := public.verificar_y_consumir_rate_limit(
        v_user_id, 'manage_guest_list', 40, INTERVAL '1 hour'
    );
    IF COALESCE((v_rl ->> 'allowed')::boolean, true) = false THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    DELETE FROM public.listas_invitados_usuario
    WHERE id = p_lista_id
      AND owner_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'list_not_found');
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_lista_invitados_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_lista_invitados_seguro(UUID) TO authenticated, postgres, service_role;

-- ==============================================================================
-- 7. RPC: listar_listas_invitados_seguro
--    Devuelve:
--      - `listas`: listas privadas guardadas por el propietario.
--      - `sugerencias_listas`: conjuntos implícitos de 2 o más destinatarios de
--        encuentros anteriores basados exclusivamente en solicitudes de invitación
--        interna enviadas por el propio organizador, priorizando conjuntos
--        reutilizados o recientes, excluyendo rechazados, cancelados, bloqueados
--        y conjuntos ya guardados como lista. Máximo 5 sugerencias.
--      - `ya_invitados_encuentro`: si se pasa `p_encuentro_id` propio, correos
--        con solicitud pendiente o aceptada en ese encuentro.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.listar_listas_invitados_seguro(
    p_encuentro_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_listas JSONB;
    v_sugerencias_listas JSONB;
    v_ya_invitados TEXT[] := '{}'::text[];
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    -- Si se especifica un encuentro, validar que pertenezca al organizador
    IF p_encuentro_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM public.encuentros e
            WHERE e.id = p_encuentro_id
              AND e.host_id = v_user_id
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_found_or_not_owner');
        END IF;

        SELECT COALESCE(pg_catalog.array_agg(DISTINCT s.destinatario_email), '{}'::text[])
        INTO v_ya_invitados
        FROM public.solicitudes_invitacion_interna s
        WHERE s.encuentro_id = p_encuentro_id
          AND s.host_id = v_user_id
          AND s.estado IN ('pendiente', 'aceptada');
    END IF;

    -- 1. Listas guardadas por el propietario
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', l.id,
                'nombre', l.nombre,
                'destinatarios_emails', pg_catalog.to_jsonb(l.destinatarios_emails),
                'destinatarios_count', pg_catalog.cardinality(l.destinatarios_emails),
                'created_at', l.created_at,
                'updated_at', l.updated_at
            )
            ORDER BY pg_catalog.lower(l.nombre) ASC, l.created_at DESC
        ),
        '[]'::jsonb
    )
    INTO v_listas
    FROM public.listas_invitados_usuario l
    WHERE l.owner_id = v_user_id;

    -- 2. Sugerencias de conjuntos implícitos (2 o más destinatarios) a partir del
    --    historial propio de solicitudes de invitaciones internas:
    --    - Exclusivamente solicitudes enviadas por el organizador (`s.host_id = v_user_id`).
    --    - Excluye destinatarios con invitación rechazada o cancelada (en ese encuentro
    --      o igual/más reciente en el historial del organizador).
    --    - Excluye destinatarios bloqueados por el organizador.
    --    - Evita sugerencias duplicadas agrupando por el conjunto canónico ordenado de correos
    --      y excluyendo conjuntos idénticos a una lista ya guardada.
    --    - Prioriza conjuntos reutilizados (`veces_usado DESC`) y recientes (`ultima_invitacion_at DESC`).
    --    - Limita a un máximo de 5 sugerencias.
    WITH valid_invites AS (
        SELECT
            s.encuentro_id,
            e.titulo AS encuentro_titulo,
            s.destinatario_email AS email,
            s.created_at
        FROM public.solicitudes_invitacion_interna s
        JOIN public.encuentros e
          ON e.id = s.encuentro_id
         AND e.host_id = v_user_id
        WHERE s.host_id = v_user_id
          AND s.estado IN ('pendiente', 'aceptada', 'expirada')
          AND NOT EXISTS (
              SELECT 1
              FROM public.solicitudes_invitacion_interna s_bad
              WHERE s_bad.host_id = v_user_id
                AND s_bad.destinatario_email = s.destinatario_email
                AND s_bad.estado IN ('rechazada', 'cancelada')
                AND (
                    s_bad.encuentro_id = s.encuentro_id
                    OR s_bad.created_at >= s.created_at
                )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.bloqueos_usuario b
              JOIN auth.users u ON u.id = b.blocked_id
              WHERE b.blocker_id = v_user_id
                AND pg_catalog.lower(u.email) = s.destinatario_email
          )
    ),
    per_encounter AS (
        SELECT
            vi.encuentro_id,
            vi.encuentro_titulo,
            (
                SELECT pg_catalog.array_agg(d.email ORDER BY d.email ASC)
                FROM (
                    SELECT DISTINCT v2.email
                    FROM valid_invites v2
                    WHERE v2.encuentro_id = vi.encuentro_id
                    ORDER BY v2.email ASC
                    LIMIT 50
                ) d
            ) AS emails,
            pg_catalog.max(vi.created_at) AS last_invite_at
        FROM valid_invites vi
        GROUP BY vi.encuentro_id, vi.encuentro_titulo
        HAVING pg_catalog.count(DISTINCT vi.email) >= 2
    ),
    grouped_sets AS (
        SELECT
            pe.emails,
            pg_catalog.cardinality(pe.emails) AS destinatarios_count,
            pg_catalog.count(*)::int AS veces_usado,
            pg_catalog.max(pe.last_invite_at) AS ultima_invitacion_at,
            pg_catalog.substr(
                pg_catalog.btrim(
                    (pg_catalog.array_agg(pe.encuentro_titulo ORDER BY pe.last_invite_at DESC, pe.encuentro_id DESC))[1]
                ),
                1,
                80
            ) AS nombre_sugerido
        FROM per_encounter pe
        WHERE pe.emails IS NOT NULL
          AND pg_catalog.cardinality(pe.emails) >= 2
          AND NOT EXISTS (
              SELECT 1
              FROM public.listas_invitados_usuario l
              WHERE l.owner_id = v_user_id
                AND (
                    SELECT pg_catalog.array_agg(x ORDER BY x ASC)
                    FROM pg_catalog.unnest(l.destinatarios_emails) AS x
                ) = pe.emails
          )
        GROUP BY pe.emails
        ORDER BY pg_catalog.count(*) DESC, pg_catalog.max(pe.last_invite_at) DESC, pe.emails ASC
        LIMIT 5
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'emails', pg_catalog.to_jsonb(gs.emails),
                'destinatarios_count', gs.destinatarios_count,
                'veces_usado', gs.veces_usado,
                'ultima_invitacion_at', gs.ultima_invitacion_at,
                'nombre_sugerido', gs.nombre_sugerido
            )
            ORDER BY gs.veces_usado DESC, gs.ultima_invitacion_at DESC, gs.emails ASC
        ),
        '[]'::jsonb
    )
    INTO v_sugerencias_listas
    FROM grouped_sets gs;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'listas', v_listas,
        'sugerencias_listas', v_sugerencias_listas,
        'ya_invitados_encuentro', pg_catalog.to_jsonb(v_ya_invitados)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.listar_listas_invitados_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_listas_invitados_seguro(UUID) TO authenticated, postgres, service_role;

COMMIT;
