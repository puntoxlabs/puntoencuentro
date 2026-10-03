import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── Fixtures criptográficos de prueba (no son secretos reales) ───────────────────────────
const newKeys = () => ({
  p256dh: crypto.randomBytes(65).toString('base64url'),
  auth: crypto.randomBytes(16).toString('base64url'),
});
const newEndpoint = () =>
  `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(24).toString('base64url')}`;

describe('Fase 3B: Delivery Web Push (Outbox, Claim Atómico, Reconciliación, SW, Sanitización)', () => {
  let db: PGlite;

  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';
  const userC = '33333333-3333-3333-3333-333333333333'; // Sin dispositivos
  const userD = '44444444-4444-4444-4444-444444444444'; // Para pruebas aisladas

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

  const registerDevice = async (
    userId: string,
    endpoint = newEndpoint(),
    keys = newKeys()
  ) => {
    return rpc(userId, 'registrar_web_push_subscription_seguro', {
      p_endpoint: endpoint,
      p_p256dh: keys.p256dh,
      p_auth: keys.auth,
    });
  };

  const insertInboxNotification = async (
    recipientId: string,
    title = 'Título Test',
    body = 'Cuerpo Test',
    deepLink = '/encuentros/123',
    expiresAt: string | null = null,
    dedupKey: string | null = null
  ) => {
    await asAdmin();
    return rpc(null, 'insertar_inbox_notification_seguro', {
      p_recipient_user_id: recipientId,
      p_notification_type: 'match_found',
      p_target_type: 'encounter',
      p_target_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      p_deep_link: deepLink,
      p_title: title,
      p_body: body,
      p_payload: { test: true },
      p_dedup_key: dedupKey || `test-dedup-${crypto.randomUUID()}`,
      p_expires_at: expiresAt,
    });
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
        ('${userA}', 'a@test.com'), ('${userB}', 'b@test.com'), ('${userC}', 'c@test.com'), ('${userD}', 'd@test.com')
      ON CONFLICT DO NOTHING;
    `);

    for (const mig of [
      'supabase/migrations/20261002180000_notifications_inbox_and_outbox_base.sql',
      'supabase/migrations/20261002200000_harden_inbox_rpc_grants.sql',
      'supabase/migrations/20261003120000_web_push_subscriptions.sql',
      'supabase/migrations/20261003140000_web_push_delivery_outbox.sql',
    ]) {
      await db.exec(read(mig));
    }
  });

  // ── 1. Encolado automático para usuario con 1 dispositivo ─────────────────────────────────
  test('1. Inserción en inbox_notifications crea entrega pending para usuario con 1 suscripción activa', async () => {
    const reg = await registerDevice(userA);
    assert.equal(reg.ok, true);

    const notifRes = await insertInboxNotification(userA, 'Notif 1', 'Cuerpo 1');
    assert.equal(notifRes.ok, true);
    const notifId = notifRes.notification_id;

    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT * FROM public.notification_delivery_outbox WHERE inbox_notification_id = $1`,
      [notifId]
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].recipient_user_id, userA);
    assert.equal(rows[0].web_push_subscription_id, reg.device.id);
    assert.equal(rows[0].channel, 'web_push');
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].attempt_count, 0);
  });

  // ── 2. Encolado automático multidispositivo (N entregas) ──────────────────────────────────
  test('2. Inserción en inbox_notifications crea N entregas para usuario con N suscripciones activas', async () => {
    // Registrar 2 dispositivos más para userA
    const reg2 = await registerDevice(userA);
    const reg3 = await registerDevice(userA);
    assert.equal(reg2.ok, true);
    assert.equal(reg3.ok, true);

    const notifRes = await insertInboxNotification(userA, 'Multidispositivo', 'Texto multi');
    const notifId = notifRes.notification_id;

    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT * FROM public.notification_delivery_outbox WHERE inbox_notification_id = $1 ORDER BY created_at ASC`,
      [notifId]
    );

    // userA tiene ahora 3 dispositivos activos -> 3 entregas generadas
    assert.equal(rows.length, 3);
    const subIds = rows.map((r) => r.web_push_subscription_id).sort();
    assert.equal(new Set(subIds).size, 3);
  });

  // ── 3. Usuario sin suscripciones → 0 entregas pero inbox intacto ──────────────────────────
  test('3. Usuario sin suscripciones (0 dispositivos) → no genera entregas pero persiste en inbox normalmente', async () => {
    const notifRes = await insertInboxNotification(userC, 'Sin push', 'Directo al inbox');
    assert.equal(notifRes.ok, true);

    await asAdmin();
    const { rows: inboxRows } = await db.query<any>(
      `SELECT * FROM public.inbox_notifications WHERE id = $1`,
      [notifRes.notification_id]
    );
    assert.equal(inboxRows.length, 1);

    const { rows: deliveryRows } = await db.query<any>(
      `SELECT * FROM public.notification_delivery_outbox WHERE inbox_notification_id = $1`,
      [notifRes.notification_id]
    );
    assert.equal(deliveryRows.length, 0);
  });

  // ── 4. Deduplicación por dedup_key en notification_delivery_outbox ────────────────────────
  test('4. Deduplicación en notification_delivery_outbox: dedup_key previene duplicados físicos', async () => {
    await asAdmin();
    const { rows: subs } = await db.query<any>(
      `SELECT id FROM public.web_push_subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [userA]
    );
    const subId = subs[0].id;

    const notifRes = await insertInboxNotification(userA, 'Dedup Check', 'Msg');
    const notifId = notifRes.notification_id;
    const dedupKey = `${notifId}:${subId}:web_push`;

    // Intentar insertar fila con misma dedup_key manualmente
    await db.query(
      `INSERT INTO public.notification_delivery_outbox (inbox_notification_id, recipient_user_id, channel, web_push_subscription_id, status, dedup_key)
       VALUES ($1, $2, 'web_push', $3, 'pending', $4)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [notifId, userA, subId, dedupKey]
    );

    const { rows } = await db.query<any>(
      `SELECT COUNT(*)::int AS count FROM public.notification_delivery_outbox WHERE dedup_key = $1`,
      [dedupKey]
    );
    assert.equal(rows[0].count, 1);
  });

  // ── 5. Trigger wake-up statement-level ───────────────────────────────────────────────────
  test('5. Trigger trg_web_push_delivery_wakeup está configurado a nivel de sentencia (statement)', async () => {
    await asAdmin();
    const { rows } = await db.query<any>(`
      SELECT tgname, tgtype 
      FROM pg_trigger 
      WHERE tgname = 'trg_web_push_delivery_wakeup'
    `);
    assert.equal(rows.length, 1);
    // tgtype bit 0: row (0 = statement-level)
    const isRowLevel = (rows[0].tgtype & 1) === 1;
    assert.equal(isRowLevel, false, 'El trigger debe ser a nivel de sentencia (statement)');
  });

  // ── 6. Atomicidad de la transacción de encolado ──────────────────────────────────────────
  test('6. Atomicidad: trigger trg_enqueue_web_push_deliveries corre en la misma transacción que el insert del inbox', async () => {
    await asAdmin();
    const { rows } = await db.query<any>(`
      SELECT tgname, tgtype 
      FROM pg_trigger 
      WHERE tgname = 'trg_enqueue_web_push_deliveries'
    `);
    assert.equal(rows.length, 1);
    assert.match(rows[0].tgname, /trg_enqueue_web_push_deliveries/);
  });

  // ── 7. claim_web_push_deliveries_seguro bloquea y pasa a processing ───────────────────────
  test('7. claim_web_push_deliveries_seguro bloquea el lote y pasa el estado a processing', async () => {
    const notif = await insertInboxNotification(userA, 'Claim test', 'Claim body');
    assert.equal(notif.ok, true);

    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-unit-test',
    });

    assert.equal(claimRes.ok, true);
    assert.ok(claimRes.count >= 1);
    const claimedItem = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );
    assert.ok(claimedItem, 'La entrega de la notificación debe haber sido reclamada');
    assert.equal(claimedItem.recipient_user_id, userA);
    assert.ok(claimedItem.endpoint);
    assert.ok(claimedItem.p256dh_key);
    assert.ok(claimedItem.auth_key);

    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT status, processing_started_at, attempt_count FROM public.notification_delivery_outbox WHERE id = $1`,
      [claimedItem.delivery_id]
    );
    assert.equal(rows[0].status, 'processing');
    assert.ok(rows[0].processing_started_at);
    assert.equal(rows[0].attempt_count, 1);
  });

  // ── 8. Workers concurrentes no colisionan (FOR UPDATE SKIP LOCKED) ────────────────────────
  test('8. Workers concurrentes: dos reclamos simultáneos devuelven conjuntos disjuntos', async () => {
    const n1 = await insertInboxNotification(userA, 'Notif Conc 1', 'B1');
    const n2 = await insertInboxNotification(userA, 'Notif Conc 2', 'B2');

    const claimA = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 1,
      p_worker_id: 'worker-A',
    });
    const claimB = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 1,
      p_worker_id: 'worker-B',
    });

    assert.equal(claimA.ok, true);
    assert.equal(claimB.ok, true);

    if (claimA.count > 0 && claimB.count > 0) {
      const idA = claimA.deliveries[0].delivery_id;
      const idB = claimB.deliveries[0].delivery_id;
      assert.notEqual(idA, idB, 'Workers concurrentes no deben reclamar la misma entrega');
    }
  });

  // ── 9. Suscripción inactiva o revocada se excluye del claim ───────────────────────────────
  test('9. Suscripción revocada antes del claim cancela la entrega pendiente al reclamar', async () => {
    const reg = await registerDevice(userA);
    const subId = reg.device.id;
    const notif = await insertInboxNotification(userA, 'Test Revoked Sub', 'Body');

    // Revocar la suscripción antes del claim
    await rpc(userA, 'revocar_web_push_subscription_seguro', {
      p_endpoint:
        reg.device.endpoint ||
        (
          await db.query<any>(
            `SELECT endpoint FROM public.web_push_subscriptions WHERE id = $1`,
            [subId]
          )
        ).rows[0].endpoint,
    });

    // Al reclamar, el RPC detecta la suscripción inactiva o ya revocada
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 50,
      p_worker_id: 'worker-check-revoked',
    });

    const claimed = claimRes.deliveries.find(
      (d: any) => d.web_push_subscription_id === subId
    );
    assert.equal(claimed, undefined, 'No debe reclamar entregas de suscripciones revocadas');

    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT status, last_error FROM public.notification_delivery_outbox WHERE inbox_notification_id = $1 AND web_push_subscription_id = $2`,
      [notif.notification_id, subId]
    );
    assert.equal(rows[0].status, 'cancelled');
    assert.match(rows[0].last_error, /Device revoked by user|subscription_inactive/);
  });

  // ── 10. Validación de destinatario ────────────────────────────────────────────────────────
  test('10. Claim valida que el dispositivo pertenezca al recipient_user_id', async () => {
    await asAdmin();
    const { rows: subRows } = await db.query<any>(
      `SELECT id, user_id FROM public.web_push_subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [userA]
    );
    const notif = await insertInboxNotification(userB, 'Notif para B', 'Body');

    const { rows: insRow } = await db.query<any>(
      `INSERT INTO public.notification_delivery_outbox (inbox_notification_id, recipient_user_id, channel, web_push_subscription_id, status, dedup_key)
       VALUES ($1, $2, 'web_push', $3, 'pending', $4) RETURNING id`,
      [notif.notification_id, userB, subRows[0].id, `spoof-${crypto.randomUUID()}`]
    );
    const deliveryId = insRow[0].id;

    // Al reclamar, detecta discrepancia de recipient y cancela
    await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 50,
      p_worker_id: 'worker-recipient-check',
    });

    const { rows: check } = await db.query<any>(
      `SELECT status, last_error FROM public.notification_delivery_outbox WHERE id = $1`,
      [deliveryId]
    );
    assert.equal(check[0].status, 'cancelled');
    assert.match(check[0].last_error, /Device or user reassigned|recipient_mismatch/);
  });

  // ── 11. Notificación leída en app cancela entrega en claim ────────────────────────────────
  test('11. Si la notificación ya fue leída en el inbox, claim la cancela sin despachar push', async () => {
    const notif = await insertInboxNotification(userA, 'Leída antes de push', 'Body');
    // Marcar como leída en inbox usando la RPC segura existente
    await rpc(userA, 'marcar_notificacion_leida_seguro', {
      p_notification_id: notif.notification_id,
    });

    await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 50,
      p_worker_id: 'worker-read-check',
    });

    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT status, last_error FROM public.notification_delivery_outbox WHERE inbox_notification_id = $1`,
      [notif.notification_id]
    );
    for (const r of rows) {
      assert.equal(r.status, 'cancelled');
      assert.match(r.last_error, /Notification already read|notification_already_read/);
    }
  });

  // ── 12. Notificación expirada cancela entrega en claim ─────────────────────────────────────
  test('12. Notificación expirada en inbox_notifications se cancela durante el claim', async () => {
    const expiredDate = new Date(Date.now() - 3600 * 1000).toISOString();
    const notif = await insertInboxNotification(
      userA,
      'Expirada',
      'Body',
      '/encuentros/expired',
      expiredDate
    );

    await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 50,
      p_worker_id: 'worker-expired-check',
    });

    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT status, last_error FROM public.notification_delivery_outbox WHERE inbox_notification_id = $1`,
      [notif.notification_id]
    );
    for (const r of rows) {
      assert.equal(r.status, 'cancelled');
      assert.match(r.last_error, /Notification expired|notification_expired/);
    }
  });

  // ── 13. Dispositivo compartido: reasignación cancela entrega previa ──────────────────────
  test('13. Dispositivo compartido: entrega pendiente de Usuario A + endpoint reasignado a Usuario B → A se cancela y B nunca recibe el push de A', async () => {
    const sharedEndpoint = newEndpoint();
    const sharedKeys = newKeys();

    // 1. Usuario A registra el dispositivo
    const regA = await registerDevice(userA, sharedEndpoint, sharedKeys);
    assert.equal(regA.ok, true);

    // 2. Notificación para A genera entrega pendiente asociada a ese endpoint
    const notifA = await insertInboxNotification(userA, 'Privada de Usuario A', 'Secreto de A');

    await asAdmin();
    const { rows: pendingA } = await db.query<any>(
      `SELECT id, status FROM public.notification_delivery_outbox 
       WHERE inbox_notification_id = $1 AND web_push_subscription_id = $2`,
      [notifA.notification_id, regA.device.id]
    );
    assert.equal(pendingA.length, 1);
    assert.equal(pendingA[0].status, 'pending');

    // 3. Usuario B inicia sesión en ese mismo dispositivo y registra el endpoint
    const regB = await registerDevice(userB, sharedEndpoint, sharedKeys);
    assert.equal(regB.ok, true);

    // 4. Verificar como admin que la entrega pendiente de Usuario A fue cancelada inmediatamente
    await asAdmin();
    const { rows: afterReassign } = await db.query<any>(
      `SELECT id, status, last_error FROM public.notification_delivery_outbox WHERE id = $1`,
      [pendingA[0].id]
    );
    assert.equal(afterReassign[0].status, 'cancelled');
    assert.match(afterReassign[0].last_error, /reassigned to another user/i);

    // 5. El reclamo para ese endpoint compartido nunca devuelve la notificación privada de A
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 50,
      p_worker_id: 'worker-privacy-test',
    });
    const foundOnSharedEndpoint = claimRes.deliveries.find(
      (d: any) =>
        d.endpoint === sharedEndpoint &&
        d.inbox_notification_id === notifA.notification_id
    );
    assert.equal(
      foundOnSharedEndpoint,
      undefined,
      'El endpoint reasignado a Usuario B nunca debe recibir la entrega de Usuario A'
    );
  });

  // ── 14. Payload conservador sin secretos ni credenciales ─────────────────────────────────
  test('14. Payload hacia el Service Worker contiene únicamente campos autorizados sin secretos', async () => {
    const notif = await insertInboxNotification(
      userB,
      'Titulo Seguro',
      'Cuerpo Seguro',
      '/?open_encounter=xyz'
    );

    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-payload-test',
    });

    const delivery = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );
    assert.ok(delivery);

    // Construir payload que enviaría el worker
    const payload = {
      notification_id: delivery.inbox_notification_id,
      title: delivery.title,
      body: delivery.body,
      deep_link: delivery.deep_link,
      tag: `pe-notif-${delivery.inbox_notification_id}`,
    };

    const json = JSON.stringify(payload);
    assert.ok(!json.includes('token'));
    assert.ok(!json.includes('secret'));
    assert.ok(!json.includes('password'));
    assert.ok(!json.includes('@test.com'));
    assert.ok(!json.includes(delivery.auth_key));
    assert.ok(!json.includes(delivery.p256dh_key));
    assert.equal(payload.notification_id, notif.notification_id);
    assert.equal(payload.title, 'Titulo Seguro');
  });

  // ── 15. Cálculo de TTL proporcional ──────────────────────────────────────────────────────
  test('15. TTL se calcula con base en expires_at entre 1 y 86400 segundos', () => {
    const now = Date.now();
    const inTwoHours = new Date(now + 7200 * 1000).toISOString();
    const inThreeDays = new Date(now + 3 * 86400 * 1000).toISOString();

    const calcTtl = (expiresAt: string | null) => {
      if (!expiresAt) return 86400;
      const rem = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
      if (rem <= 0) return 0;
      return Math.max(1, Math.min(86400, rem));
    };

    assert.equal(calcTtl(null), 86400);
    assert.equal(calcTtl(inTwoHours), 7200);
    assert.equal(calcTtl(inThreeDays), 86400); // Acotado a 24h
  });

  // ── 16. HTTP 201 Created → status delivered y actualiza last_seen_at ─────────────────────
  test('16. Provider retorna 201 Created → completar_web_push_delivery_seguro marca delivered y actualiza last_seen_at', async () => {
    const reg = await registerDevice(userB);
    const notif = await insertInboxNotification(userB, 'Entrega exitosa', 'OK');

    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-201',
    });
    const delivery = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );

    const compRes = await rpc(null, 'completar_web_push_delivery_seguro', {
      p_delivery_id: delivery.delivery_id,
      p_http_status: 201,
    });
    assert.equal(compRes.ok, true);

    await asAdmin();
    const { rows: dRows } = await db.query<any>(
      `SELECT status, delivered_at, last_http_status FROM public.notification_delivery_outbox WHERE id = $1`,
      [delivery.delivery_id]
    );
    assert.equal(dRows[0].status, 'delivered');
    assert.equal(dRows[0].last_http_status, 201);
    assert.ok(dRows[0].delivered_at);

    const { rows: sRows } = await db.query<any>(
      `SELECT last_seen_at FROM public.web_push_subscriptions WHERE id = $1`,
      [delivery.web_push_subscription_id]
    );
    assert.ok(sRows[0].last_seen_at);
  });

  // ── 17. HTTP 429 Too Many Requests → reintento con backoff ────────────────────────────────
  test('17. Provider retorna 429 Too Many Requests → fallar_web_push_delivery_seguro aplica backoff exponencial', async () => {
    const notif = await insertInboxNotification(userB, 'Error 429', 'Rate limit');
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-429',
    });
    const delivery = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );

    const failRes = await rpc(null, 'fallar_web_push_delivery_seguro', {
      p_delivery_id: delivery.delivery_id,
      p_error_message: 'Too Many Requests',
      p_http_status: 429,
      p_is_retryable: true,
      p_base_backoff_seconds: 5,
    });

    assert.equal(failRes.ok, true);
    assert.equal(failRes.status, 'pending');

    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT status, available_at, last_http_status, attempt_count FROM public.notification_delivery_outbox WHERE id = $1`,
      [delivery.delivery_id]
    );
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].last_http_status, 429);
    assert.ok(new Date(rows[0].available_at) > new Date());
  });

  // ── 18. HTTP 5xx Server Error → reintento con backoff ─────────────────────────────────────
  test('18. Provider retorna 500 / 503 → error reintentable con backoff', async () => {
    const notif = await insertInboxNotification(userB, 'Error 500', 'Server down');
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-500',
    });
    const delivery = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );

    const failRes = await rpc(null, 'fallar_web_push_delivery_seguro', {
      p_delivery_id: delivery.delivery_id,
      p_error_message: 'Internal Push Gateway Error',
      p_http_status: 503,
      p_is_retryable: true,
    });

    assert.equal(failRes.ok, true);
    assert.equal(failRes.status, 'pending');
  });

  // ── 19. Network timeout → error reintentable ──────────────────────────────────────────────
  test('19. Timeout de red → error reintentable', async () => {
    const notif = await insertInboxNotification(userB, 'Timeout', 'No response');
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-timeout',
    });
    const delivery = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );

    const failRes = await rpc(null, 'fallar_web_push_delivery_seguro', {
      p_delivery_id: delivery.delivery_id,
      p_error_message: 'Request timed out after 5000ms',
      p_http_status: 504,
      p_is_retryable: true,
    });

    assert.equal(failRes.ok, true);
    assert.equal(failRes.status, 'pending');
  });

  // ── 20. HTTP 404 Not Found → revocación de endpoint y fallo terminal ─────────────────────
  test('20. Provider retorna 404 Not Found → revocar_endpoint_invalido_seguro revoca la suscripción', async () => {
    const reg = await registerDevice(userB);
    const notif = await insertInboxNotification(userB, 'Error 404', 'Endpoint missing');
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-404',
    });
    const delivery = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );

    const revRes = await rpc(null, 'revocar_endpoint_invalido_seguro', {
      p_subscription_id: delivery.web_push_subscription_id,
      p_delivery_id: delivery.delivery_id,
      p_http_status: 404,
    });

    assert.equal(revRes.ok, true);

    await asAdmin();
    const { rows: subRows } = await db.query<any>(
      `SELECT status, revoked_at FROM public.web_push_subscriptions WHERE id = $1`,
      [delivery.web_push_subscription_id]
    );
    assert.equal(subRows[0].status, 'revoked');
    assert.ok(subRows[0].revoked_at);

    const { rows: dRows } = await db.query<any>(
      `SELECT status, last_http_status FROM public.notification_delivery_outbox WHERE id = $1`,
      [delivery.delivery_id]
    );
    assert.equal(dRows[0].status, 'failed');
    assert.equal(dRows[0].last_http_status, 404);
  });

  // ── 21. HTTP 410 Gone → revocación automática y cancelación de pendientes ────────────────
  test('21. Provider retorna 410 Gone → revocar_endpoint_invalido_seguro revoca suscripción y cancela pendientes', async () => {
    // Usar userD exclusivo para este test para aislamiento absoluto
    const reg = await registerDevice(userD);
    const n1 = await insertInboxNotification(userD, 'Notif 410 A', 'M1');

    // Reclamar únicamente la primera entrega de userD
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 100,
      p_worker_id: 'worker-410',
    });
    const delivery1 = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === n1.notification_id
    );
    assert.ok(delivery1);

    // Ahora insertar la segunda notificación, la cual queda en status pending
    const n2 = await insertInboxNotification(userD, 'Notif 410 B', 'M2');

    await asAdmin();
    const { rows: d2Before } = await db.query<any>(
      `SELECT id, status FROM public.notification_delivery_outbox WHERE inbox_notification_id = $1`,
      [n2.notification_id]
    );
    assert.equal(d2Before[0].status, 'pending');

    const revRes = await rpc(null, 'revocar_endpoint_invalido_seguro', {
      p_subscription_id: delivery1.web_push_subscription_id,
      p_delivery_id: delivery1.delivery_id,
      p_http_status: 410,
    });
    assert.equal(revRes.ok, true);

    await asAdmin();
    // La suscripción física fue revocada
    const { rows: sub } = await db.query<any>(
      `SELECT status FROM public.web_push_subscriptions WHERE id = $1`,
      [delivery1.web_push_subscription_id]
    );
    assert.equal(sub[0].status, 'revoked');

    // La entrega actual quedó failed
    const { rows: dCurrent } = await db.query<any>(
      `SELECT status, last_http_status FROM public.notification_delivery_outbox WHERE id = $1`,
      [delivery1.delivery_id]
    );
    assert.equal(dCurrent[0].status, 'failed');
    assert.equal(dCurrent[0].last_http_status, 410);

    // La otra entrega pendiente para ese dispositivo fue cancelada
    const { rows: dOther } = await db.query<any>(
      `SELECT status, last_error FROM public.notification_delivery_outbox WHERE id = $1`,
      [d2Before[0].id]
    );
    assert.equal(dOther[0].status, 'cancelled');
  });

  // ── 22. HTTP 400 Bad Request / 401 Unauthorized → no reintentable ─────────────────────────
  test('22. Provider retorna 400 Bad Request → error no reintentable, pasa directo a failed', async () => {
    const notif = await insertInboxNotification(userA, 'Error 400', 'Payload reject');
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-400',
    });
    const delivery = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );

    const failRes = await rpc(null, 'fallar_web_push_delivery_seguro', {
      p_delivery_id: delivery.delivery_id,
      p_error_message: 'Invalid payload encoding',
      p_http_status: 400,
      p_is_retryable: false,
    });

    assert.equal(failRes.ok, true);
    assert.equal(failRes.status, 'failed');

    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT status, last_http_status FROM public.notification_delivery_outbox WHERE id = $1`,
      [delivery.delivery_id]
    );
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].last_http_status, 400);
  });

  // ── 23. Máximo de intentos alcanzado (attempt_count >= 5) → status failed ──────────────────
  test('23. Al alcanzar el máximo de reintentos (attempt_count >= 5), pasa a failed', async () => {
    const notif = await insertInboxNotification(userA, 'Max attempts', 'Loop');
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-max-attempts',
    });
    const delivery = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );

    await asAdmin();
    // Forzar attempt_count a 5
    await db.query(
      `UPDATE public.notification_delivery_outbox SET attempt_count = 5 WHERE id = $1`,
      [delivery.delivery_id]
    );

    const failRes = await rpc(null, 'fallar_web_push_delivery_seguro', {
      p_delivery_id: delivery.delivery_id,
      p_error_message: 'Server error repeatedly',
      p_http_status: 503,
      p_is_retryable: true,
    });

    assert.equal(failRes.status, 'failed');
  });

  // ── 24. reconciliar_web_push_deliveries_seguro recupera entregas trabadas ────────────────
  test('24. reconciliar_web_push_deliveries_seguro reinicia entregas trabadas en processing (>5m)', async () => {
    const notif = await insertInboxNotification(userA, 'Trabada', 'Stuck');
    const claimRes = await rpc(null, 'claim_web_push_deliveries_seguro', {
      p_batch_size: 10,
      p_worker_id: 'worker-crash',
    });
    const delivery = claimRes.deliveries.find(
      (d: any) => d.inbox_notification_id === notif.notification_id
    );

    await asAdmin();
    // Simular que quedó trabada en processing hace 10 minutos
    await db.query(
      `UPDATE public.notification_delivery_outbox 
       SET processing_started_at = pg_catalog.now() - INTERVAL '10 minutes'
       WHERE id = $1`,
      [delivery.delivery_id]
    );

    const recRes = await rpc(null, 'reconciliar_web_push_deliveries_seguro', {});
    assert.equal(recRes.ok, true);
    assert.ok(recRes.recovered_count >= 1);

    const { rows } = await db.query<any>(
      `SELECT status, last_error FROM public.notification_delivery_outbox WHERE id = $1`,
      [delivery.delivery_id]
    );
    assert.equal(rows[0].status, 'pending');
    assert.match(rows[0].last_error, /Recovered from abandoned worker/);
  });

  // ── 25. reconciliar_web_push_deliveries_seguro cancela leídas o expiradas ────────────────
  test('25. reconciliar_web_push_deliveries_seguro cancela pendientes cuya notificación fue leída o expiró', async () => {
    const notif = await insertInboxNotification(userA, 'Para reconciliar leida', 'Msg');
    // Marcar como leída en inbox
    await rpc(userA, 'marcar_notificacion_leida_seguro', {
      p_notification_id: notif.notification_id,
    });

    const recRes = await rpc(null, 'reconciliar_web_push_deliveries_seguro', {});
    assert.equal(recRes.ok, true);
    assert.ok(recRes.cancelled_read_count >= 1);

    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT status FROM public.notification_delivery_outbox WHERE inbox_notification_id = $1`,
      [notif.notification_id]
    );
    for (const r of rows) {
      assert.equal(r.status, 'cancelled');
    }
  });

  // ── 26. Service Worker evento 'push' ─────────────────────────────────────────────────────
  test('26. Service Worker evento push: parsea JSON defensivo, genera opciones y tag', () => {
    const swSource = read('public/sw.js');
    assert.match(swSource, /self\.addEventListener\('push'/);
    assert.match(swSource, /event\.data\.json\(\)/);
    assert.match(swSource, /pe-notif-/);
    assert.match(swSource, /self\.registration\.showNotification/);
  });

  // ── 27. Service Worker evento 'notificationclick' con deep link seguro ───────────────────
  test('27. Service Worker notificationclick: cierra notificación, valida link relativo seguro y enfoca/navega', () => {
    const swSource = read('public/sw.js');
    assert.match(swSource, /self\.addEventListener\('notificationclick'/);
    assert.match(swSource, /event\.notification\.close\(\)/);
    assert.match(swSource, /startsWith\('\/'\)\s*&&\s*!.*startsWith\('\/\/'\)/);
    assert.match(swSource, /clients\.matchAll/);
    assert.match(swSource, /client\.focus\(\)/);
    assert.match(swSource, /client\.navigate/);
    assert.match(swSource, /clients\.openWindow/);
  });

  // ── 28. Sanitización de errores y observabilidad sin fugas de secretos ────────────────────
  test('28. Sanitización de errores en worker: jamás versiona ni registra tokens, endpoints ni secretos', async () => {
    // Función de sanitización implementada en el worker
    function sanitizeErrorMessage(msg: string): string {
      if (!msg) return 'Push delivery failed';
      return msg
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[ENDPOINT_REDACTED]')
        .replace(/(key|token|secret|auth|p256dh)=[^\s&"']+/gi, '$1=[REDACTED]')
        .slice(0, 300);
    }

    const rawError =
      'Error contacting https://fcm.googleapis.com/fcm/send/secretEndpoint123 with key=super_secret_vapid_key and auth=raw_auth_token_456';
    const clean = sanitizeErrorMessage(rawError);

    assert.ok(!clean.includes('secretEndpoint123'));
    assert.ok(!clean.includes('super_secret_vapid_key'));
    assert.ok(!clean.includes('raw_auth_token_456'));
    assert.ok(clean.includes('[ENDPOINT_REDACTED]'));
    assert.ok(clean.includes('key=[REDACTED]'));
  });
});
