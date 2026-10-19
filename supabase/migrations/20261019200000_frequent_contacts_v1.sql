-- ==============================================================================
-- Migración: 20261019200000_frequent_contacts_v1.sql
-- Módulo: Contactos frecuentes V1 (Agenda privada ligera del organizador)
--
-- Diseño de seguridad y privacidad:
--   * Tabla única `public.contactos_usuario` con propiedad estricta (`owner_id = auth.uid()`).
--   * Exclusivo para cuentas permanentes (`is_anonymous = false`).
--   * RLS activa: solo SELECT para el propietario permanente; toda escritura pasa
--     por RPCs SECURITY DEFINER con `SET search_path = ''`.
--   * Normalización y deduplicación por propietario (`lower(btrim(email))`).
--   * Límite de almacenamiento razonable (máx. 200 contactos por usuario) y rate limit.
--   * Sugerencias recientes/frecuentes derivadas únicamente del historial de
--     `public.solicitudes_invitacion_interna` enviadas por el propio organizador,
--     excluyendo contactos ya agendados, invitaciones rechazadas/canceladas y
--     usuarios bloqueados por el organizador.
--   * CERO consultas globales sobre `auth.users` por correo y CERO exposición de
--     si un correo corresponde o no a una cuenta registrada en PuntoEncuentro.
--   * Guardar o editar un contacto NUNCA envía invitaciones.
--
-- RPCs:
--   - guardar_contacto_usuario_seguro
--   - alternar_favorito_contacto_usuario_seguro
--   - eliminar_contacto_usuario_seguro
--   - listar_contactos_y_sugerencias_seguro
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. TABLA: public.contactos_usuario
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.contactos_usuario (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL,
    es_favorito BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    CONSTRAINT chk_contactos_usuario_nombre_len
        CHECK (pg_catalog.char_length(pg_catalog.btrim(nombre)) BETWEEN 1 AND 80),
    CONSTRAINT chk_contactos_usuario_email_norm
        CHECK (
            email = pg_catalog.lower(pg_catalog.btrim(email))
            AND pg_catalog.char_length(email) BETWEEN 3 AND 254
            AND pg_catalog.strpos(email, ' ') = 0
            AND pg_catalog.strpos(email, '@') >= 2
            AND pg_catalog.strpos(pg_catalog.substr(email, pg_catalog.strpos(email, '@') + 1), '.') >= 2
        )
);

-- Correo único normalizado por propietario
CREATE UNIQUE INDEX IF NOT EXISTS idx_contactos_usuario_owner_email
    ON public.contactos_usuario (owner_id, email);

-- Índice para listado ordenado por favoritos y nombre, y búsqueda por propietario
CREATE INDEX IF NOT EXISTS idx_contactos_usuario_owner_fav_nombre
    ON public.contactos_usuario (owner_id, es_favorito DESC, (pg_catalog.lower(nombre)) ASC);

-- ==============================================================================
-- 2. RLS Y PRIVILEGIOS
-- ==============================================================================
ALTER TABLE public.contactos_usuario ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.contactos_usuario FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS contactos_usuario_select_owner ON public.contactos_usuario;
CREATE POLICY contactos_usuario_select_owner
    ON public.contactos_usuario
    FOR SELECT
    TO authenticated
    USING (
        owner_id = auth.uid()
        AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    );

GRANT SELECT ON TABLE public.contactos_usuario TO authenticated;
GRANT ALL ON TABLE public.contactos_usuario TO postgres, service_role;

-- ==============================================================================
-- 3. POLÍTICA DE RATE LIMIT DURABLE
-- ==============================================================================
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES ('manage_user_contact', 60, 3600, true)
ON CONFLICT (action) DO NOTHING;

