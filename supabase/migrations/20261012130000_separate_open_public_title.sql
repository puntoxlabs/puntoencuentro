-- ==============================================================================
-- Migración: Separación de Título Privado (titulo) y Título Público (open_public_title)
-- Timestamp: 20261012130000_separate_open_public_title.sql
-- Entorno: STAGING
-- ==============================================================================

BEGIN;

-- 1. Agregar columna open_public_title en public.encuentros
ALTER TABLE public.encuentros
ADD COLUMN IF NOT EXISTS open_public_title TEXT;

-- 2. Backfill retrocompatible: publicaciones abiertas existentes usan su título actual
UPDATE public.encuentros
SET open_public_title = titulo
WHERE is_open = true AND (open_public_title IS NULL OR pg_catalog.btrim(open_public_title) = '');

-- 3. Invariante de integridad: si el encuentro está abierto, requiere open_public_title válido (3 a 80 caracteres)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_encuentros_open_public_title'
    ) THEN
        ALTER TABLE public.encuentros
        ADD CONSTRAINT chk_encuentros_open_public_title
        CHECK (
            is_open IS NOT TRUE OR (
                open_public_title IS NOT NULL
                AND pg_catalog.length(pg_catalog.btrim(open_public_title)) >= 3
                AND pg_catalog.length(pg_catalog.btrim(open_public_title)) <= 80
            )
        );
    END IF;
END $$;

