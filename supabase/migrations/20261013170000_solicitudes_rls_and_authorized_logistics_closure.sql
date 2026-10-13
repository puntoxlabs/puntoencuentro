-- ============================================================
-- Migración: 20261013170000_solicitudes_rls_and_authorized_logistics_closure.sql
-- Microchecks A, B y C:
-- 1. RLS: Política de lectura para el solicitante en solicitudes_encuentro_abierto.
-- 2. Replica identity FULL para Realtime en solicitudes_encuentro_abierto.
-- 3. Reforzamiento estricto de privacidad en get_encuentro_participante_autorizado
--    (cero fallback a título/descripción privados del Host para participantes externos).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Política RLS de lectura para el solicitante
-- ------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'solicitudes_encuentro_abierto'
          AND policyname = 'solicitudes_applicant_read_policy'
    ) THEN
        CREATE POLICY solicitudes_applicant_read_policy
            ON public.solicitudes_encuentro_abierto
            FOR SELECT
            TO authenticated
            USING (
                solicitudes_encuentro_abierto.usuario_id = auth.uid()
                AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
            );
    END IF;
END $$;

-- Asegurar replica identity FULL para suscripciones Realtime
ALTER TABLE public.solicitudes_encuentro_abierto REPLICA IDENTITY FULL;


-- ------------------------------------------------------------
-- 2. get_encuentro_participante_autorizado
-- Reforzamiento estricto: participante NUNCA recibe título ni descripción privada del Host.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_encuentro_participante_autorizado(
    p_encuentro_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_is_host BOOLEAN := false;
    v_is_participant BOOLEAN := false;
    v_part_seats INT := 1;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    v_is_host := (v_encuentro.host_id = v_user_id);

    IF NOT v_is_host THEN
        -- Verificar si es participante confirmado o asistió
        SELECT EXISTS (
            SELECT 1 FROM public.participantes p
            WHERE p.encuentro_id = p_encuentro_id
              AND p.user_id = v_user_id
              AND p.estado IN ('confirmado', 'asistio')
        ) INTO v_is_participant;

        IF NOT v_is_participant THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        SELECT COALESCE(p.seat_count, 1) INTO v_part_seats
        FROM public.participantes p
        WHERE p.encuentro_id = p_encuentro_id
          AND p.user_id = v_user_id
          AND p.estado IN ('confirmado', 'asistio')
        LIMIT 1;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', v_encuentro.id,
        'is_host', v_is_host,
        'open_public_title', CASE
            WHEN v_is_host THEN COALESCE(v_encuentro.open_public_title, v_encuentro.titulo)
            ELSE COALESCE(v_encuentro.open_public_title, 'Encuentro')
        END,
        'open_description', CASE
            WHEN v_is_host THEN COALESCE(v_encuentro.open_description, v_encuentro.descripcion)
            ELSE COALESCE(v_encuentro.open_description, '')
        END,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'open_public_zone', v_encuentro.open_public_zone,
        'lugar_texto', CASE WHEN v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto ELSE NULL END,
        'link_virtual', CASE WHEN v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual ELSE NULL END,
        'seat_count', CASE WHEN v_is_host THEN NULL ELSE v_part_seats END,
        'estado', v_encuentro.estado
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_participante_autorizado(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentro_participante_autorizado(UUID) TO authenticated;

COMMIT;
