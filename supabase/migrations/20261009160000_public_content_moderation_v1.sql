-- ==============================================================================
-- Migración: 20261009160000_public_content_moderation_v1.sql
-- Tarea: Moderación Pública v1 para Encuentros Abiertos y contenido público
--
-- Contenido:
-- 1. Estados de moderación en public.encuentros y backfill de filas existentes.
-- 2. Umbral centralizado de auto-ocultamiento (get_moderation_auto_hide_threshold).
-- 3. Política de Rate Limit específica en public.rate_limit_policies.
-- 4. Tabla de reportes de contenido público: public.public_content_reports.
-- 5. Tabla de auditoría: public.public_content_moderation_audit.
-- 6. Función determinista server-side: public.evaluar_contenido_publico_determinista.
-- 7. Actualización de RPC: public.abrir_encuentro_seguro (Choke point server-side).
-- 8. RPC: public.reportar_encuentro_publico_seguro (Deduplicación + Rate Limit + Auto-hide).
-- 9. RPCs Administrativos: public.get_moderation_queue_seguro y public.resolver_moderacion_encuentro_seguro.
-- 10. Actualización de RPC: public.get_discovery_encuentros_abiertos (Filtro server-side estricto).
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. ESTADOS DE MODERACIÓN EN public.encuentros Y BACKFILL SEGURO
-- ------------------------------------------------------------------------------

ALTER TABLE public.encuentros
    ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'draft'
        CHECK (moderation_status IN ('draft', 'approved', 'review_pending', 'hidden_pending_review', 'rejected', 'removed')),
    ADD COLUMN IF NOT EXISTS moderation_reason TEXT NULL,
    ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS moderation_decision_source TEXT NULL,
    ADD COLUMN IF NOT EXISTS moderation_categories TEXT[] NULL;

-- Backfill seguro:
-- Los encuentros que ya están abiertos (is_open = true) y activos en producción/staging
-- fueron publicados legítimamente en el sistema vigente y deben conservar visibilidad.
UPDATE public.encuentros
SET moderation_status = 'approved',
    moderated_at = COALESCE(opened_at, creado_en),
    moderation_decision_source = 'legacy_backfill'
WHERE is_open = true AND estado = 'activo';

-- Índice optimizado para Discovery con el nuevo choke point
CREATE INDEX IF NOT EXISTS idx_encuentros_discovery_moderated
    ON public.encuentros(is_open, estado, moderation_status, locality_id)
    WHERE is_open = true AND estado = 'activo' AND moderation_status = 'approved';

-- ------------------------------------------------------------------------------
-- 2. UMBRAL CENTRALIZADO DE AUTO-OCULTAMIENTO
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_moderation_auto_hide_threshold()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT 3;
$$;

REVOKE ALL ON FUNCTION public.get_moderation_auto_hide_threshold() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_moderation_auto_hide_threshold() TO anon, authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 3. POLÍTICA DE RATE LIMIT EN public.rate_limit_policies
-- ------------------------------------------------------------------------------

INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
VALUES ('public_content_report', 10, 3600, true)
ON CONFLICT (action) DO UPDATE
SET max_requests = EXCLUDED.max_requests,
    window_seconds = EXCLUDED.window_seconds,
    enabled = EXCLUDED.enabled,
    updated_at = pg_catalog.now();