-- 4. Helper canónico de hash de moderación TOCTOU
DROP FUNCTION IF EXISTS public.calcular_content_hash_moderacion(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.calcular_content_hash_moderacion(
    p_title TEXT,
    p_open_description TEXT,
    p_modalidad TEXT DEFAULT NULL,
    p_open_public_zone TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT md5(
        COALESCE(pg_catalog.btrim(p_title), '') || '::' ||
        COALESCE(pg_catalog.btrim(p_open_description), '') || '::' ||
        COALESCE(pg_catalog.btrim(p_modalidad), '') || '::' ||
        COALESCE(pg_catalog.btrim(p_open_public_zone), '')
    );
$$;

REVOKE ALL ON FUNCTION public.calcular_content_hash_moderacion(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calcular_content_hash_moderacion(TEXT, TEXT, TEXT, TEXT) TO authenticated, anon, postgres, service_role;

-- 5. RPC abrir_encuentro_seguro con soporte para p_open_public_title
DROP FUNCTION IF EXISTS public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT DEFAULT NULL,
    p_open_public_zone TEXT DEFAULT NULL,
    p_open_public_title TEXT DEFAULT NULL
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
    v_confirmed_count INT := 0;
    v_final_locality_id TEXT := NULL;
    v_final_public_zone TEXT := NULL;
    v_final_public_title TEXT := NULL;
    v_loc_record RECORD;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_eval RECORD;
    v_was_open BOOLEAN;
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

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_inactive');
    END IF;

    -- Resolución y validación del título público
    -- Autocompletado / fallback inicial desde v_encuentro.open_public_title o v_encuentro.titulo
    v_final_public_title := NULLIF(pg_catalog.btrim(COALESCE(p_open_public_title, v_encuentro.open_public_title, v_encuentro.titulo)), '');

    IF v_final_public_title IS NULL OR pg_catalog.length(v_final_public_title) < 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_short');
    END IF;

    IF pg_catalog.length(v_final_public_title) > 80 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_long');
    END IF;

    -- Validaciones de descripción pública
    IF p_open_description IS NULL OR pg_catalog.length(pg_catalog.btrim(p_open_description)) < 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'description_too_short');
    END IF;

    -- Validar que la ubicación privada no esté vacía
    IF v_encuentro.modalidad = 'presencial' THEN
        IF v_encuentro.lugar_texto IS NULL OR pg_catalog.btrim(v_encuentro.lugar_texto) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'private_location_required');
        END IF;

        IF p_locality_id IS NULL OR pg_catalog.btrim(p_locality_id) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'locality_required');
        END IF;

        SELECT id, nombre INTO v_loc_record
        FROM public.localidades
        WHERE id = pg_catalog.btrim(p_locality_id) AND activo = true;

        IF NOT FOUND THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_locality');
        END IF;

        v_final_locality_id := v_loc_record.id;
        v_final_public_zone := v_loc_record.nombre;
    ELSIF v_encuentro.modalidad = 'virtual' THEN
        IF v_encuentro.link_virtual IS NULL OR pg_catalog.btrim(v_encuentro.link_virtual) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'private_virtual_link_required');
        END IF;

        v_final_locality_id := NULL;
        v_final_public_zone := 'Virtual';
    ELSE
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unsupported_modality');
    END IF;

    -- Validar cupo
    SELECT COUNT(*) INTO v_confirmed_count
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado = 'confirmado';

    IF p_max_participants < (v_confirmed_count + 1) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    IF p_max_participants < 2 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'min_two_participants');
    END IF;

    -- EVALUACIÓN DETERMINISTA SERVER-SIDE (CHOKE POINT) sobre v_final_public_title
    SELECT * INTO v_eval
    FROM public.evaluar_contenido_publico_determinista(v_final_public_title, p_open_description);

    v_was_open := v_encuentro.is_open;

    -- CASO 1: BLOCK (Violación clara o basura) -> Rechazar apertura
    IF v_eval.decision = 'block' THEN
        UPDATE public.encuentros
        SET moderation_status = 'rejected',
            moderation_reason = v_eval.reason,
            moderated_at = v_now,
            moderation_decision_source = 'deterministic',
            moderation_categories = v_eval.categories,
            open_public_title = v_final_public_title,
            is_open = false,
            closed_at = CASE WHEN v_was_open THEN v_now ELSE closed_at END
        WHERE id = p_encuentro_id;

        INSERT INTO public.public_content_moderation_audit (
            encuentro_id, moderator_id, action, previous_status, new_status,
            reason, categories, source, metadata
        ) VALUES (
            p_encuentro_id, v_user_id, 'deterministic_block', v_encuentro.moderation_status, 'rejected',
            v_eval.reason, v_eval.categories, 'deterministic',
            pg_catalog.jsonb_build_object(
                'open_public_title', v_final_public_title,
                'open_description', p_open_description,
                'private_title', v_encuentro.titulo
            )
        );

        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'content_moderation_blocked',
            'moderation_status', 'rejected',
            'reason', v_eval.reason
        );
    END IF;

    -- CASO 2: NO BLOQUEADO -> Preparar para publicación pero dejar en REVIEW_PENDING e IS_OPEN = FALSE (CHOKE POINT)
    UPDATE public.encuentros
    SET moderation_status = 'review_pending',
        moderation_reason = v_eval.reason,
        moderated_at = v_now,
        moderation_decision_source = 'deterministic',
        moderation_categories = v_eval.categories,
        is_open = false,
        open_public_title = v_final_public_title,
        open_description = NULLIF(pg_catalog.btrim(p_open_description), ''),
        max_participants = p_max_participants,
        locality_id = v_final_locality_id,
        open_public_zone = v_final_public_zone,
        closed_at = CASE WHEN v_was_open THEN v_now ELSE closed_at END
    WHERE id = p_encuentro_id;

    INSERT INTO public.public_content_moderation_audit (
        encuentro_id, moderator_id, action, previous_status, new_status,
        reason, categories, source, metadata
    ) VALUES (
        p_encuentro_id, v_user_id, 'publish_requested', v_encuentro.moderation_status, 'review_pending',
        v_eval.reason, v_eval.categories, 'user_request',
        pg_catalog.jsonb_build_object(
            'open_public_title', v_final_public_title,
            'open_description', p_open_description,
            'private_title', v_encuentro.titulo
        )
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'is_open', false,
        'moderation_status', 'review_pending',
        'message', 'Solicitud de apertura recibida. En proceso de moderación.',
        'open_public_title', v_final_public_title,
        'max_participants', p_max_participants,
        'locality_id', v_final_locality_id,
        'open_public_zone', v_final_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT) TO authenticated;

