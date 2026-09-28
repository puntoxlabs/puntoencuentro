-- ============================================================
-- Migration: Harden Open Encounters 1.5 — Identity Security
-- 
-- Principios:
--   1. Identidad derivada exclusivamente de auth.uid()
--   2. Usuarios anónimos de Supabase rechazados en operaciones sociales
--   3. Parámetros p_host_id / p_usuario_id conservados en firma para
--      compatibilidad de despliegue, pero IGNORADOS como fuente de identidad.
--      Marcados como DEPRECATED: se eliminarán en migración posterior.
--   4. Grants reducidos al mínimo necesario.
--
-- NO modifica: get_detalle_host_seguro (compartida con flujo 1.0).
-- NO modifica: RPCs de creación/coordinación 1.0.
-- ============================================================

-- Helper macro inline: verifica si el JWT actual es de usuario anónimo de Supabase.
-- Nota: el claim 'is_anonymous' está incluido en el JWT de Supabase desde GoTrue v2.
-- Se castea a boolean con COALESCE para manejar JWTs sin el claim (permanentes).

-- ============================================================
-- 1. solicitar_sumarse_encuentro_abierto — HARDENED
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

-- Grant: solo 'authenticated'. El role anon no debe ejecutar esta RPC.
-- Nota: usuarios anónimos de Supabase pertenecen al role 'authenticated',
-- por lo que el control is_anonymous dentro de la función es obligatorio.
REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID)
    TO authenticated;

-- ============================================================
-- 2. abrir_encuentro_seguro — HARDENED
-- ============================================================
CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
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
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_confirmed_count INT := 0;
    v_locality_exists BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
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

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    TO authenticated;

-- ============================================================
-- 3. cerrar_encuentro_abierto_seguro — HARDENED
-- ============================================================
CREATE OR REPLACE FUNCTION public.cerrar_encuentro_abierto_seguro(
    p_encuentro_id UUID,
    p_host_id UUID   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
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
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
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

REVOKE ALL ON FUNCTION public.cerrar_encuentro_abierto_seguro(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cerrar_encuentro_abierto_seguro(UUID, UUID)
    TO authenticated;

-- ============================================================
-- 4. aprobar_solicitud_encuentro_abierto — HARDENED (mantiene FOR UPDATE concurrente)
-- ============================================================
CREATE OR REPLACE FUNCTION public.aprobar_solicitud_encuentro_abierto(
    p_request_id UUID,
    p_host_id UUID   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
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

    -- 3. Validar cupo real bajo bloqueo
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = v_encuentro.id AND estado = 'confirmado';

    IF (v_confirmed_count + 1) >= v_encuentro.max_participants THEN
        RETURN json_build_object('ok', false, 'error', 'quota_exceeded');
    END IF;

    -- 4. Crear participante regular
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

REVOKE ALL ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_encuentro_abierto(UUID, UUID)
    TO authenticated;

-- ============================================================
-- 5. rechazar_solicitud_encuentro_abierto — HARDENED
-- ============================================================
CREATE OR REPLACE FUNCTION public.rechazar_solicitud_encuentro_abierto(
    p_request_id UUID,
    p_host_id UUID   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
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
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
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

REVOKE ALL ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID)
    TO authenticated;

-- ============================================================
-- 6. get_solicitudes_host_seguro — HARDENED
-- Nota: token_participante se mantiene en la respuesta porque el host
-- legítimamente puede necesitarlo para notificar al participante aprobado.
-- El acceso ya está restringido a host autenticado permanente.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_solicitudes_host_seguro(
    p_encuentro_id UUID,
    p_host_id UUID   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
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
    v_result JSON;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
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

REVOKE ALL ON FUNCTION public.get_solicitudes_host_seguro(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_solicitudes_host_seguro(UUID, UUID)
    TO authenticated;

-- ============================================================
-- 7. get_mi_solicitud_encuentro_abierto — HARDENED
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_mi_solicitud_encuentro_abierto(
    p_encuentro_id UUID,
    p_usuario_id UUID   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
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
        RETURN json_build_object('ok', true, 'has_request', false);
    END IF;

    -- Nota: si el usuario es anónimo, no puede tener solicitudes (solicitar requiere permanente).
    -- Simplemente devolvemos has_request: false sin error.

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

REVOKE ALL ON FUNCTION public.get_mi_solicitud_encuentro_abierto(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mi_solicitud_encuentro_abierto(UUID, UUID)
    TO authenticated, anon;

-- ============================================================
-- 8. get_anonymous_upgrade_state — NUEVA RPC
-- Determina si un usuario anónimo tiene recursos críticos en backend
-- antes de hacer signOut para el upgrade Google OAuth.
-- Solo verifica existencia, nunca devuelve contenido sensible.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_anonymous_upgrade_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_has_encounters BOOLEAN := false;
    v_has_zones BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF NOT v_is_anon THEN
        -- Usuario permanente: no aplica upgrade
        RETURN json_build_object('ok', true, 'is_anonymous', false);
    END IF;

    -- Verificar encuentros como host
    SELECT EXISTS (
        SELECT 1 FROM public.encuentros
        WHERE host_id = v_user_id
        LIMIT 1
    ) INTO v_has_encounters;

    -- Verificar zonas sincronizadas
    SELECT EXISTS (
        SELECT 1 FROM public.usuario_localidades
        WHERE user_id = v_user_id
        LIMIT 1
    ) INTO v_has_zones;

    RETURN json_build_object(
        'ok', true,
        'is_anonymous', true,
        'has_owned_encounters', v_has_encounters,
        'has_server_zones', v_has_zones,
        'has_other_transferable_resources', false  -- extensible en el futuro
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_anonymous_upgrade_state()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_anonymous_upgrade_state()
    TO authenticated;

-- ============================================================
-- 9. RLS: verificar y agregar policies faltantes en solicitudes_encuentro_abierto
--
-- Estado previo: la tabla tiene RLS habilitado y REVOKE ALL.
-- No había políticas de SELECT/INSERT/UPDATE explícitas — el acceso
-- directo a la tabla es imposible para todos los roles.
-- Todo acceso debe ir por RPC SECURITY DEFINER. Eso es correcto.
--
-- Agregamos políticas mínimas de observabilidad para el propio solicitante
-- (vía authenticated), con protección is_anonymous.
-- ============================================================
DO $$
BEGIN
    -- Policy: solicitante puede leer SUS PROPIAS solicitudes (no las de otros)
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'solicitudes_encuentro_abierto'
          AND policyname = 'solicitudes_own_read_policy'
    ) THEN
        CREATE POLICY solicitudes_own_read_policy
            ON public.solicitudes_encuentro_abierto
            FOR SELECT
            TO authenticated
            USING (
                auth.uid() = usuario_id
                AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
            );
    END IF;
END $$;
