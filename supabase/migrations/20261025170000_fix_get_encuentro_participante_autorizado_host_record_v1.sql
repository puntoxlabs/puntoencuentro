-- ============================================================
-- Migración Aditiva: Corrección de evaluación de registro no asignado
-- para el Anfitrión en get_encuentro_participante_autorizado
-- Archivo: 20261025170000_fix_get_encuentro_participante_autorizado_host_record_v1.sql
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_encuentro_participante_autorizado(p_encuentro_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro RECORD;
    v_part RECORD;
    v_is_host BOOLEAN := false;
    v_is_open_participant BOOLEAN := false;
    v_is_authorized_logistics BOOLEAN := false;
    v_seat_count INT := NULL;
    v_reconfirmation_status TEXT := NULL;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT
        id,
        host_id,
        titulo,
        open_public_title,
        descripcion,
        open_description,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        link_virtual,
        estado,
        cancellation_reason,
        is_open,
        opened_at,
        min_participants,
        max_participants,
        realization_status,
        inscriptions_closed,
        inscriptions_cycle_id,
        open_public_zone,
        locality_id
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 1. Si es el anfitrión: acceso total
    IF v_encuentro.host_id = v_user_id THEN
        v_is_host := true;
        v_is_authorized_logistics := true;
    ELSE
        -- 2. Si es participante registrado
        SELECT
            id,
            estado,
            seat_count,
            reconfirmation_status,
            reconfirmed_cycle_id,
            tipo_invitacion,
            admission_source,
            token_invitacion,
            creado_en
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_user_id
        ORDER BY (estado IN ('confirmado', 'asistio')) DESC, creado_en DESC
        LIMIT 1;

        IF NOT FOUND THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
        END IF;

        -- Bloqueo bilateral
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_user_id AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_user_id)
        ) THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        IF v_encuentro.estado <> 'activo' OR v_part.estado IN ('rechazado', 'cancelado') THEN
            v_is_authorized_logistics := false;
        ELSIF v_part.estado IN ('confirmado', 'asistio') THEN
            v_is_open_participant := (
                EXISTS (
                    SELECT 1 FROM public.solicitudes_encuentro_abierto sea
                    WHERE sea.participante_id = v_part.id
                       OR sea.token_participante = v_part.token_invitacion
                       OR (sea.encuentro_id = p_encuentro_id AND sea.usuario_id = v_user_id)
                )
                OR (
                    (v_part.tipo_invitacion = 'generico' AND v_part.admission_source IS DISTINCT FROM 'private_general_link')
                    AND (
                        COALESCE(v_encuentro.is_open, false) = true
                        OR v_encuentro.opened_at IS NOT NULL
                        OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto sea WHERE sea.encuentro_id = p_encuentro_id)
                    )
                )
            );

            IF v_is_open_participant THEN
                v_is_authorized_logistics := (
                    v_encuentro.realization_status IN ('confirmed', 'forced')
                    AND COALESCE(v_encuentro.inscriptions_closed, false) = true
                    AND v_encuentro.inscriptions_cycle_id IS NOT NULL
                    AND v_part.reconfirmation_status = 'confirmed'
                    AND v_part.reconfirmed_cycle_id = v_encuentro.inscriptions_cycle_id
                );
            ELSE
                -- Invitado privado individual legítimo
                v_is_authorized_logistics := true;
            END IF;
        END IF;

        -- Asignar valores escalares seguros únicamente cuando v_part está asignado
        v_seat_count := COALESCE(v_part.seat_count, 1);
        v_reconfirmation_status := COALESCE(v_part.reconfirmation_status, 'pending');
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
        'lugar_texto', CASE
            WHEN NOT v_is_authorized_logistics THEN NULL
            WHEN v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto
            ELSE NULL
        END,
        'link_virtual', CASE
            WHEN NOT v_is_authorized_logistics THEN NULL
            WHEN v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual
            ELSE NULL
        END,
        'seat_count', v_seat_count,
        'estado', v_encuentro.estado,
        'cancellation_reason', CASE WHEN v_encuentro.estado = 'cancelado' THEN v_encuentro.cancellation_reason ELSE NULL END,
        'min_participants', v_encuentro.min_participants,
        'realization_status', COALESCE(v_encuentro.realization_status, 'pending'),
        'inscriptions_closed', COALESCE(v_encuentro.inscriptions_closed, false),
        'reconfirmation_status', v_reconfirmation_status
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_encuentro_participante_autorizado(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_encuentro_participante_autorizado(uuid) TO authenticated, service_role;

COMMIT;
