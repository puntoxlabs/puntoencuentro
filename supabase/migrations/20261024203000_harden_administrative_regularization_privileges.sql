-- ==============================================================================
-- Migración: 20261024203000_harden_administrative_regularization_privileges.sql
-- Fase V1 Mini-Sprint A — Hardening de Seguridad P0 de Regularización Administrativa
--
-- Objetivos:
-- 1. Eliminación de vulnerabilidad fail-open:
--    - 'auth.uid() IS NULL' NUNCA debe otorgar privilegios administrativos ni habilitar barridos globales.
-- 2. Verificación inequívoca de contexto privilegiado interno:
--    - Solo se considera contexto interno si:
--      a) auth.jwt() ->> 'role' = 'service_role', O
--      b) Sesión de base de datos directa bajo 'postgres'/'service_role' SIN token JWT activo (pg_cron/mantenimiento).
-- 3. Modo fail-closed estricto para sesiones de usuario:
--    - Si no es contexto interno verificado y auth.uid() IS NULL: rechazo inmediato con 'authentication_required'.
--    - Si es sesión anónima: rechazo inmediato con 'permanent_account_required'.
--    - Si es usuario autenticado con p_host_id ajeno: rechazo inmediato con 'forbidden'.
--    - Si es usuario autenticado con p_host_id NULL: forzado estricto a v_caller_id (cero barridos globales).
-- 4. Permisos mínimos:
--    - Revocado explícitamente de PUBLIC y anon.
--    - Concedido únicamente a authenticated, postgres y service_role.
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.regularizar_cierres_administrativos_automaticos(
    p_host_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_caller_role TEXT := COALESCE(auth.jwt() ->> 'role', '');
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_has_jwt BOOLEAN := (auth.jwt() IS NOT NULL AND auth.jwt() <> '{}'::jsonb);
    -- Contexto interno privilegiado estrictamente verificable:
    -- Requiere explícitamente rol service_role vía JWT O ejecución directa del motor
    -- bajo 'postgres'/'service_role' sin contexto JWT de cliente web.
    v_is_internal BOOLEAN := (
        v_caller_role = 'service_role'
        OR (NOT v_has_jwt AND current_user IN ('postgres', 'service_role') AND v_caller_id IS NULL)
    );
    v_target_host_id UUID;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_count INT := 0;
    v_rec RECORD;
BEGIN
    IF v_is_internal THEN
        -- Contexto interno privilegiado verificado (pg_cron, scripts DBA o service_role)
        v_target_host_id := p_host_id;
    ELSE
        -- Cualquier solicitud que provenga de un cliente o contenga sesión de usuario:
        -- 1. Falla cerrado si no hay identidad verificable (auth.uid() IS NULL no autoriza nada)
        IF v_caller_id IS NULL THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
        END IF;

        -- 2. Falla cerrado ante cuentas anónimas temporales
        IF v_is_anon THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
        END IF;

        -- 3. Aislamiento estricto: rechaza intentos de regularizar organizadores ajenos
        IF p_host_id IS NOT NULL AND p_host_id <> v_caller_id THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'forbidden',
                'message', 'No tienes permiso para regularizar encuentros ajenos.'
            );
        END IF;

        -- 4. Forzar alcance exclusivamente al organizador autenticado (prohibido barrido global)
        v_target_host_id := v_caller_id;
    END IF;

    -- Regularizar exclusivamente encuentros sin participantes confirmados vencidos
    FOR v_rec IN
        SELECT e.id, e.host_id, e.post_event_closure_status
        FROM public.encuentros e
        WHERE e.estado = 'activo'
          AND e.opened_at IS NOT NULL
          AND e.post_event_closure_status IN ('pending', 'overdue')
          AND v_now > COALESCE(e.post_event_closure_deadline, public.calcular_vencimiento_cierre_encuentro(e.fecha, e.hora, e.duration_minutes))
          AND (v_target_host_id IS NULL OR e.host_id = v_target_host_id)
          AND NOT EXISTS (
              SELECT 1 FROM public.participantes p
              WHERE p.encuentro_id = e.id AND p.estado IN ('confirmado', 'asistio')
          )
        FOR UPDATE OF e
    LOOP
        UPDATE public.encuentros
        SET post_event_closure_status = 'auto_closed',
            post_event_closure_type = 'administrative_auto',
            post_event_closed_responsibly = false,
            post_event_realization_status = 'unconfirmed',
            post_event_closed_at = v_now
        WHERE id = v_rec.id;

        INSERT INTO public.encuentro_post_event_closure_audit (
            encuentro_id,
            host_id,
            previous_closure_status,
            new_closure_status,
            realization_status,
            closure_type,
            closed_responsibly,
            created_at
        ) VALUES (
            v_rec.id,
            v_rec.host_id,
            v_rec.post_event_closure_status,
            'auto_closed',
            'unconfirmed',
            'administrative_auto',
            false,
            v_now
        );

        v_count := v_count + 1;
    END LOOP;

    RETURN pg_catalog.json_build_object('ok', true, 'regularized_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.regularizar_cierres_administrativos_automaticos(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.regularizar_cierres_administrativos_automaticos(UUID) TO authenticated, postgres, service_role;

COMMIT;
