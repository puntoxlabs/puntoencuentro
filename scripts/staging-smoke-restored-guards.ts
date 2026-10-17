/**
 * Staging Smoke QA — Restauración de Controles de Seguridad H2/H3 Post-Microfix
 *
 * Valida sobre Supabase Staging real (wougfhfwqgmxhgvjqoua):
 * 1. Control A: Anfitrión anónimo rechazado con permanent_account_required.
 * 2. Control B: Encuentro no activo rechazado con encuentro_not_active.
 * 3. Control C: Bloqueo bilateral (host->applicant y applicant->host) rechazado con request_not_available.
 * 4. Control D: Participación activa duplicada rechazada con already_joined.
 * 5. Idempotencia y Re-aprobación post-baja con rotación de token y reseteo de reconfirmación.
 * 6. Limpieza integral de fixtures y usuarios temporales.
 */

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const admin = createClient(url, secretKey, { auth: { persistSession: false } });

async function runStagingSmokeRestoredGuards() {
  console.log('================================================================');
  console.log('STAGING SMOKE QA: CONTROLES H2/H3 RESTAURADOS (POST-MICROFIX)');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('================================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  try {
    // Helper para crear usuarios temporales de QA
    async function createQaUser(prefix: string, name: string) {
      const email = `qa-h2h3-${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@puntoencuentro.test`;
      const password = 'QaPassword123!Secure';
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (error || !data.user) {
        throw new Error(`Error creando usuario QA (${prefix}): ${error?.message}`);
      }
      createdUserIds.push(data.user.id);

      const client = createClient(url, publishableKey, { auth: { persistSession: false } });
      const { data: authData, error: authErr } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (authErr || !authData.session) {
        throw new Error(`Error autenticando usuario QA (${prefix}): ${authErr?.message}`);
      }

      return {
        id: data.user.id,
        email,
        client,
      };
    }

    console.log('[1/7] Creando usuarios reales de prueba en Supabase Staging...');
    const host = await createQaUser('host', 'Host QA H2H3');
    const applicant = await createQaUser('applicant', 'Applicant QA H2H3');

    // Usuario anónimo
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonAuth, error: anonErr } = await anonClient.auth.signInAnonymously();
    if (anonErr || !anonAuth.user) {
      throw new Error(`Error iniciando sesión anónima: ${anonErr?.message}`);
    }
    const anonUserId = anonAuth.user.id;
    createdUserIds.push(anonUserId);

    console.log(`   Host permanente: ${host.id}`);
    console.log(`   Solicitante permanente: ${applicant.id}`);
    console.log(`   Anónimo: ${anonUserId}\n`);

    // Crear encuentro abierto de prueba
    console.log('[2/7] Creando encuentro abierto de prueba...');
    const encounterTitle = `Encuentro QA H2/H3 ${Date.now()}`;
    const { data: encData, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: host.id,
        titulo: encounterTitle,
        open_public_title: encounterTitle,
        descripcion: 'Validación de controles de seguridad H2/H3 en Staging',
        fecha: '2026-12-10',
        hora: '19:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Parque Central QA',
        link_virtual: null,
        tipo_invitacion: 'individual',
        invitation_template: 'default',
        locality_id: 'centro',
        open_public_zone: 'Centro',
        estado: 'activo',
        is_open: true,
        max_participants: 5,
        min_participants: 2,
        realization_status: 'pending',
        allow_multi_seat_requests: true,
        max_seats_per_request: 2,
        min_seats_per_request: 1,
        moderation_status: 'approved',
      })
      .select('id')
      .single();

    if (encErr || !encData?.id) {
      throw new Error(`Error creando encuentro: ${encErr?.message || JSON.stringify(encData)}`);
    }
    const encounterId = encData.id;
    createdEncounterIds.push(encounterId);

    // Solicitante envía solicitud para sumarse
    const { data: reqData, error: reqErr } = await applicant.client.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Applicant QA',
      p_mensaje: 'Hola quiero participar',
      p_seat_count: 1,
    });
    assert.ifError(reqErr);
    assert.equal(reqData.ok, true, 'Solicitud debe crearse exitosamente');
    const requestId = reqData.request_id;
    console.log(`   Encuentro ID: ${encounterId}`);
    console.log(`   Solicitud ID: ${requestId}\n`);

    // --------------------------------------------------------------------------
    // CONTROL A: CUENTA PERMANENTE OBLIGATORIA
    // --------------------------------------------------------------------------
    console.log('[3/7] Verificando Control A: Cuenta permanente obligatoria...');
    const { data: anonApproveData, error: anonApproveErr } = await anonClient.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
    });
    // Debe ser rechazado por permanent_account_required
    assert.ifError(anonApproveErr);
    assert.equal(anonApproveData.ok, false, 'Anónimo no debe poder aprobar');
    assert.equal(anonApproveData.error, 'permanent_account_required', `Debe devolver permanent_account_required, obtuvo: ${JSON.stringify(anonApproveData)}`);
    console.log('   -> PASÓ: Anónimo rechazado con permanent_account_required.\n');

    // --------------------------------------------------------------------------
    // CONTROL C: BLOQUEO BILATERAL
    // --------------------------------------------------------------------------
    console.log('[4/7] Verificando Control C: Bloqueo bilateral host <-> applicant...');
    // C1: Host bloquea a solicitante
    await admin.from('bloqueos_usuario').insert({ blocker_id: host.id, blocked_id: applicant.id });

    const { data: blk1Data, error: blk1Err } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
    });
    assert.ifError(blk1Err);
    assert.equal(blk1Data.ok, false, 'Host que bloqueó no debe poder aprobar');
    assert.equal(blk1Data.error, 'request_not_available');

    // Limpiar bloqueo host -> applicant
    await admin.from('bloqueos_usuario').delete().match({ blocker_id: host.id, blocked_id: applicant.id });

    // C2: Solicitante bloquea a host
    await admin.from('bloqueos_usuario').insert({ blocker_id: applicant.id, blocked_id: host.id });

    const { data: blk2Data, error: blk2Err } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
    });
    assert.ifError(blk2Err);
    assert.equal(blk2Data.ok, false, 'Host bloqueado por solicitante no debe poder aprobar');
    assert.equal(blk2Data.error, 'request_not_available');

    // Limpiar bloqueo applicant -> host
    await admin.from('bloqueos_usuario').delete().match({ blocker_id: applicant.id, blocked_id: host.id });
    console.log('   -> PASÓ: Bloqueo bilateral en ambos sentidos rechazado con request_not_available.\n');

    // --------------------------------------------------------------------------
    // CONTROL B: ESTADO ACTIVO
    // --------------------------------------------------------------------------
    console.log('[5/7] Verificando Control B: Encuentro no activo bajo lock...');
    // Modificar temporalmente el estado del encuentro a 'cancelado'
    await admin.from('encuentros').update({ estado: 'cancelado' }).eq('id', encounterId);

    const { data: stateData, error: stateErr } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
    });
    assert.ifError(stateErr);
    assert.equal(stateData.ok, false, 'Encuentro cancelado no debe permitir aprobaciones');
    assert.equal(stateData.error, 'encuentro_not_active');

    // Restaurar a 'activo'
    await admin.from('encuentros').update({ estado: 'activo' }).eq('id', encounterId);
    console.log('   -> PASÓ: Encuentro cancelado rechazado con encuentro_not_active.\n');

    // --------------------------------------------------------------------------
    // CONTROL D: PARTICIPACIÓN ACTIVA DUPLICADA & IDEMPOTENCIA
    // --------------------------------------------------------------------------
    console.log('[6/7] Verificando Control D: Participación activa duplicada e idempotencia...');
    // 1. Aprobación legítima inicial
    const { data: appData1, error: appErr1 } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
    });
    assert.ifError(appErr1);
    assert.equal(appData1.ok, true, `Aprobación debe ser exitosa: ${JSON.stringify(appData1)}`);
    const partId = appData1.participante_id;
    const initialToken = appData1.token_invitacion;

    // 2. Reintento de la misma solicitud ya aprobada (Idempotente)
    const { data: appDataIdemp, error: appErrIdemp } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
    });
    assert.ifError(appErrIdemp);
    assert.equal(appDataIdemp.ok, true);
    assert.equal(appDataIdemp.already_approved, true, 'Debe devolver already_approved = true');
    assert.equal(appDataIdemp.token_invitacion, initialToken, 'Token no debe mutar en idempotencia');

    // 3. Control D: Usuario ya confirmado en participantes intenta ser aprobado -> already_joined
    const applicant2 = await createQaUser('app2', 'Applicant 2 QA');
    const { data: req2Data, error: req2Err } = await applicant2.client.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Applicant 2 QA',
      p_mensaje: 'Hola quiero participar',
      p_seat_count: 1,
    });
    assert.ifError(req2Err);
    const req2Id = req2Data.request_id;

    // Crear directamente un registro de participante confirmado para applicant2 (simulando invitación o co-participación)
    await admin.from('participantes').insert({
      encuentro_id: encounterId,
      user_id: applicant2.id,
      nombre_invitado: 'Applicant 2 QA',
      estado: 'confirmado',
      seat_count: 1,
      tipo_invitacion: 'individual',
      token_invitacion: crypto.randomUUID(),
    });

    // Intentar aprobar su solicitud pendiente: debe rechazarse con already_joined
    const { data: dupData, error: dupErr } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: req2Id,
    });
    assert.ifError(dupErr);
    assert.equal(dupData.ok, false);
    assert.equal(dupData.error, 'already_joined', `Usuario ya confirmado debe ser rechazado con already_joined, obtuvo: ${JSON.stringify(dupData)}`);
    console.log('   -> PASÓ: Participación activa duplicada rechazada con already_joined.');

    // 4. Baja voluntaria y re-aprobación exitosa
    console.log('   Probando ciclo post-baja voluntaria...');
    await admin.from('participantes').update({
      estado: 'cancelado',
      reconfirmation_status: 'confirmed',
    }).eq('id', partId);

    await admin.from('solicitudes_encuentro_abierto').update({
      estado: 'cancelled',
      motivo_baja: 'Baja voluntaria temporal QA',
    }).eq('id', requestId);

    // Solicitante vuelve a postularse legítimamente tras la baja
    const { data: newReqData, error: newReqErr } = await applicant.client.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Applicant QA Re-Postulación',
      p_mensaje: 'Vuelvo a postularme',
      p_seat_count: 1,
    });
    assert.ifError(newReqErr);
    const newReqId = newReqData.request_id;

    // El host aprueba la nueva solicitud post-baja
    const { data: reApproveData, error: reApproveErr } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: newReqId,
    });
    assert.ifError(reApproveErr);
    assert.equal(reApproveData.ok, true, `Re-aprobación post-baja debe ser exitosa: ${JSON.stringify(reApproveData)}`);
    assert.notEqual(reApproveData.token_invitacion, initialToken, 'Token debe haberse rotado');

    // Verificar en la base de datos que reconfirmation_status = 'pending' y reconfirmed_at = null
    const { data: partRow } = await admin.from('participantes').select('reconfirmation_status, reconfirmed_at').eq('id', partId).single();
    assert.equal(partRow.reconfirmation_status, 'pending');
    assert.equal(partRow.reconfirmed_at, null);
    console.log('   -> PASÓ: Re-aprobación post-baja resetea reconfirmation_status a pending y rota token.\n');

    console.log('[7/7] Smoke QA de controles H2/H3 completado con 100% de éxito en Supabase Staging.');
  } finally {
    console.log('\n--- LIMPIEZA DE FIXTURES EN STAGING ---');
    for (const encId of createdEncounterIds) {
      await admin.from('encuentros').delete().eq('id', encId);
      console.log(`   Encuentro QA eliminado: ${encId}`);
    }
    for (const uid of createdUserIds) {
      await admin.auth.admin.deleteUser(uid);
      console.log(`   Usuario QA eliminado: ${uid}`);
    }
    console.log('Limpieza finalizada exitosamente.');
  }
}

runStagingSmokeRestoredGuards().catch((err) => {
  console.error('ERROR EN STAGING SMOKE QA:', err);
  process.exit(1);
});
