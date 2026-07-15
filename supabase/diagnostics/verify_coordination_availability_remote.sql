-- ============================================================
-- DIAGNÓSTICO REMOTO 2B.2: ESCRITURA DE DISPONIBILIDADES (CORRECCIÓN FINAL)
-- ============================================================

-- ============================================================
-- 1. FUNCIONES REMOTAS Y METADATOS
-- ============================================================
SELECT
    p.oid,
    p.oid::regprocedure AS firma_exacta,
    n.nspname AS schema,
    p.proname,
    pg_get_function_identity_arguments(p.oid) AS argumentos_identidad,
    pg_get_function_result(p.oid) AS retorno,
    l.lanname AS language,
    p.prosecdef AS es_security_definer,
    pg_get_userbyid(p.proowner) AS owner,
    p.proconfig AS configuracion,
    COALESCE(array_to_string(p.proconfig, ','), '') LIKE '%search_path=%' AS tiene_search_path,
    pg_get_functiondef(p.oid) AS definicion_completa,
    COALESCE(p.proacl, acldefault('f', p.proowner)) AS acl_efectiva,
    has_function_privilege('postgres', p.oid, 'EXECUTE') AS grant_postgres,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS grant_service_role,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS grant_authenticated,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS grant_anon,
    EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
    ) AS grant_public
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
JOIN pg_language l ON p.prolang = l.oid
WHERE n.nspname = 'public'
  AND (
    p.oid IN (
      to_regprocedure('public.responder_participante_seguro(text,text,text,text)'),
      to_regprocedure('public.crear_encuentro_con_opciones_seguro(jsonb,jsonb)'),
      to_regprocedure('public.get_coordinacion_host_seguro(uuid)'),
      to_regprocedure('public.get_coordinacion_participante_seguro(text)'),
      to_regprocedure('public.get_coordinacion_publica_seguro(text)'),
      to_regprocedure('public.get_encuentros_host_seguro(uuid[])')
    )
    OR p.proname = 'crear_participante_individual_seguro'
  );

-- ============================================================
-- 2. ACL EXPANDIDA POR FIRMA
-- ============================================================
SELECT
  p.oid,
  p.oid::regprocedure AS firma_exacta,
  CASE
    WHEN acl.grantee = 0 THEN 'PUBLIC'
    ELSE pg_get_userbyid(acl.grantee)
  END AS grantee,
  acl.privilege_type,
  acl.is_grantable
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
CROSS JOIN LATERAL aclexplode(
  COALESCE(
    p.proacl,
    acldefault('f', p.proowner)
  )
) acl
WHERE n.nspname = 'public'
  AND (
    p.oid IN (
      to_regprocedure('public.responder_participante_seguro(text,text,text,text)'),
      to_regprocedure('public.crear_encuentro_con_opciones_seguro(jsonb,jsonb)'),
      to_regprocedure('public.get_coordinacion_host_seguro(uuid)'),
      to_regprocedure('public.get_coordinacion_participante_seguro(text)'),
      to_regprocedure('public.get_coordinacion_publica_seguro(text)'),
      to_regprocedure('public.get_encuentros_host_seguro(uuid[])')
    )
    OR p.proname = 'crear_participante_individual_seguro'
  )
ORDER BY firma_exacta, grantee, privilege_type;

-- ============================================================
-- 3. ESQUEMA REMOTO: COLUMNAS
-- ============================================================
SELECT
    table_name,
    ordinal_position,
    column_name,
    data_type,
    udt_name,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades')
ORDER BY table_name, ordinal_position;

-- ============================================================
-- 4. ESQUEMA REMOTO: CONSTRAINTS
-- ============================================================
SELECT
    conrelid::regclass AS table_name,
    conname AS constraint_name,
    contype AS constraint_type,
    pg_get_constraintdef(oid) AS definicion_completa
FROM pg_constraint
WHERE conrelid IN (
    'public.encuentros'::regclass,
    'public.encuentro_opciones_fecha'::regclass,
    'public.participantes'::regclass,
    'public.participante_disponibilidades'::regclass
)
ORDER BY table_name, constraint_name;

-- ============================================================
-- 5. ESQUEMA REMOTO: ÍNDICES
-- ============================================================
SELECT
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades')
ORDER BY tablename, indexname;

-- ============================================================
-- 6. RLS
-- ============================================================
SELECT
    relname AS table_name,
    relrowsecurity,
    relforcerowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades')
ORDER BY table_name;

-- ============================================================
-- 7. POLÍTICAS
-- ============================================================
SELECT
    tablename,
    policyname,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades')
ORDER BY tablename, policyname;

-- ============================================================
-- 8. GRANTS DIRECTOS DE TABLAS
-- ============================================================
SELECT
    table_name,
    grantee,
    privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('encuentros', 'encuentro_opciones_fecha', 'participantes', 'participante_disponibilidades')
  AND grantee IN ('anon', 'authenticated', 'PUBLIC', 'service_role', 'postgres')
ORDER BY table_name, grantee, privilege_type;