-- ------------------------------------------------------------------------------
-- 4. TABLA DE REPORTES DE CONTENIDO PÚBLICO
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.public_content_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL CHECK (reason IN ('spam', 'inappropriate_content', 'fraud_scam', 'harassment', 'other')),
    comment TEXT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed', 'actioned')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    reviewed_at TIMESTAMPTZ NULL,
    reviewed_by UUID NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    resolution_note TEXT NULL,
    CONSTRAINT public_content_reports_unique_reporter_encuentro UNIQUE (reporter_id, encuentro_id),
    CONSTRAINT public_content_reports_comment_len CHECK (comment IS NULL OR pg_catalog.length(comment) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_public_content_reports_encuentro
    ON public.public_content_reports(encuentro_id);
CREATE INDEX IF NOT EXISTS idx_public_content_reports_reporter
    ON public.public_content_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_public_content_reports_status
    ON public.public_content_reports(status, created_at ASC);

ALTER TABLE public.public_content_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.public_content_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.public_content_reports TO postgres, service_role;

-- ------------------------------------------------------------------------------
-- 5. TABLA DE AUDITORÍA DE DECISIONES DE MODERACIÓN
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.public_content_moderation_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    moderator_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    previous_status TEXT NULL,
    new_status TEXT NOT NULL,
    reason TEXT NULL,
    categories TEXT[] NULL,
    source TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_public_content_moderation_audit_encuentro
    ON public.public_content_moderation_audit(encuentro_id);
CREATE INDEX IF NOT EXISTS idx_public_content_moderation_audit_created
    ON public.public_content_moderation_audit(created_at DESC);

ALTER TABLE public.public_content_moderation_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.public_content_moderation_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.public_content_moderation_audit TO postgres, service_role;

-- ------------------------------------------------------------------------------
-- 6. FUNCIÓN DETERMINISTA: EVALUACIÓN DE CONTENIDO PÚBLICO
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.evaluar_contenido_publico_determinista(
    p_title TEXT,
    p_description TEXT
)
RETURNS TABLE (
    decision TEXT,
    reason TEXT,
    categories TEXT[]
)
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
    v_clean_title TEXT := pg_catalog.btrim(COALESCE(p_title, ''));
    v_clean_desc TEXT := pg_catalog.btrim(COALESCE(p_description, ''));
    v_full_text TEXT := pg_catalog.lower(v_clean_title || ' ' || v_clean_desc);
    v_orig_full TEXT := v_clean_title || ' ' || v_clean_desc;
    v_url_count INT := 0;
    v_caps_count INT := 0;
    v_letter_count INT := 0;
    v_caps_ratio NUMERIC := 0;
BEGIN
    -- 1. Detección de payloads maliciosos evidentes
    IF v_full_text ~* '<\s*script|javascript\s*:|data\s*:\s*text\/html|<\s*iframe|<\s*object|<[^>]+href' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'malicious_payload'::TEXT, ARRAY['garbage']::TEXT[];
        RETURN;
    END IF;

    -- 3. Basura extrema / repetición masiva de caracteres o sílabas
    IF v_full_text ~* '([a-z0-9])\1{6,}'
       OR v_full_text ~* '(asdf|qwer|zxcv|1234){4,}' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'garbage_gibberish'::TEXT, ARRAY['garbage']::TEXT[];
        RETURN;
    END IF;

    -- 4. Amenazas explícitas de violencia física o muerte (inequívocas)
    IF v_full_text ~* '(te voy a matar|los voy a matar|amenaza de muerte|te voy a reventar|tiroteo|poner una bomba)' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'violence_threat'::TEXT, ARRAY['violence_threat']::TEXT[];
        RETURN;
    END IF;

    -- 5. Oferta comercial ilícita explícita / venta de estupefacientes o armas
    IF v_full_text ~* '(vendo coca[ií]na|vendo droga|vendo armas|servicios sexuales tarifados|escort tarifas)' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'illegal_activity'::TEXT, ARRAY['illegal_activity']::TEXT[];
        RETURN;
    END IF;

    -- 6. Detección de URLs (Spam masivo vs. Enlace único)
    -- Contar ocurrencias de URLs
    SELECT pg_catalog.count(*) INTO v_url_count
    FROM pg_catalog.regexp_matches(v_full_text, '(https?://|www\.|bit\.ly|t\.co|wa\.me)', 'gi');

    IF v_url_count >= 2 THEN
        RETURN QUERY SELECT 'block'::TEXT, 'excessive_urls'::TEXT, ARRAY['spam']::TEXT[];
        RETURN;
    ELSIF v_url_count = 1 THEN
        -- Un solo enlace genera revisión, no bloqueo automático
        RETURN QUERY SELECT 'review'::TEXT, 'contains_link'::TEXT, ARRAY['advertising']::TEXT[];
        RETURN;
    END IF;

    -- 7. Datos de contacto directos en texto público (Emails o teléfonos masivos)
    IF v_full_text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
       OR v_full_text ~* '(\+?[0-9]{2,4}[\s-]?[0-9]{3,4}[\s-]?[0-9]{4,})' THEN
        RETURN QUERY SELECT 'review'::TEXT, 'contains_personal_contact_data'::TEXT, ARRAY['personal_data']::TEXT[];
        RETURN;
    END IF;

    -- 8. Mayúsculas abusivas / gritos
    IF pg_catalog.length(v_orig_full) > 30 THEN
        SELECT pg_catalog.count(*) INTO v_caps_count
        FROM pg_catalog.regexp_matches(v_orig_full, '[A-ZÁÉÍÓÚÑ]', 'g');

        SELECT pg_catalog.count(*) INTO v_letter_count
        FROM pg_catalog.regexp_matches(v_orig_full, '[a-zA-ZáéíóúñÁÉÍÓÚÑ]', 'g');

        IF v_letter_count > 15 THEN
            v_caps_ratio := (v_caps_count::NUMERIC / v_letter_count::NUMERIC);
            IF v_caps_ratio >= 0.75 THEN
                RETURN QUERY SELECT 'review'::TEXT, 'excessive_caps'::TEXT, ARRAY['spam']::TEXT[];
                RETURN;
            END IF;
        END IF;
    END IF;

    -- 9. Términos ambiguos sin contexto comercial o violento (drogas, armas, sexo)
    -- NOTA: términos sociales legítimos (romance, orgullo, citas, parejas) NO disparan revisión.
    IF v_full_text ~* '\b(drogas?|armas?|pistolas?|balas?|coca[ií]na|marihuana)\b' THEN
        RETURN QUERY SELECT 'review'::TEXT, 'sensitive_terms_ambiguous'::TEXT, ARRAY['other']::TEXT[];
        RETURN;
    END IF;

    -- 10. Todo limpio: aprobado para publicación
    RETURN QUERY SELECT 'allow'::TEXT, 'clean'::TEXT, ARRAY[]::TEXT[];
    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.evaluar_contenido_publico_determinista(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluar_contenido_publico_determinista(TEXT, TEXT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 7. CHOKE POINT SERVER-SIDE: public.abrir_encuentro_seguro
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT DEFAULT NULL,
    p_open_public_zone TEXT DEFAULT NULL
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
    v_loc_record RECORD;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_conv_intencion RECORD;
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

    -- Validaciones de entrada de datos (no son eventos de abuso/moderación)
    IF v_encuentro.titulo IS NULL OR pg_catalog.length(pg_catalog.btrim(v_encuentro.titulo)) < 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_short');
    END IF;

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

    -- EVALUACIÓN DETERMINISTA SERVER-SIDE (CHOKE POINT)
    SELECT * INTO v_eval
    FROM public.evaluar_contenido_publico_determinista(v_encuentro.titulo, p_open_description);

    v_was_open := v_encuentro.is_open;

    -- CASO 1: BLOCK (Violación clara o basura) -> Rechazar apertura
    IF v_eval.decision = 'block' THEN
        UPDATE public.encuentros
        SET moderation_status = 'rejected',
            moderation_reason = v_eval.reason,
            moderated_at = v_now,
            moderation_decision_source = 'deterministic',
            moderation_categories = v_eval.categories,
            is_open = false,
            closed_at = CASE WHEN v_was_open THEN v_now ELSE closed_at END
        WHERE id = p_encuentro_id;

        INSERT INTO public.public_content_moderation_audit (
            encuentro_id, moderator_id, action, previous_status, new_status,
            reason, categories, source, metadata
        ) VALUES (
            p_encuentro_id, v_user_id, 'deterministic_block', v_encuentro.moderation_status, 'rejected',
            v_eval.reason, v_eval.categories, 'deterministic',
            pg_catalog.jsonb_build_object('title', v_encuentro.titulo, 'open_description', p_open_description)
        );

        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'content_moderation_blocked',
            'moderation_status', 'rejected',
            'reason', v_eval.reason
        );
    END IF;

    -- CASO 2: NO BLOQUEADO -> Preparar para publicación pero dejar en REVIEW_PENDING e IS_OPEN = FALSE (CHOKE POINT)
    -- Ningún cliente directo puede establecer is_open = true mediante este RPC.
    -- La aprobación final a approved / is_open = true requiere obligatoriamente resolver_moderacion_encuentro_seguro.
    UPDATE public.encuentros
    SET moderation_status = 'review_pending',
        moderation_reason = v_eval.reason,
        moderated_at = v_now,
        moderation_decision_source = 'deterministic',
        moderation_categories = v_eval.categories,
        is_open = false,
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
        pg_catalog.jsonb_build_object('title', v_encuentro.titulo, 'open_description', p_open_description)
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'is_open', false,
        'moderation_status', 'review_pending',
        'message', 'Solicitud de apertura recibida. En proceso de moderación.',
        'max_participants', p_max_participants,
        'locality_id', v_final_locality_id,
        'open_public_zone', v_final_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------------------------
-- 8. RPC: REPORTAR ENCUENTRO PÚBLICO SEGURO (DEDUPLICACIÓN + RATE LIMIT + AUTO-HIDE)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reportar_encuentro_publico_seguro(
    p_encuentro_id UUID,
    p_reason TEXT,
    p_comment TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_reporter_id UUID := auth.uid();
    v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    v_encuentro public.encuentros%ROWTYPE;
    v_clean_comment TEXT;
    v_rl JSON;
    v_report_count INT := 0;
    v_threshold INT := public.get_moderation_auto_hide_threshold();
    v_auto_hidden BOOLEAN := false;
BEGIN
    -- 1. Control de autenticación y cuenta permanente
    IF v_reporter_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    IF v_is_anon THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 2. Validación de encuentro
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_required');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    -- No permitir auto-reporte
    IF v_encuentro.host_id = v_reporter_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'cannot_report_own_encounter');
    END IF;

    -- 3. Validación de motivo
    IF p_reason IS NULL OR p_reason NOT IN ('spam', 'inappropriate_content', 'fraud_scam', 'harassment', 'other') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_report_reason');
    END IF;

    -- 4. Sanitización de comentario
    v_clean_comment := NULLIF(pg_catalog.btrim(p_comment), '');
    IF v_clean_comment IS NOT NULL THEN
        IF v_clean_comment ~* '<[^>]+>' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_comment_invalid');
        END IF;
        IF pg_catalog.length(v_clean_comment) > 500 THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'report_comment_too_long');
        END IF;
    END IF;

    -- 5. Rate limit: reutilizar infraestructura durable
    v_rl := public.check_rate_limit_and_increment('public_content_report', v_reporter_id::TEXT, v_reporter_id::TEXT);
    IF NOT (v_rl ->> 'allowed')::boolean THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
    END IF;

    -- 6. Inserción con deduplicación por (reporter_id, encuentro_id)
    BEGIN
        INSERT INTO public.public_content_reports (
            encuentro_id, reporter_id, reason, comment, status
        ) VALUES (
            p_encuentro_id, v_reporter_id, p_reason, v_clean_comment, 'pending'
        );
    EXCEPTION
        WHEN unique_violation THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'already_reported');
    END;

    -- 7. Evaluación de auto-ocultamiento (umbral centralizado de reportantes independientes)
    SELECT pg_catalog.count(DISTINCT reporter_id) INTO v_report_count
    FROM public.public_content_reports
    WHERE encuentro_id = p_encuentro_id AND status = 'pending';

    IF v_report_count >= v_threshold AND v_encuentro.moderation_status = 'approved' THEN
        UPDATE public.encuentros
        SET moderation_status = 'hidden_pending_review',
            is_open = false,
            closed_at = pg_catalog.clock_timestamp()
        WHERE id = p_encuentro_id;

        INSERT INTO public.public_content_moderation_audit (
            encuentro_id, moderator_id, action, previous_status, new_status,
            reason, categories, source, metadata
        ) VALUES (
            p_encuentro_id, NULL, 'auto_hide_threshold', 'approved', 'hidden_pending_review',
            'auto_hide_threshold_reached', ARRAY[p_reason]::TEXT[], 'auto_hide_threshold',
            pg_catalog.jsonb_build_object('report_count', v_report_count, 'threshold', v_threshold)
        );

        v_auto_hidden := true;
    END IF;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'report_count', v_report_count,
        'auto_hidden', v_auto_hidden
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reportar_encuentro_publico_seguro(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reportar_encuentro_publico_seguro(UUID, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------------------------
-- 9. RPCS ADMINISTRATIVOS: COLA Y RESOLUCIÓN MANUAL AUDITADA
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_moderation_queue_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_auth BOOLEAN := false;
    v_result JSON;
BEGIN
    -- Verificación de rol administrativo o service_role
    IF auth.role() = 'service_role' THEN
        v_is_auth := true;
    ELSIF v_user_id IS NOT NULL AND public.is_qa_authorized() THEN
        v_is_auth := true;
    END IF;

    IF NOT v_is_auth THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT pg_catalog.json_agg(q_row) INTO v_result
    FROM (
        SELECT
            e.id,
            e.titulo,
            e.open_description,
            e.host_id,
            e.moderation_status,
            e.moderation_reason,
            e.moderation_categories,
            e.moderation_decision_source,
            e.moderated_at,
            e.creado_en AS created_at,
            e.opened_at,
            COALESCE(r_agg.report_count, 0) AS report_count,
            COALESCE(r_agg.reasons, ARRAY[]::TEXT[]) AS report_reasons
        FROM public.encuentros e
        LEFT JOIN (
            SELECT
                encuentro_id,
                pg_catalog.count(DISTINCT reporter_id) AS report_count,
                pg_catalog.array_agg(DISTINCT reason) AS reasons
            FROM public.public_content_reports
            WHERE status = 'pending'
            GROUP BY encuentro_id
        ) r_agg ON r_agg.encuentro_id = e.id
        WHERE e.moderation_status IN ('review_pending', 'hidden_pending_review', 'rejected')
           OR COALESCE(r_agg.report_count, 0) > 0
        ORDER BY COALESCE(r_agg.report_count, 0) DESC, e.moderated_at DESC NULLS LAST
    ) q_row;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'queue', COALESCE(v_result, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_moderation_queue_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_moderation_queue_seguro() TO authenticated, postgres, service_role;

CREATE OR REPLACE FUNCTION public.resolver_moderacion_encuentro_seguro(
    p_encuentro_id UUID,
    p_action TEXT,
    p_note TEXT DEFAULT NULL
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
    v_source TEXT := CASE WHEN auth.role() = 'service_role' THEN 'automated_moderation' ELSE 'admin' END;
BEGIN
    -- Verificación de rol administrativo o service_role
    IF auth.role() = 'service_role' THEN
        v_is_auth := true;
    ELSIF v_user_id IS NOT NULL AND public.is_qa_authorized() THEN
        v_is_auth := true;
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

    IF p_action = 'approve' THEN
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
        pg_catalog.jsonb_build_object('moderator_role', CASE WHEN auth.role() = 'service_role' THEN 'service_role' ELSE 'admin_qa' END)
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'previous_status', v_encuentro.moderation_status,
        'new_status', v_new_status,
        'is_open', v_is_open
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 10. ACTUALIZACIÓN DE RPC DISCOVERY: get_discovery_encuentros_abiertos
-- ------------------------------------------------------------------------------

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
          AND e.moderation_status = 'approved'
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
          -- Filtrar bloqueos bilaterales si el viewer está autenticado
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

COMMIT;
