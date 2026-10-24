-- ==============================================================================
-- Migración: 20261024210000_fix_session_user_administrative_regularization.sql
-- Fase V1 Mini-Sprint A — Micro-hotfix P0: Corrección de session_user en regularización
--
-- Objetivos de Seguridad:
-- 1. Eliminar 'current_user' en función SECURITY DEFINER:
--    - En PostgreSQL, 'current_user' conmuta al propietario ('postgres') dentro de SECURITY DEFINER.
--    - La identidad real de la sesión que abrió la conexión es 'session_user'.
-- 2. Contexto administrativo estrictamente verificado:
--    - Vía API web PostgREST: Requiere explícitamente v_caller_role = 'service_role'.
--    - Vía conexión directa del motor (pg_cron / DBA): Requiere session_user IN ('postgres', 'service_role')
--      SIN claims JWT activos, SIN rol de cliente web y SIN identidad de usuario.
-- 3. Modo fail-closed absoluto:
--    - Rol 'authenticated' sin claims JWT válidos (auth.uid() IS NULL) -> 'authentication_required'.
--    - Cuentas anónimas o rol 'anon' -> 'permanent_account_required'.
--    - Usuario autenticado con p_host_id ajeno -> 'forbidden'.
--    - Usuario autenticado con p_host_id NULL -> forzado a v_caller_id (cero barridos globales).
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
    v_jwt_claims JSONB := auth.jwt();
    v_has_jwt BOOLEAN := (v_jwt_claims IS NOT NULL AND v_jwt_claims <> '{}'::jsonb);
    v_caller_role TEXT := COALESCE(
        v_jwt_claims ->> 'role',
        NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
        ''
    );
    v_is_anon BOOLEAN := (
        v_caller_role = 'anon'
        OR COALESCE((v_jwt_claims ->> 'is_anonymous')::boolean, false)
    );
    -- Contexto administrativo interno estrictamente verificable:
    -- Requiere rol 'service_role' validado vía JWT, O
    -- conexión nativa de base de datos bajo 'postgres'/'service_role' (session_user, NO current_user)
    -- sin contexto de cliente web (sin JWT, sin rol de cliente y sin auth.uid()).
    v_is_internal BOOLEAN := (
        v_caller_role = 'service_role'
        OR (
            session_user IN ('postgres', 'service_role')
            AND v_caller_role = ''
            AND NOT v_has_jwt
            AND v_caller_id IS NULL
        )
    );
    v_target_host_id UUID;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_count INT := 0;
    v_rec RECORD;
BEGIN
    IF v_is_internal THEN
        -- Contexto interno administrativo verificado (pg_cron, worker o service_role)
        v_target_host_id := p_host_id;
    ELSE
        -- Cualquier solicitud que provenga de un cliente o contenga sesión de usuario:
        -- 1. Falla cerrado si no hay identidad verificable (auth.uid() IS NULL no autoriza nada)
        IF v_caller_id IS NULL THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
        END IF;

        -- 2. Falla cerrado ante cuentas anónimas temporales o rol anon
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
