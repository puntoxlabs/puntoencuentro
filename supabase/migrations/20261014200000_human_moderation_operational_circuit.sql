-- ==============================================================================
-- MIGRACIÓN ADITIVA: CIRCUITO OPERATIVO DE MODERACIÓN HUMANA DE CONTENIDO PÚBLICO
-- ==============================================================================
-- 1. Helper server-side public.is_moderation_admin(): moderación admin o QA admin (bootstrap).
-- 2. RPC public.listar_moderadores_seguro(): listado sanitizado de moderadores autorizados.
-- 3. RPC public.agregar_moderador_por_email_seguro(email, role): resolución server-side estricta sin enumeración.
-- 4. RPC public.actualizar_rol_moderador_seguro(user_id, role): cambio de rol con guardia anti-bloqueo.
-- 5. RPC public.revocar_moderador_seguro(user_id): revocación lógica (active = false) con guardia anti-bloqueo.
-- 6. Actualización de public.get_moderation_queue_seguro(): proyección pública completa (modalidad, zona, hash) ordenada más antiguos primero.
-- 7. Actualización de public.resolver_moderacion_encuentro_seguro():
--    - Bloqueo FOR UPDATE
--    - Detección de concurrencia already_resolved
--    - TOCTOU hash en approve y reject
--    - Invariante de encuentros cancelados/cerrados (no revivir)
--    - Notificaciones deduplicadas al host vía inbox
--    - Auditoría durable con trazabilidad de hash
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. HELPER SERVER-SIDE: is_moderation_admin()
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_moderation_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid uuid := auth.uid();
BEGIN
    IF auth.role() = 'service_role' THEN
        RETURN true;
    END IF;

    IF v_uid IS NULL THEN
        RETURN false;
    END IF;

    -- 1. Moderation admin directo
    IF EXISTS (
        SELECT 1
        FROM public.moderation_authorized_users
        WHERE user_id = v_uid
          AND active = true
          AND role = 'admin'
    ) THEN
        RETURN true;
    END IF;

    -- 2. Fallback de administración: QA admin para bootstrap y gestión técnica desde /internal/qa
    IF EXISTS (
        SELECT 1
        FROM public.qa_authorized_users
        WHERE user_id = v_uid
          AND role = 'admin'
    ) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_moderation_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_moderation_admin() TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 2. RPC: listar_moderadores_seguro()
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.listar_moderadores_seguro()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_result JSON;
BEGIN
    IF NOT public.is_moderation_admin() THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT pg_catalog.json_agg(m_row) INTO v_result
    FROM (
        SELECT
            m.user_id,
            COALESCE(u.email, 'sin-email') AS email,
            m.role,
            m.active,
            m.created_at
        FROM public.moderation_authorized_users m
        LEFT JOIN auth.users u ON u.id = m.user_id
        ORDER BY m.created_at ASC
    ) m_row;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'moderators', COALESCE(v_result, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.listar_moderadores_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listar_moderadores_seguro() TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 3. RPC: agregar_moderador_por_email_seguro()
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.agregar_moderador_por_email_seguro(
    p_email TEXT,
    p_role TEXT DEFAULT 'moderator'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_clean_email TEXT;
    v_target_user_id UUID;
    v_is_anon BOOLEAN;
    v_role TEXT;
BEGIN
    IF NOT public.is_moderation_admin() THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    v_clean_email := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
    IF v_clean_email = '' OR v_clean_email NOT LIKE '%@%.%' THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'invalid_email',
            'message', 'Por favor ingresá un correo electrónico válido.'
        );
    END IF;

    v_role := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_role, 'moderator')));
    IF v_role NOT IN ('admin', 'moderator') THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'invalid_role',
            'message', 'El rol debe ser admin o moderator.'
        );
    END IF;

    -- Coincidencia exacta server-side en auth.users (sin enumeración)
    SELECT id, is_anonymous INTO v_target_user_id, v_is_anon
    FROM auth.users
    WHERE pg_catalog.lower(email) = v_clean_email
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'user_not_found',
            'message', 'No se encontró ninguna cuenta registrada con este correo exacto.'
        );
    END IF;

    IF v_is_anon IS TRUE THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'user_is_anonymous',
            'message', 'El correo corresponde a una cuenta temporal o no permanente.'
        );
    END IF;

    -- Upsert preservando trazabilidad y reactivando si ya existía
    INSERT INTO public.moderation_authorized_users (
        user_id,
        role,
        active,
        created_at,
        created_by
    ) VALUES (
        v_target_user_id,
        v_role,
        true,
        pg_catalog.clock_timestamp(),
        v_caller_id
    )
    ON CONFLICT (user_id) DO UPDATE
    SET role = EXCLUDED.role,
        active = true,
        created_by = COALESCE(EXCLUDED.created_by, public.moderation_authorized_users.created_by);

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'user_id', v_target_user_id,
        'email', v_clean_email,
        'role', v_role,
        'active', true
    );
