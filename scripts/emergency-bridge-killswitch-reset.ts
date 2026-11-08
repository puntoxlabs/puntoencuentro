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
import crypto from 'node:crypto';
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

export function computeManifestSignature(
  runId: string,
  userIds: string[],
  encounterIds: string[],
  ticketHashes: string[],
  secretKey: string
): string {
  const sortedUsers = [...userIds].sort().join(',');
  const sortedEncounters = [...encounterIds].sort().join(',');
  const sortedTickets = [...ticketHashes].sort().join(',');
  const message = `${runId}|${sortedUsers}|${sortedEncounters}|${sortedTickets}`;
  return crypto.createHmac('sha256', secretKey).update(message).digest('hex');
}

export function verifyManifestProvenance(
  content: any,
  secretKey: string
): { valid: boolean; error?: string } {
  if (!content || typeof content !== 'object') {
    return { valid: false, error: 'Contenido del manifiesto inválido (no es un objeto)' };
  }
  if (!content.runId || !RUN_ID_REGEX.test(content.runId)) {
    return { valid: false, error: `runId inválido o ausente en manifiesto: "${content.runId}"` };
  }
  if (!content.provenanceSignature || typeof content.provenanceSignature !== 'string') {
    return { valid: false, error: 'Falta la firma criptográfica de procedencia (provenanceSignature) generada por el runner' };
  }

  const userIds: string[] = (content.trackedUserIds || []).filter((id: string) => UUID_REGEX.test(id));
  const encounterIds: string[] = (content.trackedEncounterIds || []).filter((id: string) => UUID_REGEX.test(id));
  const ticketHashes: string[] = (content.trackedTicketHashes || []).filter((h: string) => /^[0-9a-f]{64}$/i.test(h));

  const expectedSignature = computeManifestSignature(content.runId, userIds, encounterIds, ticketHashes, secretKey);
  const sigBuffer = Buffer.from(content.provenanceSignature, 'hex');
  const expBuffer = Buffer.from(expectedSignature, 'hex');

  if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
    return { valid: false, error: 'Firma criptográfica inválida (manifiesto adulterado o manipulado manualmente)' };
  }

  return { valid: true };
}

