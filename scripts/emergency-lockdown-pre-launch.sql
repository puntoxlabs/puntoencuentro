-- ==============================================================================
-- Recuperación de Emergencia Fail-Closed (PRE-LAUNCH EMERGENCY LOCKDOWN)
-- Archivo: scripts/emergency-lockdown-pre-launch.sql
--
-- Propósito: Protocolo de contingencia de máxima severidad ante incidente de seguridad
-- o sospecha de compromiso durante la fase PRE-LAUNCH.
--
-- Acciones ejecutadas en una sola transacción atómica:
-- 1. Fuerza public_launch_active = false en public.platform_access_control.
-- 2. Registra el evento crítico en la bitácora inmutable de auditoría.
-- 3. Cierra la ingesta de creación y solicitudes revocando permisos a authenticated
--    y restringiéndolos exclusivamente a service_role y postgres.
-- ==============================================================================

BEGIN;

-- 1. Forzar estado PRE-LAUNCH cerrado
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'platform_access_control'
    ) THEN
        UPDATE public.platform_access_control
        SET setting_value = false,
            updated_at = pg_catalog.now()
        WHERE setting_key = 'public_launch_active';

        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'platform_access_control_audit'
        ) THEN
            INSERT INTO public.platform_access_control_audit (
                setting_key, previous_value, new_value, reason
            ) VALUES (
                'public_launch_active', true, false, 'EMERGENCY_LOCKDOWN_FAIL_CLOSED_TRIGGERED'
            );
        END IF;
    END IF;
END $$;

-- 2. Restringir temporalmente funciones de mutación sensible a nivel de permisos de motor
REVOKE EXECUTE ON FUNCTION public.crear_encuentro_seguro(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_seguro(jsonb) TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(uuid, text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(uuid, text, integer) TO service_role, postgres;

COMMIT;