END;
$$;

REVOKE ALL ON FUNCTION public.agregar_moderador_por_email_seguro(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agregar_moderador_por_email_seguro(TEXT, TEXT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 4. RPC: actualizar_rol_moderador_seguro()
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.actualizar_rol_moderador_seguro(
    p_user_id UUID,
    p_role TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_clean_role TEXT;
    v_current_rec public.moderation_authorized_users%ROWTYPE;
    v_other_mod_admins INT;
    v_qa_admins INT;
BEGIN
    IF NOT public.is_moderation_admin() THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    v_clean_role := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_role, '')));
    IF v_clean_role NOT IN ('admin', 'moderator') THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_role');
    END IF;

    SELECT * INTO v_current_rec
    FROM public.moderation_authorized_users
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'moderator_not_found');
    END IF;

    -- Si se intenta degradar a un admin activo a moderator, verificar que no quede el sistema sin admins capaces
    IF v_current_rec.role = 'admin' AND v_current_rec.active = true AND v_clean_role = 'moderator' THEN
        SELECT pg_catalog.count(*) INTO v_other_mod_admins
        FROM public.moderation_authorized_users
        WHERE role = 'admin' AND active = true AND user_id <> p_user_id;

        SELECT pg_catalog.count(*) INTO v_qa_admins
        FROM public.qa_authorized_users
        WHERE role = 'admin';

        IF (v_other_mod_admins + v_qa_admins) = 0 THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'cannot_remove_last_admin',
                'message', 'No podés quitar el rol de administrador porque no quedarían administradores disponibles para gestionar moderadores.'
            );
        END IF;
    END IF;

    UPDATE public.moderation_authorized_users
    SET role = v_clean_role
    WHERE user_id = p_user_id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'user_id', p_user_id,
        'role', v_clean_role
    );
END;
$$;

REVOKE ALL ON FUNCTION public.actualizar_rol_moderador_seguro(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.actualizar_rol_moderador_seguro(UUID, TEXT) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 5. RPC: revocar_moderador_seguro() (Revocación lógica conservando trazabilidad)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.revocar_moderador_seguro(p_user_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_current_rec public.moderation_authorized_users%ROWTYPE;
    v_other_mod_admins INT;
    v_qa_admins INT;
BEGIN
    IF NOT public.is_moderation_admin() THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT * INTO v_current_rec
    FROM public.moderation_authorized_users
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'moderator_not_found');
    END IF;

    -- Si el usuario a revocar es admin activo, asegurar que quede al menos un admin capaz de gestionar
    IF v_current_rec.role = 'admin' AND v_current_rec.active = true THEN
        SELECT pg_catalog.count(*) INTO v_other_mod_admins
        FROM public.moderation_authorized_users
        WHERE role = 'admin' AND active = true AND user_id <> p_user_id;

        SELECT pg_catalog.count(*) INTO v_qa_admins
        FROM public.qa_authorized_users
        WHERE role = 'admin';

        IF (v_other_mod_admins + v_qa_admins) = 0 THEN
            RETURN pg_catalog.json_build_object(
                'ok', false,
                'error', 'cannot_remove_last_admin',
                'message', 'No podés revocar al último administrador capaz de gestionar moderadores.'
            );
        END IF;
    END IF;

    -- Revocación lógica sin borrar fila (active = false)
    UPDATE public.moderation_authorized_users
    SET active = false
    WHERE user_id = p_user_id;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'user_id', p_user_id,
        'active', false
    );
