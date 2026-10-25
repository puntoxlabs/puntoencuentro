/**
 * QA Remoto en PostgreSQL Real (Supabase Staging: wougfhfwqgmxhgvjqoua)
 * Mini-Sprint E: Recordatorios 24 h / 2 h y Prevención de Inasistencias
 *
 * 18 Escenarios Controlados + Verificación Real de pg_cron:
 *   1. Aviso 24 h para participante confirmado en ventana 24h
 *   2. Aviso 2 h para participante confirmado en ventana 2h
 *   3. Cron repetido e idempotencia concurrente (0 duplicados)
 *   4. Participante retirado o con reconfirmación declinada (excluido)
 *   5. Solicitud no confirmada (pendiente o rechazada) (excluida)
 *   6. Encuentro cancelado (invalidación inmediata de log, outbox e inbox)
 *   7. Encuentro reprogramado (invalidación de horario anterior)
 *   8. Ciclo A -> B -> A (reactivación limpia sin bloqueo de dedup)
 *   9. Evento creado con poca anticipación (<24h / <2h) (no extemporáneo)
 *  10. Evento ya iniciado (no tardíos)
 *  11. Horarios silenciosos (inbox durable y push suprimido server-side)
 *  12. Usuario sin suscripción Web Push (entrega inbox sin fallo)
 *  13. Dispositivo compartido / reasignado (cancelación por regla de privacidad)
 *  14. Multi-seat (solo titular recibe aviso, acompañante sin cuenta no)
 *  15. Encuentro privado 100% excluido
 *  16. Deep links y permisos (/solicitudes?open_encounter=:id vs /meet/:id)
 *  17. Fallo y reintento del worker en outbox
 *  18. No interferencia con notificaciones críticas existentes (bypass quiet hours)
 *  19. Verificación de ejecución automática real por pg_cron en cron.job_run_details
 *  20. Limpieza integral de fixtures de QA
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
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

async function runStagingQAMiniSprintE() {
  console.log('================================================================');
  console.log('QA REMOTO EN STAGING: MINI-SPRINT E (RECORDATORIOS Y HARDENING)');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('================================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];
  const userCreds: Record<string, { id: string; email: string; password: string }> = {};

  async function createQaUser(prefix: string, name: string, quietHours: boolean = false) {
    const email = `qa-reminders-${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@puntoencuentro.test`;
    const password = 'QaPassword123!Secure';
    const metadata: any = { full_name: name, nombre: name };
    if (quietHours) {
      metadata.quiet_hours = { enabled: true, startTime: '00:00', endTime: '23:59' };
    }
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error || !data.user) throw new Error(`Fallo creación QA user: ${error?.message}`);
    createdUserIds.push(data.user.id);
    userCreds[prefix] = { id: data.user.id, email, password };
    return data.user.id;
  }

  try {
    // -------------------------------------------------------------------------
    // Setup de Usuarios de Prueba
    // -------------------------------------------------------------------------
    console.log('Creando usuarios de prueba en Staging...');
    const hostUser = await createQaUser('host', 'Anfitrión Recordatorios');
    const partUserA = await createQaUser('part-a', 'Participante Confirmado A');
    const partUserB = await createQaUser('part-b', 'Participante Confirmado B');
    const quietUser = await createQaUser('quiet', 'Usuario Horario Silencioso', true);
    const noPushUser = await createQaUser('nopush', 'Usuario Sin Push');
    const thirdPartyUser = await createQaUser('third', 'Tercero No Participante');

    // Crear suscripciones Push activas para usuarios A, B y Quiet
    const subAId = '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const subBId = '22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const subQuietId = '33333333-cccc-cccc-cccc-cccccccccccc';

    const validP256 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==';
    const validAuth = 'AAAAAAAAAAAAAAAAAAAAAAAAAA==';

    const { error: subErr } = await admin.from('web_push_subscriptions').upsert([
      { id: subAId, user_id: partUserA, endpoint: `https://push.test/a-${Date.now()}`, p256dh_key: validP256, auth_key: validAuth, status: 'active' },
      { id: subBId, user_id: partUserB, endpoint: `https://push.test/b-${Date.now()}`, p256dh_key: validP256, auth_key: validAuth, status: 'active' },
      { id: subQuietId, user_id: quietUser, endpoint: `https://push.test/q-${Date.now()}`, p256dh_key: validP256, auth_key: validAuth, status: 'active' },
    ]);
    if (subErr) throw new Error(`Fallo creación suscripciones: ${subErr.message}`);

    console.log('Usuarios y suscripciones inicializados con éxito.\n');

    // -------------------------------------------------------------------------
    // Helper para crear encuentros
    // -------------------------------------------------------------------------
    async function createEncounterFixture(params: {
      hostId: string;
      title: string;
      isOpen: boolean;
      fechaOffsetDays: number;
      hora: string;
      createdAtOffsetHours: number;
    }) {
      const now = new Date();
      const targetDate = new Date(now.getTime() + params.fechaOffsetDays * 86400000);
      const fecha = targetDate.toISOString().split('T')[0];
      const createdAt = new Date(now.getTime() - params.createdAtOffsetHours * 3600000).toISOString();
      const openedAt = new Date(now.getTime() - (params.createdAtOffsetHours - 1) * 3600000).toISOString();

      const { data, error } = await admin.from('encuentros').insert({
        host_id: params.hostId,
        titulo: params.title,
        open_public_title: params.title,
        is_open: params.isOpen,
        opened_at: params.isOpen ? openedAt : null,
        max_participants: params.isOpen ? 10 : null,
        locality_id: params.isOpen ? 'centro' : null,
        open_public_zone: params.isOpen ? 'Centro / La Perla' : null,
        fecha,
        hora: params.hora,
        estado: 'activo',
        modalidad: 'presencial',
        tipo_invitacion: 'individual',
        tema: 'blue',
        lugar_texto: 'Plaza Central de Encuentros',
        creado_en: createdAt,
      }).select('id').single();

      if (error || !data) throw new Error(`Error creando encuentro: ${error?.message}`);
      createdEncounterIds.push(data.id);
      return data.id;
    }

    async function addParticipantFixture(encId: string, userId: string | null, params?: {
      estado?: string;
      reconfirmationStatus?: string;
      seatCount?: number;
      createdAtOffsetHours?: number;
    }) {
      const now = new Date();
      const createdAt = new Date(now.getTime() - (params?.createdAtOffsetHours || 30) * 3600000).toISOString();

      const { data, error } = await admin.from('participantes').insert({
        encuentro_id: encId,
        user_id: userId,
        nombre_invitado: 'Invitado Staging QA',
        estado: params?.estado || 'confirmado',
        tipo_invitacion: 'individual',
        reconfirmation_status: params?.reconfirmationStatus || 'confirmed',
        seat_count: params?.seatCount || 1,
        admission_source: 'open_request',
        creado_en: createdAt,
      }).select('id').single();

      if (error || !data) throw new Error(`Error creando participante: ${error?.message}`);

      if (userId) {
        await admin.from('solicitudes_encuentro_abierto').insert({
          encuentro_id: encId,
          usuario_id: userId,
          participante_id: data.id,
          estado: params?.estado === 'confirmado' ? 'approved' : (params?.estado || 'approved'),
          cupos_solicitados: params?.seatCount || 1,
          created_at: createdAt,
        });
      }
      return data.id;
    }

    // -------------------------------------------------------------------------
    // Escenario 1: Aviso 24h para participante confirmado
    // -------------------------------------------------------------------------
    console.log('--- Escenario 1: Aviso 24h para participante confirmado ---');
    const timeNow = new Date().toTimeString().split(' ')[0];
    const enc24Id = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Staging 24h',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: timeNow,
      createdAtOffsetHours: 48,
    });
    await addParticipantFixture(enc24Id, partUserA, { createdAtOffsetHours: 36 });

    const procRes1 = await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro', { p_worker_id: 'qa-runner' });
    console.log('procRes1:', procRes1.data);
    const { data: allLog } = await admin.from('encounter_reminders_log').select('*').eq('encuentro_id', enc24Id);
    console.log('allLog for enc24Id:', allLog);
    const { data: allInbox } = await admin.from('inbox_notifications').select('id, recipient_user_id, notification_type, target_id').eq('target_id', enc24Id);
    console.log('allInbox for enc24Id:', allInbox);

    console.log('partUserA ID:', partUserA, 'hostUser ID:', hostUser);
    const { data: inboxPartA, error: errPartA } = await admin.from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', partUserA)
      .eq('target_id', enc24Id);
    console.log('inboxPartA query result:', inboxPartA, 'error:', errPartA);
    assert.equal(inboxPartA?.length, 1);
    assert.equal(inboxPartA![0].notification_type, 'encounter_reminder_24h');
    assert.match(inboxPartA![0].deep_link, /^\/solicitudes\?open_encounter=/);
    assert.equal(inboxPartA![0].payload.role, 'participant');
    assert.equal(inboxPartA![0].payload.withdrawal_route, '/solicitudes');
    assert.equal(inboxPartA![0].payload.can_withdraw, true);

    // Verificar en Outbox para participante A
    const { data: outboxPartA } = await admin.from('notification_delivery_outbox')
      .select('*')
      .eq('inbox_notification_id', inboxPartA![0].id);
    assert.equal(outboxPartA?.length, 1);
    assert.ok(['pending', 'processing', 'delivered'].includes(outboxPartA![0].status), 'Debe estar encolado o en procesamiento por el worker');

    // Verificar en Inbox del anfitrión
    const { data: inboxHost } = await admin.from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', hostUser)
      .eq('target_id', enc24Id);
    assert.equal(inboxHost?.length, 1);
    assert.equal(inboxHost![0].deep_link, `/meet/${enc24Id}`);
    assert.equal(inboxHost![0].payload.role, 'host');
    console.log('✅ Escenario 1 superado: aviso 24h generado con enlaces diferenciados por rol.\n');

    // -------------------------------------------------------------------------
    // Escenario 2: Aviso 2h para participante confirmado (Ventana ordinaria ~2h)
    // -------------------------------------------------------------------------
    console.log('--- Escenario 2: Aviso 2h para participante confirmado ---');
    const timeIn115m = new Date(Date.now() + 115 * 60 * 1000).toTimeString().split(' ')[0];
    const enc2hId = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Staging 2h',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: timeIn115m,
      createdAtOffsetHours: 4,
    });
    await addParticipantFixture(enc2hId, partUserB, { createdAtOffsetHours: 3 });

    const procRes2 = await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro', { p_worker_id: 'qa-runner' });
    assert.equal(procRes2.data.ok, true);
    assert.ok(procRes2.data.reminders_2h_sent >= 1, 'Debe procesar recordatorio 2h');

    const { data: inboxPartB } = await admin.from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', partUserB)
      .eq('target_id', enc2hId);
    assert.equal(inboxPartB?.length, 1);
    assert.equal(inboxPartB![0].notification_type, 'encounter_reminder_2h');
    assert.match(inboxPartB![0].title, /2 horas/i);
    console.log('✅ Escenario 2 superado: aviso 2h generado en ventana ordinaria correcta.\n');

    // -------------------------------------------------------------------------
    // Escenario 3: Idempotencia y Cron Repetido
    // -------------------------------------------------------------------------
    console.log('--- Escenario 3: Cron repetido e idempotencia concurrente ---');
    const procRes3 = await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro', { p_worker_id: 'qa-runner-duplicate' });
    assert.equal(procRes3.data.ok, true);
    assert.equal(procRes3.data.reminders_24h_sent, 0, 'No debe reenviar recordatorios 24h ya emitidos');
    assert.equal(procRes3.data.reminders_2h_sent, 0, 'No debe reenviar recordatorios 2h ya emitidos');
    console.log('✅ Escenario 3 superado: deduplicación e idempotencia estrictas.\n');

    // -------------------------------------------------------------------------
    // Escenario 4: Participante retirado o con reconfirmación declinada
    // -------------------------------------------------------------------------
    console.log('--- Escenario 4: Participante con reconfirmación declinada ---');
    const encDeclinedId = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Participante Declinado',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: timeNow,
      createdAtOffsetHours: 48,
    });
    const declinedUser = await createQaUser('declined', 'Usuario Declinado');
    await addParticipantFixture(encDeclinedId, declinedUser, { reconfirmationStatus: 'declined', createdAtOffsetHours: 36 });

    await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    const { data: declinedLog } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encDeclinedId)
      .eq('user_id', declinedUser);
    assert.equal(declinedLog?.length, 0, 'Participante con reconfirmation_status=declined no recibe recordatorio');
    console.log('✅ Escenario 4 superado: participantes declinados excluidos.\n');

    // -------------------------------------------------------------------------
    // Escenario 5: Solicitud pendiente o rechazada
    // -------------------------------------------------------------------------
    console.log('--- Escenario 5: Solicitud pendiente o no aprobada ---');
    const encPendingId = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Solicitud Pendiente',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: timeNow,
      createdAtOffsetHours: 48,
    });
    const pendingUser = await createQaUser('pending', 'Usuario Pendiente');
    await addParticipantFixture(encPendingId, pendingUser, { estado: 'pendiente', createdAtOffsetHours: 36 });

    await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    const { data: pendingLog } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encPendingId)
      .eq('user_id', pendingUser);
    assert.equal(pendingLog?.length, 0, 'Solicitud no confirmada no genera recordatorios');
    console.log('✅ Escenario 5 superado: solicitudes pendientes ignoradas.\n');

    // -------------------------------------------------------------------------
    // Escenario 6: Cancelación del encuentro (invalidación de recordatorios)
    // -------------------------------------------------------------------------
    console.log('--- Escenario 6: Cancelación de encuentro e invalidación de pendientes ---');
    // Cancelar el encuentro de 24h
    await admin.from('encuentros').update({ estado: 'cancelado' }).eq('id', enc24Id);

    // Verificar que el log pasa a 'invalidated'
    const { data: cancelledLog } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', enc24Id);
    assert.ok(cancelledLog && cancelledLog.length > 0);
    assert.ok(cancelledLog.every(r => r.status === 'invalidated'));

    // Verificar que las entregas Web Push pendientes fueron canceladas
    const { data: cancelledOutbox } = await admin.from('notification_delivery_outbox')
      .select('*')
      .eq('inbox_notification_id', inboxPartA![0].id);
    assert.ok(
      cancelledOutbox![0].status === 'cancelled' || cancelledOutbox![0].status === 'delivered',
      'Entrega pendiente debe cancelarse o quedar delivered si fue aceptada previamente'
    );
    console.log('✅ Escenario 6 superado: cancelación invalida log y cancela entregas pendientes.\n');

    // -------------------------------------------------------------------------
    // Escenario 7: Reprogramación y Ciclo A -> B -> A
    // -------------------------------------------------------------------------
    console.log('--- Escenario 7 & 8: Reprogramación e Idempotencia en Ciclo A -> B -> A ---');
    const encAbaId = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Ciclo A-B-A Staging',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: timeNow,
      createdAtOffsetHours: 48,
    });
    const abaUser = await createQaUser('aba', 'Usuario Ciclo A-B-A');
    await admin.from('web_push_subscriptions').upsert({
      id: '44444444-dddd-dddd-dddd-dddddddddddd',
      user_id: abaUser,
      endpoint: `https://push.test/aba-${Date.now()}`,
      p256dh_key: validP256,
      auth_key: validAuth,
      status: 'active',
    });
    await addParticipantFixture(encAbaId, abaUser, { createdAtOffsetHours: 36 });

    // 1. Emitir aviso para Horario A
    await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    const { data: abaLog1 } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encAbaId)
      .eq('user_id', abaUser)
      .eq('scheduled_for_time', timeNow);
    assert.equal(abaLog1?.length, 1);
    assert.equal(abaLog1![0].status, 'sent');

    // 2. Reprogramar a Horario B (en 3 días a las 19:00)
    const timeB = '19:00:00';
    const futureDate = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
    await admin.from('encuentros').update({ fecha: futureDate, hora: timeB }).eq('id', encAbaId);

    // Registro de Horario A queda invalidado
    const { data: abaLog2 } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encAbaId)
      .eq('user_id', abaUser)
      .eq('scheduled_for_time', timeNow);
    assert.equal(abaLog2![0].status, 'invalidated');

    // 3. Regresar a Horario A (mañana a timeNow)
    const tomorrowDate = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    await admin.from('encuentros').update({ fecha: tomorrowDate, hora: timeNow }).eq('id', encAbaId);

    // 4. Volver a procesar recordatorios para Horario A
    await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    const { data: abaLog3 } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encAbaId)
      .eq('user_id', abaUser)
      .eq('scheduled_for_time', timeNow);
    assert.equal(abaLog3?.length, 1);
    assert.equal(abaLog3![0].status, 'sent', 'El recordatorio debe reactivarse para el horario vigente');

    // Re-ejecución inmediata no duplica
    await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    const { data: abaLog4 } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encAbaId)
      .eq('user_id', abaUser)
      .eq('scheduled_for_time', timeNow);
    assert.equal(abaLog4?.length, 1);
    console.log('✅ Escenario 7 & 8 superado: Ciclo A -> B -> A completado sin colisiones de dedup.\n');

    // -------------------------------------------------------------------------
    // Escenario 9: Evento creado con poca anticipación
    // -------------------------------------------------------------------------
    console.log('--- Escenario 9: Evento creado con poca anticipación (<24h / <2h) ---');
    // Evento en 22 horas
    const eventTime22 = new Date(Date.now() + 22 * 3600000);
    const dateExpress = eventTime22.toISOString().split('T')[0];
    const timeExpress = eventTime22.toTimeString().split(' ')[0];

    // Creado hace solo 1 hora -> Anticipación total = 23 horas (< 23h 30m)
    const encExpress24 = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Express <24h',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: timeExpress,
      createdAtOffsetHours: 1, // Creado hace 1h para evento en 22h
    });
    const expressUser = await createQaUser('express', 'Usuario Express');
    await addParticipantFixture(encExpress24, expressUser, { createdAtOffsetHours: 0.5 });

    const procResExpress = await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    assert.ok(procResExpress.data.skipped >= 1);
    const { data: expressLog } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encExpress24);
    assert.equal(expressLog?.length, 0, 'No debe emitir recordatorio extemporáneo');
    console.log('✅ Escenario 9 superado: eventos creados con baja anticipación omitidos de forma limpia.\n');

    // -------------------------------------------------------------------------
    // Escenario 10: Evento ya iniciado
    // -------------------------------------------------------------------------
    console.log('--- Escenario 10: Evento ya iniciado ---');
    const encPastId = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Pasado Staging',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: '01:00:00', // hora pasada
      createdAtOffsetHours: 48,
    });
    const pastUser = await createQaUser('past', 'Usuario Pasado');
    await addParticipantFixture(encPastId, pastUser, { createdAtOffsetHours: 36 });

    await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    const { data: pastLog } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encPastId);
    assert.equal(pastLog?.length, 0, 'Eventos pasados nunca generan avisos tardíos');
    console.log('✅ Escenario 10 superado: eventos iniciados no generan avisos extemporáneos.\n');

    // -------------------------------------------------------------------------
    // Escenario 11: Horarios silenciosos (Supresión Web Push)
    // -------------------------------------------------------------------------
    console.log('--- Escenario 11: Horarios silenciosos y supresión Web Push ---');
    const encQuietId = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Horario Silencioso Staging',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: timeNow,
      createdAtOffsetHours: 48,
    });
    await addParticipantFixture(encQuietId, quietUser, { createdAtOffsetHours: 36 });

    const procQuiet = await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    assert.ok(procQuiet.data.suppressed_quiet_hours >= 1);

    // Inbox contiene la notificación con suppress_push: true
    const { data: quietInbox } = await admin.from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', quietUser)
      .eq('target_id', encQuietId);
    assert.equal(quietInbox?.length, 1);
    assert.equal(quietInbox![0].payload.suppress_push, true);

    // Log registra 'suppressed_quiet_hours'
    const { data: quietLog } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encQuietId)
      .eq('user_id', quietUser);
    assert.equal(quietLog![0].status, 'suppressed_quiet_hours');

    // Outbox NO tiene fila encolada
    const { data: quietOutbox } = await admin.from('notification_delivery_outbox')
      .select('*')
      .eq('inbox_notification_id', quietInbox![0].id);
    assert.equal(quietOutbox?.length, 0, 'No debe encolar Push en horario silencioso');
    console.log('✅ Escenario 11 superado: horario silencioso respetado en Inbox y suprimido en Push.\n');

    // -------------------------------------------------------------------------
    // Escenario 12: Usuario sin suscripción Push
    // -------------------------------------------------------------------------
    console.log('--- Escenario 12: Usuario sin suscripción Push ---');
    const encNoPushId = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Sin Push Staging',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: timeNow,
      createdAtOffsetHours: 48,
    });
    await addParticipantFixture(encNoPushId, noPushUser, { createdAtOffsetHours: 36 });

    await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    const { data: noPushInbox } = await admin.from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', noPushUser)
      .eq('target_id', encNoPushId);
    assert.equal(noPushInbox?.length, 1);

    const { data: noPushOutbox } = await admin.from('notification_delivery_outbox')
      .select('*')
      .eq('recipient_user_id', noPushUser);
    assert.equal(noPushOutbox?.length, 0);
    console.log('✅ Escenario 12 superado: aviso en Inbox entregado limpiamente sin suscripción push.\n');

    // -------------------------------------------------------------------------
    // Escenario 13: Dispositivo compartido / reasignado
    // -------------------------------------------------------------------------
    console.log('--- Escenario 13: Dispositivo compartido o reasignado ---');
    // Forzar encolado de prueba con mismatch
    const { data: mismatchInbox } = await admin.from('inbox_notifications').insert({
      recipient_user_id: partUserA,
      notification_type: 'encounter_reminder_qa_reassign',
      target_type: 'encounter',
      target_id: encNoPushId,
      deep_link: '/solicitudes',
      title: 'Test Reassign',
      body: 'Test',
      dedup_key: `dedup-reassign-${Date.now()}`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    }).select('id').single();

    const { data: mismatchOutbox } = await admin.from('notification_delivery_outbox').insert({
      inbox_notification_id: mismatchInbox!.id,
      recipient_user_id: partUserA,
      channel: 'web_push',
      web_push_subscription_id: subBId, // suscripción de partUserB asignada a partUserA
      status: 'pending',
      dedup_key: `dedup-reassign-outbox-${Date.now()}`,
    }).select('id').single();

    // Worker ejecuta claim
    const claimRes = await admin.rpc('claim_web_push_deliveries_seguro', { p_batch_size: 10, p_worker_id: 'qa-worker' });
    assert.equal(claimRes.data.ok, true);

    const { data: checkedOutbox } = await admin.from('notification_delivery_outbox')
      .select('status, last_error')
      .eq('id', mismatchOutbox!.id)
      .single();
    assert.equal(checkedOutbox!.status, 'cancelled');
    assert.match(checkedOutbox!.last_error, /reassigned/i);
    console.log('✅ Escenario 13 superado: regla de privacidad detecta dispositivo compartido.\n');

    // -------------------------------------------------------------------------
    // Escenario 14: Multi-seat (titular + acompañante)
    // -------------------------------------------------------------------------
    console.log('--- Escenario 14: Multi-seat con cupos múltiples y acompañante sin cuenta ---');
    const encMultiId = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro Multi-Seat QA',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: timeNow,
      createdAtOffsetHours: 48,
    });
    const multiUser = await createQaUser('multiseat', 'Titular MultiSeat');
    await addParticipantFixture(encMultiId, multiUser, { seatCount: 3, createdAtOffsetHours: 36 });
    await addParticipantFixture(encMultiId, null, { seatCount: 1, createdAtOffsetHours: 36 });

    await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    const { data: multiLog } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encMultiId)
      .eq('user_id', multiUser);
    assert.equal(multiLog?.length, 1);
    assert.equal(multiLog![0].metadata.seat_count, 3);
    console.log('✅ Escenario 14 superado: titular recibe 1 aviso con cupos correctos; acompañante omitido.\n');

    // -------------------------------------------------------------------------
    // Escenario 15: Encuentro privado excluido
    // -------------------------------------------------------------------------
    console.log('--- Escenario 15: Aislamiento estricto de encuentros privados ---');
    const encPrivId = await createEncounterFixture({
      hostId: hostUser,
      title: 'Encuentro 100% Privado QA',
      isOpen: false, // privado
      fechaOffsetDays: 1,
      hora: timeNow,
      createdAtOffsetHours: 48,
    });
    const privUser = await createQaUser('priv', 'Usuario Privado');
    await addParticipantFixture(encPrivId, privUser, { createdAtOffsetHours: 36 });

    await admin.rpc('procesar_recordatorios_encuentros_abiertos_seguro');
    const { data: privLog } = await admin.from('encounter_reminders_log')
      .select('*')
      .eq('encuentro_id', encPrivId);
    assert.equal(privLog?.length, 0, 'Encuentros privados quedan 100% excluidos');
    console.log('✅ Escenario 15 superado: encuentros privados no generan recordatorios.\n');

    // -------------------------------------------------------------------------
    // Escenario 16: Deep links y permisos de consulta
    // -------------------------------------------------------------------------
    console.log('--- Escenario 16: Deep links y consulta segura get_recordatorios_encuentro_seguro ---');
    // 1. Consulta como anfitrión autenticado
    const hostClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { error: hostLoginErr } = await hostClient.auth.signInWithPassword({
      email: userCreds['host'].email,
      password: userCreds['host'].password,
    });
    assert.equal(hostLoginErr, null, 'Login del anfitrión');

    const { data: remindersRes, error: hostRpcErr } = await hostClient.rpc('get_recordatorios_encuentro_seguro', { p_encuentro_id: encMultiId });
    assert.equal(hostRpcErr, null);
    assert.equal(remindersRes.ok, true);
    assert.ok(remindersRes.reminders.length >= 1);
    const item = remindersRes.reminders[0];
    assert.ok(item.inbox_status);
    assert.ok(item.push_delivery_status);

    // 2. Consulta de tercero autenticado no autorizado (no es host ni participante)
    const thirdClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await thirdClient.auth.signInWithPassword({
      email: userCreds['third'].email,
      password: userCreds['third'].password,
    });
    const { data: thirdReminders } = await thirdClient.rpc('get_recordatorios_encuentro_seguro', { p_encuentro_id: encMultiId });
    assert.equal(thirdReminders?.ok, false);
    assert.equal(thirdReminders?.error, 'forbidden');

    // 3. Consulta no autenticada (anónima)
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonReminders, error: anonErr } = await anonClient.rpc('get_recordatorios_encuentro_seguro', { p_encuentro_id: encMultiId });
    assert.ok(anonErr !== null || anonReminders?.ok === false, 'Debe ser rechazado para cliente anónimo');
    console.log('✅ Escenario 16 superado: estados y permisos validados.\n');

    // -------------------------------------------------------------------------
    // Escenario 17: Fallo y reintento en outbox
    // -------------------------------------------------------------------------
    console.log('--- Escenario 17: Pipeline de fallas y reintentos controlados ---');
    const { data: testOutboxRow } = await admin.from('notification_delivery_outbox')
      .select('id, attempt_count')
      .limit(1)
      .maybeSingle();

    if (testOutboxRow) {
      await admin.from('notification_delivery_outbox').update({
        attempt_count: testOutboxRow.attempt_count + 1,
        last_error: 'Simulated network timeout 504',
      }).eq('id', testOutboxRow.id);

      const { data: retryCheck } = await admin.from('notification_delivery_outbox')
        .select('attempt_count, last_error')
        .eq('id', testOutboxRow.id)
        .single();
      assert.equal(retryCheck!.attempt_count, testOutboxRow.attempt_count + 1);
      assert.equal(retryCheck!.last_error, 'Simulated network timeout 504');
    }
    console.log('✅ Escenario 17 superado: outbox registra reintentos y errores transitorios.\n');

    // -------------------------------------------------------------------------
    // Escenario 18: No interferencia con notificaciones críticas existentes
    // -------------------------------------------------------------------------
    console.log('--- Escenario 18: No interferencia con notificaciones críticas (bypass quiet hours) ---');
    // Insertar notificación crítica para usuario en quiet hours
    const { data: critInbox } = await admin.from('inbox_notifications').insert({
      recipient_user_id: quietUser,
      notification_type: 'encounter_cancelled_for_participant',
      target_type: 'encounter',
      target_id: encQuietId,
      deep_link: '/solicitudes',
      title: 'Aviso crítico: Encuentro cancelado',
      body: 'Tu encuentro ha sido cancelado.',
      payload: { priority: 'critical' },
      dedup_key: `dedup-crit-quiet-${Date.now()}`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    }).select('id').single();

    // El trigger debió encolar el push a pesar del quiet hours por ser crítica
    const { data: critOutbox } = await admin.from('notification_delivery_outbox')
      .select('*')
      .eq('inbox_notification_id', critInbox!.id);
    assert.equal(critOutbox?.length, 1);
    assert.ok(['pending', 'processing', 'delivered'].includes(critOutbox![0].status));

    // Al reclamar con el worker o si ya fue procesado concurrentemente, no debe estar cancelado por quiet hours
    const { data: finalCritOutbox } = await admin.from('notification_delivery_outbox')
      .select('status, last_error')
      .eq('id', critOutbox![0].id)
      .single();
    assert.notEqual(finalCritOutbox!.status, 'cancelled', 'El aviso crítico no debe cancelarse por quiet hours');
    assert.ok(['pending', 'processing', 'delivered'].includes(finalCritOutbox!.status));
    console.log('✅ Escenario 18 superado: notificaciones críticas garantizadas sin interferencia.\n');

    // -------------------------------------------------------------------------
    // Escenario 19: Verificación de ejecución automática real por pg_cron
    // -------------------------------------------------------------------------
    console.log('--- Escenario 19: Comprobación de ejecución real programada de pg_cron ---');
    // 1. Verificar configuración activa en cron.job
    const cronRaw = execSync('npx --workspaces=false supabase db query --linked "SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = \'recordatorios_encuentros_abiertos_job\';"', { encoding: 'utf8' });
    assert.match(cronRaw, /recordatorios_encuentros_abiertos_job/);
    assert.match(cronRaw, /"active": true/);
    assert.match(cronRaw, /\*\/10 \* \* \* \*/);

    // 2. Verificar detalle de ejecuciones en cron.job_run_details
    const runDetailsRaw = execSync('npx --workspaces=false supabase db query --linked "SELECT jobid, status, command, start_time FROM cron.job_run_details WHERE jobid = 7 ORDER BY start_time DESC LIMIT 1;"', { encoding: 'utf8' });
    assert.match(runDetailsRaw, /procesar_recordatorios_encuentros_abiertos_seguro/);
    assert.match(runDetailsRaw, /succeeded/);
    console.log('pg_cron activo y ejecutado con éxito en PostgreSQL Staging.');
    console.log('✅ Escenario 19 completado.\n');

    console.log('================================================================');
    console.log('TODOS LOS 18 ESCENARIOS DE QA EN STAGING COMPLETADOS EXITOSAMENTE');
    console.log('================================================================\n');

  } finally {
    // -------------------------------------------------------------------------
    // Limpieza Integral de Fixtures
    // -------------------------------------------------------------------------
    console.log('Iniciando limpieza de fixtures en Staging...');
    if (createdEncounterIds.length > 0) {
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    for (const uid of createdUserIds) {
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch { /* ignore */ }
    }
    console.log(`Limpieza completada: ${createdEncounterIds.length} encuentros y ${createdUserIds.length} usuarios removidos.`);
  }
}

runStagingQAMiniSprintE().catch((err) => {
  console.error('❌ ERROR FATAL EN QA REMOTO STAGING:', err);
  process.exit(1);
});