-- ==============================================================================
-- 4. RPC: guardar_contacto_usuario_seguro
--    Crea o actualiza un contacto en la agenda privada del usuario permanente.
--    No consulta globalmente `auth.users` ni envía invitaciones.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.guardar_contacto_usuario_seguro(
    p_nombre TEXT,
    p_email TEXT,
    p_es_favorito BOOLEAN DEFAULT false,
    p_contacto_id UUID DEFAULT NULL
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
    v_clean_email TEXT := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
    v_at_pos INT;
    v_domain_part TEXT;
    v_count INT;
    v_rl JSONB;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_row public.contactos_usuario%ROWTYPE;
BEGIN
    -- 1. Identidad y cuenta permanente
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    -- 2. Validación de nombre/alias
    IF pg_catalog.char_length(v_clean_nombre) < 1 OR pg_catalog.char_length(v_clean_nombre) > 80 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_contact_name');
    END IF;

    -- 3. Validación y normalización de correo electrónico
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

    -- 4. Rate limit antes de mutar
    v_rl := public.verificar_y_consumir_rate_limit(
        v_user_id, 'manage_user_contact', 60, INTERVAL '1 hour'
    );
    IF COALESCE((v_rl ->> 'allowed')::boolean, true) = false THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- 5. Edición vs. Creación
    IF p_contacto_id IS NOT NULL THEN
        SELECT * INTO v_row
        FROM public.contactos_usuario
        WHERE id = p_contacto_id
          AND owner_id = v_user_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'contact_not_found');
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.contactos_usuario c
            WHERE c.owner_id = v_user_id
              AND c.email = v_clean_email
              AND c.id <> p_contacto_id
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'contact_email_taken');
        END IF;

        UPDATE public.contactos_usuario
        SET nombre = v_clean_nombre,
            email = v_clean_email,
            es_favorito = COALESCE(p_es_favorito, es_favorito),
            updated_at = v_now
        WHERE id = p_contacto_id
          AND owner_id = v_user_id
        RETURNING * INTO v_row;
    ELSE
        IF EXISTS (
            SELECT 1
            FROM public.contactos_usuario c
            WHERE c.owner_id = v_user_id
              AND c.email = v_clean_email
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'contact_email_taken');
        END IF;

        SELECT pg_catalog.count(*)::int INTO v_count
        FROM public.contactos_usuario
        WHERE owner_id = v_user_id;

        IF v_count >= 200 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'contact_limit_reached');
        END IF;

        BEGIN
            INSERT INTO public.contactos_usuario (
                owner_id, nombre, email, es_favorito, created_at, updated_at
            ) VALUES (
                v_user_id, v_clean_nombre, v_clean_email, COALESCE(p_es_favorito, false), v_now, v_now
            )
            RETURNING * INTO v_row;
        EXCEPTION
            WHEN unique_violation THEN
                RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'contact_email_taken');
        END;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'contacto', pg_catalog.jsonb_build_object(
            'id', v_row.id,
            'nombre', v_row.nombre,
            'email', v_row.email,
            'es_favorito', v_row.es_favorito,
            'created_at', v_row.created_at,
            'updated_at', v_row.updated_at
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.guardar_contacto_usuario_seguro(TEXT, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_contacto_usuario_seguro(TEXT, TEXT, BOOLEAN, UUID) TO authenticated, postgres, service_role;

-- ==============================================================================
-- 5. RPC: alternar_favorito_contacto_usuario_seguro
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.alternar_favorito_contacto_usuario_seguro(
    p_contacto_id UUID,
    p_es_favorito BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_row public.contactos_usuario%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    IF p_contacto_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'contact_not_found');
    END IF;

    UPDATE public.contactos_usuario
    SET es_favorito = COALESCE(p_es_favorito, NOT es_favorito),
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_contacto_id
      AND owner_id = v_user_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'contact_not_found');
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'id', v_row.id,
        'es_favorito', v_row.es_favorito
    );
END;
$$;

REVOKE ALL ON FUNCTION public.alternar_favorito_contacto_usuario_seguro(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alternar_favorito_contacto_usuario_seguro(UUID, BOOLEAN) TO authenticated, postgres, service_role;

-- ==============================================================================
-- 6. RPC: eliminar_contacto_usuario_seguro
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.eliminar_contacto_usuario_seguro(
    p_contacto_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    IF p_contacto_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'contact_not_found');
    END IF;

    DELETE FROM public.contactos_usuario
    WHERE id = p_contacto_id
      AND owner_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'contact_not_found');
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_contacto_usuario_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_contacto_usuario_seguro(UUID) TO authenticated, postgres, service_role;