-- 6. RPC actualizar_encuentro_seguro con soporte explícito para open_public_title e independencia de titulo
CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro(
    p_encuentro_id uuid,
    p_host_id      uuid,
    p_data         jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_new_title text;
    v_new_open_title text;
    v_new_open_desc text;
    v_new_locality_id text;
    v_new_public_zone text;
    v_new_modalidad text;
    v_loc_record public.localidades%ROWTYPE;
    v_title_changed boolean := false;
    v_open_title_changed boolean := false;
    v_open_desc_changed boolean := false;
    v_modality_changed boolean := false;
    v_locality_changed boolean := false;
    v_zone_changed boolean := false;
    v_moderation_invalidated boolean := false;
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_eval record;
    v_det_reason text := null;
    v_new_status text;
    v_new_is_open boolean;
    v_changed_fields text[] := ARRAY[]::text[];
    v_effective_eval_title text;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id AND host_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'Encuentro no encontrado o sin permisos');
    END IF;

    -- Si el encuentro está abierto, rechazar cambio de modalidad directamente (invariante existente)
    IF v_encuentro.is_open = true AND p_data ? 'modalidad' AND (p_data->>'modalidad') <> v_encuentro.modalidad THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_change_modality_while_open');
    END IF;

    -- Extraer valores nuevos
    v_new_title := CASE WHEN p_data ? 'titulo' THEN NULLIF(pg_catalog.btrim(p_data->>'titulo'), '') ELSE v_encuentro.titulo END;
    v_new_open_title := CASE WHEN p_data ? 'open_public_title' THEN NULLIF(pg_catalog.btrim(p_data->>'open_public_title'), '') ELSE v_encuentro.open_public_title END;
    v_new_open_desc := CASE WHEN p_data ? 'open_description' THEN NULLIF(pg_catalog.btrim(p_data->>'open_description'), '') ELSE v_encuentro.open_description END;
    v_new_modalidad := COALESCE(p_data->>'modalidad', v_encuentro.modalidad);
    v_new_locality_id := CASE WHEN p_data ? 'locality_id' THEN p_data->>'locality_id' ELSE v_encuentro.locality_id END;
    v_new_public_zone := CASE WHEN p_data ? 'open_public_zone' THEN p_data->>'open_public_zone' ELSE v_encuentro.open_public_zone END;

    -- Validar límites de open_public_title si se intenta modificar
    IF p_data ? 'open_public_title' THEN
        IF v_new_open_title IS NULL OR pg_catalog.length(v_new_open_title) < 3 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_short');
        END IF;
        IF pg_catalog.length(v_new_open_title) > 80 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_long');
        END IF;
    END IF;

    -- Si se actualizó locality_id pero no open_public_zone, resolver zona desde localidades
    IF p_data ? 'locality_id' AND v_new_locality_id IS NOT NULL AND NOT (p_data ? 'open_public_zone') THEN
        SELECT * INTO v_loc_record FROM public.localidades WHERE id = v_new_locality_id AND activo = true;
        IF FOUND THEN
            v_new_public_zone := v_loc_record.nombre;
        END IF;
    END IF;

    -- Detectar cambios en campos moderables públicos
    IF p_data ? 'titulo' AND COALESCE(v_new_title, '') <> COALESCE(v_encuentro.titulo, '') THEN
        v_title_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'titulo');
    END IF;

    IF p_data ? 'open_public_title' AND COALESCE(v_new_open_title, '') <> COALESCE(v_encuentro.open_public_title, '') THEN
        v_open_title_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_public_title');
    END IF;

    IF p_data ? 'open_description' AND COALESCE(v_new_open_desc, '') <> COALESCE(v_encuentro.open_description, '') THEN
        v_open_desc_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_description');
    END IF;

    IF p_data ? 'modalidad' AND v_new_modalidad <> v_encuentro.modalidad THEN
        v_modality_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'modalidad');
    END IF;

    IF p_data ? 'locality_id' AND COALESCE(v_new_locality_id, '') <> COALESCE(v_encuentro.locality_id, '') THEN
        v_locality_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'locality_id');
    END IF;

    IF p_data ? 'open_public_zone' AND COALESCE(v_new_public_zone, '') <> COALESCE(v_encuentro.open_public_zone, '') THEN
        v_zone_changed := true;
        v_changed_fields := pg_catalog.array_append(v_changed_fields, 'open_public_zone');
    END IF;

    v_new_status := v_encuentro.moderation_status;
    v_new_is_open := v_encuentro.is_open;

    -- REGLA DE INDEPENDENCIA Y MODERACIÓN:
    -- Solo cambios a campos PÚBLICOS (open_public_title, open_description, modalidad, locality_id, open_public_zone)
    -- invalidan la moderación previa a review_pending y ocultan de Discovery.
    -- Modificar el título privado (titulo) NO altera la publicación pública ni invalida la moderación.
    IF (v_encuentro.moderation_status = 'approved' OR v_encuentro.is_open = true OR v_encuentro.moderation_status = 'review_pending')
       AND (v_open_title_changed OR v_open_desc_changed OR v_modality_changed OR v_locality_changed OR v_zone_changed) THEN

        v_moderation_invalidated := true;
        v_effective_eval_title := COALESCE(v_new_open_title, v_encuentro.open_public_title, v_new_title);

        -- Evaluar reglas deterministas de inmediato
        SELECT * INTO v_eval
        FROM public.evaluar_contenido_publico_determinista(v_effective_eval_title, v_new_open_desc);
        v_det_reason := v_eval.reason;

        IF v_eval.decision = 'block' THEN
            v_new_status := 'rejected';
            v_new_is_open := false;

            INSERT INTO public.public_content_moderation_audit (
                encuentro_id, moderator_id, action, previous_status, new_status,
                reason, categories, source, metadata
            ) VALUES (
                p_encuentro_id, v_user_id, 'deterministic_block', v_encuentro.moderation_status, 'rejected',
                v_eval.reason, v_eval.categories, 'deterministic_edit',
                pg_catalog.jsonb_build_object(
                    'changed_fields', v_changed_fields,
                    'open_public_title', v_effective_eval_title,
                    'open_description', v_new_open_desc,
                    'private_title', v_new_title
                )
            );
        ELSE
            v_new_status := 'review_pending';
            v_new_is_open := false;

            INSERT INTO public.public_content_moderation_audit (
                encuentro_id, moderator_id, action, previous_status, new_status,
                reason, categories, source, metadata
            ) VALUES (
                p_encuentro_id, v_user_id, 'content_updated', v_encuentro.moderation_status, 'review_pending',
                'content_updated', ARRAY[]::text[], 'user_edit',
                pg_catalog.jsonb_build_object(
                    'changed_fields', v_changed_fields,
                    'open_public_title', v_effective_eval_title,
                    'open_description', v_new_open_desc,
                    'private_title', v_new_title
                )
            );
        END IF;
    END IF;

    UPDATE public.encuentros
    SET
        titulo = v_new_title,
        open_public_title = v_new_open_title,
        descripcion = CASE
            WHEN p_data ? 'descripcion'
            THEN p_data->>'descripcion'
            ELSE descripcion
        END,
        open_description = v_new_open_desc,
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
        modalidad = v_new_modalidad,
        locality_id = v_new_locality_id,
        open_public_zone = v_new_public_zone,
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
        END,
        moderation_status = v_new_status,
        is_open = v_new_is_open,
        moderated_at = CASE WHEN v_moderation_invalidated THEN v_now ELSE moderated_at END,
        moderation_reason = CASE
            WHEN v_moderation_invalidated AND v_new_status = 'rejected' THEN v_det_reason
            WHEN v_moderation_invalidated THEN 'content_updated'
            ELSE moderation_reason
        END,
        moderation_decision_source = CASE
            WHEN v_moderation_invalidated AND v_new_status = 'rejected' THEN 'deterministic'
            WHEN v_moderation_invalidated THEN 'content_update'
            ELSE moderation_decision_source
        END,
        closed_at = CASE WHEN v_moderation_invalidated AND v_encuentro.is_open THEN v_now ELSE closed_at END
    WHERE id = p_encuentro_id
      AND host_id = v_user_id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'moderation_invalidated', v_moderation_invalidated,
        'moderation_status', v_new_status,
        'is_open', v_new_is_open
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.actualizar_encuentro_seguro(uuid, uuid, jsonb) TO authenticated;

