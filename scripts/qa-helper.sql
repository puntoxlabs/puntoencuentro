CREATE OR REPLACE FUNCTION public.qa_create_test_user(
    p_id uuid,
    p_is_anon boolean,
    p_email text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO auth.users (
        id,
        instance_id,
        aud,
        role,
        email,
        is_anonymous,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    ) VALUES (
        p_id,
        '00000000-0000-0000-0000-000000000000',
        'authenticated',
        'authenticated',
        p_email,
        p_is_anon,
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    )
    ON CONFLICT (id) DO UPDATE SET
        is_anonymous = p_is_anon,
        email = COALESCE(p_email, auth.users.email);
    RETURN p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.qa_set_user_anonymous(
    p_id uuid,
    p_is_anon boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE auth.users SET is_anonymous = p_is_anon WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.qa_delete_test_user(
    p_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM auth.users WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.qa_test_call_as(
    p_user_id uuid,
    p_is_anon boolean,
    p_fn_name text,
    p_args jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_claims jsonb;
    v_res jsonb;
BEGIN
    v_claims := jsonb_build_object(
        'sub', p_user_id::text,
        'role', 'authenticated',
        'is_anonymous', p_is_anon
    );
    PERFORM pg_catalog.set_config('request.jwt.claims', v_claims::text, true);
    PERFORM pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
    PERFORM pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

    IF p_fn_name = 'create_anonymous_transfer_ticket' THEN
        SELECT public.create_anonymous_transfer_ticket() INTO v_res;
        RETURN v_res;
    ELSIF p_fn_name = 'claim_anonymous_transfer' THEN
        SELECT public.claim_anonymous_transfer(p_args ->> 'p_transfer_token') INTO v_res;
        RETURN v_res;
    ELSIF p_fn_name = 'get_anonymous_upgrade_state' THEN
        SELECT public.get_anonymous_upgrade_state() INTO v_res;
        RETURN v_res;
    ELSIF p_fn_name = 'get_detalle_host_seguro' THEN
        SELECT public.get_detalle_host_seguro((p_args ->> 'p_encuentro_id')::uuid, (p_args ->> 'p_host_id')::uuid)::jsonb INTO v_res;
        RETURN v_res;
    ELSE
        RAISE EXCEPTION 'Unsupported test function %', p_fn_name;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.qa_create_test_user(uuid, boolean, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.qa_create_test_user(uuid, boolean, text) FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.qa_set_user_anonymous(uuid, boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.qa_set_user_anonymous(uuid, boolean) FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.qa_delete_test_user(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.qa_delete_test_user(uuid) FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.qa_test_call_as(uuid, boolean, text, jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.qa_test_call_as(uuid, boolean, text, jsonb) FROM anon, authenticated, public;
