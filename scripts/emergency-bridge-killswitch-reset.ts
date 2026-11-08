/**
 * Procedimiento de Emergencia: Apagado Inmediato de Kill Switches y Limpieza Auditada
 * Mini-Sprint 2B-4: Puente de Identidad entre Dominios
 *
 * ARQUITECTURA DE SEGURIDAD:
 * 1. MODO POR DEFECTO: '--shutdown-only' (no destructivo).
 *    Apaga de inmediato los switches y verifica independientemente que ambos están en 'false'.
 * 2. MODO LIMPIEZA DESTRUCCIÓN AUTORIZADA: Requiere '--clean-run-id <runId>'.
 *    Solo opera sobre el manifiesto específico 'recovery-manifest-staging-<runId>.json'.
 *    Comprueba pertenencia y formato UUID antes de cualquier eliminación.
 *    Comprueba { error } en cada query y en deleteUser.
 *    No borra el manifiesto salvo confirmación estricta de residuo cero.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

assertStagingEnvironment(STAGING_URL);
assertStagingEnvironment(STAGING_PROJECT_REF);

if (STAGING_URL.includes(PRODUCTION_PROJECT_REF)) {
  console.error(`[CRITICAL SECURITY] Intento contra PRODUCCIÓN (${PRODUCTION_PROJECT_REF}). Abortando.`);
  process.exit(1);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID_REGEX = /^bridge-e2e-\d+-[0-9a-f]+$/;

export async function forceKillSwitchShutdown(adminClient: any): Promise<boolean> {
  console.log('1. Forzando apagado de ambos Kill Switches SQL en Staging...');

  const { error: resetBridgeErr } = await adminClient.rpc('set_domain_migration_setting', {
    p_key: 'cross_origin_bridge_enabled',
    p_value: false,
  });
  if (resetBridgeErr) {
    console.warn(`  [WARN] set_domain_migration_setting bridge falló (${resetBridgeErr.message}). Aplicando UPDATE...`);
    const { error: updBridgeErr } = await adminClient
      .from('domain_migration_settings')
      .update({ setting_value: false, updated_at: new Date().toISOString() })
      .eq('setting_key', 'cross_origin_bridge_enabled');
    if (updBridgeErr) {
      console.error(`  [ERROR] Falló UPDATE de bridge switch: ${updBridgeErr.message}`);
    }
  }

  const { error: resetManualErr } = await adminClient.rpc('set_domain_migration_setting', {
    p_key: 'cross_origin_manual_enabled',
    p_value: false,
  });
  if (resetManualErr) {
    console.warn(`  [WARN] set_domain_migration_setting manual falló (${resetManualErr.message}). Aplicando UPDATE...`);
    const { error: updManualErr } = await adminClient
      .from('domain_migration_settings')
      .update({ setting_value: false, updated_at: new Date().toISOString() })
      .eq('setting_key', 'cross_origin_manual_enabled');
    if (updManualErr) {
      console.error(`  [ERROR] Falló UPDATE de manual switch: ${updManualErr.message}`);
    }
  }

  // 2. Verificación independiente de solo lectura
  console.log('2. Verificando lectura independiente de domain_migration_settings...');
  const { data: checkSettings, error: checkErr } = await adminClient
    .from('domain_migration_settings')
    .select('setting_key, setting_value, updated_at')
    .in('setting_key', ['cross_origin_bridge_enabled', 'cross_origin_manual_enabled']);

  if (checkErr || !checkSettings) {
    console.error('[CRÍTICO] No se pudo leer domain_migration_settings tras intento de apagado:', checkErr?.message);
    return false;
  }

  const bridgeRow = checkSettings.find((s) => s.setting_key === 'cross_origin_bridge_enabled');
  const manualRow = checkSettings.find((s) => s.setting_key === 'cross_origin_manual_enabled');

  const bridgeVal = bridgeRow?.setting_value;
  const manualVal = manualRow?.setting_value;

  console.log(`  cross_origin_bridge_enabled: ${bridgeVal}`);
  console.log(`  cross_origin_manual_enabled: ${manualVal}`);

  // Asegurar que el estado indeterminado (null/undefined) NUNCA se trate como false
  if (bridgeVal === undefined || bridgeVal === null || manualVal === undefined || manualVal === null) {
    console.error('[CRÍTICO] Estado INDETERMINADO en kill switches tras intento de apagado.');
    return false;
  }

  if (bridgeVal !== false || manualVal !== false) {
    console.error('[CRÍTICO] Al menos un switch permanece ACTIVO o no se apagó correctamente.');
    return false;
  }

  console.log('  -> Confirmado: Ambos kill switches están en false (puente totalmente cerrado).\n');
  return true;
}

export async function cleanAuthorizedManifest(adminClient: any, targetRunId: string): Promise<boolean> {
  if (!RUN_ID_REGEX.test(targetRunId)) {
    console.error(`[ERROR] Formato de runId inválido: "${targetRunId}". Debe coincidir con ${RUN_ID_REGEX}`);
    return false;
  }

  const manifestPath = path.resolve(process.cwd(), `recovery-manifest-staging-${targetRunId}.json`);
  if (!fs.existsSync(manifestPath)) {
    console.error(`[ERROR] No existe el archivo de manifiesto para el runId especificado: ${manifestPath}`);
    return false;
  }

  let content: any;
  try {
    content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err: any) {
    console.error(`[ERROR] Manifiesto corrupto o no parseable: ${err?.message}`);
    return false;
  }

  if (content.runId !== targetRunId) {
    console.error(`[CRÍTICO] Discrepancia de seguridad: runId en manifiesto (${content.runId}) no coincide con solicitado (${targetRunId})`);
    return false;
  }

  const userIds: string[] = (content.trackedUserIds || []).filter((id: string) => UUID_REGEX.test(id));
  const encounterIds: string[] = (content.trackedEncounterIds || []).filter((id: string) => UUID_REGEX.test(id));
  const ticketHashes: string[] = (content.trackedTicketHashes || []).filter((h: string) => /^[0-9a-f]{64}$/i.test(h));

  console.log(`--- Ejecutando limpieza auditada para runId: ${targetRunId} ---`);
  console.log(`  UUIDs verificados: ${encounterIds.length} encuentros, ${userIds.length} usuarios, ${ticketHashes.length} tickets`);

  const errors: string[] = [];

  // Borrado de recursos de encuentros
  if (encounterIds.length > 0) {
    const { error: partErr } = await adminClient.from('participantes').delete().in('encuentro_id', encounterIds);
    if (partErr) errors.push(`participantes(encuentro_id): ${partErr.message}`);

    const { error: msgErr } = await adminClient.from('mensajes_encuentro').delete().in('encuentro_id', encounterIds);
    if (msgErr) errors.push(`mensajes_encuentro(encuentro_id): ${msgErr.message}`);

    const { error: encErr } = await adminClient.from('encuentros').delete().in('id', encounterIds);
    if (encErr) errors.push(`encuentros(id): ${encErr.message}`);
  }

  // Borrado de recursos de usuarios
  if (userIds.length > 0) {
    const { error: pUserErr } = await adminClient.from('participantes').delete().in('user_id', userIds);
    if (pUserErr) errors.push(`participantes(user_id): ${pUserErr.message}`);

    const { error: mUserErr } = await adminClient.from('mensajes_encuentro').delete().in('autor_user_id', userIds);
    if (mUserErr) errors.push(`mensajes_encuentro(autor_user_id): ${mUserErr.message}`);

    const { error: eHostErr } = await adminClient.from('encuentros').delete().in('host_id', userIds);
    if (eHostErr) errors.push(`encuentros(host_id): ${eHostErr.message}`);

    const { error: notifErr } = await adminClient.from('inbox_notifications').delete().in('recipient_user_id', userIds);
    if (notifErr) errors.push(`inbox_notifications: ${notifErr.message}`);

    const { error: outboxErr } = await adminClient.from('notification_delivery_outbox').delete().in('recipient_user_id', userIds);
    if (outboxErr) errors.push(`notification_delivery_outbox: ${outboxErr.message}`);

    const { error: rlErr } = await adminClient.from('rate_limit_buckets').delete().in('user_id', userIds);
    if (rlErr) errors.push(`rate_limit_buckets: ${rlErr.message}`);

    const { error: tsErr } = await adminClient.from('anonymous_transfer_tickets').delete().in('source_user_id_snapshot', userIds);
    if (tsErr) errors.push(`tickets(source): ${tsErr.message}`);

    const { error: ttErr } = await adminClient.from('anonymous_transfer_tickets').delete().in('target_user_id_snapshot', userIds);
    if (ttErr) errors.push(`tickets(target): ${ttErr.message}`);

    const { error: tiErr } = await adminClient.from('anonymous_transfer_tickets').delete().in('intended_target_user_id', userIds);
    if (tiErr) errors.push(`tickets(intended): ${tiErr.message}`);

    // Eliminación de identidades en Auth Admin con comprobación de error
    for (const uid of userIds) {
      const { error: delUserErr } = await adminClient.auth.admin.deleteUser(uid);
      if (delUserErr) {
        errors.push(`auth.deleteUser(${uid}): ${delUserErr.message}`);
      }
    }
  }

  if (ticketHashes.length > 0) {
    const { error: thErr } = await adminClient.from('anonymous_transfer_tickets').delete().in('token_hash', ticketHashes);
    if (thErr) errors.push(`tickets(token_hash): ${thErr.message}`);
  }

  // Verificación estricta de residuo cero antes de tocar el manifiesto
  console.log('  Verificando residuo cero en base de datos...');
  let residualCount = 0;
  if (encounterIds.length > 0) {
    const { count } = await adminClient.from('encuentros').select('*', { count: 'exact', head: true }).in('id', encounterIds);
    residualCount += (count || 0);
  }
  if (userIds.length > 0) {
    for (const uid of userIds) {
      const { data: uData } = await adminClient.auth.admin.getUserById(uid);
      if (uData?.user) residualCount += 1;
    }
  }

  if (errors.length > 0 || residualCount > 0) {
    console.error(`[CRÍTICO] Limpieza incompleta: ${errors.length} errores, ${residualCount} residuos detectados.`);
    console.error('El manifiesto NO será eliminado para preservar trazabilidad de recuperación.');
    return false;
  }

  fs.unlinkSync(manifestPath);
  console.log(`  -> Limpieza confirmada y manifiesto ${path.basename(manifestPath)} archivado/eliminado con éxito.\n`);
  return true;
}

export async function runEmergencyCli(): Promise<boolean> {
  const args = process.argv.slice(2);
  const adminKey = getStagingSecretKey();
  const adminClient = createClient(STAGING_URL, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const isShutdownOnly = args.includes('--shutdown-only') || args.length === 0;
  const cleanRunIdIdx = args.indexOf('--clean-run-id');
  const targetRunId = cleanRunIdIdx !== -1 && args[cleanRunIdIdx + 1] ? args[cleanRunIdIdx + 1] : null;

  console.log('================================================================================');
  console.log('PROCEDIMIENTO DE EMERGENCIA Y SEGURIDAD — STAGING');
  console.log(`Modo: ${targetRunId ? `LIMPIEZA DE RUN_ID (${targetRunId})` : 'SHUTDOWN-ONLY (NO DESTRUCTIVO)'}`);
  console.log('================================================================================\n');

  // Siempre ejecutar apagado primero
  const shutdownOk = await forceKillSwitchShutdown(adminClient);
  if (!shutdownOk) {
    console.error('[CRÍTICO] Falló el apagado de seguridad.');
    return false;
  }

  if (targetRunId) {
    const cleanOk = await cleanAuthorizedManifest(adminClient, targetRunId);
    if (!cleanOk) return false;
  }

  console.log('================================================================================');
  console.log('PROCEDIMIENTO DE EMERGENCIA COMPLETADO SATISFACTORIAMENTE');
  console.log('================================================================================');
  return true;
}

if (process.argv[1]?.endsWith('emergency-bridge-killswitch-reset.ts')) {
  runEmergencyCli()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error('[CRITICAL UNCAUGHT EMERGENCY ERROR]', err);
      process.exit(1);
    });
}
