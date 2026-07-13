-- ============================================================
-- Diagnóstico: verify_date_coordination_prerequisites
-- ============================================================

-- 0. Identificación del Entorno
SELECT
    current_database() AS database_name,
    current_user AS executing_user,
    current_setting('server_version') AS postgres_version,
    current_setting('TimeZone') AS database_timezone;

-- 1. Tablas y Columnas (encuentros y participantes)
SELECT 
    table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default, ordinal_position
FROM information_schema.columns 
WHERE table_name IN ('encuentros', 'participantes') AND table_schema = 'public' 
ORDER BY table_name, ordinal_position;

-- 2. Constraints de encuentros y participantes
SELECT
    ns.nspname AS table_schema,
    cls.relname AS table_name,
    con.conname AS constraint_name,
    CASE con.contype
        WHEN 'p' THEN 'PRIMARY KEY'
        WHEN 'u' THEN 'UNIQUE'
        WHEN 'f' THEN 'FOREIGN KEY'
        WHEN 'c' THEN 'CHECK'
        WHEN 'x' THEN 'EXCLUSION'
        ELSE con.contype::text
    END AS constraint_type,
    pg_get_constraintdef(con.oid, true) AS constraint_definition,
    con.convalidated AS is_validated,
    con.condeferrable AS is_deferrable,
    con.condeferred AS initially_deferred
FROM pg_constraint con
JOIN pg_class cls ON cls.oid = con.conrelid
JOIN pg_namespace ns ON ns.oid = cls.relnamespace
WHERE ns.nspname = 'public'
  AND cls.relname IN ('encuentros', 'participantes')
ORDER BY cls.relname, con.conname;

-- 3. Dependencias sobre fecha y hora
-- Vistas que dependen de encuentros
SELECT
    v.view_schema,
    v.view_name,
    v.table_schema,
    v.table_name
FROM information_schema.view_table_usage v
WHERE v.table_schema = 'public'
  AND v.table_name = 'encuentros'
ORDER BY v.view_schema, v.view_name;

-- Funciones que mencionan fecha u hora
SELECT
    p.oid AS function_oid,
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n
    ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.prokind IN ('f', 'p')
  AND pg_get_functiondef(p.oid) ~* '(^|[^[:alnum:]_])(fecha|hora)($|[^[:alnum:]_])'
ORDER BY p.proname, arguments;

-- Triggers sobre encuentros
SELECT tg.tgname AS trigger_name, pg_get_triggerdef(tg.oid) AS trigger_definition
FROM pg_trigger tg JOIN pg_class c ON tg.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public' AND c.relname = 'encuentros' AND NOT tg.tgisinternal;

-- Índices que involucren fecha u hora en encuentros
SELECT indexname, indexdef FROM pg_indexes 
WHERE schemaname = 'public' AND tablename = 'encuentros' AND (indexdef ~* '(^|[^[:alnum:]_])(fecha|hora)($|[^[:alnum:]_])');

-- 4. Triggers Completos de encuentros y participantes
SELECT tg.tgrelid::regclass AS table_name, tg.tgname AS trigger_name, tgenabled AS trigger_status, pg_get_triggerdef(tg.oid) AS trigger_definition
FROM pg_trigger tg JOIN pg_class c ON tg.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public' AND c.relname IN ('encuentros', 'participantes') AND NOT tg.tgisinternal;

-- 5. Row Level Security y Policies
SELECT
    schemaname,
    tablename,
    rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('encuentros', 'participantes')
ORDER BY tablename;

SELECT
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('encuentros', 'participantes')
ORDER BY tablename, policyname;

-- 6. Privilegios de Tablas
SELECT
    table_schema,
    table_name,
    grantor,
    grantee,
    privilege_type,
    is_grantable
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name IN ('encuentros', 'participantes')
ORDER BY
    CASE grantee
        WHEN 'PUBLIC' THEN 1
        WHEN 'anon' THEN 2
        WHEN 'authenticated' THEN 3
        ELSE 4
    END,
    grantee,
    table_name,
    privilege_type;

-- 7. Funciones RPC: Firmas, Privilegios y Detalles
SELECT 
    p.oid AS function_oid,
    p.proname AS function_name, 
    pg_get_userbyid(p.proowner) AS owner,
    pg_get_function_identity_arguments(p.oid) AS arguments, 
    pg_get_function_result(p.oid) AS return_type, 
    CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END AS security_type, 
    p.proconfig AS search_path, 
    p.proacl AS acl
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname ~ 'encuentro|participante|invitacion|cancelar|eliminar|reprogramar|respuesta';

-- Roles con EXECUTE en dichas funciones
SELECT routine_name, specific_name, grantee, privilege_type 
FROM information_schema.routine_privileges 
WHERE routine_schema = 'public' AND routine_name ~ 'encuentro|participante|invitacion|cancelar|eliminar|reprogramar|respuesta';

-- 8. Definición completa de Funciones Relacionadas
SELECT p.proname AS function_name, pg_get_function_identity_arguments(p.oid) AS arguments, pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND p.proname ~ 'encuentro|participante|invitacion|cancelar|eliminar|reprogramar|respuesta';

-- 9. Datos Reales (Métricas de impacto)
SELECT
    COUNT(*) AS total_encuentros,
    COUNT(*) FILTER (WHERE fecha IS NULL) AS encuentros_fecha_nula,
    COUNT(*) FILTER (WHERE hora IS NULL) AS encuentros_hora_nula,
    COUNT(*) FILTER (WHERE fecha IS NULL OR hora IS NULL) AS encuentros_fecha_u_hora_nula
FROM public.encuentros;

SELECT estado, COUNT(*) AS cantidad
FROM public.encuentros
GROUP BY estado
ORDER BY estado;

SELECT estado, COUNT(*) AS cantidad
FROM public.participantes
GROUP BY estado
ORDER BY estado;

-- ============================================================
-- 10. Consulta Condicional: Tipos de Invitación
-- ============================================================
-- Verificá primero si la columna existe en el esquema remoto:
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'participantes' AND column_name = 'tipo_invitacion' AND table_schema = 'public';

-- Si la consulta anterior devuelve resultados, podés ejecutar manualmente esta métrica:
/*
SELECT
    tipo_invitacion,
    COUNT(*) AS cantidad
FROM public.participantes
GROUP BY tipo_invitacion
ORDER BY tipo_invitacion;
*/
