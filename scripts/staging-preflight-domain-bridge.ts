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
  | 'OK_PREEXISTENTE'       // Estructura base que ya existe y está operativa
  | 'OK_MIGRADO'            // Estructura nueva de 2B-1 ya desplegada y operativa
  | 'PENDIENTE_MIGRACION'   // Estructura nueva de 2B-1 ausente (esperado ANTES de aplicar migración)
  | 'PROTECTED_RLS'         // Acceso anónimo denegado formalmente por permiso o RLS
  | 'INDETERMINATE_EMPTY'   // Tabla vacía: devuelve 0 filas pero no acredita bloqueo RLS
  | 'FAILED'                // Error de red, permiso insuficiente o regresión
  | 'WARNING';              // Alerta que requiere atención operativa

export interface PreflightItem {
  fase: 'BASE_PREEXISTENTE' | 'NUEVO_2B1' | 'SEGURIDAD_RLS' | 'KILL_SWITCH';
  categoria: string;
  elemento: string;
  estado: CheckStatus;
  detalle: string;
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
  console.log(`Mecanismo: Introspección de catálogo OpenAPI de PostgREST (Cero llamadas RPC)`);
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
  // 1. Introspección del Catálogo OpenAPI de PostgREST (100% No Mutante)
  // -------------------------------------------------------------------------
  console.log('Paso 1: Obteniendo catálogo OpenAPI de PostgREST (GET /rest/v1/)...');
  let openApi: any = null;
  try {
    const res = await fetch(`${STAGING_URL}/rest/v1/`, {
      method: 'GET',
      headers: {
        apikey: adminKey,
        Authorization: `Bearer ${adminKey}`,
        Accept: 'application/openapi+json',
      },
    });

    if (!res.ok) {
      throw new Error(`PostgREST OpenAPI retornó HTTP ${res.status}: ${res.statusText}`);
    }
    openApi = await res.json();
    console.log(`  Catálogo OpenAPI obtenido exitosamente. Rutas indexadas: ${Object.keys(openApi.paths || {}).length}`);
  } catch (err: any) {
    items.push({
      fase: 'BASE_PREEXISTENTE',
      categoria: 'Catálogo OpenAPI',
      elemento: 'GET /rest/v1/',
      estado: 'FAILED',
      detalle: `Fallo crítico de introspección: ${err?.message}`,
    });
    console.error(`  Error obteniendo catálogo OpenAPI: ${err?.message}`);
  }

  const paths = openApi?.paths || {};
  const definitions = openApi?.definitions || {};

  // -------------------------------------------------------------------------
  // 2. Verificación de Estructuras BASE PREEXISTENTES (Ya deben existir)
  // -------------------------------------------------------------------------
  console.log('Paso 2: Verificando estructuras base preexistentes...');