-- 7. Actualizar resolver_moderacion_encuentro_seguro con hash canónico sobre open_public_title
CREATE OR REPLACE FUNCTION public.resolver_moderacion_encuentro_seguro(
    p_encuentro_id UUID,
    p_action TEXT,
    p_note TEXT DEFAULT NULL,
    p_expected_content_hash TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_auth BOOLEAN := false;
    v_encuentro public.encuentros%ROWTYPE;
    v_new_status TEXT;
    v_is_open BOOLEAN;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_clean_note TEXT;
    v_conv_intencion RECORD;
    v_source TEXT;
    v_current_hash TEXT;
    v_mod_role TEXT;
    v_effective_title TEXT;
BEGIN
    -- Verificación de rol administrativo o service_role
    IF auth.role() = 'service_role' THEN
        v_is_auth := true;
        v_source := 'automated_moderation';
    ELSIF v_user_id IS NOT NULL AND public.is_moderation_authorized() THEN
        v_is_auth := true;
        SELECT role INTO v_mod_role
        FROM public.moderation_authorized_users
        WHERE user_id = v_user_id AND active = true;

        v_source := COALESCE(v_mod_role, 'moderator');
    END IF;

    IF NOT v_is_auth THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    v_clean_note := NULLIF(pg_catalog.btrim(p_note), '');
    v_effective_title := COALESCE(v_encuentro.open_public_title, v_encuentro.titulo);

    -- Control estricto de transiciones de estado para APPROVE
    IF p_action = 'approve' THEN
        IF auth.role() = 'service_role' AND v_encuentro.moderation_status <> 'review_pending' THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'invalid_status_transition',
                'current_status', v_encuentro.moderation_status,
                'message', 'Automated moderation can only approve encounters in review_pending'
            );
        END IF;

        IF auth.role() <> 'service_role' AND v_encuentro.moderation_status NOT IN ('review_pending', 'hidden_pending_review') THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'invalid_status_transition',
                'current_status', v_encuentro.moderation_status
            );
        END IF;

        -- TOCTOU check: comparar hash esperado contra título público efectivo en DB
        IF p_expected_content_hash IS NOT NULL THEN
            v_current_hash := public.calcular_content_hash_moderacion(
                v_effective_title,
                v_encuentro.open_description,
                v_encuentro.modalidad,
                v_encuentro.open_public_zone
            );
            IF v_current_hash <> p_expected_content_hash THEN
                RETURN pg_catalog.json_build_object(
                    'ok', false,
                    'error', 'content_hash_mismatch',
                    'message', 'El contenido fue modificado durante la evaluación de moderación'
                );
            END IF;
        END IF;

        v_new_status := 'approved';
        v_is_open := true;
    ELSIF p_action = 'hide' THEN
        v_new_status := 'hidden_pending_review';
        v_is_open := false;
    ELSIF p_action = 'remove' THEN
        v_new_status := 'removed';
        v_is_open := false;
    ELSIF p_action = 'reject' THEN
        v_new_status := 'rejected';
        v_is_open := false;
    ELSE
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_action');
    END IF;

    -- Actualizar estado del encuentro
    UPDATE public.encuentros
    SET moderation_status = v_new_status,
        is_open = v_is_open,
        moderated_at = v_now,
        moderation_decision_source = v_source,
        closed_at = CASE WHEN NOT v_is_open AND v_encuentro.is_open THEN v_now ELSE closed_at END,
        opened_at = CASE WHEN v_is_open AND opened_at IS NULL THEN v_now ELSE opened_at END
    WHERE id = p_encuentro_id;

    -- Si se aprueba y no estaba abierto, emitir alertas y evento de dominio
    IF v_is_open AND NOT v_encuentro.is_open THEN
        FOR v_conv_intencion IN
            SELECT id
            FROM public.intenciones
            WHERE encuentro_id = p_encuentro_id
              AND estado = 'convertida'
        LOOP
            PERFORM public.emitir_alertas_intencion_convertida_outbox(v_conv_intencion.id, p_encuentro_id);
        END LOOP;

        INSERT INTO public.domain_events_outbox (
            event_type, event_version, aggregate_type, aggregate_id,
            actor_user_id, payload, dedup_key, status
        ) VALUES (
            'encounter.opened.v1', 1, 'encounter', p_encuentro_id,
            v_encuentro.host_id,
            pg_catalog.jsonb_build_object(
                'encounter_id', p_encuentro_id,
                'host_id', v_encuentro.host_id,
                'modalidad', v_encuentro.modalidad,
                'locality_id', v_encuentro.locality_id,
                'max_participants', v_encuentro.max_participants,
                'opened_at', v_now
            ),
            pg_catalog.format('encounter:%s:opened:%s', p_encuentro_id, extract(epoch from v_now)::text),
            'pending'
        )
        ON CONFLICT (dedup_key) DO NOTHING;
    END IF;

    -- Actualizar reportes pendientes asociados
    UPDATE public.public_content_reports
    SET status = CASE WHEN p_action = 'approve' THEN 'dismissed' ELSE 'actioned' END,
        reviewed_at = v_now,
        reviewed_by = v_user_id,
        resolution_note = v_clean_note
    WHERE encuentro_id = p_encuentro_id AND status = 'pending';

    -- Registrar auditoría persistente
    INSERT INTO public.public_content_moderation_audit (
        encuentro_id, moderator_id, action, previous_status, new_status,
        reason, categories, source, metadata
    ) VALUES (
        p_encuentro_id, v_user_id, p_action, v_encuentro.moderation_status, v_new_status,
        v_clean_note, ARRAY[]::TEXT[], v_source,
        pg_catalog.jsonb_build_object('moderator_role', CASE WHEN auth.role() = 'service_role' THEN 'service_role' ELSE COALESCE(v_mod_role, 'moderator') END)
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'action', p_action,
        'moderation_status', v_new_status,
        'is_open', v_is_open
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT, TEXT) TO authenticated, postgres, service_role;

