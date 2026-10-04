-- ============================================================
-- Migración: 20261003210000_normalize_open_encounters_zone_by_modality.sql
-- Módulo: Normalización de Zona Pública por Modalidad en Encuentros Abiertos
-- ============================================================

BEGIN;

-- 1. NORMALIZACIÓN DE DATOS HISTÓRICOS ENCUENTROS ABIERTOS
-- Virtual: locality_id = NULL, open_public_zone = 'Virtual'
UPDATE public.encuentros
SET locality_id = NULL,
    open_public_zone = 'Virtual'
WHERE is_open = true
  AND modalidad = 'virtual';

-- Presencial: open_public_zone canónico derivado del catálogo de localidades
UPDATE public.encuentros e
SET open_public_zone = l.nombre
FROM public.localidades l
WHERE e.locality_id = l.id
  AND e.is_open = true
  AND e.modalidad = 'presencial';

-- 2. REEMPLAZO DEL CONSTRAINT DE INTEGRIDAD
ALTER TABLE public.encuentros
DROP CONSTRAINT IF EXISTS check_encuentro_abierto_integrity;

ALTER TABLE public.encuentros
ADD CONSTRAINT check_encuentro_abierto_integrity
CHECK (
    (is_open = false)
    OR
    (
        is_open = true
        AND max_participants IS NOT NULL
        AND max_participants >= 2
        AND (
            (modalidad = 'presencial' AND locality_id IS NOT NULL AND open_public_zone IS NOT NULL AND trim(open_public_zone) <> '')
            OR
            (modalidad = 'virtual' AND locality_id IS NULL)
        )
    )
);

-- 3. ACTUALIZAR RPC: abrir_encuentro_seguro
-- Lee modalidad real de DB:
-- - presencial: exige p_locality_id activa y deriva open_public_zone = l.nombre
-- - virtual: fuerza locality_id = NULL y open_public_zone = 'Virtual'
CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,   -- DEPRECATED: ignorado. Identidad = auth.uid() únicamente.
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT DEFAULT NULL,
    p_open_public_zone TEXT DEFAULT NULL -- DEPRECATED: ignorado. Se deriva en servidor.
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
    v_final_locality_id TEXT := NULL;
    v_final_public_zone TEXT := NULL;
    v_loc_record RECORD;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_conv_intencion RECORD;
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

    -- Validar y resolver zona según modalidad
    IF v_encuentro.modalidad = 'presencial' THEN
        IF p_locality_id IS NULL OR trim(p_locality_id) = '' THEN
            RETURN json_build_object('ok', false, 'error', 'locality_required');
        END IF;

        SELECT id, nombre INTO v_loc_record
        FROM public.localidades
        WHERE id = trim(p_locality_id) AND activo = true;

        IF NOT FOUND THEN
            RETURN json_build_object('ok', false, 'error', 'invalid_locality');
        END IF;

        v_final_locality_id := v_loc_record.id;
        v_final_public_zone := v_loc_record.nombre;
    ELSIF v_encuentro.modalidad = 'virtual' THEN
        v_final_locality_id := NULL;
        v_final_public_zone := 'Virtual';
    ELSE
        RETURN json_build_object('ok', false, 'error', 'unsupported_modality');
    END IF;

    -- Validar cupo
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado = 'confirmado';

    IF p_max_participants < (v_confirmed_count + 1) THEN
        RETURN json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    IF p_max_participants < 2 THEN
        RETURN json_build_object('ok', false, 'error', 'min_two_participants');
    END IF;

    IF NOT v_encuentro.is_open THEN
        -- Transición real cerrado -> abierto (false -> true)
        UPDATE public.encuentros
        SET is_open = true,
            open_description = NULLIF(trim(p_open_description), ''),
            max_participants = p_max_participants,
            locality_id = v_final_locality_id,
            open_public_zone = v_final_public_zone,
            opened_at = v_now,
            closed_at = NULL
        WHERE id = p_encuentro_id;

        -- Emitir eventos outbox para usuarios interesados en intenciones convertidas previamente
        FOR v_conv_intencion IN
            SELECT id
            FROM public.intenciones
            WHERE encuentro_id = p_encuentro_id
              AND estado = 'convertida'
        LOOP
            PERFORM public.emitir_alertas_intencion_convertida_outbox(v_conv_intencion.id, p_encuentro_id);
        END LOOP;

        -- Emisión del Domain Event: encounter.opened.v1 (Transactional Outbox)
        INSERT INTO public.domain_events_outbox (
            event_type,
            event_version,
            aggregate_type,
            aggregate_id,
            actor_user_id,
            payload,
            dedup_key,
            status
        ) VALUES (
            'encounter.opened.v1',
            1,
            'encounter',
            p_encuentro_id,
            v_user_id,
            jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'host_id', v_user_id,
                'modalidad', v_encuentro.modalidad,
                'locality_id', v_final_locality_id,
                'max_participants', p_max_participants,
                'opened_at', v_now
            ),
            format('encounter:%s:opened:%s', p_encuentro_id, extract(epoch from v_now)::text),
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;
    ELSE
        -- Ya está abierto: actualizar configuración sin alterar opened_at ni emitir encounter.opened.v1
        UPDATE public.encuentros
        SET open_description = NULLIF(trim(p_open_description), ''),
            max_participants = p_max_participants,
            locality_id = v_final_locality_id,
            open_public_zone = v_final_public_zone
        WHERE id = p_encuentro_id;
    END IF;

    RETURN json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'is_open', true,
        'max_participants', p_max_participants,
        'locality_id', v_final_locality_id,
        'open_public_zone', v_final_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT)
    TO authenticated;

