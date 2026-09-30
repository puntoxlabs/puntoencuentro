/**
 * Staging Smoke QA — Fase 2.0-C1 (T5-B2.1): Directed Rate Limiting & Validation Order Smoke
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Directed checks (Section 19):
 * A. invalid create simple no consume.
 * B. valid create simple consume +1.
 * C. invalid create options no consume.
 * D. valid create options según contrato auth previo consume +1 (and anon rejects with permanent_account_required).
 * E. invalid intention no consume.
 * F. valid intention consume +1.
 * G. duplicate pending no consume.
 * H. blocked join no consume.
 * I. cooldown join no consume.
 * J. valid join consume +1.
 * K. thresholds siguen bloqueando.
 * Cleanup QA (Preserving historical 13 rows).
 */

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const admin = createClient(url, secretKey, { auth: { persistSession: false } });

async function runStagingSmokeT5B2() {
  console.log('========================================================');
  console.log('STAGING SMOKE T5-B2.1: DIRECTED VALIDATION & RATE LIMIT QA');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  const timestamp = Date.now();
  let hostUserId: string | null = null;
  let applicantAId: string | null = null;
  let applicantBId: string | null = null;
  let blockedUserId: string | null = null;
  let anonUserId: string | null = null;

  const createdEncounterIds: string[] = [];
  const createdIntentionIds: string[] = [];
  const createdUserIds: string[] = [];

  const getBucketCount = async (action: string, userId: string): Promise<number> => {
    const { data } = await admin
      .from('rate_limit_buckets')
      .select('request_count')
      .eq('action', action)
      .eq('user_id', userId)
      .maybeSingle();
    return data?.request_count || 0;
  };

  try {
    // ----------------------------------------------------
    // 0. Precheck: 13 Historical Legacy Rows Check
    // ----------------------------------------------------
    console.log('[0/12] Precheck: Verificando las 13 solicitudes históricas con resolved_at IS NULL...');
    const { data: legacyRows, error: legErr } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('id, encuentro_id, usuario_id, estado, resolved_at, created_at')
      .eq('estado', 'rejected')
      .is('resolved_at', null);

    if (legErr || !legacyRows) {
      throw new Error(`Error consultando filas legacy: ${legErr?.message}`);
    }
    console.log(`  Filas legacy encontradas: ${legacyRows.length}`);
    assert.equal(legacyRows.length, 13, 'Deben existir exactamente 13 filas históricas con resolved_at NULL');

    // ----------------------------------------------------
    // 1. Crear usuarios de prueba QA
    // ----------------------------------------------------
    console.log('\n[1/12] Creando usuarios QA (Host, Solicitante A, Solicitante B, Bloqueado, Anónimo)...');
    
    // Host
    const hostEmail = `qa-t5b2-host-${timestamp}@puntoencuentro.test`;
    const hostPass = 'QaPassword123!Safe';
    const { data: uHost, error: uHostErr } = await admin.auth.admin.createUser({
      email: hostEmail,
      password: hostPass,
      email_confirm: true,
      user_metadata: { full_name: 'QA Host T5B2.1' },
    });
    if (uHostErr || !uHost.user) throw new Error(`Error creando host: ${uHostErr?.message}`);
    hostUserId = uHost.user.id;
    createdUserIds.push(hostUserId);

    // Solicitante A
    const appAEmail = `qa-t5b2-appa-${timestamp}@puntoencuentro.test`;
    const appAPass = 'QaPassword123!Safe';
    const { data: uAppA, error: uAppAErr } = await admin.auth.admin.createUser({
      email: appAEmail,
      password: appAPass,
      email_confirm: true,
      user_metadata: { full_name: 'QA Applicant A T5B2.1' },
    });
    if (uAppAErr || !uAppA.user) throw new Error(`Error creando applicant A: ${uAppAErr?.message}`);
    applicantAId = uAppA.user.id;
    createdUserIds.push(applicantAId);

    // Solicitante B
    const appBEmail = `qa-t5b2-appb-${timestamp}@puntoencuentro.test`;
    const appBPass = 'QaPassword123!Safe';
    const { data: uAppB, error: uAppBErr } = await admin.auth.admin.createUser({
      email: appBEmail,
      password: appBPass,
      email_confirm: true,
      user_metadata: { full_name: 'QA Applicant B T5B2.1' },
    });
    if (uAppBErr || !uAppB.user) throw new Error(`Error creando applicant B: ${uAppBErr?.message}`);
    applicantBId = uAppB.user.id;
    createdUserIds.push(applicantBId);

    // Bloqueado
    const blockedEmail = `qa-t5b2-blocked-${timestamp}@puntoencuentro.test`;
    const blockedPass = 'QaPassword123!Safe';
    const { data: uBlocked, error: uBlockedErr } = await admin.auth.admin.createUser({
      email: blockedEmail,
      password: blockedPass,
      email_confirm: true,
      user_metadata: { full_name: 'QA Blocked T5B2.1' },
    });
    if (uBlockedErr || !uBlocked.user) throw new Error(`Error creando blocked: ${uBlockedErr?.message}`);
    blockedUserId = uBlocked.user.id;
    createdUserIds.push(blockedUserId);

    // Client sessions
    const hostClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await hostClient.auth.signInWithPassword({ email: hostEmail, password: hostPass });

    const appAClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await appAClient.auth.signInWithPassword({ email: appAEmail, password: appAPass });

    const appBClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await appBClient.auth.signInWithPassword({ email: appBEmail, password: appBPass });

    const blockedClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await blockedClient.auth.signInWithPassword({ email: blockedEmail, password: blockedPass });

    // Anónimo
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonAuth, error: anonErr } = await anonClient.auth.signInAnonymously();
    if (anonErr || !anonAuth.user) throw new Error(`Error signInAnonymously: ${anonErr?.message}`);
    anonUserId = anonAuth.user.id;
    createdUserIds.push(anonUserId);

    console.log(`  Host: ${hostUserId}`);
    console.log(`  Applicant A: ${applicantAId}`);
    console.log(`  Applicant B: ${applicantBId}`);
    console.log(`  Blocked: ${blockedUserId}`);
    console.log(`  Anonymous: ${anonUserId}`);

    // ----------------------------------------------------
    // 2. CHECK A & B: CREATE ENCOUNTER SIMPLE
    // ----------------------------------------------------
    console.log('\n[2/12] Verificando [A] invalid simple no consume y [B] valid simple consume +1...');
    const countAnon0 = await getBucketCount('create_encounter', anonUserId);
    assert.equal(countAnon0, 0);

    // [A] Invalid create simple: post_event_active_minutes invalido (-5)
    const invalidSimplePayload = {
      titulo: `Encuentro Invalido ${timestamp}`,
      fecha: '2026-10-15',
      hora: '19:00',
      modalidad: 'presencial',
      lugar_texto: 'Parque Patricios',
      tipo_invitacion: 'link_general',
      post_event_active_minutes: -5,
    };
    const { data: rInvSimple } = await anonClient.rpc('crear_encuentro_seguro', { p_data: invalidSimplePayload });
    assert.equal(rInvSimple.ok, false);
    assert.equal(rInvSimple.error, 'invalid_post_event_active_minutes');

    const countAnonAfterInvalid = await getBucketCount('create_encounter', anonUserId);
    assert.equal(countAnonAfterInvalid, 0, '[A] Invalid simple MUST NOT consume rate limit');
    console.log('  -> [A] PASÓ: invalid simple devolvió invalid_post_event_active_minutes y NO consumió bucket (conteo=0)');

    // [B] Valid create simple as anonymous -> consumes +1
    const validSimplePayload = {
      titulo: `Encuentro Anon Valido ${timestamp}`,
      fecha: '2026-10-15',
      hora: '19:00',
      modalidad: 'presencial',
      lugar_texto: 'Parque Patricios',
      tipo_invitacion: 'link_general',
      post_event_active_minutes: 60,
    };
    const { data: rValSimple, error: errValSimple } = await anonClient.rpc('crear_encuentro_seguro', { p_data: validSimplePayload });
    if (errValSimple) throw new Error(`Error rValSimple: ${errValSimple.message}`);
    assert.equal(rValSimple.ok, true);
    createdEncounterIds.push(rValSimple.id);

    const countAnonAfterValid = await getBucketCount('create_encounter', anonUserId);
    assert.equal(countAnonAfterValid, 1, '[B] Valid simple MUST increment bucket by 1');
    console.log('  -> [B] PASÓ: valid simple creado exitosamente por anónimo y consumió +1 (conteo=1)');

    // ----------------------------------------------------
    // 3. CHECK C & D: CREATE ENCOUNTER CON OPCIONES
    // ----------------------------------------------------
    console.log('\n[3/12] Verificando [C] invalid options no consume y [D] valid options consume +1 (y anon rechaza)...');

    // Contrato previo: anónimo es rechazado por permanent_account_required sin consumir
    const optPayload = {
      titulo: `Encuentro Opciones QA ${timestamp}`,
      modalidad: 'presencial',
      lugar_texto: 'Recoleta',
      tipo_invitacion: 'link_general',
      response_deadline: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    };
    const validOpciones = [
      { fecha: '2026-10-22', hora_inicio: '18:00' },
      { fecha: '2026-10-23', hora_inicio: '18:00' },
    ];
    const { data: rAnonOpt } = await anonClient.rpc('crear_encuentro_con_opciones_seguro', {
      p_data: optPayload,
      p_opciones: validOpciones,
    });
    assert.equal(rAnonOpt.ok, false);
    assert.equal(rAnonOpt.error, 'permanent_account_required');
    assert.equal(await getBucketCount('create_encounter', anonUserId), 1, 'Anon rechazado en opciones NO debe consumir bucket');
    console.log('  -> Contrato preexistente verificado: opciones requiere cuenta permanente (anónimo rechazado sin consumir)');

    // [C] Host con opciones inválidas (< 2 opciones) -> error minimum_two_options sin consumir
    const countHostBefore = await getBucketCount('create_encounter', hostUserId);
    assert.equal(countHostBefore, 0);

    const singleOption = [{ fecha: '2026-10-22', hora_inicio: '18:00' }];
    const { data: rInvOpt } = await hostClient.rpc('crear_encuentro_con_opciones_seguro', {
      p_data: optPayload,
      p_opciones: singleOption,
    });
    assert.equal(rInvOpt.ok, false);
    assert.equal(rInvOpt.error, 'minimum_two_options');

    const countHostAfterInvalid = await getBucketCount('create_encounter', hostUserId);
    assert.equal(countHostAfterInvalid, 0, '[C] Invalid options MUST NOT consume rate limit');
    console.log('  -> [C] PASÓ: invalid options devolvió minimum_two_options y NO consumió bucket (conteo=0)');

    // [D] Host con opciones válidas -> consume +1
    const { data: rValOpt, error: errValOpt } = await hostClient.rpc('crear_encuentro_con_opciones_seguro', {
      p_data: optPayload,
      p_opciones: validOpciones,
    });
    if (errValOpt) throw new Error(`Error rValOpt: ${errValOpt.message}`);
    assert.equal(rValOpt.ok, true);
    createdEncounterIds.push(rValOpt.id);

    const countHostAfterValid = await getBucketCount('create_encounter', hostUserId);
    assert.equal(countHostAfterValid, 1, '[D] Valid options MUST increment bucket by 1');
    console.log('  -> [D] PASÓ: valid options creado exitosamente y consumió +1 (conteo=1)');

    // También creamos un simple con host para confirmar bucket compartido (+2)
    const { data: rHostSimple, error: errHostSimple } = await hostClient.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: `Encuentro Host Simple 2 ${timestamp}`,
        fecha: '2026-10-18',
        hora: '20:00',
        modalidad: 'presencial',
        lugar_texto: 'Palermo',
        tipo_invitacion: 'link_general',
      },
    });
    if (errHostSimple) throw new Error(`Error rHostSimple: ${errHostSimple.message}`);
    assert.equal(rHostSimple.ok, true);
    createdEncounterIds.push(rHostSimple.id);

    const countHostShared = await getBucketCount('create_encounter', hostUserId);
    assert.equal(countHostShared, 2, 'Host bucket compartido debe ser exactamente 2');
    console.log('  -> Bucket compartido verificado: simple + opciones comparten el bucket (conteo=2)');

    // ----------------------------------------------------
    // 4. CHECK E, F, K: CREATE INTENTION
    // ----------------------------------------------------
    console.log('\n[4/12] Verificando [E] invalid intention no consume, [F] valid intention consume +1 y [K] threshold...');
    const countAppABefore = await getBucketCount('create_intention', applicantAId);
    assert.equal(countAppABefore, 0);

    // [E] Invalid intention: empty title -> invalid_title sin consumir
    const { data: rInvInt } = await appAClient.rpc('crear_intencion_segura', { p_titulo: '' });
    assert.equal(rInvInt.ok, false);
    assert.equal(rInvInt.error, 'invalid_title');

    const countAppAAfterInvalid = await getBucketCount('create_intention', applicantAId);
    assert.equal(countAppAAfterInvalid, 0, '[E] Invalid intention MUST NOT consume rate limit');
    console.log('  -> [E] PASÓ: invalid intention devolvió invalid_title y NO consumió bucket (conteo=0)');

    // [F] Valid intention -> consume +1
    const { data: rValInt, error: errValInt } = await appAClient.rpc('crear_intencion_segura', {
      p_titulo: `Intención Válida A ${timestamp}`,
    });
    if (errValInt) throw new Error(`Error rValInt: ${errValInt.message}`);
    assert.equal(rValInt.ok, true);
    createdIntentionIds.push(rValInt.id);

    const countAppAAfterValid = await getBucketCount('create_intention', applicantAId);
    assert.equal(countAppAAfterValid, 1, '[F] Valid intention MUST increment bucket by 1');
    console.log('  -> [F] PASÓ: valid intention consumió +1 (conteo=1)');

    // [K] Threshold enforcement con Applicant B (6 válidas, 7ma excede)
    console.log('  -> Verificando threshold límite 6 en intenciones...');
    for (let i = 1; i <= 6; i++) {
      const { data: intRes, error: intErr } = await appBClient.rpc('crear_intencion_segura', {
        p_titulo: `Intención B #${i} - ${timestamp}`,
      });
      if (intErr) throw new Error(`Error intB #${i}: ${intErr.message}`);
      assert.equal(intRes.ok, true);
      createdIntentionIds.push(intRes.id);
    }
    const { data: rExceededInt } = await appBClient.rpc('crear_intencion_segura', {
      p_titulo: `Intención B #7 Excedida - ${timestamp}`,
    });
    assert.equal(rExceededInt.ok, false);
    assert.equal(rExceededInt.error, 'rate_limit_exceeded');
    console.log('  -> [K] PASÓ: 6 intenciones creadas, 7ma rechazada con rate_limit_exceeded');

    // ----------------------------------------------------
    // 5. CHECK G, H, I, J: JOIN OPEN ENCOUNTER
    // ----------------------------------------------------
    console.log('\n[5/12] Verificando [G] duplicate no consume, [H] blocked no consume, [I] cooldown no consume y [J] valid consume +1...');

    const { data: locs } = await admin.from('localidades').select('id').eq('activo', true).limit(1);
    const localityId = locs?.[0]?.id || 'palermo';

    // Host crea 2 encuentros abiertos
    const { data: encOpen1, error: enc1Err } = await admin
      .from('encuentros')
      .insert({
        titulo: `Encuentro Abierto 1 ${timestamp}`,
        host_id: hostUserId,
        estado: 'activo',
        is_open: true,
        max_participants: 10,
        modalidad: 'presencial',
        locality_id: localityId,
        tipo_invitacion: 'link_general',
        fecha: '2026-10-30',
        hora: '20:00',
      })
      .select('id')
      .single();
    if (enc1Err || !encOpen1) throw new Error(`Error creando encOpen1: ${enc1Err?.message}`);
    createdEncounterIds.push(encOpen1.id);

    const { data: encOpen2, error: enc2Err } = await admin
      .from('encuentros')
      .insert({
        titulo: `Encuentro Abierto 2 ${timestamp}`,
        host_id: hostUserId,
        estado: 'activo',
        is_open: true,
        max_participants: 10,
        modalidad: 'presencial',
        locality_id: localityId,
        tipo_invitacion: 'link_general',
        fecha: '2026-10-31',
        hora: '20:00',
      })
      .select('id')
      .single();
    if (enc2Err || !encOpen2) throw new Error(`Error creando encOpen2: ${enc2Err?.message}`);
    createdEncounterIds.push(encOpen2.id);

    // [H] Bloqueo bilateral no consume
    await admin.from('bloqueos_usuario').insert({
      blocker_id: hostUserId,
      blocked_id: blockedUserId,
    });
    const countBlockedBefore = await getBucketCount('join_open_encounter', blockedUserId);
    assert.equal(countBlockedBefore, 0);

    const { data: rBlockedJoin } = await blockedClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen1.id,
      p_nombre: 'Blocked QA User',
    });
    assert.equal(rBlockedJoin.ok, false);
    assert.equal(rBlockedJoin.error, 'encuentro_not_open');

    const countBlockedAfter = await getBucketCount('join_open_encounter', blockedUserId);
    assert.equal(countBlockedAfter, 0, '[H] Blocked join MUST NOT consume rate limit');
    console.log('  -> [H] PASÓ: blocked join devolvió encuentro_not_open y NO consumió bucket (conteo=0)');

    // Solicitud 1 de Applicant A a Encuentro 1 -> consume +1
    const countAppAJoin0 = await getBucketCount('join_open_encounter', applicantAId);
    assert.equal(countAppAJoin0, 0);

    const { data: rJoin1, error: errJoin1 } = await appAClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen1.id,
      p_nombre: 'Applicant A QA',
    });
    if (errJoin1) throw new Error(`Error rJoin1: ${errJoin1.message}`);
    assert.equal(rJoin1.ok, true);
    const requestId1 = rJoin1.request_id;
    assert.ok(requestId1);

    const countAppAJoin1 = await getBucketCount('join_open_encounter', applicantAId);
    assert.equal(countAppAJoin1, 1, 'Initial valid join request consumes 1');

    // [G] Duplicate pending no consume
    const { data: rDupJoin } = await appAClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen1.id,
      p_nombre: 'Applicant A QA Dup',
    });
    assert.equal(rDupJoin.ok, false);
    assert.equal(rDupJoin.error, 'duplicate_pending_request');

    const countAppAAfterDup = await getBucketCount('join_open_encounter', applicantAId);
    assert.equal(countAppAAfterDup, 1, '[G] Duplicate request MUST NOT consume rate limit');
    console.log('  -> [G] PASÓ: duplicate request devolvió duplicate_pending_request y NO consumió bucket (conteo=1)');

    // Host rechaza la solicitud 1
    const { data: rRej, error: errRej } = await hostClient.rpc('rechazar_solicitud_encuentro_abierto', {
      p_request_id: requestId1,
      p_host_id: hostUserId,
    });
    if (errRej) throw new Error(`Error rechazo: ${errRej.message}`);
    assert.equal(rRej.ok, true);

    // [I] Cooldown post-rechazo no consume
    const { data: rCooldownJoin } = await appAClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen1.id,
      p_nombre: 'Applicant A Re-request',
    });
    assert.equal(rCooldownJoin.ok, false);
    assert.equal(rCooldownJoin.error, 'request_not_available');

    const countAppAAfterCooldown = await getBucketCount('join_open_encounter', applicantAId);
    assert.equal(countAppAAfterCooldown, 1, '[I] Cooldown-rejected attempt MUST NOT consume rate limit');
    console.log('  -> [I] PASÓ: cooldown devolvió request_not_available y NO consumió bucket (conteo=1)');

    // [J] Valid join a otro encuentro consume +1
    const { data: rJoin2, error: errJoin2 } = await appAClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen2.id,
      p_nombre: 'Applicant A to Enc 2',
    });
    if (errJoin2) throw new Error(`Error rJoin2: ${errJoin2.message}`);
    assert.equal(rJoin2.ok, true);

    const countAppAJoin2 = await getBucketCount('join_open_encounter', applicantAId);
    assert.equal(countAppAJoin2, 2, '[J] Valid join to another encounter MUST increment bucket to 2');
    console.log('  -> [J] PASÓ: solicitud válida a otro encuentro aprobada y consumió +1 (conteo=2)');

    // ----------------------------------------------------
    // 6. Verificar Filas Históricas Intactas
    // ----------------------------------------------------
    console.log('\n[6/12] Verificando que las 13 filas históricas permanezcan intactas...');
    const { data: legacyAfter } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('id')
      .eq('estado', 'rejected')
      .is('resolved_at', null);
    assert.equal(legacyAfter?.length, 13, 'Las 13 filas históricas deben seguir con resolved_at NULL');
    console.log('  -> 13 filas históricas intactas sin modificación.');

    console.log('\n✔ TODOS LOS PUNTOS A-K DE QA SMOKE T5-B2.1 PASARON EXITOSAMENTE EN STAGING.');
  } finally {
    // ----------------------------------------------------
    // 7. Cleanup en Staging
    // ----------------------------------------------------
    console.log('\n[Cleanup] Realizando cleanup de fixtures de prueba en Staging...');

    if (createdEncounterIds.length > 0) {
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentro_opciones_fecha').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }

    if (createdIntentionIds.length > 0) {
      await admin.from('intenciones').delete().in('id', createdIntentionIds);
    }

    if (createdUserIds.length > 0) {
      await admin.from('bloqueos_usuario').delete().in('blocker_id', createdUserIds);
      await admin.from('bloqueos_usuario').delete().in('blocked_id', createdUserIds);
      await admin.from('rate_limit_buckets').delete().in('user_id', createdUserIds);
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
    }

    console.log('  Cleanup finalizado con éxito.');
  }
}

runStagingSmokeT5B2().catch((err) => {
  console.error('\n✖ ERROR FATAL EN STAGING SMOKE T5-B2.1:', err);
  process.exit(1);
});
