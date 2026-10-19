-- ============================================================
-- Migración: 20261019150000_encounter_templates_favorites_v1.sql
-- Módulo: Favoritos / Repetir encuentro V1
--
-- Diseño (solución mínima, sin duplicar lógica de creación):
--   * Una única tabla public.plantillas_encuentro que guarda una instantánea
--     SANEADA de la configuración reutilizable (whitelist construida en el servidor
--     a partir del encuentro del propio organizador) + opcionalmente los correos
--     de personas invitadas internamente que el organizador ya conocía.
--   * NO se crea ninguna RPC nueva de creación ni de invitación: el cliente reutiliza
--     crear_encuentro_seguro / crear_encuentro_con_opciones_seguro y
--     enviar_invitacion_interna_seguro (con todas sus validaciones).
--   * Lo que NUNCA se persiste ni se copia: id, public_token, tokens de participantes,
--     respuestas, votos, confirmaciones, asistencia, estados, fechas concretas,
--     opciones de coordinación, plazos, flags de encuentro abierto (is_open, cupos,
--     título/descr. públicos, localidad), solicitudes de Discovery ni nombres de
--     invitados individuales.
--
-- RPCs:
--   - guardar_plantilla_encuentro_seguro
--   - listar_plantillas_encuentro_seguro
--   - get_plantilla_encuentro_seguro
--   - renombrar_plantilla_encuentro_seguro
--   - eliminar_plantilla_encuentro_seguro
--   - get_repeticion_encuentro_seguro
-- Helpers internos (sin EXECUTE para clientes):
--   - construir_config_plantilla_interno
--   - obtener_invitados_reutilizables_interno
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLA: public.plantillas_encuentro
-- ============================================================
CREATE TABLE IF NOT EXISTS public.plantillas_encuentro (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    origen_encuentro_id UUID REFERENCES public.encuentros(id) ON DELETE SET NULL,
    date_mode TEXT NOT NULL CHECK (date_mode IN ('fixed', 'coordination')),
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    invitados_emails TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    CONSTRAINT chk_plantilla_encuentro_nombre_len
        CHECK (pg_catalog.char_length(pg_catalog.btrim(nombre)) BETWEEN 1 AND 80),
    CONSTRAINT chk_plantilla_encuentro_config_object
        CHECK (pg_catalog.jsonb_typeof(config) = 'object'),
    CONSTRAINT chk_plantilla_encuentro_invitados_max
        CHECK (pg_catalog.cardinality(invitados_emails) <= 50)
);

-- Nombre único por propietario (sin distinguir mayúsculas)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plantillas_encuentro_owner_nombre
    ON public.plantillas_encuentro (owner_id, (pg_catalog.lower(pg_catalog.btrim(nombre))));

CREATE INDEX IF NOT EXISTS idx_plantillas_encuentro_owner_updated
    ON public.plantillas_encuentro (owner_id, updated_at DESC);

-- ============================================================
-- 2. RLS Y PRIVACIDAD
--    Solo el propietario (cuenta permanente) puede LEER sus filas.
--    No hay privilegios de escritura directa: toda mutación pasa por RPCs
--    que validan propiedad, whitelist de configuración y límites.
-- ============================================================
ALTER TABLE public.plantillas_encuentro ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.plantillas_encuentro FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS plantillas_encuentro_select_owner ON public.plantillas_encuentro;
CREATE POLICY plantillas_encuentro_select_owner
    ON public.plantillas_encuentro
    FOR SELECT
    TO authenticated
    USING (
        owner_id = auth.uid()
        AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    );

GRANT SELECT ON TABLE public.plantillas_encuentro TO authenticated;
GRANT ALL ON TABLE public.plantillas_encuentro TO postgres, service_role;

-- ============================================================
-- 3. POLÍTICA DE RATE LIMIT DURABLE (guardado de favoritos)
-- ============================================================
INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES ('save_encounter_template', 30, 3600, true)
ON CONFLICT (action) DO NOTHING;

