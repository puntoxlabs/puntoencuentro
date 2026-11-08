/**
 * Preflight de Diagnóstico de Solo Lectura para Supabase Staging
 * Mini-Sprint 2B-2: Puente de Identidad entre Dominios
 *
 * ====================================================================================
 * GARANTÍA DE NO MODIFICACIÓN (ESTRICTAMENTE NO MUTANTE):
 * Este script es 100% DE SOLO LECTURA:
 *  - CERO ejecuciones de RPCs de negocio (ni siquiera con payloads vacíos o no autenticados).
 *  - Introspección de RPCs, tablas y columnas realizada EXCLUSIVAMENTE mediante
 *    el catálogo OpenAPI de PostgREST (GET /rest/v1/ con Accept: application/openapi+json).
 *  - CERO mutaciones SQL (sin INSERT, UPDATE ni DELETE).
 *  - CERO cambios en DDL, esquemas o migraciones.
 *  - CERO modificaciones al Kill Switch (cross_origin_bridge_enabled permanece intacto).
 *  - CERO fixtures de prueba creados en auth.users ni tablas de negocio.
 *
 * Entorno autorizado único: Staging (wougfhfwqgmxhgvjqoua).
 * Terminantemente prohibido contra Producción (aurbicjwftjhwryhyjiq).
 * ====================================================================================
 */

import { createClient } from '@supabase/supabase-js';

import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

// 1. Guardias de seguridad de entorno
assertStagingEnvironment(STAGING_URL);
assertStagingEnvironment(STAGING_PROJECT_REF);

if (STAGING_URL.includes(PRODUCTION_PROJECT_REF)) {
  console.error(`[CRITICAL SECURITY] Intento de ejecución contra PRODUCCIÓN (${PRODUCTION_PROJECT_REF}). Abortando.`);
  process.exit(1);
}

export type CheckStatus =
  | 'OK_PREEXISTENTE'       // Estructura base que ya existe y está operativa con firma confirmada
  | 'OK_MIGRADO'            // Estructura nueva de 2B-1 ya desplegada y operativa con firma confirmada
  | 'PENDIENTE_MIGRACION'   // Estructura nueva de 2B-1 ausente (esperado ANTES de aplicar migración)
  | 'NO_VERIFICABLE'        // Ausente o catálogo ambiguo: no es posible certificar estado sin ejecutar
  | 'PROTECTED_RLS'         // Acceso anónimo denegado formalmente por permiso o RLS
  | 'INDETERMINATE_EMPTY'   // Tabla vacía: devuelve 0 filas pero no acredita bloqueo RLS
  | 'FAILED'                // Error de red, discrepancia de firma o regresión
  | 'WARNING';              // Alerta que requiere atención operativa

export interface PreflightItem {
  fase: 'BASE_PREEXISTENTE' | 'NUEVO_2B1' | 'SEGURIDAD_RLS' | 'KILL_SWITCH';
  categoria: string;
  elemento: string;
  estado: CheckStatus;
  detalle: string;
}

/**
 * Inspecciona exhaustivamente una RPC en el catálogo OpenAPI de PostgREST.
 * Verifica existencia de la ruta, método POST y coincidencia estricta de parámetros requeridos.
 */
