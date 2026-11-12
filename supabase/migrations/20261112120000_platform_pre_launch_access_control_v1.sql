-- ==============================================================================
-- Migración Aditiva: Control Centralizado de Acceso Pre-Lanzamiento (Etapa 1)
-- Timestamp: 20261112120000
-- Archivo: 20261112120000_platform_pre_launch_access_control_v1.sql
--
-- Principios de Seguridad e Invariantes:
-- 1. Cerrado por defecto (Fail-Closed): la plataforma inicia con 'public_launch_active' = false.
-- 2. Entidad independiente (platform_access_control): desacoplada de domain_migration_settings.
-- 3. Autorización server-side estricta: evalúa public.qa_authorized_users vía is_qa_authorized().
--    Cero confianza en parámetros enviados por el cliente.
-- 4. Soporte para QA anónimo y permanente: permite a usuarios sintéticos de pruebas
--    (tanto anónimos como permanentes) expresamente registrados en qa_authorized_users
--    probar la creación y discovery, mientras bloquea a usuarios externos o anónimos no listados.
-- 5. Cero filtración por rutas alternativas: endurece Discovery (encuentros e intenciones),
--    ficha de encuentro abierto, creación y solicitudes.
-- 6. Preservación estricta de contratos: no altera tipos de retorno, nombres ni parámetros.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. TABLA: public.platform_access_control
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.platform_access_control (
    setting_key TEXT PRIMARY KEY,
    setting_value BOOLEAN NOT NULL DEFAULT false,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.platform_access_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_access_control FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.platform_access_control TO postgres, service_role;

-- Inicialización Segura: CERRADO por defecto (Fail-closed)
-- Si la fila ya existe con valor 'true' (contradictorio con PRE-LAUNCH), ABORTAR la transacción.
DO $$
DECLARE
    v_existing_val BOOLEAN;
BEGIN
    SELECT setting_value INTO v_existing_val
    FROM public.platform_access_control
    WHERE setting_key = 'public_launch_active';

    IF v_existing_val IS NULL THEN
        INSERT INTO public.platform_access_control (setting_key, setting_value, description)
        VALUES (
            'public_launch_active',
            false,
            'Indica si la plataforma está oficialmente abierta al público general. False = Modo PRE-LAUNCH hermético.'
        );
    ELSIF v_existing_val = true THEN
        RAISE EXCEPTION 'INCONSISTENCIA CRÍTICA: public.platform_access_control ya tiene public_launch_active = true. En fase PRE-LAUNCH la plataforma debe estar cerrada (false). Abortando migración.';
    END IF;
END $$;


-- ==============================================================================
-- 2. TABLA: public.platform_access_control_audit
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.platform_access_control_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    setting_key TEXT NOT NULL,
    previous_value BOOLEAN,
    new_value BOOLEAN NOT NULL,
    changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.platform_access_control_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_access_control_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.platform_access_control_audit TO postgres, service_role;

-- Protección de Inmutabilidad Estricta: Prohibir UPDATE o DELETE sobre la bitácora
CREATE OR REPLACE FUNCTION public.prevent_platform_audit_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'platform_access_control_audit es una tabla inmutable; no se permiten modificaciones, eliminaciones ni truncados.';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_platform_access_control_audit ON public.platform_access_control_audit;
CREATE TRIGGER trg_protect_platform_access_control_audit
BEFORE UPDATE OR DELETE ON public.platform_access_control_audit
FOR EACH ROW EXECUTE FUNCTION public.prevent_platform_audit_tampering();

DROP TRIGGER IF EXISTS trg_protect_platform_access_control_audit_truncate ON public.platform_access_control_audit;
CREATE TRIGGER trg_protect_platform_access_control_audit_truncate
BEFORE TRUNCATE ON public.platform_access_control_audit
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_platform_audit_tampering();


-- ==============================================================================
-- 2.1. TABLA: public.platform_launch_authorizations
-- Diferenciación de Autorización: Personal autorizado para apertura pública vs QA
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.platform_launch_authorizations (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('launch_manager', 'emergency_operator')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.platform_launch_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_launch_authorizations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.platform_launch_authorizations TO postgres, service_role;


-- ==============================================================================
-- 3. FUNCIONES DE EVALUACIÓN DE ESTADO (FAIL-CLOSED)
-- ==============================================================================

-- 3.1. Consulta de Estado de Apertura
CREATE OR REPLACE FUNCTION public.is_public_launch_open()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_is_open boolean := false;
BEGIN
    SELECT setting_value INTO v_is_open
    FROM public.platform_access_control
    WHERE setting_key = 'public_launch_active';

    RETURN COALESCE(v_is_open, false);
EXCEPTION WHEN OTHERS THEN
    RETURN false; -- Fail-closed ante cualquier error
END;
$$;

REVOKE ALL ON FUNCTION public.is_public_launch_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_public_launch_open() TO anon, authenticated, postgres, service_role;


-- 3.2. Consulta de Acceso a Pre-Lanzamiento (Reutiliza public.qa_authorized_users)
CREATE OR REPLACE FUNCTION public.can_access_pre_launch()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- 1. Si la plataforma ya fue abierta oficialmente al público, todos tienen acceso
    IF public.is_public_launch_open() THEN
        RETURN true;
    END IF;

    -- 2. En pre-lanzamiento, SOLO usuarios autorizados de QA/Admin pueden operar
    -- (Consulta directamente public.qa_authorized_users mediante is_qa_authorized().
    -- Admite tanto identidades permanentes como sesiones sintéticas anónimas debidamente registradas).
    RETURN public.is_qa_authorized();
EXCEPTION WHEN OTHERS THEN
    RETURN false; -- Fail-closed
END;
$$;

REVOKE ALL ON FUNCTION public.can_access_pre_launch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_pre_launch() TO anon, authenticated, postgres, service_role;


-- 3.3. Transición Controlada y Auditable de Fase (Diferenciación Estricta de Roles)
CREATE OR REPLACE FUNCTION public.set_platform_launch_phase(
    p_active BOOLEAN,
    p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_caller_role TEXT := NULL;
    v_prev BOOLEAN;
    v_is_service_role BOOLEAN := false;
BEGIN
    -- 1. IDENTIDAD SERVER-SIDE: Verificar quién invoca
    IF v_uid IS NULL THEN
        -- Comprobar si es invocación interna autenticada por service_role
        v_is_service_role := (COALESCE(pg_catalog.current_setting('request.jwt.claim.role', true), '') = 'service_role');
        IF v_is_service_role THEN
            v_caller_role := 'service_role';
        ELSE
            -- Llamada anónima o sin identidad: RECHAZO INMEDIATO
            RETURN pg_catalog.jsonb_build_object(
                'ok', false,
                'error', 'authentication_required',
                'message', 'Se requiere una identidad autenticada para invocar el control de fase de plataforma.'
            );
        END IF;
    ELSE
        -- 2. IDENTIDAD AUTENTICADA: Comprobar roles habilitados
        -- A. Comprobar si está en platform_launch_authorizations
        SELECT role INTO v_caller_role
        FROM public.platform_launch_authorizations
        WHERE user_id = v_uid AND is_active = true;

        -- B. Si no está en launch authorizations, comprobar si es un QA admin en qa_authorized_users
        IF v_caller_role IS NULL THEN
            IF EXISTS (
                SELECT 1 FROM public.qa_authorized_users
                WHERE user_id = v_uid AND role = 'admin'
            ) THEN
                v_caller_role := 'qa_admin';
            END IF;
        END IF;
    END IF;

    -- Si la identidad no pertenece a ningún rol habilitado: RECHAZO
    IF v_caller_role IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'unauthorized_operator',
            'message', 'La identidad no posee permisos administrativos sobre el control de fase de plataforma.'
        );
    END IF;

    -- 3. VALIDACIÓN DE OPERACIÓN SEGÚN ROL:
    -- A. Para APERTURA PÚBLICA (p_active = true):
    -- ESTRICTAMENTE RESERVADO a 'launch_manager' o 'service_role'.
    -- Las cuentas habituales de QA (incluso qa_admin) tienen PROHIBIDA la apertura pública.
    IF p_active = true THEN
        IF v_caller_role NOT IN ('launch_manager', 'service_role') THEN
            RETURN pg_catalog.jsonb_build_object(
                'ok', false,
                'error', 'launch_authorization_required',
                'message', 'Las cuentas de QA, incluyendo administradores de QA, no tienen permisos para abrir públicamente la plataforma. Esta operación requiere autorización explícita de lanzamiento (launch_manager).'
            );
        END IF;
    END IF;

    -- B. Para CIERRE DE EMERGENCIA / PRE-LANZAMIENTO (p_active = false):
    -- Permitido a 'launch_manager', 'emergency_operator', 'service_role' y 'qa_admin'.

    -- 4. VALIDACIÓN DE JUSTIFICACIÓN
    IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) < 5 THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'invalid_reason_length',
            'message', 'Debe especificarse una justificación válida de al menos 5 caracteres.'
        );
    END IF;

    -- 5. TRANSICIÓN ATÓMICA CON BLOQUEO FOR UPDATE
    SELECT setting_value INTO v_prev
    FROM public.platform_access_control
    WHERE setting_key = 'public_launch_active'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'setting_not_found',
            'message', 'No se encontró el registro public_launch_active en platform_access_control.'
        );
    END IF;

    UPDATE public.platform_access_control
    SET setting_value = p_active,
        updated_at = pg_catalog.now(),
        updated_by = v_uid
    WHERE setting_key = 'public_launch_active';

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'update_failed',
            'message', 'No se pudo actualizar la configuración de fase de plataforma.'
        );
    END IF;

    -- 6. AUDITORÍA INMUTABLE
    INSERT INTO public.platform_access_control_audit (
        setting_key, previous_value, new_value, changed_by, reason
    ) VALUES (
        'public_launch_active', v_prev, p_active, v_uid, pg_catalog.btrim(p_reason)
    );

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'previous_value', v_prev,
        'new_value', p_active,
        'caller_role', v_caller_role,
        'changed_at', pg_catalog.now()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_platform_launch_phase(BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_platform_launch_phase(BOOLEAN, TEXT) TO authenticated, postgres, service_role;


-- ==============================================================================
-- 4. CHOKE-POINTS: ENDURECIMIENTO DE DISCOVERY DURANTE PRE-LANZAMIENTO
-- ==============================================================================

-- 4.1. get_discovery_encuentros_abiertos
CREATE OR REPLACE FUNCTION public.get_discovery_encuentros_abiertos(
    p_locality_ids TEXT[] DEFAULT NULL,
    p_only_available BOOLEAN DEFAULT false
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_blocked_host_ids UUID[] := '{}';
    v_result JSON;
BEGIN
    -- GUARDA PRE-LANZAMIENTO: Si no está en público y no es QA autorizado, retorna lista vacía
    IF NOT public.can_access_pre_launch() THEN
        RETURN '[]'::json;
    END IF;

    IF v_user_id IS NOT NULL THEN
        SELECT COALESCE(pg_catalog.array_agg(DISTINCT blocked_user_id), '{}')
        INTO v_blocked_host_ids
        FROM (
            SELECT blocked_id AS blocked_user_id
            FROM public.bloqueos_usuario
            WHERE blocker_id = v_user_id
            UNION
            SELECT blocker_id AS blocked_user_id
            FROM public.bloqueos_usuario
            WHERE blocked_id = v_user_id
        ) b;
    END IF;

    SELECT pg_catalog.json_agg(row_data) INTO v_result
    FROM (
        SELECT
            e.id,
            e.open_public_title AS title,
            e.open_description AS description,
            e.fecha,
            e.hora,
            e.modalidad,
            e.max_participants AS slots,
            e.max_participants AS public_capacity,
            COALESCE(e.allow_multi_seat_requests, false) AS allow_multi_seat_requests,
            COALESCE(e.max_seats_per_request, 1) AS max_seats_per_request,
            COALESCE(e.min_seats_per_request, 1) AS min_seats_per_request,
            e.min_participants,
            COALESCE(e.realization_status, 'pending') AS realization_status,
            COALESCE(e.inscriptions_closed, false) AS inscriptions_closed,
            (v_user_id IS NOT NULL AND e.host_id = v_user_id) AS is_host,
            e.locality_id,
            e.open_public_zone,
            COALESCE(e.open_public_zone, l.nombre, 'Sin zona') AS approximate_zone,
            e.host_id,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_count,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_seats,
            COALESCE(p_agg.confirmed_requests, 0) AS confirmed_requests,
            COALESCE(w_agg.reserved_seats, 0) AS reserved_waitlist_seats,
            COALESCE(w_agg.waiting_count, 0) AS waitlist_count,
            GREATEST(0, e.max_participants - (COALESCE(p_agg.confirmed_seats, 0) + COALESCE(w_agg.reserved_seats, 0))) AS open_slots,
            CASE
                WHEN e.fecha IS NULL THEN 'Fecha a coordinar'
                ELSE pg_catalog.to_char(e.fecha, 'DD/MM/YYYY')
            END AS date_label,
            CASE
                WHEN e.hora IS NULL THEN 'Horario a coordinar'
                ELSE pg_catalog.to_char(e.hora, 'HH24:MI')
            END AS time_label,
            e.opened_at,
            e.tema,
            e.tema_invitacion,
            e.open_activity_canonical,
            e.open_activity_matching_eligible
        FROM public.encuentros e
        LEFT JOIN public.localidades l ON l.id = e.locality_id
        LEFT JOIN (
            SELECT
                encuentro_id,
                COALESCE(pg_catalog.sum(seat_count), 0)::int AS confirmed_seats,
                pg_catalog.count(*)::int AS confirmed_requests
            FROM public.participantes
            WHERE estado IN ('confirmado', 'asistio')
            GROUP BY encuentro_id
        ) p_agg ON p_agg.encuentro_id = e.id
        LEFT JOIN (
            SELECT
                encuentro_id,
                COALESCE(pg_catalog.sum(CASE WHEN estado IN ('waitlist_offered', 'waitlist_confirmed') THEN seat_count ELSE 0 END), 0)::int AS reserved_seats,
                COALESCE(pg_catalog.sum(CASE WHEN estado = 'waitlist_waiting' THEN 1 ELSE 0 END), 0)::int AS waiting_count
            FROM public.solicitudes_encuentro_abierto
            WHERE estado IN ('waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
            GROUP BY encuentro_id
        ) w_agg ON w_agg.encuentro_id = e.id
        WHERE e.is_open = true
          AND e.estado <> 'cancelado'
          AND e.moderation_status = 'approved'
          AND (
              e.fecha IS NULL
              OR e.fecha > (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::date
              OR (
                  e.fecha = (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::date
                  AND (
                      e.hora IS NULL
                      OR e.hora >= (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::time
                  )
              )
          )
          AND (v_user_id IS NULL OR e.host_id <> ALL(v_blocked_host_ids))
          AND (
              p_locality_ids IS NULL
              OR cardinality(p_locality_ids) = 0
              OR e.locality_id = ANY(p_locality_ids)
              OR e.modalidad = 'virtual'
          )
          AND (
              p_only_available = false
              OR (
                  COALESCE(e.inscriptions_closed, false) = false
                  AND GREATEST(0, e.max_participants - (COALESCE(p_agg.confirmed_seats, 0) + COALESCE(w_agg.reserved_seats, 0))) >= COALESCE(e.min_seats_per_request, 1)
              )
          )
        ORDER BY
            CASE WHEN e.fecha IS NULL THEN 1 ELSE 0 END,
            e.fecha ASC NULLS LAST,
            e.hora ASC NULLS LAST,
            e.opened_at DESC,
            e.id ASC
        LIMIT 50
    ) row_data;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[], BOOLEAN) TO anon, authenticated, postgres, service_role;


-- 4.2. get_discovery_intenciones_activas
CREATE OR REPLACE FUNCTION public.get_discovery_intenciones_activas(
    p_locality_ids TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_viewer_id UUID := auth.uid();
    v_is_anon BOOLEAN := (v_viewer_id IS NULL) OR COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_result JSONB;
BEGIN
    -- GUARDA PRE-LANZAMIENTO:
    IF NOT public.can_access_pre_launch() THEN
        RETURN '[]'::jsonb;
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', i.id,
            'titulo', i.titulo,
            'descripcion', i.descripcion,
            'temporalidad_texto', i.temporalidad_texto,
            'fecha_desde', i.fecha_desde,
            'fecha_hasta', i.fecha_hasta,
            'modalidad', i.modalidad,
            'locality_id', i.locality_id,
            'approximate_zone', COALESCE(l.nombre, 'Zona aproximada'),
            'interested_count', COALESCE((
                SELECT pg_catalog.count(*)::int
                FROM public.intencion_intereses ii
                WHERE ii.intencion_id = i.id
            ), 0),
            'created_at', i.created_at,
            'is_own', CASE WHEN v_is_anon THEN false ELSE (i.user_id = v_viewer_id) END,
            'viewer_interested', CASE WHEN v_is_anon THEN false ELSE EXISTS(
                SELECT 1
                FROM public.intencion_intereses ii
                WHERE ii.intencion_id = i.id AND ii.user_id = v_viewer_id
            ) END
        ) ORDER BY i.created_at DESC
    ), '[]'::jsonb)
    INTO v_result
    FROM public.intenciones i
    LEFT JOIN public.localidades l ON l.id = i.locality_id
    WHERE i.estado = 'activa'
      AND (
          i.fecha_hasta IS NULL
          OR i.fecha_hasta >= (pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      )
      AND (
          i.modalidad = 'virtual'
          OR i.locality_id IS NULL
          OR l.activo = true
      )
      AND (
          p_locality_ids IS NULL
          OR pg_catalog.array_length(p_locality_ids, 1) IS NULL
          OR i.modalidad = 'virtual'
          OR (i.locality_id = ANY(p_locality_ids) AND l.activo = true)
      )
      AND (
          v_viewer_id IS NULL
          OR NOT EXISTS (
              SELECT 1 FROM public.bloqueos_usuario b
              WHERE (b.blocker_id = v_viewer_id AND b.blocked_id = i.user_id)
                 OR (b.blocker_id = i.user_id AND b.blocked_id = v_viewer_id)
          )
      );

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) TO anon, authenticated, postgres, service_role;


-- 4.3. get_encuentro_abierto_publico
CREATE OR REPLACE FUNCTION public.get_encuentro_abierto_publico(p_encuentro_id uuid)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_blocked_host_ids UUID[] := '{}';
    v_result JSON;
BEGIN
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_id');
    END IF;

    -- GUARDA PRE-LANZAMIENTO:
    IF NOT public.can_access_pre_launch() THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'pre_launch_restricted');
    END IF;

    IF v_user_id IS NOT NULL THEN
        SELECT COALESCE(pg_catalog.array_agg(DISTINCT blocked_user_id), '{}')
        INTO v_blocked_host_ids
        FROM (
            SELECT blocked_id AS blocked_user_id
            FROM public.bloqueos_usuario
            WHERE blocker_id = v_user_id
            UNION
            SELECT blocker_id AS blocked_user_id
            FROM public.bloqueos_usuario
            WHERE blocked_id = v_user_id
        ) b;
    END IF;

    SELECT pg_catalog.row_to_json(row_data) INTO v_result
    FROM (
        SELECT
            e.id,
            e.open_public_title AS title,
            e.open_description AS description,
            e.fecha,
            e.hora,
            e.modalidad,
            e.max_participants AS slots,
            e.max_participants AS public_capacity,
            COALESCE(e.allow_multi_seat_requests, false) AS allow_multi_seat_requests,
            COALESCE(e.max_seats_per_request, 1) AS max_seats_per_request,
            COALESCE(e.min_seats_per_request, 1) AS min_seats_per_request,
            e.min_participants,
            COALESCE(e.realization_status, 'pending') AS realization_status,
            COALESCE(e.inscriptions_closed, false) AS inscriptions_closed,
            (v_user_id IS NOT NULL AND e.host_id = v_user_id) AS is_host,
            e.locality_id,
            e.open_public_zone,
            COALESCE(e.open_public_zone, l.nombre, CASE WHEN e.modalidad = 'virtual' THEN 'Online' ELSE 'Sin zona' END) AS approximate_zone,
            e.host_id,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_count,
            COALESCE(p_agg.confirmed_seats, 0) AS confirmed_seats,
            COALESCE(p_agg.confirmed_requests, 0) AS confirmed_requests,
            COALESCE(w_agg.reserved_seats, 0) AS reserved_waitlist_seats,
            COALESCE(w_agg.waiting_count, 0) AS waitlist_count,
            GREATEST(0, e.max_participants - (COALESCE(p_agg.confirmed_seats, 0) + COALESCE(w_agg.reserved_seats, 0))) AS open_slots,
            CASE
                WHEN e.fecha IS NULL THEN 'Fecha a coordinar'
                ELSE pg_catalog.to_char(e.fecha, 'DD/MM/YYYY')
            END AS date_label,
            CASE
                WHEN e.hora IS NULL THEN 'Horario a coordinar'
                ELSE pg_catalog.to_char(e.hora, 'HH24:MI')
            END AS time_label,
            e.opened_at,
            e.tema,
            e.tema_invitacion,
            e.open_activity_canonical,
            e.open_activity_matching_eligible
        FROM public.encuentros e
        LEFT JOIN public.localidades l ON l.id = e.locality_id
        LEFT JOIN (
            SELECT
                encuentro_id,
                COALESCE(pg_catalog.sum(seat_count), 0)::int AS confirmed_seats,
                pg_catalog.count(*)::int AS confirmed_requests
            FROM public.participantes
            WHERE estado IN ('confirmado', 'asistio')
            GROUP BY encuentro_id
        ) p_agg ON p_agg.encuentro_id = e.id
        LEFT JOIN (
            SELECT
                encuentro_id,
                COALESCE(pg_catalog.sum(CASE WHEN estado IN ('waitlist_offered', 'waitlist_confirmed') THEN seat_count ELSE 0 END), 0)::int AS reserved_seats,
                COALESCE(pg_catalog.sum(CASE WHEN estado = 'waitlist_waiting' THEN 1 ELSE 0 END), 0)::int AS waiting_count
            FROM public.solicitudes_encuentro_abierto
            WHERE estado IN ('waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed')
            GROUP BY encuentro_id
        ) w_agg ON w_agg.encuentro_id = e.id
        WHERE e.id = p_encuentro_id
          AND e.is_open = true
          AND e.estado <> 'cancelado'
          AND e.moderation_status = 'approved'
          AND (
              e.fecha IS NULL
              OR e.fecha > (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::date
              OR (
                  e.fecha = (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::date
                  AND (
                      e.hora IS NULL
                      OR e.hora >= (pg_catalog.timezone('America/Argentina/Buenos_Aires', pg_catalog.now()))::time
                  )
              )
          )
          AND (v_user_id IS NULL OR e.host_id <> ALL(v_blocked_host_ids))
        LIMIT 1
    ) row_data;

    IF v_result IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    RETURN pg_catalog.json_build_object('ok', true, 'data', v_result);
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_abierto_publico(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentro_abierto_publico(uuid) TO anon, authenticated, postgres, service_role;


-- ==============================================================================
-- 5. CHOKE-POINT: CREACIÓN DE ENCUENTROS DURANTE PRE-LANZAMIENTO
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.crear_encuentro_seguro(p_data jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id          uuid := auth.uid();
    v_is_anon          boolean := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_id               uuid;
    v_token            uuid;
    v_result           json;
    v_tema_invitacion  text;
    v_post_minutes     integer;
    v_post_raw         text;
    v_rl               jsonb;
    v_priv_eval        record;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    -- GUARDA PRE-LANZAMIENTO:
    -- En pre-lanzamiento, SOLO usuarios autorizados de QA pueden crear encuentros.
    -- La verificación server-side evalúa public.is_qa_authorized() sobre auth.uid().
    -- Permite tanto cuentas permanentes como sesiones sintéticas anónimas de pruebas que
    -- hayan sido debidamente registradas en public.qa_authorized_users por los runners de test,
    -- mientras bloquea a usuarios externos o sesiones anónimas públicas no autorizadas.
    IF NOT public.is_public_launch_open() THEN
        IF NOT public.is_qa_authorized() THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'pre_launch_creation_restricted',
                'message', 'La creación de encuentros está restringida a usuarios de pruebas autorizados durante el pre-lanzamiento.'
            );
        END IF;
    END IF;

    -- Exclusión mutua y guardia para sesiones anónimas migradas
    IF v_is_anon THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('pe_identity_mutation:' || v_user_id::text)
        );
        IF public.is_retired_anonymous_source(v_user_id) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'anonymous_session_already_migrated');
        END IF;
    END IF;

    -- Validaciones determinísticas de payload
    v_id    := COALESCE((p_data->>'id')::uuid, gen_random_uuid());
    v_token := COALESCE((p_data->>'public_token')::uuid, gen_random_uuid());

    -- Piso mínimo antiabuso de plataforma para invitaciones compartibles por link
    IF p_data ? 'tipo_invitacion' AND (p_data->>'tipo_invitacion') = 'link_general' THEN
        SELECT * INTO v_priv_eval FROM public.evaluar_antiabuso_privado_determinista(p_data->>'titulo', p_data->>'descripcion');
        IF NOT v_priv_eval.allowed THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'private_content_blocked',
                'reason', v_priv_eval.reason,
                'message', 'El contenido de la invitación no cumple con las pautas de seguridad de la plataforma.'
            );
        END IF;
    END IF;

    v_tema_invitacion := CASE
        WHEN p_data->>'tema_invitacion' IN (
            'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
            'family', 'special', 'romantic', 'sports', 'entertainment',
            'learning', 'wellness', 'custom'
        )
        THEN p_data->>'tema_invitacion'
        ELSE 'classic'
    END;

    v_post_raw := p_data->>'post_event_active_minutes';
    IF v_post_raw IS NOT NULL THEN
        BEGIN
            v_post_minutes := v_post_raw::integer;
        EXCEPTION WHEN OTHERS THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END;
        IF v_post_minutes < 0 OR v_post_minutes > 1440 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_post_event_active_minutes');
        END IF;
    ELSE
        v_post_minutes := 45;
    END IF;

    -- Rate limiter
    v_rl := public.check_rate_limit_internal('create_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- Mutación productiva
    INSERT INTO public.encuentros (
        id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, link_virtual,
        tipo_invitacion, host_id, public_token, estado, tema, tema_invitacion,
        invitation_template, post_event_active_minutes
    )
    VALUES (
        v_id,
        p_data->>'titulo',
        p_data->>'descripcion',
        (p_data->>'fecha')::date,
        (p_data->>'hora')::time,
        p_data->>'modalidad',
        p_data->>'lugar_texto',
        p_data->>'link_virtual',
        p_data->>'tipo_invitacion',
        v_user_id,
        v_token,
        'activo',
        'blue',
        v_tema_invitacion,
        p_data->>'invitation_template',
        v_post_minutes
    )
    RETURNING
        pg_catalog.json_build_object(
            'ok', true,
            'id', id,
            'public_token', public_token
        ) INTO v_result;

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.crear_encuentro_seguro(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_seguro(jsonb) TO anon, authenticated, postgres, service_role;


-- ==============================================================================
-- 6. CHOKE-POINT: SOLICITAR SUMARSE A ENCUENTRO ABIERTO
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.solicitar_sumarse_encuentro_abierto(
    p_encuentro_id UUID,
    p_nombre TEXT,
    p_mensaje TEXT DEFAULT NULL,
    p_usuario_id UUID DEFAULT NULL,
    p_seat_count INT DEFAULT 1
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
    v_confirmed_seats INT := 0;
    v_reserved_seats INT := 0;
    v_solicitud_id UUID;
    v_clean_nombre TEXT;
    v_rejected_at TIMESTAMPTZ;
    v_rl JSONB;
    v_effective_seat_count INT := 1;
    v_available_seats INT;
    v_notif_body TEXT;
    v_min_seats INT := 1;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- GUARDA PRE-LANZAMIENTO:
    IF NOT public.can_access_pre_launch() THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'pre_launch_restricted',
            'message', 'Las solicitudes para sumarse están restringidas a usuarios de pruebas autorizados durante el pre-lanzamiento.'
        );
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_clean_nombre := pg_catalog.btrim(COALESCE(p_nombre, ''));
    IF pg_catalog.length(v_clean_nombre) < 2 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_name');
    END IF;

    -- Concurrencia: FOR SHARE bloquea lectura stale
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    IF NOT v_encuentro.is_open THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_an_open_encounter');
    END IF;

    IF v_encuentro.estado = 'cancelado' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_cancelled');
    END IF;

    IF v_encuentro.moderation_status <> 'approved' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_approved');
    END IF;

    IF COALESCE(v_encuentro.inscriptions_closed, false) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'inscriptions_closed');
    END IF;

    IF v_encuentro.host_id = v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_join_own_encounter');
    END IF;

    -- Validar temporalidad en timezone de Argentina
    IF (v_encuentro.fecha IS NOT NULL AND v_encuentro.fecha < (pg_catalog.timezone('America/Argentina/Buenos_Aires', v_now))::date)
       OR (v_encuentro.fecha = (pg_catalog.timezone('America/Argentina/Buenos_Aires', v_now))::date
           AND v_encuentro.hora IS NOT NULL
           AND v_encuentro.hora < (pg_catalog.timezone('America/Argentina/Buenos_Aires', v_now))::time)
    THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_expired');
    END IF;

    -- Multi-seat validation
    IF COALESCE(v_encuentro.allow_multi_seat_requests, false) THEN
        v_min_seats := COALESCE(v_encuentro.min_seats_per_request, 1);
        v_effective_seat_count := COALESCE(p_seat_count, 1);
        IF v_effective_seat_count < v_min_seats OR v_effective_seat_count > COALESCE(v_encuentro.max_seats_per_request, 1) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_seat_count');
        END IF;
    ELSE
        v_effective_seat_count := 1;
    END IF;

    -- Rate limit
    v_rl := public.check_rate_limit_internal('request_open_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    -- Cooldown de rechazos
    SELECT updated_at INTO v_rejected_at
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id
      AND usuario_id = v_user_id
      AND estado = 'rechazada'
    ORDER BY updated_at DESC
    LIMIT 1;

    IF v_rejected_at IS NOT NULL AND (v_now - v_rejected_at) < INTERVAL '24 hours' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_cooldown_active');
    END IF;

    -- Estado de cupos
    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    SELECT COALESCE(pg_catalog.sum(CASE WHEN estado IN ('waitlist_offered', 'waitlist_confirmed') THEN seat_count ELSE 0 END), 0)::int
    INTO v_reserved_seats
    FROM public.solicitudes_encuentro_abierto
    WHERE encuentro_id = p_encuentro_id;

    v_available_seats := GREATEST(0, v_encuentro.max_participants - (v_confirmed_seats + v_reserved_seats));

    IF v_available_seats < v_effective_seat_count THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'capacity_exceeded');
    END IF;

    INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id, usuario_id, nombre_solicitante, mensaje, seat_count, estado, created_at, updated_at
    )
    VALUES (
        p_encuentro_id, v_user_id, v_clean_nombre, p_mensaje, v_effective_seat_count, 'pendiente', v_now, v_now
    )
    ON CONFLICT (encuentro_id, usuario_id) DO UPDATE SET
        nombre_solicitante = EXCLUDED.nombre_solicitante,
        mensaje = EXCLUDED.mensaje,
        seat_count = EXCLUDED.seat_count,
        estado = 'pendiente',
        motivo_baja = NULL,
        resolved_at = NULL,
        updated_at = v_now
    RETURNING id INTO v_solicitud_id;

    -- Notificación al host
    v_notif_body := CASE
        WHEN v_effective_seat_count > 1 THEN v_clean_nombre || ' solicitó ' || v_effective_seat_count::text || ' lugares para tu encuentro abierto.'
        ELSE v_clean_nombre || ' solicitó sumarse a tu encuentro abierto.'
    END;

    PERFORM public.insertar_inbox_notification_seguro(
        v_encuentro.host_id,
        'solicitud_recibida',
        'encounter',
        p_encuentro_id,
        '/?open_encounter=' || p_encuentro_id::text,
        'Nueva solicitud de encuentro abierto',
        v_notif_body,
        pg_catalog.json_build_object(
            'solicitud_id', v_solicitud_id,
            'nombre_solicitante', v_clean_nombre,
            'seat_count', v_effective_seat_count,
            'mensaje', p_mensaje
        ),
        'solicitud:' || v_solicitud_id::text
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'solicitud_id', v_solicitud_id,
        'estado', 'pendiente',
        'seat_count', v_effective_seat_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solicitar_sumarse_encuentro_abierto(UUID, TEXT, TEXT, UUID, INT) TO anon, authenticated, postgres, service_role;


-- ==============================================================================
-- 7. CHOKE-POINT: SOLICITUDES DE COBERTURA
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.submit_coverage_request(
    p_location_text TEXT,
    p_intent_text TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_clean_loc TEXT;
    v_clean_intent TEXT;
    v_id UUID;
BEGIN
    -- GUARDA PRE-LANZAMIENTO:
    IF NOT public.can_access_pre_launch() THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'pre_launch_restricted',
            'message', 'El registro de solicitudes de cobertura está restringido a usuarios de pruebas autorizados durante el pre-lanzamiento.'
        );
    END IF;

    v_clean_loc := pg_catalog.btrim(COALESCE(p_location_text, ''));
    IF pg_catalog.length(v_clean_loc) < 2 OR pg_catalog.length(v_clean_loc) > 120 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_location_length');
    END IF;

    v_clean_intent := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_intent_text, '')), '');
    IF v_clean_intent IS NOT NULL AND pg_catalog.length(v_clean_intent) > 200 THEN
        v_clean_intent := pg_catalog.substr(v_clean_intent, 1, 200);
    END IF;

    INSERT INTO public.coverage_requests (
        user_id, raw_location_text, normalized_location_text, intent_text, client_environment
    ) VALUES (
        v_user_id, v_clean_loc, pg_catalog.lower(v_clean_loc), v_clean_intent, 'web'
    ) RETURNING id INTO v_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'request_id', v_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_coverage_request(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_coverage_request(TEXT, TEXT) TO anon, authenticated, postgres, service_role;

COMMIT;
