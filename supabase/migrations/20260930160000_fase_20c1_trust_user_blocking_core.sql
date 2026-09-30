-- ============================================================
-- Migración: 20260930160000_fase_20c1_trust_user_blocking_core.sql
-- Módulo: Fase 2.0-C1 Seguridad y Confianza — T3-A1
-- Entidad y núcleo seguro de bloqueo contextual entre usuarios
-- ============================================================

BEGIN;

-- 1. TABLA: public.bloqueos_usuario
CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
    blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT chk_bloqueos_no_self_block CHECK (blocker_id <> blocked_id)
);

-- 2. ÍNDICE INVERSO para búsquedas y filtros bilaterales de alto rendimiento
CREATE INDEX IF NOT EXISTS idx_bloqueos_usuario_reverse 
ON public.bloqueos_usuario (blocked_id, blocker_id);

-- 3. RLS Y PERMISOS ESTRICTOS
-- Preferencia P0: sin acceso directo para anon ni authenticated.
-- Toda operación y consulta se realiza mediante RPCs SECURITY DEFINER.
ALTER TABLE public.bloqueos_usuario ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.bloqueos_usuario FROM PUBLIC, anon, authenticated;

-- 4. RPC: bloquear_desde_solicitud_seguro
-- Deriva la contraparte desde una solicitud real de Encuentro Abierto.
-- Resuelve atómicamente todas las solicitudes pending entre ambas partes.
-- Limpia silenciosamente intereses mutuos en intenciones.
CREATE OR REPLACE FUNCTION public.bloquear_desde_solicitud_seguro(
    p_solicitud_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_blocker_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_solicitud RECORD;
    v_blocked_id UUID;
BEGIN
    -- 1. Validar autenticación
    IF v_blocker_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- 2. Rechazar cuentas anónimas (se requiere cuenta permanente)
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 3. Validar parámetro
    IF p_solicitud_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    -- 4. Obtener server-side solicitud y encuentro (con host_id y usuario_id reales)
    SELECT s.id, s.usuario_id, s.encuentro_id, e.host_id
    INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto s
    JOIN public.encuentros e ON e.id = s.encuentro_id
    WHERE s.id = p_solicitud_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    -- 5. Derivar contraparte server-side
    IF v_blocker_id = v_solicitud.host_id THEN
        -- El blocker es el HOST -> el bloqueado es el SOLICITANTE
        v_blocked_id := v_solicitud.usuario_id;
    ELSIF v_blocker_id = v_solicitud.usuario_id THEN
        -- El blocker es el SOLICITANTE -> el bloqueado es el HOST
        v_blocked_id := v_solicitud.host_id;
    ELSE
        -- Tercero sin relación legítima con la solicitud
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 6. Validar auto-bloqueo
    IF v_blocker_id = v_blocked_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_block_self');
    END IF;

    -- 7. Insertar bloqueo idempotente
    INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
    VALUES (v_blocker_id, v_blocked_id)
    ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

    -- 8. Resolver TODAS las solicitudes pending existentes entre ambas cuentas
    -- Caso A: blocker es HOST del encuentro -> solicitud de blocked pasa a rejected
    UPDATE public.solicitudes_encuentro_abierto s
    SET estado = 'rejected',
        resolved_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    FROM public.encuentros e
    WHERE s.encuentro_id = e.id
      AND s.estado = 'pending'
      AND e.host_id = v_blocker_id
      AND s.usuario_id = v_blocked_id;

    -- Caso B: blocker es SOLICITANTE -> su solicitud ante blocked pasa a withdrawn
    UPDATE public.solicitudes_encuentro_abierto s
    SET estado = 'withdrawn',
        resolved_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    FROM public.encuentros e
    WHERE s.encuentro_id = e.id
      AND s.estado = 'pending'
      AND e.host_id = v_blocked_id
      AND s.usuario_id = v_blocker_id;

    -- 9. Eliminar relaciones de interés en intenciones mutuas (en ambas direcciones)
    DELETE FROM public.intencion_intereses ii
    USING public.intenciones i
    WHERE ii.intencion_id = i.id
      AND (
        (ii.user_id = v_blocker_id AND i.user_id = v_blocked_id)
        OR
        (ii.user_id = v_blocked_id AND i.user_id = v_blocker_id)
      );

    -- 10. Retorno seguro (NUNCA expone v_blocked_id)
    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'blocked', true
    );
END;
$$;

-- 5. RPC: desbloquear_usuario_seguro
-- Elimina ÚNICAMENTE el bloqueo creado por el llamador.
CREATE OR REPLACE FUNCTION public.desbloquear_usuario_seguro(
    p_blocked_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_blocker_id UUID := auth.uid();
    v_is_anon BOOLEAN;
BEGIN
    IF v_blocker_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_blocked_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    DELETE FROM public.bloqueos_usuario
    WHERE blocker_id = v_blocker_id
      AND blocked_id = p_blocked_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'unblocked', true
    );
END;
$$;

-- 6. RPC: get_mis_bloqueos_seguro
-- Devuelve exclusivamente la lista de usuarios bloqueados por auth.uid().
-- Jamás expone si otros usuarios han bloqueado a auth.uid().
CREATE OR REPLACE FUNCTION public.get_mis_bloqueos_seguro()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_result JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'blocked_id', b.blocked_id,
            'created_at', b.created_at
        ) ORDER BY b.created_at DESC
    ), '[]'::jsonb)
    INTO v_result
    FROM public.bloqueos_usuario b
    WHERE b.blocker_id = v_user_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'bloqueos', v_result
    );
END;
$$;

-- 7. PERMISOS
REVOKE ALL ON FUNCTION public.bloquear_desde_solicitud_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bloquear_desde_solicitud_seguro(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.desbloquear_usuario_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.desbloquear_usuario_seguro(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.get_mis_bloqueos_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mis_bloqueos_seguro() TO authenticated;

COMMIT;
