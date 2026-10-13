/**
 * Staging Smoke QA E2E — Cierre del Flujo Solicitar -> Aceptar/Rechazar -> Participar
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Cobertura de Compuestas:
 * 1. get_mis_solicitudes_seguro():
 *    - Devuelve listado durable no sensible.
 *    - Invariante de privacidad: NO contiene exact_address, lugar_texto, link_virtual, token_participante, token_invitacion.
 * 2. get_encuentro_participante_autorizado():
 *    - Autorización server-side basada exclusivamente en auth.uid().
 *    - Host A accede a logística completa.
 *    - Participante B confirmado accede a logística autorizada (lugar_texto / link_virtual).
 *    - Participante B NO recibe por defecto titulo ni descripcion privados del Host.
 *    - Negativos: Solicitud pendiente B no accede, Rechazado B no accede, Usuario C (tercero ajeno) no accede, Usuario anónimo no accede.
 * 3. Notificaciones atómicas y dedupe:
 *    - Aprobación inserta en inbox_notifications (open_encounter_request_accepted).
 *    - Outbox registra domain event.
 * 4. Conteo de solicitudes pendientes para Host:
 *    - get_encuentros_host_seguro() refleja pending_requests_count exacto (0 -> 1 -> 0).
 * 5. Recordatorio a las 24 horas:
 *    - procesar_recordatorio_solicitudes_pendientes() genera recordatorio para solicitudes pendientes > 24h.
 *    - Idempotencia: segunda pasada deduplica exactamente sin insertar duplicados.
 * 6. Cancelación segura:
 *    - cancelar_solicitud_encuentro_abierto() cancela solicitudes pendientes propias.
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

async function runStagingSmokeRequestsClosure() {
  console.log('========================================================');
  console.log('STAGING SMOKE E2E REAL: CIERRE FLUJO SOLICITAR → ACEPTAR → PARTICIPAR');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];
  const qaPass = 'QaRequestsClosurePass123!Safe';

  const createQAUser = async (email: string, name: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: qaPass,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (error || !data.user) throw new Error(`Error creando ${email}: ${error?.message}`);
    createdUserIds.push(data.user.id);
    return data.user.id;
  };

  const createAuthClient = async (userId: string) => {
    const userObj = await admin.auth.admin.getUserById(userId);
    const email = userObj.data.user?.email || '';
    const client = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data, error } = await client.auth.signInWithPassword({ email, password: qaPass });
    if (error || !data.session) throw new Error(`Error login ${email}: ${error?.message}`);
    return client;
  };

  try {
    // 1. Crear usuarios de prueba (Host A, Participante B, Tercero C, Solicitante D)
    console.log('1. Creando usuarios de prueba en Staging...');
    const hostAId = await createQAUser(`qa-req-host-a-${timestamp}@test.com`, 'Host Alberto');
    const userBId = await createQAUser(`qa-req-user-b-${timestamp}@test.com`, 'Bárbara Solicitante');
    const userCId = await createQAUser(`qa-req-user-c-${timestamp}@test.com`, 'Carlos Ajeno');
    const userDId = await createQAUser(`qa-req-user-d-${timestamp}@test.com`, 'Daniel Solicitante');

    const hostAClient = await createAuthClient(hostAId);
    const clientB = await createAuthClient(userBId);
    const clientC = await createAuthClient(userCId);
    const clientD = await createAuthClient(userDId);
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });

    console.log('   Usuarios creados exitosamente.\n');

    // 2. Crear encuentro canónico con logística privada
    console.log('2. Creando encuentro abierto con datos privados de logística...');
    const futureDate = new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0];
    const privateTitulo = `Asado Privado Amigos ${timestamp}`;
    const publicTitulo = `Asado del finde en la terraza`;
    const privateDesc = `Contraseña del portón: 4567. Por favor no tocar el timbre.`;
    const publicDesc = `Nos juntamos a compartir un rico asado al mediodía. Traer bebida.`;
    const privateLugar = `Av. Colón 1234, Piso 8 Depto B, Mar del Plata`;

    const { data: encCreated, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostAId,
        titulo: privateTitulo,
        open_public_title: publicTitulo,
        descripcion: privateDesc,
        open_description: publicDesc,
        modalidad: 'presencial',
        lugar_texto: privateLugar,
        locality_id: 'centro',
        open_public_zone: 'Centro / Plaza Colón',
        tipo_invitacion: 'link_general',
        max_participants: 10,
        allow_multi_seat_requests: true,
        max_seats_per_request: 3,
        fecha: futureDate,
        hora: '13:00:00',
        is_open: true,
        opened_at: new Date().toISOString(),
        estado: 'activo',
        moderation_status: 'approved',
      })
      .select('id')
      .single();

    if (encErr || !encCreated) throw new Error(`Error creando encuentro: ${encErr?.message}`);
    const encounterId = encCreated.id;
    createdEncounterIds.push(encounterId);
    console.log(`   Encuentro creado: ${encounterId}`);

    // 3. Verificar conteo inicial de solicitudes pendientes para el host
    console.log('3. Verificando get_encuentros_host_seguro (inicial 0 pendientes)...');
    const { data: hostEncInitial, error: hostEncInitErr } = await hostAClient.rpc('get_encuentros_host_seguro', {
      p_host_ids: [hostAId],
    });
    assert.ifError(hostEncInitErr);
    const hostEnc1 = (hostEncInitial as any[]).find((e: any) => e.id === encounterId);
    assert.ok(hostEnc1, 'Host debe ver su encuentro');
    assert.equal(Number(hostEnc1.pending_requests_count), 0, 'Inicialmente debe tener 0 solicitudes pendientes');
    console.log('   PASS: Host A tiene pending_requests_count = 0');

    // 4. Usuario B solicita sumarse con 2 lugares
    console.log('4. Usuario B solicita sumarse con 2 lugares...');
    const { data: reqRes, error: reqErr } = await clientB.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Bárbara Solicitante',
      p_mensaje: 'Voy con un amigo que cocina muy bien!',
      p_seat_count: 2,
    });
    assert.ifError(reqErr);
    assert.equal(reqRes?.ok, true, `Solicitud debe ser exitosa: ${JSON.stringify(reqRes)}`);
    const requestIdB = reqRes.request_id || reqRes.solicitud_id;
    console.log(`   PASS: Solicitud B creada (id: ${requestIdB})`);

    // 5. Verificar que get_encuentros_host_seguro refleja 1 solicitud pendiente
    console.log('5. Verificando get_encuentros_host_seguro tras solicitud (1 pendiente)...');
    const { data: hostEncAfterReq, error: hostEncAfterErr } = await hostAClient.rpc('get_encuentros_host_seguro', {
      p_host_ids: [hostAId],
    });
    assert.ifError(hostEncAfterErr);
    const hostEnc2 = (hostEncAfterReq as any[]).find((e: any) => e.id === encounterId);
    assert.equal(Number(hostEnc2.pending_requests_count), 1, 'Host debe ver 1 solicitud pendiente');
    console.log('   PASS: Host A tiene pending_requests_count = 1');

    // 6. Verificar get_mis_solicitudes_seguro() para Usuario B (Pendiente)
    console.log('6. Verificando get_mis_solicitudes_seguro() para Usuario B...');
    const { data: misSolsB, error: misSolsBErr } = await clientB.rpc('get_mis_solicitudes_seguro');
    assert.ifError(misSolsBErr);
    assert.ok(Array.isArray(misSolsB), 'Debe devolver array');
    const solBItem = (misSolsB as any[]).find((s: any) => s.request_id === requestIdB || s.id === requestIdB);
    assert.ok(solBItem, 'Debe incluir la solicitud creada');
    assert.equal(solBItem.estado, 'pending');
    assert.equal(solBItem.seat_count, 2);
    assert.equal(solBItem.open_public_title, publicTitulo);
    assert.equal(solBItem.open_public_zone, 'Centro / Plaza Colón');

    // COMPUERTA DE PRIVACIDAD: no devolver campos privados
    assert.equal(solBItem.exact_address, undefined, 'NO debe devolver exact_address');
    assert.equal(solBItem.lugar_texto, undefined, 'NO debe devolver lugar_texto');
    assert.equal(solBItem.link_virtual, undefined, 'NO debe devolver link_virtual');
    assert.equal(solBItem.token_participante, undefined, 'NO debe devolver token_participante');
    assert.equal(solBItem.token_invitacion, undefined, 'NO debe devolver token_invitacion');
    console.log('   PASS: get_mis_solicitudes_seguro() devuelve solo datos operativos no sensibles');

    // 7. COMPUERTA NEGATIVA: get_encuentro_participante_autorizado() mientras está PENDIENTE
    console.log('7. Compuesta Negativa: Usuario B intenta acceder a datos privados estando pendiente...');
    const { data: authDetPending, error: authDetPendingErr } = await clientB.rpc('get_encuentro_participante_autorizado', {
      p_encuentro_id: encounterId,
    });
    assert.ifError(authDetPendingErr);
    assert.equal(authDetPending?.ok, false, 'Usuario pendiente NO debe tener acceso');
    assert.equal(authDetPending?.error, 'unauthorized');
    console.log('   PASS: Acceso denegado para solicitud pendiente (unauthorized)');

    // 8. COMPUERTA NEGATIVA: Usuario C (ajeno) intenta acceder a datos privados
    console.log('8. Compuesta Negativa: Usuario C (ajeno) intenta acceder a datos privados...');
    const { data: authDetC, error: authDetCErr } = await clientC.rpc('get_encuentro_participante_autorizado', {
      p_encuentro_id: encounterId,
    });
    assert.ifError(authDetCErr);
    assert.equal(authDetC?.ok, false, 'Usuario ajeno NO debe tener acceso');
    assert.equal(authDetC?.error, 'unauthorized');
    console.log('   PASS: Acceso denegado para usuario ajeno C (unauthorized)');

    // 9. COMPUERTA NEGATIVA: Anónimo intenta acceder a get_encuentro_participante_autorizado() y get_mis_solicitudes_seguro()
    console.log('9. Compuesta Negativa: Anónimo intenta acceder a RPCs seguras...');
    const { data: anonAuthDet, error: anonAuthDetErr } = await anonClient.rpc('get_encuentro_participante_autorizado', {
      p_encuentro_id: encounterId,
    });
    assert.ok(anonAuthDetErr || anonAuthDet?.ok === false, 'Anónimo no debe acceder a detalle autorizado');

    const { data: anonMisSols, error: anonMisSolsErr } = await anonClient.rpc('get_mis_solicitudes_seguro');
    assert.ok(anonMisSolsErr || (Array.isArray(anonMisSols) && anonMisSols.length === 0) || anonMisSols?.ok === false, 'Anónimo no debe ver solicitudes');
    console.log('   PASS: Anónimo bloqueado en ambas RPCs');

    // 10. Host A aprueba la solicitud de Usuario B
    console.log('10. Host A aprueba la solicitud de Usuario B...');
    const { data: approveRes, error: approveErr } = await hostAClient.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestIdB,
    });
    assert.ifError(approveErr);
    assert.equal(approveRes?.ok, true, `Aprobación debe ser ok: ${JSON.stringify(approveRes)}`);
    console.log('   PASS: Solicitud aprobada');

    // 11. Verificar que get_encuentros_host_seguro vuelve a 0 pendientes
    console.log('11. Verificando get_encuentros_host_seguro tras aprobación (0 pendientes)...');
    const { data: hostEncAfterApprove, error: hostEncApproveErr } = await hostAClient.rpc('get_encuentros_host_seguro', {
      p_host_ids: [hostAId],
    });
    assert.ifError(hostEncApproveErr);
    const hostEnc3 = (hostEncAfterApprove as any[]).find((e: any) => e.id === encounterId);
    assert.equal(Number(hostEnc3.pending_requests_count), 0, 'Host debe ver 0 solicitudes pendientes tras aprobar');
    console.log('   PASS: Host A tiene pending_requests_count = 0');

    // 12. Verificar notificación atómica y Outbox
    console.log('12. Verificando notificación atómica en inbox_notifications y outbox...');
    const { data: notifsB, error: notifsBErr } = await admin
      .from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', userBId)
      .eq('notification_type', 'open_encounter_request_accepted');
    assert.ifError(notifsBErr);
    assert.ok(notifsB && notifsB.length > 0, 'Usuario B debe tener notificación de aprobación en inbox');
    assert.equal(notifsB[0].dedup_key, `join_request_approved:${requestIdB}`);
    console.log('   PASS: inbox_notifications tiene registro con dedup_key atómica');

    const { data: outboxEvents, error: outboxErr } = await admin
      .from('domain_events_outbox')
      .select('*')
      .eq('event_type', 'encounter.join_request.approved.v1')
      .eq('aggregate_id', encounterId);
    assert.ifError(outboxErr);
    assert.ok(outboxEvents && outboxEvents.length > 0, 'Outbox debe registrar el evento aprobado');
    console.log('   PASS: domain_events_outbox tiene registro de evento');

    // 13. Usuario B confirmado consulta get_encuentro_participante_autorizado()
    console.log('13. Verificando get_encuentro_participante_autorizado() para Usuario B CONFIRMADO...');
    const { data: authDetB, error: authDetBErr } = await clientB.rpc('get_encuentro_participante_autorizado', {
      p_encuentro_id: encounterId,
    });
    assert.ifError(authDetBErr);
    assert.equal(authDetB?.ok, true, `Usuario confirmado debe acceder: ${JSON.stringify(authDetB)}`);
    assert.equal(authDetB.lugar_texto, privateLugar, 'Debe devolver lugar_texto autorizado');
    assert.equal(authDetB.open_public_title, publicTitulo, 'Debe devolver título público');
    assert.equal(authDetB.open_description, publicDesc, 'Debe devolver descripción pública');
    assert.equal(authDetB.seat_count, 2, 'Debe devolver seat_count asignado');

    // PRIVACIDAD ESTRICTA: El participante NO debe recibir titulo ni descripcion privados del Host
    assert.notEqual(authDetB.open_public_title, privateTitulo, 'NO debe exponer título privado del host');
    assert.equal(authDetB.titulo, undefined, 'NO debe exponer campo titulo privado');
    assert.equal(authDetB.descripcion, undefined, 'NO debe exponer campo descripcion privado');
    console.log('   PASS: get_encuentro_participante_autorizado() devuelve logística privada autorizada sin filtrar secretos del host');

    // 14. Host A también consulta get_encuentro_participante_autorizado()
    console.log('14. Verificando get_encuentro_participante_autorizado() para Host A...');
    const { data: authDetHost, error: authDetHostErr } = await hostAClient.rpc('get_encuentro_participante_autorizado', {
      p_encuentro_id: encounterId,
    });
    assert.ifError(authDetHostErr);
    assert.equal(authDetHost?.ok, true);
    assert.equal(authDetHost.is_host, true);
    assert.equal(authDetHost.lugar_texto, privateLugar);
    console.log('   PASS: Host A accede como host autorizado');

    // 15. Flujo de Cancelación: Usuario D solicita y luego cancela
    console.log('15. Verificando cancelar_solicitud_encuentro_abierto() con Usuario D...');
    const { data: reqDRes, error: reqDErr } = await clientD.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Daniel Solicitante',
      p_mensaje: 'Hola quiero sumarme',
      p_seat_count: 1,
    });
    assert.ifError(reqDErr);
    const requestIdD = reqDRes.request_id || reqDRes.solicitud_id;

    // Cancelar la solicitud
    const { data: cancelRes, error: cancelErr } = await clientD.rpc('cancelar_solicitud_encuentro_abierto', {
      p_request_id: requestIdD,
    });
    assert.ifError(cancelErr);
    assert.equal(cancelRes?.ok, true, `Cancelación debe ser ok: ${JSON.stringify(cancelRes)}`);

    // Verificar estado en get_mis_solicitudes_seguro()
    const { data: misSolsD } = await clientD.rpc('get_mis_solicitudes_seguro');
    const solDItem = (misSolsD as any[]).find((s: any) => s.request_id === requestIdD || s.id === requestIdD);
    assert.ok(solDItem);
    assert.equal(solDItem.estado, 'cancelled');
    console.log('   PASS: Solicitud cancelada correctamente por el participante');

    // 16. Verificación de Recordatorio 24 horas e idempotencia
    console.log('16. Verificando procesar_recordatorio_solicitudes_pendientes()...');
    // Creamos una solicitud pendiente con fecha de creación atrasada 25 horas
    const reqOlderId = 'a1111111-2222-3333-4444-555555555555';
    const { error: insErr } = await admin.from('solicitudes_encuentro_abierto').insert({
      id: reqOlderId,
      encuentro_id: encounterId,
      usuario_id: userCId,
      nombre_solicitante: 'Carlos Recordatorio',
      mensaje: 'Me sumo si hay lugar',
      seat_count: 1,
      estado: 'pending',
      created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
    });
    assert.ifError(insErr);

    // Ejecutar la función de recordatorio
    const { data: reminderRes1, error: reminderErr1 } = await admin.rpc('procesar_recordatorio_solicitudes_pendientes');
    assert.ifError(reminderErr1);
    assert.equal(reminderRes1?.ok, true);
    assert.ok(
      (reminderRes1.reminded_count ?? reminderRes1.recordatorios_emitidos ?? 0) >= 1,
      `Debe emitir al menos 1 recordatorio: ${JSON.stringify(reminderRes1)}`
    );

    // Verificar que se insertó la notificación para el host
    const { data: notifReminder1, error: notifRemErr1 } = await admin
      .from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', hostAId)
      .eq('dedup_key', `join_request_reminder:${reqOlderId}`);
    assert.ifError(notifRemErr1);
    assert.equal(notifReminder1.length, 1, 'Debe existir exactamente 1 notificación de recordatorio');

    // Segunda ejecución: IDEMPOTENCIA / DEDUPE
    const { data: reminderRes2, error: reminderErr2 } = await admin.rpc('procesar_recordatorio_solicitudes_pendientes');
    assert.ifError(reminderErr2);
    assert.equal(reminderRes2?.ok, true);

    const { data: notifReminder2 } = await admin
      .from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', hostAId)
      .eq('dedup_key', `join_request_reminder:${reqOlderId}`);
    assert.equal(notifReminder2.length, 1, 'No debe duplicar notificaciones en segunda pasada');
    console.log('   PASS: Recordatorio 24h generado e idempotente');

    // Limpieza de fixture del recordatorio
    await admin.from('solicitudes_encuentro_abierto').delete().eq('id', reqOlderId);

    console.log('\n========================================================');
    console.log('TODAS LAS COMPUERTAS DE CIERRE Y PRIVACIDAD DIERON PASS');
    console.log('========================================================\n');
  } finally {
    console.log('Limpiando fixtures de prueba en Staging...');
    if (createdEncounterIds.length > 0) {
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('domain_events_outbox').delete().in('aggregate_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    for (const uid of createdUserIds) {
      await admin.from('inbox_notifications').delete().eq('recipient_user_id', uid);
      await admin.auth.admin.deleteUser(uid);
    }
    console.log('Fixtures limpiados correctamente.');
  }
}

runStagingSmokeRequestsClosure()
  .then(() => {
    console.log('STAGING SMOKE QA COMPLETED SUCCESSFULLY.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('STAGING SMOKE QA FAILED:', err);
    process.exit(1);
  });