-- ============================================================
-- 4. HELPER INTERNO: configuración reutilizable (whitelist)
--    Única fuente de verdad de qué campos se consideran "plantilla".
-- ============================================================
CREATE OR REPLACE FUNCTION public.construir_config_plantilla_interno(p_enc public.encuentros)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'titulo', p_enc.titulo,
        'descripcion', p_enc.descripcion,
        'modalidad', p_enc.modalidad,
        'lugar_texto', p_enc.lugar_texto,
        'link_virtual', p_enc.link_virtual,
        'tipo_invitacion', p_enc.tipo_invitacion,
        'tema', p_enc.tema,
        'tema_invitacion', COALESCE(p_enc.tema_invitacion, 'classic'),
        'invitation_template', p_enc.invitation_template,
        -- Solo la hora del día es reutilizable; la fecha concreta jamás se copia.
        'hora', CASE
            WHEN p_enc.date_mode = 'fixed' AND p_enc.hora IS NOT NULL
            THEN pg_catalog.substr(p_enc.hora::text, 1, 5)
            ELSE NULL
        END,
        'duration_minutes', CASE
            WHEN p_enc.date_mode = 'coordination' THEN p_enc.duration_minutes
            ELSE NULL
        END,
        'mostrar_respuestas_a_invitados', CASE
            WHEN p_enc.date_mode = 'coordination'
            THEN COALESCE(p_enc.mostrar_respuestas_a_invitados, false)
            ELSE NULL
        END,
        'visibilidad_respuestas_invitados', CASE
            WHEN p_enc.date_mode = 'coordination'
            THEN COALESCE(p_enc.visibilidad_respuestas_invitados, 'hidden')
            ELSE NULL
        END
    );
$$;

REVOKE ALL ON FUNCTION public.construir_config_plantilla_interno(public.encuentros) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 5. HELPER INTERNO: invitados recuperables de forma autorizada
--    Fuente única: solicitudes de invitación interna que el propio organizador
--    envió para ese encuentro (correos que él mismo ingresó).
--    Se excluyen:
--      - rechazadas y canceladas (el destinatario declinó / el organizador retiró),
--      - personas que el organizador bloqueó posteriormente,
--      - cualquier dato de Discovery, solicitudes de unión, participantes por link
--        o invitados individuales por nombre (no tienen correo recuperable).
--    No consulta ni revela si el correo corresponde a una cuenta registrada,
--    ni si alguien bloqueó al organizador.
-- ============================================================
CREATE OR REPLACE FUNCTION public.obtener_invitados_reutilizables_interno(
    p_host_id UUID,
    p_encuentro_id UUID
)
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_emails TEXT[];
BEGIN
    SELECT COALESCE(pg_catalog.array_agg(q.email ORDER BY q.first_at), '{}'::text[])
    INTO v_emails
    FROM (
        SELECT s.destinatario_email AS email, pg_catalog.min(s.created_at) AS first_at
        FROM public.solicitudes_invitacion_interna s
        WHERE s.encuentro_id = p_encuentro_id
          AND s.host_id = p_host_id
          AND s.estado IN ('pendiente', 'aceptada', 'expirada')
          AND NOT EXISTS (
              SELECT 1
              FROM public.bloqueos_usuario b
              JOIN auth.users u ON u.id = b.blocked_id
              WHERE b.blocker_id = p_host_id
                AND pg_catalog.lower(u.email) = s.destinatario_email
          )
        GROUP BY s.destinatario_email
        ORDER BY pg_catalog.min(s.created_at)
        LIMIT 50
    ) q;

    RETURN v_emails;
END;
$$;

