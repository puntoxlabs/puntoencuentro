/**
 * Staging Smoke QA — Fase 2.0-C1 (T3-A2.1): Alertas + Verificación del Guard de Aprobación
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 */

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

async function runStagingSmokeT3A21() {
  console.log('========================================================');
  console.log('STAGING SMOKE T3-A2.1: ALERTS & APPROVAL GUARD VERIFICATION');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let hostId: string | null = null;
  let applicantId: string | null = null;
  let thirdPartyId: string | null = null;

  let encounterId: string | null = null;
  let intentionId: string | null = null;
  let alertId: string | null = null;
  let requestId: string | null = null;

  const timestamp = Date.now();

  try {
    // ----------------------------------------------------
    // Paso 1: Crear usuarios temporales QA en Staging Auth
    // ----------------------------------------------------
    const password = 'QaPassword123!Safe';
    const emailHost = `qa-t3a21-host-${timestamp}@puntoencuentro.test`;
    const emailApplicant = `qa-t3a21-applicant-${timestamp}@puntoencuentro.test`;
    const emailThird = `qa-t3a21-third-${timestamp}@puntoencuentro.test`;

    const { data: uHost, error: errH } = await admin.auth.admin.createUser({
      email: emailHost, password, email_confirm: true, user_metadata: { full_name: 'QA Host' }
    });
    if (errH || !uHost.user) throw new Error(`Failed to create Host: ${errH?.message}`);
    hostId = uHost.user.id;

    const { data: uApp, error: errA } = await admin.auth.admin.createUser({
      email: emailApplicant, password, email_confirm: true, user_metadata: { full_name: 'QA Applicant' }
    });
    if (errA || !uApp.user) throw new Error(`Failed to create Applicant: ${errA?.message}`);
    applicantId = uApp.user.id;

    const { data: uThird, error: errT } = await admin.auth.admin.createUser({
      email: emailThird, password, email_confirm: true, user_metadata: { full_name: 'QA Third' }
    });
    if (errT || !uThird.user) throw new Error(`Failed to create Third Party: ${errT?.message}`);
    thirdPartyId = uThird.user.id;

    console.log(`[Paso 1/8] Creados usuarios temporales (Host: ${hostId}, Applicant: ${applicantId}, Third: ${thirdPartyId})`);

    // ----------------------------------------------------
    // Paso 2: Autenticar clientes
    // ----------------------------------------------------
    const clientHost = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientHost.auth.signInWithPassword({ email: emailHost, password });

    const clientApplicant = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientApplicant.auth.signInWithPassword({ email: emailApplicant, password });

    const clientThird = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientThird.auth.signInWithPassword({ email: emailThird, password });

    console.log('[Paso 2/8] Clientes autenticados');

    // ----------------------------------------------------
    // Paso 3: Crear Encuentro Abierto (Host) e Intención (Applicant)
    // ----------------------------------------------------
    const { data: enc, error: encErr } = await admin.from('encuentros').insert({
      titulo: `Encuentro QA T3A21 ${timestamp}`,
      host_id: hostId,
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      is_open: true,
      estado: 'activo',
      max_participants: 5,
      opened_at: new Date().toISOString(),
      fecha: '2026-10-20',
      hora: '19:00:00',
      date_mode: 'fixed',
      locality_id: 'guemes',
      tema_invitacion: 'friends'
    }).select('id').single();
    if (encErr) throw new Error(`Failed to insert encounter: ${encErr.message}`);
    encounterId = enc.id;

    const { data: int, error: intErr } = await admin.from('intenciones').insert({
      titulo: `Intención QA T3A21 ${timestamp}`,
      descripcion: 'Tenis fin de semana',
      user_id: applicantId,
      estado: 'activa',
      locality_id: 'guemes',
      modalidad: 'presencial'
    }).select('id').single();
    if (intErr) throw new Error(`Failed to insert intention: ${intErr.message}`);
    intentionId = int.id;

    console.log(`[Paso 3/8] Creado Encuentro (${encounterId}) e Intención (${intentionId})`);

    // ====================================================
    // BLOQUE A: VERIFICACIÓN DEL GUARD DE APROBACIÓN
    // ====================================================

    // ----------------------------------------------------
    // Paso 4: Crear solicitud pending
    // ----------------------------------------------------
    const { data: solRes, error: solErr } = await clientApplicant.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'QA Applicant Name',
      p_mensaje: 'Hola quiero participar'
    });
    if (solErr || !solRes?.ok) throw new Error(`Failed to create join request: ${solErr?.message || solRes?.error}`);
    requestId = solRes.request_id;
    console.log(`[Paso 4/8] Solicitud creada en estado pending (ID: ${requestId})`);

    // ----------------------------------------------------
    // Paso 5: Insertar administrativamente bloqueo bilateral (SIN invocar bloquear_desde_solicitud_seguro)
    // ----------------------------------------------------
    const { error: blockInsertErr } = await admin.from('bloqueos_usuario').insert({
      blocker_id: applicantId,
      blocked_id: hostId
    });
    if (blockInsertErr) throw new Error(`Failed to insert administrative block: ${blockInsertErr.message}`);

    // Confirmar que la solicitud sigue pending ANTES de llamar aprobar
    const { data: solPreCheck } = await admin.from('solicitudes_encuentro_abierto').select('estado').eq('id', requestId).single();
    if (solPreCheck?.estado !== 'pending') throw new Error(`Expected solicitud to be pending before approval attempt, got ${solPreCheck?.estado}`);

    // Host intenta aprobar la solicitud
    const { data: aprRes } = await clientHost.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId
    });

    if (aprRes?.ok !== false || aprRes?.error !== 'request_not_available') {
      throw new Error(`Expected request_not_available but got: ${JSON.stringify(aprRes)}`);
    }

    // Confirmar que la solicitud sigue pending después del rechazo
    const { data: solPostCheck } = await admin.from('solicitudes_encuentro_abierto').select('estado, participante_id, token_participante').eq('id', requestId).single();
    if (solPostCheck?.estado !== 'pending') throw new Error(`Expected solicitud to remain pending, got ${solPostCheck?.estado}`);
    if (solPostCheck?.participante_id !== null) throw new Error('participante_id must be null');
    if (solPostCheck?.token_participante !== null) throw new Error('token_participante must be null');

    // Confirmar cero participante nuevo en la tabla participantes
    const { count: partCount } = await admin.from('participantes').select('*', { count: 'exact', head: true }).eq('encuentro_id', encounterId);
    if ((partCount || 0) > 0) throw new Error(`Expected 0 participants, found ${partCount}`);

    console.log('[Paso 5/8] Guard de aprobación verificado en Staging: request_not_available, solicitud sigue pending, cero participantes');

    // ====================================================
    // BLOQUE B: VERIFICACIÓN DE ALERTAS IN-APP
    // ====================================================

    // Limpiar el bloqueo previo para probar alertas
    await admin.from('bloqueos_usuario').delete().match({ blocker_id: applicantId, blocked_id: hostId });

    // ----------------------------------------------------
    // Paso 6: Insertar alerta de compatibilidad para Applicant (sobre encuentro de Host)
    // ----------------------------------------------------
    const { data: alertRow, error: alertErr } = await admin.from('alertas_compatibilidad').insert({
      user_id: applicantId,
      source_intencion_id: intentionId,
      target_encuentro_id: encounterId,
      tipo: 'interes_convertido',
      leida: false
    }).select('id, created_at, leida').single();
    if (alertErr) throw new Error(`Failed to insert alert: ${alertErr.message}`);
    alertId = alertRow.id;

    // Alerta visible antes del bloqueo
    const { data: alertsBefore } = await clientApplicant.rpc('get_mis_alertas_seguro');
    const isVisibleBefore = (alertsBefore?.alertas || []).some((x: any) => x.id === alertId);
    if (!isVisibleBefore) throw new Error('Alert must be visible before block');

    // DTO Privacy check
    const alertDto = (alertsBefore.alertas || []).find((x: any) => x.id === alertId);
    if (alertDto.public_token !== undefined) throw new Error('DTO must not expose public_token');
    if (alertDto.host_id !== undefined) throw new Error('DTO must not expose host_id');
    if (alertDto.encuentro?.public_token !== undefined) throw new Error('DTO nested must not expose public_token');
    if (alertDto.encuentro?.host_id !== undefined) throw new Error('DTO nested must not expose host_id');

    console.log('[Paso 6/8] Alerta visible antes del bloqueo y DTO sanitizado verificado');

    // ----------------------------------------------------
    // Paso 7: Crear bloqueo bilateral y verificar que se oculta la alerta
    // ----------------------------------------------------
    await admin.from('bloqueos_usuario').insert({ blocker_id: hostId, blocked_id: applicantId });

    const { data: alertsUnderBlock } = await clientApplicant.rpc('get_mis_alertas_seguro');
    const isVisibleUnderBlock = (alertsUnderBlock?.alertas || []).some((x: any) => x.id === alertId);
    if (isVisibleUnderBlock) throw new Error('Alert must NOT be visible under bilateral block');

    // Confirmar fila de alerta preservada (no borrada, leida y created_at inalterados)
    const { data: alertCheckRow } = await admin.from('alertas_compatibilidad').select('id, leida, created_at').eq('id', alertId).single();
    if (!alertCheckRow) throw new Error('Alert row was unexpectedly deleted');
    if (alertCheckRow.leida !== false) throw new Error('Alert leida was unexpectedly modified');
    if (new Date(alertCheckRow.created_at).getTime() !== new Date(alertRow.created_at).getTime()) {
      throw new Error('Alert created_at was unexpectedly modified');
    }

    console.log('[Paso 7/8] Alerta oculta bajo bloqueo bilateral y fila en base de datos 100% preservada');

    // ----------------------------------------------------
    // Paso 8: Desbloquear y verificar que la alerta vuelve a ser visible
    // ----------------------------------------------------
    await admin.from('bloqueos_usuario').delete().match({ blocker_id: hostId, blocked_id: applicantId });

    const { data: alertsAfterUnblock } = await clientApplicant.rpc('get_mis_alertas_seguro');
    const isVisibleAfterUnblock = (alertsAfterUnblock?.alertas || []).some((x: any) => x.id === alertId);
    if (!isVisibleAfterUnblock) throw new Error('Alert must be visible again after unblocking');

    console.log('[Paso 8/8] Alerta restaurada tras desbloqueo exitosamente');

    console.log('\n========================================================');
    console.log('STAGING SMOKE T3-A2.1: ALL 8 VERIFICATIONS PASSED SUCCESFULLY!');
    console.log('========================================================');
  } finally {
    console.log('\n[Cleanup] Limpiando datos de prueba en Staging...');
    if (alertId) await admin.from('alertas_compatibilidad').delete().eq('id', alertId);
    if (requestId) await admin.from('solicitudes_encuentro_abierto').delete().eq('id', requestId);
    if (encounterId) await admin.from('encuentros').delete().eq('id', encounterId);
    if (intentionId) await admin.from('intenciones').delete().eq('id', intentionId);
    if (hostId) await admin.auth.admin.deleteUser(hostId);
    if (applicantId) await admin.auth.admin.deleteUser(applicantId);
    if (thirdPartyId) await admin.auth.admin.deleteUser(thirdPartyId);
    console.log('[Cleanup] Limpieza completada.');
  }
}

runStagingSmokeT3A21().catch((err) => {
  console.error('STAGING SMOKE T3-A2.1 FAILURE:', err);
  process.exit(1);
});
