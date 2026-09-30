-- ==============================================================================
-- Migración: 20260930120000_fase_20c1_trust_applicant_profile.sql
-- Fase 2.0-C1 (T1): Ficha factual de actividad del solicitante
--
-- Proporciona al anfitrión de un Encuentro Abierto un DTO sanitizado y
-- estrictamente factual de la actividad previa del solicitante en la plataforma.
--
-- Invariantes:
-- 1. Identidad derivada exclusivamente de la solicitud (auth.uid() = host).
-- 2. Solo el anfitrión legítimo del encuentro puede consultar la ficha.
-- 3. Métricas agregadas basadas en hechos: solicitudes previas 'approved' en
--    encuentros pasados y aperturas pasadas demostrables.
-- 4. No infiere asistencia presencial ni expone datos privados.
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_perfil_confianza_solicitante(
    p_solicitud_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
    v_encuentro public.encuentros%ROWTYPE;
    v_applicant_id UUID;
    v_member_since_month TEXT;
    v_approved_previous INT := 0;
    v_hosted_previous INT := 0;
    v_no_prior_open_history BOOLEAN := true;
BEGIN
    -- 1. Control de autenticación y cuenta permanente
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 2. Validación de parámetro
    IF p_solicitud_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_request_id');
    END IF;

    -- 3. Cargar la solicitud
    SELECT * INTO v_solicitud
    FROM public.solicitudes_encuentro_abierto
    WHERE id = p_solicitud_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
    END IF;

    -- 4. Cargar el encuentro correspondiente
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = v_solicitud.encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    -- 5. Verificar que corresponda a un Encuentro Abierto
    IF v_encuentro.opened_at IS NULL AND v_encuentro.is_open <> true THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_open_encounter');
    END IF;

    -- 6. Verificar que auth.uid() sea el host legítimo del encuentro
    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 7. Identidad del solicitante derivada exclusivamente de la solicitud
    v_applicant_id := v_solicitud.usuario_id;
    IF v_applicant_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_applicant');
    END IF;

    -- 8. Antigüedad en PuntoEncuentro (precisión YYYY-MM desde auth.users.created_at)
    SELECT pg_catalog.to_char(u.created_at, 'YYYY-MM')
    INTO v_member_since_month
    FROM auth.users u
    WHERE u.id = v_applicant_id;

    -- 9. Conteo de Encuentros Abiertos pasados donde fue aceptado
    -- Excluye el encuentro actual y solo computa encuentros activos cuya fecha/hora ya transcurrieron.
    SELECT pg_catalog.count(DISTINCT s.encuentro_id)::INT
    INTO v_approved_previous
    FROM public.solicitudes_encuentro_abierto s
    JOIN public.encuentros e ON s.encuentro_id = e.id
    WHERE s.usuario_id = v_applicant_id
      AND s.estado = 'approved'
      AND s.encuentro_id <> v_encuentro.id
      AND e.estado = 'activo'
      AND (
          e.fecha < CURRENT_DATE
          OR (e.fecha = CURRENT_DATE AND (e.hora IS NULL OR e.hora < CURRENT_TIME))
      );

    v_approved_previous := COALESCE(v_approved_previous, 0);

    -- 10. Conteo de Encuentros Abiertos pasados organizados por el solicitante
    -- Requiere que el encuentro haya sido publicado como abierto (opened_at IS NOT NULL),
    -- esté activo, sea pasado y no sea el actual.
    SELECT pg_catalog.count(DISTINCT e.id)::INT
    INTO v_hosted_previous
    FROM public.encuentros e
    WHERE e.host_id = v_applicant_id
      AND e.id <> v_encuentro.id
      AND e.opened_at IS NOT NULL
      AND e.estado = 'activo'
      AND (
          e.fecha < CURRENT_DATE
          OR (e.fecha = CURRENT_DATE AND (e.hora IS NULL OR e.hora < CURRENT_TIME))
      );

    v_hosted_previous := COALESCE(v_hosted_previous, 0);

    -- 11. Indicador neutral de usuario sin historial previo en Encuentros Abiertos
    v_no_prior_open_history := (v_approved_previous = 0);

    -- 12. Devolver DTO estructurado sanitizado (sin textos en español, sin IDs personales ni datos de terceros)
    RETURN pg_catalog.json_build_object(
        'ok', true,
        'data', pg_catalog.json_build_object(
            'member_since_month', v_member_since_month,
            'approved_open_encounters_previous', v_approved_previous,
            'hosted_open_encounters_previous', v_hosted_previous,
            'no_prior_open_history', v_no_prior_open_history
        )
    );
END;
$$;

-- Permisos estrictos: solo usuarios autenticados permanentes
REVOKE ALL ON FUNCTION public.get_perfil_confianza_solicitante(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_perfil_confianza_solicitante(UUID) TO authenticated;

COMMIT;