-- 4. ACTUALIZAR RPC: get_discovery_encuentros_abiertos
-- LEFT JOIN sobre localidades para permitir encuentros virtuales con locality_id = NULL
CREATE OR REPLACE FUNCTION public.get_discovery_encuentros_abiertos(
    p_locality_ids TEXT[] DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_result JSON;
BEGIN
    SELECT json_agg(enc_row) INTO v_result
    FROM (
        SELECT
            e.id,
            e.titulo AS title,
            CASE
                WHEN e.tema_invitacion = 'sports' THEN '🎾'
                WHEN e.tema_invitacion = 'friends' THEN '🍻'
                WHEN e.tema_invitacion = 'celebration' THEN '🎉'
                WHEN e.tema_invitacion = 'family' THEN '👨‍👩‍👦'
                WHEN e.tema_invitacion = 'learning' THEN '📚'
                WHEN e.tema_invitacion = 'wellness' THEN '🧘'
                WHEN e.tema_invitacion = 'romantic' THEN '🍷'
                ELSE '✨'
            END AS emoji,
            COALESCE(e.tema_invitacion, 'social') AS activity_type,
            CASE
                WHEN e.fecha IS NOT NULL AND e.hora IS NOT NULL THEN
                    to_char(e.fecha, 'YYYY-MM-DD') || 'T' || to_char(e.hora, 'HH24:MI:SS')
                ELSE
                    to_char(e.creado_en, 'YYYY-MM-DD"T"HH24:MI:SS')
            END AS starts_at,
            CASE
                WHEN e.fecha IS NOT NULL AND e.hora IS NOT NULL THEN
                    to_char(e.fecha, 'DD/MM') || ' · ' || to_char(e.hora, 'HH24:MI') || ' hs'
                WHEN e.date_mode = 'coordination' THEN
                    'Fecha por coordinar'
                ELSE
                    'A convenir'
            END AS date_label,
            COALESCE(e.open_public_zone, CASE WHEN e.modalidad = 'virtual' THEN 'Virtual' ELSE l.nombre END, 'Zona aproximada') AS approximate_zone,
            e.locality_id,
            GREATEST(0, e.max_participants - (1 + COALESCE(part_counts.confirmed, 0))) AS open_slots,
            (1 + COALESCE(part_counts.confirmed, 0)) AS confirmed_count,
            'es' AS language,
            e.open_description AS description,
            COALESCE(e.opened_at, e.creado_en) AS opened_at
        FROM public.encuentros e
        LEFT JOIN public.localidades l ON e.locality_id = l.id
        LEFT JOIN (
            SELECT encuentro_id, COUNT(*) AS confirmed
            FROM public.participantes
            WHERE estado = 'confirmado'
            GROUP BY encuentro_id
        ) part_counts ON part_counts.encuentro_id = e.id
        WHERE e.is_open = true
          AND e.estado = 'activo'
          AND (e.modalidad = 'virtual' OR (l.id IS NOT NULL AND l.activo = true))
          -- Filtrar si venció
          AND (
              e.fecha IS NULL
              OR e.hora IS NULL
              OR (e.fecha + e.hora) >= (CURRENT_DATE - INTERVAL '1 day')
          )
          -- Filtrar por localidades si se proveyeron
          AND (
              p_locality_ids IS NULL
              OR array_length(p_locality_ids, 1) IS NULL
              OR e.locality_id = ANY(p_locality_ids)
          )
        ORDER BY e.opened_at DESC, e.creado_en DESC
    ) enc_row;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) TO anon, authenticated;

