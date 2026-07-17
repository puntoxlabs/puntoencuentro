-- ============================================================
-- VALIDACIÓN MIGRACIÓN 2B.1 (LECTURAS Y DURACIÓN)
-- ============================================================

BEGIN;

SET LOCAL plpgsql.check_asserts = on;

-- ============================================================
-- 1. VALIDACIONES DE CATÁLOGO (ASSERT AUTOMATIZADO)
-- ============================================================
DO $$
DECLARE
    v_count int;
    v_constraint_def text;
BEGIN
    -- Validar el contrato exacto de la columna
    SELECT count(*)
    INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'encuentros'
      AND column_name = 'duration_minutes'
      AND data_type = 'integer'
      AND udt_name = 'int4'
      AND is_nullable = 'YES'
      AND column_default IS NULL;
      
    ASSERT v_count = 1, 'Contrato incorrecto de encuentros.duration_minutes';

    -- Validar el constraint completo
    SELECT pg_get_constraintdef(c.oid, true)
    INTO v_constraint_def
    FROM pg_constraint c
    WHERE c.conrelid = 'public.encuentros'::regclass
      AND c.conname = 'encuentros_duration_minutes_check'
      AND c.contype = 'c'
      AND c.convalidated = true;

    ASSERT v_constraint_def IS NOT NULL, 'Falta o no está validado encuentros_duration_minutes_check';
    ASSERT v_constraint_def LIKE '%duration_minutes IS NULL%', 'Constraint no incluye duration_minutes IS NULL';
    ASSERT v_constraint_def LIKE '%15%', 'Constraint no incluye límite inferior 15';
    ASSERT v_constraint_def LIKE '%1440%', 'Constraint no incluye límite superior 1440';

    -- Validaciones de seguridad de funciones
    ASSERT to_regprocedure('public.crear_encuentro_con_opciones_seguro(jsonb,jsonb)') IS NOT NULL, 'Falta crear_encuentro_con_opciones_seguro';
    ASSERT to_regprocedure('public.get_coordinacion_host_seguro(uuid)') IS NOT NULL, 'Falta get_coordinacion_host_seguro';
    ASSERT to_regprocedure('public.get_coordinacion_participante_seguro(text)') IS NOT NULL, 'Falta get_coordinacion_participante_seguro';
    ASSERT to_regprocedure('public.get_coordinacion_publica_seguro(text)') IS NOT NULL, 'Falta get_coordinacion_publica_seguro';
    ASSERT to_regprocedure('public.get_encuentros_host_seguro(uuid[])') IS NOT NULL, 'Falta get_encuentros_host_seguro';

    SELECT count(*)
    INTO v_count
    FROM pg_proc p
    WHERE p.oid IN (
        to_regprocedure('public.crear_encuentro_con_opciones_seguro(jsonb,jsonb)'),
        to_regprocedure('public.get_coordinacion_host_seguro(uuid)'),
        to_regprocedure('public.get_coordinacion_participante_seguro(text)'),
        to_regprocedure('public.get_coordinacion_publica_seguro(text)'),
        to_regprocedure('public.get_encuentros_host_seguro(uuid[])')
    )
    AND p.prosecdef = true
    AND pg_get_userbyid(p.proowner) = 'postgres'
    AND pg_get_function_result(p.oid) = 'json'
    AND COALESCE(p.proconfig @> ARRAY['search_path=public']::text[], false);

    ASSERT v_count = 5, 'Contrato de seguridad incorrecto en una o más RPC';

    -- Grants de Funciones: HOST
    ASSERT has_function_privilege('authenticated', to_regprocedure('public.crear_encuentro_con_opciones_seguro(jsonb,jsonb)'), 'EXECUTE') = true, 'Falta grant auth en crear_encuentro_con_opciones_seguro';
    ASSERT has_function_privilege('anon', to_regprocedure('public.crear_encuentro_con_opciones_seguro(jsonb,jsonb)'), 'EXECUTE') = false, 'Grant anon incorrecto en crear_encuentro_con_opciones_seguro';
    
    ASSERT has_function_privilege('authenticated', to_regprocedure('public.get_coordinacion_host_seguro(uuid)'), 'EXECUTE') = true, 'Falta grant auth en get_coordinacion_host_seguro';
    ASSERT has_function_privilege('anon', to_regprocedure('public.get_coordinacion_host_seguro(uuid)'), 'EXECUTE') = false, 'Grant anon incorrecto en get_coordinacion_host_seguro';
    
    ASSERT has_function_privilege('authenticated', to_regprocedure('public.get_encuentros_host_seguro(uuid[])'), 'EXECUTE') = true, 'Falta grant auth en get_encuentros_host_seguro';
    ASSERT has_function_privilege('anon', to_regprocedure('public.get_encuentros_host_seguro(uuid[])'), 'EXECUTE') = false, 'Grant anon incorrecto en get_encuentros_host_seguro';

    -- Grants de Funciones: INVITADO
    ASSERT has_function_privilege('authenticated', to_regprocedure('public.get_coordinacion_participante_seguro(text)'), 'EXECUTE') = true, 'Falta grant auth en get_coordinacion_participante_seguro';
    ASSERT has_function_privilege('anon', to_regprocedure('public.get_coordinacion_participante_seguro(text)'), 'EXECUTE') = true, 'Falta grant anon en get_coordinacion_participante_seguro';

    ASSERT has_function_privilege('authenticated', to_regprocedure('public.get_coordinacion_publica_seguro(text)'), 'EXECUTE') = true, 'Falta grant auth en get_coordinacion_publica_seguro';
    ASSERT has_function_privilege('anon', to_regprocedure('public.get_coordinacion_publica_seguro(text)'), 'EXECUTE') = true, 'Falta grant anon en get_coordinacion_publica_seguro';

    -- Control PUBLIC por firma exacta
    SELECT count(*)
    INTO v_count
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(
        COALESCE(
            p.proacl,
            acldefault('f', p.proowner)
        )
    ) AS acl
    WHERE p.oid IN (
        to_regprocedure(
            'public.crear_encuentro_con_opciones_seguro(jsonb,jsonb)'
        ),
        to_regprocedure(
            'public.get_coordinacion_host_seguro(uuid)'
        ),
        to_regprocedure(
            'public.get_coordinacion_participante_seguro(text)'
        ),
        to_regprocedure(
            'public.get_coordinacion_publica_seguro(text)'
        ),
        to_regprocedure(
            'public.get_encuentros_host_seguro(uuid[])'
        )
    )
    AND acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE';

    ASSERT v_count = 0, 'Alguna función tiene EXECUTE otorgado a PUBLIC';

    -- Validar que existan las cuatro tablas RLS
    SELECT count(*)
    INTO v_count
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind = 'r'
      AND c.relname IN (
        'encuentros',
        'encuentro_opciones_fecha',
        'participantes',
        'participante_disponibilidades'
      )
      AND c.relrowsecurity = true;
      
    ASSERT v_count = 4, 'Falta una tabla o alguna tabla no tiene RLS habilitado';

    SELECT count(*) INTO v_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades');
    ASSERT v_count = 0, 'Existen políticas (policy) para estas tablas';

    SELECT count(*) INTO v_count
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades')
      AND grantee IN ('anon', 'authenticated', 'PUBLIC');
    ASSERT v_count = 0, 'Existen privilegios directos de tabla para anon, authenticated o PUBLIC';

