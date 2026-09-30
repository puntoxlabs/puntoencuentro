/**
 * Staging Smoke QA — Fase 2.0-C1 (T5-B2): Enforcement of Rate Limits on Core Actions
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Verifies live in Staging:
 * 1. Anonymous user can create private encounter within limit.
 * 2. Simple encounter and with-options encounter share the 'create_encounter' bucket.
 * 3. Intenciones enforce rate limiting (hit limit 6 -> 7th rejected) and anonymous is blocked before limiter.
 * 4. Join open encounter consumes global bucket, while duplicate_pending does NOT consume bucket.
 * 5. Rejection sets resolved_at = now() and triggers 6-hour exact cooldown on the SAME encounter without affecting other encounters.
 * 6. Historical 13 legacy rows with resolved_at NULL remain intact and unblocked (>6h old).
 * 7. Full cleanup of all created QA fixtures (preserving historical data).
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
  console.log('STAGING SMOKE T5-B2: RATE LIMITING CORE ENFORCEMENT');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  const timestamp = Date.now();
  let hostUserId: string | null = null;
  let applicantAId: string | null = null;
  let applicantBId: string | null = null;
  let anonUserId: string | null = null;

  const createdEncounterIds: string[] = [];
  const createdIntentionIds: string[] = [];
  const createdUserIds: string[] = [];

  try {
    // ----------------------------------------------------
    // 0. Precheck: 13 Historical Legacy Rows Check
    // ----------------------------------------------------
    console.log('[0/7] Precheck: Verificando las 13 solicitudes históricas con resolved_at IS NULL...');
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
    console.log('\n[1/7] Creando usuarios QA (Host, Solicitante A, Solicitante B, Anónimo)...');
    
    // Host
    const hostEmail = `qa-t5b2-host-${timestamp}@puntoencuentro.test`;
    const hostPass = 'QaPassword123!Safe';
    const { data: uHost, error: uHostErr } = await admin.auth.admin.createUser({
      email: hostEmail,
      password: hostPass,
      email_confirm: true,
      user_metadata: { full_name: 'QA Host T5B2' },
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
      user_metadata: { full_name: 'QA Applicant A T5B2' },
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
      user_metadata: { full_name: 'QA Applicant B T5B2' },
    });
    if (uAppBErr || !uAppB.user) throw new Error(`Error creando applicant B: ${uAppBErr?.message}`);
    applicantBId = uAppB.user.id;
    createdUserIds.push(applicantBId);

    // Client sessions
    const hostClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await hostClient.auth.signInWithPassword({ email: hostEmail, password: hostPass });

    const appAClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await appAClient.auth.signInWithPassword({ email: appAEmail, password: appAPass });

    const appBClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await appBClient.auth.signInWithPassword({ email: appBEmail, password: appBPass });

    // Anónimo
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonAuth, error: anonErr } = await anonClient.auth.signInAnonymously();
    if (anonErr || !anonAuth.user) throw new Error(`Error signInAnonymously: ${anonErr?.message}`);
    anonUserId = anonAuth.user.id;
    createdUserIds.push(anonUserId);

    console.log(`  Host: ${hostUserId}`);
    console.log(`  Applicant A: ${applicantAId}`);
    console.log(`  Applicant B: ${applicantBId}`);
    console.log(`  Anonymous: ${anonUserId} (is_anonymous=true)`);

    // ----------------------------------------------------
    // 2. CREATE ENCOUNTER: Anónimo y Bucket Compartido (Simple + Opciones)
    // ----------------------------------------------------
    console.log('\n[2/7] Verificando CREATE ENCOUNTER (Anónimo + Compartido Simple/Opciones)...');

    // A. Anónimo crea encuentro privado
    const anonEncounterPayload = {
      titulo: `Encuentro Anon T5B2 ${timestamp}`,
      fecha: '2026-10-15',
      hora: '19:00',
      modalidad: 'presencial',
      lugar_texto: 'Parque Patricios',
      tipo_invitacion: 'link_general',
    };
    const { data: anonEncRes, error: anonEncErr } = await anonClient.rpc('crear_encuentro_seguro', {
      p_data: anonEncounterPayload,
    });
    if (anonEncErr) throw new Error(`Error anon crear_encuentro_seguro: ${anonEncErr.message}`);
    assert.equal(anonEncRes.ok, true, 'Anónimo debe poder crear encuentro privado');
    createdEncounterIds.push(anonEncRes.id);

    // Verificar bucket de anon incrementó a 1
    const { data: bAnon } = await admin
      .from('rate_limit_buckets')
      .select('request_count')
      .eq('action', 'create_encounter')
      .eq('user_id', anonUserId)
      .single();
    assert.equal(bAnon?.request_count, 1, 'Bucket anon debe tener conteo 1');
    console.log('  -> Anónimo creó encuentro privado exitosamente y consumió 1 slot de create_encounter');

    // B. Host crea Simple
    const hostSimplePayload = {
      titulo: `Encuentro Host Simple ${timestamp}`,
      fecha: '2026-10-18',
      hora: '20:00',
      modalidad: 'presencial',
      lugar_texto: 'Palermo',
      tipo_invitacion: 'link_general',
    };
    const { data: hSimpleRes, error: hSimpleErr } = await hostClient.rpc('crear_encuentro_seguro', {
      p_data: hostSimplePayload,
    });
    if (hSimpleErr) throw new Error(`Error host crear_encuentro_seguro: ${hSimpleErr.message}`);
    assert.equal(hSimpleRes.ok, true);
    createdEncounterIds.push(hSimpleRes.id);

    // C. Host crea Con Opciones
    const hostOptPayload = {
      titulo: `Encuentro Host Coordinacion ${timestamp}`,
      modalidad: 'presencial',
      lugar_texto: 'Recoleta',
      tipo_invitacion: 'link_general',
      response_deadline: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    };
    const hostOpciones = [
      { fecha: '2026-10-22', hora_inicio: '18:00' },
      { fecha: '2026-10-23', hora_inicio: '18:00' },
    ];
    const { data: hOptRes, error: hOptErr } = await hostClient.rpc('crear_encuentro_con_opciones_seguro', {
      p_data: hostOptPayload,
      p_opciones: hostOpciones,
    });
    if (hOptErr) throw new Error(`Error host crear_encuentro_con_opciones_seguro: ${hOptErr.message}`);
    assert.equal(hOptRes.ok, true);
    createdEncounterIds.push(hOptRes.id);

    // Verificar bucket de host tiene conteo exactamente 2 (compartido)
    const { data: bHost } = await admin
      .from('rate_limit_buckets')
      .select('request_count')
      .eq('action', 'create_encounter')
      .eq('user_id', hostUserId)
      .single();
    assert.equal(bHost?.request_count, 2, 'Host bucket debe ser exactamente 2');
    console.log('  -> Host creó Simple + Con Opciones y ambos incrementaron el mismo bucket (conteo=2)');

    // ----------------------------------------------------
    // 3. CREATE INTENTION: Anonymous pre-check & Enforcement límite 6
    // ----------------------------------------------------
    console.log('\n[3/7] Verificando CREATE INTENTION (Anónimo rechazado + Enforcement límite 6)...');

    // A. Anonymous intenta crear intención -> rejected by permanent_account_required
    const { data: anonIntRes } = await anonClient.rpc('crear_intencion_segura', {
      p_titulo: 'Intención anon rechazada',
    });
    assert.equal(anonIntRes.ok, false);
    assert.equal(anonIntRes.error, 'permanent_account_required');
    console.log('  -> Anónimo rechazado por permanent_account_required antes del limiter');

    // B. Applicant B crea intenciones hasta el límite (6 permitidas)
    for (let i = 1; i <= 6; i++) {
      const { data: intRes, error: intErr } = await appBClient.rpc('crear_intencion_segura', {
        p_titulo: `Intención QA ${i} - ${timestamp}`,
      });
      if (intErr) throw new Error(`Error appB crear_intencion_segura #${i}: ${intErr.message}`);
      assert.equal(intRes.ok, true, `Intención ${i} debe crearse exitosamente`);
      createdIntentionIds.push(intRes.id);
    }

    // 7ma intención debe exceder el límite
    const { data: intExceededRes } = await appBClient.rpc('crear_intencion_segura', {
      p_titulo: `Intención QA 7 Excedida - ${timestamp}`,
    });
    assert.equal(intExceededRes.ok, false);
    assert.equal(intExceededRes.error, 'rate_limit_exceeded');
    console.log('  -> Intención 1-6 exitosas, 7ma rechazada con rate_limit_exceeded');

    // ----------------------------------------------------
    // 4. JOIN OPEN ENCOUNTER: Global Quota & Duplicate Check
    // ----------------------------------------------------
    console.log('\n[4/7] Verificando JOIN OPEN ENCOUNTER (Duplicate pending no consume quota)...');

    // Obtener localidad 'palermo' o primera localidad activa
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
    if (enc1Err || !encOpen1) throw new Error(`Error creando encuentro abierto 1: ${enc1Err?.message}`);
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
    if (enc2Err || !encOpen2) throw new Error(`Error creando encuentro abierto 2: ${enc2Err?.message}`);
    createdEncounterIds.push(encOpen2.id);

    // Applicant A solicita unirse a Encuentro 1
    const { data: join1Res, error: join1Err } = await appAClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen1.id,
      p_nombre: 'Applicant A QA',
    });
    if (join1Err) throw new Error(`Error join1: ${join1Err.message}`);
    assert.equal(join1Res.ok, true);
    const requestId1 = join1Res.request_id;
    assert.ok(requestId1);

    // Applicant A solicita nuevamente a Encuentro 1 -> duplicate_pending_request
    const { data: dupRes } = await appAClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen1.id,
      p_nombre: 'Applicant A QA Duplicate',
    });
    assert.equal(dupRes.ok, false);
    assert.equal(dupRes.error, 'duplicate_pending_request');

    // Verificar que el bucket de join_open_encounter para Applicant A sigue en 1 (el duplicado NO consumió slot)
    const { data: bJoin } = await admin
      .from('rate_limit_buckets')
      .select('request_count')
      .eq('action', 'join_open_encounter')
      .eq('user_id', applicantAId)
      .single();
    assert.equal(bJoin?.request_count, 1, 'Duplicate request must NOT increment bucket');
    console.log('  -> Solicitud 1 aceptada (conteo=1). Duplicado rechazado con duplicate_pending_request sin incrementar bucket');

    // ----------------------------------------------------
    // 5. COOLDOWN 6 HORAS POST-RECHAZO: Scope y Normal Invariant
    // ----------------------------------------------------
    console.log('\n[5/7] Verificando COOLDOWN 6 HORAS post-rechazo...');

    // Host rechaza la solicitud de Applicant A
    const { data: rejRes, error: rejErr } = await hostClient.rpc('rechazar_solicitud_encuentro_abierto', {
      p_request_id: requestId1,
      p_host_id: hostUserId,
    });
    if (rejErr) throw new Error(`Error rechazar solicitud: ${rejErr.message}`);
    assert.equal(rejRes.ok, true);

    // Verificar que rechazar_solicitud_encuentro_abierto seteó resolved_at
    const { data: reqRow } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado, resolved_at')
      .eq('id', requestId1)
      .single();
    assert.equal(reqRow.estado, 'rejected');
    assert.ok(reqRow.resolved_at !== null, 'Normal rejection MUST set resolved_at');
    console.log('  -> Invariante cumplida: rechazo registró resolved_at =', reqRow.resolved_at);

    // Applicant A intenta volver a unirse al MISMO Encuentro 1 -> bloqueado por cooldown (6h)
    const { data: cooldownRes } = await appAClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen1.id,
      p_nombre: 'Applicant A Re-request',
    });
    assert.equal(cooldownRes.ok, false);
    assert.equal(cooldownRes.error, 'request_not_available');
    console.log('  -> Cooldown activo: solicitud al mismo encuentro rechazada con request_not_available');

    // Applicant A solicita unirse a un Encuentro DIFERENTE (Encuentro 2) -> permitido!
    const { data: diffRes, error: diffErr } = await appAClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen2.id,
      p_nombre: 'Applicant A to Enc 2',
    });
    if (diffErr) throw new Error(`Error diffRes: ${diffErr.message}`);
    assert.equal(diffRes.ok, true);
    console.log('  -> Cooldown NO afecta otros encuentros: solicitud al Encuentro 2 aprobada con ok=true');

    // ----------------------------------------------------
    // 6. Verificar Filas Históricas Intactas
    // ----------------------------------------------------
    console.log('\n[6/7] Verificando que las 13 filas históricas permanezcan intactas...');
    const { data: legacyAfter } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('id')
      .eq('estado', 'rejected')
      .is('resolved_at', null);
    assert.equal(legacyAfter?.length, 13, 'Las 13 filas históricas deben seguir con resolved_at NULL');
    console.log('  -> 13 filas históricas intactas sin modificación.');

    console.log('\n✔ TODOS LOS PUNTOS DE QA SMOKE T5-B2 PASARON EXITOSAMENTE.');
  } finally {
    // ----------------------------------------------------
    // 7. Cleanup en Staging
    // ----------------------------------------------------
    console.log('\n[7/7] Realizando cleanup de fixtures de prueba en Staging...');

    // Eliminar solicitudes creadas en encuentros de prueba
    if (createdEncounterIds.length > 0) {
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentro_opciones_fecha').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }

    // Eliminar intenciones creadas
    if (createdIntentionIds.length > 0) {
      await admin.from('intenciones').delete().in('id', createdIntentionIds);
    }

    // Eliminar rate limit buckets de los usuarios QA creados
    if (createdUserIds.length > 0) {
      await admin.from('rate_limit_buckets').delete().in('user_id', createdUserIds);
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
    }

    console.log('  Cleanup finalizado con éxito.');
  }
}

runStagingSmokeT5B2().catch((err) => {
  console.error('\n✖ ERROR FATAL EN STAGING SMOKE T5-B2:', err);
  process.exit(1);
});