END;
$$;

REVOKE ALL ON FUNCTION public.revocar_moderador_seguro(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revocar_moderador_seguro(UUID) TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 6. RPC: get_moderation_queue_seguro() (Cola sanitizada, más antiguos primero)
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
    IF auth.role() = 'service_role' THEN
        v_is_auth := true;
    ELSIF v_user_id IS NOT NULL AND public.is_moderation_authorized() THEN
        v_is_auth := true;
    END IF;

    IF NOT v_is_auth THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT pg_catalog.json_agg(q_row) INTO v_result
    FROM (
        SELECT
            e.id,
            COALESCE(e.open_public_title, '') AS titulo,
            e.open_public_title,
            e.open_description,
            e.modalidad,
            e.open_public_zone,
            e.fecha,
            e.hora,
            e.host_id,
            e.moderation_status,
            e.moderation_reason,
            e.moderation_categories,
            e.moderation_decision_source,
            e.moderated_at,
            e.creado_en AS created_at,
            e.opened_at,
            COALESCE(r_agg.report_count, 0) AS report_count,
            COALESCE(r_agg.reasons, ARRAY[]::TEXT[]) AS report_reasons,
            public.calcular_content_hash_moderacion(
                COALESCE(e.open_public_title, ''),
                e.open_description,
                e.modalidad,
                e.open_public_zone
            ) AS content_hash
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
        ORDER BY COALESCE(e.opened_at, e.creado_en) ASC
    ) q_row;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'queue', COALESCE(v_result, '[]'::json)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_moderation_queue_seguro() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_moderation_queue_seguro() TO authenticated, postgres, service_role;

-- ------------------------------------------------------------------------------
-- 7. RPC: resolver_moderacion_encuentro_seguro() (Concurrencia, TOCTOU, Inbox, Auditoría)
-- ------------------------------------------------------------------------------

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
    v_clean_action TEXT;
BEGIN
    -- 1. Verificación de rol administrativo o service_role
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

    -- 2. Bloqueo de fila para serializar decisiones concurrentes (FOR UPDATE)
    SELECT * INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
    END IF;

    v_clean_action := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_action, '')));
    v_clean_note := NULLIF(pg_catalog.btrim(p_note), '');

    -- INVARIANTE: Sólo puede resolver un registro que siga efectivamente en estado de revisión
    IF v_encuentro.moderation_status NOT IN ('review_pending', 'hidden_pending_review') THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'already_resolved',
            'message', 'Este caso ya fue resuelto por otro moderador o ya no está pendiente de revisión.',
            'current_status', v_encuentro.moderation_status
        );
    END IF;

    v_effective_title := NULLIF(pg_catalog.btrim(COALESCE(v_encuentro.open_public_title, '')), '');
    IF v_effective_title IS NULL THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'missing_open_public_title',
            'message', 'No se puede moderar una publicación sin open_public_title válido'
        );
    END IF;

    -- 3. TOCTOU & Versionado: calcular hash actual del contenido público
    v_current_hash := public.calcular_content_hash_moderacion(
        v_effective_title,
        v_encuentro.open_description,
        v_encuentro.modalidad,
        v_encuentro.open_public_zone
    );

    -- Si se especificó expected hash, validar atómicamente contra el contenido actual en BD
    IF p_expected_content_hash IS NOT NULL AND v_current_hash <> p_expected_content_hash THEN
        RETURN pg_catalog.json_build_object(
            'ok', false,
            'error', 'content_hash_mismatch',
            'message', 'El contenido fue modificado durante la evaluación de moderación'
        );
    END IF;

    -- 4. Transiciones de estado
    IF v_clean_action = 'approve' THEN
        -- Si el encuentro fue cancelado o cerrado mientras esperaba revisión, NO revivirlo
        IF v_encuentro.cancelled_at IS NOT NULL OR v_encuentro.closed_at IS NOT NULL THEN
            v_new_status := 'approved';
            v_is_open := false;
        ELSE
            v_new_status := 'approved';
            v_is_open := true;
        END IF;
    ELSIF v_clean_action = 'reject' THEN
        v_new_status := 'rejected';
        v_is_open := false;
    ELSIF v_clean_action = 'hide' THEN
        v_new_status := 'hidden_pending_review';
        v_is_open := false;
    ELSIF v_clean_action = 'remove' THEN
        v_new_status := 'removed';
        v_is_open := false;
    ELSE
        RETURN pg_catalog.json_build_object('ok', false, 'error', 'invalid_action');
    END IF;

    -- 5. Actualizar registro en base de datos
    UPDATE public.encuentros
    SET moderation_status = v_new_status,
        is_open = v_is_open,
        moderated_at = v_now,
        moderation_decision_source = v_source,
        moderation_reason = CASE WHEN v_clean_action = 'reject' THEN COALESCE(v_clean_note, moderation_reason) ELSE moderation_reason END,
        closed_at = CASE WHEN NOT v_is_open AND v_encuentro.is_open THEN v_now ELSE closed_at END,
        opened_at = CASE WHEN v_is_open AND opened_at IS NULL THEN v_now ELSE opened_at END
    WHERE id = p_encuentro_id;

    -- 6. Si se aprueba y se abre activamente, emitir outbox y alertas
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

    -- 7. Actualizar reportes pendientes asociados
    UPDATE public.public_content_reports
    SET status = CASE WHEN v_clean_action = 'approve' THEN 'dismissed' ELSE 'actioned' END,
        reviewed_at = v_now,
        reviewed_by = v_user_id,
        resolution_note = v_clean_note
    WHERE encuentro_id = p_encuentro_id AND status = 'pending';

    -- 8. Notificaciones al host (Inbox deduplicado)
    IF v_clean_action = 'approve' THEN
        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_encuentro.host_id,
            p_notification_type := 'moderation_approved',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/meet/' || p_encuentro_id,
            p_title := 'Tu encuentro fue aprobado',
            p_body := 'Ya puede aparecer públicamente en PuntoEncuentro.',
            p_payload := pg_catalog.jsonb_build_object('encounter_id', p_encuentro_id, 'action', 'approve'),
            p_dedup_key := pg_catalog.format('moderation_approved:%s:%s', p_encuentro_id, v_current_hash)
        );
    ELSIF v_clean_action = 'reject' THEN
        PERFORM public.insertar_inbox_notification_seguro(
            p_recipient_user_id := v_encuentro.host_id,
            p_notification_type := 'moderation_rejected',
            p_target_type := 'encounter',
            p_target_id := p_encuentro_id,
            p_deep_link := '/meet/' || p_encuentro_id,
            p_title := 'Tu publicación necesita cambios',
            p_body := COALESCE(v_clean_note, 'Tu publicación necesita ajustes en el contenido público para cumplir las normas comunitarias.'),
            p_payload := pg_catalog.jsonb_build_object('encounter_id', p_encuentro_id, 'action', 'reject', 'reason', v_clean_note),
            p_dedup_key := pg_catalog.format('moderation_rejected:%s:%s', p_encuentro_id, v_current_hash)
        );
    END IF;

    -- 9. Registrar auditoría persistente con hash de contenido en metadata
    INSERT INTO public.public_content_moderation_audit (
        encuentro_id, moderator_id, action, previous_status, new_status,
        reason, categories, source, metadata
    ) VALUES (
        p_encuentro_id, v_user_id, v_clean_action, v_encuentro.moderation_status, v_new_status,
        v_clean_note, ARRAY[]::TEXT[], v_source,
        pg_catalog.jsonb_build_object(
            'content_hash', v_current_hash,
            'moderator_role', CASE WHEN auth.role() = 'service_role' THEN 'service_role' ELSE COALESCE(v_mod_role, 'moderator') END
        )
    );

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'encuentro_id', p_encuentro_id,
        'action', v_clean_action,
        'moderation_status', v_new_status,
        'is_open', v_is_open
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT, TEXT) TO authenticated, postgres, service_role;

COMMIT;
