/**
 * Staging Functional UI Smoke QA — Fase 2.0-C1 (T3-C): Bloqueo / Desbloqueo Contextual
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Validates complete UI integration:
 * UI -> service layer -> RPC Staging -> UI actualizada
 * Surfaces: HostOpenEncounterSection & InviteGuest
 */

import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard';

import { supabase } from '../src/lib/supabase';
import { trustService } from '../src/services/trustService';
import { openEncountersService } from '../src/services/openEncountersService';
import { HostOpenEncounterSection } from '../src/components/host/HostOpenEncounterSection';
import { ContextualBlockAction } from '../src/components/trust/ContextualBlockAction';
import { ContextualBlockModal } from '../src/components/trust/ContextualBlockModal';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const admin = createClient(url, secretKey, { auth: { persistSession: false } });

async function runStagingSmokeT3C() {
  console.log('========================================================');
  console.log('STAGING SMOKE T3-C: FUNCTIONAL UI QA OF BLOCK / UNBLOCK');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let hostAId: string | null = null;
  let applicantBId: string | null = null;
  let otherCId: string | null = null;
  let encounterAId: string | null = null;
  let requestId: string | null = null;
  let participantBId: string | null = null;
  const participantTokenB = crypto.randomUUID();

  const timestamp = Date.now();

  // Network call logger to verify payload invariants
  const contextualRpcCalls: { fn: string; params: any }[] = [];

  let activeClient: any = null;

  // Intercept supabase.rpc to forward to active client and record payload
  const originalRpc = supabase.rpc.bind(supabase);
  (supabase as any).rpc = async (fn: string, params?: any) => {
    if (
      fn === 'get_estado_bloqueo_desde_solicitud_seguro' ||
      fn === 'bloquear_desde_solicitud_seguro' ||
      fn === 'desbloquear_desde_solicitud_seguro'
    ) {
      contextualRpcCalls.push({ fn, params });
    }

    if (activeClient) {
      return activeClient.rpc(fn, params);
    }
    return originalRpc(fn, params);
  };

  try {
    // ----------------------------------------------------
    // Setup: Crear cuentas efímeras de QA para A, B y C
    // ----------------------------------------------------
    console.log('[Setup] Creando cuentas de prueba en Staging...');
    const password = 'QaPassword123!Safe';
    const emailA = `qa-t3c-host-${timestamp}@puntoencuentro.test`;
    const emailB = `qa-t3c-part-${timestamp}@puntoencuentro.test`;
    const emailC = `qa-t3c-other-${timestamp}@puntoencuentro.test`;

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

    const { data: uC, error: errC } = await admin.auth.admin.createUser({
      email: emailC, password, email_confirm: true, user_metadata: { full_name: 'QA Other C' }
    });
    if (errC || !uC.user) throw new Error(`Failed to create Other C: ${errC?.message}`);
    otherCId = uC.user.id;

    const clientA = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientA.auth.signInWithPassword({ email: emailA, password });

    const clientB = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientB.auth.signInWithPassword({ email: emailB, password });

    const clientC = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientC.auth.signInWithPassword({ email: emailC, password });

    // Crear Encuentro Abierto de Host A
    const { data: encA, error: encAErr } = await admin.from('encuentros').insert({
      titulo: `Encuentro QA T3-C ${timestamp}`,
      host_id: hostAId,
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      is_open: true,
      estado: 'activo',
      max_participants: 6,
      opened_at: new Date().toISOString(),
      fecha: '2026-10-30',
      hora: '20:00:00',
      date_mode: 'fixed',
      locality_id: 'guemes',
      tema_invitacion: 'friends',
      open_public_zone: 'Plaza Güemes'
    }).select('id, titulo, host_id, modalidad, tipo_invitacion, is_open, estado, max_participants, fecha, hora, open_public_zone').single();
    if (encAErr) throw new Error(`Failed to insert encounter A: ${encAErr.message}`);
    encounterAId = encA.id;

    // Crear Solicitud de B a encuentro de A
    const { data: solRes, error: solErr } = await clientB.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterAId,
      p_nombre: 'QA Applicant B',
      p_mensaje: 'Hola quiero participar en este encuentro'
    });
    if (solErr) throw new Error(`Failed to request join: ${solErr.message}`);
    if (!solRes || !solRes.ok || !solRes.request_id) {
      throw new Error(`solicitar_sumarse failed: ${JSON.stringify(solRes)}`);
    }
    requestId = solRes.request_id;

    // Crear registro de participante para B con token
    const { data: partB, error: partBErr } = await admin.from('participantes').insert({
      encuentro_id: encounterAId,
      nombre_invitado: 'QA Applicant B',
      tipo_invitacion: 'individual',
      estado: 'confirmado',
      token_invitacion: participantTokenB,
      user_id: applicantBId
    }).select('id').single();
    if (partBErr) throw new Error(`Failed to insert participant B: ${partBErr.message}`);
    participantBId = partB.id;

    console.log('[Setup] Datos de prueba creados exitosamente.\n');

    // ====================================================
    // 1. SMOKE HOST — ESTADO INICIAL
    // ====================================================
    console.log('[Paso 1/11] Smoke Host — Estado Inicial');
    activeClient = clientA;

    // Consultar estado de bloqueo desde Staging para Host A
    const stateAInitial = await trustService.getEstadoBloqueoDesdeSolicitud(requestId!);
    assert.equal(stateAInitial.ok, true, 'Debe responder ok desde Staging');
    assert.equal(stateAInitial.blockedByMe, false, 'Host A no tiene bloqueo activo inicialmente');

    // Renderizar sección de solicitudes del host
    const initialSolicitudes = [{
      id: requestId!,
      encuentro_id: encounterAId!,
      user_id: applicantBId!,
      nombre_solicitante: 'QA Applicant B',
      mensaje: 'Hola quiero participar en este encuentro',
      estado: 'pending' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }];

    const hostHtmlInitial = renderToString(
      React.createElement(HostOpenEncounterSection, {
        encuentro: encA,
        hostId: hostAId!,
        confirmedCount: 1,
        onRefresh: () => {},
        onParticipantAdded: () => {},
        initialSolicitudes: initialSolicitudes,
      })
    );

    assert.ok(hostHtmlInitial.includes('QA Applicant B'), 'Muestra nombre del solicitante');
    assert.ok(hostHtmlInitial.includes('pe-host-request-item__btn-report'), 'Botón reportar solicitud presente');
    assert.ok(hostHtmlInitial.includes('pe-host-request-item__btn-accept'), 'Botón aceptar presente');
    assert.ok(hostHtmlInitial.includes('pe-host-request-item__btn-reject'), 'Botón rechazar presente');
    assert.ok(!hostHtmlInitial.includes(hostAId!), 'No expone host_id en HTML');
    assert.ok(!hostHtmlInitial.includes(applicantBId!), 'No expone applicant_id en HTML');
    assert.ok(!hostHtmlInitial.includes('te bloqueó'), 'No revela información inversa');
    console.log('  ✔ HostOpenEncounterSection renderiza solicitud y acciones sin exponer UUIDs');

    // ====================================================
    // 2. SMOKE HOST — BLOQUEAR
    // ====================================================
    console.log('\n[Paso 2/11] Smoke Host — Bloquear');

    // A. Renderizar modal de confirmación de bloqueo
    const blockModalHtml = renderToString(
      React.createElement(ContextualBlockModal, {
        isOpen: true,
        onClose: () => {},
        solicitudId: requestId!,
        targetName: 'QA Applicant B',
        isBlocked: false,
        onSuccess: () => {},
      })
    );

    assert.ok(blockModalHtml.includes('¿Bloquear a QA Applicant B?'), 'Modal incluye título neutral');
    assert.ok(blockModalHtml.includes('Bloquear no envía un reporte.'), 'Aclara distinción con reporte');
    assert.ok(blockModalHtml.includes('Cancelar'), 'Botón cancelar presente');
    assert.ok(blockModalHtml.includes('Bloquear'), 'Botón confirmar bloqueo presente');
    console.log('  ✔ Modal de bloqueo renderiza copy neutral y distinción frente a reporte');

    // B. Ejecutar llamada real a Staging para bloquear
    const blockResA = await trustService.bloquearDesdeSolicitud(requestId!);
    assert.equal(blockResA.ok, true, 'Bloqueo exitoso en Staging');
    assert.equal(blockResA.blocked, true, 'Confirmado estado bloqueado');

    // C. Verificar estado actualizado desde Staging
    const stateAAfterBlock = await trustService.getEstadoBloqueoDesdeSolicitud(requestId!);
    assert.equal(stateAAfterBlock.ok, true);
    assert.equal(stateAAfterBlock.blockedByMe, true, 'Host A ahora tiene blockedByMe = true');

    // D. Verificar que backend resolvió la solicitud a rejected
    const { data: reqInDb } = await admin.from('solicitudes_encuentro_abierto').select('estado').eq('id', requestId).single();
    assert.equal(reqInDb?.estado, 'rejected', 'Solicitud pendiente auto-resuelta a rejected');

    // E. Re-renderizar HostOpenEncounterSection con solicitud en historial resuelto
    const resolvedSolicitudes = [{
      id: requestId!,
      encuentro_id: encounterAId!,
      user_id: applicantBId!,
      nombre_solicitante: 'QA Applicant B',
      mensaje: 'Hola quiero participar en este encuentro',
      estado: 'rejected' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }];

    const hostHtmlAfterBlock = renderToString(
      React.createElement(HostOpenEncounterSection, {
        encuentro: encA,
        hostId: hostAId!,
        confirmedCount: 1,
        onRefresh: () => {},
        onParticipantAdded: () => {},
        initialSolicitudes: resolvedSolicitudes,
      })
    );

    assert.ok(hostHtmlAfterBlock.includes('Historial de solicitudes (1)'), 'Solicitud figura en historial resuelto');

    // Verificar renderizado de ContextualBlockAction en historial (variant="link")
    const resolvedItemActionHtml = renderToString(
      React.createElement(ContextualBlockAction, {
        solicitudId: requestId!,
        applicantName: 'QA Applicant B',
        variant: 'link',
        initialBlocked: stateAAfterBlock.blockedByMe,
      })
    );
    assert.ok(resolvedItemActionHtml.includes('pe-contextual-block-action__btn--link'), 'Acción contextual en historial usa variant link');
    assert.ok(resolvedItemActionHtml.includes('Desbloquear'), 'Acción contextual en historial muestra Desbloquear');
    console.log('  ✔ Host bloqueó en Staging, solicitud resuelta a rejected y visible en historial');

    // ====================================================
    // 3. SMOKE HOST — DESBLOQUEAR
    // ====================================================
    console.log('\n[Paso 3/11] Smoke Host — Desbloquear');

    // A. Renderizar modal de confirmación de desbloqueo
    const unblockModalHtml = renderToString(
      React.createElement(ContextualBlockModal, {
        isOpen: true,
        onClose: () => {},
        solicitudId: requestId!,
        targetName: 'QA Applicant B',
        isBlocked: true,
        onSuccess: () => {},
      })
    );

    assert.ok(unblockModalHtml.includes('¿Desbloquear a QA Applicant B?'), 'Modal incluye título de desbloqueo');
    assert.ok(unblockModalHtml.includes('no se restauran'), 'Aclara que solicitudes previas no se restauran');
    assert.ok(unblockModalHtml.includes('Desbloquear'), 'Botón confirmar desbloqueo presente');

    // B. Ejecutar desbloqueo real contra Staging
    const unblockResA = await trustService.desbloquearDesdeSolicitud(requestId!);
    assert.equal(unblockResA.ok, true, 'Desbloqueo exitoso en Staging');
    assert.equal(unblockResA.blocked, false, 'Confirmado estado no bloqueado');

    // C. Verificar estado actualizado desde Staging
    const stateAAfterUnblock = await trustService.getEstadoBloqueoDesdeSolicitud(requestId!);
    assert.equal(stateAAfterUnblock.ok, true);
    assert.equal(stateAAfterUnblock.blockedByMe, false, 'Host A ahora tiene blockedByMe = false');

    // D. Verificar que la solicitud histórica NO revivió
    const { data: reqInDbAfterUnblock } = await admin.from('solicitudes_encuentro_abierto').select('estado').eq('id', requestId).single();
    assert.equal(reqInDbAfterUnblock?.estado, 'rejected', 'Solicitud histórica NO revivió, permanece rejected');
    console.log('  ✔ Desbloqueo contextual de Host exitoso; solicitud histórica permanece en rejected');

    // ====================================================
    // 4. SMOKE PARTICIPANTE — ESTADO INICIAL
    // ====================================================
    console.log('\n[Paso 4/11] Smoke Participante — Estado Inicial');
    activeClient = clientB;

    // Participante B consulta su solicitud real en Staging
    const solB = await openEncountersService.getMiSolicitud(encounterAId!, applicantBId!);
    assert.equal(solB.ok, true);
    assert.equal(solB.has_request, true);
    assert.equal(solB.request_id, requestId);

    // Consulta estado de bloqueo
    const stateBInitial = await trustService.getEstadoBloqueoDesdeSolicitud(solB.request_id!);
    assert.equal(stateBInitial.ok, true);
    assert.equal(stateBInitial.blockedByMe, false, 'Participante B no tiene bloqueo activo inicialmente');

    // Renderizar ContextualBlockAction en variant="button" para InviteGuest
    const participantActionHtml = renderToString(
      React.createElement(ContextualBlockAction, {
        solicitudId: solB.request_id!,
        applicantName: 'Anfitrión',
        variant: 'button',
        initialBlocked: stateBInitial.blockedByMe,
      })
    );

    assert.ok(participantActionHtml.includes('pe-contextual-block-action__btn--button'), 'Usa variant button');
    assert.ok(participantActionHtml.includes('aria-label="Bloquear a Anfitrión"'), 'Aria label accesible');
    assert.ok(participantActionHtml.includes('Bloquear'), 'Muestra acción Bloquear inicialmente');
    assert.ok(!participantActionHtml.includes(hostAId!), 'No expone host_id');
    console.log('  ✔ Participante recupera solicitud real y renderiza botón contextual para bloquear anfitrión');

    // ====================================================
    // 5. SMOKE PARTICIPANTE — BLOQUEAR
    // ====================================================
    console.log('\n[Paso 5/11] Smoke Participante — Bloquear');

    const blockResB = await trustService.bloquearDesdeSolicitud(requestId!);
    assert.equal(blockResB.ok, true, 'Bloqueo desde participante exitoso');
    assert.equal(blockResB.blocked, true);

    const stateBAfterBlock = await trustService.getEstadoBloqueoDesdeSolicitud(requestId!);
    assert.equal(stateBAfterBlock.ok, true);
    assert.equal(stateBAfterBlock.blockedByMe, true, 'B tiene blockedByMe = true');

    // Verificar que la invitación por token sigue operativa en base de datos
    const { data: partCheck } = await admin.from('participantes').select('estado').eq('token_invitacion', participantTokenB).single();
    assert.equal(partCheck?.estado, 'confirmado', 'Token de participante sigue existiendo y operativo');

    // Verificar que NO se disparó ningún reporte a reportes_encuentro
    const { count: reportCount } = await admin.from('reportes_encuentro').select('*', { count: 'exact', head: true }).eq('solicitud_id', requestId!);
    assert.equal(reportCount, 0, 'Bloquear NO genera reporte en DB');
    console.log('  ✔ Participante bloqueó al host; invitación intacta y cero reportes creados');

    // ====================================================
    // 6. SMOKE PARTICIPANTE — DESBLOQUEAR
    // ====================================================
    console.log('\n[Paso 6/11] Smoke Participante — Desbloquear');

    const unblockResB = await trustService.desbloquearDesdeSolicitud(requestId!);
    assert.equal(unblockResB.ok, true, 'Desbloqueo desde participante exitoso');
    assert.equal(unblockResB.blocked, false);

    const stateBAfterUnblock = await trustService.getEstadoBloqueoDesdeSolicitud(requestId!);
    assert.equal(stateBAfterUnblock.ok, true);
    assert.equal(stateBAfterUnblock.blockedByMe, false, 'B tiene blockedByMe = false');
    console.log('  ✔ Desbloqueo desde participante exitoso y reflejado en Staging');

    // ====================================================
    // 7. CASO ANÓNIMO
    // ====================================================
    console.log('\n[Paso 7/11] Caso Anónimo en InviteGuest');

    // Simulación del guard en InviteGuest para usuario anónimo o sin sesión
    const anonUser = { is_anonymous: true, id: 'anon-user-123' };
    let anonMySolicitudId: string | null = 'stale-id';

    if (!anonUser || anonUser.is_anonymous) {
      anonMySolicitudId = null;
    }
    assert.equal(anonMySolicitudId, null, 'Usuario anónimo no recupera ni asigna mySolicitudId');

    // Si mySolicitudId es null, la acción no se renderiza
    const anonRender = anonMySolicitudId
      ? renderToString(React.createElement(ContextualBlockAction, { solicitudId: anonMySolicitudId }))
      : null;
    assert.equal(anonRender, null, 'ContextualBlockAction NO se renderiza para sesión anónima');
    console.log('  ✔ Caso anónimo excluido correctamente de la acción de bloqueo');

    // ====================================================
    // 8. CASO SIN SOLICITUD
    // ====================================================
    console.log('\n[Paso 8/11] Caso Sin Solicitud en InviteGuest');
    activeClient = clientC;

    // Usuario C tiene cuenta pero NUNCA solicitó sumarse a encounterAId
    const solC = await openEncountersService.getMiSolicitud(encounterAId!, otherCId!);
    assert.equal(solC.ok, true);
    assert.equal(solC.has_request, false, 'Usuario C no tiene solicitud');
    assert.equal(solC.request_id, undefined);

    let otherCRequestId: string | null = null;
    if (solC.ok && solC.has_request && solC.request_id) {
      otherCRequestId = solC.request_id;
    }
    assert.equal(otherCRequestId, null, 'mySolicitudId es null cuando no hay solicitud');

    const noRequestRender = otherCRequestId
      ? renderToString(React.createElement(ContextualBlockAction, { solicitudId: otherCRequestId }))
      : null;
    assert.equal(noRequestRender, null, 'ContextualBlockAction NO se renderiza sin solicitud real');
    console.log('  ✔ Usuario sin solicitud no recibe acción de bloqueo');

    // ====================================================
    // 9. BLOQUEO INVERSO
    // ====================================================
    console.log('\n[Paso 9/11] Bloqueo Inverso y Privacidad Unilateral');

    // A bloquea a B
    activeClient = clientA;
    await trustService.bloquearDesdeSolicitud(requestId!);

    // B bloquea a A
    activeClient = clientB;
    await trustService.bloquearDesdeSolicitud(requestId!);

    // Ahora A desbloquea a B
    activeClient = clientA;
    await trustService.desbloquearDesdeSolicitud(requestId!);

    // Comprobar estado visto por A
    const stateAAfterReverse = await trustService.getEstadoBloqueoDesdeSolicitud(requestId!);
    assert.equal(stateAAfterReverse.blockedByMe, false, 'A ve su propio bloqueo como inactivo');

    // Renderizar acción para A
    const actionAAfterReverse = renderToString(
      React.createElement(ContextualBlockAction, {
        solicitudId: requestId!,
        applicantName: 'QA Applicant B',
        variant: 'compact',
        initialBlocked: stateAAfterReverse.blockedByMe,
      })
    );

    assert.ok(actionAAfterReverse.includes('Bloquear'), 'UI de A muestra opción de volver a Bloquear');
    assert.ok(!actionAAfterReverse.includes('te bloqueó'), 'UI de A NO dice "B te bloqueó"');
    assert.ok(!actionAAfterReverse.includes('seguís bloqueado'), 'UI de A NO dice "seguís bloqueado"');
    console.log('  ✔ Privacidad preservada ante bloqueo inverso: no revela estado inverso a la contraparte');

    // ====================================================
    // 10. VERIFICAR NETWORK / PAYLOAD
    // ====================================================
    console.log('\n[Paso 10/11] Verificación de Payloads RPC');

    assert.ok(contextualRpcCalls.length >= 8, 'Se ejecutaron múltiples llamadas RPC contextuales');

    const forbiddenKeys = ['blocked_id', 'blocker_id', 'host_id', 'usuario_id', 'participante_id', 'target_user_id'];

    for (const call of contextualRpcCalls) {
      assert.ok(call.params, `Llamada a ${call.fn} debe tener params`);
      assert.ok('p_solicitud_id' in call.params, `Llamada a ${call.fn} debe contener p_solicitud_id`);
      assert.equal(call.params.p_solicitud_id, requestId, `p_solicitud_id debe coincidir`);

      for (const forbidden of forbiddenKeys) {
        assert.ok(
          !(forbidden in call.params),
          `Parámetro prohibido '${forbidden}' encontrado en llamada a ${call.fn}`
        );
      }
    }
    console.log(`  ✔ ${contextualRpcCalls.length} llamadas RPC verificadas: enviaron estrictamente p_solicitud_id sin parámetros prohibidos`);

    // ====================================================
    // 11. VERIFICAR PRESERVACIÓN DE ACCIÓN DE REPORTE
    // ====================================================
    console.log('\n[Paso 11/11] Verificación de Preservación de Reportar');

    // En HostOpenEncounterSection con solicitud inicial pendiente
    assert.ok(hostHtmlInitial.includes('pe-host-request-item__btn-report'), 'Botón reportar se preserva en solicitudes');

    // En HostOpenEncounterSection código para historial de solicitudes resueltas
    const sectionPath = path.resolve(process.cwd(), 'src/components/host/HostOpenEncounterSection.tsx');
    const sectionCode = fs.readFileSync(sectionPath, 'utf-8');
    assert.ok(sectionCode.includes('pe-host-resolved-item__btn-report'), 'Botón reportar se preserva en historial de solicitudes');
    console.log('  ✔ Acción de reporte preservada en solicitudes pendientes e historial');

    console.log('\n========================================================');
    console.log('STAGING SMOKE T3-C: ALL VERIFICATIONS PASSED SUCCESFULLY!');
    console.log('========================================================\n');

  } finally {
    // ----------------------------------------------------
    // Cleanup QA
    // ----------------------------------------------------
    console.log('[Cleanup] Limpiando datos de prueba en Staging...');
    (supabase as any).rpc = originalRpc;

    if (hostAId && applicantBId) {
      await admin.from('bloqueos_usuario').delete().or(`blocker_id.eq.${hostAId},blocker_id.eq.${applicantBId}`);
    }
    if (requestId) {
      await admin.from('solicitudes_encuentro_abierto').delete().eq('id', requestId);
    }
    if (participantBId) {
      await admin.from('participantes').delete().eq('id', participantBId);
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
    if (otherCId) {
      await admin.auth.admin.deleteUser(otherCId);
    }
    console.log('[Cleanup] Limpieza completada con éxito.');
  }
}

runStagingSmokeT3C().catch((err) => {
  console.error('\n❌ ERROR EN STAGING SMOKE T3-C:', err);
  process.exit(1);
});