-- 8. Actualizar trigger de clasificación de actividad con open_public_title
CREATE OR REPLACE FUNCTION public.fn_trg_encuentros_classify_open_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_res RECORD;
    v_effective_title TEXT;
BEGIN
    v_effective_title := COALESCE(NEW.open_public_title, NEW.titulo);
    SELECT * INTO v_res FROM public.fn_classify_activity(v_effective_title, NEW.open_description);
    NEW.open_activity_canonical := v_res.activity_canonical;
    NEW.open_activity_strong_tokens := v_res.activity_strong_tokens;
    NEW.open_activity_matching_eligible := v_res.activity_matching_eligible;
    NEW.open_match_ineligible_reason := v_res.match_ineligible_reason;
    NEW.open_activity_classified_at := pg_catalog.timezone('utc', pg_catalog.now());
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_encuentros_classify_open_activity ON public.encuentros;
CREATE TRIGGER trg_encuentros_classify_open_activity
    BEFORE INSERT OR UPDATE OF open_public_title, open_description, titulo ON public.encuentros
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_encuentros_classify_open_activity();

-- 9. Actualizar RPC Discovery: get_discovery_encuentros_abiertos consumiendo open_public_title
CREATE OR REPLACE FUNCTION public.get_discovery_encuentros_abiertos(
    p_locality_ids TEXT[] DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_viewer_id UUID := auth.uid();
    v_result JSON;
BEGIN
    SELECT pg_catalog.json_agg(enc_row) INTO v_result
    FROM (
        SELECT
            e.id,
            COALESCE(e.open_public_title, e.titulo) AS title,
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
          AND e.moderation_status = 'approved'
          AND (e.modalidad = 'virtual' OR (l.id IS NOT NULL AND l.activo = true))
          AND (
              e.fecha IS NULL
              OR e.hora IS NULL
              OR (e.fecha + e.hora) >= (CURRENT_DATE - INTERVAL '1 day')
          )
          AND (
              p_locality_ids IS NULL
              OR array_length(p_locality_ids, 1) IS NULL
              OR e.locality_id = ANY(p_locality_ids)
          )
          AND (
              v_viewer_id IS NULL
              OR NOT EXISTS (
                  SELECT 1 FROM public.bloqueos_usuario b
                  WHERE (b.blocker_id = v_viewer_id AND b.blocked_id = e.host_id)
                     OR (b.blocker_id = e.host_id AND b.blocked_id = v_viewer_id)
              )
          )
        ORDER BY e.opened_at DESC, e.creado_en DESC
    ) enc_row;

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discovery_encuentros_abiertos(TEXT[]) TO anon, authenticated;

-- 10. Actualizar get_detalle_host_seguro para incluir open_public_title y moderation_status
CREATE OR REPLACE FUNCTION public.get_detalle_host_seguro(p_encuentro_id uuid, p_host_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        v_user_id := p_host_id;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('error', 'unauthorized');
    END IF;

    RETURN pg_catalog.json_build_object(
        'id', v_encuentro.id,
        'titulo', v_encuentro.titulo,
        'open_public_title', v_encuentro.open_public_title,
        'descripcion', v_encuentro.descripcion,
        'fecha', v_encuentro.fecha,
        'hora', v_encuentro.hora,
        'modalidad', v_encuentro.modalidad,
        'lugar_texto', v_encuentro.lugar_texto,
        'link_virtual', v_encuentro.link_virtual,
        'tipo_invitacion', v_encuentro.tipo_invitacion,
        'host_id', v_encuentro.host_id,
        'public_token', v_encuentro.public_token,
        'estado', v_encuentro.estado,
        'tema', v_encuentro.tema,
        'tema_invitacion', COALESCE(v_encuentro.tema_invitacion, 'classic'),
        'invitation_template', v_encuentro.invitation_template,
        'reemplaza_a', v_encuentro.reemplaza_a,
        'creado_en', v_encuentro.creado_en,
        'is_open', COALESCE(v_encuentro.is_open, false),
        'open_description', v_encuentro.open_description,
        'max_participants', v_encuentro.max_participants,
        'locality_id', v_encuentro.locality_id,
        'open_public_zone', v_encuentro.open_public_zone,
        'opened_at', v_encuentro.opened_at,
        'closed_at', v_encuentro.closed_at,
        'moderation_status', v_encuentro.moderation_status
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_detalle_host_seguro(uuid, uuid) TO authenticated, anon;

-- 11. Actualizar get_encuentro_por_public_token: protege título privado cuando el encuentro está abierto
CREATE OR REPLACE FUNCTION public.get_encuentro_por_public_token(p_public_token text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_token_uuid uuid;
    v_encuentro record;
BEGIN
    BEGIN
        v_token_uuid := p_public_token::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN NULL;
    END;

    SELECT
        id,
        titulo,
        open_public_title,
        descripcion,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        estado,
        tema,
        tema_invitacion,
        invitation_template,
        creado_en,
        is_open,
        open_description,
        open_public_zone,
        locality_id
    INTO v_encuentro
    FROM public.encuentros
    WHERE public_token = v_token_uuid;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN pg_catalog.json_build_object(
        'id',                  v_encuentro.id,
        'titulo',              CASE
                                   WHEN v_encuentro.is_open = true THEN COALESCE(v_encuentro.open_public_title, v_encuentro.titulo)
                                   ELSE v_encuentro.titulo
                               END,
        'open_public_title',   v_encuentro.open_public_title,
        'descripcion',         v_encuentro.descripcion,
        'fecha',               v_encuentro.fecha,
        'hora',                v_encuentro.hora,
        'modalidad',           v_encuentro.modalidad,
        'lugar_texto',         v_encuentro.lugar_texto,
        'estado',              v_encuentro.estado,
        'tema',                v_encuentro.tema,
        'tema_invitacion',     v_encuentro.tema_invitacion,
        'invitation_template', v_encuentro.invitation_template,
        'creado_en',           v_encuentro.creado_en,
        'is_open',             v_encuentro.is_open,
        'open_description',    v_encuentro.open_description,
        'open_public_zone',    v_encuentro.open_public_zone,
        'locality_id',         v_encuentro.locality_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentro_por_public_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_encuentro_por_public_token(text) TO anon, authenticated;

COMMIT;
