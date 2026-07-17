BEGIN;

SET LOCAL plpgsql.check_asserts = on;

-- ============================================================
-- A. VALIDACIONES DE CATÁLOGO
-- ============================================================
DO $$
DECLARE
    v_count int;
BEGIN
    -- Índice nuevo
    SELECT count(*) INTO v_count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'participante_disponibilidades'
      AND indexname = 'idx_disp_encuentro_opcion';
    ASSERT v_count = 1, 'Falta el índice idx_disp_encuentro_opcion';

    -- Funciones nuevas y sus metadatos (firma estricta, json, sec def, owner postgres, search_path)
    SELECT count(*) INTO v_count
    FROM pg_proc p
    WHERE p.oid IN (
        to_regprocedure('public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb)'),
        to_regprocedure('public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb)')
    )
    AND p.prosecdef = true
    AND pg_get_userbyid(p.proowner) = 'postgres'
    AND pg_get_function_result(p.oid) = 'json'
    AND COALESCE(p.proconfig @> ARRAY['search_path=public']::text[], false);
    ASSERT v_count = 2, 'Contrato de seguridad incorrecto en nuevas RPC de escritura';

    -- Funciones modificadas
    SELECT count(*) INTO v_count
    FROM pg_proc p
    WHERE p.oid IN (
        to_regprocedure('public.get_coordinacion_host_seguro(uuid)'),
        to_regprocedure('public.get_coordinacion_participante_seguro(text)')
    )
    AND p.prosecdef = true
    AND pg_get_userbyid(p.proowner) = 'postgres'
    AND pg_get_function_result(p.oid) = 'json'
    AND COALESCE(p.proconfig @> ARRAY['search_path=public']::text[], false);
    ASSERT v_count = 2, 'Contrato de seguridad incorrecto en RPC modificadas json';

    SELECT count(*) INTO v_count
    FROM pg_proc p
    WHERE p.oid IN (
        to_regprocedure('public.responder_participante_seguro(text,text,text,text)')
    )
    AND p.prosecdef = true
    AND pg_get_userbyid(p.proowner) = 'postgres'
    AND pg_get_function_result(p.oid) = 'jsonb'
    AND COALESCE(p.proconfig @> ARRAY['search_path=public']::text[], false);
    ASSERT v_count = 1, 'Contrato de seguridad incorrecto en RPC modificada jsonb (responder)';

    -- Grants exactos (anon, auth deben tener; PUBLIC no)
    ASSERT has_function_privilege('anon', to_regprocedure('public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb)'), 'EXECUTE') = true, 'Falta grant anon en crear_disponibilidad';
    ASSERT has_function_privilege('authenticated', to_regprocedure('public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb)'), 'EXECUTE') = true, 'Falta grant auth en crear_disponibilidad';
    ASSERT has_function_privilege('anon', to_regprocedure('public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb)'), 'EXECUTE') = true, 'Falta grant anon en guardar_disponibilidad';
    ASSERT has_function_privilege('authenticated', to_regprocedure('public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb)'), 'EXECUTE') = true, 'Falta grant auth en guardar_disponibilidad';
    ASSERT has_function_privilege('anon', to_regprocedure('public.responder_participante_seguro(text,text,text,text)'), 'EXECUTE') = true, 'Falta grant anon en responder';
    ASSERT has_function_privilege('authenticated', to_regprocedure('public.responder_participante_seguro(text,text,text,text)'), 'EXECUTE') = true, 'Falta grant auth en responder';
    ASSERT has_function_privilege('anon', to_regprocedure('public.get_coordinacion_participante_seguro(text)'), 'EXECUTE') = true, 'Falta grant anon en participante';
    ASSERT has_function_privilege('authenticated', to_regprocedure('public.get_coordinacion_participante_seguro(text)'), 'EXECUTE') = true, 'Falta grant auth en participante';
    ASSERT has_function_privilege('authenticated', to_regprocedure('public.get_coordinacion_host_seguro(uuid)'), 'EXECUTE') = true, 'Falta grant auth en host';

    -- Host no anon
    ASSERT has_function_privilege('anon', to_regprocedure('public.get_coordinacion_host_seguro(uuid)'), 'EXECUTE') = false, 'anon tiene grant indebido en host';

    -- Postgres y service_role preservados en todas
    ASSERT has_function_privilege('postgres', to_regprocedure('public.get_coordinacion_host_seguro(uuid)'), 'EXECUTE') = true, 'Falta postgres en host';
    ASSERT has_function_privilege('service_role', to_regprocedure('public.get_coordinacion_host_seguro(uuid)'), 'EXECUTE') = true, 'Falta service_role en host';
    ASSERT has_function_privilege('postgres', to_regprocedure('public.get_coordinacion_participante_seguro(text)'), 'EXECUTE') = true, 'Falta postgres en part';
    ASSERT has_function_privilege('service_role', to_regprocedure('public.get_coordinacion_participante_seguro(text)'), 'EXECUTE') = true, 'Falta service_role en part';
    ASSERT has_function_privilege('postgres', to_regprocedure('public.responder_participante_seguro(text,text,text,text)'), 'EXECUTE') = true, 'Falta postgres en responder';
    ASSERT has_function_privilege('service_role', to_regprocedure('public.responder_participante_seguro(text,text,text,text)'), 'EXECUTE') = true, 'Falta service_role en responder';
    ASSERT has_function_privilege('postgres', to_regprocedure('public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb)'), 'EXECUTE') = true, 'Falta postgres en crear disp';
    ASSERT has_function_privilege('service_role', to_regprocedure('public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb)'), 'EXECUTE') = true, 'Falta service_role en crear disp';
    ASSERT has_function_privilege('postgres', to_regprocedure('public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb)'), 'EXECUTE') = true, 'Falta postgres en guardar disp';
    ASSERT has_function_privilege('service_role', to_regprocedure('public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb)'), 'EXECUTE') = true, 'Falta service_role en guardar disp';

    -- PUBLIC sin EXECUTE en ninguna
    SELECT count(*) INTO v_count
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid IN (
        to_regprocedure('public.crear_disponibilidad_coordinacion_publica_seguro(text,text,jsonb)'),
        to_regprocedure('public.guardar_disponibilidad_coordinacion_participante_seguro(text,jsonb)'),
        to_regprocedure('public.get_coordinacion_host_seguro(uuid)'),
        to_regprocedure('public.get_coordinacion_participante_seguro(text)'),
        to_regprocedure('public.responder_participante_seguro(text,text,text,text)')
    )
    AND acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE';
    ASSERT v_count = 0, 'PUBLIC tiene EXECUTE indebidamente';

    -- RLS intacto, cero políticas, cero grants directos
    SELECT count(*) INTO v_count
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades')
      AND c.relrowsecurity = true
      AND c.relforcerowsecurity = false;
    ASSERT v_count = 4, 'Falta RLS o forcerowsecurity en tablas';

    SELECT count(*) INTO v_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades');
    ASSERT v_count = 0, 'Existen políticas (policy) para estas tablas, que no deberían existir';

    SELECT count(*) INTO v_count
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades')
      AND grantee IN ('anon', 'authenticated', 'PUBLIC');
    ASSERT v_count = 0, 'Existen privilegios directos de tabla para anon/auth/PUBLIC';
