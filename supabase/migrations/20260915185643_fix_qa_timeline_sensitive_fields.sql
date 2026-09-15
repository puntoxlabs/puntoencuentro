-- Reemplazar row_to_json por jsonb_build_object en get_qa_session_timeline para evitar exposicion

CREATE OR REPLACE FUNCTION public.get_qa_session_timeline(
    p_session_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_session JSON;
    v_events JSON;
BEGIN
    -- 1. Validacion estricta de autorizacion
    IF NOT public.is_qa_authorized() THEN
        RAISE EXCEPTION 'unauthorized: insufficient permissions for QA timeline';
    END IF;

    IF p_session_id IS NULL THEN
        RAISE EXCEPTION 'invalid_parameter: p_session_id cannot be null';
    END IF;

    -- Obtener sesion segura mediante Whitelist explicita (sin client_token_hash ni user_id)
    SELECT pg_catalog.jsonb_build_object(
        'id', s.id,
        'creation_source', s.creation_source,
        'initial_route', s.initial_route,
        'status', s.status,
        'date_mode', s.date_mode,
        'encounter_id', s.encounter_id,
        'turns', s.turns,
        'elapsed_ms', s.elapsed_ms,
        'frontend_version', s.frontend_version,
        'edge_version', s.edge_version,
        'created_at', s.created_at,
        'completed_at', s.completed_at,
        'last_event_at', s.last_event_at
    ) INTO v_session
    FROM public.creation_sessions s
    WHERE s.id = p_session_id;

    IF v_session IS NULL THEN
        RAISE EXCEPTION 'session_not_found: %', p_session_id;
    END IF;

    -- Obtener eventos cronologicos con whitelist explicita
    SELECT pg_catalog.json_agg(row_data) INTO v_events
    FROM (
        SELECT
            e.id,
            e.turn_number,
            e.event_type,
            e.source,
            e.operation,
            e.result,
            e.provider,
            e.fallback_used,
            e.latency_ms,
            e.fields_changed,
            e.metadata,
            e.created_at
        FROM public.creation_session_events e
        WHERE e.session_id = p_session_id
        ORDER BY e.created_at ASC, e.id ASC
    ) row_data;

    RETURN pg_catalog.json_build_object(
        'ok', true,
        'session', v_session,
        'events', COALESCE(v_events, '[]'::json)
    );
END;
$$;

-- REVOKE EXECUTE para blindaje extra
REVOKE ALL ON FUNCTION public.get_qa_session_timeline(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_qa_session_timeline(UUID) TO authenticated, postgres, service_role;

