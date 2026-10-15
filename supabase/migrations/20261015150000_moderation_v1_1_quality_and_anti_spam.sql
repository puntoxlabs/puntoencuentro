-- ==============================================================================
-- Migración: 20261015150000_moderation_v1_1_quality_and_anti_spam.sql
-- Tarea: Moderación v1.1 — Calidad pública + Anti-Spam Gate
--
-- Contenido:
-- 1. Función determinista actualizada: public.evaluar_contenido_publico_determinista(p_title, p_description).
-- 2. Función piso mínimo antiabuso privado: public.evaluar_antiabuso_privado_determinista(p_titulo, p_descripcion).
-- 3. Actualización de RPC: public.abrir_encuentro_seguro (Invariante de privacidad estricto: cero datos privados a moderación pública).
-- 4. Actualización de RPC: public.actualizar_encuentro_seguro (Invariante de privacidad y re-evaluación).
-- 5. Actualización de RPC: public.get_encuentro_por_public_token (Bloqueo de invitaciones con abuso severo).
-- 6. Actualización de RPC: public.crear_encuentro_seguro (Piso mínimo antiabuso en link general).
-- 7. Actualización de RPC: public.crear_encuentro_con_opciones_seguro (Piso mínimo antiabuso en link general).
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. FUNCIÓN DETERMINISTA: EVALUAR CONTENIDO PÚBLICO
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
    -- 1. Longitud básica
    IF pg_catalog.length(v_clean_title) < 3 THEN
        RETURN QUERY SELECT 'block'::TEXT, 'title_too_short'::TEXT, ARRAY['garbage']::TEXT[];
        RETURN;
    END IF;

    -- 2. Payloads maliciosos
    IF v_full_text ~* '<\s*script|javascript\s*:|data\s*:\s*text\/html|<\s*iframe|<\s*object|<\s*embed|<\s*svg|<[^>]+href' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'malicious_payload'::TEXT, ARRAY['malicious_payload']::TEXT[];
        RETURN;
    END IF;

    -- 3. Basura extrema / repetición masiva de caracteres o sílabas
    IF v_full_text ~* '([a-z0-9])\1{5,}'
       OR v_full_text ~* '(asdf|qwer|zxcv|1234){3,}'
       OR v_full_text ~* '\b[bcdfghjklmnpqrstvwxyz]{6,}\b' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'gibberish'::TEXT, ARRAY['garbage']::TEXT[];
        RETURN;
    END IF;

    -- 4. Amenazas explícitas de violencia física o muerte
    IF v_full_text ~* '(te voy a matar|los voy a matar|amenaza de muerte|te voy a reventar|tiroteo|poner una bomba|vamos a golpear|masacre)' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'violence_threat'::TEXT, ARRAY['violence_threat']::TEXT[];
        RETURN;
    END IF;

    -- 5. Oferta comercial ilícita explícita / estupefacientes / armas
    IF v_full_text ~* '(vendo coca[ií]na|vendo droga|vendo armas|servicios sexuales tarifados|escort tarifas)' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'illegal_activity'::TEXT, ARRAY['illegal_activity']::TEXT[];
        RETURN;
    END IF;

    -- 6. Scams / Phishing / Captación fraudulenta
    IF v_full_text ~* '(ingres[aá] tu contrase[ñn]a|verific[aá] tu cuenta bancaria|actualiz[aá] tus datos bancarios|ganaste un sorteo de|tarjeta de cr[eé]dito gratis|click aqu[ií] para reclamar premio|inversi[oó]n en cripto asegurada|ganancias garantizadas en d[oó]lares|esquema piramidal|forex trading garantizado)' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'possible_scam'::TEXT, ARRAY['fraud_scam']::TEXT[];
        RETURN;
    END IF;

    -- 7. Exceso de símbolos reiterados
    IF v_orig_full ~* '([!?#$%&*+=~^_\-]){5,}' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'excessive_symbols'::TEXT, ARRAY['excessive_symbols']::TEXT[];
        RETURN;
    END IF;

    -- 8. Detección de URLs (Spam masivo vs. Enlace único)
    SELECT pg_catalog.count(*) INTO v_url_count
    FROM pg_catalog.regexp_matches(v_full_text, '(?:https?://[^\s]+|(?:www\.|bit\.ly/|tinyurl\.com/|t\.co/|wa\.me/|t\.me/|linktr\.ee/|discord\.gg/|cutt\.ly/)[^\s]+)', 'gi');

    IF v_url_count >= 2 THEN
        RETURN QUERY SELECT 'block'::TEXT, 'commercial_spam'::TEXT, ARRAY['spam']::TEXT[];
        RETURN;
    ELSIF v_url_count = 1 THEN
        IF v_full_text ~* '(wa\.me|t\.me)' THEN
            RETURN QUERY SELECT 'review'::TEXT, 'external_contact'::TEXT, ARRAY['external_contact']::TEXT[];
            RETURN;
        END IF;
        RETURN QUERY SELECT 'review'::TEXT, 'contains_link'::TEXT, ARRAY['advertising']::TEXT[];
        RETURN;
    END IF;

    -- 9. Datos de contacto directos en texto público (Emails o teléfonos)
    IF v_full_text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
       OR v_full_text ~* '(?:arroba|\(at\)|\[at\])\s*[a-z0-9.-]+\s*(?:punto|\(dot\)|\[dot\]|\.)\s*[a-z]{2,}'
       OR v_full_text ~* '(\+?[0-9]{2,4}[\s-]?[0-9]{3,4}[\s-]?[0-9]{4,})'
       OR v_full_text ~* '\b(?:\d\s+){6,}\d\b'
       OR v_full_text ~* '(?:mi\s+ig|mi\s+wsp|mi\s+wapp|escribime\s+al\s+wsp|hablame\s+al\s+wsp|telegram:\s*@?|instagram:\s*@?)\s*[@a-z0-9_.]+' THEN
        RETURN QUERY SELECT 'review'::TEXT, 'external_contact'::TEXT, ARRAY['personal_data']::TEXT[];
        RETURN;
    END IF;

    -- 10. Publicidad comercial explícita
    IF v_full_text ~* '(trabaja desde casa|gana dinero f[aá]cil|inversi[oó]n de bajo riesgo|compr[aá] ya con descuento|oferta exclusiva por tiempo limitado|distribuidor mayorista oficial|venta directa por cat[aá]logo)' THEN
        RETURN QUERY SELECT 'block'::TEXT, 'commercial_spam'::TEXT, ARRAY['advertising', 'commercial_spam']::TEXT[];
        RETURN;
    END IF;

    -- 11. Mayúsculas abusivas / gritos
    IF pg_catalog.length(v_orig_full) > 30 THEN
        SELECT pg_catalog.count(*) INTO v_caps_count
        FROM pg_catalog.regexp_matches(v_orig_full, '[A-ZÁÉÍÓÚÑ]', 'g');

        SELECT pg_catalog.count(*) INTO v_letter_count
        FROM pg_catalog.regexp_matches(v_orig_full, '[a-zA-ZáéíóúñÁÉÍÓÚÑ]', 'g');

        IF v_letter_count > 15 THEN
            v_caps_ratio := (v_caps_count::NUMERIC / v_letter_count::NUMERIC);
            IF v_caps_ratio >= 0.75 THEN
                RETURN QUERY SELECT 'review'::TEXT, 'excessive_symbols'::TEXT, ARRAY['spam']::TEXT[];
                RETURN;
            END IF;
        END IF;
    END IF;

    -- 12. Términos sensibles ambiguos
    IF v_full_text ~* '\b(drogas?|armas?|pistolas?|balas?|coca[ií]na|marihuana)\b' THEN
        RETURN QUERY SELECT 'review'::TEXT, 'sensitive_terms_ambiguous'::TEXT, ARRAY['other']::TEXT[];
        RETURN;
    END IF;

    -- Todo limpio
    RETURN QUERY SELECT 'allow'::TEXT, 'clean_social_meetup'::TEXT, ARRAY[]::TEXT[];
    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.evaluar_contenido_publico_determinista(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluar_contenido_publico_determinista(TEXT, TEXT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 2. FUNCIÓN: PISO MÍNIMO ANTIABUSO PRIVADO
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.evaluar_antiabuso_privado_determinista(
    p_titulo TEXT,
    p_descripcion TEXT
)
RETURNS TABLE (
    allowed BOOLEAN,
    reason TEXT
)
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
    v_clean_title TEXT := pg_catalog.btrim(COALESCE(p_titulo, ''));
    v_clean_desc TEXT := pg_catalog.btrim(COALESCE(p_descripcion, ''));
    v_text TEXT := pg_catalog.lower(v_clean_title || ' ' || v_clean_desc);
BEGIN
    -- 1. Payloads maliciosos de inyección web
    IF v_text ~* '<\s*script|javascript\s*:|data\s*:\s*text\/html|<\s*iframe|<\s*object|<\s*embed' THEN
        RETURN QUERY SELECT false, 'malicious_payload'::TEXT;
        RETURN;
    END IF;

    -- 2. Robo de credenciales bancarias o contraseñas
    IF v_text ~* '(ingres[aá]\s+(tu|su)\s+contrase[ñn]a|verific[aá]\s+(tu|su)\s+clave\s+bancaria|actualiz[aá]\s+tus\s+datos\s+bancarios|robo\s+de\s+cuenta|inici[aá]\s+sesi[oó]n\s+en\s+home\s*banking|ingres[aá]\s+el\s+token\s+de\s+tu\s+banco)' THEN
        RETURN QUERY SELECT false, 'credential_theft'::TEXT;
        RETURN;
    END IF;

    -- 3. Scams masivos
    IF v_text ~* '(ganaste\s+(un\s+sorteo|\$1000000|un\s+auto)\s+reclamalo\s+aqu[ií]|tarjeta\s+de\s+cr[eé]dito\s+gratis\s+sin\s+requisitos\s+click)' THEN
        RETURN QUERY SELECT false, 'severe_scam'::TEXT;
        RETURN;
    END IF;

    -- Todo lo demás (otros idiomas, comerciales privados, títulos raros, textos informales) está permitido
    RETURN QUERY SELECT true, 'clean'::TEXT;
    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.evaluar_antiabuso_privado_determinista(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluar_antiabuso_privado_determinista(TEXT, TEXT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 3. CHOKE POINT SERVER-SIDE: abrir_encuentro_seguro
-- (Invariante de Privacidad: NUNCA envía lugar_texto ni link_virtual al análisis público)
-- ------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, INT);

CREATE OR REPLACE FUNCTION public.abrir_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,
    p_open_description TEXT,
    p_max_participants INT,
    p_locality_id TEXT DEFAULT NULL,
    p_open_public_zone TEXT DEFAULT NULL,
    p_open_public_title TEXT DEFAULT NULL,
    p_allow_multi_seat_requests BOOLEAN DEFAULT false,
    p_max_seats_per_request INT DEFAULT 1,
    p_min_seats_per_request INT DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro RECORD;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_was_open BOOLEAN;
    v_eval RECORD;
    v_loc_record RECORD;
    v_final_public_zone TEXT;
    v_final_locality_id TEXT;
    v_final_public_title TEXT;
    v_confirmed_seats INT := 0;
    v_final_multi_seat BOOLEAN := false;
    v_final_max_seats INT := 1;
    v_final_min_seats INT := 1;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_user_id <> p_host_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encounter_not_active');
    END IF;

    -- Validar cupo
    IF p_max_participants IS NULL OR p_max_participants < 1 OR p_max_participants > 40 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_slots');
    END IF;

    SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
    FROM public.participantes
    WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

    IF p_max_participants < v_confirmed_seats THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'max_participants_too_low');
    END IF;

    -- Validar multi-seat
    IF COALESCE(p_allow_multi_seat_requests, false) THEN
        v_final_multi_seat := true;
        IF p_max_seats_per_request IS NULL OR p_max_seats_per_request < 2 OR p_max_seats_per_request > p_max_participants THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_max_seats_per_request');
        END IF;
        v_final_max_seats := p_max_seats_per_request;

        v_final_min_seats := COALESCE(p_min_seats_per_request, 1);
        IF v_final_min_seats < 1 OR v_final_min_seats > v_final_max_seats THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_min_seats_per_request');
        END IF;
    ELSE
        v_final_multi_seat := false;
        v_final_max_seats := 1;
        v_final_min_seats := 1;
    END IF;

    -- Resolver título público
    IF p_open_public_title IS NOT NULL AND pg_catalog.btrim(p_open_public_title) <> '' THEN
        v_final_public_title := pg_catalog.btrim(p_open_public_title);
    ELSIF v_encuentro.open_public_title IS NOT NULL AND pg_catalog.btrim(v_encuentro.open_public_title) <> '' THEN
        v_final_public_title := pg_catalog.btrim(v_encuentro.open_public_title);
    ELSE
        v_final_public_title := pg_catalog.btrim(v_encuentro.titulo);
    END IF;

    IF pg_catalog.length(v_final_public_title) < 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_short');
    END IF;
    IF pg_catalog.length(v_final_public_title) > 80 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_long');
    END IF;

    -- Validar logística privada preexistente
    IF v_encuentro.modalidad = 'presencial' THEN
        IF v_encuentro.lugar_texto IS NULL OR pg_catalog.btrim(v_encuentro.lugar_texto) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'private_location_required');
        END IF;
    ELSIF v_encuentro.modalidad = 'virtual' THEN
        IF v_encuentro.link_virtual IS NULL OR pg_catalog.btrim(v_encuentro.link_virtual) = '' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'virtual_link_required');
        END IF;
    END IF;

    -- Resolver localidad y zona según modalidad
    IF v_encuentro.modalidad = 'virtual' THEN
        v_final_locality_id := NULL;
        v_final_public_zone := 'Online';
    ELSE
        v_final_locality_id := p_locality_id;
        v_final_public_zone := NULLIF(pg_catalog.btrim(p_open_public_zone), '');

        IF v_final_locality_id IS NULL AND v_final_public_zone IS NULL THEN
            IF v_encuentro.locality_id IS NOT NULL THEN
                v_final_locality_id := v_encuentro.locality_id;
                v_final_public_zone := v_encuentro.open_public_zone;
            ELSE
                v_final_locality_id := 'guemes';
            END IF;
        END IF;

        IF v_final_locality_id IS NOT NULL AND v_final_public_zone IS NULL THEN
            SELECT * INTO v_loc_record FROM public.localidades WHERE id = v_final_locality_id AND activo = true;
            IF FOUND THEN
                v_final_public_zone := v_loc_record.nombre;
            ELSE
                v_final_locality_id := 'guemes';
                v_final_public_zone := 'Güemes';
            END IF;
        END IF;
    END IF;

    v_was_open := COALESCE(v_encuentro.is_open, false);

    -- EVALUACIÓN DETERMINISTA SERVER-SIDE (Estricta privacidad: solo campos públicos)
    SELECT * INTO v_eval FROM public.evaluar_contenido_publico_determinista(
        v_final_public_title,
        p_open_description
    );

    -- CASO 1: BLOQUEO DETERMINISTA INMEDIATO (CHOKE POINT)
    IF v_eval.decision = 'block' THEN
        UPDATE public.encuentros
        SET moderation_status = 'rejected',
            moderation_reason = v_eval.reason,
            moderated_at = v_now,
            moderation_decision_source = 'deterministic',
            moderation_categories = v_eval.categories,
            open_public_title = v_final_public_title,
            open_description = p_open_description,
            is_open = false,
            closed_at = CASE WHEN v_was_open THEN v_now ELSE closed_at END,
            max_participants = p_max_participants,
            allow_multi_seat_requests = v_final_multi_seat,
            max_seats_per_request = v_final_max_seats,
            min_seats_per_request = v_final_min_seats,
            locality_id = v_final_locality_id,
            open_public_zone = v_final_public_zone
        WHERE id = p_encuentro_id;

        INSERT INTO public.public_content_moderation_audit (
            encuentro_id, moderator_id, action, previous_status, new_status,
            reason, categories, source, metadata
        ) VALUES (
            p_encuentro_id, v_user_id, 'deterministic_block', v_encuentro.moderation_status, 'rejected',
            v_eval.reason, v_eval.categories, 'deterministic',
            pg_catalog.jsonb_build_object('title', v_final_public_title, 'open_description', p_open_description)
        );

        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'content_moderation_blocked',
            'moderation_status', 'rejected',
            'reason', v_eval.reason,
            'message', 'El contenido no cumple las normas de seguridad comunitaria.'
        );
    END IF;

    -- CASO 2: NO BLOQUEADO -> Deja en review_pending e is_open = false para resolución de pipeline
    UPDATE public.encuentros
    SET is_open = false,
        open_public_title = v_final_public_title,
        open_description = p_open_description,
        max_participants = p_max_participants,
        allow_multi_seat_requests = v_final_multi_seat,
        max_seats_per_request = v_final_max_seats,
        min_seats_per_request = v_final_min_seats,
        locality_id = v_final_locality_id,
        open_public_zone = v_final_public_zone,
        moderation_status = 'review_pending',
        moderated_at = NULL,
        moderation_reason = v_eval.reason,
        moderation_categories = v_eval.categories,
        opened_at = COALESCE(v_encuentro.opened_at, v_now)
    WHERE id = p_encuentro_id;

    INSERT INTO public.public_content_moderation_audit (
        encuentro_id, moderator_id, action, previous_status, new_status,
        reason, categories, source, metadata
    ) VALUES (
        p_encuentro_id, v_user_id, 'publish_requested', v_encuentro.moderation_status, 'review_pending',
        v_eval.reason, v_eval.categories, 'user_request',
        pg_catalog.jsonb_build_object('title', v_final_public_title, 'open_description', p_open_description)
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', p_encuentro_id,
        'is_open', false,
        'moderation_status', 'review_pending',
        'open_public_title', v_final_public_title,
        'max_participants', p_max_participants,
        'allow_multi_seat_requests', v_final_multi_seat,
        'max_seats_per_request', v_final_max_seats,
        'min_seats_per_request', v_final_min_seats,
        'locality_id', v_final_locality_id,
        'open_public_zone', v_final_public_zone
    );
