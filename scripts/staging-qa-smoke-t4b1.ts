/**
 * Staging Smoke QA — Fase 2.0-C1 (T4-B1): Trazabilidad de Moderación para Soft Launch
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Verifies live in Staging:
 * 1. Crear reporte QA pending.
 * 2. Confirmar que aparece en la cola manual de moderación (pending ORDER BY created_at ASC).
 * 3. Pasar a reviewed con operador válido.
 * 4. Confirmar reviewed_at y reviewed_by persistidos.
 * 5. Pasar a dismissed o actioned con resolution_note.
 * 6. Confirmar resolved_at, resolved_by y resolution_note.
 * 7. Verificar que usuario authenticated normal NO puede leer ni actualizar reportes_encuentro.
 * 8. Cleanup completo en Staging.
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

async function runStagingSmokeT4B1() {
  console.log('========================================================');
  console.log('STAGING SMOKE T4-B1: MODERATION AUDIT TRAIL SOFT LAUNCH');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let hostAId: string | null = null;
  let applicantBId: string | null = null;
  let operatorMId: string | null = null;
  let encounterAId: string | null = null;
  let requestId: string | null = null;
  let reportId: string | null = null;

  const timestamp = Date.now();

  try {
    // ----------------------------------------------------
    // Setup: Crear cuentas efímeras de QA para A, B y Operador M
    // ----------------------------------------------------
    console.log('[Setup] Creando cuentas de prueba en Staging...');
    const password = 'QaPassword123!Safe';
    const emailA = `qa-t4b1-host-${timestamp}@puntoencuentro.test`;
    const emailB = `qa-t4b1-part-${timestamp}@puntoencuentro.test`;
    const emailM = `qa-t4b1-op-${timestamp}@puntoencuentro.test`;

    const { data: uA, error: errA } = await admin.auth.admin.createUser({
      email: emailA, password, email_confirm: true, user_metadata: { full_name: 'QA Host A' }
    });
    if (errA || !uA.user) throw new Error(`Failed to create Host A: ${errA?.message}`);
    hostAId = uA.user.id;

    const { data: uB, error: errB } = await admin.auth.admin.createUser({
      email: emailB, password, email_confirm: true, user_metadata: { full_name: 'QA Applicant B' }
    });
    if (errB || !uB.user) throw new Error(`Failed to create Applicant B: ${errB?.message}`);
    applicantBId = uB.user.id;

    const { data: uM, error: errM } = await admin.auth.admin.createUser({
      email: emailM, password, email_confirm: true, user_metadata: { full_name: 'QA Operator M' }
    });
    if (errM || !uM.user) throw new Error(`Failed to create Operator M: ${errM?.message}`);
    operatorMId = uM.user.id;

    const clientA = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientA.auth.signInWithPassword({ email: emailA, password });

    const clientB = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientB.auth.signInWithPassword({ email: emailB, password });

    // Crear Encuentro Abierto de Host A
    const { data: encA, error: encAErr } = await admin.from('encuentros').insert({
      titulo: `Encuentro QA T4-B1 ${timestamp}`,
      host_id: hostAId,
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      is_open: true,
      estado: 'activo',
      max_participants: 6,
      opened_at: new Date().toISOString(),
      fecha: '2026-11-15',
      hora: '19:00:00',
      date_mode: 'fixed',
      locality_id: 'guemes',
      tema_invitacion: 'friends',
      open_public_zone: 'Plaza Güemes'
    }).select('id').single();
    if (encAErr) throw new Error(`Failed to insert encounter A: ${encAErr.message}`);
    encounterAId = encA.id;

    // Crear Solicitud de B
    const { data: solRes, error: solErr } = await clientB.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterAId,
      p_nombre: 'QA Applicant B',
      p_mensaje: 'Hola quiero participar'
    });
    if (solErr || !solRes?.ok || !solRes?.request_id) {
      throw new Error(`solicitar_sumarse failed: ${solErr?.message || JSON.stringify(solRes)}`);
    }
    requestId = solRes.request_id;

    // 1. Crear reporte QA pending desde Host A usando RPC segura
    console.log('[Paso 1/8] Creando reporte seguro pending...');
    const { data: repRes, error: repErr } = await clientA.rpc('crear_reporte_seguro', {
      p_solicitud_id: requestId,
      p_contexto: 'pre_solicitud',
      p_motivo: 'commercial_spam',
      p_detalle: 'Mensaje con publicidad de producto ajeno al encuentro'
    });
    if (repErr || !repRes?.ok) {
      throw new Error(`crear_reporte_seguro failed: ${repErr?.message || JSON.stringify(repRes)}`);
    }

    const { data: repInDb } = await admin
      .from('reportes_encuentro')
      .select('id')
      .eq('solicitud_id', requestId)
      .single();

    if (!repInDb?.id) throw new Error('No se encontró el reporte creado en DB');
    reportId = repInDb.id;
    console.log('  ✔ Reporte creado exitosamente en Staging con ID:', reportId);

    // 2. Confirmar que aparece en la cola manual de moderación
    console.log('\n[Paso 2/8] Confirmando aparición en cola manual de pending...');
    const { data: queueRows, error: queueErr } = await admin
      .from('reportes_encuentro')
      .select('id, created_at, contexto, motivo, detalle, estado, solicitud_id, encuentro_id')
      .eq('estado', 'pending')
      .order('created_at', { ascending: true });

    if (queueErr) throw new Error(`Queue query error: ${queueErr.message}`);
    const foundInQueue = queueRows?.some(r => r.id === reportId);
    assert.ok(foundInQueue, 'El reporte debe figurar en la cola de reportes pending');
    console.log('  ✔ Reporte encontrado en cola de moderación pending');

    // 2B. Verificar que intentar pending con metadata de revisión es estrictamente RECHAZADO
    console.log('\n[Paso 2B/8] Verificando rechazo estricto de pending con metadata de revisión...');
    const { error: invalidPendingErr } = await admin
      .from('reportes_encuentro')
      .update({
        reviewed_at: new Date().toISOString(),
        reviewed_by: operatorMId,
      })
      .eq('id', reportId);

    assert.ok(invalidPendingErr !== null, 'Debe fallar por constraint reportes_encuentro_pending_unreviewed');
    assert.match(invalidPendingErr?.message || '', /reportes_encuentro_pending_unreviewed/);
    console.log('  ✔ Pending con metadata de revisión rechazado por constraint reportes_encuentro_pending_unreviewed');

    // 3 & 4. Pasar a reviewed con operador válido y confirmar reviewed_at/by
    console.log('\n[Paso 3/8] Transición a reviewed con operador...');
    const reviewedTime = new Date().toISOString();
    const { error: reviewErr } = await admin
      .from('reportes_encuentro')
      .update({
        estado: 'reviewed',
        reviewed_at: reviewedTime,
        reviewed_by: operatorMId,
      })
      .eq('id', reportId);

    if (reviewErr) throw new Error(`Review update failed: ${reviewErr.message}`);

    const { data: reviewedData } = await admin
      .from('reportes_encuentro')
      .select('estado, reviewed_at, reviewed_by, resolved_at, resolved_by')
      .eq('id', reportId)
      .single();

    assert.equal(reviewedData?.estado, 'reviewed');
    assert.ok(reviewedData?.reviewed_at, 'reviewed_at debe estar presente');
    assert.equal(reviewedData?.reviewed_by, operatorMId);
    assert.equal(reviewedData?.resolved_at, null);
    assert.equal(reviewedData?.resolved_by, null);
    console.log('  ✔ Reporte actualizado a reviewed con metadata de operador');

    // 5, 6 & 7. Pasar a dismissed con metadata de resolución y resolution_note
    console.log('\n[Paso 4/8] Transición a dismissed con metadata de resolución y nota interna...');
    const resolvedTime = new Date().toISOString();
    const resolutionNote = 'Revisado por moderación: contenido considerado publicitario pero no lesivo. Advertencia preventiva.';

    const { error: resolveErr } = await admin
      .from('reportes_encuentro')
      .update({
        estado: 'dismissed',
        resolved_at: resolvedTime,
        resolved_by: operatorMId,
        resolution_note: resolutionNote,
      })
      .eq('id', reportId);

    if (resolveErr) throw new Error(`Resolve update failed: ${resolveErr.message}`);

    const { data: resolvedData } = await admin
      .from('reportes_encuentro')
      .select('estado, reviewed_by, resolved_by, resolution_note')
      .eq('id', reportId)
      .single();

    assert.equal(resolvedData?.estado, 'dismissed');
    assert.equal(resolvedData?.reviewed_by, operatorMId);
    assert.equal(resolvedData?.resolved_by, operatorMId);
    assert.equal(resolvedData?.resolution_note, resolutionNote);
    console.log('  ✔ Reporte cerrado como dismissed con resolution_note y trazabilidad completa');

    // 4B. Verificar transición directa pending -> actioned con ambos pares completos
    console.log('\n[Paso 4B/8] Verificando transición directa pending -> actioned con ambos pares...');
    const { data: directRep, error: directRepErr } = await admin
      .from('reportes_encuentro')
      .insert({
        solicitud_id: requestId,
        encuentro_id: encounterAId,
        reporter_id: applicantBId,
        reported_id: hostAId,
        contexto: 'post_encuentro',
        motivo: 'other',
        detalle: 'Detalle de prueba para resolución directa',
        estado: 'pending'
      })
      .select('id')
      .single();

    if (directRepErr || !directRep?.id) throw new Error(`Direct rep insert failed: ${directRepErr?.message}`);
    const directRepId = directRep.id;

    const directNow = new Date().toISOString();
    const { error: directActionErr } = await admin
      .from('reportes_encuentro')
      .update({
        estado: 'actioned',
        reviewed_at: directNow,
        reviewed_by: operatorMId,
        resolved_at: directNow,
        resolved_by: operatorMId,
        resolution_note: 'Resolución directa de caso flagrante.',
      })
      .eq('id', directRepId);

    if (directActionErr) throw new Error(`Direct transition failed: ${directActionErr.message}`);
    console.log('  ✔ Transición directa pending -> actioned con timestamps idénticos aceptada');
    await admin.from('reportes_encuentro').delete().eq('id', directRepId);

    // 8. Verificar que usuario normal no puede leer ni actualizar reportes_encuentro
    console.log('\n[Paso 5/8] Verificando aislamiento de privacidad para clientes normales...');

    const { data: clientReadData, error: clientReadErr } = await clientA
      .from('reportes_encuentro')
      .select('*')
      .eq('id', reportId);

    // Puede retornar array vacío por RLS o error de permisos
    assert.ok(
      clientReadErr !== null || (Array.isArray(clientReadData) && clientReadData.length === 0),
      'Cliente authenticated no debe poder leer reportes_encuentro'
    );

    const { error: clientUpdateErr } = await clientA
      .from('reportes_encuentro')
      .update({ estado: 'pending' })
      .eq('id', reportId);

    assert.ok(clientUpdateErr !== null, 'Cliente authenticated no debe poder modificar reportes_encuentro');
    console.log('  ✔ Privacidad y RLS verificados: usuario authenticated no tiene acceso a reportes_encuentro');

    console.log('\n========================================================');
    console.log('STAGING SMOKE T4-B1: ALL VERIFICATIONS PASSED SUCCESFULLY!');
    console.log('========================================================\n');

  } finally {
    // ----------------------------------------------------
    // Cleanup QA
    // ----------------------------------------------------
    console.log('[Cleanup] Limpiando datos de prueba en Staging...');
    if (reportId) {
      await admin.from('reportes_encuentro').delete().eq('id', reportId);
    }
    if (requestId) {
      await admin.from('solicitudes_encuentro_abierto').delete().eq('id', requestId);
    }
    if (encounterAId) {
      await admin.from('encuentros').delete().eq('id', encounterAId);
    }
    if (hostAId) {
      await admin.auth.admin.deleteUser(hostAId);
    }
    if (applicantBId) {
      await admin.auth.admin.deleteUser(applicantBId);
    }
    if (operatorMId) {
      await admin.auth.admin.deleteUser(operatorMId);
    }
    console.log('[Cleanup] Limpieza completada con éxito.');
  }
}

runStagingSmokeT4B1().catch((err) => {
  console.error('\n❌ ERROR EN STAGING SMOKE T4-B1:', err);
  process.exit(1);
});
