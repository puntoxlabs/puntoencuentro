/**
 * Runner de Integración y Concurrencia en Supabase Staging
 * Mini-Sprint 2B-2B: Validación Funcional Real del Puente de Identidad
 *
 * ====================================================================================
 * ¡ATENCIÓN! COMPUERTA DE SEGURIDAD OBLIGATORIA:
 * Este runner valida exhaustivamente el backend del puente de identidad en Staging
 * bajo condiciones reales de GoTrue, PostgREST y PostgreSQL.
 *
 * Requiere:
 *  - STAGING_BRIDGE_QA_AUTHORIZED === '1'
 *  - STAGING_ENABLE_BRIDGE_KILL_SWITCH === '1'
 *
 * ESTRICTAMENTE PROHIBIDO CONTRA PRODUCCIÓN (aurbicjwftjhwryhyjiq).
 * Entorno autorizado único: Staging (wougfhfwqgmxhgvjqoua).
 * ====================================================================================
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

// 1. Guardrail estricto de entorno y autorización
const STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

assertStagingEnvironment(STAGING_URL);
assertStagingEnvironment(STAGING_PROJECT_REF);

if (STAGING_URL.includes(PRODUCTION_PROJECT_REF)) {
  console.error(`[CRITICAL SECURITY] Intento de ejecución contra PRODUCCIÓN (${PRODUCTION_PROJECT_REF}). Abortando.`);
  process.exit(1);
}

// COMPUERTA ESTRICTA: Exigir exactamente '1'
if (process.env.STAGING_BRIDGE_QA_AUTHORIZED !== '1') {
  console.log('================================================================================');
  console.log('ESTADO DEL RUNNER: [PENDIENTE PARA MINI-SPRINT 2B-2]');
  console.log('  Este runner de Staging está completamente implementado y verificado en código.');
  console.log('  Por mandato de seguridad, la ejecución remota requiere STAGING_BRIDGE_QA_AUTHORIZED === "1".');
  console.log('  Cualquier otro valor impide completamente la ejecución.');
  console.log('================================================================================');
  process.exit(0);
}

/**
 * Sanitiza recursivamente cualquier objeto o cadena para garantizar que CERO tokens,
 * códigos o fragmentos de transferencias sean impresos en consola o registros.
 */
function sanitizeLog(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Si parece un token hex de 64 caracteres, redactar completamente
    if (/^[0-9a-fA-F]{64}$/.test(obj)) {
      return '[REDACTED_64HEX_TOKEN]';
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeLog);
  }
  if (typeof obj === 'object') {
    const sanitized: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        k.toLowerCase().includes('token') ||
        k.toLowerCase().includes('secret') ||
        k.toLowerCase().includes('password')
      ) {
        sanitized[k] = '[REDACTED_SECRET]';
      } else {
        sanitized[k] = sanitizeLog(v);
      }
    }
    return sanitized;
  }
  return obj;
}

export interface StagingQAResult {
  runId: string;
  success: boolean;
  phase1Passed: boolean;
  phase2ScenariosPassed: number;
  phase3Cleaned: boolean;
  errors: string[];
}

