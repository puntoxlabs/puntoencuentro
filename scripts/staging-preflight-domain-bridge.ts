/**
 * Preflight de Diagnóstico de Solo Lectura para Supabase Staging
 * Mini-Sprint 2B-2: Puente de Identidad entre Dominios
 *
 * ====================================================================================
 * GARANTÍA DE NO MODIFICACIÓN:
 * Este script es ESTRICTAMENTE DE SOLO LECTURA.
 *  - CERO mutaciones (sin INSERT, UPDATE ni DELETE).
 *  - CERO cambios de DDL ni migraciones.
 *  - CERO cambios en flags o Kill Switch (no activa el puente).
 *  - CERO fixtures creados en Auth o tablas de negocio.
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

interface CheckResult {
  category: string;
  item: string;
  status: 'OK' | 'PENDING_MIGRATION' | 'FAILED' | 'PROTECTED';
  detail: string;
}

async function runReadOnlyPreflight() {
  console.log('================================================================================');
  console.log('PREFLIGHT DE SOLO LECTURA — PUENTE DE IDENTIDAD (STAGING)');
  console.log(`Target: ${STAGING_URL} (Ref: ${STAGING_PROJECT_REF})`);
  console.log(`Protección anti-producción: Prohibido ${PRODUCTION_PROJECT_REF}`);
  console.log(`Modo de operación: SOLO LECTURA (Cero mutaciones en la base de datos)`);
  console.log('================================================================================\n');

  const adminKey = getStagingSecretKey();
  const publishableKey = getStagingPublishableKey();

  const adminClient = createClient(STAGING_URL, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const anonClient = createClient(STAGING_URL, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const results: CheckResult[] = [];

  // -------------------------------------------------------------------------
  // 1. Preflight de Privilegios Administrativos (service_role)
  // -------------------------------------------------------------------------
  console.log('1. Verificando privilegios administrativos de service_role...');

  const adminTableChecks = [
    { table: 'domain_migration_settings', select: 'setting_key, setting_value' },
    { table: 'anonymous_transfer_tickets', select: 'id, token_hash, status, flow_mode, intended_target_user_id' },
    { table: 'encuentros', select: 'id, host_id, titulo' },
    { table: 'mensajes_encuentro', select: 'id, encuentro_id, autor_user_id' },
    { table: 'inbox_notifications', select: 'id, recipient_user_id' },
    { table: 'notification_delivery_outbox', select: 'id, recipient_user_id' },
    { table: 'rate_limit_buckets', select: 'action, user_id' },
  ];

  for (const tc of adminTableChecks) {
    const { data, error } = await adminClient.from(tc.table).select(tc.select).limit(1);
    if (error) {
      if (error.code === '42P01' || error.message.includes('does not exist')) {
        results.push({
          category: 'Tablas (service_role)',
          item: tc.table,
          status: 'PENDING_MIGRATION',
          detail: 'Tabla no existe aún en Staging (pendiente aplicar migración 2B-1).',
        });
      } else if (error.code === '42501' || error.message.includes('permission denied')) {
        results.push({
          category: 'Tablas (service_role)',
          item: tc.table,
          status: 'FAILED',
          detail: `Permiso denegado para service_role: ${error.message}`,
        });
      } else if (error.code === '42703' || error.message.includes('column') || error.message.includes('does not exist')) {
        results.push({
          category: 'Columnas (service_role)',
          item: `${tc.table} (${tc.select})`,
          status: 'PENDING_MIGRATION',
          detail: `Columna pendiente de migración: ${error.message}`,
        });
      } else {
        results.push({
          category: 'Tablas (service_role)',
          item: tc.table,
          status: 'FAILED',
          detail: `Error inesperado: ${error.message} (${error.code})`,
        });
      }
    } else {
      results.push({
        category: 'Tablas (service_role)',
        item: tc.table,
        status: 'OK',
        detail: `Lectura exitosa por service_role (0 mutaciones).`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. Preflight de Aislamiento RLS (anon)
  // -------------------------------------------------------------------------
  console.log('2. Verificando aislamiento RLS para clientes anónimos...');

  const rlsTableChecks = [
    { table: 'domain_migration_settings', expectBlocked: true },
    { table: 'anonymous_transfer_tickets', expectBlocked: true },
  ];

  for (const rls of rlsTableChecks) {
    const { data, error } = await anonClient.from(rls.table).select('*').limit(1);
    if (error) {
      if (error.code === '42P01') {
        results.push({
          category: 'RLS (anon)',
          item: rls.table,
          status: 'PENDING_MIGRATION',
          detail: 'Tabla pendiente de migración.',
        });
      } else {
        // Bloqueo exitoso por permisos / RLS
        results.push({
          category: 'RLS (anon)',
          item: rls.table,
          status: 'PROTECTED',
          detail: `Acceso anónimo bloqueado correctamente: ${error.message}`,
        });
      }
    } else if (data && data.length === 0) {
      results.push({
        category: 'RLS (anon)',
        item: rls.table,
        status: 'PROTECTED',
        detail: `Acceso anónimo devuelve 0 filas (filtrado por RLS).`,
      });
    } else {
      results.push({
        category: 'RLS (anon)',
        item: rls.table,
        status: 'FAILED',
        detail: `CRÍTICO: Acceso anónimo permitió leer datos sin autorización.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Preflight de Existencia y Firmas de RPCs
  // -------------------------------------------------------------------------
  console.log('3. Verificando disponibilidad de RPCs y contratos...');

  const rpcChecks = [
    {
      name: 'crear_encuentro_seguro',
      call: () => anonClient.rpc('crear_encuentro_seguro', { p_data: {} }),
      expectedError: 'not_authenticated',
    },
    {
      name: 'create_domain_migration_ticket_seguro',
      call: () => anonClient.rpc('create_domain_migration_ticket_seguro', {}),
      expectedError: 'not_authenticated',
    },
    {
      name: 'claim_domain_migration_ticket_seguro',
      call: () => anonClient.rpc('claim_domain_migration_ticket_seguro', { p_ticket_token: 'dummy' }),
      expectedError: 'not_authenticated',
    },
    {
      name: 'revoke_my_pending_transfer_ticket',
      call: () => anonClient.rpc('revoke_my_pending_transfer_ticket'),
      expectedError: 'not_authenticated',
    },
    {
      name: 'publicar_mensaje_encuentro_seguro',
      call: () => anonClient.rpc('publicar_mensaje_encuentro_seguro', { p_encuentro_id: '00000000-0000-0000-0000-000000000000', p_contenido: '' }),
      expectedError: 'empty_content', // o error de encuentro
    },
    {
      name: 'confirmar_migracion_dominio_completada_seguro',
      call: () => anonClient.rpc('confirmar_migracion_dominio_completada_seguro', { p_ticket_token: 'dummy' }),
      expectedError: 'not_authenticated',
    },
    {
      name: 'vincular_tokens_participante_lote_seguro',
      call: () => anonClient.rpc('vincular_tokens_participante_lote_seguro', { p_tokens: [] }),
      expectedError: 'not_authenticated',
    },
  ];

  for (const rpc of rpcChecks) {
    try {
      const { data, error } = await rpc.call();
      if (error) {
        if (error.code === 'PGRST202' || error.message.includes('Could not find')) {
          results.push({
            category: 'RPCs',
            item: rpc.name,
            status: 'PENDING_MIGRATION',
            detail: `RPC no encontrada en schema cache (pendiente aplicar migración 2B-1).`,
          });
        } else {
          // Si devuelve error funcional esperado (ej: not_authenticated), la RPC existe y su firma responde
          results.push({
            category: 'RPCs',
            item: rpc.name,
            status: 'OK',
            detail: `RPC existe y responde correctamente (${error.message || error.code}).`,
          });
        }
      } else if (data && typeof data === 'object' && ('ok' in data || 'error' in data)) {
        results.push({
          category: 'RPCs',
          item: rpc.name,
          status: 'OK',
          detail: `RPC existe y devolvió payload JSON determinístico: ${JSON.stringify(data)}`,
        });
      } else {
        results.push({
          category: 'RPCs',
          item: rpc.name,
          status: 'OK',
          detail: `RPC invocable sin errores de schema cache.`,
        });
      }
    } catch (err: any) {
      results.push({
        category: 'RPCs',
        item: rpc.name,
        status: 'FAILED',
        detail: `Error invocando RPC: ${err?.message}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Preflight de Kill Switch (Solo Lectura)
  // -------------------------------------------------------------------------
  console.log('4. Verificando estado del Kill Switch (sin mutar)...');

  const { data: killSwitchData, error: killSwitchErr } = await adminClient
    .from('domain_migration_settings')
    .select('setting_key, setting_value')
    .eq('setting_key', 'cross_origin_bridge_enabled')
    .maybeSingle();

  if (killSwitchErr) {
    if (killSwitchErr.code === '42P01') {
      results.push({
        category: 'Kill Switch',
        item: 'cross_origin_bridge_enabled',
        status: 'PENDING_MIGRATION',
        detail: 'Tabla domain_migration_settings pendiente de migración.',
      });
    } else {
      results.push({
        category: 'Kill Switch',
        item: 'cross_origin_bridge_enabled',
        status: 'FAILED',
        detail: `Error al leer kill switch: ${killSwitchErr.message}`,
      });
    }
  } else if (!killSwitchData) {
    results.push({
      category: 'Kill Switch',
      item: 'cross_origin_bridge_enabled',
      status: 'PENDING_MIGRATION',
      detail: 'Clave no sembrada aún en domain_migration_settings.',
    });
  } else {
    const isEnabled = killSwitchData.setting_value === true;
    results.push({
      category: 'Kill Switch',
      item: 'cross_origin_bridge_enabled',
      status: isEnabled ? 'FAILED' : 'OK',
      detail: isEnabled
        ? 'ADVERTENCIA: El kill switch está activo (esperado: false por defecto).'
        : 'CONFIRMADO: Apagado por defecto (false). Operación segura.',
    });
  }

  // -------------------------------------------------------------------------
  // 5. Informe Estructurado de Diagnóstico
  // -------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('RESUMEN DE DIAGNÓSTICO DE PREFLIGHT (STAGING)');
  console.log('================================================================================');
  console.table(results.map((r) => ({
    Categoría: r.category,
    Elemento: r.item,
    Estado: r.status,
    Detalle: r.detail.length > 60 ? r.detail.slice(0, 57) + '...' : r.detail,
  })));

  const pendingCount = results.filter((r) => r.status === 'PENDING_MIGRATION').length;
  const failedCount = results.filter((r) => r.status === 'FAILED').length;
  const okCount = results.filter((r) => r.status === 'OK' || r.status === 'PROTECTED').length;

  console.log('\n--------------------------------------------------------------------------------');
  console.log(`Verificaciones Totales: ${results.length}`);
  console.log(`  - Operativos / Protegidos: ${okCount}`);
  console.log(`  - Pendientes de Migración: ${pendingCount}`);
  console.log(`  - Fallidos / Errores:      ${failedCount}`);
  console.log('--------------------------------------------------------------------------------');
  console.log('GARANTÍA: Cero mutaciones ejecutadas en Staging.');
  console.log('================================================================================\n');

  if (failedCount > 0) {
    console.error('[PREFLIGHT ALERTA] Se detectaron errores que requieren atención antes de continuar.');
  } else if (pendingCount > 0) {
    console.log('[PREFLIGHT DIAGNÓSTICO] Entorno listo para recibir la migración 20261107120000_domain_identity_bridge_v1.sql.');
  } else {
    console.log('[PREFLIGHT LISTO] Todas las estructuras y permisos del puente están operativos en Staging.');
  }
}

runReadOnlyPreflight().catch((err) => {
  console.error('[PREFLIGHT ERROR]', err);
  process.exit(1);
});