REVOKE ALL ON FUNCTION public.obtener_invitados_reutilizables_interno(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 6. RPC: get_repeticion_encuentro_seguro
--    Lectura de la configuración reutilizable de un encuentro PROPIO
--    (cualquier estado: activo, cancelado, realizado; privado o abierto).
--    Los correos solo se devuelven si el organizador eligió expresamente
--    la modalidad "con invitados" y posee cuenta permanente.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_repeticion_encuentro_seguro(
    p_encuentro_id UUID,
    p_incluir_invitados BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_enc public.encuentros%ROWTYPE;
    v_emails TEXT[] := '{}'::text[];
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_found_or_not_owner');
    END IF;

    IF COALESCE(p_incluir_invitados, false) AND v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    SELECT * INTO v_enc
    FROM public.encuentros
    WHERE id = p_encuentro_id
      AND host_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_found_or_not_owner');
    END IF;

    IF NOT v_is_anon THEN
        v_emails := public.obtener_invitados_reutilizables_interno(v_user_id, p_encuentro_id);
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'plantilla', pg_catalog.jsonb_build_object(
            'origen', 'encuentro',
            'date_mode', v_enc.date_mode,
            'config', public.construir_config_plantilla_interno(v_enc),
            'invitados_count', pg_catalog.cardinality(v_emails),
            'invitados', CASE
                WHEN COALESCE(p_incluir_invitados, false) THEN pg_catalog.to_jsonb(v_emails)
                ELSE '[]'::jsonb
            END
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_repeticion_encuentro_seguro(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_repeticion_encuentro_seguro(UUID, BOOLEAN) TO authenticated;

-- ============================================================
-- 7. RPC: guardar_plantilla_encuentro_seguro
--    La instantánea se construye en el servidor desde el encuentro propio:
--    el cliente solo aporta id, nombre y modalidad (con/sin invitados).
-- ============================================================
CREATE OR REPLACE FUNCTION public.guardar_plantilla_encuentro_seguro(
    p_encuentro_id UUID,
    p_nombre TEXT,
    p_incluir_invitados BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_nombre TEXT;
    v_enc public.encuentros%ROWTYPE;
    v_emails TEXT[] := '{}'::text[];
    v_rl JSONB;
    v_count INT;
    v_id UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon IS TRUE THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    v_nombre := pg_catalog.btrim(COALESCE(p_nombre, ''));
    IF pg_catalog.char_length(v_nombre) < 1 OR pg_catalog.char_length(v_nombre) > 80 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_template_name');
    END IF;

    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_found_or_not_owner');
    END IF;

    SELECT * INTO v_enc
    FROM public.encuentros
    WHERE id = p_encuentro_id
      AND host_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encuentro_not_found_or_not_owner');
    END IF;

    v_rl := public.verificar_y_consumir_rate_limit(v_user_id, 'save_encounter_template', 30, INTERVAL '1 hour');
    IF NOT COALESCE((v_rl ->> 'allowed')::boolean, true) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- Serializa el chequeo de cupo por usuario para evitar superar el límite en paralelo
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('plantillas_encuentro:' || v_user_id::text, 0)
    );

    SELECT pg_catalog.count(*) INTO v_count
    FROM public.plantillas_encuentro
    WHERE owner_id = v_user_id;

    IF v_count >= 30 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'template_limit_reached');
    END IF;

    IF COALESCE(p_incluir_invitados, false) THEN
        v_emails := public.obtener_invitados_reutilizables_interno(v_user_id, p_encuentro_id);
    END IF;

    BEGIN
        INSERT INTO public.plantillas_encuentro (
            owner_id, nombre, origen_encuentro_id, date_mode, config, invitados_emails
        ) VALUES (
            v_user_id,
            v_nombre,
            p_encuentro_id,
            v_enc.date_mode,
            public.construir_config_plantilla_interno(v_enc),
            v_emails
        )
        RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'template_name_taken');
    END;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'id', v_id,
        'invitados_count', pg_catalog.cardinality(v_emails)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.guardar_plantilla_encuentro_seguro(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guardar_plantilla_encuentro_seguro(UUID, TEXT, BOOLEAN) TO authenticated;

-- ============================================================
-- 8. RPC: listar_plantillas_encuentro_seguro
--    Resumen mínimo: no incluye correos ni enlaces privados.
-- ============================================================
CREATE OR REPLACE FUNCTION public.listar_plantillas_encuentro_seguro()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_items JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon IS TRUE THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', p.id,
                'nombre', p.nombre,
                'date_mode', p.date_mode,
                'titulo', p.config ->> 'titulo',
                'modalidad', p.config ->> 'modalidad',
                'invitados_count', pg_catalog.cardinality(p.invitados_emails),
                'created_at', p.created_at,
                'updated_at', p.updated_at
            ) ORDER BY p.updated_at DESC, p.id
        ), '[]'::jsonb
    ) INTO v_items
    FROM public.plantillas_encuentro p
    WHERE p.owner_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'plantillas', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.listar_plantillas_encuentro_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_plantillas_encuentro_seguro() TO authenticated;

