-- ============================================================
-- Migración: 20260927120000_open_encounters_and_localities.sql
-- Etapa 1.5: Encuentros Abiertos + Catálogo de Localidades + Solicitudes
-- ============================================================

-- 1. CATÁLOGO DE LOCALIDADES
CREATE TABLE IF NOT EXISTS public.localidades (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    ciudad TEXT NOT NULL,
    zona TEXT NOT NULL,
    pais TEXT NOT NULL DEFAULT 'AR',
    orden INT NOT NULL DEFAULT 1,
    activo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Seed localidades iniciales (Mar del Plata + Buenos Aires)
INSERT INTO public.localidades (id, nombre, ciudad, zona, pais, orden, activo) VALUES
    ('guemes', 'Güemes', 'Mar del Plata', 'Costa Atlántica', 'AR', 1, true),
    ('constitucion', 'Constitución', 'Mar del Plata', 'Costa Atlántica', 'AR', 2, true),
    ('costa', 'La Costa', 'Mar del Plata', 'Costa Atlántica', 'AR', 3, true),
    ('centro', 'Centro', 'Mar del Plata', 'Costa Atlántica', 'AR', 4, true),
    ('mitre', 'Plaza Mitre', 'Mar del Plata', 'Costa Atlántica', 'AR', 5, true),
    ('palermo', 'Palermo', 'Buenos Aires', 'CABA', 'AR', 6, true),
    ('belgrano', 'Belgrano', 'Buenos Aires', 'CABA', 'AR', 7, true),
    ('caballito', 'Caballito', 'Buenos Aires', 'CABA', 'AR', 8, true),
    ('vicente-lopez', 'Vicente López', 'Buenos Aires', 'GBA Norte', 'AR', 9, true),
    ('villa-urquiza', 'Villa Urquiza', 'Buenos Aires', 'CABA', 'AR', 10, true)
ON CONFLICT (id) DO NOTHING;

-- 2. EXTENSIÓN DE ENCUENTROS PARA ESTADO ABIERTO (IS_OPEN)
ALTER TABLE public.encuentros
ADD COLUMN IF NOT EXISTS is_open BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS open_description TEXT,
ADD COLUMN IF NOT EXISTS max_participants INT,
ADD COLUMN IF NOT EXISTS locality_id TEXT REFERENCES public.localidades(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS open_public_zone TEXT,
ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP WITH TIME ZONE;

-- Constraint de cupo e integridad
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_encuentro_abierto_integrity'
    ) THEN
        ALTER TABLE public.encuentros
        ADD CONSTRAINT check_encuentro_abierto_integrity
        CHECK (
            (is_open = false)
            OR
            (is_open = true AND max_participants IS NOT NULL AND max_participants >= 2 AND locality_id IS NOT NULL)
        );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_encuentros_discovery 
ON public.encuentros(is_open, estado, locality_id) 
WHERE is_open = true AND estado = 'activo';

-- 3. PREFERENCIAS DE LOCALIDADES DEL USUARIO (MIS ZONAS)
CREATE TABLE IF NOT EXISTS public.usuario_localidades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    locality_id TEXT NOT NULL REFERENCES public.localidades(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    UNIQUE (user_id, locality_id)
);

CREATE INDEX IF NOT EXISTS idx_usuario_localidades_user ON public.usuario_localidades(user_id);
CREATE INDEX IF NOT EXISTS idx_usuario_localidades_loc ON public.usuario_localidades(locality_id);

-- 4. SOLICITUDES PARA SUMARSE A ENCUENTRO ABIERTO
CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    usuario_id UUID NOT NULL,
    nombre_solicitante TEXT NOT NULL,
    mensaje TEXT,
    estado TEXT NOT NULL DEFAULT 'pending' CHECK (estado IN ('pending', 'approved', 'rejected', 'withdrawn')),
    participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
    token_participante UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_encuentro ON public.solicitudes_encuentro_abierto(encuentro_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_usuario ON public.solicitudes_encuentro_abierto(usuario_id);

-- Evita duplicar solicitudes pendientes para el mismo encuentro
CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitudes_pendientes_unicas 
ON public.solicitudes_encuentro_abierto(encuentro_id, usuario_id) 
WHERE estado = 'pending';

-- 5. SEGURIDAD RLS
ALTER TABLE public.localidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuario_localidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solicitudes_encuentro_abierto ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.localidades FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.localidades TO anon, authenticated;

REVOKE ALL ON TABLE public.usuario_localidades FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.solicitudes_encuentro_abierto FROM PUBLIC, anon, authenticated;

-- Policies de lectura de localidades
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'localidades_select_policy') THEN
        CREATE POLICY localidades_select_policy ON public.localidades
        FOR SELECT TO anon, authenticated USING (activo = true);
    END IF;
END $$;

-- ============================================================
-- 6. RPC: abrir_encuentro_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT,
    p_open_public_zone TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_locality_exists BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_host_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_inactive');
    END IF;

    -- Validar localidad
    SELECT EXISTS (SELECT 1 FROM public.localidades WHERE id = p_locality_id AND activo = true)
    INTO v_locality_exists;

    IF NOT v_locality_exists THEN
        RETURN json_build_object('ok', false, 'error', 'invalid_locality');
    END IF;

    -- Validar cupo
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado = 'confirmado';

    -- Host cuenta como 1 ocupante
    IF p_max_participants < (v_confirmed_count + 1) THEN
        RETURN json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    IF p_max_participants < 2 THEN
        RETURN json_build_object('ok', false, 'error', 'min_two_participants');
    END IF;

    UPDATE public.encuentros
    SET is_open = true,
        open_description = NULLIF(trim(p_open_description), ''),
        max_participants = p_max_participants,
        locality_id = p_locality_id,
        open_public_zone = NULLIF(trim(p_open_public_zone), ''),
        opened_at = now(),
        closed_at = NULL
    WHERE id = p_encuentro_id;

    RETURN json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'is_open', true,
        'max_participants', p_max_participants,
        'locality_id', p_locality_id,
        'open_public_zone', p_open_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT) TO authenticated, anon;

