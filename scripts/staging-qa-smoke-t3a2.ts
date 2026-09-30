/**
 * Staging Smoke QA — Fase 2.0-C1 (T3-A2): Enforcement Bilateral de Bloqueos
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

async function runStagingSmokeT3A2() {
  console.log('========================================================');
  console.log('STAGING SMOKE T3-A2: BILATERAL BLOCKING ENFORCEMENT');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let userAId: string | null = null;
  let userBId: string | null = null;
  let userCId: string | null = null;

  let encounterAId: string | null = null;
  let encounterBId: string | null = null;
  let intentionAId: string | null = null;
  let intentionBId: string | null = null;
  let requestId: string | null = null;

  const timestamp = Date.now();

  try {
    // ----------------------------------------------------
    // Paso 1: Crear usuarios temporales QA
    // ----------------------------------------------------
    const password = 'QaPassword123!Safe';
    const emailA = `qa-t3a2-a-${timestamp}@puntoencuentro.test`;
    const emailB = `qa-t3a2-b-${timestamp}@puntoencuentro.test`;
    const emailC = `qa-t3a2-c-${timestamp}@puntoencuentro.test`;

    const { data: uA, error: errA } = await admin.auth.admin.createUser({
      email: emailA, password, email_confirm: true, user_metadata: { full_name: 'QA User A' }
    });
    if (errA || !uA.user) throw new Error(`Failed to create User A: ${errA?.message}`);
    userAId = uA.user.id;

    const { data: uB, error: errB } = await admin.auth.admin.createUser({
      email: emailB, password, email_confirm: true, user_metadata: { full_name: 'QA User B' }
    });
    if (errB || !uB.user) throw new Error(`Failed to create User B: ${errB?.message}`);
    userBId = uB.user.id;

    const { data: uC, error: errC } = await admin.auth.admin.createUser({
      email: emailC, password, email_confirm: true, user_metadata: { full_name: 'QA User C' }
    });
    if (errC || !uC.user) throw new Error(`Failed to create User C: ${errC?.message}`);
    userCId = uC.user.id;

    console.log(`[Paso 1/15] Creados 3 usuarios temporales QA (A: ${userAId}, B: ${userBId}, C: ${userCId})`);

    // ----------------------------------------------------
    // Paso 2: Autenticar clientes para A, B, C y cliente anónimo
    // ----------------------------------------------------
    const clientA = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientA.auth.signInWithPassword({ email: emailA, password });

    const clientB = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientB.auth.signInWithPassword({ email: emailB, password });

    const clientC = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientC.auth.signInWithPassword({ email: emailC, password });

    const clientAnon = createClient(url, publishableKey, { auth: { persistSession: false } });

    console.log('[Paso 2/15] Clientes autenticados para A, B, C y cliente anónimo listos');

    // ----------------------------------------------------
    // Paso 3: Crear Encuentro Abierto e Intención para A
    // ----------------------------------------------------
    const { data: encA, error: encAErr } = await admin.from('encuentros').insert({
      titulo: `Encuentro QA A ${timestamp}`,
      host_id: userAId,
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      is_open: true,
      estado: 'activo',
      max_participants: 5,
      opened_at: new Date().toISOString(),
      fecha: '2026-10-15',
      hora: '19:00:00',
      date_mode: 'fixed',
      locality_id: 'guemes',
      tema_invitacion: 'friends'
    }).select('id').single();
    if (encAErr) throw new Error(`Failed to insert encounter A: ${encAErr.message}`);
    encounterAId = encA.id;

    const { data: intA, error: intAErr } = await admin.from('intenciones').insert({
      titulo: `Intención QA A ${timestamp}`,
      descripcion: 'Tenis fin de semana',
      user_id: userAId,
      estado: 'activa',
      locality_id: 'guemes',
      modalidad: 'presencial'
    }).select('id').single();
    if (intAErr) throw new Error(`Failed to insert intention A: ${intAErr.message}`);
    intentionAId = intA.id;

    console.log(`[Paso 3/15] Creado Encuentro A (${encounterAId}) e Intención A (${intentionAId})`);

    // ----------------------------------------------------
    // Paso 4: Crear Encuentro Abierto e Intención para B
    // ----------------------------------------------------
    const { data: encB, error: encBErr } = await admin.from('encuentros').insert({
      titulo: `Encuentro QA B ${timestamp}`,
      host_id: userBId,
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      is_open: true,
      estado: 'activo',
      max_participants: 5,
      opened_at: new Date().toISOString(),
      fecha: '2026-10-15',
      hora: '19:00:00',
      date_mode: 'fixed',
      locality_id: 'guemes',
      tema_invitacion: 'friends'
    }).select('id').single();
    if (encBErr) throw new Error(`Failed to insert encounter B: ${encBErr.message}`);
    encounterBId = encB.id;

    const { data: intB, error: intBErr } = await admin.from('intenciones').insert({
      titulo: `Intención QA B ${timestamp}`,
      descripcion: 'Café de especialidad',
      user_id: userBId,
      estado: 'activa',
      locality_id: 'guemes',
      modalidad: 'presencial'
    }).select('id').single();
    if (intBErr) throw new Error(`Failed to insert intention B: ${intBErr.message}`);
    intentionBId = intB.id;

    console.log(`[Paso 4/15] Creado Encuentro B (${encounterBId}) e Intención B (${intentionBId})`);

    // ----------------------------------------------------
    // Paso 5: Verificar visibilidad inicial sin bloqueo
    // ----------------------------------------------------
    const { data: discEncA } = await clientA.rpc('get_discovery_encuentros_abiertos');
    const hasBInA = (discEncA || []).some((x: any) => x.id === encounterBId);
    if (!hasBInA) throw new Error('A should see encounter B before blocking');

    const { data: discIntA } = await clientA.rpc('get_discovery_intenciones_activas');
    const hasIntBInA = (discIntA || []).some((x: any) => x.id === intentionBId);
    if (!hasIntBInA) throw new Error('A should see intention B before blocking');

    console.log('[Paso 5/15] Visibilidad inicial confirmada: A ve los items de B');

    // ----------------------------------------------------
    // Paso 6: B solicita sumarse a Encuentro A
    // ----------------------------------------------------
    const { data: solRes, error: solErr } = await clientB.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterAId,
      p_nombre: 'Usuario B QA',
      p_mensaje: 'Hola quiero participar'
    });
    if (solErr || !solRes?.ok) throw new Error(`Failed to join encounter: ${solErr?.message || solRes?.error}`);
    requestId = solRes.request_id;
    console.log(`[Paso 6/15] B solicitó sumarse exitosamente a Encuentro A (Request: ${requestId})`);

    // ----------------------------------------------------
    // Paso 7: B marca interés en Intención A
    // ----------------------------------------------------
    const { data: intRes, error: intErr } = await clientB.rpc('set_interes_intencion', {
      p_intencion_id: intentionAId,
      p_interesado: true
    });
    if (intErr || !intRes?.ok) throw new Error(`Failed to express interest: ${intErr?.message || intRes?.error}`);
    console.log('[Paso 7/15] B expresó interés exitosamente en Intención A');

    // ----------------------------------------------------
    // Paso 8: A bloquea a B usando la RPC contextual de T3-A1
    // ----------------------------------------------------
    const { data: blockRes, error: blockErr } = await clientA.rpc('bloquear_desde_solicitud_seguro', {
      p_solicitud_id: requestId
    });
    if (blockErr || !blockRes?.ok) throw new Error(`Failed to block: ${blockErr?.message || blockRes?.error}`);
    console.log('[Paso 8/15] A bloqueó a B mediante bloquear_desde_solicitud_seguro');

    // ----------------------------------------------------
    // Paso 9: Enforcement bilateral en Discovery Encuentros
    // ----------------------------------------------------
    const { data: discEncAAfter } = await clientA.rpc('get_discovery_encuentros_abiertos');
    const aSeesBEnc = (discEncAAfter || []).some((x: any) => x.id === encounterBId);
    if (aSeesBEnc) throw new Error('A must NOT see encounter B after blocking');

    const { data: discEncBAfter } = await clientB.rpc('get_discovery_encuentros_abiertos');
    const bSeesAEnc = (discEncBAfter || []).some((x: any) => x.id === encounterAId);
    if (bSeesAEnc) throw new Error('B must NOT see encounter A after blocking (bilateral)');

    const { data: discEncCAfter } = await clientC.rpc('get_discovery_encuentros_abiertos');
    const cSeesAEnc = (discEncCAfter || []).some((x: any) => x.id === encounterAId);
    const cSeesBEnc = (discEncCAfter || []).some((x: any) => x.id === encounterBId);
    if (!cSeesAEnc || !cSeesBEnc) throw new Error('C (third party) must see both encounters');

    console.log('[Paso 9/15] Discovery Encuentros: filtrado bilateral silencioso verificado (A no ve B, B no ve A, C ve ambos)');

    // ----------------------------------------------------
    // Paso 10: Enforcement bilateral en Discovery Intenciones
    // ----------------------------------------------------
    const { data: discIntAAfter } = await clientA.rpc('get_discovery_intenciones_activas');
    const aSeesBInt = (discIntAAfter || []).some((x: any) => x.id === intentionBId);
    if (aSeesBInt) throw new Error('A must NOT see intention B after blocking');

    const { data: discIntBAfter } = await clientB.rpc('get_discovery_intenciones_activas');
    const bSeesAInt = (discIntBAfter || []).some((x: any) => x.id === intentionAId);
    if (bSeesAInt) throw new Error('B must NOT see intention A after blocking (bilateral)');

    console.log('[Paso 10/15] Discovery Intenciones: filtrado bilateral silencioso verificado (A no ve B, B no ve A)');

    // ----------------------------------------------------
    // Paso 11: Rechazo fail-closed de nueva solicitud de sumarse
    // ----------------------------------------------------
    const { data: blockJoinRes } = await clientB.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterAId,
      p_nombre: 'Usuario B QA',
      p_mensaje: 'Intento post-bloqueo'
    });
    if (blockJoinRes?.ok !== false || blockJoinRes?.error !== 'encuentro_not_open') {
      throw new Error(`Expected encuentro_not_open but got: ${JSON.stringify(blockJoinRes)}`);
    }
    console.log('[Paso 11/15] solicitar_sumarse_encuentro_abierto: rechaza fail-closed con encuentro_not_open');

    // ----------------------------------------------------
    // Paso 12: Rechazo fail-closed de marcar nuevo interés en intención
    // ----------------------------------------------------
    const { data: blockIntRes } = await clientB.rpc('set_interes_intencion', {
      p_intencion_id: intentionAId,
      p_interesado: true
    });
    if (blockIntRes?.ok !== false || blockIntRes?.error !== 'intention_not_found_or_inactive') {
      throw new Error(`Expected intention_not_found_or_inactive but got: ${JSON.stringify(blockIntRes)}`);
    }

    // Desmarcar interés debe responder ok: true sin filtrar por bloqueo
    const { data: unmarkRes } = await clientB.rpc('set_interes_intencion', {
      p_intencion_id: intentionAId,
      p_interesado: false
    });
    if (!unmarkRes?.ok) {
      throw new Error(`Expected unmark interest to succeed: ${JSON.stringify(unmarkRes)}`);
    }
    console.log('[Paso 12/15] set_interes_intencion: true rechaza fail-closed con intention_not_found_or_inactive, false es idempotente');

    // ----------------------------------------------------
    // Paso 13: Coexistencia con Reportes de Moderación
    // ----------------------------------------------------
    const { data: repRes, error: repErr } = await clientA.rpc('crear_reporte_seguro', {
      p_solicitud_id: requestId,
      p_contexto: 'pre_solicitud',
      p_motivo: 'inappropriate_behavior',
      p_detalle: 'Reporte legítimo post bloqueo'
    });
    if (repErr || !repRes?.ok) {
      throw new Error(`crear_reporte_seguro failed post-block: ${repErr?.message || JSON.stringify(repRes)}`);
    }
    console.log('[Paso 13/15] Coexistencia verificada: reporte pre_solicitud exitoso sobre la solicitud bloqueada');

    // ----------------------------------------------------
    // Paso 14: Desbloqueo y restauración de visibilidad
    // ----------------------------------------------------
    const { data: unblockRes, error: unblockErr } = await clientA.rpc('desbloquear_usuario_seguro', {
      p_blocked_id: userBId
    });
    if (unblockErr || !unblockRes?.ok) {
      throw new Error(`desbloquear_usuario_seguro failed: ${unblockErr?.message || JSON.stringify(unblockRes)}`);
    }

    const { data: discEncARestored } = await clientA.rpc('get_discovery_encuentros_abiertos');
    const aSeesBEncRestored = (discEncARestored || []).some((x: any) => x.id === encounterBId);
    if (!aSeesBEncRestored) throw new Error('A must see encounter B after unblocking');

    const { data: discIntARestored } = await clientA.rpc('get_discovery_intenciones_activas');
    const aSeesBIntRestored = (discIntARestored || []).some((x: any) => x.id === intentionBId);
    if (!aSeesBIntRestored) throw new Error('A must see intention B after unblocking');

    // Comprobar que la solicitud previa sigue en rejected (no revivida)
    const { data: solRow } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado')
      .eq('id', requestId)
      .single();
    if (solRow?.estado !== 'rejected') {
      throw new Error(`Request should remain rejected after unblocking, found: ${solRow?.estado}`);
    }

    console.log('[Paso 14/15] Desbloqueo verificado: visibilidad restaurada y solicitud previa no revivida (rejected)');

    // ----------------------------------------------------
    // Paso 15: Concurrencia de Aprobación bajo Bloqueo
    // ----------------------------------------------------
    // Crear nueva solicitud de B hacia A (ahora desbloqueados)
    const { data: newSolRes } = await clientB.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterAId,
      p_nombre: 'Usuario B QA',
      p_mensaje: 'Nueva solicitud para prueba de concurrencia'
    });
    const newReqId = newSolRes?.request_id;
    if (!newReqId) throw new Error('Failed to create new request for concurrency test');

    // Simular carrera concurrente: surge un bloqueo B -> A mientras la solicitud sigue pending
    await admin.from('bloqueos_usuario').insert({ blocker_id: userBId, blocked_id: userAId });

    // A intenta aprobar: debe ser rechazado con request_not_available
    const { data: aprBlockedRes } = await clientA.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: newReqId
    });
    if (aprBlockedRes?.ok !== false || aprBlockedRes?.error !== 'request_not_available') {
      throw new Error(`Expected request_not_available but got: ${JSON.stringify(aprBlockedRes)}`);
    }
    console.log('[Paso 15/15] Guard concurrente verificado: aprobar_solicitud_encuentro_abierto rechaza con request_not_available');

    console.log('\n========================================================');
    console.log('STAGING SMOKE T3-A2: ALL 15 VERIFICATIONS PASSED SUCCESFULLY!');
    console.log('========================================================');
  } finally {
    // Limpieza de datos en Staging
    console.log('\n[Cleanup] Limpiando datos de prueba en Staging...');
    if (encounterAId) await admin.from('encuentros').delete().eq('id', encounterAId);
    if (encounterBId) await admin.from('encuentros').delete().eq('id', encounterBId);
    if (intentionAId) await admin.from('intenciones').delete().eq('id', intentionAId);
    if (intentionBId) await admin.from('intenciones').delete().eq('id', intentionBId);
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
    if (userCId) await admin.auth.admin.deleteUser(userCId);
    console.log('[Cleanup] Datos y usuarios temporales eliminados correctamente.');
  }
}

runStagingSmokeT3A2().catch((err) => {
  console.error('STAGING SMOKE FAILURE:', err);
  process.exit(1);
});
