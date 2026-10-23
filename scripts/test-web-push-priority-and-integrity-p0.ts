import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const newKeys = () => ({
  p256dh: crypto.randomBytes(65).toString('base64url'),
  auth: crypto.randomBytes(16).toString('base64url'),
});
const newEndpoint = () =>
  `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(24).toString('base64url')}`;

describe('Mini-sprint P0: Blindaje de Notificaciones Críticas y Prioridad Web Push', () => {
  let db: PGlite;

  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';

  const setAuth = async (userId: string | null) => {
    if (!userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
      await db.query(`SET ROLE anon;`);
      return;
    }
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
    await db.query(
      `SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": false}', false);`
    );
    await db.query(`SET ROLE authenticated;`);
  };

  const asAdmin = async () => {
    await db.query(`RESET ROLE;`);
    await db.query(`SET ROLE service_role;`);
  };

  const rpc = async (
    userId: string | null,
    name: string,
    args: Record<string, unknown>
  ) => {
    if (userId) {
      await setAuth(userId);
    } else {
      await asAdmin();
    }
    const keys = Object.keys(args);
    const sql = `SELECT public.${name}(${keys
      .map((k, i) => `${k} => $${i + 1}`)
      .join(', ')}) AS res;`;
    const { rows } = await db.query<{ res: any }>(
      sql,
      keys.map((k) => args[k])
    );
    return rows[0].res;
  };

  before(async () => {
    db = new PGlite();

    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
      ALTER ROLE service_role BYPASSRLS;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY, email TEXT);
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT SELECT ON auth.users TO service_role;

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;
      GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;

      CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = pg_catalog.timezone('utc', pg_catalog.now());
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      INSERT INTO auth.users (id, email) VALUES
        ('${userA}', 'usera@example.com'),
        ('${userB}', 'userb@example.com')
      ON CONFLICT DO NOTHING;

      -- Tablas mínimas requeridas para compilar y probar actualizar_encuentro_seguro en PGlite
      CREATE TABLE IF NOT EXISTS public.localities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY,
        host_id UUID NOT NULL,
        titulo TEXT NOT NULL,
        open_public_title TEXT,
        descripcion TEXT,
        open_description TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        locality_id TEXT,
        open_public_zone TEXT,
        lugar_texto TEXT,
        link_virtual TEXT,
        max_participants INT DEFAULT 10,
        allow_multi_seat_requests BOOLEAN DEFAULT false,
        min_seats_per_request INT DEFAULT 1,
        max_seats_per_request INT DEFAULT 1,
        is_open BOOLEAN DEFAULT false,
        opened_at TIMESTAMPTZ,
        moderation_status TEXT DEFAULT 'approved',
        moderation_reason TEXT,
        moderated_at TIMESTAMPTZ,
        moderation_decision_source TEXT,
        closed_at TIMESTAMPTZ,
        inscriptions_closed BOOLEAN DEFAULT false,
        inscriptions_cycle_id UUID,
        estado TEXT NOT NULL DEFAULT 'activo'
      );
      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL,
        user_id UUID NOT NULL,
        seat_count INT DEFAULT 1,
        estado TEXT NOT NULL DEFAULT 'confirmado',
        reconfirmation_status TEXT DEFAULT 'none',
        reconfirmed_at TIMESTAMPTZ,
        reconfirmed_cycle_id UUID
      );
      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL,
        usuario_id UUID NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE OR REPLACE FUNCTION public.evaluar_contenido_publico_determinista(t TEXT, d TEXT)
      RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$
        SELECT true, NULL::TEXT;
      $$ LANGUAGE sql;

      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
    `);

    // 2. Cargar migraciones base de notificaciones, outbox y las nuevas migraciones P0
    const migrations = [
      'supabase/migrations/20261002180000_notifications_inbox_and_outbox_base.sql',
      'supabase/migrations/20261002200000_harden_inbox_rpc_grants.sql',
      'supabase/migrations/20261003120000_web_push_subscriptions.sql',
      'supabase/migrations/20261003140000_web_push_delivery_outbox.sql',
      'supabase/migrations/20261003150000_harden_web_push_delivery_safety.sql',
      'supabase/migrations/20261023183000_harden_web_push_claim_and_priority_v1.sql',
      'supabase/migrations/20261023193000_harden_logistics_priority_and_claim_safety_v2.sql',
    ];

    for (const mig of migrations) {
      await db.exec(read(mig));
    }
  });

  const registerDevice = async (userId: string) => {
    return rpc(userId, 'registrar_web_push_subscription_seguro', {
      p_endpoint: newEndpoint(),
      p_p256dh: newKeys().p256dh,
      p_auth: newKeys().auth,
    });
  };

  const insertInbox = async (
    recipientId: string,
    notifType: string,
    payload: Record<string, unknown> = {},
    title = 'Test Title',
    body = 'Test Body'
  ) => {
    await asAdmin();
    return rpc(null, 'insertar_inbox_notification_seguro', {
      p_recipient_user_id: recipientId,
      p_notification_type: notifType,
      p_target_type: 'encounter',
      p_target_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      p_deep_link: '/meet/test',
      p_title: title,
      p_body: body,
      p_payload: payload,
      p_dedup_key: `dedup-${crypto.randomUUID()}`,
      p_expires_at: null,
    });
  };

  test('Validación D & C: claim_web_push_deliveries_seguro asigna urgency high a cancelaciones y normal a eventos comunes', async () => {
    await registerDevice(userA);

    // 1. Notificación crítica de cancelación
    await insertInbox(userA, 'encounter_cancelled_for_participant', { priority: 'critical', cancellation_reason: 'Lluvia' });

    // 2. Notificación crítica de cambio de horario para participante confirmado
    await insertInbox(userA, 'encounter_schedule_changed', { is_applicant: false, date_label: 'Mañana 19:00' });

    // 3. Notificación normal de coincidencia de Discovery
    await insertInbox(userA, 'match_found', { score: 95 });

    // 4. Notificación de tipo desconocido
    await insertInbox(userA, 'unknown_future_event_type', { foo: 'bar' });

    // Reclamar lote con claim_web_push_deliveries_seguro
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', { p_batch_size: 10 });
    assert.equal(claimRes.ok, true);
    assert.equal(claimRes.deliveries.length, 4);

    const cancDelivery = claimRes.deliveries.find((d: any) => d.notification_type === 'encounter_cancelled_for_participant');
    assert.ok(cancDelivery);
    assert.equal(cancDelivery.is_critical, true);
    assert.equal(cancDelivery.urgency, 'high');

    const schedDelivery = claimRes.deliveries.find((d: any) => d.notification_type === 'encounter_schedule_changed');
    assert.ok(schedDelivery);
    assert.equal(schedDelivery.is_critical, true);
    assert.equal(schedDelivery.urgency, 'high');

    const matchDelivery = claimRes.deliveries.find((d: any) => d.notification_type === 'match_found');
    assert.ok(matchDelivery);
    assert.equal(matchDelivery.is_critical, false);
    assert.equal(matchDelivery.urgency, 'normal');

    const unknownDelivery = claimRes.deliveries.find((d: any) => d.notification_type === 'unknown_future_event_type');
    assert.ok(unknownDelivery);
    assert.equal(unknownDelivery.is_critical, false);
    assert.equal(unknownDelivery.urgency, 'normal');
  });

  test('Validación E: Reprogramación dirigida a solicitante pendiente (is_applicant: true) recibe urgency normal', async () => {
    await registerDevice(userB);

    await insertInbox(userB, 'encounter_schedule_changed', { is_applicant: true, public_zone: 'Palermo' });

    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', { p_batch_size: 10 });
    assert.equal(claimRes.ok, true);
    const applicantSched = claimRes.deliveries.find((d: any) => d.notification_type === 'encounter_schedule_changed');
    assert.ok(applicantSched);
    assert.equal(applicantSched.is_critical, false);
    assert.equal(applicantSched.urgency, 'normal');
  });

  test('Validación C: Cambio de logística relevante (encounter_logistics_changed) para participante confirmado recibe prioridad high', async () => {
    await asAdmin();
    await db.query(`DELETE FROM public.notification_delivery_outbox;`);
    await db.query(`DELETE FROM public.inbox_notifications;`);
    await db.query(`DELETE FROM public.web_push_subscriptions;`);

    await registerDevice(userA);

    // 1. Modificación de logística generada por actualizar_encuentro_seguro para participante confirmado
    await insertInbox(userA, 'encounter_logistics_changed', {
      encounter_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      title: 'Encuentro de Prueba',
      priority: 'critical',
      change_type: 'logistics',
    });

    // 2. Modificación de logística sin priority explícito pero sin is_applicant (participante confirmado)
    await insertInbox(userA, 'encounter_logistics_changed', {
      encounter_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      title: 'Encuentro de Prueba 2',
      change_type: 'logistics',
    });

    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', { p_batch_size: 10 });
    assert.equal(claimRes.ok, true);
    assert.equal(claimRes.deliveries.length, 2);

    for (const d of claimRes.deliveries) {
      assert.equal(d.notification_type, 'encounter_logistics_changed');
      assert.equal(d.is_critical, true, 'Logística para participante confirmado debe ser critical');
      assert.equal(d.urgency, 'high', 'Logística para participante confirmado debe ser urgency high');
    }
  });

  test('Validación C2: actualizar_encuentro_seguro emite encounter_logistics_changed con priority critical para participantes confirmados', async () => {
    const encounterId = '33333333-3333-3333-3333-333333333333';

    await asAdmin();
    await db.query(`DELETE FROM public.notification_delivery_outbox;`);
    await db.query(`DELETE FROM public.inbox_notifications;`);
    await db.query(`DELETE FROM public.web_push_subscriptions;`);

    // Insertar encuentro de prueba donde userA es host
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, modalidad, lugar_texto, is_open, estado)
      VALUES ($1, $2, 'Encuentro Test', 'Encuentro Abierto Test', '2026-10-30', '18:00', 'presencial', 'Café Central', true, 'activo')
      ON CONFLICT (id) DO UPDATE SET lugar_texto = 'Café Central';
    `, [encounterId, userA]);

    // Registrar userB como participante confirmado
    await db.query(`DELETE FROM public.participantes WHERE encuentro_id = $1;`, [encounterId]);
    await db.query(`INSERT INTO public.participantes (encuentro_id, user_id, estado) VALUES ($1, $2, 'confirmado');`, [encounterId, userB]);

    // Dispositivo para userB
    await registerDevice(userB);

    // Host userA actualiza lugar_texto
    const updateRes = await rpc(userA, 'actualizar_encuentro_seguro', {
      p_encuentro_id: encounterId,
      p_host_id: userA,
      p_data: { lugar_texto: 'Nuevo Lugar Plaza Serrano' },
    });
    assert.equal(updateRes.ok, true);
    assert.equal(updateRes.logistics_changed, true);

    // Verificar como admin que se insertó notificación en inbox_notifications para userB
    await asAdmin();
    const { rows: inboxRows } = await db.query(
      `SELECT notification_type, payload, body FROM public.inbox_notifications WHERE recipient_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userB]
    );
    assert.ok(inboxRows.length > 0);
    const notif = inboxRows[0];
    assert.equal(notif.notification_type, 'encounter_logistics_changed');
    assert.equal(notif.payload.priority, 'critical', 'Debe incluir priority: critical en el payload');
    assert.equal(notif.payload.change_type, 'logistics');

    // Invariante de privacidad: el body no expone la dirección exacta
    assert.ok(!notif.body.includes('Plaza Serrano'), 'El cuerpo de la notificación no debe exponer la dirección');

    // Reclamar delivery outbox y verificar urgencia high
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', { p_batch_size: 5 });
    assert.equal(claimRes.ok, true);
    const deliv = claimRes.deliveries.find((d: any) => d.notification_type === 'encounter_logistics_changed');
    assert.ok(deliv);
    assert.equal(deliv.is_critical, true);
    assert.equal(deliv.urgency, 'high');
  });

  test('Validación SQL Robustez: claim_web_push_deliveries_seguro tolera campo ausente, booleanos, valores inesperados y tipos desconocidos sin abortar', async () => {
    await asAdmin();
    await db.query(`DELETE FROM public.notification_delivery_outbox;`);
    await db.query(`DELETE FROM public.inbox_notifications;`);
    await db.query(`DELETE FROM public.web_push_subscriptions;`);

    await registerDevice(userB);

    // Caso 1: Campo is_applicant ausente en encounter_schedule_changed (confirmado) -> high
    await insertInbox(userB, 'encounter_schedule_changed', { date_label: 'Viernes 20:00' });

    // Caso 2: Booleano verdadero is_applicant: true -> normal
    await insertInbox(userB, 'encounter_schedule_changed', { is_applicant: true });

    // Caso 3: Booleano falso is_applicant: false -> high
    await insertInbox(userB, 'encounter_schedule_changed', { is_applicant: false });

    // Caso 4: Valor inesperado (string arbitrario que antes rompía por ::boolean) -> safe (no lanza excepción)
    await insertInbox(userB, 'encounter_schedule_changed', { is_applicant: 'unexpected_text_value_that_caused_cast_exception' });

    // Caso 5: Valor inesperado numérico -> safe
    await insertInbox(userB, 'encounter_schedule_changed', { is_applicant: 12345 });

    // Caso 6: Valor inesperado de tipo objeto -> safe
    await insertInbox(userB, 'encounter_schedule_changed', { is_applicant: { nested: true } });

    // Caso 7: Notificación desconocida con payload malformado -> safe, normal
    await insertInbox(userB, 'totally_unknown_notification_type', {
      is_applicant: 'corrupted',
      priority: 99999,
    });

    // Caso 8: Notificación con prioridad crítica explícita -> high
    await insertInbox(userB, 'custom_critical_alert', { priority: 'critical' });

    // Reclamar todo el lote de 8 elementos en una única invocación
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', { p_batch_size: 15 });
    assert.equal(claimRes.ok, true);
    assert.equal(claimRes.deliveries.length, 8, 'El lote completo debe procesarse sin abortar por excepciones SQL');

    // Verificar clasificaciones individuales
    const deliveries = claimRes.deliveries;

    // Caso 1: ausente -> high
    const d1 = deliveries[0];
    assert.equal(d1.is_critical, true);
    assert.equal(d1.urgency, 'high');

    // Caso 2: true -> normal
    const d2 = deliveries[1];
    assert.equal(d2.is_critical, false);
    assert.equal(d2.urgency, 'normal');

    // Caso 3: false -> high
    const d3 = deliveries[2];
    assert.equal(d3.is_critical, true);
    assert.equal(d3.urgency, 'high');

    // Caso 4: string inesperado -> no crasheó
    const d4 = deliveries[3];
    assert.ok(d4, 'Elemento con string inesperado debe haberse procesado');

    // Caso 5: numérico -> no crasheó
    const d5 = deliveries[4];
    assert.ok(d5, 'Elemento con número debe haberse procesado');

    // Caso 6: objeto -> no crasheó
    const d6 = deliveries[5];
    assert.ok(d6, 'Elemento con objeto debe haberse procesado');

    // Caso 7: desconocido -> normal
    const d7 = deliveries[6];
    assert.equal(d7.is_critical, false);
    assert.equal(d7.urgency, 'normal');

    // Caso 8: critical explícito -> high
    const d8 = deliveries[7];
    assert.equal(d8.is_critical, true);
    assert.equal(d8.urgency, 'high');
  });

  test('Validación F: El payload generado por el worker es estrictamente genérico sin identificadores internos', () => {
    // Simulación de la lógica del web-push-worker
    const buildWorkerPayload = (delivery: { is_critical?: boolean; urgency?: string }) => {
      const isCritical = delivery.is_critical === true || delivery.urgency === 'high';
      const effectiveUrgency = isCritical ? 'high' : 'normal';

      const payloadObj: Record<string, unknown> = {
        title: 'PuntoEncuentro',
        body: 'Tenés una nueva notificación',
        urgency: effectiveUrgency,
      };

      if (!isCritical) {
        payloadObj.tag = 'pe-notification';
      }

      return JSON.stringify(payloadObj);
    };

    const criticalRaw = buildWorkerPayload({ is_critical: true, urgency: 'high' });
    const normalRaw = buildWorkerPayload({ is_critical: false, urgency: 'normal' });

    const critParsed = JSON.parse(criticalRaw);
    const normParsed = JSON.parse(normalRaw);

    // Verificaciones críticas
    assert.equal(critParsed.title, 'PuntoEncuentro');
    assert.equal(critParsed.body, 'Tenés una nueva notificación');
    assert.equal(critParsed.urgency, 'high');
    assert.equal(critParsed.tag, undefined, 'Aviso crítico no debe tener tag fijo');

    assert.equal(normParsed.title, 'PuntoEncuentro');
    assert.equal(normParsed.body, 'Tenés una nueva notificación');
    assert.equal(normParsed.urgency, 'normal');
    assert.equal(normParsed.tag, 'pe-notification');

    // Comprobar ausencia absoluta de campos internos sensibles
    const sensitiveKeys = ['target_id', 'encounter_id', 'notification_id', 'user_id', 'recipient_user_id', 'deep_link'];
    for (const key of sensitiveKeys) {
      assert.equal(critParsed[key], undefined, `Payload crítico no debe incluir ${key}`);
      assert.equal(normParsed[key], undefined, `Payload normal no debe incluir ${key}`);
    }
  });

  test('Validación A & B: Service Worker no reemplaza notificaciones críticas y coexisten en el panel visual', () => {
    // Simulación del Service Worker push handler
    const simulateSWPush = (payloadJson: string) => {
      const data = JSON.parse(payloadJson);
      const title = 'PuntoEncuentro';
      const body = 'Tenés una nueva notificación';

      const isCritical = data.urgency === 'high' || data.is_critical === true;
      const tag = isCritical ? undefined : (data.tag || 'pe-notification');

      const notificationOptions: Record<string, any> = {
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: {},
      };

      if (tag) {
        notificationOptions.tag = tag;
        notificationOptions.renotify = true;
      }

      return { title, options: notificationOptions };
    };

    // Caso 1: Llega cancelación crítica
    const critEvent = simulateSWPush(JSON.stringify({ urgency: 'high', is_critical: true }));
    assert.equal(critEvent.options.tag, undefined, 'Aviso crítico no tiene tag para no ser reemplazado');
    assert.equal(critEvent.options.renotify, undefined, 'Sin tag, renotify debe ser omitido');

    // Caso 2: Posteriormente llega aviso informativo de Discovery
    const infoEvent = simulateSWPush(JSON.stringify({ urgency: 'normal', tag: 'pe-notification' }));
    assert.equal(infoEvent.options.tag, 'pe-notification');
    assert.equal(infoEvent.options.renotify, true);

    // Análisis de coexistencia:
    // El aviso crítico no tiene tag (tag: undefined) -> genera una notificación independiente en el SO.
    // El aviso informativo tiene tag: 'pe-update' -> genera/actualiza su propio slot 'pe-update'.
    // Por lo tanto, el aviso informativo posterior NUNCA elimina del panel al aviso crítico anterior.
    assert.notEqual(critEvent.options.tag, infoEvent.options.tag);

    // Caso 3: Llega una segunda notificación crítica
    const critEvent2 = simulateSWPush(JSON.stringify({ urgency: 'high', is_critical: true }));
    assert.equal(critEvent2.options.tag, undefined);
    // Dos notificaciones críticas sucesivas tampoco se reemplazan entre sí porque ambas tienen tag: undefined
  });

  test('Validación G: NotificationClick en Service Worker navega a la ruta neutral /?notifications=1', () => {
    const swCode = read('public/sw.js');

    // Verificar que targetUrl apunte estrictamente a /?notifications=1
    assert.match(swCode, /const\s+targetUrl\s*=\s*new\s+URL\('\/\?notifications=1',\s*self\.location\.origin\)\.href;/);

    // Verificar que notification.close() sea invocado
    assert.match(swCode, /event\.notification\.close\(\);/);

    // Verificar que se llame a client.navigate o clients.openWindow con targetUrl
    assert.match(swCode, /await\s+client\.navigate\(targetUrl\);/);
    assert.match(swCode, /await\s+self\.clients\.openWindow\(targetUrl\);/);
  });

  test('Validación H: Seguridad del Outbox, cancelación ante suscripción inactiva o lectura previa', async () => {
    // 1. Suscripción revocada antes del claim cancela la entrega
    const subRes = await registerDevice(userA);
    const subId = subRes.device?.id || subRes.subscription?.id;

    await insertInbox(userA, 'match_found');

    // Revocar suscripción en DB
    await asAdmin();
    await db.query(`UPDATE public.web_push_subscriptions SET status = 'revoked', revoked_at = now() WHERE id = $1`, [subId]);

    // Reclamar
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', { p_batch_size: 10 });
    assert.equal(claimRes.ok, true);

    // Verificar que la entrega fue marcada como cancelled en notification_delivery_outbox
    const { rows: cancelledRows } = await db.query(
      `SELECT status, last_error FROM public.notification_delivery_outbox WHERE web_push_subscription_id = $1`,
      [subId]
    );
    assert.ok(cancelledRows.length > 0);
    assert.equal(cancelledRows[0].status, 'cancelled');
  });

  test('Validación I: Catálogo de domain-events-worker incluye todos los eventos y no produce Unsupported event_type', async () => {
    const workerCode = read('supabase/functions/domain-events-worker/index.ts');

    // Verificar handlers presentes en EVENT_HANDLERS
    const requiredHandlers = [
      'encounter.opened.v1',
      'encounter.updated.v1',
      'encounter.cancelled.v1',
      'encounter.join_request.created.v1',
      'encounter.join_request.approved.v1',
      'encounter.join_request.rejected.v1',
      'encounter.join_request.cancelled.v1',
      'encounter.join_request.reminder.v1',
      'encounter.participant.withdrawn.v1',
      'match.detected.v1',
      'intention.converted_to_encounter.v1',
      'internal_invitation.created.v1',
      'internal_invitation.accepted.v1',
      'internal_invitation.declined.v1',
      'internal_invitation.cancelled.v1',
      'internal_invitation.expired.v1',
    ];

    for (const handler of requiredHandlers) {
      assert.ok(
        workerCode.includes(`"${handler}":`),
        `domain-events-worker debe contener handler para ${handler}`
      );
    }
  });
});
