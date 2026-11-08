/**
 * Runner de Integración y Concurrencia en Supabase Staging
 * Mini-Sprint 2B-2: Puente de Identidad entre Dominios
 *
 * ====================================================================================
 * ¡ATENCIÓN! COMPUERTA DE SEGURIDAD OBLIGATORIA (Mini-Sprint 2B-1):
 * Este runner está preparado EXCLUSIVAMENTE para la sesión remota de Staging (2B-2).
 * NO DEBE EJECUTARSE durante el Mini-Sprint 2B-1 ni mientras no se autorice la
 * aplicación de migraciones en Staging.
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

async function runStagingConcurrencyQA() {
  console.log('================================================================================');
  console.log('INICIANDO STAGING QA: CONCURRENCIA DE PUENTE DE IDENTIDAD (2B-2)');
  console.log(`Target Supabase URL: ${STAGING_URL} (Ref: ${STAGING_PROJECT_REF})`);
  console.log(`Protección anti-producción activa: Prohibido ${PRODUCTION_PROJECT_REF}`);
  console.log('================================================================================\n');

  const adminKey = getStagingSecretKey();
  const publishableKey = getStagingPublishableKey();

  const adminClient = createClient(STAGING_URL, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Preflight de Privilegios: Verificar que service_role tiene permisos efectivos
  console.log('Paso 0: Preflight de privilegios administrativos y RLS...');
  const privilegeChecks = [
    { table: 'anonymous_transfer_tickets', query: adminClient.from('anonymous_transfer_tickets').select('id', { head: true, count: 'exact' }) },
    { table: 'domain_migration_settings', query: adminClient.from('domain_migration_settings').select('setting_key', { head: true, count: 'exact' }) },
    { table: 'encuentros', query: adminClient.from('encuentros').select('id', { head: true, count: 'exact' }) },
    { table: 'mensajes_encuentro', query: adminClient.from('mensajes_encuentro').select('id', { head: true, count: 'exact' }) },
    { table: 'inbox_notifications', query: adminClient.from('inbox_notifications').select('id', { head: true, count: 'exact' }) },
  ];

  for (const check of privilegeChecks) {
    const { error } = await check.query;
    if (error) {
      throw new Error(`[PREFLIGHT FALLIDO] service_role carece de permisos sobre '${check.table}': ${error.message} (${error.code})`);
    }
  }
  console.log('  Privilegios de service_role validados.');

  // Control estricto del Kill Switch: requiere autorización expresa
  let previousBridgeSetting = false;
  if (process.env.STAGING_ENABLE_BRIDGE_KILL_SWITCH !== '1') {
    throw new Error(
      '[KILL SWITCH GUARD]: El puente de identidad cross-origin está desactivado por defecto.\n' +
      'Para habilitarlo temporalmente durante la prueba de concurrencia se requiere STAGING_ENABLE_BRIDGE_KILL_SWITCH === "1".\n' +
      'El runner no modificará el estado del kill switch sin esta autorización explícita.'
    );
  }

  // Leer estado anterior para restaurarlo determinísticamente en finally
  const { data: initialSetting, error: settingReadErr } = await adminClient
    .from('domain_migration_settings')
    .select('setting_value')
    .eq('setting_key', 'cross_origin_bridge_enabled')
    .maybeSingle();

  if (settingReadErr) {
    throw new Error(`Error leyendo domain_migration_settings: ${settingReadErr.message}`);
  }
  previousBridgeSetting = initialSetting?.setting_value ?? false;

  console.log(`  Estado previo de 'cross_origin_bridge_enabled': ${previousBridgeSetting}`);
  console.log('  Activando temporalmente kill switch para la prueba con autorización explícita...');
  const { error: setErr } = await adminClient.rpc('set_domain_migration_setting', {
    p_key: 'cross_origin_bridge_enabled',
    p_value: true,
  });
  if (setErr) {
    throw new Error(`Fallo activando kill switch temporal: ${setErr.message}`);
  }

  const trackedUserIds: string[] = [];
  const trackedEncounterIds: string[] = [];
  const trackedTicketTokens: string[] = [];
  let testExecutionFailed = false;

  try {
    // 2. Crear clientes y sesiones anónimas reales vía GoTrue
    console.log('\nPaso 1: Creando identidades anónimas de prueba en GoTrue Staging...');
    const sourceClient = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const targetClient = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: anonSourceData, error: anonSourceErr } = await sourceClient.auth.signInAnonymously();
    if (anonSourceErr || !anonSourceData.user) {
      throw new Error(`Fallo signInAnonymously Source: ${anonSourceErr?.message}`);
    }
    const uid_Source = anonSourceData.user.id;
    trackedUserIds.push(uid_Source);

    const { data: anonTargetData, error: anonTargetErr } = await targetClient.auth.signInAnonymously();
    if (anonTargetErr || !anonTargetData.user) {
      throw new Error(`Fallo signInAnonymously Target: ${anonTargetErr?.message}`);
    }
    const uid_Target = anonTargetData.user.id;
    trackedUserIds.push(uid_Target);

    console.log(`  Source UID (anónimo): ${uid_Source}`);
    console.log(`  Target UID (anónimo): ${uid_Target}`);

    // 3. Crear encuentro de prueba mediante la RPC productiva autenticada respetando firma (p_data jsonb)
    console.log('Paso 2: Creando encuentro de prueba para Source mediante crear_encuentro_seguro(p_data)...');
    const encPayload = {
      titulo: `Staging Concurrency QA ${crypto.randomUUID().slice(0, 8)}`,
      descripcion: 'Encuentro para auditoría de concurrencia y carrera de transferencia',
      fecha: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10),
      hora: '21:00',
      modalidad: 'presencial',
      tipo_invitacion: 'link_general',
      post_event_active_minutes: 45,
    };

    const encRes = await sourceClient.rpc('crear_encuentro_seguro', { p_data: encPayload });

    if (encRes.error || !encRes.data?.id) {
      throw new Error(`Fallo al crear encuentro: ${JSON.stringify(encRes.error || encRes.data)}`);
    }
    const encId = encRes.data.id;
    trackedEncounterIds.push(encId);
    console.log(`  Encuentro creado con éxito: ${encId}`);

    // 4. Emitir ticket de transferencia para el Target
    console.log('Paso 3: Emitiendo ticket de transferencia cross_origin_bridge...');
    const ticketRes = await sourceClient.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_bridge',
      p_intended_target_user_id: uid_Target,
    });

    if (ticketRes.error || !ticketRes.data?.ok || !ticketRes.data?.ticket_token) {
      throw new Error(`Fallo emisión ticket: ${JSON.stringify(ticketRes.error || ticketRes.data)}`);
    }
    const ticketToken = ticketRes.data.ticket_token;
    trackedTicketTokens.push(ticketToken);
    console.log(`  Ticket emitido. Token: ${ticketToken.slice(0, 10)}... (TTL: ${ticketRes.data.expires_in_seconds}s)`);

    // 5. Barrera de Sincronización Promise para 4 workers simultáneos sobre PostgREST/HTTP
    console.log('Paso 4: Despachando 4 operaciones concurrentes simultáneas contra PostgREST...');
    let releaseBarrier!: () => void;
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const workerPromises = [
      // Worker 1: Target canjea ticket
      (async () => {
        await barrierPromise;
        const res = await targetClient.rpc('claim_domain_migration_ticket_seguro', {
          p_ticket_token: ticketToken,
        });
        return { worker: 'claim', res };
      })(),

      // Worker 2: Source re-emite ticket
      (async () => {
        await barrierPromise;
        const res = await sourceClient.rpc('create_domain_migration_ticket_seguro', {
          p_flow_mode: 'cross_origin_bridge',
          p_intended_target_user_id: uid_Target,
        });
        return { worker: 'create_ticket', res };
      })(),

      // Worker 3: Source revoca ticket
      (async () => {
        await barrierPromise;
        const res = await sourceClient.rpc('revoke_my_pending_transfer_ticket');
        return { worker: 'revoke', res };
      })(),

      // Worker 4: Source publica mensaje
      (async () => {
        await barrierPromise;
        const res = await sourceClient.rpc('publicar_mensaje_encuentro_seguro', {
          p_encuentro_id: encId,
          p_contenido: 'Mensaje concurrente en Staging',
        });
        return { worker: 'message', res };
      })(),
    ];

    // Disparo sincronizado
    releaseBarrier();
    const results = await Promise.all(workerPromises);

    console.log('Paso 5: Analizando respuestas de cada worker...');
    for (const r of results) {
      if (r.res.error && !['PGRST', '23', '40', '55'].some((prefix) => r.res.error.code?.startsWith(prefix))) {
        // Loguear errores inesperados
      }
      console.log(`  ${r.worker}:`, r.res.data || r.res.error);
    }

    const claimRes = results.find((r) => r.worker === 'claim')!.res;
    const createRes = results.find((r) => r.worker === 'create_ticket')!.res;
    const revokeRes = results.find((r) => r.worker === 'revoke')!.res;
    const msgRes = results.find((r) => r.worker === 'message')!.res;

    // Ningún error no controlado de red o PostgREST debe ser ignorado
    assert.ok(!claimRes.error, `Error no controlado en Worker claim: ${claimRes.error?.message}`);
    assert.ok(!createRes.error, `Error no controlado en Worker create_ticket: ${createRes.error?.message}`);
    assert.ok(!revokeRes.error, `Error no controlado en Worker revoke: ${revokeRes.error?.message}`);
    assert.ok(!msgRes.error, `Error no controlado en Worker message: ${msgRes.error?.message}`);

    // 6. Verificación de invariantes en Base de Datos vía Admin Client
    const { data: ticketDb, error: ticketDbErr } = await adminClient
      .from('anonymous_transfer_tickets')
      .select('status, used_at, target_user_id_snapshot')
      .eq('token_hash', crypto.createHash('sha256').update(ticketToken).digest('hex'))
      .single();

    if (ticketDbErr || !ticketDb) {
      throw new Error(`No se pudo verificar el estado del ticket en DB: ${ticketDbErr?.message}`);
    }

    const { data: encDb, error: encDbErr } = await adminClient
      .from('encuentros')
      .select('host_id')
      .eq('id', encId)
      .single();

    if (encDbErr || !encDb) {
      throw new Error(`No se pudo verificar el encuentro en DB: ${encDbErr?.message}`);
    }

    if (claimRes.data?.ok === true) {
      console.log('  -> PERMUTACIÓN A: El canje ganó la carrera de concurrencia.');
      assert.equal(ticketDb.status, 'completed', 'Ticket debe estar en status completed');
      assert.ok(ticketDb.used_at, 'used_at debe estar presente');
      assert.equal(ticketDb.target_user_id_snapshot, uid_Target);
      assert.equal(encDb.host_id, uid_Target, 'El encuentro debe haber sido transferido al Target');
      assert.equal(createRes.data?.ok, false, 'Re-emisión no puede haber tenido éxito');
      assert.ok(
        ['transfer_ticket_already_pending', 'anonymous_session_already_migrated'].includes(createRes.data?.error),
        'Re-emisión debe fallar con error esperado'
      );

      // Verificación de mensajería frente a retiro de identidad
      if (msgRes.data?.ok === true) {
        const { data: msgDb } = await adminClient
          .from('mensajes_encuentro')
          .select('autor_user_id')
          .eq('encuentro_id', encId)
          .single();
        if (msgDb) {
          assert.equal(msgDb.autor_user_id, uid_Target, 'Si el mensaje se publicó antes del canje, debe pertenecer a Target');
        }
      } else {
        assert.equal(msgRes.data?.error, 'anonymous_session_already_migrated');
      }
    } else {
      console.log('  -> PERMUTACIÓN B: La revocación ganó la carrera de concurrencia.');
      assert.equal(ticketDb.status, 'revoked', 'Ticket debe estar en status revoked');
      assert.equal(claimRes.data?.ok, false);
      assert.equal(claimRes.data?.error, 'ticket_revoked');
      assert.equal(encDb.host_id, uid_Source, 'El encuentro debe permanecer en Source');
    }

    console.log('\n================================================================================');
    console.log('STAGING CONCURRENCY QA: APROBADO CON ÉXITO');
    console.log('  - Cero inconsistencias de estado.');
    console.log('  - Cero bypass de permisos o identidades.');
    console.log('  - Jerarquía de locks validada bajo PostgREST HTTP concurrent requests.');
    console.log('================================================================================\n');
  } catch (err: any) {
    testExecutionFailed = true;
    throw err;
  } finally {
    // 7. Restauración del Kill Switch y Limpieza Determinista con Residuo Cero
    console.log('Paso 6: Restaurando estado de Kill Switch y ejecutando limpieza...');
    let cleanupFailed = false;
    let cleanupError: any = null;

    try {
      // Restaurar estado anterior del kill switch
      await adminClient.rpc('set_domain_migration_setting', {
        p_key: 'cross_origin_bridge_enabled',
        p_value: previousBridgeSetting,
      });

      // Limpieza exhaustiva de fixtures
      if (trackedEncounterIds.length > 0) {
        const { error: msgErr } = await adminClient.from('mensajes_encuentro').delete().in('encuentro_id', trackedEncounterIds);
        if (msgErr) throw msgErr;
        const { error: partErr } = await adminClient.from('participantes').delete().in('encuentro_id', trackedEncounterIds);
        if (partErr) throw partErr;
        const { error: encErr } = await adminClient.from('encuentros').delete().in('id', trackedEncounterIds);
        if (encErr) throw encErr;
      }

      if (trackedUserIds.length > 0) {
        const { error: t1Err } = await adminClient.from('anonymous_transfer_tickets').delete().in('source_user_id_snapshot', trackedUserIds);
        if (t1Err) throw t1Err;
        const { error: t2Err } = await adminClient.from('anonymous_transfer_tickets').delete().in('target_user_id_snapshot', trackedUserIds);
        if (t2Err) throw t2Err;
        const { error: rlErr } = await adminClient.from('rate_limit_buckets').delete().in('user_id', trackedUserIds);
        if (rlErr) throw rlErr;
        // Columna real: recipient_user_id
        const { error: notifErr } = await adminClient.from('inbox_notifications').delete().in('recipient_user_id', trackedUserIds);
        if (notifErr) throw notifErr;
        const { error: outboxErr } = await adminClient.from('notification_delivery_outbox').delete().in('recipient_user_id', trackedUserIds);
        if (outboxErr) throw outboxErr;

        for (const uid of trackedUserIds) {
          await adminClient.auth.admin.deleteUser(uid);
        }
      }

      // Verificación estricta de residuo cero (prohibido asumir count === null como 0)
      const residueTables = [
        { name: 'encuentros', query: adminClient.from('encuentros').select('*', { count: 'exact', head: true }).in('id', trackedEncounterIds) },
        { name: 'tickets', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('source_user_id_snapshot', trackedUserIds) },
        { name: 'mensajes', query: adminClient.from('mensajes_encuentro').select('*', { count: 'exact', head: true }).in('encuentro_id', trackedEncounterIds) },
        { name: 'notificaciones', query: adminClient.from('inbox_notifications').select('*', { count: 'exact', head: true }).in('recipient_user_id', trackedUserIds) },
      ];

      for (const t of residueTables) {
        const { count, error } = await t.query;
        if (error) {
          throw new Error(`Error al verificar residuo en ${t.name}: ${error.message}`);
        }
        if (count === null || count === undefined) {
          throw new Error(`Residuo indeterminado en ${t.name}: count retornó null/undefined.`);
        }
        assert.equal(count, 0, `Residuo en ${t.name} debe ser estrictamente 0, encontrado: ${count}`);
      }

      console.log('  Limpieza verificada: 0 registros residuales en Staging.');
    } catch (cleanupErr: any) {
      cleanupFailed = true;
      cleanupError = cleanupErr;

      // Preservar manifiesto de recuperación segura en disco
      const manifest = {
        timestamp: new Date().toISOString(),
        status: 'CLEANUP_FAILED',
        error: cleanupErr?.message || String(cleanupErr),
        trackedUserIds,
        trackedEncounterIds,
        trackedTicketTokens,
      };
      const manifestPath = path.resolve(process.cwd(), `recovery-manifest-staging-concurrency-${Date.now()}.json`);
      try {
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        console.error(`\n[CRITICAL ERROR] Limpieza en Staging falló.`);
        console.error(`Manifiesto de IDs para remediación segura guardado en: ${manifestPath}\n`);
      } catch (writeErr) {
        console.error(`Error guardando manifiesto:`, writeErr);
      }
    }

    if (cleanupFailed) {
      throw new Error(`[STAGING QA FALLIDO]: Fallo de limpieza o verificación de residuo cero: ${cleanupError?.message}`);
    }
  }
}

runStagingConcurrencyQA().catch((err) => {
  console.error('[STAGING QA ERROR]', err);
  process.exit(1);
});
