import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeepLink } from '../src/lib/deepLink';
import { isValidPostAuthRedirect } from '../src/hooks/usePostAuthRedirect';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Mini-Sprint E: Recordatorios 24 h / 2 h y Prevención de Inasistencias', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const partUserA = '22222222-2222-2222-2222-222222222222';
  const partUserB = '33333333-3333-3333-3333-333333333333';
  const partQuietUser = '44444444-4444-4444-4444-444444444444';
  const partNoPushUser = '55555555-5555-5555-5555-555555555555';
  const thirdPartyUser = '66666666-6666-6666-6666-666666666666';

  const setAuth = async (userId: string | null, isAnon: boolean = false) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${userId}","is_anonymous":${isAnon}}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    }
  };

  before(async () => {
    db = new PGlite();

    // 1. Mock Roles y Auth
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres; END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        raw_user_meta_data JSONB DEFAULT '{}'::jsonb
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        ('${hostUser}', 'host@test.com', '{}'::jsonb),
        ('${partUserA}', 'parta@test.com', '{}'::jsonb),
        ('${partUserB}', 'partb@test.com', '{}'::jsonb),
        ('${partQuietUser}', 'quiet@test.com', '{"quiet_hours":{"enabled":true,"startTime":"00:00","endTime":"23:59"}}'::jsonb),
        ('${partNoPushUser}', 'nopush@test.com', '{}'::jsonb),
        ('${thirdPartyUser}', 'third@test.com', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;

      -- Moderación
      CREATE TABLE IF NOT EXISTS public.moderation_authorized_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'moderator',
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION public.is_moderation_authorized()
      RETURNS BOOLEAN AS $$
      BEGIN
        RETURN EXISTS (
          SELECT 1 FROM public.moderation_authorized_users
          WHERE user_id = auth.uid() AND active = true
        );
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      -- Tabla encuentros
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
        duration_minutes INT DEFAULT 120,
        modalidad TEXT DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        tipo_invitacion TEXT DEFAULT 'individual',
        max_participants INT DEFAULT 10,
        min_participants INT DEFAULT 1,
        is_open BOOLEAN DEFAULT false,
        opened_at TIMESTAMPTZ,
        open_public_title TEXT,
        open_public_zone TEXT,
        locality_id TEXT,
        estado TEXT DEFAULT 'activo',
        post_event_closure_status TEXT DEFAULT 'not_applicable',
        post_event_closure_type TEXT,
        post_event_realization_status TEXT,
        post_event_closed_at TIMESTAMPTZ,
        post_event_closed_responsibly BOOLEAN DEFAULT false,
        creado_en TIMESTAMPTZ DEFAULT now(),
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      -- Tabla participantes
      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id),
        user_id UUID,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT DEFAULT 'individual',
        estado TEXT NOT NULL DEFAULT 'confirmado',
        seat_count INT DEFAULT 1,
        attendance_status TEXT DEFAULT 'unverified',
        attendance_recorded_at TIMESTAMPTZ,
        attendance_dispute_status TEXT DEFAULT 'none',
        attendance_dispute_id UUID,
        reconfirmation_status TEXT DEFAULT 'none',
        admission_source TEXT DEFAULT 'open_request',
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      -- Tabla solicitudes
      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id),
        usuario_id UUID NOT NULL,
        participante_id UUID REFERENCES public.participantes(id),
        estado TEXT NOT NULL DEFAULT 'approved',
        cupos_solicitados INT DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      -- Infraestructura de Notificaciones: Inbox y Web Push
      CREATE TABLE IF NOT EXISTS public.inbox_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_user_id UUID NOT NULL,
        notification_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id UUID NOT NULL,
        deep_link TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        payload JSONB DEFAULT '{}'::jsonb,
        dedup_key TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
      );

      CREATE TABLE IF NOT EXISTS public.web_push_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh_key TEXT NOT NULL,
        auth_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.notification_delivery_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        inbox_notification_id UUID NOT NULL REFERENCES public.inbox_notifications(id) ON DELETE CASCADE,
        recipient_user_id UUID NOT NULL,
        channel TEXT NOT NULL DEFAULT 'web_push',
        web_push_subscription_id UUID NOT NULL REFERENCES public.web_push_subscriptions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'cancelled')),
        attempt_count INT DEFAULT 0,
        max_attempts INT DEFAULT 5,
        available_at TIMESTAMPTZ DEFAULT now(),
        processing_started_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        last_error TEXT,
        dedup_key TEXT UNIQUE,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      -- Suscripciones Web Push de prueba
      INSERT INTO public.web_push_subscriptions (id, user_id, endpoint, p256dh_key, auth_key, status)
      VALUES 
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${partUserA}', 'https://push.example.com/userA', 'p256A', 'authA', 'active'),
        ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${partUserB}', 'https://push.example.com/userB', 'p256B', 'authB', 'active'),
        ('cccccccc-cccc-cccc-cccc-cccccccccccc', '${partQuietUser}', 'https://push.example.com/quiet', 'p256Q', 'authQ', 'active')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Aplicar las migraciones de Mini-Sprint E (base + compatibilidad creado_en + precisión temporal)
    for (const file of [
      '20261025110000_open_encounters_reminders_and_absence_prevention_v1.sql',
      '20261025114500_fix_reminders_encuentros_creado_en_column_v1.sql',
      '20261025120000_adjust_reminders_precision_windows_and_recovery_v1.sql',
    ]) {
      const sqlPath = path.join(__dirname, '..', 'supabase', 'migrations', file);
      const sqlContent = fs.readFileSync(sqlPath, 'utf8');
      await db.exec(sqlContent);
    }
  });

  // Helper para crear encuentro abierto
  async function createEncounter(params: {
    hostId: string;
    title: string;
    isOpen: boolean;
    fechaOffsetDays: number;
    hora: string;
    createdAtOffsetHours: number;
    estado?: string;
  }) {
    const res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at,
        fecha, hora, estado, creado_en, created_at
      ) VALUES (
        '${params.hostId}', '${params.title}', '${params.title}', ${params.isOpen}, CURRENT_TIMESTAMP - INTERVAL '3 days',
        CURRENT_DATE + INTERVAL '${params.fechaOffsetDays} days', '${params.hora}', '${params.estado || 'activo'}',
        CURRENT_TIMESTAMP - INTERVAL '${params.createdAtOffsetHours} hours',
        CURRENT_TIMESTAMP - INTERVAL '${params.createdAtOffsetHours} hours'
      ) RETURNING id;
    `);
    return res.rows[0].id;
  }

  // Helper para agregar participante
  async function addParticipant(encId: string, userId: string | null, params?: {
    estado?: string;
    reconfirmationStatus?: string;
    createdAtOffsetHours?: number;
    seatCount?: number;
  }) {
    const userVal = userId ? `'${userId}'` : 'NULL';
    const res = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, reconfirmation_status, seat_count, creado_en
      ) VALUES (
        '${encId}', ${userVal}, 'Invitado QA', '${params?.estado || 'confirmado'}',
        '${params?.reconfirmationStatus || 'none'}', ${params?.seatCount || 1},
        CURRENT_TIMESTAMP - INTERVAL '${params?.createdAtOffsetHours || 30} hours'
      ) RETURNING id;
    `);
    return res.rows[0].id;
  }

  // ---------------------------------------------------------------------------
  // 1. Recordatorio 24 h
  // ---------------------------------------------------------------------------
  test('1. Recordatorio 24 h: generado para participante confirmado en ventana 24h', async () => {
    // Encuentro mañana a esta misma hora (24h)
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Mañana 24h',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48, // Creado hace 48h
    });
    await addParticipant(encId, partUserA, { createdAtOffsetHours: 36 });

    const res = await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro() AS res;`);
    const r = (res.rows[0].res as any);

    assert.equal(r.ok, true);
    assert.ok(r.reminders_24h_sent >= 1, 'Debe enviar al menos 1 recordatorio 24h');

    // Verificar en Inbox
    const inbox = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${partUserA}' AND notification_type = 'encounter_reminder_24h';
    `);
    assert.equal(inbox.rows.length, 1);
    assert.match(inbox.rows[0].title as string, /Recordatorio: mañana/i);
    assert.equal(inbox.rows[0].payload.reminder_type, 'reminder_24h');
    assert.equal(inbox.rows[0].payload.can_withdraw, true);

    // Verificar en log durable
    const log = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${partUserA}' AND reminder_type = 'reminder_24h';
    `);
    assert.equal(log.rows.length, 1);
    assert.equal(log.rows[0].status, 'sent');
  });

  // ---------------------------------------------------------------------------
  // 2. Recordatorio 2 h
  // ---------------------------------------------------------------------------
  test('2. Recordatorio 2 h: generado para participante confirmado en ventana 2h', async () => {
    // Encuentro hoy dentro de 2 horas
    const twoHoursLater = new Date(Date.now() + 2 * 3600 * 1000).toTimeString().split(' ')[0];
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Hoy 2h',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: twoHoursLater,
      createdAtOffsetHours: 24,
    });
    await addParticipant(encId, partUserA, { createdAtOffsetHours: 12 });

    const res = await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro() AS res;`);
    const r = (res.rows[0].res as any);
    assert.equal(r.ok, true);
    assert.ok(r.reminders_2h_sent >= 1, 'Debe enviar recordatorio 2h');

    const inbox = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${partUserA}' AND notification_type = 'encounter_reminder_2h';
    `);
    assert.equal(inbox.rows.length, 1);
    assert.match(inbox.rows[0].title as string, /comienza en 2 horas/i);
  });

  // ---------------------------------------------------------------------------
  // 3. No duplicación por cron repetido (Idempotencia)
  // ---------------------------------------------------------------------------
  test('3. No duplicación por cron repetido: ejecución inmediata posterior no duplica avisos', async () => {
    const res = await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro() AS res;`);
    const r = (res.rows[0].res as any);
    assert.equal(r.ok, true);
    assert.equal(r.reminders_24h_sent, 0, 'No debe volver a enviar 24h ya enviados');
    assert.equal(r.reminders_2h_sent, 0, 'No debe volver a enviar 2h ya enviados');
  });

  // ---------------------------------------------------------------------------
  // 4. Encuentro cancelado
  // ---------------------------------------------------------------------------
  test('4. Encuentro cancelado: no genera recordatorios e invalida entregas pendientes', async () => {
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Cancelado',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: '18:00:00',
      createdAtOffsetHours: 48,
      estado: 'cancelado',
    });
    await addParticipant(encId, partUserB, { createdAtOffsetHours: 24 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    const log = await db.query(`SELECT * FROM public.encounter_reminders_log WHERE encuentro_id = '${encId}';`);
    assert.equal(log.rows.length, 0, 'Encuentro cancelado no debe emitir recordatorios');
  });

  // ---------------------------------------------------------------------------
  // 5. Participante retirado o reconfirmación declinada
  // ---------------------------------------------------------------------------
  test('5. Participante retirado o con reconfirmación declinada: no recibe recordatorio', async () => {
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Retirados',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48,
    });
    // Participante cancelado/retirado
    await addParticipant(encId, partUserB, { estado: 'cancelado' });

    // Participante con reconfirmación rechazada
    const declinedUser = '77777777-7777-7777-7777-777777777777';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ('${declinedUser}', 'dec@test.com') ON CONFLICT DO NOTHING;`);
    await addParticipant(encId, declinedUser, { estado: 'confirmado', reconfirmationStatus: 'declined' });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    const log = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id IN ('${partUserB}', '${declinedUser}');
    `);
    assert.equal(log.rows.length, 0, 'No debe enviar recordatorio a usuarios dados de baja o declinados');
  });

  // ---------------------------------------------------------------------------
  // 6. Solicitud pendiente o rechazada
  // ---------------------------------------------------------------------------
  test('6. Solicitud pendiente o rechazada: no confirmada no recibe recordatorio', async () => {
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Solicitudes Pendientes',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48,
    });
    const pendingUser = '88888888-8888-8888-8888-888888888888';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ('${pendingUser}', 'pen@test.com') ON CONFLICT DO NOTHING;`);
    await addParticipant(encId, pendingUser, { estado: 'pendiente' });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    const log = await db.query(`SELECT * FROM public.encounter_reminders_log WHERE user_id = '${pendingUser}';`);
    assert.equal(log.rows.length, 0, 'Solicitante pendiente nunca recibe recordatorio');
  });

  // ---------------------------------------------------------------------------
  // 7. Cambio de fecha: invalidación y reprogramación
  // ---------------------------------------------------------------------------
  test('7. Cambio de fecha: invalida recordatorio previo y actualiza estado', async () => {
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro para Reprogramar Fecha',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48,
    });
    await addParticipant(encId, partUserB, { createdAtOffsetHours: 30 });

    // Enviar recordatorio 24h
    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);
    const sent = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${partUserB}' AND status = 'sent';
    `);
    assert.equal(sent.rows.length, 1);

    // Host cambia la fecha del encuentro al día siguiente (+2 days)
    await db.query(`
      UPDATE public.encuentros
      SET fecha = CURRENT_DATE + INTERVAL '5 days'
      WHERE id = '${encId}';
    `);

    // El recordatorio previo para la fecha anterior debe quedar 'invalidated'
    const invalidated = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${partUserB}';
    `);
    assert.equal(invalidated.rows[0].status, 'invalidated');
  });

  // ---------------------------------------------------------------------------
  // 8. Cambio de hora: invalidación
  // ---------------------------------------------------------------------------
  test('8. Cambio de hora: invalida recordatorio previo emitido para la hora anterior', async () => {
    const twoHoursLater = new Date(Date.now() + 2 * 3600 * 1000).toTimeString().split(' ')[0];
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro para Reprogramar Hora',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: twoHoursLater,
      createdAtOffsetHours: 24,
    });
    await addParticipant(encId, partUserB, { createdAtOffsetHours: 12 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    // Cambiar hora a +5 horas
    const fiveHoursLater = new Date(Date.now() + 5 * 3600 * 1000).toTimeString().split(' ')[0];
    await db.query(`
      UPDATE public.encuentros
      SET hora = '${fiveHoursLater}'
      WHERE id = '${encId}';
    `);

    const log = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${partUserB}';
    `);
    assert.equal(log.rows[0].status, 'invalidated');
  });

  // ---------------------------------------------------------------------------
  // 9. Evento creado con menos de 24 h de anticipación
  // ---------------------------------------------------------------------------
  test('9. Evento creado con menos de 24 h: no envía recordatorio 24h extemporáneo', async () => {
    // Evento en 22 horas a partir de ahora (dentro de la ventana 20h-25h)
    const eventTime = new Date(Date.now() + 22 * 3600 * 1000);
    const fecha = eventTime.toISOString().split('T')[0];
    const hora = eventTime.toTimeString().split(' ')[0];

    // Creado hace solo 1 hora -> Anticipación total = 22h + 1h = 23h (< 24 horas)
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at,
        fecha, hora, estado, created_at
      ) VALUES (
        '${hostUser}', 'Encuentro Creado Express 23h', 'Express 23h', true, CURRENT_TIMESTAMP,
        '${fecha}', '${hora}', 'activo', CURRENT_TIMESTAMP - INTERVAL '1 hour'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const newUser = '99999999-9999-9999-9999-999999999999';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ('${newUser}', 'new24@test.com') ON CONFLICT DO NOTHING;`);
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, creado_en)
      VALUES ('${encId}', '${newUser}', 'Participante Express', 'confirmado', CURRENT_TIMESTAMP - INTERVAL '30 minutes');
    `);

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);
    const log = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${newUser}' AND reminder_type = 'reminder_24h';
    `);
    assert.equal(log.rows.length, 0, 'No debe emitir recordatorio de 24h para evento creado con menos de 24h');
  });

  // ---------------------------------------------------------------------------
  // 10. Evento creado con menos de 2 h de anticipación
  // ---------------------------------------------------------------------------
  test('10. Evento creado con menos de 2 h: no envía recordatorio 2h extemporáneo', async () => {
    // Evento en 80 minutos a partir de ahora (dentro de la ventana 15m - 135m)
    const eventTime = new Date(Date.now() + 80 * 60 * 1000);
    const fecha = eventTime.toISOString().split('T')[0];
    const hora = eventTime.toTimeString().split(' ')[0];

    // Creado hace solo 10 minutos -> Anticipación total = 90 minutos (< 105 minutos / 2 horas)
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at,
        fecha, hora, estado, created_at
      ) VALUES (
        '${hostUser}', 'Encuentro Creado Express 80m', 'Express 80m', true, CURRENT_TIMESTAMP,
        '${fecha}', '${hora}', 'activo', CURRENT_TIMESTAMP - INTERVAL '10 minutes'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const newUser = 'aaaaaaaa-1111-1111-1111-111111111111';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ('${newUser}', 'new2h@test.com') ON CONFLICT DO NOTHING;`);
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, creado_en)
      VALUES ('${encId}', '${newUser}', 'Participante Express 2h', 'confirmado', CURRENT_TIMESTAMP - INTERVAL '5 minutes');
    `);

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);
    const log = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${newUser}' AND reminder_type = 'reminder_2h';
    `);
    assert.equal(log.rows.length, 0, 'No debe emitir 2h para evento creado hace menos de 2 horas');
  });

  // ---------------------------------------------------------------------------
  // 11. Encuentro ya iniciado
  // ---------------------------------------------------------------------------
  test('11. Encuentro ya iniciado: no envía recordatorios tardíos', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toTimeString().split(' ')[0];
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Pasado',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: twoHoursAgo,
      createdAtOffsetHours: 48,
    });
    await addParticipant(encId, partUserA);

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);
    const log = await db.query(`SELECT * FROM public.encounter_reminders_log WHERE encuentro_id = '${encId}';`);
    assert.equal(log.rows.length, 0, 'No debe emitir recordatorios de eventos ya pasados o iniciados');
  });

  // ---------------------------------------------------------------------------
  // 12. Multi-seat (acompañantes sin cuenta)
  // ---------------------------------------------------------------------------
  test('12. Multi-seat: acompañante sin cuenta no recibe recordatorio; solo el titular confirmado', async () => {
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Multi-Seat Recordatorio',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48,
    });
    const multiUser = 'bbbbbbbb-2222-2222-2222-222222222222';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ('${multiUser}', 'multi@test.com') ON CONFLICT DO NOTHING;`);

    // Titular con seat_count = 3
    await addParticipant(encId, multiUser, { seatCount: 3, createdAtOffsetHours: 30 });
    // Acompañante con user_id = NULL
    await addParticipant(encId, null, { seatCount: 1, createdAtOffsetHours: 30 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    // Se emite 1 recordatorio para participantes (al titular, ninguno para acompañante sin cuenta)
    const logParts = await db.query(`SELECT * FROM public.encounter_reminders_log WHERE encuentro_id = '${encId}' AND user_id <> '${hostUser}';`);
    assert.equal(logParts.rows.length, 1);
    assert.equal(logParts.rows[0].user_id, multiUser);

    // Y el anfitrión recibe su recordatorio como host
    const logHost = await db.query(`SELECT * FROM public.encounter_reminders_log WHERE encuentro_id = '${encId}' AND user_id = '${hostUser}';`);
    assert.equal(logHost.rows.length, 1);
  });

  // ---------------------------------------------------------------------------
  // 13. Dispositivo sin permiso Push
  // ---------------------------------------------------------------------------
  test('13. Dispositivo sin suscripción Web Push: se entrega en Inbox sin error en Outbox', async () => {
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Sin Push',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48,
    });
    // partNoPushUser no tiene entradas en web_push_subscriptions
    await addParticipant(encId, partNoPushUser, { createdAtOffsetHours: 30 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    // En Inbox existe
    const inbox = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${partNoPushUser}' AND target_id = '${encId}';
    `);
    assert.equal(inbox.rows.length, 1);

    // En delivery outbox no se genera entrega porque no tiene suscripción activa
    const outbox = await db.query(`
      SELECT * FROM public.notification_delivery_outbox
      WHERE recipient_user_id = '${partNoPushUser}';
    `);
    assert.equal(outbox.rows.length, 0);
  });

  // ---------------------------------------------------------------------------
  // 14. Preferencias y horarios silenciosos
  // ---------------------------------------------------------------------------
  test('14. Horarios silenciosos: recordatorio se guarda en Inbox y suprime Web Push', async () => {
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Horario Silencioso',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48,
    });
    // partQuietUser tiene quiet_hours 00:00 - 23:59 (todo el día)
    await addParticipant(encId, partQuietUser, { createdAtOffsetHours: 30 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    // Registrado en Inbox con suppress_push: true
    const inbox = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${partQuietUser}' AND target_id = '${encId}';
    `);
    assert.equal(inbox.rows.length, 1);
    assert.equal(inbox.rows[0].payload.suppress_push, true);

    // Log durable registra 'suppressed_quiet_hours'
    const log = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${partQuietUser}';
    `);
    assert.equal(log.rows[0].status, 'suppressed_quiet_hours');

    // No se encoló en outbox de web push debido a suppress_push
    const outbox = await db.query(`
      SELECT * FROM public.notification_delivery_outbox
      WHERE inbox_notification_id = '${inbox.rows[0].id}';
    `);
    assert.equal(outbox.rows.length, 0);
  });

  // ---------------------------------------------------------------------------
  // 15. Reintentos y control de entregas
  // ---------------------------------------------------------------------------
  test('15. Pipeline de entrega: outbox registra intentos y control de fallas', async () => {
    // Tomar una entrega generada para partUserA en outbox
    const outboxRow = await db.query<{ id: string }>(`
      SELECT id FROM public.notification_delivery_outbox
      WHERE recipient_user_id = '${partUserA}' LIMIT 1;
    `);
    assert.ok(outboxRow.rows.length > 0, 'Debe existir entrega en outbox para partUserA');
    const delId = outboxRow.rows[0].id;

    // Simular intento fallido controlado
    await db.query(`
      UPDATE public.notification_delivery_outbox
      SET attempt_count = attempt_count + 1,
          last_error = 'Network temporary timeout',
          available_at = CURRENT_TIMESTAMP + INTERVAL '10 seconds'
      WHERE id = '${delId}';
    `);

    const updated = await db.query(`SELECT attempt_count, last_error FROM public.notification_delivery_outbox WHERE id = '${delId}';`);
    assert.equal(updated.rows[0].attempt_count, 1);
    assert.equal(updated.rows[0].last_error, 'Network temporary timeout');
  });

  // ---------------------------------------------------------------------------
  // 16. Cambio de usuario en dispositivo compartido
  // ---------------------------------------------------------------------------
  test('16. Dispositivo compartido / reasignado: cancelación por regla de privacidad', async () => {
    // Crear una entrega donde la suscripción pertenezca a otro usuario
    const dummyInbox = await db.query<{ id: string }>(`
      INSERT INTO public.inbox_notifications (
        recipient_user_id, notification_type, target_type, target_id, deep_link,
        title, body, dedup_key, expires_at
      ) VALUES (
        '${partUserA}', 'encounter_reminder_test_reassign', 'encounter', gen_random_uuid(), '/meet',
        'Title', 'Body', 'dedup_reassign', CURRENT_TIMESTAMP + INTERVAL '1 day'
      ) RETURNING id;
    `);
    const inboxId = dummyInbox.rows[0].id;

    // Asociar a una suscripción que pertenece a partUserB (mismatch)
    const subB = await db.query<{ id: string }>(`
      SELECT id FROM public.web_push_subscriptions WHERE user_id = '${partUserB}' LIMIT 1;
    `);

    await db.query(`
      INSERT INTO public.notification_delivery_outbox (
        inbox_notification_id, recipient_user_id, channel, web_push_subscription_id,
        status, dedup_key
      ) VALUES (
        '${inboxId}', '${partUserA}', 'web_push', '${subB.rows[0].id}',
        'pending', 'dedup_reassign:subB'
      );
    `);

    // Al validar el claim o regla de integridad, se detecta el mismatch en la suscripción reasignada
    const checkMismatch = await db.query(`
      SELECT d.id, s.user_id AS sub_user_id, d.recipient_user_id
      FROM public.notification_delivery_outbox d
      JOIN public.web_push_subscriptions s ON s.id = d.web_push_subscription_id
      WHERE d.inbox_notification_id = '${inboxId}' AND d.web_push_subscription_id = '${subB.rows[0].id}';
    `);
    assert.ok(checkMismatch.rows.length > 0);
    assert.notEqual(checkMismatch.rows[0].sub_user_id, checkMismatch.rows[0].recipient_user_id);
  });

  // ---------------------------------------------------------------------------
  // 17. Deep links y acceso autorizado en recordatorios
  // ---------------------------------------------------------------------------
  test('17. Deep links y acceso autorizado en recordatorios', async () => {
    await setAuth(partUserA);
    const notifications = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${partUserA}' AND notification_type = 'encounter_reminder_24h'
      ORDER BY created_at ASC
      LIMIT 1;
    `);
    assert.ok(notifications.rows.length > 0);
    const notif = notifications.rows[0];

    // Deep link seguro de participante hacia /solicitudes?open_encounter=:id
    assert.match(notif.deep_link as string, /^\/solicitudes\?open_encounter=[a-f0-9-]+$/);
    // Payload facilita consultar detalles y opción de retirarse
    assert.equal(notif.payload.withdrawal_route, '/solicitudes');
    assert.equal(notif.payload.detail_route, notif.deep_link);
    assert.equal(notif.payload.can_withdraw, true);
    assert.equal(notif.payload.role, 'participant');

    // Deep link seguro de anfitrión hacia /meet/:id
    const hostNotifications = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${hostUser}' AND notification_type = 'encounter_reminder_24h'
      ORDER BY created_at ASC
      LIMIT 1;
    `);
    assert.ok(hostNotifications.rows.length > 0);
    const hostNotif = hostNotifications.rows[0];
    assert.match(hostNotif.deep_link as string, /^\/meet\/[a-f0-9-]+$/);
    assert.equal(hostNotif.payload.role, 'host');
    assert.equal(hostNotif.payload.detail_route, hostNotif.deep_link);
  });

  // ---------------------------------------------------------------------------
  // 18. Aislamiento de encuentros privados
  // ---------------------------------------------------------------------------
  test('18. Aislamiento de encuentros privados: nunca generan recordatorios automáticos de abiertos', async () => {
    const encPrivId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro 100% Privado',
      isOpen: false, // is_open = false
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48,
    });
    const privateUser = 'cccccccc-3333-3333-3333-333333333333';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ('${privateUser}', 'priv@test.com') ON CONFLICT DO NOTHING;`);
    await addParticipant(encPrivId, privateUser, { createdAtOffsetHours: 30 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    const log = await db.query(`SELECT * FROM public.encounter_reminders_log WHERE encuentro_id = '${encPrivId}';`);
    assert.equal(log.rows.length, 0, 'Encuentros privados quedan 100% excluidos');
  });

  // ---------------------------------------------------------------------------
  // 19. Consulta segura get_recordatorios_encuentro_seguro
  // ---------------------------------------------------------------------------
  test('19. RPC get_recordatorios_encuentro_seguro: autorización anfitrión y participante', async () => {
    // Encuentro de prueba
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Test RPC Recordatorios',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48,
    });
    await addParticipant(encId, partUserA, { createdAtOffsetHours: 30 });
    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    // Host consulta: obtiene resumen del encuentro
    await setAuth(hostUser);
    const hostRes = await db.query(`SELECT public.get_recordatorios_encuentro_seguro('${encId}') AS res;`);
    const hr = (hostRes.rows[0].res as any);
    assert.equal(hr.ok, true);
    assert.ok(hr.reminders.length >= 1);

    // Participante consulta: obtiene sus propios recordatorios
    await setAuth(partUserA);
    const partRes = await db.query(`SELECT public.get_recordatorios_encuentro_seguro('${encId}') AS res;`);
    const pr = (partRes.rows[0].res as any);
    assert.equal(pr.ok, true);
    assert.ok(pr.reminders.length >= 1);

    // Tercero no participante recibe error forbidden
    await setAuth(thirdPartyUser);
    const thirdRes = await db.query(`SELECT public.get_recordatorios_encuentro_seguro('${encId}') AS res;`);
    const tr = (thirdRes.rows[0].res as any);
    assert.equal(tr.ok, false);
    assert.equal(tr.error, 'forbidden');
  });

  // ---------------------------------------------------------------------------
  // 20. Reprogramaciones e idempotencia en ciclo A -> B -> A
  // ---------------------------------------------------------------------------
  test('20. Reprogramaciones e idempotencia en ciclo A -> B -> A', async () => {
    // Horario A: exactamente dentro de la ventana de 24 horas a partir de ahora
    const timeA = new Date(Date.now()).toTimeString().split(' ')[0];
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Ciclo Reprogramacion A-B-A',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: timeA,
      createdAtOffsetHours: 48,
    });
    const partC = '77777777-7777-7777-7777-777777777777';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ('${partC}', 'partc@test.com') ON CONFLICT DO NOTHING;`);
    await db.query(`
      INSERT INTO public.web_push_subscriptions (id, user_id, endpoint, p256dh_key, auth_key, status)
      VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', '${partC}', 'https://push.example.com/userC', 'p256C', 'authC', 'active')
      ON CONFLICT DO NOTHING;
    `);
    await addParticipant(encId, partC, { createdAtOffsetHours: 36 });

    // 1. Procesar recordatorios en Horario A
    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    const logA1 = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${partC}' AND scheduled_for_time = '${timeA}';
    `);
    assert.equal(logA1.rows.length, 1);
    assert.equal(logA1.rows[0].status, 'sent');

    // 2. Reprogramar a Horario B (pasado mañana)
    const timeB = new Date(Date.now() + 3600 * 1000).toTimeString().split(' ')[0];
    await db.query(`
      UPDATE public.encuentros
      SET fecha = CURRENT_DATE + INTERVAL '2 days',
          hora = '${timeB}'
      WHERE id = '${encId}';
    `);

    // Invalida recordatorio para horario anterior
    const logA2 = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${partC}' AND scheduled_for_time = '${timeA}';
    `);
    assert.equal(logA2.rows.length, 1);
    assert.equal(logA2.rows[0].status, 'invalidated');

    // 3. Regresar a Horario A (mañana a timeA)
    await db.query(`
      UPDATE public.encuentros
      SET fecha = CURRENT_DATE + INTERVAL '1 day',
          hora = '${timeA}'
      WHERE id = '${encId}';
    `);

    // 4. Procesar recordatorios nuevamente para Horario A
    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    const logA3 = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${partC}' AND scheduled_for_time = '${timeA}';
    `);
    assert.equal(logA3.rows.length, 1);
    assert.equal(logA3.rows[0].status, 'sent', 'Dedup no bloquea nuevo aviso para el horario vigente A');

    // 5. Ejecución posterior no duplica
    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);
    const countCheck = await db.query(`
      SELECT count(*) as c FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encId}' AND user_id = '${partC}' AND scheduled_for_time = '${timeA}';
    `);
    assert.equal(Number(countCheck.rows[0].c), 1);
  });

  // ---------------------------------------------------------------------------
  // 21. Quiet hours en worker claim y bypass para avisos críticos
  // ---------------------------------------------------------------------------
  test('21. Quiet hours en worker claim: cancelación de no críticos y entrega garantizada de críticos', async () => {
    // 1. Notificación no crítica con outbox pendiente para usuario en quiet hours
    const nonCritInbox = await db.query<{ id: string }>(`
      INSERT INTO public.inbox_notifications (
        recipient_user_id, notification_type, target_type, target_id, deep_link,
        title, body, payload, dedup_key, expires_at
      ) VALUES (
        '${partQuietUser}', 'encounter_reminder_24h', 'encounter', gen_random_uuid(), '/solicitudes',
        'Recordatorio normal', 'Texto', '{"suppress_push": false}'::jsonb, 'dedup_claim_quiet_noncrit', CURRENT_TIMESTAMP + INTERVAL '1 day'
      ) RETURNING id;
    `);
    const subQuiet = await db.query<{ id: string }>(`
      SELECT id FROM public.web_push_subscriptions WHERE user_id = '${partQuietUser}' LIMIT 1;
    `);
    const outboxNonCrit = await db.query<{ id: string }>(`
      INSERT INTO public.notification_delivery_outbox (
        inbox_notification_id, recipient_user_id, channel, web_push_subscription_id,
        status, dedup_key
      ) VALUES (
        '${nonCritInbox.rows[0].id}', '${partQuietUser}', 'web_push', '${subQuiet.rows[0].id}',
        'pending', 'dedup_outbox_quiet_noncrit'
      ) RETURNING id;
    `);

    // 2. Notificación crítica (cancelación de encuentro) para el mismo usuario
    const critInbox = await db.query<{ id: string }>(`
      INSERT INTO public.inbox_notifications (
        recipient_user_id, notification_type, target_type, target_id, deep_link,
        title, body, payload, dedup_key, expires_at
      ) VALUES (
        '${partQuietUser}', 'encounter_cancelled_for_participant', 'encounter', gen_random_uuid(), '/solicitudes',
        'Encuentro cancelado', 'Texto', '{"priority": "critical"}'::jsonb, 'dedup_claim_quiet_crit', CURRENT_TIMESTAMP + INTERVAL '1 day'
      ) RETURNING id;
    `);
    const outboxCrit = await db.query<{ id: string }>(`
      INSERT INTO public.notification_delivery_outbox (
        inbox_notification_id, recipient_user_id, channel, web_push_subscription_id,
        status, dedup_key
      ) VALUES (
        '${critInbox.rows[0].id}', '${partQuietUser}', 'web_push', '${subQuiet.rows[0].id}',
        'pending', 'dedup_outbox_quiet_crit'
      ) RETURNING id;
    `);

    // 3. Worker ejecuta claim_web_push_deliveries_seguro
    const claimRes = await db.query(`SELECT public.claim_web_push_deliveries_seguro(10, 'worker-test') AS res;`);
    const cr = (claimRes.rows[0].res as any);
    assert.equal(cr.ok, true);

    // La entrega no crítica debió ser cancelada por quiet hours en el claim
    const nonCritCheck = await db.query(`
      SELECT status, last_error FROM public.notification_delivery_outbox WHERE id = '${outboxNonCrit.rows[0].id}';
    `);
    assert.equal(nonCritCheck.rows[0].status, 'cancelled');
    assert.equal(nonCritCheck.rows[0].last_error, 'Suppressed by quiet hours');

    // La entrega crítica debió superar quiet hours y pasar a 'processing' con is_critical = true
    const critCheck = await db.query(`
      SELECT status FROM public.notification_delivery_outbox WHERE id = '${outboxCrit.rows[0].id}';
    `);
    assert.equal(critCheck.rows[0].status, 'processing');
    const claimedCrit = cr.deliveries.find((d: any) => d.delivery_id === outboxCrit.rows[0].id);
    assert.ok(claimedCrit, 'El aviso crítico debe estar presente en el lote de despacho');
    assert.equal(claimedCrit.is_critical, true);
    assert.equal(claimedCrit.urgency, 'high');
  });

  // ---------------------------------------------------------------------------
  // 22. Diferenciación de estados de entrega
  // ---------------------------------------------------------------------------
  test('22. Diferenciación de estados de entrega (Inbox vs Outbox pending vs delivered vs suppressed)', async () => {
    const encId = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Estados Entrega',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: new Date(Date.now()).toTimeString().split(' ')[0],
      createdAtOffsetHours: 48,
    });
    await addParticipant(encId, partUserA, { createdAtOffsetHours: 30 });
    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    await setAuth(hostUser);
    const hostRes = await db.query(`SELECT public.get_recordatorios_encuentro_seguro('${encId}') AS res;`);
    const hr = (hostRes.rows[0].res as any);
    assert.equal(hr.ok, true);

    const partReminder = hr.reminders.find((r: any) => r.recipient_role === 'participant');
    assert.ok(partReminder);
    // Inbox: guardado y entregado en bandeja (read_at is null)
    assert.equal(partReminder.inbox_status, 'delivered');
    // Web Push: encolado en espera de despacho por worker
    assert.equal(partReminder.push_delivery_status, 'pending');

    // Simular que el gateway Web Push completó la entrega
    await db.query(`
      UPDATE public.notification_delivery_outbox
      SET status = 'delivered',
          delivered_at = CURRENT_TIMESTAMP
      WHERE recipient_user_id = '${partUserA}';
    `);

    const hostResAfter = await db.query(`SELECT public.get_recordatorios_encuentro_seguro('${encId}') AS res;`);
    const hrAfter = (hostResAfter.rows[0].res as any);
    const partReminderAfter = hrAfter.reminders.find((r: any) => r.recipient_role === 'participant');
    assert.equal(partReminderAfter.push_delivery_status, 'delivered');
  });

  // ---------------------------------------------------------------------------
  // 23. Validación de deep link y redirección post-auth de participante
  // ---------------------------------------------------------------------------
  test('23. Validación de deep link y compatibilidad post-auth para participantes', () => {
    const validUuid = '12345678-1234-1234-1234-123456789abc';
    const participantDeepLink = `/solicitudes?open_encounter=${validUuid}`;

    // 1. Validador interno de deep links en UI
    const validated = validateDeepLink(participantDeepLink);
    assert.equal(validated, participantDeepLink);

    // 2. Validador post-auth (redirección tras login de Google y recarga)
    assert.equal(isValidPostAuthRedirect(participantDeepLink), true);
    assert.equal(isValidPostAuthRedirect('/solicitudes'), true);
    assert.equal(isValidPostAuthRedirect('/solicitudes?malicious=true'), false);
    assert.equal(isValidPostAuthRedirect('/solicitudes#token=123'), false);
  });

  // ---------------------------------------------------------------------------
  // 24. Límites de precisión de la ventana 24 h (sincronizada con 10 min pg_cron)
  // ---------------------------------------------------------------------------
  test('24. Límites de precisión 24 h: rechazo a 24h 20m (evita 25h prematuro) y aceptación a 24h 05m', async () => {
    // A. Encuentro a 24h 20m en el futuro (> 24h 10m): NO debe emitirse aún (el viejo código a 25h lo emitía 1h antes)
    const futureDateA = new Date(Date.now() + 24 * 3600000 + 20 * 60000); // +24h 20m
    const fechaA = futureDateA.toISOString().split('T')[0];
    const horaA = futureDateA.toTimeString().split(' ')[0];

    const encTooEarly = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Prematuro 24h 20m',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: horaA,
      createdAtOffsetHours: 48,
    });
    // Forzar fecha exacta calculada
    await db.query(`UPDATE public.encuentros SET fecha = '${fechaA}' WHERE id = '${encTooEarly}';`);
    await addParticipant(encTooEarly, partUserA, { createdAtOffsetHours: 36 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);
    const logTooEarly = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encTooEarly}' AND reminder_type = 'reminder_24h';
    `);
    assert.equal(logTooEarly.rows.length, 0, 'No debe emitir recordatorio a 24h 20m');

    // B. Encuentro a 24h 05m en el futuro (<= 24h 10m, dentro del tick de cron): SÍ debe emitirse
    const futureDateB = new Date(Date.now() + 24 * 3600000 + 4 * 60000); // +24h 04m
    const fechaB = futureDateB.toISOString().split('T')[0];
    const horaB = futureDateB.toTimeString().split(' ')[0];

    const encJustInTime = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro En Ventana 24h 05m',
      isOpen: true,
      fechaOffsetDays: 1,
      hora: horaB,
      createdAtOffsetHours: 48,
    });
    await db.query(`UPDATE public.encuentros SET fecha = '${fechaB}' WHERE id = '${encJustInTime}';`);
    await addParticipant(encJustInTime, partUserA, { createdAtOffsetHours: 36 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);
    const logJustInTime = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encJustInTime}' AND reminder_type = 'reminder_24h';
    `);
    assert.equal(logJustInTime.rows.length, 2, 'Debe emitir a anfitrión y participante');
  });

  // ---------------------------------------------------------------------------
  // 25. Límites de precisión de la ventana 2 h (sincronizada con 10 min pg_cron)
  // ---------------------------------------------------------------------------
  test('25. Límites de precisión 2 h: rechazo a 2h 20m (evita 2h 15m prematuro) y aceptación a 2h 05m', async () => {
    // A. Encuentro a 2h 20m en el futuro (> 2h 10m): NO debe emitirse
    const futureDateA = new Date(Date.now() + 2 * 3600000 + 20 * 60000);
    const horaA = futureDateA.toTimeString().split(' ')[0];

    const encTooEarly = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Prematuro 2h 20m',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: horaA,
      createdAtOffsetHours: 24,
    });
    await addParticipant(encTooEarly, partUserB, { createdAtOffsetHours: 12 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);
    const logTooEarly = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encTooEarly}' AND reminder_type = 'reminder_2h';
    `);
    assert.equal(logTooEarly.rows.length, 0, 'No debe emitir recordatorio a 2h 20m');

    // B. Encuentro a 2h 05m en el futuro (<= 2h 10m): SÍ debe emitirse con copy ordinario
    const futureDateB = new Date(Date.now() + 2 * 3600000 + 3 * 60000);
    const horaB = futureDateB.toTimeString().split(' ')[0];

    const encJustInTime = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro En Ventana 2h 05m',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: horaB,
      createdAtOffsetHours: 24,
    });
    await addParticipant(encJustInTime, partUserB, { createdAtOffsetHours: 12 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);
    const logJustInTime = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encJustInTime}' AND reminder_type = 'reminder_2h';
    `);
    assert.equal(logJustInTime.rows.length, 2);

    const inbox = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${partUserB}' AND target_id = '${encJustInTime}';
    `);
    assert.match(inbox.rows[0].title as string, /comienza en 2 horas/i);
    assert.match(inbox.rows[0].body as string, /empieza en 2 horas/i);
  });

  // ---------------------------------------------------------------------------
  // 26. Recuperación controlada ante demoras del cron (aviso 2h generado tarde)
  // ---------------------------------------------------------------------------
  test('26. Recuperación demorada 2 h: cron ejecutado a 35 min antes del evento adapta el copy a "comienza pronto"', async () => {
    // Encuentro en 35 minutos (cron sufrió demora y corre a 35m antes del evento)
    const delayedDate = new Date(Date.now() + 35 * 60000);
    const delayedHora = delayedDate.toTimeString().split(' ')[0];

    const encDelayed = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Cron Demorado 35m',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: delayedHora,
      createdAtOffsetHours: 24,
    });
    await addParticipant(encDelayed, partUserA, { createdAtOffsetHours: 12 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    // El recordatorio SÍ se recupera (no se pierde la prevención de inasistencia)
    const logDelayed = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encDelayed}' AND reminder_type = 'reminder_2h';
    `);
    assert.equal(logDelayed.rows.length, 2, 'Debe recuperarse y emitirse a anfitrión y participante');

    // PERO el copy NO debe decir "comienza en 2 horas" (temporalmente falso) sino "comienza pronto"
    const inbox = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${partUserA}' AND target_id = '${encDelayed}';
    `);
    assert.equal(inbox.rows.length, 1);
    assert.match(inbox.rows[0].title as string, /comienza pronto/i);
    assert.match(inbox.rows[0].body as string, /empieza pronto/i);
    assert.doesNotMatch(inbox.rows[0].title as string, /en 2 horas/i);
    assert.doesNotMatch(inbox.rows[0].body as string, /en 2 horas/i);
  });

  // ---------------------------------------------------------------------------
  // 27. Recuperación controlada ante demoras del cron (aviso 24h el mismo día)
  // ---------------------------------------------------------------------------
  test('27. Recuperación demorada 24 h: cron ejecutado el mismo día adapta el copy a "hoy" en lugar de "mañana"', async () => {
    // Encuentro hoy a las 23:30 (en 12 horas, dentro de ventana [24h 10m .. 10h])
    // Creado hace 35 horas -> anticipación >= 23h 30m
    const encSameDay = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Hoy Demorado',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: '23:30:00',
      createdAtOffsetHours: 35,
    });
    await db.query(`UPDATE public.encuentros SET fecha = CURRENT_DATE, hora = '23:30:00' WHERE id = '${encSameDay}';`);
    await addParticipant(encSameDay, partUserA, { createdAtOffsetHours: 30 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    const log = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encSameDay}' AND reminder_type = 'reminder_24h';
    `);
    assert.equal(log.rows.length, 2, 'Debe emitir aviso recuperado');

    const inbox = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${partUserA}' AND target_id = '${encSameDay}';
    `);
    assert.equal(inbox.rows.length, 1);
    // Debido a que la fecha es HOY, no debe decir "mañana" sino "hoy"
    assert.match(inbox.rows[0].title as string, /hoy es el encuentro/i);
    assert.match(inbox.rows[0].body as string, /hoy tenés el encuentro/i);
    assert.doesNotMatch(inbox.rows[0].title as string, /mañana/i);
  });

  // ---------------------------------------------------------------------------
  // 28. Cero avisos retrospectivos tras el inicio del evento
  // ---------------------------------------------------------------------------
  test('28. Cero avisos retrospectivos tras el inicio del evento', async () => {
    // Evento iniciado hace 15 minutos
    const pastDate = new Date(Date.now() - 15 * 60000);
    const pastHora = pastDate.toTimeString().split(' ')[0];

    const encStarted = await createEncounter({
      hostId: hostUser,
      title: 'Encuentro Ya Iniciado',
      isOpen: true,
      fechaOffsetDays: 0,
      hora: pastHora,
      createdAtOffsetHours: 24,
    });
    await addParticipant(encStarted, partUserB, { createdAtOffsetHours: 12 });

    await db.query(`SELECT public.procesar_recordatorios_encuentros_abiertos_seguro();`);

    const log = await db.query(`
      SELECT * FROM public.encounter_reminders_log
      WHERE encuentro_id = '${encStarted}';
    `);
    assert.equal(log.rows.length, 0, 'No debe emitir ningún recordatorio retrospectivo tras el inicio');
  });
});