-- ============================================================
-- 7. RPC: cerrar_encuentro_abierto_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.cerrar_encuentro_abierto_seguro(
    p_encuentro_id UUID,
    p_host_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_host_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    UPDATE public.encuentros
    SET is_open = false,
        closed_at = now()
    WHERE id = p_encuentro_id;

    RETURN json_build_object('ok', true, 'encuentro_id', p_encuentro_id, 'is_open', false);
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_encuentro_abierto_seguro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cerrar_encuentro_abierto_seguro(UUID, UUID) TO authenticated, anon;

-- ============================================================
-- 8. RPC: get_discovery_encuentros_abiertos (PÚBLICO Y SEGURO)
-- Jamás devuelve dirección exacta (lugar_texto), virtual_link ni tokens privados.
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
    v_result JSON;
    v_now TIMESTAMP WITH TIME ZONE := now();
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
        ORDER BY e.opened_at DESC, e.creado_en DESC
    ) enc_row;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) TO anon, authenticated;

-- ============================================================
-- 9. RPC: solicitar_sumarse_encuentro_abierto
-- ============================================================
CREATE OR REPLACE FUNCTION public.solicitar_sumarse_encuentro_abierto(
    p_encuentro_id UUID,
    p_nombre TEXT,
    p_mensaje TEXT DEFAULT NULL,
    p_usuario_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_solicitud_id UUID;
    v_clean_nombre TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_usuario_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

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

    -- Validar que no tenga ya una solicitud pendiente
    IF EXISTS (
        SELECT 1 FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
          AND usuario_id = v_user_id
          AND estado = 'pending'
    ) THEN
        RETURN json_build_object('ok', false, 'error', 'duplicate_pending_request');
    END IF;

    -- Validar que no sea ya un participante confirmado
    IF EXISTS (
        SELECT 1 FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND nombre_invitado = v_clean_nombre
          AND estado = 'confirmado'
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

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID) TO anon, authenticated;

-- ============================================================
-- 10. RPC: aprobar_solicitud_encuentro_abierto (TRANSACCIONAL & CONCURRENCIA)
-- Bloquea las filas por FOR UPDATE para impedir sobrecupo concurrente.
-- Crea el participante regular en public.participantes.
-- ============================================================
CREATE OR REPLACE FUNCTION public.aprobar_solicitud_encuentro_abierto(
    p_request_id UUID,
    p_host_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_participante_id UUID;
    v_token_invitacion UUID;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_host_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
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

    -- 3. Validar cupo real bajo bloqueo
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id AND estado = 'confirmado';

    IF (v_confirmed_count + 1) >= v_encuentro.max_participants THEN
        RETURN json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    -- 4. Reutilizar participante regular existente o crear nuevo
    v_token_invitacion := gen_random_uuid();
    v_participante_id := gen_random_uuid();

    INSERT INTO public.participantes (
        id,
        encuentro_id,
        nombre_invitado,
        tipo_invitacion,
        estado,
        token_invitacion,
        mensaje_respuesta
    ) VALUES (
        v_participante_id,
        v_encuentro.id,
        v_solicitud.nombre_solicitante,
        'individual',
        'confirmado',
        v_token_invitacion,
        v_solicitud.mensaje
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

REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID) TO authenticated, anon;

-- ============================================================
-- 11. RPC: rechazar_solicitud_encuentro_abierto
-- ============================================================
CREATE OR REPLACE FUNCTION public.rechazar_solicitud_encuentro_abierto(
    p_request_id UUID,
    p_host_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_host_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

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

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_solicitud.encuentro_id;

    IF NOT FOUND OR v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    UPDATE public.solicitudes_encuentro_abierto
    SET estado = 'rejected',
        resolved_at = now(),
        updated_at = now()
    WHERE id = p_request_id;

    RETURN json_build_object('ok', true, 'request_id', p_request_id, 'estado', 'rejected');
END;
$$;

REVOKE ALL ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID) TO authenticated, anon;

-- ============================================================
-- 12. RPC: get_solicitudes_host_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_solicitudes_host_seguro(
    p_encuentro_id UUID,
    p_host_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_result JSON;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_host_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT json_agg(r) INTO v_result
    FROM (
        SELECT
            id,
            encuentro_id,
            usuario_id,
            nombre_solicitante,
            mensaje,
            estado,
            participante_id,
            token_participante,
            created_at,
            resolved_at
        FROM public.solicitudes_encuentro_abierto
        WHERE encuentro_id = p_encuentro_id
        ORDER BY created_at DESC
    ) r;

    RETURN json_build_object('ok', true, 'solicitudes', COALESCE(v_result, '[]'::json));
END;
$$;

REVOKE ALL ON FUNCTION public.get_solicitudes_host_seguro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_solicitudes_host_seguro(UUID, UUID) TO authenticated, anon;

-- ============================================================
-- 13. RPC: get_mi_solicitud_encuentro_abierto
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_mi_solicitud_encuentro_abierto(
    p_encuentro_id UUID,
    p_usuario_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_usuario_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', true, 'has_request', false);
    END IF;

    RETURN json_build_object(
        'ok', true,
        'has_request', true,
        'request_id', v_solicitud.id,
        'estado', v_solicitud.estado,
        'token_participante', v_solicitud.token_participante,
        'created_at', v_solicitud.created_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_mi_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mi_solicitud_encuentro_abierto(UUID, UUID) TO anon, authenticated;

-- ============================================================
-- 14. RPC: get_localidades_catalogo
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_localidades_catalogo()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_result JSON;
BEGIN
    SELECT json_agg(l) INTO v_result
    FROM (
        SELECT id, nombre, ciudad, zona, pais, orden
        FROM public.localidades
        WHERE activo = true
        ORDER BY orden ASC, nombre ASC
    ) l;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_localidades_catalogo() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_localidades_catalogo() TO anon, authenticated;

-- ============================================================
-- 15. RPCs: get_user_localidades_seguro & set_user_localidades_seguro
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_localidades_seguro(
    p_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_result JSON;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_user_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN '[]'::json;
    END IF;

    SELECT json_agg(locality_id) INTO v_result
    FROM public.usuario_localidades
    WHERE user_id = v_user_id;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_localidades_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_localidades_seguro(UUID) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_user_localidades_seguro(
    p_locality_ids TEXT[],
    p_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_loc TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_user_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- Borrar existentes
    DELETE FROM public.usuario_localidades WHERE user_id = v_user_id;

    -- Insertar nuevas
    IF p_locality_ids IS NOT NULL AND array_length(p_locality_ids, 1) > 0 THEN
        FOREACH v_loc IN ARRAY p_locality_ids LOOP
            IF EXISTS (SELECT 1 FROM public.localidades WHERE id = v_loc AND activo = true) THEN
                INSERT INTO public.usuario_localidades (user_id, locality_id)
                VALUES (v_user_id, v_loc)
                ON CONFLICT (user_id, locality_id) DO NOTHING;
            END IF;
        END LOOP;
    END IF;

    RETURN json_build_object('ok', true, 'locality_ids', p_locality_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.set_user_localidades_seguro(TEXT[], UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_localidades_seguro(TEXT[], UUID) TO anon, authenticated;

-- ============================================================
-- 16. ACTUALIZACIÓN get_detalle_host_seguro
-- Incluye campos de encuentro abierto y soporte para p_host_id
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_detalle_host_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_host_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN json_build_object('error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN json_build_object('error', 'unauthorized');
    END IF;

    RETURN json_build_object(
        'id', v_encuentro.id,
        'titulo', v_encuentro.titulo,
        'descripcion', v_encuentro.descripcion,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'lugar_texto', v_encuentro.lugar_texto,
        'link_virtual', v_encuentro.link_virtual,
        'tipo_invitacion', v_encuentro.tipo_invitacion,
        'host_id', v_encuentro.host_id,
        'public_token', v_encuentro.public_token,
        'estado', v_encuentro.estado,
        'tema', v_encuentro.tema,
        'tema_invitacion', COALESCE(v_encuentro.tema_invitacion, 'classic'),
        'invitation_template', v_encuentro.invitation_template,
        'reemplaza_a', v_encuentro.reemplaza_a,
        'creado_en', v_encuentro.creado_en,
        'is_open', COALESCE(v_encuentro.is_open, false),
        'open_description', v_encuentro.open_description,
        'max_participants', v_encuentro.max_participants,
        'locality_id', v_encuentro.locality_id,
        'open_public_zone', v_encuentro.open_public_zone,
        'opened_at', v_encuentro.opened_at,
        'closed_at', v_encuentro.closed_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) TO authenticated, anon;