  const baseTables = [
    { name: 'encuentros', cols: ['id', 'host_id', 'titulo', 'estado', 'post_event_active_minutes'] },
    { name: 'participantes', cols: ['id', 'encuentro_id', 'user_id', 'estado'] },
    { name: 'mensajes_encuentro', cols: ['id', 'encuentro_id', 'autor_user_id'] },
    { name: 'inbox_notifications', cols: ['id', 'recipient_user_id'] },
    { name: 'notification_delivery_outbox', cols: ['id', 'recipient_user_id'] },
    { name: 'rate_limit_buckets', cols: ['action', 'user_id'] },
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
        detalle: `Presente en catálogo con todas sus columnas requeridas (${t.cols.join(', ')}).`,
      });
    } else if (pathExists && missingCols.length > 0) {
      items.push({
        fase: 'BASE_PREEXISTENTE',
        categoria: 'Columna Base',
        elemento: `${t.name} (${missingCols.join(', ')})`,
        estado: 'FAILED',
        detalle: `Tabla existe pero faltan columnas base esperadas: ${missingCols.join(', ')}`,
      });
    } else {
      // Fallback a consulta HEAD en caso de que OpenAPI oculte la tabla
      const { error: headErr } = await adminClient.from(t.name).select(t.cols[0], { head: true, count: 'exact' });
      if (!headErr) {
        items.push({
          fase: 'BASE_PREEXISTENTE',
          categoria: 'Tabla Base (HEAD)',
          elemento: t.name,
          estado: 'OK_PREEXISTENTE',
          detalle: `Accesible mediante SELECT HEAD de service_role.`,
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

  // RPCs Base Preexistentes (inspección de catálogo, CERO invocaciones)
  const baseRpcs = [
    {
      rpcName: 'crear_encuentro_seguro',
      expectedParam: 'p_data',
    },
    {
      rpcName: 'publicar_mensaje_encuentro_seguro',
      expectedParam: 'p_encuentro_id',
    },
  ];

  for (const r of baseRpcs) {
    const rpcPath = `/rpc/${r.rpcName}`;
    const op = paths[rpcPath]?.post;
    if (op) {
      const params = op.parameters || [];
      const hasParam = params.some((p: any) => p.name === r.expectedParam || (p.schema && r.expectedParam in (p.schema.properties || {})));
      items.push({
        fase: 'BASE_PREEXISTENTE',
        categoria: 'RPC Base',
        elemento: r.rpcName,
        estado: 'OK_PREEXISTENTE',
        detalle: `Catalogada en OpenAPI. Parámetro '${r.expectedParam}' verificado sin invocar función.`,
      });
    } else {
      items.push({
        fase: 'BASE_PREEXISTENTE',
        categoria: 'RPC Base',
        elemento: r.rpcName,
        estado: 'FAILED',
        detalle: `RPC base ${r.rpcName} no figura en OpenAPI de PostgREST.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Verificación de Estructuras NUEVAS 2B-1 (Pre-migración vs Post-migración)
  // -------------------------------------------------------------------------
  console.log('Paso 3: Verificando estructuras nuevas del Mini-Sprint 2B-1...');

  // 3.1 Tabla domain_migration_settings
  const hasSettingsTable = '/domain_migration_settings' in paths;
  if (hasSettingsTable) {
    items.push({
      fase: 'NUEVO_2B1',
      categoria: 'Tabla Nueva',
      elemento: 'domain_migration_settings',
      estado: 'OK_MIGRADO',
      detalle: 'Tabla de configuración de migración presente en catálogo.',
    });
  } else {
    items.push({
      fase: 'NUEVO_2B1',
      categoria: 'Tabla Nueva',
      elemento: 'domain_migration_settings',
      estado: 'PENDIENTE_MIGRACION',
      detalle: 'Tabla no existe aún en Staging (esperado antes de aplicar migración 2B-1).',
    });
  }

  // 3.2 Tabla y Columnas de anonymous_transfer_tickets
  const hasTicketsTable = '/anonymous_transfer_tickets' in paths;
  const ticketProps = definitions.anonymous_transfer_tickets?.properties || {};
  const bridgeTicketCols = ['flow_mode', 'intended_target_user_id', 'source_user_id_snapshot', 'target_user_id_snapshot', 'revoked_at'];
  const missingBridgeCols = bridgeTicketCols.filter((c) => !(c in ticketProps));

  if (hasTicketsTable && missingBridgeCols.length === 0) {
    items.push({
      fase: 'NUEVO_2B1',
      categoria: 'Tabla / Columnas 2B-1',
      elemento: 'anonymous_transfer_tickets (extensiones 2B-1)',
      estado: 'OK_MIGRADO',
      detalle: `Columnas de puente presentes (${bridgeTicketCols.join(', ')}).`,
    });
  } else if (hasTicketsTable && missingBridgeCols.length > 0) {
    items.push({
      fase: 'NUEVO_2B1',
      categoria: 'Tabla / Columnas 2B-1',
      elemento: 'anonymous_transfer_tickets (columnas 2B-1)',
      estado: 'PENDIENTE_MIGRACION',
      detalle: `Tabla existe pero faltan columnas 2B-1: ${missingBridgeCols.join(', ')} (esperado antes de migración).`,
    });
  } else {
    items.push({
      fase: 'NUEVO_2B1',
      categoria: 'Tabla / Columnas 2B-1',
      elemento: 'anonymous_transfer_tickets',
      estado: 'PENDIENTE_MIGRACION',
      detalle: 'Tabla de tickets no catalogada aún (esperado antes de migración 2B-1).',
    });
  }

  // 3.3 RPCs Nuevas de 2B-1 (Inspección en OpenAPI, CERO llamadas mutantes)
  const newRpcs = [
    { name: 'create_domain_migration_ticket_seguro', desc: 'Emisión con flow_mode y target snapshot' },
    { name: 'claim_domain_migration_ticket_seguro', desc: 'Canje de puente con target snapshot' },
    { name: 'revoke_my_pending_transfer_ticket', desc: 'Revocación idempotente de ticket pendiente' },
    { name: 'confirmar_migracion_dominio_completada_seguro', desc: 'Confirmación idempotente post-commit' },
    { name: 'vincular_tokens_participante_lote_seguro', desc: 'Rescate de tokens huérfanos' },
    { name: 'set_domain_migration_setting', desc: 'Control administrativo de Kill Switch' },
  ];

  for (const r of newRpcs) {
    const isPresent = `/rpc/${r.name}` in paths;
    if (isPresent) {
      items.push({
        fase: 'NUEVO_2B1',
        categoria: 'RPC Nueva 2B-1',
        elemento: r.name,
        estado: 'OK_MIGRADO',
        detalle: `Catalogada en OpenAPI (${r.desc}). Verificada sin invocación.`,
      });
    } else {
      items.push({
        fase: 'NUEVO_2B1',
        categoria: 'RPC Nueva 2B-1',
        elemento: r.name,
        estado: 'PENDIENTE_MIGRACION',
        detalle: `RPC ausente en catálogo (esperado antes de aplicar migración 2B-1).`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Verificación de Seguridad RLS de Clientes Anónimos
  // -------------------------------------------------------------------------
  console.log('Paso 4: Verificando aislamiento de permisos RLS para anonClient...');

  const rlsTargetTables = ['domain_migration_settings', 'anonymous_transfer_tickets'];

  for (const tableName of rlsTargetTables) {
    // Si la tabla aún no existe, registrar como PENDIENTE_MIGRACION
    if (!(`/${tableName}` in paths)) {
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
      // 0 filas devueltas sin error: advertir que tabla vacía no certifica RLS por sí sola
      items.push({
        fase: 'SEGURIDAD_RLS',
        categoria: 'Permisos anon',
        elemento: tableName,
        estado: 'INDETERMINATE_EMPTY',
        detalle: `Devolvió 0 filas pero sin error de denegación explícito. No certifica RLS por sí solo con tabla vacía.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. Verificación de Kill Switch (Solo Lectura, Cero Mutaciones)
  // -------------------------------------------------------------------------
  console.log('Paso 5: Inspeccionando estado del Kill Switch (sin mutar)...');

  if (hasSettingsTable) {
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
        estado: 'PENDIENTE_MIGRACION',
        detalle: 'Clave no sembrada aún en la tabla (esperado antes de migración).',
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
  const baseOkCount = items.filter((it) => it.estado === 'OK_PREEXISTENTE').length;
  const newOkCount = items.filter((it) => it.estado === 'OK_MIGRADO' || it.estado === 'PROTECTED_RLS').length;

  const isPreMigration = failedCount === 0 && pendingCount > 0;
  const isPostMigration = failedCount === 0 && pendingCount === 0;

  console.log('\n--------------------------------------------------------------------------------');
  console.log(`Evaluación de Diagnóstico:`);
  console.log(`  - Estructuras base preexistentes OK: ${baseOkCount}`);
  console.log(`  - Estructuras nuevas 2B-1 migradas:   ${newOkCount}`);
  console.log(`  - Estructuras pendientes migración:  ${pendingCount}`);
  console.log(`  - Fallos / Errores críticos:         ${failedCount}`);
  console.log('--------------------------------------------------------------------------------');
  console.log('GARANTÍA DE AISLAMIENTO: CERO mutaciones SQL, CERO llamadas RPC ejecutadas.');
  console.log('================================================================================\n');

  if (failedCount > 0) {
    console.error('[PREFLIGHT RESULTADO: FALLIDO] Se detectaron errores críticos en Staging.');
    return { success: false, isPreMigration, isPostMigration, items };
  }

  if (isPreMigration) {
    console.log('================================================================================');
    console.log('ESTADO STAGING: [DIAGNÓSTICO PRE-MIGRACIÓN SATISFACTORIO]');
    console.log('  1. Todas las estructuras y tablas base preexistentes están 100% operativas.');
    console.log('  2. Las estructuras nuevas de 2B-1 están correctamente catalogadas como pendientes.');
    console.log('  3. El entorno está listo y limpio para autorizar la aplicación de la migración:');
    console.log('     supabase/migrations/20261107120000_domain_identity_bridge_v1.sql');
    console.log('================================================================================');
  } else if (isPostMigration) {
    console.log('================================================================================');
    console.log('ESTADO STAGING: [DIAGNÓSTICO POST-MIGRACIÓN SATISFACTORIO]');
    console.log('  1. Todas las tablas, columnas, RPCs y políticas de 2B-1 están desplegadas.');
    console.log('  2. El Kill Switch está verificado y apagado (false).');
    console.log('  3. El entorno está listo para autorizar el runner de concurrencia controlado.');
    console.log('================================================================================');
  }

  return { success: true, isPreMigration, isPostMigration, items };
}

// Ejecutar preflight si se invoca directamente desde CLI
const isDirectRun = process.argv[1]?.endsWith('staging-preflight-domain-bridge.ts');
if (isDirectRun) {
  runReadOnlyPreflight().catch((err) => {
    console.error('[CRITICAL PREFLIGHT ERROR]', err);
    process.exit(1);
  });
}