-- 5. ENDURECER: actualizar_encuentro_seguro
-- Impide cambiar la modalidad de un encuentro que ya está abierto en Discovery
CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro(
    p_encuentro_id uuid,
    p_host_id      uuid,
    p_data         jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id AND host_id = v_user_id;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'Encuentro no encontrado o sin permisos');
    END IF;

    -- Si el encuentro está abierto, rechazar cambio de modalidad directamente
    IF v_encuentro.is_open = true AND p_data ? 'modalidad' AND (p_data->>'modalidad') <> v_encuentro.modalidad THEN
        RETURN json_build_object('ok', false, 'error', 'cannot_change_modality_while_open');
    END IF;

    UPDATE public.encuentros
    SET
        titulo = COALESCE(p_data->>'titulo', titulo),
        descripcion = CASE
            WHEN p_data ? 'descripcion'
            THEN p_data->>'descripcion'
            ELSE descripcion
        END,
        fecha = CASE
            WHEN p_data ? 'fecha'
            THEN (p_data->>'fecha')::date
            ELSE fecha
        END,
        hora = CASE
            WHEN p_data ? 'hora'
            THEN (p_data->>'hora')::time
            ELSE hora
        END,
        modalidad = COALESCE(
            p_data->>'modalidad',
            modalidad
        ),
        lugar_texto = CASE WHEN p_data ? 'lugar_texto' THEN p_data->>'lugar_texto' ELSE lugar_texto END,
        link_virtual = CASE WHEN p_data ? 'link_virtual' THEN p_data->>'link_virtual' ELSE link_virtual END,
        tipo_invitacion = COALESCE(
            p_data->>'tipo_invitacion',
            tipo_invitacion
        ),
        estado = COALESCE(
            p_data->>'estado',
            estado
        ),
        tema = CASE WHEN p_data ? 'tema' THEN p_data->>'tema' ELSE tema END,
        tema_invitacion = CASE
            WHEN p_data ? 'tema_invitacion'
                 AND p_data->>'tema_invitacion' IN (
                    'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
                    'family', 'special', 'romantic', 'sports', 'entertainment',
                    'learning', 'wellness', 'custom'
                 )
            THEN p_data->>'tema_invitacion'
            ELSE tema_invitacion
        END,
        invitation_template = CASE WHEN p_data ? 'invitation_template' THEN p_data->>'invitation_template' ELSE invitation_template END,
        reemplaza_a = CASE
            WHEN p_data ? 'reemplaza_a'
                 AND p_data->>'reemplaza_a' IS NOT NULL
                 AND p_data->>'reemplaza_a' <> ''
            THEN (p_data->>'reemplaza_a')::uuid
            WHEN p_data ? 'reemplaza_a'
            THEN NULL
            ELSE reemplaza_a
        END
    WHERE id = p_encuentro_id
      AND host_id = v_user_id;

    RETURN json_build_object(
        'ok', true,
        'id', p_encuentro_id
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) TO authenticated;

COMMIT;