END;
$$;

REVOKE ALL ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abrir_encuentro_seguro(UUID, UUID, TEXT, INT, TEXT, TEXT, TEXT, BOOLEAN, INT, INT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 4. ACTUALIZACIÓN DE RPC: actualizar_encuentro_seguro
-- (Invariante de Privacidad: Cero datos privados a moderación pública)
-- ------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.actualizar_encuentro_seguro(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.actualizar_encuentro_seguro(UUID, UUID, JSON);

CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro(
    p_encuentro_id UUID,
    p_host_id UUID,
    p_data JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_encuentro public.encuentros%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());

    v_title_changed BOOLEAN := false;
    v_open_title_changed BOOLEAN := false;
    v_open_desc_changed BOOLEAN := false;
    v_modality_changed BOOLEAN := false;
    v_locality_changed BOOLEAN := false;
    v_zone_changed BOOLEAN := false;

    v_moderation_invalidated BOOLEAN := false;
    v_new_status TEXT := NULL;
    v_new_is_open BOOLEAN := NULL;
    v_det_reason TEXT := NULL;

    v_new_title TEXT;
    v_new_open_title TEXT;
    v_new_open_desc TEXT;
    v_new_modalidad TEXT;
    v_new_locality_id TEXT;
    v_new_public_zone TEXT;
    v_new_max_participants INT;
    v_new_allow_multi BOOLEAN;
    v_new_max_seats INT;
    v_new_min_seats INT;
    v_confirmed_seats INT := 0;

    v_loc_record RECORD;
    v_eval RECORD;
    v_effective_eval_title TEXT;
    v_changed_fields TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_user_id <> p_host_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_encuentro.host_id <> v_user_id THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'encounter_not_active');
    END IF;

    IF v_encuentro.is_open = true AND p_data ? 'modalidad' AND (p_data->>'modalidad') <> v_encuentro.modalidad THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_change_modality_while_open');
    END IF;

    v_new_title := CASE WHEN p_data ? 'titulo' THEN NULLIF(pg_catalog.btrim(p_data->>'titulo'), '') ELSE v_encuentro.titulo END;
    v_new_open_title := CASE WHEN p_data ? 'open_public_title' THEN NULLIF(pg_catalog.btrim(p_data->>'open_public_title'), '') ELSE v_encuentro.open_public_title END;
    v_new_open_desc := CASE WHEN p_data ? 'open_description' THEN NULLIF(pg_catalog.btrim(p_data->>'open_description'), '') ELSE v_encuentro.open_description END;
    v_new_modalidad := COALESCE(p_data->>'modalidad', v_encuentro.modalidad);
    v_new_locality_id := CASE WHEN p_data ? 'locality_id' THEN p_data->>'locality_id' ELSE v_encuentro.locality_id END;
    v_new_public_zone := CASE WHEN p_data ? 'open_public_zone' THEN p_data->>'open_public_zone' ELSE v_encuentro.open_public_zone END;

    IF p_data ? 'open_public_title' THEN
        IF v_new_open_title IS NULL OR pg_catalog.length(v_new_open_title) < 3 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'title_too_short');
        END IF;
        IF pg_catalog.length(v_new_open_title) > 80 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'title_too_long');
        END IF;
    END IF;

    IF p_data ? 'max_participants' THEN
        v_new_max_participants := (p_data->>'max_participants')::int;
        IF v_new_max_participants IS NULL OR v_new_max_participants < 1 OR v_new_max_participants > 40 THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_slots');
        END IF;

        SELECT COALESCE(pg_catalog.sum(seat_count), 0)::int INTO v_confirmed_seats
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id AND estado IN ('confirmado', 'asistio');

        IF v_new_max_participants < v_confirmed_seats THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'max_participants_too_low');
        END IF;
    ELSE
        v_new_max_participants := v_encuentro.max_participants;
    END IF;

    IF p_data ? 'allow_multi_seat_requests' THEN
        v_new_allow_multi := (p_data->>'allow_multi_seat_requests')::boolean;
    ELSE
        v_new_allow_multi := v_encuentro.allow_multi_seat_requests;
    END IF;

    IF p_data ? 'max_seats_per_request' THEN
        v_new_max_seats := (p_data->>'max_seats_per_request')::int;
    ELSE
        v_new_max_seats := v_encuentro.max_seats_per_request;
    END IF;

    IF p_data ? 'min_seats_per_request' THEN
        v_new_min_seats := (p_data->>'min_seats_per_request')::int;
    ELSE
        v_new_min_seats := COALESCE(v_encuentro.min_seats_per_request, 1);
    END IF;

    IF COALESCE(v_new_allow_multi, false) THEN
        IF v_new_max_seats IS NULL OR v_new_max_seats < 2 OR (v_new_max_participants IS NOT NULL AND v_new_max_seats > v_new_max_participants) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_max_seats_per_request');
        END IF;
        IF v_new_min_seats IS NOT NULL AND (v_new_min_seats < 1 OR v_new_min_seats > v_new_max_seats) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_min_seats_per_request');
        END IF;
    ELSE
        v_new_max_seats := 1;
        v_new_min_seats := 1;
    END IF;

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

    IF p_data ? 'modalidad' AND COALESCE(v_new_modalidad, '') <> COALESCE(v_encuentro.modalidad, '') THEN
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

    -- Si el encuentro alguna vez fue abierto/moderado y se modificó algún campo público
    IF v_encuentro.moderation_status IN ('approved', 'rejected') AND (v_open_title_changed OR v_open_desc_changed OR v_modality_changed OR v_locality_changed OR v_zone_changed) THEN
        v_effective_eval_title := COALESCE(v_new_open_title, v_encuentro.open_public_title, v_new_title, v_encuentro.titulo);

        -- Invariante de privacidad: solo evaluar campos públicos
        SELECT * INTO v_eval FROM public.evaluar_contenido_publico_determinista(
            v_effective_eval_title,
            COALESCE(v_new_open_desc, v_encuentro.open_description, '')
        );

        v_moderation_invalidated := true;

        IF v_eval.decision = 'block' THEN
            v_new_status := 'rejected';
            v_new_is_open := false;
            v_det_reason := v_eval.reason;
        ELSE
            v_new_status := 'review_pending';
            v_new_is_open := false;
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
        max_participants = v_new_max_participants,
        allow_multi_seat_requests = COALESCE(v_new_allow_multi, false),
        max_seats_per_request = COALESCE(v_new_max_seats, 1),
        min_seats_per_request = COALESCE(v_new_min_seats, 1),
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
        moderation_status = COALESCE(v_new_status, moderation_status),
        is_open = COALESCE(v_new_is_open, is_open),
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
        'moderation_status', COALESCE(v_new_status, v_encuentro.moderation_status),
        'is_open', COALESCE(v_new_is_open, v_encuentro.is_open),
        'max_participants', v_new_max_participants,
        'allow_multi_seat_requests', COALESCE(v_new_allow_multi, false),
        'max_seats_per_request', COALESCE(v_new_max_seats, 1),
        'min_seats_per_request', COALESCE(v_new_min_seats, 1),
        'open_public_title', v_new_open_title
    );
