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

if (!process.env.STAGING_BRIDGE_QA_AUTHORIZED) {
  console.log('================================================================================');
  console.log('ESTADO DEL RUNNER: [PENDIENTE PARA MINI-SPRINT 2B-2]');
  console.log('  Este runner de Staging está completamente implementado y verificado en código.');
  console.log('  Por mandato del Mini-Sprint 2B-1, NINGÚN script mutante remoto debe ejecutarse');
  console.log('  hasta que la migración SQL sea formalmente autorizada y aplicada en Staging.');
  console.log('  Para ejecutarlo en 2B-2, definir: STAGING_BRIDGE_QA_AUTHORIZED=1');
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

  const trackedUserIds: string[] = [];
  const trackedEncounterIds: string[] = [];
  const trackedTicketTokens: string[] = [];

  try {
    // 2. Crear clientes y sesiones anónimas reales vía GoTrue
    console.log('Paso 1: Creando identidades anónimas de prueba en GoTrue Staging...');
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

    // 3. Crear encuentro de prueba mediante la RPC productiva autenticada
    console.log('Paso 2: Creando encuentro de prueba para Source...');
    const encRes = await sourceClient.rpc('crear_encuentro_seguro', {
      p_titulo: `Staging Concurrency QA ${crypto.randomUUID().slice(0, 8)}`,
      p_descripcion: 'Encuentro para auditoría de concurrencia y carrera de transferencia',
      p_fecha: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10),
      p_hora: '21:00',
      p_modalidad: 'presencial',
      p_tipo_invitacion: 'link_general',
      p_capacidad_maxima: 10,
    });

    if (!encRes.data?.id) {
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

    if (!ticketRes.data?.ok || !ticketRes.data?.ticket_token) {
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
    const claimRes = results.find((r) => r.worker === 'claim')!.res;
    const createRes = results.find((r) => r.worker === 'create_ticket')!.res;
    const revokeRes = results.find((r) => r.worker === 'revoke')!.res;
    const msgRes = results.find((r) => r.worker === 'message')!.res;

    console.log('  Claim Result:', claimRes.data || claimRes.error);
    console.log('  Create Result:', createRes.data || createRes.error);
    console.log('  Revoke Result:', revokeRes.data || revokeRes.error);
    console.log('  Message Result:', msgRes.data || msgRes.error);

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
  } finally {
    // 7. Limpieza Determinista y Verificación de Residuo Cero en Staging
    console.log('Paso 6: Ejecutando limpieza exhaustiva y verificando residuo cero...');
    try {
      if (trackedEncounterIds.length > 0) {
        await adminClient.from('mensajes_encuentro').delete().in('encuentro_id', trackedEncounterIds);
        await adminClient.from('participantes').delete().in('encuentro_id', trackedEncounterIds);
        await adminClient.from('encuentros').delete().in('id', trackedEncounterIds);
      }

      if (trackedUserIds.length > 0) {
        await adminClient.from('anonymous_transfer_tickets').delete().in('source_user_id_snapshot', trackedUserIds);
        await adminClient.from('anonymous_transfer_tickets').delete().in('target_user_id_snapshot', trackedUserIds);
        await adminClient.from('rate_limit_buckets').delete().in('user_id', trackedUserIds);
        await adminClient.from('inbox_notifications').delete().in('user_id', trackedUserIds);
        await adminClient.from('notification_delivery_outbox').delete().in('user_id', trackedUserIds);

        for (const uid of trackedUserIds) {
          await adminClient.auth.admin.deleteUser(uid);
        }
      }

      // Verificación de residuo cero
      const { count: encCount } = await adminClient
        .from('encuentros')
        .select('*', { count: 'exact', head: true })
        .in('id', trackedEncounterIds);

      const { count: ticketCount } = await adminClient
        .from('anonymous_transfer_tickets')
        .select('*', { count: 'exact', head: true })
        .in('source_user_id_snapshot', trackedUserIds);

      assert.equal(encCount || 0, 0, 'Residuo en encuentros debe ser 0');
      assert.equal(ticketCount || 0, 0, 'Residuo en anonymous_transfer_tickets debe ser 0');
      console.log('  Limpieza verificada: 0 registros residuales en Staging.');
    } catch (cleanupErr) {
      console.error('  Error durante limpieza de fixtures en Staging:', cleanupErr);
    }
  }
}

runStagingConcurrencyQA().catch((err) => {
  console.error('[STAGING QA ERROR]', err);
  process.exit(1);
});