-- ============================================================
-- 9. ESTADÍSTICAS REMOTAS NO SENSIBLES
-- ============================================================
WITH enc_stats AS (
    SELECT
        e.id,
        e.date_mode,
        e.coordination_status,
        e.estado,
        e.tipo_invitacion,
        (SELECT count(*) FROM public.encuentro_opciones_fecha op WHERE op.encuentro_id = e.id) as option_count
    FROM public.encuentros e
),
part_stats AS (
    SELECT
        p.id,
        p.encuentro_id,
        p.tipo_invitacion,
        p.token_invitacion,
        (SELECT count(*) FROM public.participante_disponibilidades pd WHERE pd.participante_id = p.id) as total_respuestas,
        (SELECT count(DISTINCT pd.opcion_fecha_id) FROM public.participante_disponibilidades pd WHERE pd.participante_id = p.id) as dist_respuestas_totales,
        (
            SELECT count(DISTINCT pd.opcion_fecha_id)
            FROM public.participante_disponibilidades pd
            JOIN public.encuentro_opciones_fecha op
              ON op.id = pd.opcion_fecha_id
             AND op.encuentro_id = p.encuentro_id
            WHERE pd.participante_id = p.id
              AND pd.encuentro_id = p.encuentro_id
        ) AS dist_respuestas_validas,
        (SELECT count(*) FROM public.participante_disponibilidades pd WHERE pd.participante_id = p.id AND pd.es_preferida = true) as count_preferidas,
        (SELECT count(*) FROM public.participante_disponibilidades pd WHERE pd.participante_id = p.id AND pd.es_preferida = true AND pd.respuesta = 'unavailable') as count_pref_unavailable,
        (SELECT count(*) FROM public.participante_disponibilidades pd WHERE pd.participante_id = p.id AND pd.respuesta NOT IN ('available', 'maybe', 'unavailable')) as count_bad_respuestas,
        (SELECT count(*) FROM public.participante_disponibilidades pd WHERE pd.participante_id = p.id AND pd.encuentro_id <> p.encuentro_id) as count_bad_encuentro,
        (
            SELECT count(*)
            FROM public.participante_disponibilidades pd
            LEFT JOIN public.encuentro_opciones_fecha op ON pd.opcion_fecha_id = op.id
            WHERE pd.participante_id = p.id AND op.id IS NULL
        ) as count_opcion_inexistente,
        (
            SELECT count(*)
            FROM public.participante_disponibilidades pd
            JOIN public.encuentro_opciones_fecha op ON pd.opcion_fecha_id = op.id
            WHERE pd.participante_id = p.id AND op.encuentro_id IS DISTINCT FROM pd.encuentro_id
        ) as count_opcion_otro_encuentro
    FROM public.participantes p
)
SELECT
    -- A. Encuentros
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination') AS encuentros_coord_total,
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND coordination_status = 'open') AS encuentros_coord_open,
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND coordination_status = 'closed') AS encuentros_coord_closed,
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND estado = 'cancelado') AS encuentros_coord_cancelados,
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND tipo_invitacion = 'link_general') AS encuentros_coord_link_general,
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND tipo_invitacion = 'individual') AS encuentros_coord_individual,

    -- B. Opciones
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND option_count = 0) AS coord_0_opciones,
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND option_count = 1) AS coord_1_opcion,
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND option_count = 2) AS coord_2_opciones,
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND option_count = 3) AS coord_3_opciones,
    (SELECT count(*) FROM enc_stats WHERE date_mode = 'coordination' AND option_count > 3) AS coord_mas_3_opciones,

    -- C. Participantes
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination') AS participantes_coord_total,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.tipo_invitacion = 'individual') AS participantes_coord_individual,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.tipo_invitacion = 'generico') AS participantes_coord_generico,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.token_invitacion IS NULL) AS participantes_sin_token,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.token_invitacion IS NOT NULL) AS participantes_con_token,

    -- D. Disponibilidades
    (SELECT count(*) FROM public.participante_disponibilidades pd JOIN enc_stats e ON pd.encuentro_id = e.id WHERE e.date_mode = 'coordination') AS disponibilidades_total,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.total_respuestas = 0) AS participantes_sin_respuestas,

    -- Respuestas Parciales / Completas usando dist_respuestas_validas y option_count > 0
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.dist_respuestas_validas > 0 AND p.dist_respuestas_validas < e.option_count) AS participantes_respuestas_parciales,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND e.option_count > 0 AND p.dist_respuestas_validas = e.option_count) AS participantes_respuestas_completas,

    -- Inconsistencias
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.dist_respuestas_totales > e.option_count) AS participantes_exceso_respuestas,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.total_respuestas > p.dist_respuestas_totales) AS participantes_opciones_duplicadas,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.count_preferidas > 1) AS participantes_multiples_preferidas,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.count_pref_unavailable > 0) AS participantes_pref_unavailable,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.count_bad_respuestas > 0) AS participantes_valor_fuera_check,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.count_bad_encuentro > 0) AS disponibilidades_participante_no_coincide,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.count_opcion_inexistente > 0) AS disponibilidades_opcion_inexistente,
    (SELECT count(*) FROM part_stats p JOIN enc_stats e ON p.encuentro_id = e.id WHERE e.date_mode = 'coordination' AND p.count_opcion_otro_encuentro > 0) AS disponibilidades_opcion_otro_encuentro,
    (
        SELECT count(*)
        FROM public.participante_disponibilidades pd
        LEFT JOIN public.encuentros e ON pd.encuentro_id = e.id
        LEFT JOIN public.participantes p ON pd.participante_id = p.id
        LEFT JOIN public.encuentro_opciones_fecha op ON pd.opcion_fecha_id = op.id
        WHERE e.id IS NULL OR p.id IS NULL
    ) AS filas_huerfanas_encuentro_o_participante;