export async function verifyFixtureOwnership(
  adminClient: any,
  targetRunId: string,
  userIds: string[],
  encounterIds: string[]
): Promise<{ authorized: boolean; error?: string }> {
  // 1. Validar usuarios en Auth Admin: solo se autoriza la eliminación de usuarios anónimos o fixtures QA (@puntoencuentro.test)
  for (const uid of userIds) {
    const { data: uData, error: uErr } = await adminClient.auth.admin.getUserById(uid);
    if (uErr) {
      if (!uErr.message?.toLowerCase().includes('not found') && !uErr.message?.toLowerCase().includes('database error')) {
        return { authorized: false, error: `Error verificando identidad de usuario ${uid}: ${uErr.message}` };
      }
      continue;
    }
    const user = uData?.user;
    if (user) {
      const isAnon = user.is_anonymous === true;
      const isQaEmail = Boolean(
        user.email &&
        user.email.endsWith('@puntoencuentro.test') &&
        user.email.startsWith('qa-')
      );
      if (!isAnon && !isQaEmail) {
        return {
          authorized: false,
          error: `El usuario ${uid} es una cuenta real o no autorizada (email: ${user.email}). Pertenencia denegada; limpieza abortada para proteger identidades ajenas.`,
        };
      }
    }
  }

  // 2. Validar encuentros en base de datos: verificar que pertenecen a los usuarios del run o poseen tags de procedencia
  if (encounterIds.length > 0) {
    const { data: encounters, error: encErr } = await adminClient
      .from('encuentros')
      .select('id, host_id, titulo, descripcion')
      .in('id', encounterIds);

    if (encErr) {
      return { authorized: false, error: `Error consultando encuentros para verificación de procedencia: ${encErr.message}` };
    }

    for (const enc of encounters || []) {
      const hostInRun = userIds.includes(enc.host_id);
      const taggedWithRunId =
        (enc.descripcion && enc.descripcion.includes(targetRunId)) ||
        (enc.titulo && enc.titulo.includes(targetRunId));
      const hasQaPrefix =
        (enc.titulo && (enc.titulo.includes('Fixture') || enc.titulo.includes('E2E Bridge') || enc.titulo.includes('Manual Fallback') || enc.titulo.includes('Guest Token Test') || enc.titulo.includes('Chain A->B->C') || enc.titulo.includes('Messaging Perms') || enc.titulo.includes('R6 Fixture') || enc.titulo.includes('R7 Fixture') || enc.titulo.includes('R8 Fixture')));

      if (!hostInRun && !taggedWithRunId) {
        return {
          authorized: false,
          error: `El encuentro ${enc.id} ("${enc.titulo}") no pertenece a los usuarios del run (${enc.host_id}) ni está etiquetado con runId. Abortando limpieza de seguridad.`,
        };
      }
      if (!hasQaPrefix && !taggedWithRunId) {
        return {
          authorized: false,
          error: `El encuentro ${enc.id} no posee marcas de procedencia QA autorizadas. Abortando limpieza de seguridad.`,
        };
      }
    }
  }

  return { authorized: true };
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

  // 1. Verificación de Procedencia Criptográfica (Anti-manipulación manual)
  const adminKey = getStagingSecretKey();
  const provCheck = verifyManifestProvenance(content, adminKey);
  if (!provCheck.valid) {
    console.error(`[CRÍTICO DE SEGURIDAD] Rechazo de procedencia: ${provCheck.error}`);
    console.error('El manifiesto NO será procesado ni eliminado para preservar la evidencia forense.');
    return false;
  }

  const userIds: string[] = (content.trackedUserIds || []).filter((id: string) => UUID_REGEX.test(id));
  const encounterIds: string[] = (content.trackedEncounterIds || []).filter((id: string) => UUID_REGEX.test(id));
  const ticketHashes: string[] = (content.trackedTicketHashes || []).filter((h: string) => /^[0-9a-f]{64}$/i.test(h));

  // 2. Verificación de Pertenencia Estricta de Recursos contra DB antes de cualquier mutación
  const ownCheck = await verifyFixtureOwnership(adminClient, targetRunId, userIds, encounterIds);
  if (!ownCheck.authorized) {
    console.error(`[CRÍTICO DE SEGURIDAD] Rechazo de pertenencia: ${ownCheck.error}`);
    console.error('Abortando limpieza administrativa para prevenir eliminación accidental o maliciosa de recursos ajenos.');
    return false;
  }

  console.log(`--- Ejecutando limpieza auditada para runId: ${targetRunId} ---`);
  console.log(`  Procedencia validada: ${encounterIds.length} encuentros, ${userIds.length} usuarios, ${ticketHashes.length} tickets`);

  const errors: string[] = [];

  // 3. Borrado controlado de recursos de encuentros
  if (encounterIds.length > 0) {
    const { error: partErr } = await adminClient.from('participantes').delete().in('encuentro_id', encounterIds);
    if (partErr) errors.push(`participantes(encuentro_id): ${partErr.message}`);

    const { error: msgErr } = await adminClient.from('mensajes_encuentro').delete().in('encuentro_id', encounterIds);
    if (msgErr) errors.push(`mensajes_encuentro(encuentro_id): ${msgErr.message}`);

    const { error: encErr } = await adminClient.from('encuentros').delete().in('id', encounterIds);
    if (encErr) errors.push(`encuentros(id): ${encErr.message}`);
  }

  // 4. Borrado controlado de recursos de usuarios
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

    // Eliminación de identidades en Auth Admin con comprobación estricta de error
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

  // 5. Verificación completa e independiente de residuo cero en TODAS las superficies modificadas
  console.log('  Verificando exhaustivamente residuo cero en todas las superficies...');
  let residualCount = 0;

  const surfaceChecks = [
    { name: 'encuentros (por id)', query: adminClient.from('encuentros').select('*', { count: 'exact', head: true }).in('id', encounterIds), active: encounterIds.length > 0 },
    { name: 'encuentros (por host_id)', query: adminClient.from('encuentros').select('*', { count: 'exact', head: true }).in('host_id', userIds), active: userIds.length > 0 },
    { name: 'participantes (por encuentro_id)', query: adminClient.from('participantes').select('*', { count: 'exact', head: true }).in('encuentro_id', encounterIds), active: encounterIds.length > 0 },
    { name: 'participantes (por user_id)', query: adminClient.from('participantes').select('*', { count: 'exact', head: true }).in('user_id', userIds), active: userIds.length > 0 },
    { name: 'mensajes_encuentro (por encuentro_id)', query: adminClient.from('mensajes_encuentro').select('*', { count: 'exact', head: true }).in('encuentro_id', encounterIds), active: encounterIds.length > 0 },
    { name: 'mensajes_encuentro (por autor_user_id)', query: adminClient.from('mensajes_encuentro').select('*', { count: 'exact', head: true }).in('autor_user_id', userIds), active: userIds.length > 0 },
    { name: 'tickets (por source_user_id_snapshot)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('source_user_id_snapshot', userIds), active: userIds.length > 0 },
    { name: 'tickets (por target_user_id_snapshot)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('target_user_id_snapshot', userIds), active: userIds.length > 0 },
    { name: 'tickets (por intended_target_user_id)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('intended_target_user_id', userIds), active: userIds.length > 0 },
    { name: 'tickets (por token_hash)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('token_hash', ticketHashes), active: ticketHashes.length > 0 },
    { name: 'inbox_notifications', query: adminClient.from('inbox_notifications').select('*', { count: 'exact', head: true }).in('recipient_user_id', userIds), active: userIds.length > 0 },
    { name: 'notification_delivery_outbox', query: adminClient.from('notification_delivery_outbox').select('*', { count: 'exact', head: true }).in('recipient_user_id', userIds), active: userIds.length > 0 },
    { name: 'rate_limit_buckets', query: adminClient.from('rate_limit_buckets').select('*', { count: 'exact', head: true }).in('user_id', userIds), active: userIds.length > 0 },
  ];

  for (const sc of surfaceChecks) {
    if (!sc.active) continue;
    const { count, error } = await sc.query;
    if (error) {
      errors.push(`Error en chequeo ${sc.name}: ${error.message}`);
    } else if ((count || 0) > 0) {
      residualCount += count!;
      errors.push(`Residuo detectado en ${sc.name}: ${count} filas`);
    }
  }

  // Verificación de usuarios Auth eliminados
  if (userIds.length > 0) {
    for (const uid of userIds) {
      const { data: uData, error: uErr } = await adminClient.auth.admin.getUserById(uid);
      if (uErr) {
        if (!uErr.message?.toLowerCase().includes('not found') && !uErr.message?.toLowerCase().includes('database error')) {
          errors.push(`Error verificando borrado de usuario ${uid}: ${uErr.message}`);
        }
      } else if (uData?.user) {
        residualCount += 1;
        errors.push(`Usuario ${uid} aún existe en Auth Admin`);
      }
    }
  }

  if (errors.length > 0 || residualCount > 0) {
    console.error(`[CRÍTICO] Limpieza incompleta: ${errors.length} errores, ${residualCount} residuos detectados.`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
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