-- ==============================================================================
-- 7. RPC: listar_contactos_y_sugerencias_seguro
--    Devuelve:
--      - `contactos`: agenda guardada del usuario (favoritos primero, luego alfabético).
--      - `sugerencias`: correos frecuentes/recientes del historial de invitaciones
--        internas enviadas por el propio organizador que NO están ya en `contactos`,
--        excluyendo invitaciones rechazadas o canceladas y destinatarios bloqueados
--        por el organizador. No revela si un correo está registrado.
--      - `ya_invitados_encuentro`: si se pasa `p_encuentro_id` propio, lista los correos
--        que ya tienen solicitud pendiente o aceptada en ese encuentro para evitar duplicados.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.listar_contactos_y_sugerencias_seguro(
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
    v_contactos JSONB;
    v_sugerencias JSONB;
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

    -- 1. Contactos guardados por el propietario
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', c.id,
                'nombre', c.nombre,
                'email', c.email,
                'es_favorito', c.es_favorito,
                'created_at', c.created_at,
                'updated_at', c.updated_at
            )
            ORDER BY c.es_favorito DESC, pg_catalog.lower(c.nombre) ASC, c.created_at DESC
        ),
        '[]'::jsonb
    )
    INTO v_contactos
    FROM public.contactos_usuario c
    WHERE c.owner_id = v_user_id;

    -- 2. Sugerencias basadas exclusivamente en el historial propio de invitaciones internas:
    --    - Solo estados válidos ('pendiente', 'aceptada', 'expirada').
    --    - Excluye cualquier correo cuya última solicitud del organizador haya sido
    --      'rechazada' o 'cancelada'.
    --    - Excluye correos ya guardados en `public.contactos_usuario` del organizador.
    --    - Excluye destinatarios bloqueados por el organizador.
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'email', q.email,
                'veces_invitado', q.veces_invitado,
                'ultima_invitacion_at', q.ultima_invitacion_at
            )
            ORDER BY q.veces_invitado DESC, q.ultima_invitacion_at DESC, q.email ASC
        ),
        '[]'::jsonb
    )
    INTO v_sugerencias
    FROM (
        SELECT
            s.destinatario_email AS email,
            pg_catalog.count(*)::int AS veces_invitado,
            pg_catalog.max(s.created_at) AS ultima_invitacion_at
        FROM public.solicitudes_invitacion_interna s
        WHERE s.host_id = v_user_id
          AND s.estado IN ('pendiente', 'aceptada', 'expirada')
          -- No sugerir correos ya guardados como contacto
          AND NOT EXISTS (
              SELECT 1
              FROM public.contactos_usuario c
              WHERE c.owner_id = v_user_id
                AND c.email = s.destinatario_email
          )
          -- No sugerir si existe una invitación rechazada o cancelada igual o más reciente para ese correo
          AND NOT EXISTS (
              SELECT 1
              FROM public.solicitudes_invitacion_interna s_bad
              WHERE s_bad.host_id = v_user_id
                AND s_bad.destinatario_email = s.destinatario_email
                AND s_bad.estado IN ('rechazada', 'cancelada')
                AND s_bad.created_at >= s.created_at
          )
          -- No sugerir destinatarios bloqueados por el organizador
          AND NOT EXISTS (
              SELECT 1
              FROM public.bloqueos_usuario b
              JOIN auth.users u ON u.id = b.blocked_id
              WHERE b.blocker_id = v_user_id
                AND pg_catalog.lower(u.email) = s.destinatario_email
          )
        GROUP BY s.destinatario_email
        ORDER BY pg_catalog.count(*) DESC, pg_catalog.max(s.created_at) DESC, s.destinatario_email ASC
        LIMIT 30
    ) q;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'contactos', v_contactos,
        'sugerencias', v_sugerencias,
        'ya_invitados_encuentro', pg_catalog.to_jsonb(v_ya_invitados)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.listar_contactos_y_sugerencias_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_contactos_y_sugerencias_seguro(UUID) TO authenticated, postgres, service_role;

COMMIT;