export async function runStagingConcurrencyQA(): Promise<StagingQAResult> {
  const runId = `staging-qa-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  console.log('================================================================================');
  console.log('INICIANDO STAGING QA: CONCURRENCIA DE PUENTE DE IDENTIDAD (2B-2B)');
  console.log(`Run ID: ${runId}`);
  console.log(`Target Supabase URL: ${STAGING_URL} (Ref: ${STAGING_PROJECT_REF})`);
  console.log(`Protección anti-producción activa: Prohibido estrictamente ${PRODUCTION_PROJECT_REF}`);
  console.log('================================================================================\n');

  const adminKey = getStagingSecretKey();
  const publishableKey = getStagingPublishableKey();

  const adminClient = createClient(STAGING_URL, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Preflight de Privilegios: Verificar que service_role tiene permisos efectivos
  console.log('Paso 0: Preflight de privilegios administrativos y catálogo...');
  const privilegeChecks = [
    { table: 'anonymous_transfer_tickets', query: adminClient.from('anonymous_transfer_tickets').select('id', { head: true, count: 'exact' }) },
    { table: 'domain_migration_settings', query: adminClient.from('domain_migration_settings').select('setting_key', { head: true, count: 'exact' }) },
    { table: 'encuentros', query: adminClient.from('encuentros').select('id', { head: true, count: 'exact' }) },
    { table: 'participantes', query: adminClient.from('participantes').select('id', { head: true, count: 'exact' }) },
    { table: 'mensajes_encuentro', query: adminClient.from('mensajes_encuentro').select('id', { head: true, count: 'exact' }) },
    { table: 'inbox_notifications', query: adminClient.from('inbox_notifications').select('id', { head: true, count: 'exact' }) },
    { table: 'notification_delivery_outbox', query: adminClient.from('notification_delivery_outbox').select('id', { head: true, count: 'exact' }) },
    { table: 'rate_limit_buckets', query: adminClient.from('rate_limit_buckets').select('action', { head: true, count: 'exact' }) },
  ];

  for (const check of privilegeChecks) {
    const { error } = await check.query;
    if (error) {
      throw new Error(`[PREFLIGHT FALLIDO] service_role carece de permisos sobre '${check.table}': ${error.message} (${error.code})`);
    }
  }
  console.log('  Privilegios de service_role validados.');

  // Control estricto de switches iniciales: AMBOS DEBEN ESTAR EN FALSE
  console.log('Paso 0.1: Verificando estado inicial de ambos kill switches (deben ser false)...');
  const { data: initialSettings, error: initialSettingsErr } = await adminClient
    .from('domain_migration_settings')
    .select('setting_key, setting_value')
    .in('setting_key', ['cross_origin_bridge_enabled', 'cross_origin_manual_enabled']);

  if (initialSettingsErr || !initialSettings) {
    throw new Error(`Error leyendo domain_migration_settings: ${initialSettingsErr?.message}`);
  }

  const initialBridge = initialSettings.find((s) => s.setting_key === 'cross_origin_bridge_enabled')?.setting_value;
  const initialManual = initialSettings.find((s) => s.setting_key === 'cross_origin_manual_enabled')?.setting_value;

  console.log(`  Estado inicial cross_origin_bridge_enabled: ${initialBridge}`);
  console.log(`  Estado inicial cross_origin_manual_enabled: ${initialManual}`);

  if (initialBridge !== false || initialManual !== false) {
    throw new Error(
      `[SECURITY GUARD ABORT]: Ambos kill switches deben estar inicialmente en 'false'.\n` +
      `Encontrado: bridge=${initialBridge}, manual=${initialManual}. Abortando de inmediato.`
    );
  }

  // Comprobar autorización para habilitar el bridge
  if (process.env.STAGING_ENABLE_BRIDGE_KILL_SWITCH !== '1') {
    throw new Error(
      '[KILL SWITCH GUARD]: El puente de identidad cross-origin está desactivado por defecto.\n' +
      'Para habilitarlo temporalmente durante la prueba se requiere STAGING_ENABLE_BRIDGE_KILL_SWITCH === "1".'
    );
  }

  // Variables de seguimiento para limpieza (inicializadas ANTES del bloque try)
  let killSwitchActivated = false;
  const trackedUserIds: string[] = [];
  const trackedEncounterIds: string[] = [];
  const trackedTicketHashes: string[] = []; // Solo hashes SHA256 (CERO tokens en texto claro ni secretos)

  let phase1Passed = false;
  let phase2ScenariosPassed = 0;
  const qaErrors: string[] = [];

  // =========================================================================
  // BLOQUE TRY/FINALLY GLOBAL: Abarca desde ANTES de encender el kill switch
  // Garantiza que cualquier excepción conduzca a restauración y limpieza
  // =========================================================================
  try {
    // =========================================================================
    // FASE 1: VERIFICACIONES CON AMBOS SWITCHES APAGADOS
    // =========================================================================
    console.log('\n================================================================================');
    console.log('FASE 1: VERIFICACIONES CON AMBOS KILL SWITCHES APAGADOS');
    console.log('================================================================================');

    const clientP1 = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: anonP1Data, error: anonP1Err } = await clientP1.auth.signInAnonymously();
    if (anonP1Err || !anonP1Data.user) {
      throw new Error(`Fallo signInAnonymously para Fase 1: ${anonP1Err?.message}`);
    }
    const uid_P1 = anonP1Data.user.id;
    trackedUserIds.push(uid_P1);
    console.log(`  Usuario anónimo de Fase 1 creado: ${uid_P1}`);

    // 1.1 RPCs y permisos existentes continúan funcionando
    console.log('  1.1 Probando creación de encuentro base con crear_encuentro_seguro(p_data)...');
    const encP1Res = await clientP1.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: `Fase 1 Pre-Bridge Test ${crypto.randomUUID().slice(0, 8)}`,
        descripcion: 'Verificación de contrato existente con switches apagados',
        fecha: new Date(Date.now() + 86400000 * 5).toISOString().slice(0, 10),
        hora: '19:00',
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
        post_event_active_minutes: 30,
      },
    });

    assert.ok(encP1Res.data?.id, `Fallo al crear encuentro en Fase 1: ${JSON.stringify(sanitizeLog(encP1Res))}`);
    const encP1Id = encP1Res.data.id;
    trackedEncounterIds.push(encP1Id);
    console.log(`      Encuentro creado exitosamente: ${encP1Id}`);

    // 1.2 El puente rechaza emisiones y canjes nuevos mientras está desactivado
    console.log('  1.2 Verificando rechazo de emisiones y canjes cross-origin con switches en false...');
    const fakeTargetId = crypto.randomUUID();
    const bridgeEmitRes = await clientP1.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_bridge',
      p_intended_target_user_id: fakeTargetId,
    });

    assert.equal(bridgeEmitRes.data?.ok, false, 'Emisión cross_origin_bridge debe fallar cuando kill switch está en false');
    assert.equal(bridgeEmitRes.data?.error, 'cross_origin_migration_disabled', 'Error esperado: cross_origin_migration_disabled');
    console.log('      Rechazo de emisión cross_origin_bridge confirmado: cross_origin_migration_disabled');

    const manualEmitRes = await clientP1.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_manual',
    });
    assert.equal(manualEmitRes.data?.ok, false, 'Emisión cross_origin_manual debe fallar cuando kill switch está en false');
    assert.equal(manualEmitRes.data?.error, 'manual_migration_disabled', 'Error esperado: manual_migration_disabled');
    console.log('      Rechazo de emisión cross_origin_manual confirmado: manual_migration_disabled');

    const dummyHex64 = crypto.randomBytes(32).toString('hex');
    const bridgeClaimRes = await clientP1.rpc('claim_domain_migration_ticket_seguro', {
      p_ticket_token: dummyHex64,
    });
    assert.equal(bridgeClaimRes.data?.ok, false, 'Canje debe ser rechazado');
    // Si el token ficticio no existe, ticket_not_found; si existiera con switch apagado, cross_origin_migration_disabled.
    assert.ok(
      ['ticket_not_found', 'cross_origin_migration_disabled'].includes(bridgeClaimRes.data?.error),
      `Error de canje seguro esperado: ${bridgeClaimRes.data?.error}`
    );
    console.log(`      Rechazo de canje con switch apagado comprobado: ${bridgeClaimRes.data?.error}`);

    // 1.3 Verificación de NO exposición administrativa ni de tickets a no autorizados
    console.log('  1.3 Verificando aislamiento de RLS para usuarios no autorizados...');
    const { data: settingsAnonData, error: settingsAnonErr } = await clientP1
      .from('domain_migration_settings')
      .select('*')
      .limit(1);

    // Debe o bien fallar por RLS / SQL GRANT o bien retornar 0 filas protegidas
    if (settingsAnonErr) {
      assert.ok(
        settingsAnonErr.code === '42501' || settingsAnonErr.message.includes('permission denied'),
        `Error inesperado: ${settingsAnonErr.message}`
      );
    } else {
      assert.equal(settingsAnonData.length, 0, 'Cliente anónimo no debe poder leer domain_migration_settings');
    }
    console.log('      Tabla domain_migration_settings estrictamente aislada de lectura no autorizada.');

    const { data: ticketsAnonData, error: ticketsAnonErr } = await clientP1
      .from('anonymous_transfer_tickets')
      .select('*')
      .limit(1);

    if (ticketsAnonErr) {
      assert.ok(
        ticketsAnonErr.code === '42501' || ticketsAnonErr.message.includes('permission denied'),
        `Error inesperado: ${ticketsAnonErr.message}`
      );
    } else {
      assert.equal(ticketsAnonData.length, 0, 'Cliente anónimo no debe poder leer anonymous_transfer_tickets sin filtrar');
    }
    console.log('      Tabla anonymous_transfer_tickets estrictamente protegida por RLS.');

    // Intento anónimo de mutar setting debe fallar
    const { error: setAttemptErr } = await clientP1.rpc('set_domain_migration_setting', {
      p_key: 'cross_origin_bridge_enabled',
      p_value: true,
    });
    assert.ok(setAttemptErr, 'Invocación anónima de set_domain_migration_setting DEBE ser rechazada');
    console.log('      Invocación de set_domain_migration_setting denegada a usuarios no administrativos.');

    // 1.4 Flujo legacy oauth_upgrade NO está bloqueado por switches cross-origin
    console.log('  1.4 Verificando compatibilidad de firma y emisión del flujo legacy oauth_upgrade...');
    const legacyRes = await clientP1.rpc('create_anonymous_transfer_ticket');
    assert.equal(legacyRes.data?.ok, true, `Fallo emisión legacy: ${JSON.stringify(sanitizeLog(legacyRes))}`);
    assert.ok(legacyRes.data?.ticket_token, 'Debe devolver ticket_token');
    const legacyHash = crypto.createHash('sha256').update(legacyRes.data.ticket_token).digest('hex');
    trackedTicketHashes.push(legacyHash);
    console.log('      Ticket oauth_upgrade emitido exitosamente (flujo Google preservado sin afectación).');

    // Revocar inmediatamente para no dejar ticket pending
    const revokeLegacyRes = await clientP1.rpc('revoke_my_pending_transfer_ticket');
    assert.equal(revokeLegacyRes.data?.ok, true, 'Revocación de ticket legacy debe ser exitosa');
    console.log('      Ticket legacy revocado determinísticamente.');

    // 1.5 Consultas habituales de encuentros, participantes y mensajería
    console.log('  1.5 Verificando contratos de lectura de encuentros y participantes...');
    const { data: encFetch, error: encFetchErr } = await clientP1
      .from('encuentros')
      .select('id, titulo, estado')
      .eq('id', encP1Id)
      .single();
    assert.ok(!encFetchErr && encFetch, `Error leyendo encuentro propio: ${encFetchErr?.message}`);
    assert.equal(encFetch.titulo.startsWith('Fase 1 Pre-Bridge Test'), true);
    console.log('      Contratos de consulta habitual verificados.');

    phase1Passed = true;
    console.log('\n>>> FASE 1 COMPLETADA CON ÉXITO: 5/5 comprobaciones aprobadas con switches apagados.\n');

    // =========================================================================
    // FASE 2: TRANSFERENCIA Y CONCURRENCIA REALES
    // =========================================================================
    console.log('================================================================================');
    console.log('FASE 2: TRANSFERENCIA Y CONCURRENCIA REALES EN STAGING');
    console.log('================================================================================');

    console.log('Activando temporalmente cross_origin_bridge_enabled (cross_origin_manual_enabled permanece false)...');
    const { error: enableErr } = await adminClient.rpc('set_domain_migration_setting', {
      p_key: 'cross_origin_bridge_enabled',
      p_value: true,
    });
    if (enableErr) {
      throw new Error(`Fallo activando kill switch: ${enableErr.message}`);
    }
    killSwitchActivated = true;

    // Confirmación independiente de activación
    const { data: verifyActive, error: verifyActiveErr } = await adminClient
      .from('domain_migration_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['cross_origin_bridge_enabled', 'cross_origin_manual_enabled']);

    const bridgeNow = verifyActive?.find((s) => s.setting_key === 'cross_origin_bridge_enabled')?.setting_value;
    const manualNow = verifyActive?.find((s) => s.setting_key === 'cross_origin_manual_enabled')?.setting_value;

    assert.equal(bridgeNow, true, 'cross_origin_bridge_enabled debe estar activo');
    assert.equal(manualNow, false, 'cross_origin_manual_enabled debe PERMANECER estrictamente false');
    console.log('  Kill switch activado y verificado: bridge=true, manual=false.\n');

    // -------------------------------------------------------------------------
    // ESCENARIO A: CARRERA CONCURRENTE SIMULTÁNEA (4 Workers)
    // -------------------------------------------------------------------------
    console.log('--- ESCENARIO A: Carrera Concurrente Simultánea (4 Workers) ---');
    const sourceClientA = createClient(STAGING_URL, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const targetClientA = createClient(STAGING_URL, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: userSourceA, error: errSourceA } = await sourceClientA.auth.signInAnonymously();
    const { data: userTargetA, error: errTargetA } = await targetClientA.auth.signInAnonymously();
    assert.ok(userSourceA?.user && userTargetA?.user, `Fallo creación usuarios escenario A: ${errSourceA?.message || errTargetA?.message}`);

    const uid_SourceA = userSourceA.user.id;
    const uid_TargetA = userTargetA.user.id;
    trackedUserIds.push(uid_SourceA, uid_TargetA);
    console.log(`  Source A: ${uid_SourceA} | Target A: ${uid_TargetA}`);

    const encARes = await sourceClientA.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: `Staging Concurrency Escenario A ${crypto.randomUUID().slice(0, 8)}`,
        descripcion: 'Carrera simultánea de canje, reemisión, revocación y mensaje',
        fecha: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10),
        hora: '21:00',
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
        post_event_active_minutes: 45,
      },
    });
    assert.ok(encARes.data?.id, `Fallo crear encuentro Escenario A: ${JSON.stringify(sanitizeLog(encARes))}`);
    const encAId = encARes.data.id;
    trackedEncounterIds.push(encAId);

    const ticketARes = await sourceClientA.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_bridge',
      p_intended_target_user_id: uid_TargetA,
    });
    assert.equal(ticketARes.data?.ok, true, `Fallo emisión ticket A: ${JSON.stringify(sanitizeLog(ticketARes))}`);
    const ticketTokenA = ticketARes.data.ticket_token;
    const ticketHashA = crypto.createHash('sha256').update(ticketTokenA).digest('hex');
    trackedTicketHashes.push(ticketHashA);

    // Barrera de sincronización Promise
    let releaseBarrierA!: () => void;
    const barrierPromiseA = new Promise<void>((resolve) => {
      releaseBarrierA = resolve;
    });

    const workersA = [
      // Worker 1: Target canjea ticket
      (async () => {
        await barrierPromiseA;
        const res = await targetClientA.rpc('claim_domain_migration_ticket_seguro', { p_ticket_token: ticketTokenA });
        return { worker: 'claim', res };
      })(),
      // Worker 2: Source re-emite ticket
      (async () => {
        await barrierPromiseA;
        const res = await sourceClientA.rpc('create_domain_migration_ticket_seguro', {
          p_flow_mode: 'cross_origin_bridge',
          p_intended_target_user_id: uid_TargetA,
        });
        return { worker: 'create_ticket', res };
      })(),
      // Worker 3: Source revoca ticket
      (async () => {
        await barrierPromiseA;
        const res = await sourceClientA.rpc('revoke_my_pending_transfer_ticket');
        return { worker: 'revoke', res };
      })(),
      // Worker 4: Source publica mensaje
      (async () => {
        await barrierPromiseA;
        const res = await sourceClientA.rpc('publicar_mensaje_encuentro_seguro', {
          p_encuentro_id: encAId,
          p_contenido: 'Mensaje concurrente carrera Staging',
        });
        return { worker: 'message', res };
      })(),
    ];

    releaseBarrierA();
    const resultsA = await Promise.all(workersA);

    console.log('  Respuestas de workers en Escenario A:');
    for (const r of resultsA) {
      console.log(`    Worker [${r.worker}]:`, sanitizeLog(r.res.data || r.res.error));
    }

    const claimResA = resultsA.find((r) => r.worker === 'claim')!.res;
    const createResA = resultsA.find((r) => r.worker === 'create_ticket')!.res;
    const revokeResA = resultsA.find((r) => r.worker === 'revoke')!.res;
    const msgResA = resultsA.find((r) => r.worker === 'message')!.res;

    // Ausencia de errores de deadlock o timeout (40P01 / 55P03)
    for (const r of resultsA) {
      const errMsg = r.res.error?.message || '';
      assert.ok(!errMsg.includes('40P01'), `DEADLOCK DETECTADO en worker ${r.worker}: ${errMsg}`);
      assert.ok(!errMsg.includes('55P03'), `LOCK TIMEOUT DETECTADO en worker ${r.worker}: ${errMsg}`);
      assert.ok(!r.res.error, `Error no controlado en worker ${r.worker}: ${r.res.error?.message}`);
    }

    // Verificación en base de datos
    const { data: ticketDbA } = await adminClient
      .from('anonymous_transfer_tickets')
      .select('status, used_at, target_user_id_snapshot')
      .eq('token_hash', ticketHashA)
      .single();

    const { data: encDbA } = await adminClient
      .from('encuentros')
      .select('host_id')
      .eq('id', encAId)
      .single();

    assert.ok(ticketDbA && encDbA, 'Ticket y encuentro deben existir en base de datos');

    if (claimResA.data?.ok === true) {
      console.log('    Resultado: El CANJE ganó la contienda concurrente.');
      assert.equal(ticketDbA.status, 'completed', 'Ticket status debe ser completed');
      assert.equal(ticketDbA.target_user_id_snapshot, uid_TargetA);
      assert.equal(encDbA.host_id, uid_TargetA, 'Encuentro debe pertenecer a Target');
      assert.equal(createResA.data?.ok, false, 'Re-emisión no puede haber tenido éxito');
    } else {
      console.log('    Resultado: La REVOCACIÓN ganó la contienda concurrente.');
      assert.equal(ticketDbA.status, 'revoked', 'Ticket status debe ser revoked');
      assert.equal(claimResA.data?.ok, false);
      assert.equal(claimResA.data?.error, 'ticket_revoked');
      assert.equal(encDbA.host_id, uid_SourceA, 'Encuentro debe permanecer en Source');
    }
    phase2ScenariosPassed++;
    console.log('  -> Escenario A completado con éxito (0 interbloqueos, 0 errores 40P01).\n');

    // -------------------------------------------------------------------------
    // ESCENARIO B: TRANSFERENCIA EXITOSA, RECHAZO DE TERCERO Y RETIRO DE SESIÓN
    // -------------------------------------------------------------------------
    console.log('--- ESCENARIO B: Transferencia Exitosa, Rechazo Tercero C y Retiro de Sesión ---');
    const sourceClientB = createClient(STAGING_URL, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const targetClientB = createClient(STAGING_URL, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const thirdPartyClient = createClient(STAGING_URL, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: userSourceB } = await sourceClientB.auth.signInAnonymously();
    const { data: userTargetB } = await targetClientB.auth.signInAnonymously();
    const { data: userThirdParty } = await thirdPartyClient.auth.signInAnonymously();

    assert.ok(userSourceB?.user && userTargetB?.user && userThirdParty?.user, 'Fallo creación identidades Escenario B');
    const uid_SourceB = userSourceB.user.id;
    const uid_TargetB = userTargetB.user.id;
    const uid_ThirdParty = userThirdParty.user.id;
    trackedUserIds.push(uid_SourceB, uid_TargetB, uid_ThirdParty);
    console.log(`  Source B: ${uid_SourceB} | Target B: ${uid_TargetB} | Tercero C: ${uid_ThirdParty}`);

    const encBRes = await sourceClientB.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: `Staging Transfer Escenario B ${crypto.randomUUID().slice(0, 8)}`,
        descripcion: 'Verificación exhaustiva de titularidad, retiro y anti-tercero',
        fecha: new Date(Date.now() + 86400000 * 4).toISOString().slice(0, 10),
        hora: '20:00',
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
        post_event_active_minutes: 60,
      },
    });
    assert.ok(encBRes.data?.id, `Fallo crear encuentro Escenario B: ${JSON.stringify(sanitizeLog(encBRes))}`);
    const encBId = encBRes.data.id;
    trackedEncounterIds.push(encBId);

    const ticketBRes = await sourceClientB.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_bridge',
      p_intended_target_user_id: uid_TargetB,
    });
    assert.equal(ticketBRes.data?.ok, true, `Fallo emisión ticket B: ${JSON.stringify(sanitizeLog(ticketBRes))}`);
    const ticketTokenB = ticketBRes.data.ticket_token;
    const ticketHashB = crypto.createHash('sha256').update(ticketTokenB).digest('hex');
    trackedTicketHashes.push(ticketHashB);

    // B.1 Intento de canje por Tercero NO autorizado (Tercero C)
    console.log('  B.1 Probando intento de canje por Tercero NO Autorizado C...');
    const thirdPartyClaimRes = await thirdPartyClient.rpc('claim_domain_migration_ticket_seguro', {
      p_ticket_token: ticketTokenB,
    });
    assert.equal(thirdPartyClaimRes.data?.ok, false, 'Tercero C NO debe poder canjear el ticket de Target B');
    assert.equal(thirdPartyClaimRes.data?.error, 'ticket_target_mismatch', 'Error esperado: ticket_target_mismatch');
    console.log('      Rechazo de Tercero C verificado inequívocamente: ticket_target_mismatch.');

    // Comprobar que el ticket permanece intacto en DB para Target B
    const { data: ticketDbPreB } = await adminClient
      .from('anonymous_transfer_tickets')
      .select('status, target_user_id_snapshot')
      .eq('token_hash', ticketHashB)
      .single();
    assert.equal(ticketDbPreB?.status, 'pending', 'Ticket debe continuar pending tras rechazo de atacante');
    console.log('      Ticket permanece pending y sin desgaste (anti-DoS verificado).');

    // B.2 Canje legítimo por Target B
    console.log('  B.2 Ejecutando canje legítimo por Target B...');
    const claimResB = await targetClientB.rpc('claim_domain_migration_ticket_seguro', {
      p_ticket_token: ticketTokenB,
    });
    assert.equal(claimResB.data?.ok, true, `Canje legítimo falló: ${JSON.stringify(sanitizeLog(claimResB))}`);
    console.log('      Canje legítimo por Target B completado exitosamente.');

    // B.3 Confirmación idempotente post-commit
    console.log('  B.3 Ejecutando confirmar_migracion_dominio_completada_seguro por Target B...');
    const confirmResB = await targetClientB.rpc('confirmar_migracion_dominio_completada_seguro', {
      p_ticket_token: ticketTokenB,
    });
    assert.equal(confirmResB.data?.ok, true, 'Confirmación post-commit debe ser exitosa');
    assert.equal(confirmResB.data?.already_completed, true, 'Debe indicar already_completed = true');
    console.log('      Confirmación idempotente post-commit verificada.');

    // B.4 Verificación de titularidades en DB
    const { data: encDbB } = await adminClient
      .from('encuentros')
      .select('host_id')
      .eq('id', encBId)
      .single();
    assert.equal(encDbB?.host_id, uid_TargetB, 'El encuentro fue transferido a Target B');

    const { data: ticketDbB } = await adminClient
      .from('anonymous_transfer_tickets')
      .select('status, target_user_id_snapshot, resources_transferred')
      .eq('token_hash', ticketHashB)
      .single();
    assert.equal(ticketDbB?.status, 'completed');
    assert.equal(ticketDbB?.target_user_id_snapshot, uid_TargetB);
    console.log('      Titularidades en base de datos validadas: host_id actualizado y ticket completed.');

    // B.5 Verificación de retiro de sesión: Source B NO puede escribir ni crear nuevos recursos
    console.log('  B.5 Verificando blindaje ante sesión retirada (Source B)...');
    const retiredMsgRes = await sourceClientB.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encBId,
      p_contenido: 'Intento de mensaje de sesión retirada',
    });
    assert.equal(retiredMsgRes.data?.ok, false, 'Source B retirado NO puede publicar mensajes');
    assert.equal(retiredMsgRes.data?.error, 'anonymous_session_already_migrated');

    const retiredCreateEncRes = await sourceClientB.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: 'Intento ilegal tras retiro',
        descripcion: 'No debe permitirse',
        fecha: new Date(Date.now() + 86400000 * 5).toISOString().slice(0, 10),
        hora: '18:00',
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
      },
    });
    // Debe devolver ok: false o lanzar error de sesión retirada
    assert.ok(
      retiredCreateEncRes.error || retiredCreateEncRes.data?.ok === false,
      'Source B retirado NO puede crear nuevos encuentros'
    );
    console.log('      Bloqueo de escritura y creación para sesión retirada comprobado.');

    // B.6 Verificación de que Target B puede publicar mensajes normalmente
    console.log('  B.6 Verificando permisos operativos plenos de Target B sobre el encuentro transferido...');
    const targetMsgRes = await targetClientB.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encBId,
      p_contenido: 'Mensaje legítimo emitido por el nuevo host Target B',
    });
    assert.equal(targetMsgRes.data?.ok, true, `Target B no pudo publicar mensaje: ${JSON.stringify(sanitizeLog(targetMsgRes))}`);
    console.log('      Target B operativo como anfitrión del encuentro transferido.');

    phase2ScenariosPassed++;
    console.log('  -> Escenario B completado con éxito (Transferencia total + Anti-Tercero + Retiro).\n');

    // -------------------------------------------------------------------------
    // ESCENARIO C: REVOCACIÓN PREVIA ANTES DE CANJE
    // -------------------------------------------------------------------------
    console.log('--- ESCENARIO C: Revocación Previa de Ticket y Rechazo de Canje ---');
    const sourceClientC = createClient(STAGING_URL, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const targetClientC = createClient(STAGING_URL, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: userSourceC } = await sourceClientC.auth.signInAnonymously();
    const { data: userTargetC } = await targetClientC.auth.signInAnonymously();
    assert.ok(userSourceC?.user && userTargetC?.user, 'Fallo creación identidades Escenario C');

    const uid_SourceC = userSourceC.user.id;
    const uid_TargetC = userTargetC.user.id;
    trackedUserIds.push(uid_SourceC, uid_TargetC);

    const encCRes = await sourceClientC.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: `Staging Revocation Escenario C ${crypto.randomUUID().slice(0, 8)}`,
        descripcion: 'Verificación de revocación determinística',
        fecha: new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10),
        hora: '17:00',
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
      },
    });
    assert.ok(encCRes.data?.id, 'Fallo al crear encuentro Escenario C');
    const encCId = encCRes.data.id;
    trackedEncounterIds.push(encCId);

    const ticketCRes = await sourceClientC.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_bridge',
      p_intended_target_user_id: uid_TargetC,
    });
    assert.equal(ticketCRes.data?.ok, true, 'Fallo emisión ticket C');
    const ticketTokenC = ticketCRes.data.ticket_token;
    const ticketHashC = crypto.createHash('sha256').update(ticketTokenC).digest('hex');
    trackedTicketHashes.push(ticketHashC);

    // C.1 Revocación por Source C
    console.log('  C.1 Source C ejecuta revocación de su ticket pendiente...');
    const revokeCRes = await sourceClientC.rpc('revoke_my_pending_transfer_ticket');
    assert.equal(revokeCRes.data?.ok, true, 'Revocación debe ser exitosa');

    // C.2 Target C intenta canjear el ticket revocado
    console.log('  C.2 Target C intenta canjear el ticket revocado...');
    const claimCRes = await targetClientC.rpc('claim_domain_migration_ticket_seguro', {
      p_ticket_token: ticketTokenC,
    });
    assert.equal(claimCRes.data?.ok, false, 'Canje de ticket revocado debe ser rechazado');
    assert.equal(claimCRes.data?.error, 'ticket_revoked', 'Error esperado: ticket_revoked');

    // C.3 Encuentro debe pertenecer a Source C
    const { data: encDbC } = await adminClient.from('encuentros').select('host_id').eq('id', encCId).single();
    assert.equal(encDbC?.host_id, uid_SourceC, 'El encuentro permanece con Source C');

    phase2ScenariosPassed++;
    console.log('  -> Escenario C completado con éxito (Revocación antes de canje comprobada).\n');

    console.log('\n================================================================================');
    console.log(`FASE 2 COMPLETADA EXITOSAMENTE: ${phase2ScenariosPassed}/3 escenarios validados.`);
    console.log('================================================================================\n');
  } catch (err: any) {
    console.error('\n[EXCEPCIÓN DURANTE EJECUCIÓN QA]', err?.message || err);
    qaErrors.push(err?.message || String(err));
  } finally {
    // =========================================================================
    // FASE 3: RESTAURACIÓN Y LIMPIEZA OBLIGATORIAS (RESIDUO CERO)
    // =========================================================================
    console.log('\n================================================================================');
    console.log('FASE 3: RESTAURACIÓN DEL KILL SWITCH Y LIMPIEZA DE FIXTURES (RESIDUO CERO)');
    console.log('================================================================================');

    let killSwitchFailed = false;
    let cleanupFailed = false;
    let cleanupError: any = null;

    // 3.1 Restauración determinista de cross_origin_bridge_enabled a FALSE
    if (killSwitchActivated) {
      console.log('Paso 3.1: Restaurando cross_origin_bridge_enabled a false...');
      try {
        const { error: restoreErr } = await adminClient.rpc('set_domain_migration_setting', {
          p_key: 'cross_origin_bridge_enabled',
          p_value: false,
        });

        if (restoreErr) {
          console.error(`[ALERTA CRÍTICA]: Fallo al invocar set_domain_migration_setting(false): ${restoreErr.message}`);
          killSwitchFailed = true;
        }
      } catch (ksErr: any) {
        console.error(`[ALERTA CRÍTICA]: Excepción restaurando kill switch: ${ksErr?.message}`);
        killSwitchFailed = true;
      }
    }

    // 3.2 Verificación Independiente por Lectura Directa: AMBOS DEBEN SER FALSE
    console.log('Paso 3.2: Verificación independiente de ambos kill switches...');
    try {
      const { data: finalSettings, error: finalSettingsErr } = await adminClient
        .from('domain_migration_settings')
        .select('setting_key, setting_value')
        .in('setting_key', ['cross_origin_bridge_enabled', 'cross_origin_manual_enabled']);

      const finalBridge = finalSettings?.find((s) => s.setting_key === 'cross_origin_bridge_enabled')?.setting_value;
      const finalManual = finalSettings?.find((s) => s.setting_key === 'cross_origin_manual_enabled')?.setting_value;

      if (finalSettingsErr || finalBridge !== false || finalManual !== false) {
        console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        console.error(`[ALERTA CRÍTICA DE SEGURIDAD]: Fallo al verificar restauración de kill switches!`);
        console.error(`  Esperado: bridge=false, manual=false | Encontrado: bridge=${finalBridge}, manual=${finalManual}`);
        console.error(`PROCEDIMIENTO MANUAL DE EMERGENCIA:`);
        console.error(`  UPDATE public.domain_migration_settings SET setting_value = false WHERE setting_key IN ('cross_origin_bridge_enabled', 'cross_origin_manual_enabled');`);
        console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
        killSwitchFailed = true;
      } else {
        console.log(`  Confirmado: cross_origin_bridge_enabled === false, cross_origin_manual_enabled === false.`);
      }
    } catch (err: any) {
      console.error(`[ALERTA CRÍTICA]: Excepción verificando switches: ${err?.message}`);
      killSwitchFailed = true;
    }

    // 3.3 Eliminación exhaustiva en orden FK estricto de todos los fixtures registrados
    console.log(`Paso 3.3: Eliminando fixtures registrados (${trackedEncounterIds.length} encuentros, ${trackedUserIds.length} usuarios)...`);
    try {
      if (trackedEncounterIds.length > 0 || trackedUserIds.length > 0) {
        // Mensajes
        if (trackedEncounterIds.length > 0) {
          await adminClient.from('mensajes_encuentro').delete().in('encuentro_id', trackedEncounterIds);
        }
        if (trackedUserIds.length > 0) {
          await adminClient.from('mensajes_encuentro').delete().in('autor_user_id', trackedUserIds);
        }

        // Participantes
        if (trackedEncounterIds.length > 0) {
          await adminClient.from('participantes').delete().in('encuentro_id', trackedEncounterIds);
        }
        if (trackedUserIds.length > 0) {
          await adminClient.from('participantes').delete().in('user_id', trackedUserIds);
        }

        // Encuentros
        if (trackedEncounterIds.length > 0) {
          await adminClient.from('encuentros').delete().in('id', trackedEncounterIds);
        }
        if (trackedUserIds.length > 0) {
          await adminClient.from('encuentros').delete().in('host_id', trackedUserIds);
        }

        // Tickets (por source, target o intended_target)
        if (trackedUserIds.length > 0) {
          await adminClient.from('anonymous_transfer_tickets').delete().in('source_user_id_snapshot', trackedUserIds);
          await adminClient.from('anonymous_transfer_tickets').delete().in('target_user_id_snapshot', trackedUserIds);
          await adminClient.from('anonymous_transfer_tickets').delete().in('intended_target_user_id', trackedUserIds);
        }
        if (trackedTicketHashes.length > 0) {
          await adminClient.from('anonymous_transfer_tickets').delete().in('token_hash', trackedTicketHashes);
        }

        // Notificaciones y Rate limits
        if (trackedUserIds.length > 0) {
          await adminClient.from('inbox_notifications').delete().in('recipient_user_id', trackedUserIds);
          await adminClient.from('notification_delivery_outbox').delete().in('recipient_user_id', trackedUserIds);
          await adminClient.from('rate_limit_buckets').delete().in('user_id', trackedUserIds);
        }

        // Eliminación de identidades en Auth
        for (const uid of trackedUserIds) {
          const { error: delUserErr } = await adminClient.auth.admin.deleteUser(uid);
          if (delUserErr && !delUserErr.message.includes('User not found')) {
            console.warn(`Advertencia al eliminar usuario auth ${uid}: ${delUserErr.message}`);
          }
        }
      }

      // 3.4 Verificación Estricta de Residuo Cero
      console.log('Paso 3.4: Verificando Residuo Cero en Staging...');
      const residueChecks = [
        { name: 'encuentros (por id)', query: adminClient.from('encuentros').select('*', { count: 'exact', head: true }).in('id', trackedEncounterIds) },
        { name: 'encuentros (por host_id)', query: adminClient.from('encuentros').select('*', { count: 'exact', head: true }).in('host_id', trackedUserIds) },
        { name: 'tickets (por source)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('source_user_id_snapshot', trackedUserIds) },
        { name: 'tickets (por target)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('target_user_id_snapshot', trackedUserIds) },
        { name: 'tickets (por intended)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('intended_target_user_id', trackedUserIds) },
        { name: 'tickets (por hash)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('token_hash', trackedTicketHashes) },
        { name: 'mensajes (por encuentro)', query: adminClient.from('mensajes_encuentro').select('*', { count: 'exact', head: true }).in('encuentro_id', trackedEncounterIds) },
        { name: 'mensajes (por autor)', query: adminClient.from('mensajes_encuentro').select('*', { count: 'exact', head: true }).in('autor_user_id', trackedUserIds) },
        { name: 'participantes (por encuentro)', query: adminClient.from('participantes').select('*', { count: 'exact', head: true }).in('encuentro_id', trackedEncounterIds) },
        { name: 'participantes (por user_id)', query: adminClient.from('participantes').select('*', { count: 'exact', head: true }).in('user_id', trackedUserIds) },
        { name: 'notificaciones (recipient)', query: adminClient.from('inbox_notifications').select('*', { count: 'exact', head: true }).in('recipient_user_id', trackedUserIds) },
        { name: 'outbox (recipient)', query: adminClient.from('notification_delivery_outbox').select('*', { count: 'exact', head: true }).in('recipient_user_id', trackedUserIds) },
        { name: 'rate_limits (user_id)', query: adminClient.from('rate_limit_buckets').select('*', { count: 'exact', head: true }).in('user_id', trackedUserIds) },
      ];

      for (const check of residueChecks) {
        const { count, error } = await check.query;
        if (error) {
          throw new Error(`Error en chequeo de residuo [${check.name}]: ${error.message}`);
        }
        if (count === null || count === undefined) {
          throw new Error(`Residuo indeterminado en [${check.name}]: count retornó null/undefined.`);
        }
        assert.equal(count, 0, `Residuo detectado en ${check.name}: se encontraron ${count} filas`);
      }

      console.log('  -> Residuo Cero confirmado en todas las tablas de negocio, tickets y cuotas.');
    } catch (cleanErr: any) {
      cleanupFailed = true;
      cleanupError = cleanErr;
      qaErrors.push(`Fallo de limpieza: ${cleanErr?.message}`);

      // Manifiesto Seguro SIN SECRETOS ante fallos
      const secureManifest = {
        run_id: runId,
        timestamp: new Date().toISOString(),
        status: 'CLEANUP_FAILED',
        error: cleanErr?.message || String(cleanErr),
        trackedUserIds,
        trackedEncounterIds,
        trackedTicketHashes, // Hashes SHA256 únicamente (CERO tokens ni secretos)
      };

      const manifestPath = path.resolve(process.cwd(), `recovery-manifest-staging-${runId}.json`);
      try {
        fs.writeFileSync(manifestPath, JSON.stringify(secureManifest, null, 2), 'utf8');
        console.error(`\n[CRITICAL ERROR] Limpieza en Staging incompleta.`);
        console.error(`Manifiesto seguro de IDs guardado en: ${manifestPath}\n`);
      } catch (writeErr) {
        console.error('Error escribiendo manifiesto seguro:', writeErr);
      }
    }

    if (killSwitchFailed) {
      throw new Error('[ALERTA CRÍTICA]: Falló la restauración/verificación del kill switch. Kill switch debe estar en false.');
    }

    if (cleanupFailed) {
      throw new Error(`[STAGING QA FALLIDO]: Fallo de limpieza o comprobación de residuo cero: ${cleanupError?.message}`);
    }

    if (qaErrors.length > 0) {
      throw new Error(`[STAGING QA FALLIDO]: Se produjeron ${qaErrors.length} errores funcionales:\n${qaErrors.join('\n')}`);
    }

    console.log('\n================================================================================');
    console.log('RESULTADO FINAL: [QA DE PUENTE DE IDENTIDAD COMPLETADO SATISFACTORIAMENTE]');
    console.log('  1. Fase 1 (Switches apagados): 5/5 validaciones de seguridad superadas.');
    console.log('  2. Fase 2 (Transferencia y concurrencia): 3/3 escenarios aprobados.');
    console.log('  3. Ausencia de interbloqueos (40P01) y timeouts bajo contención simultánea.');
    console.log('  4. Control anti-tercero (ticket_target_mismatch) y retiro de sesión verificado.');
    console.log('  5. Fase 3 (Restauración y limpieza): Kill switches en false y Residuo Cero.');
    console.log('================================================================================\n');

    return {
      runId,
      success: true,
      phase1Passed,
      phase2ScenariosPassed,
      phase3Cleaned: !cleanupFailed,
      errors: qaErrors,
    };
  }
}

// Invocación CLI directa
const isDirectRun = process.argv[1]?.endsWith('staging-qa-concurrency-bridge.ts');
if (isDirectRun) {
  runStagingConcurrencyQA()
    .then((res) => {
      if (!res.success) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[CRITICAL RUNNER ERROR]', err);
      process.exit(1);
    });
}
