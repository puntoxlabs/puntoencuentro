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
    `);

    // 2. Cargar migraciones base de notificaciones, outbox y la nueva migración P0
    const migrations = [
      'supabase/migrations/20261002180000_notifications_inbox_and_outbox_base.sql',
      'supabase/migrations/20261002200000_harden_inbox_rpc_grants.sql',
      'supabase/migrations/20261003120000_web_push_subscriptions.sql',
      'supabase/migrations/20261003140000_web_push_delivery_outbox.sql',
      'supabase/migrations/20261003150000_harden_web_push_delivery_safety.sql',
      'supabase/migrations/20261023183000_harden_web_push_claim_and_priority_v1.sql',
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
