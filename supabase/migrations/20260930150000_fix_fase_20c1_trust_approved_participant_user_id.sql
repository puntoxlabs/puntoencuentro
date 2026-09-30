-- ==============================================================================
-- Migración: 20260930150000_fix_fase_20c1_trust_approved_participant_user_id.sql
-- Fase 2.0-C1 (T2-B2-P): Asignación de user_id a participantes de solicitudes aprobadas
--
-- Garantiza que al aprobar una solicitud de Encuentro Abierto, el participante creado
-- conserve el usuario_id del solicitante (participantes.user_id = v_solicitud.usuario_id),
-- permitiendo que el encuentro aparezca en el historial de "Participo" del solicitante
-- y habilitando la auditoría de identidad post-evento.
-- ==============================================================================

BEGIN;

-- 1. Backfill seguro e inequívoco de filas históricas aprobadas
UPDATE public.participantes p
SET user_id = s.usuario_id
FROM public.solicitudes_encuentro_abierto s
WHERE s.participante_id = p.id
  AND s.estado = 'approved'
  AND s.usuario_id IS NOT NULL
  AND p.user_id IS NULL;

-- 2. Redefinir aprobar_solicitud_encuentro_abierto para incluir user_id
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

COMMIT;
