/**
 * Staging Smoke QA — Fase 2.0-C1 (T3-B0): Contrato Contextual de Desbloqueo y Estado
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

async function runStagingSmokeT3B0() {
  console.log('========================================================');
  console.log('STAGING SMOKE T3-B0: CONTEXTUAL UNBLOCK & STATUS CONTRACT');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let hostAId: string | null = null;
  let applicantBId: string | null = null;
  let encounterAId: string | null = null;
  let encounterBId: string | null = null;
  let intentionAId: string | null = null;
  let requestId: string | null = null;

  const timestamp = Date.now();

  try {
    // ----------------------------------------------------
    // Setup: Crear cuentas efímeras de QA para A y B
    // ----------------------------------------------------
    const password = 'QaPassword123!Safe';
    const emailA = `qa-t3b0-a-${timestamp}@puntoencuentro.test`;
    const emailB = `qa-t3b0-b-${timestamp}@puntoencuentro.test`;

    const { data: uA, error: errA } = await admin.auth.admin.createUser({
      email: emailA, password, email_confirm: true, user_metadata: { full_name: 'QA Host A' }
    });
    if (errA || !uA.user) throw new Error(`Failed to create User A: ${errA?.message}`);
    hostAId = uA.user.id;

    const { data: uB, error: errB } = await admin.auth.admin.createUser({
      email: emailB, password, email_confirm: true, user_metadata: { full_name: 'QA Applicant B' }
    });
    if (errB || !uB.user) throw new Error(`Failed to create User B: ${errB?.message}`);
    applicantBId = uB.user.id;

    const clientA = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientA.auth.signInWithPassword({ email: emailA, password });

    const clientB = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientB.auth.signInWithPassword({ email: emailB, password });

    // Crear Encuentro de A
    const { data: encA, error: encAErr } = await admin.from('encuentros').insert({
      titulo: `Encuentro QA A ${timestamp}`,
      host_id: hostAId,
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      is_open: true,
      estado: 'activo',
      max_participants: 5,
      opened_at: new Date().toISOString(),
      fecha: '2026-10-25',
      hora: '19:00:00',
      date_mode: 'fixed',
      locality_id: 'guemes',
      tema_invitacion: 'friends'
    }).select('id').single();
    if (encAErr) throw new Error(`Failed to insert encounter A: ${encAErr.message}`);
    encounterAId = encA.id;

    // Crear Encuentro de B
    const { data: encB, error: encBErr } = await admin.from('encuentros').insert({
      titulo: `Encuentro QA B ${timestamp}`,
      host_id: applicantBId,
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      is_open: true,
      estado: 'activo',
      max_participants: 5,
      opened_at: new Date().toISOString(),
      fecha: '2026-10-25',
      hora: '19:00:00',
      date_mode: 'fixed',
      locality_id: 'guemes',
      tema_invitacion: 'friends'
    }).select('id').single();
    if (encBErr) throw new Error(`Failed to insert encounter B: ${encBErr.message}`);
    encounterBId = encB.id;

    // Crear Intención de A
    const { data: intA, error: intAErr } = await admin.from('intenciones').insert({
      titulo: `Intención QA A ${timestamp}`,
      descripcion: 'Tenis fin de semana',
      user_id: hostAId,
      estado: 'activa',
      locality_id: 'guemes',
      modalidad: 'presencial'
    }).select('id').single();
    if (intAErr) throw new Error(`Failed to insert intention A: ${intAErr.message}`);
    intentionAId = intA.id;

    // Crear solicitud de B a encuentro de A
    const { data: solRes, error: solErr } = await clientB.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterAId,
      p_nombre: 'QA Applicant B Name',
      p_mensaje: 'Hola quiero participar'
    });
    if (solErr || !solRes?.ok) throw new Error(`Failed to create join request: ${solErr?.message || solRes?.error}`);
    requestId = solRes.request_id;

    // Marcar interés de B en intención de A
    await clientB.rpc('set_interes_intencion', {
      p_intencion_id: intentionAId,
      p_interesado: true
    });

    console.log('[Setup] Datos de prueba creados en Staging');

    // ----------------------------------------------------
    // Paso 1: estado A = false
    // ----------------------------------------------------
    const { data: sA1 } = await clientA.rpc('get_estado_bloqueo_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (sA1?.blocked_by_me !== false) throw new Error(`Paso 1 falló: estado A esperado false, obtenido ${sA1?.blocked_by_me}`);
    console.log('[Paso 1/16] estado A = false verificado');

    // ----------------------------------------------------
    // Paso 2: estado B = false
    // ----------------------------------------------------
    const { data: sB1 } = await clientB.rpc('get_estado_bloqueo_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (sB1?.blocked_by_me !== false) throw new Error(`Paso 2 falló: estado B esperado false, obtenido ${sB1?.blocked_by_me}`);
    console.log('[Paso 2/16] estado B = false verificado');

    // ----------------------------------------------------
    // Paso 3: A bloquea a B mediante solicitud
    // ----------------------------------------------------
    const { data: blkA } = await clientA.rpc('bloquear_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (!blkA?.ok) throw new Error(`Paso 3 falló: ${JSON.stringify(blkA)}`);
    console.log('[Paso 3/16] A bloqueó a B mediante solicitud');

    // ----------------------------------------------------
    // Paso 4: estado A = true
    // ----------------------------------------------------
    const { data: sA2 } = await clientA.rpc('get_estado_bloqueo_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (sA2?.blocked_by_me !== true) throw new Error(`Paso 4 falló: estado A esperado true, obtenido ${sA2?.blocked_by_me}`);
    // Verificar que DTO no expone UUIDs
    if (sA2.blocked_id !== undefined || sA2.blocker_id !== undefined || sA2.host_id !== undefined) {
      throw new Error('DTO de estado expone campos privados indebidamente');
    }
    console.log('[Paso 4/16] estado A = true verificado (sin campos privados)');

    // ----------------------------------------------------
    // Paso 5: estado B = false (no se entera del bloqueo de A)
    // ----------------------------------------------------
    const { data: sB2 } = await clientB.rpc('get_estado_bloqueo_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (sB2?.blocked_by_me !== false) throw new Error(`Paso 5 falló: estado B esperado false, obtenido ${sB2?.blocked_by_me}`);
    console.log('[Paso 5/16] estado B = false verificado (privacidad preservada)');

    // ----------------------------------------------------
    // Paso 6: B bloquea a A mediante solicitud
    // ----------------------------------------------------
    const { data: blkB } = await clientB.rpc('bloquear_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (!blkB?.ok) throw new Error(`Paso 6 falló: ${JSON.stringify(blkB)}`);
    console.log('[Paso 6/16] B bloqueó a A mediante solicitud');

    // ----------------------------------------------------
    // Paso 7: estado A = true
    // ----------------------------------------------------
    const { data: sA3 } = await clientA.rpc('get_estado_bloqueo_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (sA3?.blocked_by_me !== true) throw new Error(`Paso 7 falló: estado A esperado true, obtenido ${sA3?.blocked_by_me}`);
    console.log('[Paso 7/16] estado A = true verificado');

    // ----------------------------------------------------
    // Paso 8: estado B = true
    // ----------------------------------------------------
    const { data: sB3 } = await clientB.rpc('get_estado_bloqueo_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (sB3?.blocked_by_me !== true) throw new Error(`Paso 8 falló: estado B esperado true, obtenido ${sB3?.blocked_by_me}`);
    console.log('[Paso 8/16] estado B = true verificado');

    // ----------------------------------------------------
    // Paso 9: A desbloquea contextual
    // ----------------------------------------------------
    const { data: unblkA } = await clientA.rpc('desbloquear_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (!unblkA?.ok || unblkA?.blocked !== false) throw new Error(`Paso 9 falló: ${JSON.stringify(unblkA)}`);
    console.log('[Paso 9/16] A desbloqueó contextual');

    // ----------------------------------------------------
    // Paso 10: estado A = false
    // ----------------------------------------------------
    const { data: sA4 } = await clientA.rpc('get_estado_bloqueo_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (sA4?.blocked_by_me !== false) throw new Error(`Paso 10 falló: estado A esperado false, obtenido ${sA4?.blocked_by_me}`);
    console.log('[Paso 10/16] estado A = false verificado');

    // ----------------------------------------------------
    // Paso 11: estado B = true (bloqueo B -> A permanece intacto)
    // ----------------------------------------------------
    const { data: sB4 } = await clientB.rpc('get_estado_bloqueo_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (sB4?.blocked_by_me !== true) throw new Error(`Paso 11 falló: estado B esperado true, obtenido ${sB4?.blocked_by_me}`);
    console.log('[Paso 11/16] estado B = true verificado (bloqueo inverso preservado)');

    // ----------------------------------------------------
    // Paso 12: enforcement bilateral continúa activo (B bloquea a A)
    // ----------------------------------------------------
    const { data: discEncA } = await clientA.rpc('get_discovery_encuentros_abiertos');
    const aSeesB = (discEncA || []).some((x: any) => x.id === encounterBId);
    if (aSeesB) throw new Error('Enforcement bilateral falló: A no debería ver el encuentro de B');
    console.log('[Paso 12/16] enforcement bilateral continúa activo tras desbloqueo unilateral');

    // ----------------------------------------------------
    // Paso 13: B desbloquea contextual
    // ----------------------------------------------------
    const { data: unblkB } = await clientB.rpc('desbloquear_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (!unblkB?.ok || unblkB?.blocked !== false) throw new Error(`Paso 13 falló: ${JSON.stringify(unblkB)}`);
    console.log('[Paso 13/16] B desbloqueó contextual');

    // ----------------------------------------------------
    // Paso 14: estado B = false
    // ----------------------------------------------------
    const { data: sB5 } = await clientB.rpc('get_estado_bloqueo_desde_solicitud_seguro', { p_solicitud_id: requestId });
    if (sB5?.blocked_by_me !== false) throw new Error(`Paso 14 falló: estado B esperado false, obtenido ${sB5?.blocked_by_me}`);
    console.log('[Paso 14/16] estado B = false verificado');

    // ----------------------------------------------------
    // Paso 15: enforcement bilateral desaparece hacia adelante
    // ----------------------------------------------------
    const { data: discEncAAfter } = await clientA.rpc('get_discovery_encuentros_abiertos');
    const aSeesBAfter = (discEncAAfter || []).some((x: any) => x.id === encounterBId);
    if (!aSeesBAfter) throw new Error('Enforcement falló: A debería ver el encuentro de B tras desbloqueo total');
    console.log('[Paso 15/16] enforcement desaparece hacia adelante (visibilidad restaurada)');

    // ----------------------------------------------------
    // Paso 16: solicitudes/intereses históricos NO reviven
    // ----------------------------------------------------
    const { data: solRow } = await admin.from('solicitudes_encuentro_abierto').select('estado').eq('id', requestId).single();
    if (solRow?.estado !== 'withdrawn' && solRow?.estado !== 'rejected') {
      throw new Error(`Solicitud histórica revivió a ${solRow?.estado}`);
    }

    const { count: intCount } = await admin.from('intencion_intereses').select('*', { count: 'exact', head: true }).match({
      intencion_id: intentionAId,
      user_id: applicantBId
    });
    if ((intCount || 0) > 0) throw new Error('Interés histórico revivió indebidamente');

    console.log('[Paso 16/16] solicitudes e intereses históricos NO reviven (preservados)');

    console.log('\n========================================================');
    console.log('STAGING SMOKE T3-B0: ALL 16 VERIFICATIONS PASSED SUCCESFULLY!');
    console.log('========================================================');
  } finally {
    console.log('\n[Cleanup] Limpiando datos de prueba en Staging...');
    if (requestId) await admin.from('solicitudes_encuentro_abierto').delete().eq('id', requestId);
    if (encounterAId) await admin.from('encuentros').delete().eq('id', encounterAId);
    if (encounterBId) await admin.from('encuentros').delete().eq('id', encounterBId);
    if (intentionAId) await admin.from('intenciones').delete().eq('id', intentionAId);
    if (hostAId) await admin.auth.admin.deleteUser(hostAId);
    if (applicantBId) await admin.auth.admin.deleteUser(applicantBId);
    console.log('[Cleanup] Limpieza completada.');
  }
}

runStagingSmokeT3B0().catch((err) => {
  console.error('STAGING SMOKE T3-B0 FAILURE:', err);
  process.exit(1);
});