-- ============================================================
-- 9. RPC: get_plantilla_encuentro_seguro
--    Recupera una plantilla propia para usarla. Los correos solo se
--    devuelven con p_incluir_invitados = true.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_plantilla_encuentro_seguro(
    p_plantilla_id UUID,
    p_incluir_invitados BOOLEAN DEFAULT false
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
    v_p public.plantillas_encuentro%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon IS TRUE THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    SELECT * INTO v_p
    FROM public.plantillas_encuentro
    WHERE id = p_plantilla_id
      AND owner_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'template_not_found');
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'plantilla', pg_catalog.jsonb_build_object(
            'origen', 'plantilla',
            'id', v_p.id,
            'nombre', v_p.nombre,
            'date_mode', v_p.date_mode,
            'config', v_p.config,
            'invitados_count', pg_catalog.cardinality(v_p.invitados_emails),
            'invitados', CASE
                WHEN COALESCE(p_incluir_invitados, false) THEN pg_catalog.to_jsonb(v_p.invitados_emails)
                ELSE '[]'::jsonb
            END
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_plantilla_encuentro_seguro(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_plantilla_encuentro_seguro(UUID, BOOLEAN) TO authenticated;

-- ============================================================
-- 10. RPC: renombrar_plantilla_encuentro_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.renombrar_plantilla_encuentro_seguro(
    p_plantilla_id UUID,
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
    v_nombre TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF v_is_anon IS TRUE THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    v_nombre := pg_catalog.btrim(COALESCE(p_nombre, ''));
    IF pg_catalog.char_length(v_nombre) < 1 OR pg_catalog.char_length(v_nombre) > 80 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_template_name');
    END IF;

    BEGIN
        UPDATE public.plantillas_encuentro
        SET nombre = v_nombre,
            updated_at = pg_catalog.timezone('utc', pg_catalog.now())
        WHERE id = p_plantilla_id
          AND owner_id = v_user_id;
    EXCEPTION WHEN unique_violation THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'template_name_taken');
    END;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'template_not_found');
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.renombrar_plantilla_encuentro_seguro(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renombrar_plantilla_encuentro_seguro(UUID, TEXT) TO authenticated;

-- ============================================================
-- 11. RPC: eliminar_plantilla_encuentro_seguro
--     Elimina físicamente la plantilla y, con ella, los correos guardados.
-- ============================================================
CREATE OR REPLACE FUNCTION public.eliminar_plantilla_encuentro_seguro(
    p_plantilla_id UUID
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

    IF v_is_anon IS TRUE THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'anonymous_user_not_allowed');
    END IF;

    DELETE FROM public.plantillas_encuentro
    WHERE id = p_plantilla_id
      AND owner_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'template_not_found');
    END IF;

    RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_plantilla_encuentro_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_plantilla_encuentro_seguro(UUID) TO authenticated;

COMMIT;