END $$;


-- ============================================================
-- 2. PRUEBAS FUNCIONALES Y DESTRUCTIVAS
-- ============================================================
DO $$
DECLARE
    v_host_id uuid := gen_random_uuid();
    v_other_id uuid := gen_random_uuid();
    v_res jsonb;
    v_enc_id uuid;
    v_public_token text;
    v_op_id_1 uuid;
    v_op_id_2 uuid;
    v_part_id uuid := gen_random_uuid();
    v_token_invitacion uuid := gen_random_uuid();
    v_home_item jsonb;
    v_found boolean := false;
    v_persisted_duration integer;
    v_fixed_enc_id uuid;
    v_fixed_home_item jsonb;
    v_fixed_found boolean := false;
    v_base_data jsonb := '{"titulo": "Test", "modalidad": "virtual", "link_virtual": "https://meet.google.com/test", "tipo_invitacion": "link_general", "tema": "blue"}';
    v_opciones jsonb := format('[{"fecha": "%s", "hora_inicio": "10:00"}, {"fecha": "%s", "hora_inicio": "11:00"}]', current_date + 30, current_date + 31)::jsonb;
BEGIN
    -- ============================================================
    -- Configurar claims de host (Propietario)
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config(
        'request.jwt.claims',
        json_build_object(
            'sub', v_host_id::text,
            'role', 'authenticated',
            'is_anonymous', false
        )::text,
        true
    );

    ASSERT auth.uid() = v_host_id, 'auth.uid() no coincide con el propietario';
    ASSERT COALESCE((auth.jwt()->>'is_anonymous')::boolean, false) = false, 'El propietario no debe ser anónimo';

    -- ============================================================
    -- Casos de duración
    -- ============================================================
    
    -- Clave ausente
    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data, v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló clave ausente';
    ASSERT v_res->'encuentro'->'duration_minutes' = 'null'::jsonb, 'La duración omitida debería ser null';

    -- Null explícito
    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": null}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló null';
    ASSERT v_res->'encuentro'->'duration_minutes' = 'null'::jsonb, 'La duración JSON null debería persistirse como null';
    
    -- Aceptados válidos
    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": 15}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló 15';
    ASSERT (v_res->'encuentro'->>'duration_minutes')::integer = 15, 'La duración 15 no se persistió correctamente';
    
    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": 30}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló 30';
    ASSERT (v_res->'encuentro'->>'duration_minutes')::integer = 30, 'La duración 30 no se persistió correctamente';
    
    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": 1440}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló 1440';
    ASSERT (v_res->'encuentro'->>'duration_minutes')::integer = 1440, 'La duración 1440 no se persistió correctamente';
    
    -- Rechazados
    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": 14}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Debería fallar 14';
    ASSERT v_res->>'error' = 'invalid_duration_minutes', 'Error incorrecto para 14';

    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": 1441}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Debería fallar 1441';
    ASSERT v_res->>'error' = 'invalid_duration_minutes', 'Error incorrecto para 1441';
    
    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": 30.5}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Debería fallar 30.5';
    ASSERT v_res->>'error' = 'invalid_duration_minutes', 'Error incorrecto para 30.5';

    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": "30"}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Debería fallar "30"';
    ASSERT v_res->>'error' = 'invalid_duration_minutes', 'Error incorrecto para "30"';

    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": true}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Debería fallar true';
    ASSERT v_res->>'error' = 'invalid_duration_minutes', 'Error incorrecto para true';

    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": []}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Debería fallar array';
    ASSERT v_res->>'error' = 'invalid_duration_minutes', 'Error incorrecto para array';

    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": {}}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Debería fallar objeto';
    ASSERT v_res->>'error' = 'invalid_duration_minutes', 'Error incorrecto para objeto';

    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": -1}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Debería fallar -1';
    ASSERT v_res->>'error' = 'invalid_duration_minutes', 'Error incorrecto para -1';

    -- ============================================================
    -- Crear encuentro oficial para pruebas de host y participante
    -- ============================================================
    v_res := public.crear_encuentro_con_opciones_seguro(v_base_data || '{"duration_minutes": 60}', v_opciones)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló creación de encuentro base 60';
    
    v_enc_id := (v_res->'encuentro'->>'id')::uuid;
    v_public_token := v_res->'encuentro'->>'public_token';
    v_op_id_1 := (v_res->'opciones'->0->>'id')::uuid;
    v_op_id_2 := (v_res->'opciones'->1->>'id')::uuid;

    ASSERT (v_res->'encuentro'->>'duration_minutes')::integer = 60, 'El response de creacion no tiene duration = 60';
    ASSERT v_res->'encuentro'->>'date_mode' = 'coordination', 'date_mode no es coordination';
    ASSERT v_res->'encuentro'->>'coordination_status' = 'open', 'coordination_status no es open';
    ASSERT jsonb_array_length(v_res->'opciones') = 2, 'No hay dos opciones';

    -- Comprobar la duración persistida en la tabla
    SELECT duration_minutes INTO v_persisted_duration FROM public.encuentros WHERE id = v_enc_id;
    ASSERT v_persisted_duration = 60, 'duration_minutes no quedó persistido en encuentros';

    -- Insertar directamente un encuentro fijo perteneciente al mismo host
    INSERT INTO public.encuentros (
        titulo, descripcion, fecha, hora, modalidad, lugar_texto, tipo_invitacion, host_id, date_mode, coordination_status, selected_option_id, response_deadline, duration_minutes
    )
    VALUES (
        'Test fijo Home', 'Validación option_count', current_date + 40, '12:00'::time, 'presencial', 'Lugar de prueba', 'link_general', v_host_id, 'fixed', NULL, NULL, NULL, NULL
    )
    RETURNING id INTO v_fixed_enc_id;

    -- ============================================================
    -- Prueba de HOST (Propietario)
    -- ============================================================
    v_res := public.get_coordinacion_host_seguro(v_enc_id)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló get_coordinacion_host_seguro';
    ASSERT v_res->'encuentro'->>'public_token' = v_public_token, 'No coincide public_token';
    ASSERT (v_res->'encuentro'->>'duration_minutes')::integer = 60, 'Duracion host no es 60';
    ASSERT v_res ? 'derived_status', 'No existe derived_status';
    ASSERT v_res ? 'coordination_status', 'No existe coordination_status';
    ASSERT jsonb_array_length(v_res->'opciones') = 2, 'No tiene dos opciones en lectura host';
    ASSERT v_res->'opciones'->0 ? 'available_count', 'Falta available_count';
    ASSERT v_res->'opciones'->0 ? 'maybe_count', 'Falta maybe_count';
    ASSERT v_res->'opciones'->0 ? 'unavailable_count', 'Falta unavailable_count';
    ASSERT v_res->'opciones'->0 ? 'preferred_count', 'Falta preferred_count';

    -- ============================================================
    -- Prueba de USUARIO AJENO
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', v_other_id::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', v_other_id::text,
        'role', 'authenticated',
        'is_anonymous', false
      )::text,
      true
    );
    
    ASSERT auth.uid() = v_other_id, 'auth.uid() no coincide con el usuario ajeno';
    
    v_res := public.get_coordinacion_host_seguro(v_enc_id)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Usuario ajeno deberia fallar';
    ASSERT v_res->>'error' = 'not_owner', 'Usuario ajeno no devolvió not_owner';

    -- ============================================================
    -- Prueba de CUENTA ANÓNIMA (del mismo host)
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', v_host_id::text,
        'role', 'authenticated',
        'is_anonymous', true
      )::text,
      true
    );
    
    ASSERT auth.uid() = v_host_id, 'auth.uid() no coincide en prueba anónima';
    ASSERT (auth.jwt()->>'is_anonymous')::boolean = true, 'La cuenta no está configurada como anónima';
    
    v_res := public.get_coordinacion_host_seguro(v_enc_id)::jsonb;
    ASSERT v_res->>'ok' = 'false', 'Cuenta anónima deberia fallar';
    ASSERT v_res->>'error' = 'permanent_account_required', 'Cuenta anónima no devolvió permanent_account_required';

    -- ============================================================
    -- Restaurar claims de HOST (Propietario)
    -- ============================================================
    PERFORM set_config('request.jwt.claim.sub', v_host_id::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', v_host_id::text,
        'role', 'authenticated',
        'is_anonymous', false
      )::text,
      true
    );

    ASSERT auth.uid() = v_host_id, 'Error al restaurar auth.uid() del propietario';

    -- ============================================================
    -- Prueba de HOME
    -- ============================================================
    v_res := public.get_encuentros_host_seguro(ARRAY[v_host_id])::jsonb;
    
    FOR v_home_item IN
        SELECT value
        FROM jsonb_array_elements(v_res)
    LOOP
        IF v_home_item->>'id' = v_enc_id::text THEN
            v_found := true;
    
            ASSERT v_home_item ? 'titulo', 'Falta titulo';
            ASSERT v_home_item ? 'descripcion', 'Falta descripcion';
            ASSERT v_home_item ? 'fecha', 'Falta fecha';
            ASSERT v_home_item ? 'hora', 'Falta hora';
            ASSERT v_home_item ? 'modalidad', 'Falta modalidad';
            ASSERT v_home_item ? 'lugar_texto', 'Falta lugar_texto';
            ASSERT v_home_item ? 'link_virtual', 'Falta link_virtual';
            ASSERT v_home_item ? 'tipo_invitacion', 'Falta tipo_invitacion';
            ASSERT v_home_item ? 'host_id', 'Falta host_id';
            ASSERT v_home_item ? 'public_token', 'Falta public_token';
            ASSERT v_home_item ? 'estado', 'Falta estado';
            ASSERT v_home_item ? 'tema', 'Falta tema';
            ASSERT v_home_item ? 'reemplaza_a', 'Falta reemplaza_a';
            ASSERT v_home_item ? 'creado_en', 'Falta creado_en';
            ASSERT v_home_item ? 'tema_invitacion', 'Falta tema_invitacion';
            ASSERT v_home_item ? 'invitation_template', 'Falta invitation_template';
            ASSERT v_home_item ? 'date_mode', 'Falta date_mode';
            ASSERT v_home_item ? 'coordination_status', 'Falta coordination_status';
            ASSERT v_home_item ? 'response_deadline', 'Falta response_deadline';
            ASSERT v_home_item ? 'duration_minutes', 'Falta duration_minutes';
            ASSERT v_home_item ? 'selected_option_id', 'Falta selected_option_id';
            ASSERT v_home_item ? 'option_count', 'Falta option_count';
    
            ASSERT (v_home_item->>'duration_minutes')::integer = 60,
                'duration_minutes incorrecto en Home';
    
            ASSERT (v_home_item->>'option_count')::integer = 2,
                'option_count incorrecto en Home';
    
            ASSERT v_home_item->>'public_token' = v_public_token,
                'public_token alterado en Home';
        END IF;

        IF v_home_item->>'id' = v_fixed_enc_id::text THEN
            v_fixed_found := true;
            ASSERT v_home_item->>'date_mode' = 'fixed', 'date_mode no es fixed';
            ASSERT v_home_item->'coordination_status' = 'null'::jsonb, 'coordination_status no es JSON null en fijo';
            ASSERT v_home_item->'duration_minutes' = 'null'::jsonb, 'duration_minutes no es JSON null en fijo';
            ASSERT v_home_item->'selected_option_id' = 'null'::jsonb, 'selected_option_id no es JSON null en fijo';
            ASSERT (v_home_item->>'option_count')::integer = 0, 'option_count no es 0 en fijo';
            ASSERT v_home_item ? 'public_token', 'Falta public_token en fijo';
            ASSERT v_home_item ? 'fecha', 'Falta fecha en fijo';
            ASSERT v_home_item ? 'hora', 'Falta hora en fijo';
        END IF;
    END LOOP;
    
    ASSERT v_found, 'Encuentro no encontrado en Home';
    ASSERT v_fixed_found, 'Encuentro fijo no encontrado en Home';

    -- ============================================================
    -- Prueba de PÚBLICA
    -- ============================================================
    v_res := public.get_coordinacion_publica_seguro(v_public_token)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló publica';
    ASSERT (v_res->'encuentro'->>'duration_minutes')::integer = 60, 'Duración pública no es 60';
    ASSERT jsonb_array_length(v_res->'opciones') = 2, 'Opciones públicas incorrectas';
    ASSERT NOT (v_res->'encuentro' ? 'public_token'), 'Filtró public_token en publica';
    ASSERT NOT (v_res->'encuentro' ? 'host_id'), 'Filtró host_id en publica';
    ASSERT NOT (v_res->'encuentro' ? 'link_virtual'), 'Filtró link_virtual en publica';
    ASSERT NOT (v_res ? 'participantes'), 'Raíz publica tiene participantes';
    ASSERT NOT (v_res ? 'mis_respuestas'), 'Raíz publica tiene mis_respuestas';

    -- ============================================================
    -- Crear Participante y Disponibilidades
    -- ============================================================
    INSERT INTO public.participantes (id, encuentro_id, token_invitacion, nombre_invitado, tipo_invitacion)
    VALUES (v_part_id, v_enc_id, v_token_invitacion, 'Invitado Test', 'individual');

    INSERT INTO public.participante_disponibilidades (participante_id, encuentro_id, opcion_fecha_id, respuesta, es_preferida)
    VALUES 
        (v_part_id, v_enc_id, v_op_id_1, 'available', true),
        (v_part_id, v_enc_id, v_op_id_2, 'maybe', false);

    -- ============================================================
    -- Prueba de INDIVIDUAL
    -- ============================================================
    v_res := public.get_coordinacion_participante_seguro(v_token_invitacion::text)::jsonb;
    ASSERT v_res->>'ok' = 'true', 'Falló individual';
    ASSERT (v_res->'encuentro'->>'duration_minutes')::integer = 60, 'Duracion individual no es 60';
    ASSERT v_res->'participante'->>'id' = v_part_id::text, 'Participante ID incorrecto';
    ASSERT jsonb_array_length(v_res->'mis_respuestas') = 2, 'mis_respuestas no tiene 2 elementos';
    ASSERT v_res->'mis_respuestas'->0 ? 'opcion_fecha_id', 'mis_respuestas sin opcion_fecha_id';
    ASSERT (v_res->'mis_respuestas'->0->>'opcion_fecha_id') = v_op_id_1::text, 'Orden incorrecto en mis_respuestas';
    
    ASSERT NOT (v_res->'encuentro' ? 'public_token'), 'Individual expuso public_token';
    ASSERT NOT (v_res->'encuentro' ? 'host_id'), 'Individual expuso host_id';
    ASSERT NOT (v_res->'encuentro' ? 'link_virtual'), 'Individual expuso link_virtual';
    ASSERT NOT (v_res->'participante' ? 'token_invitacion'), 'Participante expuso token_invitacion';

    -- ============================================================
    -- Prueba de CONTEOS REALES HOST
    -- ============================================================
    v_res := public.get_coordinacion_host_seguro(v_enc_id)::jsonb;
    ASSERT (v_res->'opciones'->0->>'available_count')::integer = 1, 'Conteos reales: available falló';
    ASSERT (v_res->'opciones'->0->>'preferred_count')::integer = 1, 'Conteos reales: preferred falló';
    ASSERT (v_res->'opciones'->1->>'maybe_count')::integer = 1, 'Conteos reales: maybe falló';
    ASSERT (v_res->'opciones'->1->>'available_count')::integer = 0, 'Conteos reales: available opción 2 falló';

END $$;

ROLLBACK;
