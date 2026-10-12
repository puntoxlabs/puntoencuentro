/**
 * Staging Smoke QA E2E — Cupos Canónicos y Reserva Múltiple V1
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Caso Canónico Controlado de Producto (Sección 37):
 * - Título privado: 'Cena de 5 pasos privada'
 * - Título público: 'Cena de 5 pasos'
 * - Descripción pública: 'Menú degustación con maridaje en Güemes'
 * - Modalidad: 'presencial'
 * - Zona pública: 'Güemes / Playa Grande'
 * - Lugares configurados: 14
 * - Reserva múltiple: habilitada
 * - Máximo de lugares por solicitud: 4
 *
 * Verificaciones E2E:
 * 1. Inicial: Host = 14, Discovery = 14, Detalle = 14 (NO 15)
 * 2. Solicitud A (3 lugares) aprobada -> pasa a 11
 * 3. Solicitud B (2 lugares) pendiente -> sigue en 11
 * 4. Solicitud C (5 lugares > 4) -> rechazada por el backend (seats_exceed_limit)
 * 5. Sobrecupo: 2 lugares libres, solicitud de 3 lugares -> rechazo atómico (quota_exceeded)
 * 6. Liberación: Cancelar solicitud de 3 lugares -> cupo se libera de inmediato
 * 7. Limpieza exhaustiva de fixtures
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

async function runStagingSmokeQuotasAndMultiSeat() {
  console.log('========================================================');
  console.log('STAGING SMOKE E2E REAL: CUPOS Y RESERVA MÚLTIPLE V1');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  const qaPass = 'QaQuotasPass123!Safe';

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
    // 1. Crear usuarios de prueba
    console.log('1. Creando usuarios de prueba en Staging...');
    const hostId = await createQAUser(`qa-quota-host-${timestamp}@test.com`, 'Host Cena');
    const userAId = await createQAUser(`qa-quota-user-a-${timestamp}@test.com`, 'Ana Solicitante');
    const userBId = await createQAUser(`qa-quota-user-b-${timestamp}@test.com`, 'Beto Solicitante');
    const userCId = await createQAUser(`qa-quota-user-c-${timestamp}@test.com`, 'Carlos Solicitante');
    const userDId = await createQAUser(`qa-quota-user-d-${timestamp}@test.com`, 'Damián Solicitante');

    const hostClient = await createAuthClient(hostId);
    const clientA = await createAuthClient(userAId);
    const clientB = await createAuthClient(userBId);
    const clientC = await createAuthClient(userCId);
    const clientD = await createAuthClient(userDId);

    // 2. Crear encuentro canónico de 14 lugares, multi-seat = true, max 4
    console.log('2. Creando encuentro base en Staging...');
    const futureDate = new Date(Date.now() + 86400000 * 5).toISOString().split('T')[0];

    const { data: encCreated, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostId,
        titulo: 'Cena de 5 pasos privada',
        open_public_title: 'Cena de 5 pasos',
        descripcion: 'Detalle privado del anfitrión',
        open_description: 'Menú degustación con maridaje en Güemes',
        modalidad: 'presencial',
        lugar_texto: 'Alvarado 1234, Mar del Plata',
        locality_id: 'guemes',
        open_public_zone: 'Güemes / Playa Grande',
        tipo_invitacion: 'link_general',
        max_participants: 14,
        allow_multi_seat_requests: true,
        max_seats_per_request: 4,
        fecha: futureDate,
        hora: '21:00:00',
        is_open: true,
        opened_at: new Date().toISOString(),
        estado: 'activo',
        moderation_status: 'approved',
      })
      .select('id')
      .single();

    if (encErr || !encCreated) throw new Error(`Error creando encuentro base: ${encErr?.message}`);
    const encounterId = encCreated.id;
    createdEncounterIds.push(encounterId);
    console.log(`  Encuentro creado con ID: ${encounterId}\n`);

    // 3. Verificación de consistencia inicial (14 vs 14 vs 14, NO 15)
    console.log('3. Verificando consistencia inicial de cupos (Host vs Discovery vs Detalle)...');
    const { data: discList, error: discErr } = await admin.rpc('get_discovery_encuentros_abiertos');
    if (discErr) throw new Error(`Error en get_discovery_encuentros_abiertos: ${discErr.message}`);
    const discEnc = (discList as any[]).find((e) => e.id === encounterId);
    assert.ok(discEnc, 'El encuentro debe aparecer en Discovery');
    assert.equal(discEnc.open_slots, 14, 'Discovery debe mostrar exactamente 14 lugares libres (NO 15)');
    assert.equal(discEnc.public_capacity, 14, 'Discovery public_capacity debe ser 14');
    assert.equal(discEnc.allow_multi_seat_requests, true, 'allow_multi_seat_requests debe ser true');
    assert.equal(discEnc.max_seats_per_request, 4, 'max_seats_per_request debe ser 4');
    console.log(`  ✔ Discovery: open_slots = ${discEnc.open_slots}, public_capacity = ${discEnc.public_capacity}`);

    const { data: hostDet, error: hostErr } = await hostClient.rpc('get_detalle_host_seguro', {
      p_encuentro_id: encounterId,
      p_host_id: hostId,
    });
    if (hostErr) throw new Error(`Error en get_detalle_host_seguro: ${hostErr.message}`);
    assert.equal((hostDet as any).available_slots, 14, 'Host disponible debe ser exactamente 14 (NO 15)');
    assert.equal((hostDet as any).max_participants, 14, 'Host max_participants debe ser 14');
    assert.equal((hostDet as any).confirmed_seats, 0, 'Host confirmed_seats debe ser 0');
    console.log(`  ✔ Host Detalle: available_slots = ${(hostDet as any).available_slots}, confirmed = ${(hostDet as any).confirmed_seats}`);
    console.log('  ✔ Consistencia canónica P0 verificada: Host 14 = Discovery 14 = Detalle 14 (CERO sobrecupo anfitrión)\n');

    // 4. Solicitud A: Ana pide 3 lugares
    console.log('4. Solicitud A: Ana solicita 3 lugares...');
    const { data: reqAData, error: reqAErr } = await clientA.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Ana',
      p_mensaje: 'Hola, somos 3 personas!',
      p_seat_count: 3,
    });
    if (reqAErr) throw new Error(`Error solicitando A: ${reqAErr.message}`);
    assert.equal((reqAData as any).ok, true);
    assert.equal((reqAData as any).seat_count, 3);
    const reqAId = (reqAData as any).request_id;
    console.log(`  ✔ Solicitud A registrada con ID: ${reqAId}, seat_count = 3`);

    // Comprobar que mientras está pendiente, Discovery sigue en 14
    const { data: discPending } = await admin.rpc('get_discovery_encuentros_abiertos');
    const encPending = (discPending as any[]).find((e) => e.id === encounterId);
    assert.equal(encPending.open_slots, 14, 'Con solicitud pendiente, Discovery sigue mostrando 14');
    console.log('  ✔ Solicitud pendiente NO reserva cupo: open_slots sigue en 14');

    // Host aprueba Solicitud A
    console.log('  Host aprueba Solicitud A (3 lugares)...');
    const { data: appAData, error: appAErr } = await hostClient.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: reqAId,
    });
    if (appAErr) throw new Error(`Error aprobando A: ${appAErr.message}`);
    assert.equal((appAData as any).ok, true);
    assert.equal((appAData as any).seat_count, 3);
    assert.equal((appAData as any).nuevo_cupo_disponible, 11);
    const participanteAId = (appAData as any).participante_id;
    console.log(`  ✔ Solicitud A aprobada. nuevo_cupo_disponible retornado = 11`);

    // Verificar en Discovery y Host que pasó a 11
    const { data: discAfterA } = await admin.rpc('get_discovery_encuentros_abiertos');
    const encAfterA = (discAfterA as any[]).find((e) => e.id === encounterId);
    assert.equal(encAfterA.open_slots, 11, 'Discovery debe mostrar exactamente 11');
    assert.equal(encAfterA.confirmed_count, 3, 'Discovery confirmed_count debe ser 3');

    const { data: hostAfterA } = await hostClient.rpc('get_detalle_host_seguro', {
      p_encuentro_id: encounterId,
      p_host_id: hostId,
    });
    assert.equal((hostAfterA as any).available_slots, 11, 'Host available_slots debe ser 11');
    assert.equal((hostAfterA as any).confirmed_seats, 3, 'Host confirmed_seats debe ser 3');
    console.log('  ✔ Aprobación de 3 lugares reduce atómicamente cupos a 11 en Discovery y Host\n');

    // 5. Solicitud B: Beto pide 2 lugares y queda pendiente
    console.log('5. Solicitud B: Beto solicita 2 lugares (pendiente)...');
    const { data: reqBData, error: reqBErr } = await clientB.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Beto',
      p_mensaje: 'Somos 2',
      p_seat_count: 2,
    });
    if (reqBErr) throw new Error(`Error solicitando B: ${reqBErr.message}`);
    assert.equal((reqBData as any).ok, true);
    assert.equal((reqBData as any).seat_count, 2);

    // Cupo debe seguir exactamente en 11
    const { data: discAfterB } = await admin.rpc('get_discovery_encuentros_abiertos');
    const encAfterB = (discAfterB as any[]).find((e) => e.id === encounterId);
    assert.equal(encAfterB.open_slots, 11, 'Con solicitud B pendiente, cupo disponible se mantiene en 11');
    console.log('  ✔ Cupo verificado: 11 disponibles\n');

    // 6. Solicitud C: Cliente manipulado pide 5 lugares (> max_seats_per_request = 4)
    console.log('6. Solicitud C: Manipulación de cliente pidiendo 5 lugares (> 4)...');
    const { data: reqCData, error: reqCErr } = await clientC.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Carlos',
      p_mensaje: 'Quiero 5 lugares',
      p_seat_count: 5,
    });
    if (reqCErr) throw new Error(`RPC error inesperado: ${reqCErr.message}`);
    assert.equal((reqCData as any).ok, false, 'Backend debe rechazar solicitud que supera max_seats_per_request');
    assert.equal((reqCData as any).error, 'seats_exceed_limit', 'Error debe ser seats_exceed_limit');
    console.log('  ✔ Backend rechazó con fail-closed: error = seats_exceed_limit\n');

    // 7. Sobrecupo Concurrente / Límite
    console.log('7. Verificando protección contra sobrecupo (dejando 2 libres e intentando aprobar 3)...');
    // Aprobamos a Beto (2 lugares) -> cupo pasa a 11 - 2 = 9
    const reqBId = (reqBData as any).request_id;
    const { data: appBData } = await hostClient.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: reqBId,
    });
    assert.equal((appBData as any).ok, true);
    assert.equal((appBData as any).nuevo_cupo_disponible, 9);

    // Simulamos ocupación adicional para dejar exactamente 2 lugares libres:
    // Insertamos directamente un participante con 7 lugares (total confirmados = 3 + 2 + 7 = 12 de 14 -> quedan 2)
    const { error: insertSimErr } = await admin.from('participantes').insert({
      encuentro_id: encounterId,
      user_id: userCId,
      nombre_invitado: 'Grupo Amigos',
      tipo_invitacion: 'individual',
      estado: 'confirmado',
      seat_count: 7,
    });
    if (insertSimErr) throw new Error(`Error en insert sim: ${insertSimErr.message}`);

    // Verificamos que quedan exactamente 2 lugares libres
    const { data: hostBeforeOver } = await hostClient.rpc('get_detalle_host_seguro', {
      p_encuentro_id: encounterId,
      p_host_id: hostId,
    });
    assert.equal((hostBeforeOver as any).available_slots, 2, 'Deben quedar exactamente 2 lugares libres');
    console.log('  Quedan 2 lugares libres. Damián solicita 3 lugares...');

    // Damián solicita 3 lugares (permitido pedir hasta 4)
    const { data: reqDData } = await clientD.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Damián',
      p_mensaje: 'Queremos 3 lugares',
      p_seat_count: 3,
    });
    const reqDId = (reqDData as any).request_id;

    // Host intenta aprobar a Damián (3 lugares cuando solo hay 2 disponibles)
    const { data: appDData } = await hostClient.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: reqDId,
    });
    assert.equal((appDData as any).ok, false, 'Aprobación debe fallar');
    assert.equal((appDData as any).error, 'quota_exceeded', 'Debe retornar error quota_exceeded');
    console.log('  ✔ Servidor impidió atómicamente el sobrecupo bajo lock: error = quota_exceeded\n');

    // 8. Liberación tras cancelación
    console.log('8. Verificando liberación automática al cancelar o eliminar participante...');
    // Eliminamos el grupo de 7 y la solicitud de Beto (2) para volver al estado donde Ana tenía 3 ocupados (11 libres)
    await admin.from('participantes').delete().eq('encuentro_id', encounterId).eq('nombre_invitado', 'Grupo Amigos');
    await admin.from('participantes').delete().eq('encuentro_id', encounterId).eq('nombre_invitado', 'Beto');

    const { data: checkBeforeCancel } = await hostClient.rpc('get_detalle_host_seguro', {
      p_encuentro_id: encounterId,
      p_host_id: hostId,
    });
    assert.equal((checkBeforeCancel as any).available_slots, 11, 'Con solo Ana confirmada (3), hay 11 libres');

    // Host cancela o elimina participante de Ana (3 lugares)
    await admin.from('participantes').delete().eq('id', participanteAId);

    // Verificamos que los cupos vuelven automáticamente a 14
    const { data: discAfterCancel } = await admin.rpc('get_discovery_encuentros_abiertos');
    const encAfterCancel = (discAfterCancel as any[]).find((e) => e.id === encounterId);
    assert.equal(encAfterCancel.open_slots, 14, 'Al cancelar participante de 3, Discovery vuelve inmediatamente a 14');

    const { data: hostAfterCancel } = await hostClient.rpc('get_detalle_host_seguro', {
      p_encuentro_id: encounterId,
      p_host_id: hostId,
    });
    assert.equal((hostAfterCancel as any).available_slots, 14, 'Host vuelve inmediatamente a 14');
    assert.equal((hostAfterCancel as any).confirmed_seats, 0, 'Confirmados vuelve a 0');
    console.log('  ✔ Liberación confirmada: disponible pasó de 11 a 14 automáticamente\n');

    console.log('========================================================');
    console.log('TODAS LAS PRUEBAS DE CUPOS Y RESERVA MÚLTIPLE EN STAGING PASARON');
    console.log('========================================================\n');
  } finally {
    console.log('Limpiando fixtures de prueba en Staging...');
    if (createdEncounterIds.length > 0) {
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    if (createdUserIds.length > 0) {
      await admin.from('inbox_notifications').delete().in('recipient_user_id', createdUserIds);
      await admin.from('domain_events_outbox').delete().in('actor_user_id', createdUserIds);
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
    }
    console.log('Limpieza de fixtures completada.');
  }
}

runStagingSmokeQuotasAndMultiSeat()
  .then(() => {
    console.log('EXITO TOTAL VALIDACION STAGING');
    process.exit(0);
  })
  .catch((err) => {
    console.error('ERROR VALIDACION STAGING:', err);
    process.exit(1);
  });