function inspectRpcInOpenApi(
  paths: any,
  rpcName: string,
  expectedParams: string[]
): {
  existsInCatalog: boolean;
  signatureMatch: boolean;
  foundParams: string[];
  missingParams: string[];
  catalogDetail: string;
} {
  const rpcPath = `/rpc/${rpcName}`;
  const pathObj = paths[rpcPath];
  if (!pathObj) {
    return {
      existsInCatalog: false,
      signatureMatch: false,
      foundParams: [],
      missingParams: expectedParams,
      catalogDetail: `Ruta ${rpcPath} no catalogada en OpenAPI de PostgREST`,
    };
  }

  const postOp = pathObj.post;
  if (!postOp) {
    return {
      existsInCatalog: true,
      signatureMatch: false,
      foundParams: [],
      missingParams: expectedParams,
      catalogDetail: `Ruta ${rpcPath} catalogada pero sin método POST disponible`,
    };
  }

  const rawParams = postOp.parameters || [];
  const foundParamNames = new Set<string>();

  for (const p of rawParams) {
    if (p.name && p.in !== 'body') {
      foundParamNames.add(p.name);
    }
    if (p.in === 'body' && p.schema?.properties) {
      for (const propName of Object.keys(p.schema.properties)) {
        foundParamNames.add(propName);
      }
    }
  }

  const missingParams = expectedParams.filter((ep) => !foundParamNames.has(ep));
  const hasAllExpected = missingParams.length === 0;

  // Si se esperan 0 parámetros (ej: revoke_my_pending_transfer_ticket)
  if (expectedParams.length === 0) {
    const signatureMatch = foundParamNames.size === 0;
    return {
      existsInCatalog: true,
      signatureMatch,
      foundParams: Array.from(foundParamNames),
      missingParams: [],
      catalogDetail: signatureMatch
        ? `RPC sin parámetros catalogada correctamente (0 argumentos requeridos)`
        : `RPC catalogada con parámetros inesperados: ${Array.from(foundParamNames).join(', ')}`,
    };
  }

  return {
    existsInCatalog: true,
    signatureMatch: hasAllExpected,
    foundParams: Array.from(foundParamNames),
    missingParams,
    catalogDetail: hasAllExpected
      ? `Firma comprobada: parámetros presentes (${expectedParams.join(', ')})`
      : `Discrepancia de firma: faltan [${missingParams.join(', ')}]. Encontrados en catálogo: [${Array.from(foundParamNames).join(', ')}]`,
  };
}