END;
$$;

REVOKE ALL ON FUNCTION public.actualizar_encuentro_seguro(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.actualizar_encuentro_seguro(UUID, UUID, JSONB) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 5. ACTUALIZACIÓN DE RPC: get_encuentro_por_public_token
-- (Piso mínimo antiabuso: bloquea invitaciones con phishing o payloads maliciosos)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_encuentro_por_public_token(
    p_public_token text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_encuentro RECORD;
    v_token_uuid UUID;
    v_priv_eval RECORD;
BEGIN
    BEGIN
        v_token_uuid := p_public_token::UUID;
    EXCEPTION WHEN OTHERS THEN
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
        locality_id,
        moderation_status,
        moderation_reason
    INTO v_encuentro
    FROM public.encuentros
    WHERE public_token = v_token_uuid;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_encuentro.estado <> 'activo' THEN
        RETURN NULL;
    END IF;

    -- Piso mínimo antiabuso: evaluar contenido privado de la invitación compartible
    SELECT * INTO v_priv_eval FROM public.evaluar_antiabuso_privado_determinista(v_encuentro.titulo, v_encuentro.descripcion);
    IF NOT v_priv_eval.allowed THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'private_content_blocked',
            'reason', v_priv_eval.reason,
            'message', 'Este enlace de invitación no está disponible porque el contenido infringe las normas de seguridad de la comunidad.'
        );
    END IF;

    RETURN pg_catalog.json_build_object(
        'id',                  v_encuentro.id,
        'titulo',              CASE
                                   WHEN v_encuentro.is_open = true THEN v_encuentro.open_public_title
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
GRANT EXECUTE ON FUNCTION public.get_encuentro_por_public_token(text) TO anon, authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 6. ACTUALIZACIÓN DE RPC: crear_encuentro_seguro
-- (Piso mínimo antiabuso si es link_general compartible)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.crear_encuentro_seguro(p_data jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id          uuid := auth.uid();
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

-- ------------------------------------------------------------------------------
-- 7. ACTUALIZACIÓN DE RPC: crear_encuentro_con_opciones_seguro
-- (Piso mínimo antiabuso si es link_general compartible)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.crear_encuentro_con_opciones_seguro(
    p_data jsonb,
    p_opciones jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id uuid;
    v_enc_id uuid;
    v_token uuid;
    v_tema_invitacion text;
    v_deadline timestamptz;
    v_min_opcion_ts timestamptz;
    v_opciones_count int;
    v_ord int := 1;
    v_op record;

    v_op_fecha date;
    v_op_hora time;
    v_op_ts timestamptz;

    v_arr_fechas date[];
    v_arr_horas time[];
    v_arr_ts timestamptz[];
    v_idx int;
    v_is_duplicate boolean;

    v_titulo text;
    v_modalidad text;
    v_lugar_texto text;
    v_link_virtual text;
    v_tipo_invitacion text;
    v_tema text;
    v_duration_numeric numeric;
    v_duration_minutes integer;
    v_mostrar_respuestas_a_invitados boolean;
    v_visibilidad_respuestas text;
    v_post_minutes integer;
    v_post_raw text;
    v_rl jsonb;
    v_priv_eval record;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_authenticated');
    END IF;

    IF COALESCE((auth.jwt()->>'is_anonymous')::boolean, false) THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_data');
    END IF;

    IF p_opciones IS NULL OR jsonb_typeof(p_opciones) <> 'array' THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_options');
    END IF;

    -- Piso mínimo antiabuso para invitaciones coordinadas compartibles
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

    v_opciones_count := jsonb_array_length(p_opciones);
    IF v_opciones_count < 2 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'minimum_two_options');
    END IF;
    IF v_opciones_count > 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'maximum_three_options');
    END IF;

    FOR v_idx IN 0..jsonb_array_length(p_opciones)-1 LOOP
        v_op_fecha := (p_opciones->v_idx->>'fecha')::date;
        v_op_hora := (p_opciones->v_idx->>'hora_inicio')::time;

        IF v_op_fecha IS NULL OR v_op_hora IS NULL THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_option_format');
        END IF;

        v_op_ts := (v_op_fecha + v_op_hora) AT TIME ZONE 'America/Argentina/Buenos_Aires';

        IF v_op_ts < pg_catalog.now() THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'option_in_past');
        END IF;

        IF v_min_opcion_ts IS NULL OR v_op_ts < v_min_opcion_ts THEN
            v_min_opcion_ts := v_op_ts;
        END IF;

        IF v_arr_ts IS NOT NULL THEN
            v_is_duplicate := false;
            FOREACH v_op_ts IN ARRAY v_arr_ts LOOP
                IF v_op_ts = (v_op_fecha + v_op_hora) AT TIME ZONE 'America/Argentina/Buenos_Aires' THEN
                    v_is_duplicate := true;
                    EXIT;
                END IF;
            END LOOP;
            IF v_is_duplicate THEN
                RETURN pg_catalog.json_build_object('ok', false, 'error', 'duplicate_option');
            END IF;
        END IF;

        v_arr_fechas := array_append(v_arr_fechas, v_op_fecha);
        v_arr_horas := array_append(v_arr_horas, v_op_hora);
        v_arr_ts := array_append(v_arr_ts, (v_op_fecha + v_op_hora) AT TIME ZONE 'America/Argentina/Buenos_Aires');
    END LOOP;

    v_titulo := p_data->>'titulo';
    IF v_titulo IS NULL OR pg_catalog.length(pg_catalog.btrim(v_titulo)) < 3 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'title_too_short');
    END IF;

    v_modalidad := p_data->>'modalidad';
    IF v_modalidad NOT IN ('presencial', 'virtual') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_modality');
    END IF;

    v_lugar_texto := p_data->>'lugar_texto';
    v_link_virtual := p_data->>'link_virtual';
    IF v_modalidad = 'presencial' AND (v_lugar_texto IS NULL OR pg_catalog.btrim(v_lugar_texto) = '') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'location_required');
    END IF;
    IF v_modalidad = 'virtual' AND (v_link_virtual IS NULL OR pg_catalog.btrim(v_link_virtual) = '') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'virtual_link_required');
    END IF;

    IF p_data->>'deadline' IS NOT NULL THEN
        v_deadline := (p_data->>'deadline')::timestamptz;
        IF v_deadline <= pg_catalog.now() THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'deadline_in_past');
        END IF;
        IF v_deadline >= v_min_opcion_ts THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'deadline_after_earliest_option');
        END IF;
    ELSE
        v_deadline := pg_catalog.least(
            pg_catalog.now() + interval '2 days',
            v_min_opcion_ts - interval '2 hours'
        );
        IF v_deadline <= pg_catalog.now() THEN
            v_deadline := pg_catalog.now() + interval '30 minutes';
        END IF;
    END IF;

    v_tema_invitacion := CASE
        WHEN p_data->>'tema_invitacion' IN (
            'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
            'family', 'special', 'romantic', 'sports', 'entertainment',
            'learning', 'wellness', 'custom'
        ) THEN p_data->>'tema_invitacion'
        ELSE 'classic'
    END;

    v_duration_numeric := (p_data->>'duration_minutes')::numeric;
    v_duration_minutes := COALESCE(v_duration_numeric::integer, 120);
    IF v_duration_minutes < 15 OR v_duration_minutes > 1440 THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_duration');
    END IF;

    v_tipo_invitacion := COALESCE(p_data->>'tipo_invitacion', 'individual');
    v_tema := COALESCE(p_data->>'tema', 'blue');

    v_visibilidad_respuestas := CASE
        WHEN p_data->>'visibilidad_respuestas' IN ('hidden', 'summary', 'detail') THEN p_data->>'visibilidad_respuestas'
        WHEN (p_data->>'mostrar_respuestas_a_invitados')::boolean IS TRUE THEN 'summary'
        ELSE 'hidden'
    END;
    v_mostrar_respuestas_a_invitados := (v_visibilidad_respuestas <> 'hidden');

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

    -- Rate limit
    v_rl := public.check_rate_limit_internal('create_encounter', '');
    IF NOT COALESCE((v_rl->>'allowed')::boolean, false) THEN
        IF (v_rl->>'error') = 'rate_limit_exceeded' THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_exceeded');
        ELSE
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'rate_limit_unavailable');
        END IF;
    END IF;

    v_enc_id := COALESCE((p_data->>'id')::uuid, gen_random_uuid());
    v_token := COALESCE((p_data->>'public_token')::uuid, gen_random_uuid());

    INSERT INTO public.encuentros (
        id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, link_virtual,
        tipo_invitacion, host_id, public_token, estado, tema, tema_invitacion,
        invitation_template, date_mode, duration_minutes, post_event_active_minutes,
        mostrar_respuestas_a_invitados, visibilidad_respuestas
    )
    VALUES (
        v_enc_id, v_titulo, p_data->>'descripcion', NULL, NULL, v_modalidad,
        v_lugar_texto, v_link_virtual, v_tipo_invitacion, v_user_id, v_token,
        'activo', v_tema, v_tema_invitacion, p_data->>'invitation_template',
        'coordination', v_duration_minutes, v_post_minutes,
        v_mostrar_respuestas_a_invitados, v_visibilidad_respuestas
    );

    FOR v_idx IN 0..jsonb_array_length(p_opciones)-1 LOOP
        INSERT INTO public.encuentro_opciones_fecha (
            encuentro_id, fecha, hora_inicio, orden
        )
        VALUES (
            v_enc_id,
            (p_opciones->v_idx->>'fecha')::date,
            (p_opciones->v_idx->>'hora_inicio')::time,
            v_ord
        );
        v_ord := v_ord + 1;
    END LOOP;

    INSERT INTO public.coordinacion_fase (
        encuentro_id, estado, deadline
    )
    VALUES (
        v_enc_id, 'voting', v_deadline
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'id', v_enc_id,
        'public_token', v_token
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_encuentro_con_opciones_seguro(jsonb, jsonb) TO authenticated, postgres, service_role;

COMMIT;
