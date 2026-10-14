/**
 * Staging QA REAL — Concurrencia de cupos (solicitudes y aprobaciones simultáneas)
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging). Guard: assertStagingEnvironment().
 *
 * Escenario:
 *   capacidad = 5, confirmed_seats = 3 (1 titular con seat_count = 3), available_slots = 2
 *   A solicita 2, B solicita 2, C solicita 1 (en paralelo)
 *   -> las 3 quedan pending, available_slots sigue en 2 (pending NO reserva)
 *   Host aprueba A y B en paralelo
 *   -> exactamente una PASS y otra quota_exceeded, confirmed_seats = 5, available_slots = 0
 *   Completo:
 *   -> nueva solicitud => encounter_full; las pendientes se conservan;
 *      aprobar C (1) con 0 libres => quota_exceeded
 *   Liberación:
 *   -> Host elimina al titular de 2 => available_slots = 2, pendientes siguen presentes,
 *      nueva solicitud vuelve a aceptarse, y puede aprobarse la pendiente de 2.
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

const admin = createClient(url, getStagingSecretKey(), { auth: { persistSession: false } });
const publishableKey = getStagingPublishableKey();

async function run() {
  console.log('========================================================');
  console.log('STAGING QA REAL: CONCURRENCIA DE CUPOS');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  const ts = Date.now();
  const qaPass = 'QaConcurrencyPass123!Safe';
  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  const createQAUser = async (tag: string, name: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `qa-conc-${tag}-${ts}@test.com`,
      password: qaPass,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (error || !data.user) throw new Error(`Error creando ${tag}: ${error?.message}`);
    createdUserIds.push(data.user.id);
    return { id: data.user.id, email: data.user.email as string };
  };

  const loginClient = async (email: string) => {
    const client = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data, error } = await client.auth.signInWithPassword({ email, password: qaPass });
    if (error || !data.session) throw new Error(`Error login ${email}: ${error?.message}`);
    return client;
  };

  try {
    console.log('1. Creando usuarios (Host, Titular, A, B, C, D)...');
    const host = await createQAUser('host', 'Host Concurrencia');
    const holder = await createQAUser('holder', 'Titular Tres Lugares');
    const uA = await createQAUser('a', 'Solicitante A');
    const uB = await createQAUser('b', 'Solicitante B');
    const uC = await createQAUser('c', 'Solicitante C');
    const uD = await createQAUser('d', 'Solicitante D');

    const hostClient = await loginClient(host.email);
    const cA = await loginClient(uA.email);
    const cB = await loginClient(uB.email);
    const cC = await loginClient(uC.email);
    const cD = await loginClient(uD.email);

    console.log('2. Creando encuentro abierto (capacidad 5, multi-seat hasta 3)...');
    const futureDate = new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0];
    const { data: enc, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: host.id,
        titulo: `QA Concurrencia ${ts}`,
        open_public_title: 'QA Concurrencia de cupos',
        descripcion: 'Fixture QA de concurrencia',
        open_description: 'Fixture QA de concurrencia de cupos.',
        modalidad: 'presencial',
        lugar_texto: 'Lugar privado QA',
        locality_id: 'centro',
        open_public_zone: 'Centro',
        tipo_invitacion: 'link_general',
        max_participants: 5,
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
    if (encErr || !enc) throw new Error(`Error creando encuentro: ${encErr?.message}`);
    const encounterId = enc.id as string;
    createdEncounterIds.push(encounterId);

    console.log('3. Titular confirmado con seat_count = 3...');
    const { data: holderPart, error: holderErr } = await admin
      .from('participantes')
      .insert({
        encuentro_id: encounterId,
        nombre_invitado: 'Titular Tres Lugares',
        tipo_invitacion: 'individual',
        estado: 'confirmado',
        user_id: holder.id,
        seat_count: 3,
      })
      .select('id')
      .single();
    if (holderErr || !holderPart) throw new Error(`Error creando titular: ${holderErr?.message}`);

    const hostSnapshot = async () => {
      const { data, error } = await hostClient.rpc('get_encuentros_host_seguro', { p_host_ids: [host.id] });
      assert.ifError(error);
      const row = (data as any[]).find((e: any) => e.id === encounterId);
      assert.ok(row, 'Host debe ver su encuentro');
      return row;
    };

    const s0 = await hostSnapshot();
    assert.equal(Number(s0.confirmed_seats), 3);
    assert.equal(Number(s0.available_slots), 2);
    console.log('   PASS: confirmed_seats = 3, available_slots = 2');

    console.log('4. A(2), B(2), C(1) solicitan EN PARALELO...');
    const request = (client: any, nombre: string, seats: number) =>
      client.rpc('solicitar_sumarse_encuentro_abierto', {
        p_encuentro_id: encounterId,
        p_nombre: nombre,
        p_mensaje: 'QA concurrencia',
        p_seat_count: seats,
      });
    const [rA, rB, rC] = await Promise.all([
      request(cA, 'Solicitante A', 2),
      request(cB, 'Solicitante B', 2),
      request(cC, 'Solicitante C', 1),
    ]);
    for (const [label, r] of [['A', rA], ['B', rB], ['C', rC]] as const) {
      assert.ifError(r.error);
      assert.equal(r.data?.ok, true, `Solicitud ${label} debe crearse: ${JSON.stringify(r.data)}`);
    }
    const reqA = rA.data.request_id as string;
    const reqB = rB.data.request_id as string;
    const reqC = rC.data.request_id as string;

    const s1 = await hostSnapshot();
    assert.equal(Number(s1.pending_requests_count), 3, 'Las 3 solicitudes quedan pending');
    assert.equal(Number(s1.available_slots), 2, 'Pending NO reserva lugares');
    assert.equal(Number(s1.confirmed_seats), 3);
    console.log('   PASS: 3 pending, available_slots sigue en 2');

    console.log('5. Host aprueba A y B EN PARALELO (ambas de 2, queda cupo 2)...');
    const [apA, apB] = await Promise.all([
      hostClient.rpc('aprobar_solicitud_encuentro_abierto', { p_request_id: reqA }),
      hostClient.rpc('aprobar_solicitud_encuentro_abierto', { p_request_id: reqB }),
    ]);
    assert.ifError(apA.error);
    assert.ifError(apB.error);
    const results = [
      { label: 'A', reqId: reqA, res: apA.data },
      { label: 'B', reqId: reqB, res: apB.data },
    ];
    const winners = results.filter((r) => r.res?.ok === true);
    const losers = results.filter((r) => r.res?.ok !== true);
    assert.equal(winners.length, 1, `Exactamente UNA aprobación: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].res?.error, 'quota_exceeded', `La otra debe ser quota_exceeded: ${JSON.stringify(losers[0].res)}`);
    console.log(`   PASS: ganó ${winners[0].label}, ${losers[0].label} => quota_exceeded`);

    const s2 = await hostSnapshot();
    assert.equal(Number(s2.confirmed_seats), 5, 'confirmed_seats = 5');
    assert.equal(Number(s2.available_slots), 0, 'available_slots = 0');
    const { data: seatRows } = await admin
      .from('participantes')
      .select('seat_count')
      .eq('encuentro_id', encounterId)
      .in('estado', ['confirmado', 'asistio']);
    const dbSeats = (seatRows || []).reduce((acc: number, r: any) => acc + (r.seat_count || 1), 0);
    assert.equal(dbSeats, 5, 'Cero sobrecupo en DB');
    console.log('   PASS: confirmed_seats = 5, available_slots = 0, cero sobrecupo');

    console.log('6. Encuentro completo: bloquear nuevas, conservar pendientes...');
    const rFull = await request(cD, 'Solicitante D', 1);
    assert.ifError(rFull.error);
    assert.equal(rFull.data?.ok, false);
    assert.equal(rFull.data?.error, 'encounter_full', `Nueva solicitud debe fallar: ${JSON.stringify(rFull.data)}`);

    const { data: stillPending } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('id, estado')
      .in('id', [reqC, losers[0].reqId]);
    assert.equal((stillPending || []).filter((s: any) => s.estado === 'pending').length, 2, 'Pendientes conservadas');

    const apCFull = await hostClient.rpc('aprobar_solicitud_encuentro_abierto', { p_request_id: reqC });
    assert.ifError(apCFull.error);
    assert.equal(apCFull.data?.error, 'quota_exceeded', 'No se aprueba pendiente si no entra');
    console.log('   PASS: nueva => encounter_full; pendientes intactas; aprobar sin cupo => quota_exceeded');

    console.log('7. Se libera cupo: Host elimina al ganador (2 lugares)...');
    const winnerPartId = winners[0].res.participante_id as string;
    const del = await hostClient.rpc('eliminar_participante_seguro', {
      p_participante_id: winnerPartId,
      p_host_id: host.id,
    });
    assert.ifError(del.error);
    assert.equal(del.data?.ok, true);

    const s3 = await hostSnapshot();
    assert.equal(Number(s3.available_slots), 2, 'available_slots vuelve a 2');
    assert.equal(Number(s3.confirmed_seats), 3);
    assert.equal(Number(s3.pending_requests_count), 2, 'Pendientes antiguas siguen presentes');
    console.log('   PASS: available_slots = 2, 2 pendientes presentes');

    const rReopen = await request(cD, 'Solicitante D', 1);
    assert.ifError(rReopen.error);
    assert.equal(rReopen.data?.ok, true, `Debe aceptar nuevas otra vez: ${JSON.stringify(rReopen.data)}`);

    const apLoser = await hostClient.rpc('aprobar_solicitud_encuentro_abierto', { p_request_id: losers[0].reqId });
    assert.ifError(apLoser.error);
    assert.equal(apLoser.data?.ok, true, `Pendiente de 2 ahora entra: ${JSON.stringify(apLoser.data)}`);

    const s4 = await hostSnapshot();
    assert.equal(Number(s4.confirmed_seats), 5);
    assert.equal(Number(s4.available_slots), 0);
    console.log('   PASS: nueva solicitud aceptada, pendiente de 2 aprobada, de nuevo completo');

    console.log('\n========================================================');
    console.log('CONCURRENCIA DE CUPOS: TODAS LAS COMPUERTAS PASS');
    console.log('========================================================\n');
  } finally {
    console.log('Limpiando fixtures en Staging...');
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
    console.log('Fixtures limpiados.');
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('STAGING CONCURRENCY QA FAILED:', err);
    process.exit(1);
  });