export async function runReadOnlyPreflight(): Promise<{
  success: boolean;
  isPreMigration: boolean;
  isPostMigration: boolean;
  items: PreflightItem[];
}> {
  console.log('================================================================================');
  console.log('PREFLIGHT DE SOLO LECTURA — PUENTE DE IDENTIDAD (STAGING)');
  console.log(`Target Supabase URL: ${STAGING_URL} (Ref: ${STAGING_PROJECT_REF})`);
  console.log(`Protección anti-producción: Prohibido estrictamente ${PRODUCTION_PROJECT_REF}`);
  console.log(`Mecanismo: Introspección de catálogo OpenAPI de PostgREST (CERO llamadas RPC)`);
  console.log('================================================================================\n');

  const adminKey = getStagingSecretKey();
  const publishableKey = getStagingPublishableKey();

  const adminClient = createClient(STAGING_URL, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const anonClient = createClient(STAGING_URL, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const items: PreflightItem[] = [];

  // -------------------------------------------------------------------------
  // 1. Obtención y Validación del Catálogo OpenAPI de PostgREST
  // -------------------------------------------------------------------------
  console.log('Paso 1: Obteniendo catálogo OpenAPI de PostgREST (GET /rest/v1/)...');
  let openApi: any = null;
  let openApiError: string | null = null;

  // Probar autenticación compatible con las claves de Staging (sin imprimir claves en logs)
  const authMethods = [
    { name: 'service_role key (admin - openapi+json)', key: adminKey, accept: 'application/openapi+json' },
    { name: 'service_role key (admin - json)', key: adminKey, accept: 'application/json' },
    { name: 'publishable key (anon - openapi+json)', key: publishableKey, accept: 'application/openapi+json' },
    { name: 'publishable key (anon - json)', key: publishableKey, accept: 'application/json' },
  ];

  for (const method of authMethods) {
    try {
      const res = await fetch(`${STAGING_URL}/rest/v1/`, {
        method: 'GET',
        headers: {
          apikey: method.key,
          Authorization: `Bearer ${method.key}`,
          Accept: method.accept,
        },
      });
      if (res.ok) {
        openApi = await res.json();
        console.log(`  Catálogo OpenAPI obtenido exitosamente mediante: ${method.name}.`);
        break;
      } else {
        openApiError = `HTTP ${res.status}: ${res.statusText}`;
      }
    } catch (err: any) {
      openApiError = err?.message || String(err);
    }
  }

  if (!openApi) {
    console.error(`  Fallo crítico obteniendo catálogo OpenAPI: ${openApiError}`);
    items.push({
      fase: 'BASE_PREEXISTENTE',
      categoria: 'Catálogo OpenAPI',
      elemento: 'GET /rest/v1/',
      estado: 'FAILED',
      detalle: `No se pudo obtener OpenAPI de PostgREST: ${openApiError} (claves sanitizadas).`,
    });
  } else {
    console.log(`  Rutas indexadas en catálogo: ${Object.keys(openApi.paths || {}).length}`);
  }

  const paths = openApi?.paths || {};
  const definitions = openApi?.definitions || {};

  // -------------------------------------------------------------------------
  // 2. Verificación de Estructuras BASE PREEXISTENTES (Ya deben existir)
  // -------------------------------------------------------------------------
  console.log('\nPaso 2: Verificando estructuras base preexistentes...');

  // 2.1 Tablas Base
  const baseTables = [
    { name: 'encuentros', cols: ['id', 'host_id', 'titulo', 'estado', 'post_event_active_minutes'] },
    { name: 'participantes', cols: ['id', 'encuentro_id', 'user_id', 'estado'] },
    { name: 'mensajes_encuentro', cols: ['id', 'encuentro_id', 'autor_user_id'] },
    { name: 'inbox_notifications', cols: ['id', 'recipient_user_id'] },
    { name: 'notification_delivery_outbox', cols: ['id', 'recipient_user_id'] },
    { name: 'rate_limit_buckets', cols: ['action', 'user_id'] },
    { name: 'anonymous_transfer_tickets', cols: ['id', 'token_hash', 'status', 'expires_at'] },
  ];

  for (const t of baseTables) {
    const pathExists = `/${t.name}` in paths;
    const def = definitions[t.name]?.properties || {};
    const missingCols = t.cols.filter((c) => !(c in def));

    if (pathExists && missingCols.length === 0) {
      items.push({
        fase: 'BASE_PREEXISTENTE',
        categoria: 'Tabla Base',
        elemento: t.name,
        estado: 'OK_PREEXISTENTE',
        detalle: `Presente en catálogo con todas sus columnas base (${t.cols.join(', ')}).`,
      });
    } else if (pathExists && missingCols.length > 0) {
      // Si la tabla está en paths pero le faltan columnas base
      items.push({
        fase: 'BASE_PREEXISTENTE',
        categoria: 'Columna Base',
        elemento: `${t.name} (${missingCols.join(', ')})`,
        estado: 'FAILED',
        detalle: `Tabla existe pero faltan columnas base esperadas: ${missingCols.join(', ')}`,
      });
    } else {
      // Fallback a consulta HEAD no mutante para verificar si la tabla existe en PostgreSQL
      const { error: headErr } = await adminClient.from(t.name).select(t.cols[0], { head: true, count: 'exact' });
      if (!headErr) {
        items.push({
          fase: 'BASE_PREEXISTENTE',
          categoria: 'Tabla Base (HEAD)',
          elemento: t.name,
          estado: 'OK_PREEXISTENTE',
          detalle: `Accesible mediante SELECT HEAD administrativo de service_role.`,
        });
      } else {
        items.push({
          fase: 'BASE_PREEXISTENTE',
          categoria: 'Tabla Base',
          elemento: t.name,
          estado: 'FAILED',
          detalle: `Tabla base preexistente no accesible: ${headErr.message}`,
        });
      }
    }
  }

  // 2.2 RPCs Base Preexistentes (inspección estricta de firma en OpenAPI, CERO llamadas)
  const baseRpcs = [
    {
      name: 'crear_encuentro_seguro',
      expectedParams: ['p_data'],
      desc: 'Firma canónica con p_data jsonb',
    },
    {
      name: 'publicar_mensaje_encuentro_seguro',
      expectedParams: ['p_encuentro_id', 'p_contenido'],
      desc: 'Publicación con encuentro y contenido',
    },
    {
      name: 'revoke_my_pending_transfer_ticket',
      expectedParams: [], // 0 argumentos
      desc: 'Revocación idempotente preexistente',
    },
  ];

  for (const r of baseRpcs) {
    if (!openApi) {
      items.push({
        fase: 'BASE_PREEXISTENTE',
        categoria: 'RPC Base',
        elemento: r.name,
        estado: 'NO_VERIFICABLE',
        detalle: `Catálogo OpenAPI no disponible para comprobar firma.`,
      });
      continue;
    }

    const inspection = inspectRpcInOpenApi(paths, r.name, r.expectedParams);
    if (inspection.existsInCatalog && inspection.signatureMatch) {
      items.push({
        fase: 'BASE_PREEXISTENTE',
        categoria: 'RPC Base',
        elemento: r.name,
        estado: 'OK_PREEXISTENTE',
        detalle: `${r.desc}. ${inspection.catalogDetail}`,
      });
    } else if (inspection.existsInCatalog && !inspection.signatureMatch) {
      items.push({
        fase: 'BASE_PREEXISTENTE',
        categoria: 'RPC Base',
        elemento: r.name,
        estado: 'FAILED',
        detalle: `${r.desc}. ${inspection.catalogDetail}`,
      });
    } else {
      items.push({
        fase: 'BASE_PREEXISTENTE',
        categoria: 'RPC Base',
        elemento: r.name,
        estado: 'FAILED',
        detalle: `RPC base preexistente ${r.name} no figura en catálogo de PostgREST.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Verificación de Estructuras NUEVAS 2B-1 (Pre-migración vs Post-migración)
  // -------------------------------------------------------------------------
  console.log('\nPaso 3: Verificando estructuras nuevas del Mini-Sprint 2B-1...');

  // 3.1 Tabla domain_migration_settings
  const hasSettingsInPaths = '/domain_migration_settings' in paths;
  const { error: settingsHeadErr } = await adminClient
    .from('domain_migration_settings')
    .select('setting_key', { head: true, count: 'exact' });

  if (!settingsHeadErr || hasSettingsInPaths) {
    items.push({
      fase: 'NUEVO_2B1',
      categoria: 'Tabla Nueva',
      elemento: 'domain_migration_settings',
      estado: 'OK_MIGRADO',
      detalle: 'Tabla de configuración de migración desplegada y accesible.',
    });
  } else if (settingsHeadErr?.code === '42P01' || settingsHeadErr?.message.includes('does not exist')) {
    items.push({
      fase: 'NUEVO_2B1',
      categoria: 'Tabla Nueva',
      elemento: 'domain_migration_settings',
      estado: 'PENDIENTE_MIGRACION',
      detalle: 'Tabla no existe aún en Staging (código 42P01, esperado antes de migración 2B-1).',
    });
  } else {
    items.push({
      fase: 'NUEVO_2B1',
      categoria: 'Tabla Nueva',
      elemento: 'domain_migration_settings',
      estado: 'NO_VERIFICABLE',
      detalle: `Estado ambiguo de tabla: ${settingsHeadErr?.message || 'sin datos de catálogo'}`,
    });
  }

  // 3.2 Columnas Nuevas de 2B-1 en anonymous_transfer_tickets
  // Corrección 1: flow_mode e intended_target_user_id (revoked_at NO es columna, se maneja por status)
  const ticketProps = definitions.anonymous_transfer_tickets?.properties || {};
  const bridgeCols2B1 = ['flow_mode', 'intended_target_user_id'];
  const hasBridgeCols = bridgeCols2B1.every((c) => c in ticketProps);

  if (hasBridgeCols) {
    items.push({
      fase: 'NUEVO_2B1',
      categoria: 'Columnas 2B-1',
      elemento: 'anonymous_transfer_tickets (flow_mode, intended_target_user_id)',
      estado: 'OK_MIGRADO',
      detalle: `Columnas nuevas de 2B-1 presentes en catálogo OpenAPI.`,
    });
  } else {
    // Comprobar con HEAD si existen en PostgreSQL
    const { error: colHeadErr } = await adminClient
      .from('anonymous_transfer_tickets')
      .select('flow_mode, intended_target_user_id', { head: true });

    if (!colHeadErr) {
      items.push({
        fase: 'NUEVO_2B1',
        categoria: 'Columnas 2B-1',
        elemento: 'anonymous_transfer_tickets (flow_mode, intended_target_user_id)',
        estado: 'OK_MIGRADO',
        detalle: `Columnas nuevas verificadas vía SELECT HEAD de service_role.`,
      });
    } else if (colHeadErr.code === '42703' || colHeadErr.message.includes('column') || colHeadErr.message.includes('does not exist')) {
      items.push({
        fase: 'NUEVO_2B1',
        categoria: 'Columnas 2B-1',
        elemento: 'anonymous_transfer_tickets (flow_mode, intended_target_user_id)',
        estado: 'PENDIENTE_MIGRACION',
        detalle: `Columnas aún no creadas en tickets (esperado antes de aplicar migración 2B-1).`,
      });
    } else {
      items.push({
        fase: 'NUEVO_2B1',
        categoria: 'Columnas 2B-1',
        elemento: 'anonymous_transfer_tickets (flow_mode, intended_target_user_id)',
        estado: 'NO_VERIFICABLE',
        detalle: `Error al comprobar columnas: ${colHeadErr.message}`,
      });
    }
  }

  // 3.3 RPCs Nuevas de 2B-1 (Inspección estricta de firma en OpenAPI, CERO llamadas mutantes)
  const newRpcs2B1 = [
    {
      name: 'create_domain_migration_ticket_seguro',
      expectedParams: ['p_flow_mode', 'p_intended_target_user_id'],
      desc: 'Emisión con flow_mode y target snapshot',
    },
    {
      name: 'claim_domain_migration_ticket_seguro',
      expectedParams: ['p_ticket_token'],
      desc: 'Canje de puente con target snapshot',
    },
    {
      name: 'confirmar_migracion_dominio_completada_seguro',
      expectedParams: ['p_ticket_token'],
      desc: 'Confirmación idempotente post-commit',
    },
    {
      name: 'vincular_tokens_participante_lote_seguro',
      expectedParams: ['p_tokens'],
      desc: 'Rescate de tokens huérfanos',
    },
    {
      name: 'set_domain_migration_setting',
      expectedParams: ['p_key', 'p_value'],
      desc: 'Control administrativo de Kill Switch',
    },
    {
      name: 'is_cross_origin_migration_enabled',
      expectedParams: ['p_flow_mode'],
      desc: 'Consulta server-side del Kill Switch',
    },
  ];

  for (const r of newRpcs2B1) {
    if (!openApi) {
      items.push({
        fase: 'NUEVO_2B1',
        categoria: 'RPC Nueva 2B-1',
        elemento: r.name,
        estado: 'NO_VERIFICABLE',
        detalle: `Catálogo OpenAPI no disponible para comprobar firma.`,
      });
      continue;
    }

    const inspection = inspectRpcInOpenApi(paths, r.name, r.expectedParams);
    if (inspection.existsInCatalog && inspection.signatureMatch) {
      items.push({
        fase: 'NUEVO_2B1',
        categoria: 'RPC Nueva 2B-1',
        elemento: r.name,
        estado: 'OK_MIGRADO',
        detalle: `${r.desc}. ${inspection.catalogDetail}`,
      });
    } else if (inspection.existsInCatalog && !inspection.signatureMatch) {
      items.push({
        fase: 'NUEVO_2B1',
        categoria: 'RPC Nueva 2B-1',
        elemento: r.name,
        estado: 'FAILED',
        detalle: `Discrepancia en RPC 2B-1: ${inspection.catalogDetail}`,
      });
    } else {
      // La RPC no figura en el catálogo OpenAPI.
      // Si la tabla domain_migration_settings está PENDIENTE_MIGRACION, es consistente que las RPCs de 2B-1 estén pendientes.
      const settingsPending = items.some((it) => it.elemento === 'domain_migration_settings' && it.estado === 'PENDIENTE_MIGRACION');
      items.push({
        fase: 'NUEVO_2B1',
        categoria: 'RPC Nueva 2B-1',
        elemento: r.name,
        estado: settingsPending ? 'PENDIENTE_MIGRACION' : 'NO_VERIFICABLE',
        detalle: settingsPending
          ? `No catalogada en OpenAPI (esperado antes de aplicar migración 2B-1).`
          : `Ausente en catálogo pero estado de migración ambiguo.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Verificación de Seguridad RLS de Clientes Anónimos
  // -------------------------------------------------------------------------
  console.log('\nPaso 4: Verificando aislamiento de permisos RLS para anonClient...');

  const rlsTargetTables = ['domain_migration_settings', 'anonymous_transfer_tickets'];

  for (const tableName of rlsTargetTables) {
    // Si la tabla aún no existe, registrar como PENDIENTE_MIGRACION
    const isTableMissing = items.some((it) => it.elemento === tableName && it.estado === 'PENDIENTE_MIGRACION');
    if (isTableMissing) {
      items.push({
        fase: 'SEGURIDAD_RLS',
        categoria: 'Permisos anon',
        elemento: tableName,
        estado: 'PENDIENTE_MIGRACION',
        detalle: `Tabla no existe aún. La validación RLS se ejecutará tras la migración.`,
      });
      continue;
    }

    // Consulta de solo lectura con limit(1) desde cliente anónimo
    const { data: anonData, error: anonErr } = await anonClient.from(tableName).select('*').limit(1);

    if (anonErr) {
      if (anonErr.code === '42501' || anonErr.message.includes('permission denied') || anonErr.message.includes('violates row-level security')) {
        items.push({
          fase: 'SEGURIDAD_RLS',
          categoria: 'Permisos anon',
          elemento: tableName,
          estado: 'PROTECTED_RLS',
          detalle: `Acceso anónimo formalmente denegado por RLS / SQL GRANT (${anonErr.message}).`,
        });
      } else {
        items.push({
          fase: 'SEGURIDAD_RLS',
          categoria: 'Permisos anon',
          elemento: tableName,
          estado: 'WARNING',
          detalle: `Error inesperado en consulta anónima: ${anonErr.message} (${anonErr.code})`,
        });
      }
    } else if (anonData && anonData.length > 0) {
      items.push({
        fase: 'SEGURIDAD_RLS',
        categoria: 'Permisos anon',
        elemento: tableName,
        estado: 'FAILED',
        detalle: `CRÍTICO: Acceso anónimo permitió leer ${anonData.length} fila(s) de datos protegidos.`,
      });
    } else {
      // 0 filas devueltas sin error: advertir que tabla vacía NO certifica RLS por sí sola
      items.push({
        fase: 'SEGURIDAD_RLS',
        categoria: 'Permisos anon',
        elemento: tableName,
        estado: 'INDETERMINATE_EMPTY',
        detalle: `Devolvió 0 filas pero sin error explícito de denegación. No certifica RLS con tabla vacía.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. Verificación de Kill Switch (Solo Lectura, CERO Mutaciones)
  // -------------------------------------------------------------------------
  console.log('\nPaso 5: Inspeccionando estado del Kill Switch (sin mutar)...');

  const settingsTableStatus = items.find((it) => it.elemento === 'domain_migration_settings')?.estado;

  if (settingsTableStatus === 'OK_MIGRADO') {
    const { data: ksRow, error: ksErr } = await adminClient
      .from('domain_migration_settings')
      .select('setting_key, setting_value')
      .eq('setting_key', 'cross_origin_bridge_enabled')
      .maybeSingle();

    if (ksErr) {
      items.push({
        fase: 'KILL_SWITCH',
        categoria: 'Configuración Servidor',
        elemento: 'cross_origin_bridge_enabled',
        estado: 'FAILED',
        detalle: `Error leyendo setting: ${ksErr.message}`,
      });
    } else if (!ksRow) {
      items.push({
        fase: 'KILL_SWITCH',
        categoria: 'Configuración Servidor',
        elemento: 'cross_origin_bridge_enabled',
        estado: 'WARNING',
        detalle: 'Clave no sembrada aún en la tabla de configuración.',
      });
    } else {
      const isEnabled = ksRow.setting_value === true;
      items.push({
        fase: 'KILL_SWITCH',
        categoria: 'Configuración Servidor',
        elemento: 'cross_origin_bridge_enabled',
        estado: isEnabled ? 'WARNING' : 'OK_MIGRADO',
        detalle: isEnabled
          ? 'ALERTA: El kill switch figura ACTIVO (debe estar false por defecto).'
          : 'CONFIRMADO: Kill switch apagado por defecto (false). Puente contenido.',
      });
    }
  } else {
    items.push({
      fase: 'KILL_SWITCH',
      categoria: 'Configuración Servidor',
      elemento: 'cross_origin_bridge_enabled',
      estado: 'PENDIENTE_MIGRACION',
      detalle: 'Tabla de settings ausente. El kill switch se sembrará en la migración 2B-1.',
    });
  }

  // -------------------------------------------------------------------------
  // 6. Diagnóstico y Clasificación Final
  // -------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('INFORME CONSOLIDADO DE PREFLIGHT (STAGING)');
  console.log('================================================================================');
  console.table(
    items.map((it) => ({
      Fase: it.fase,
      Categoría: it.categoria,
      Elemento: it.elemento,
      Estado: it.estado,
      Detalle: it.detalle.length > 55 ? it.detalle.slice(0, 52) + '...' : it.detalle,
    }))
  );

  const pendingCount = items.filter((it) => it.estado === 'PENDIENTE_MIGRACION').length;
  const failedCount = items.filter((it) => it.estado === 'FAILED').length;
  const warningCount = items.filter((it) => it.estado === 'WARNING').length;
  const indeterminateCount = items.filter((it) => it.estado === 'INDETERMINATE_EMPTY').length;
  const noVerificableCount = items.filter((it) => it.estado === 'NO_VERIFICABLE').length;

  const baseOkCount = items.filter((it) => it.estado === 'OK_PREEXISTENTE').length;
  const newOkCount = items.filter((it) => it.estado === 'OK_MIGRADO' || it.estado === 'PROTECTED_RLS').length;

  // Criterio estricto de aprobación: FAILED, WARNING, INDETERMINATE_EMPTY y NO_VERIFICABLE impiden aprobación
  const hasBlockers = failedCount > 0 || warningCount > 0 || indeterminateCount > 0 || noVerificableCount > 0;

  const isPreMigration = !hasBlockers && pendingCount > 0;
  const isPostMigration = !hasBlockers && pendingCount === 0;
  const success = !hasBlockers;

  console.log('\n--------------------------------------------------------------------------------');
  console.log(`Evaluación de Diagnóstico:`);
  console.log(`  - Estructuras base preexistentes OK: ${baseOkCount}`);
  console.log(`  - Estructuras nuevas 2B-1 migradas:   ${newOkCount}`);
  console.log(`  - Estructuras pendientes migración:  ${pendingCount}`);
  console.log(`  - Bloqueos / Errores críticos (FAILED):     ${failedCount}`);
  console.log(`  - Alertas operativas (WARNING):             ${warningCount}`);
  console.log(`  - RLS indeterminado por tabla vacía:        ${indeterminateCount}`);
  console.log(`  - No verificables por catálogo ambiguo:     ${noVerificableCount}`);
  console.log('--------------------------------------------------------------------------------');
  console.log('GARANTÍA DE SEGURIDAD: CERO mutaciones SQL, CERO llamadas RPC ejecutadas.');
  console.log('================================================================================\n');

  if (hasBlockers) {
    console.error('================================================================================');
    console.error('ESTADO STAGING: [PREFLIGHT BLOQUEADO]');
    console.error('  Se detectaron elementos que impiden la aprobación automática:');
    if (failedCount > 0) console.error(`   - ${failedCount} fallo(s) crítico(s) (FAILED).`);
    if (warningCount > 0) console.error(`   - ${warningCount} advertencia(s) operativa(s) (WARNING).`);
    if (indeterminateCount > 0) console.error(`   - ${indeterminateCount} verificación(es) RLS indeterminada(s) por tabla vacía.`);
    if (noVerificableCount > 0) console.error(`   - ${noVerificableCount} elemento(s) no verificable(s) en catálogo.`);
    console.error('================================================================================');
    return { success: false, isPreMigration, isPostMigration, items };
  }

  if (isPreMigration) {
    console.log('================================================================================');
    console.log('ESTADO STAGING: [DIAGNÓSTICO PRE-MIGRACIÓN SATISFACTORIO]');
    console.log('  1. Todas las estructuras y tablas base preexistentes están 100% operativas.');
    console.log('  2. Las firmas de crear_encuentro_seguro, publicar_mensaje y revoke están comprobadas.');
    console.log('  3. Las estructuras nuevas de 2B-1 están correctamente catalogadas como pendientes.');
    console.log('  4. El entorno está listo y limpio para autorizar la aplicación de la migración:');
    console.log('     supabase/migrations/20261107120000_domain_identity_bridge_v1.sql');
    console.log('================================================================================');
  } else if (isPostMigration) {
    console.log('================================================================================');
    console.log('ESTADO STAGING: [DIAGNÓSTICO POST-MIGRACIÓN SATISFACTORIO]');
    console.log('  1. Todas las tablas, columnas, RPCs y políticas de 2B-1 están desplegadas.');
    console.log('  2. Todas las firmas de RPCs 2B-1 están verificadas en OpenAPI.');
    console.log('  3. El Kill Switch está verificado y apagado (false).');
    console.log('  4. El entorno está listo para autorizar el runner de concurrencia controlado.');
    console.log('================================================================================');
  }

  return { success: true, isPreMigration, isPostMigration, items };
}

// Ejecutar preflight si se invoca directamente desde CLI
const isDirectRun = process.argv[1]?.endsWith('staging-preflight-domain-bridge.ts');
if (isDirectRun) {
  runReadOnlyPreflight()
    .then((res) => {
      if (!res.success) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[CRITICAL PREFLIGHT ERROR]', err);
      process.exit(1);
    });
}
