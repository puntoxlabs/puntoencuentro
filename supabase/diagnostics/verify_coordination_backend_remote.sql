-- ============================================================
-- SCRIPT DE DIAGNÓSTICO REMOTO - BLOQUE 2B
-- ============================================================
-- IMPORTANTE: Ejecutar en Supabase SQL Editor y guardar resultados.

-- 1. INSPECCIÓN DE COLUMNAS DE ENCUENTROS Y OPCIONES
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades')
  AND table_schema = 'public'
ORDER BY table_name, ordinal_position;

-- 2. INSPECCIÓN DE CONSTRAINTS (INCLUYENDO CHECKS Y UNIQUES)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN (
    'public.encuentros'::regclass,
    'public.encuentro_opciones_fecha'::regclass,
    'public.participantes'::regclass,
    'public.participante_disponibilidades'::regclass
)
ORDER BY conrelid, conname;

-- 3. INSPECCIÓN DE ÍNDICES
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades');

-- 4. POLÍTICAS RLS (ROW LEVEL SECURITY)
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades');

-- 5. GRANTS EN TABLAS SENSITIVAS
SELECT grantee, privilege_type, table_name
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('encuentro_opciones_fecha', 'participante_disponibilidades')
  AND grantee IN ('PUBLIC', 'anon', 'authenticated');

-- 6. INSPECCIÓN DE FIRMAS Y TIPOS DE RETORNO DE RPCS ACTUALES
SELECT 
    p.proname AS nombre_funcion,
    pg_get_function_identity_arguments(p.oid) AS argumentos,
    pg_get_function_result(p.oid) AS tipo_retorno,
    p.prosecdef AS es_security_definer
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
      'crear_encuentro_con_opciones_seguro',
      'get_coordinacion_host_seguro',
      'get_coordinacion_participante_seguro',
      'get_coordinacion_publica_seguro',
      'get_encuentros_host_seguro',
      'responder_participante_seguro',
      'crear_participante_individual_seguro'
  );

-- 7. INSPECCIÓN DEL CÓDIGO FUENTE DE LAS FUNCIONES CRÍTICAS
-- Para revisar cómo está escrito actualmente el HOME y el responder_participante
SELECT 
    p.proname,
    pg_get_functiondef(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
      'get_encuentros_host_seguro',
      'responder_participante_seguro'
  );

-- 8. PERMISOS DE EJECUCIÓN (GRANTS) EN LAS FUNCIONES
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN (
      'crear_encuentro_con_opciones_seguro',
      'get_coordinacion_host_seguro',
      'get_coordinacion_participante_seguro',
      'get_coordinacion_publica_seguro',
      'get_encuentros_host_seguro',
      'responder_participante_seguro',
      'crear_participante_individual_seguro'
  )
ORDER BY routine_name, grantee;