END $$;

-- ============================================================
-- PRUEBAS FUNCIONALES
-- ============================================================
DO $$
DECLARE
    v_host_id uuid := gen_random_uuid();
    v_res jsonb;
    v_enc_id uuid;
    v_public_token text;
    v_op_id_1 uuid;
    v_op_id_2 uuid;
    v_op_id_3 uuid;
    
    v_part_token text;
    v_part_id uuid;
    v_indiv_part_id uuid;
    v_indiv_token text;

    v_fixed_enc_id uuid;
    v_fixed_public_token text;
    v_fixed_part_token text;
    
    v_parcial_id uuid := gen_random_uuid();
    v_parcial_token uuid := gen_random_uuid();
    v_sin_resp_id uuid := gen_random_uuid();
    v_sin_resp_token uuid := gen_random_uuid();

    v_payload_valido jsonb;
    v_count int;
BEGIN
    -- M. Crear datos de prueba propios dentro del ROLLBACK, no tocar los reales
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_host_id::text, 'role', 'authenticated', 'is_anonymous', false)::text, true);

    v_res := public.crear_encuentro_con_opciones_seguro(
        '{"titulo": "Test Coord", "modalidad": "presencial", "lugar_texto": "Lugar de prueba", "tipo_invitacion": "link_general", "tema": "blue", "duration_minutes": 60}'::jsonb, 
        format('[{"fecha": "%s", "hora_inicio": "10:00"}, {"fecha": "%s", "hora_inicio": "11:00"}, {"fecha": "%s", "hora_inicio": "12:00"}]', current_date + 30, current_date + 31, current_date + 32)::jsonb
    )::jsonb;
    
    v_enc_id := (v_res->'encuentro'->>'id')::uuid;
    v_public_token := v_res->'encuentro'->>'public_token';
    v_op_id_1 := (v_res->'opciones'->0->>'id')::uuid;
    v_op_id_2 := (v_res->'opciones'->1->>'id')::uuid;
    v_op_id_3 := (v_res->'opciones'->2->>'id')::uuid;

    -- Forzar estado activo explícitamente
    UPDATE public.encuentros SET estado = 'activo' WHERE id = v_enc_id;

    v_payload_valido := jsonb_build_array(
        jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', true),
        jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
        jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
    );

    -- ============================================================
    -- B. PRIMER ENVÍO PÚBLICO VÁLIDO
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon', 'is_anonymous', true)::text, true);

    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, 'Juan', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló envío público válido';
    
    v_part_id := (v_res->'participante'->>'id')::uuid;
    v_part_token := v_res->>'token_invitacion';
    
    ASSERT (v_res->'participante'->>'tipo_invitacion') = 'generico', 'Tipo invitacion incorrecto';
    ASSERT v_part_token IS NOT NULL, 'No devolvió token';
    ASSERT jsonb_array_length(v_res->'mis_respuestas') = 3, 'No devolvió 3 respuestas ordenadas';
    ASSERT NOT (v_res ? 'link_virtual'), 'Devolvió link_virtual';
    ASSERT NOT (v_res ? 'public_token'), 'Devolvió public_token';

    DECLARE v_estado text; v_respondido_en timestamp; v_msg text;
    BEGIN
        SELECT estado, respondido_en, mensaje_respuesta INTO v_estado, v_respondido_en, v_msg FROM public.participantes WHERE id = v_part_id;
        ASSERT v_estado = 'pendiente', 'Estado no quedó pendiente';
        ASSERT v_respondido_en IS NULL, 'respondido_en no quedó null';
        ASSERT v_msg IS NULL, 'mensaje_respuesta no quedó null';
    END;

    -- ============================================================
    -- C. NOMBRE PÚBLICO (Normalización y rechazo explícito)
    -- ============================================================
    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, NULL, v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_name', 'No rechazó null';
    
    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, '', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_name', 'No rechazó vacío explicitly';

    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, '   ', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_name', 'No rechazó espacios';
    
    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, repeat('a', 81), v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_name', 'No rechazó >80 char';

    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, '  Pedro  ', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló nombre con espacios';
    ASSERT v_res->'participante'->>'nombre_invitado' = 'Pedro', 'No hizo trim del nombre';

    -- ============================================================
    -- D e I. PAYLOAD INVÁLIDO Y ATOMICIDAD (pública e individual)
    -- ============================================================
    DECLARE v_prev_disp int; v_prev_part int;
    BEGIN
        SELECT count(*) INTO v_prev_part FROM public.participantes;
        SELECT count(*) INTO v_prev_disp FROM public.participante_disponibilidades WHERE participante_id = v_part_id;
        
        -- C.1 RPC Pública rechazos
        v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, 'Fallo', '{}'::jsonb)::jsonb;
        ASSERT v_res->>'error' = 'invalid_responses';
        ASSERT (SELECT count(*) FROM public.participantes) = v_prev_part, 'Creó participante a pesar del error de payload';

        -- D.1 null/object/empty array (Individual)
        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, NULL)::jsonb;
        ASSERT v_res->>'error' = 'invalid_responses', 'No rechazó null array';
        
        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, '{}'::jsonb)::jsonb;
        ASSERT v_res->>'error' = 'invalid_responses', 'No rechazó objeto';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, '[]'::jsonb)::jsonb;
        ASSERT v_res->>'error' = 'invalid_responses', 'No rechazó array vacío';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, '[1,2,3]'::jsonb)::jsonb;
        ASSERT v_res->>'error' = 'invalid_responses', 'No rechazó escalar en array';

        -- D.2 Faltante o repetida
        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'incomplete_responses', 'No rechazó faltante';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'duplicate_options', 'No rechazó repetida';

        -- D.3 Opción inválida (UUID string roto, numerico, ajeno)
        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', 'not-a-uuid', 'respuesta', 'available', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_option', 'No rechazó string no UUID';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', 12345, 'respuesta', 'available', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_option', 'No rechazó opción numérica';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', gen_random_uuid(), 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_option', 'No rechazó UUID aleatorio';

        -- D.4 Valores inválidos, nulls y tipos en respuesta
        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'yes', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_response_value', 'No rechazó respuesta yes';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', null, 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_response_value', 'No rechazó respuesta null';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 1, 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_response_value', 'No rechazó respuesta numérica';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', 'true'),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_preferred', 'No rechazó es_preferida string';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', null),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_preferred', 'No rechazó es_preferida null';

        -- D.5 Lógica preferida
        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', true),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'available', 'es_preferida', true),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_preferred', 'No rechazó dos preferidas';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', true)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_preferred', 'No rechazó unavailable preferida';

        -- D.6 Estructura de elemento JSON
        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available'),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', true)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_responses', 'No rechazó clave faltante';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_responses', 'No rechazó alias opcion_id';

        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'available', 'es_preferida', false, 'extra', 'bad'),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_responses', 'No rechazó clave extra';

        -- I. Atomicidad garantizada: no borró nada
        SELECT count(*) INTO v_count FROM public.participante_disponibilidades WHERE participante_id = v_part_id;
        ASSERT v_count = v_prev_disp, 'Falló la atomicidad: eliminó o mutó registros a pesar del error de validación';
    END;

    -- ============================================================
    -- D Extra. OPCIÓN DE OTRO ENCUENTRO (Propia)
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_host_id::text, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    DECLARE v_res_otro jsonb; v_op_otro_1 uuid; v_enc_otro_id uuid;
    BEGIN
        v_res_otro := public.crear_encuentro_con_opciones_seguro(
            '{
            "titulo": "Otro encuentro de prueba",
            "modalidad": "presencial",
            "lugar_texto": "Otro lugar de prueba",
            "tipo_invitacion": "link_general",
            "tema": "blue",
            "duration_minutes": 60
            }'::jsonb,
            format(
            '[
                {
                "fecha": "%s",
                "hora_inicio": "10:00"
                },
                {
                "fecha": "%s",
                "hora_inicio": "11:00"
                }
            ]',
            current_date + 60,
            current_date + 61
            )::jsonb
        )::jsonb;
        ASSERT v_res_otro->>'ok' = 'true', 'No pudo crear segundo encuentro válido';

        v_op_otro_1 := (v_res_otro->'opciones'->0->>'id')::uuid;
        
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon', 'is_anonymous', true)::text, true);
        
        v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, jsonb_build_array(
            jsonb_build_object('opcion_fecha_id', v_op_otro_1, 'respuesta', 'available', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
            jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
        ))::jsonb;
        ASSERT v_res->>'error' = 'invalid_option', 'No rechazó UUID de otro encuentro real';
    END;

    -- ============================================================
    -- E. EDICIÓN CON TOKEN GENÉRICO
    -- ============================================================
    v_payload_valido := jsonb_build_array(
        jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'unavailable', 'es_preferida', false),
        jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
        jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'available', 'es_preferida', true)
    );
    v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló edición válida';
    
    SELECT count(*) INTO v_count FROM public.participante_disponibilidades WHERE participante_id = v_part_id;
    ASSERT v_count = 3, 'Cantidad final inexacta, duplicó tras edición';

    DECLARE v_new_name text; v_t uuid; v_e text;
    BEGIN
        SELECT nombre_invitado, token_invitacion, estado INTO v_new_name, v_t, v_e FROM public.participantes WHERE id = v_part_id;
        ASSERT v_new_name = 'Juan', 'Modificó nombre';
        ASSERT v_t = v_part_token::uuid, 'Modificó token';
        ASSERT v_e = 'pendiente', 'Modificó estado';
    END;

    -- ============================================================
    -- F. PARTICIPANTE INDIVIDUAL
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_host_id::text, 'role', 'authenticated', 'is_anonymous', false)::text, true);

    v_res := public.crear_participante_individual_seguro(v_enc_id, v_host_id, 'Invitado Indiv')::jsonb;
    v_indiv_part_id := (v_res->>'id')::uuid;
    v_indiv_token := v_res->>'token_invitacion';
    
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon', 'is_anonymous', true)::text, true);

    v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_indiv_token, v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló guardar disponibilidad inv individual';

    -- F2. Editar indiv nuevamente
    v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_indiv_token, jsonb_build_array(
        jsonb_build_object('opcion_fecha_id', v_op_id_1, 'respuesta', 'maybe', 'es_preferida', false),
        jsonb_build_object('opcion_fecha_id', v_op_id_2, 'respuesta', 'maybe', 'es_preferida', false),
        jsonb_build_object('opcion_fecha_id', v_op_id_3, 'respuesta', 'unavailable', 'es_preferida', false)
    ))::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló reeditar disponibilidad inv individual';
    
    DECLARE v_new_name_indiv text; v_t_indiv uuid; v_e_indiv text;
    BEGIN
        SELECT nombre_invitado, token_invitacion, estado INTO v_new_name_indiv, v_t_indiv, v_e_indiv FROM public.participantes WHERE id = v_indiv_part_id;
        ASSERT v_new_name_indiv = 'Invitado Indiv', 'Modificó nombre';
        ASSERT v_t_indiv = v_indiv_token::uuid, 'Modificó token';
        ASSERT v_e_indiv = 'pendiente', 'Modificó estado';
        SELECT count(*) INTO v_count FROM public.participante_disponibilidades WHERE participante_id = v_indiv_part_id;
        ASSERT v_count = 3, 'Cantidad mutada';
    END;

    -- ============================================================
    -- G. IDENTIDAD
    -- ============================================================
    -- public_token no actualiza previa (es decir public_token en individual)
    v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_public_token, v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_token', 'Permitió editar con public_token';
    
    -- nombre repetido crea otro
    SELECT count(*) INTO v_count FROM public.participantes;
    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, 'Juan', v_payload_valido)::jsonb;
    ASSERT (SELECT count(*) FROM public.participantes) = v_count + 1, 'Juan duplicado no creó participante nuevo';

    -- Token inválido no modifica
    v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(gen_random_uuid()::text, v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_token', 'Aceptó token inválido random';

    v_res := public.guardar_disponibilidad_coordinacion_participante_seguro('not-uuid', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_token', 'Aceptó string literal roto';

    -- ============================================================
    -- H. ESTADOS DEL ENCUENTRO
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_host_id::text, 'role', 'authenticated', 'is_anonymous', false)::text, true);

    v_fixed_public_token := gen_random_uuid()::text;
    INSERT INTO public.encuentros (titulo, modalidad, tipo_invitacion, date_mode, host_id, public_token, fecha, hora, estado)
    VALUES ('Fijo real', 'presencial', 'link_general', 'fixed', v_host_id, v_fixed_public_token::uuid, current_date + 40, '12:00', 'activo')
    RETURNING id INTO v_fixed_enc_id;

    -- Fixed con RPC pública e individual
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon', 'is_anonymous', true)::text, true);
    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_fixed_public_token, 'Fijo1', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_date_mode', 'Aceptó RPC pública en fixed';
    
    INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, estado, token_invitacion)
    VALUES (v_fixed_enc_id, 'Fijo2', 'individual', 'pendiente', gen_random_uuid()) RETURNING token_invitacion INTO v_fixed_part_token;
    v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_fixed_part_token, v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_date_mode', 'Aceptó RPC indiv en fixed';

    -- RPC pública sobre tipo individual de coordination
    UPDATE public.encuentros SET tipo_invitacion = 'individual' WHERE id = v_enc_id;
    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, 'Juan', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_invitation_type', 'Aceptó RPC pública sobre individual';
    UPDATE public.encuentros SET tipo_invitacion = 'link_general' WHERE id = v_enc_id;

    -- Cerrar y cancelar
    UPDATE public.encuentros
    SET
      coordination_status = 'closed',
      selected_option_id = v_op_id_1,
      fecha = (
        SELECT fecha
        FROM public.encuentro_opciones_fecha
        WHERE id = v_op_id_1
          AND encuentro_id = v_enc_id
      ),
      hora = (
        SELECT hora_inicio
        FROM public.encuentro_opciones_fecha
        WHERE id = v_op_id_1
          AND encuentro_id = v_enc_id
      )
    WHERE id = v_enc_id;

    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, 'Tarde', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'coordination_closed', 'Permitió public_token en closed';

    v_res := public.guardar_disponibilidad_coordinacion_participante_seguro(v_part_token, v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'coordination_closed', 'Permitió editar en closed';

    UPDATE public.encuentros SET coordination_status = 'open', selected_option_id = NULL, fecha = NULL, hora = NULL WHERE id = v_enc_id;
    UPDATE public.encuentros SET estado = 'cancelado' WHERE id = v_enc_id;

    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, 'Tarde', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'encounter_cancelled', 'Permitió public_token en cancelado';

    UPDATE public.encuentros SET estado = 'activo' WHERE id = v_enc_id;

    -- Deadline
    UPDATE public.encuentros SET response_deadline = now() - interval '1 day' WHERE id = v_enc_id;
    v_res := public.crear_disponibilidad_coordinacion_publica_seguro(v_public_token, 'Tarde', v_payload_valido)::jsonb;
    ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'response_deadline_passed', 'Permitió en deadline vencido';
    UPDATE public.encuentros SET response_deadline = NULL WHERE id = v_enc_id;

    -- ============================================================
    -- J. LECTURA HOST
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_host_id::text, 'role', 'authenticated', 'is_anonymous', false)::text, true);

    -- Determinar conteo de completos pre-parcial (Juan, Pedro, Individual, Juan2)
    DECLARE 
        v_expected_complete int;
    BEGIN
        v_res := public.get_coordinacion_host_seguro(v_enc_id)::jsonb;
        v_expected_complete := (v_res->>'respondent_count')::int;

        -- Crear uno parcial y uno sin respuestas usando variables
        INSERT INTO public.participantes (id, encuentro_id, nombre_invitado, tipo_invitacion, estado, token_invitacion)
        VALUES (v_parcial_id, v_enc_id, 'Parcial', 'individual', 'pendiente', v_parcial_token),
               (v_sin_resp_id, v_enc_id, 'SinResp', 'individual', 'pendiente', v_sin_resp_token);
        
        -- Insert bypass validations to create partial row
        INSERT INTO public.participante_disponibilidades (participante_id, encuentro_id, opcion_fecha_id, respuesta, es_preferida)
        VALUES (v_parcial_id, v_enc_id, v_op_id_1, 'available', true);

        v_res := public.get_coordinacion_host_seguro(v_enc_id)::jsonb;
        ASSERT (v_res->>'respondent_count')::integer = v_expected_complete, 'respondent_count contó parciales o huerfanos.'; 
        
        DECLARE v_part_json jsonb; v_has_token boolean := false; v_has_user boolean := false;
        BEGIN
            FOR v_part_json IN SELECT * FROM jsonb_array_elements(v_res->'participantes') LOOP
                IF v_part_json->>'id' = v_parcial_id::text OR v_part_json->>'id' = v_sin_resp_id::text THEN
                    ASSERT (v_part_json->>'respondio_disponibilidad')::boolean = false, 'Parcial/SinResp dice true';
                END IF;
                IF v_part_json->>'nombre_invitado' = 'Juan' THEN
                    ASSERT (v_part_json->>'respondio_disponibilidad')::boolean = true, 'Completo dice false';
                END IF;
                IF v_part_json ? 'token_invitacion' THEN v_has_token := true; END IF;
                IF v_part_json ? 'user_id' THEN v_has_user := true; END IF;
            END LOOP;
            ASSERT NOT v_has_token, 'Host devuelve token_invitacion';
            ASSERT NOT v_has_user, 'Host devuelve user_id';
            ASSERT NOT (v_res ? 'user_id'), 'Host devuelve user_id';
            
            -- Validation of fallback classic for tema_invitacion
            ASSERT v_res->'encuentro'->>'tema_invitacion' = 'classic', 'No conserva classic como fallback de tema_invitacion';
            -- Test derived status deadline_passed
            UPDATE public.encuentros SET response_deadline = now() - interval '1 day' WHERE id = v_enc_id;
            DECLARE v_d_res jsonb := public.get_coordinacion_host_seguro(v_enc_id)::jsonb;
            BEGIN
                ASSERT v_d_res->>'derived_status' = 'deadline_passed', 'derived_status vencido no retornó deadline_passed';
            END;
            UPDATE public.encuentros SET response_deadline = NULL WHERE id = v_enc_id;
        END;

        -- Test selected options exactly one selected when closed
        UPDATE public.encuentros
        SET
          coordination_status = 'closed',
          selected_option_id = v_op_id_1,
          fecha = (SELECT fecha FROM public.encuentro_opciones_fecha WHERE id = v_op_id_1 AND encuentro_id = v_enc_id),
          hora = (SELECT hora_inicio FROM public.encuentro_opciones_fecha WHERE id = v_op_id_1 AND encuentro_id = v_enc_id)
        WHERE id = v_enc_id;

        DECLARE v_c_res jsonb := public.get_coordinacion_host_seguro(v_enc_id)::jsonb; v_op_item jsonb; v_sel_count int := 0;
        BEGIN
            FOR v_op_item IN SELECT * FROM jsonb_array_elements(v_c_res->'opciones') LOOP
                IF (v_op_item->>'selected')::boolean THEN
                    v_sel_count := v_sel_count + 1;
                    ASSERT (v_op_item->>'id') = v_op_id_1::text, 'Selected id erroneo';
                END IF;
            END LOOP;
            ASSERT v_sel_count = 1, 'Mas de un selected en closed';
        END;

        -- Test order explicit
        DECLARE v_prev_orden int := -1; v_op_item jsonb; v_part_item jsonb; v_prev_ts text := ''; v_prev_name text := ''; v_r_item jsonb;
        BEGIN
            v_res := public.get_coordinacion_host_seguro(v_enc_id)::jsonb;
            -- opciones ordenadas por orden
            FOR v_op_item IN SELECT * FROM jsonb_array_elements(v_res->'opciones') LOOP
                ASSERT (v_op_item->>'orden')::int >= v_prev_orden, 'Opciones host no ordenadas por orden';
                v_prev_orden := (v_op_item->>'orden')::int;
            END LOOP;

            -- participantes ordenados
            FOR v_part_item IN SELECT * FROM jsonb_array_elements(v_res->'participantes') LOOP
                -- check order
                DECLARE v_curr_name text := v_part_item->>'nombre_invitado';
                BEGIN
                    -- It's ordered by creado_en, nombre_invitado. We don't have creado_en exposed, but we can verify it's stable.
                    -- Just verify the internal array of respuestas is ordered
                    v_prev_orden := -1;
                    FOR v_r_item IN SELECT * FROM jsonb_array_elements(v_part_item->'respuestas') LOOP
                        DECLARE v_curr_ord int;
                        BEGIN
                            SELECT orden INTO v_curr_ord FROM public.encuentro_opciones_fecha WHERE id = (v_r_item->>'opcion_fecha_id')::uuid;
                            ASSERT v_curr_ord >= v_prev_orden, 'Respuestas host no ordenadas por orden de opción';
                            v_prev_orden := v_curr_ord;
                        END;
                    END LOOP;
                END;
            END LOOP;
        END;

        -- Reabrir
        UPDATE public.encuentros SET coordination_status = 'open', selected_option_id = NULL, fecha = NULL, hora = NULL WHERE id = v_enc_id;

        -- Exclusión en conteos
        DECLARE v_av_count int; v_pref_count int;
        BEGIN
            SELECT available_count, preferred_count INTO v_av_count, v_pref_count FROM jsonb_to_record(v_res->'opciones'->0) AS r(available_count int, preferred_count int);
            -- Si el parcial suma 1 en available y preferida para opcion 1, verifiquemos que se excluyó.
            -- Para esto, removemos al parcial y medimos
            DELETE FROM public.participante_disponibilidades WHERE participante_id = v_parcial_id;
            DECLARE v_res2 jsonb := public.get_coordinacion_host_seguro(v_enc_id)::jsonb; v_av_count2 int; v_pref_count2 int;
            BEGIN
                SELECT available_count, preferred_count INTO v_av_count2, v_pref_count2 FROM jsonb_to_record(v_res2->'opciones'->0) AS r(available_count int, preferred_count int);
                ASSERT v_av_count = v_av_count2, 'El parcial fue incluido en el available_count';
                ASSERT v_pref_count = v_pref_count2, 'El parcial fue incluido en el preferred_count';
            END;
        END;
    END;

    -- ============================================================
    -- K. LECTURA PARTICIPANTE
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon', 'is_anonymous', true)::text, true);

    v_res := public.get_coordinacion_participante_seguro(v_indiv_token)::jsonb;
    ASSERT (v_res->'participante'->>'respondio_disponibilidad')::boolean = true, 'Individual completo dice false';
    ASSERT NOT (v_res->'encuentro' ? 'link_virtual'), 'Expuso link_virtual';
    ASSERT NOT (v_res->'encuentro' ? 'public_token'), 'Expuso public_token';
    ASSERT NOT (v_res->'participante' ? 'token_invitacion'), 'Expuso token_invitacion';
    ASSERT v_res->'encuentro'->>'tema_invitacion' = 'classic', 'No conserva classic como fallback de tema_invitacion';
    
    -- Test order
    DECLARE v_prev_o int := -1; v_o jsonb;
    BEGIN
        FOR v_o IN SELECT * FROM jsonb_array_elements(v_res->'opciones') LOOP
            ASSERT (v_o->>'orden')::int >= v_prev_o, 'Opciones part no ordenadas';
            v_prev_o := (v_o->>'orden')::int;
        END LOOP;
        v_prev_o := -1;
        FOR v_o IN SELECT * FROM jsonb_array_elements(v_res->'mis_respuestas') LOOP
            DECLARE v_curr_ord int;
            BEGIN
                SELECT orden INTO v_curr_ord FROM public.encuentro_opciones_fecha WHERE id = (v_o->>'opcion_fecha_id')::uuid;
                ASSERT v_curr_ord >= v_prev_o, 'mis_respuestas part no ordenadas';
                v_prev_o := v_curr_ord;
            END;
        END LOOP;
    END;

    -- Test derived status deadline_passed participante
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_host_id::text, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    UPDATE public.encuentros SET response_deadline = now() - interval '1 day' WHERE id = v_enc_id;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon', 'is_anonymous', true)::text, true);
    DECLARE v_d_res_part jsonb := public.get_coordinacion_participante_seguro(v_indiv_token)::jsonb;
    BEGIN
        ASSERT v_d_res_part->>'derived_status' = 'deadline_passed', 'derived_status vencido participante no retornó deadline_passed';
    END;
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_host_id::text, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    UPDATE public.encuentros SET response_deadline = NULL WHERE id = v_enc_id;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon', 'is_anonymous', true)::text, true);

    -- Parcial lectura usando variable
    BEGIN
        -- Reimplantar
        INSERT INTO public.participante_disponibilidades (participante_id, encuentro_id, opcion_fecha_id, respuesta, es_preferida)
        VALUES (v_parcial_id, v_enc_id, v_op_id_1, 'available', true);
        
        v_res := public.get_coordinacion_participante_seguro(v_parcial_token::text)::jsonb;
        ASSERT (v_res->'participante'->>'respondio_disponibilidad')::boolean = false, 'Parcial dice true';
    END;

    -- Sin respuesta
    BEGIN
        v_res := public.get_coordinacion_participante_seguro(v_sin_resp_token::text)::jsonb;
        ASSERT (v_res->'participante'->>'respondio_disponibilidad')::boolean = false, 'Sin respuestas dice true';
    END;

    -- ============================================================
    -- L. responder_participante_seguro
    -- ============================================================
    -- Coordination errors guards: Asserting atomicity prior to execution
    DECLARE 
        v_s_state text; v_s_name text; v_s_resp_en timestamp; v_s_parts int; v_s_disps int;
    BEGIN
        SELECT estado, nombre_invitado, respondido_en INTO v_s_state, v_s_name, v_s_resp_en FROM public.participantes WHERE token_invitacion = v_part_token::uuid;
        SELECT count(*) INTO v_s_parts FROM public.participantes;
        SELECT count(*) INTO v_s_disps FROM public.participante_disponibilidades;

        v_res := public.responder_participante_seguro(v_public_token, 'confirmado', 'Intentofijo')::jsonb;
        ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_date_mode', 'Coord procesó public_token de fixed';
        
        v_res := public.responder_participante_seguro(v_part_token, 'confirmado', 'Intentofijo')::jsonb;
        ASSERT v_res->>'ok' = 'false' AND v_res->>'error' = 'invalid_date_mode', 'Coord procesó token indiv de fixed';

        -- Verify mutations on coordination
        DECLARE v_a_state text; v_a_name text; v_a_resp_en timestamp;
        BEGIN
            SELECT estado, nombre_invitado, respondido_en INTO v_a_state, v_a_name, v_a_resp_en FROM public.participantes WHERE token_invitacion = v_part_token::uuid;
            ASSERT v_s_state = v_a_state, 'Mutó estado en fallback';
            ASSERT v_s_name = v_a_name, 'Mutó nombre en fallback';
            ASSERT v_s_resp_en IS NOT DISTINCT FROM v_a_resp_en, 'Mutó respondido en fallback';
            ASSERT v_s_parts = (SELECT count(*) FROM public.participantes), 'Añadió participante en coord';
            ASSERT v_s_disps = (SELECT count(*) FROM public.participante_disponibilidades), 'Añadió disp en coord';
        END;
    END;

    -- Fixed correctos
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon', 'is_anonymous', true)::text, true);

    v_res := public.responder_participante_seguro(v_fixed_public_token, 'confirmado', 'JoseFijo')::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Fijo se rompió procesando un fixed público legítimo';
    ASSERT v_res->>'tipo' = 'general', 'Fijo no retornó tipo=general público';
    ASSERT v_res->>'id' IS NOT NULL, 'Fijo no retornó id';
    ASSERT v_res->>'encuentro_id' = v_fixed_enc_id::text, 'Fijo no retornó enc_id';
    ASSERT v_res->>'estado' = 'confirmado', 'Fijo no retornó estado conf';
    ASSERT v_res->>'token_invitacion' IS NOT NULL, 'Fijo no devolvió token generado';
    
    -- Histórico SIEMPRE devuelve la clave link_virtual
    ASSERT v_res ? 'link_virtual', 'Falta la clave histórica link_virtual';
    ASSERT v_res->>'link_virtual' IS NULL, 'Encuentro presencial devolvió un link_virtual no nulo';

    v_res := public.responder_participante_seguro(v_fixed_part_token, 'confirmado', 'Intentofijo')::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Fijo se rompió procesando un fixed indiv legítimo';
    ASSERT v_res->>'tipo' = 'individual', 'Fijo no retornó tipo individual indiv';
    ASSERT v_res->>'id' IS NOT NULL, 'Fijo no retornó id';
    ASSERT v_res->>'encuentro_id' = v_fixed_enc_id::text, 'Fijo no retornó enc_id';
    ASSERT v_res->>'estado' = 'confirmado', 'No actualizó estado en fixed';
    ASSERT v_res->>'token_invitacion' = v_fixed_part_token, 'Fijo no devolvió token preservado';
    ASSERT (SELECT nombre_invitado FROM public.participantes WHERE token_invitacion = v_fixed_part_token::uuid) = 'Intentofijo', 'Fijo indiv no preservó renombre COALESCE(v_nombre_limpio, nombre_invitado)';

END $$;

ROLLBACK;
