-- ==============================================================================
-- MIGRACIÓN ADITIVA: COMPATIBILIDAD DE CLAVES EN resolver_moderacion_encuentro_seguro
-- ==============================================================================
-- Asegura que la respuesta de resolver_moderacion_encuentro_seguro incluya
-- tanto 'new_status' como 'moderation_status' y 'previous_status' para compatibilidad
-- total con todos los clientes y scripts de auditoría/smoke.
-- ==============================================================================

BEGIN;

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
        'new_status', v_new_status,
        'moderation_status', v_new_status,
        'previous_status', v_encuentro.moderation_status,
        'is_open', v_is_open
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_moderacion_encuentro_seguro(UUID, TEXT, TEXT, TEXT) TO authenticated, postgres, service_role;

COMMIT;
