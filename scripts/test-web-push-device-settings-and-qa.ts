import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createWebPushService, type WebPushDeps, type WebPushEnv } from '../src/services/webPushService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Clave VAPID pública de prueba (punto P-256 no comprimido válido de 65 bytes)
const TEST_VAPID_PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-Skv6_yViEuiBIa_Ib9_Skv6_yViEuiBIa_Ib9_Skv6_yViEuiBIa-Ic=';

describe('Web Push Device Settings, Multi-Device Isolation & QA Diagnostic Action', () => {
  let db: PGlite;

  const qaUser = '11111111-1111-1111-1111-111111111111';
  const regularUser = '22222222-2222-2222-2222-222222222222';

  before(async () => {
    db = new PGlite();

    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = pg_catalog.timezone('utc', pg_catalog.now());
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      INSERT INTO auth.users (id, email) VALUES
        ('${qaUser}', 'qa@test.com'),
        ('${regularUser}', 'regular@test.com')
      ON CONFLICT DO NOTHING;

      -- Tabla de autorización QA
      CREATE TABLE IF NOT EXISTS public.qa_authorized_users (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id),
        role TEXT NOT NULL DEFAULT 'qa'
      );

      INSERT INTO public.qa_authorized_users (user_id, role)
      VALUES ('${qaUser}', 'qa')
      ON CONFLICT DO NOTHING;

      CREATE OR REPLACE FUNCTION public.is_qa_authorized() RETURNS BOOLEAN AS $$
      DECLARE
        v_user_id UUID := auth.uid();
      BEGIN
        IF v_user_id IS NULL THEN RETURN false; END IF;
        RETURN EXISTS (SELECT 1 FROM public.qa_authorized_users WHERE user_id = v_user_id AND role IN ('admin', 'qa'));
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      -- Inbox base
      CREATE TABLE IF NOT EXISTS public.inbox_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        notification_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id UUID NOT NULL,
        deep_link TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        read_at TIMESTAMPTZ,
        dedup_key TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
        CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
      );

      CREATE OR REPLACE FUNCTION public.insertar_inbox_notification_seguro(
          p_recipient_user_id UUID,
          p_notification_type TEXT,
          p_target_type TEXT,
          p_target_id UUID,
          p_deep_link TEXT,
          p_title TEXT,
          p_body TEXT,
          p_payload JSONB DEFAULT '{}'::jsonb,
          p_dedup_key TEXT DEFAULT NULL,
          p_expires_at TIMESTAMPTZ DEFAULT NULL
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $$
      DECLARE
          v_dedup TEXT := COALESCE(p_dedup_key, p_notification_type || ':' || p_target_id || ':' || pg_catalog.gen_random_uuid()::text);
          v_expires TIMESTAMPTZ := COALESCE(p_expires_at, timezone('utc', now()) + INTERVAL '14 days');
          v_inserted_id UUID;
      BEGIN
          INSERT INTO public.inbox_notifications (
              recipient_user_id,
              notification_type,
              target_type,
              target_id,
              deep_link,
              title,
              body,
              payload,
              dedup_key,
              expires_at
          ) VALUES (
              p_recipient_user_id,
              p_notification_type,
              p_target_type,
              p_target_id,
              p_deep_link,
              p_title,
              p_body,
              COALESCE(p_payload, '{}'::jsonb),
              v_dedup,
              v_expires
          )
          ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING
          RETURNING id INTO v_inserted_id;

          RETURN pg_catalog.jsonb_build_object(
              'ok', true,
              'inserted', (v_inserted_id IS NOT NULL),
              'notification_id', v_inserted_id
          );
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.verificar_y_consumir_rate_limit(
          p_usuario_id UUID,
          p_accion TEXT,
          p_max_requests INT,
          p_ventana INTERVAL
      )
      RETURNS JSONB AS $$ BEGIN RETURN '{"allowed": true}'::jsonb; END; $$ LANGUAGE plpgsql;
    `);

    // Migraciones de Web Push fundacionales y outbox
    const migFoundation = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261003120000_web_push_subscriptions.sql'), 'utf8');
    await db.exec(migFoundation);

    const migOutbox = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261003140000_web_push_delivery_outbox.sql'), 'utf8');
    await db.exec(migOutbox);

    const migQA = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261014193000_qa_web_push_test_and_diagnostics.sql'), 'utf8');
    await db.exec(migQA);
  });

  const setAuthContext = async (userId: string | null, isAnon: boolean = false) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated", "is_anonymous": ${isAnon}}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    }
  };

  // ── CASOS DE RESOLUCIÓN DE ESTADO DEL DISPOSITIVO ───────────────────────────

  test('Caso A: permission=granted + local subscription + backend active => subscribed ("Activadas en este dispositivo")', async () => {
    const fakeEndpoint = 'https://fcm.googleapis.com/fcm/send/device-a-123';

    // Mock dependencias del servicio
    const env: WebPushEnv = {
      isSecureContext: true,
      hasPushManager: true,
      isStandalone: false,
      isIosLike: false,
      notification: { permission: 'granted', requestPermission: async () => 'granted' },
      serviceWorker: {
        register: async () => ({} as any),
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => ({
              endpoint: fakeEndpoint,
              toJSON: () => ({ endpoint: fakeEndpoint }),
              unsubscribe: async () => true,
            }),
            subscribe: async () => ({} as any),
          },
        }),
        ready: Promise.resolve({} as any),
      },
    };

    const deps: WebPushDeps = {
      getEnv: () => env,
      getVapidPublicKey: () => TEST_VAPID_PUBLIC_KEY,
      rpc: async (name, args) => {
        if (name === 'get_web_push_device_status_seguro') {
          return { data: { ok: true, subscribed: true, active_device_count: 1 }, error: null };
        }
        return { data: null, error: null };
      },
      warn: () => {},
    };

    const service = createWebPushService(deps);
    const state = await service.getDeviceState();
    assert.equal(state.kind, 'subscribed', 'Debe resolver como subscribed');
  });

  test('Caso B1: permission=granted pero sin subscription local => granted_unsubscribed ("Volver a activar")', async () => {
    const env: WebPushEnv = {
      isSecureContext: true,
      hasPushManager: true,
      isStandalone: false,
      isIosLike: false,
      notification: { permission: 'granted', requestPermission: async () => 'granted' },
      serviceWorker: {
        register: async () => ({} as any),
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => null, // Sin suscripción en el navegador
            subscribe: async () => ({} as any),
          },
        }),
        ready: Promise.resolve({} as any),
      },
    };

    const deps: WebPushDeps = {
      getEnv: () => env,
      getVapidPublicKey: () => TEST_VAPID_PUBLIC_KEY,
      rpc: async () => ({ data: null, error: null }),
      warn: () => {},
    };

    const service = createWebPushService(deps);
    const state = await service.getDeviceState();
    assert.equal(state.kind, 'granted_unsubscribed', 'Debe resolver como granted_unsubscribed');
  });

  test('Caso B2: permission=granted + subscription local pero backend revoked => granted_unsubscribed ("Volver a activar")', async () => {
    const fakeEndpoint = 'https://fcm.googleapis.com/fcm/send/device-revoked-456';

    const env: WebPushEnv = {
      isSecureContext: true,
      hasPushManager: true,
      isStandalone: false,
      isIosLike: false,
      notification: { permission: 'granted', requestPermission: async () => 'granted' },
      serviceWorker: {
        register: async () => ({} as any),
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => ({
              endpoint: fakeEndpoint,
              toJSON: () => ({ endpoint: fakeEndpoint }),
              unsubscribe: async () => true,
            }),
            subscribe: async () => ({} as any),
          },
        }),
        ready: Promise.resolve({} as any),
      },
    };

    const deps: WebPushDeps = {
      getEnv: () => env,
      getVapidPublicKey: () => TEST_VAPID_PUBLIC_KEY,
      rpc: async (name) => {
        if (name === 'get_web_push_device_status_seguro') {
          // Backend confirma que está inactiva/revocada
          return { data: { ok: true, subscribed: false, active_device_count: 0 }, error: null };
        }
        return { data: null, error: null };
      },
      warn: () => {},
    };

    const service = createWebPushService(deps);
    const state = await service.getDeviceState();
    assert.equal(state.kind, 'granted_unsubscribed', 'Debe resolver como granted_unsubscribed (NO como subscribed falso)');
  });

  test('Caso C: permission=default => default ("Activar notificaciones / Disponibles para activar")', async () => {
    const env: WebPushEnv = {
      isSecureContext: true,
      hasPushManager: true,
      isStandalone: false,
      isIosLike: false,
      notification: { permission: 'default', requestPermission: async () => 'default' },
      serviceWorker: {
        register: async () => ({} as any),
        getRegistration: async () => null as any,
        ready: Promise.resolve({} as any),
      },
    };

    const deps: WebPushDeps = {
      getEnv: () => env,
      getVapidPublicKey: () => TEST_VAPID_PUBLIC_KEY,
      rpc: async () => ({ data: null, error: null }),
      warn: () => {},
    };

    const service = createWebPushService(deps);
    const state = await service.getDeviceState();
    assert.equal(state.kind, 'default', 'Debe resolver como default');
  });

  test('Caso D: permission=denied => denied ("Bloqueadas sin auto-prompt")', async () => {
    const env: WebPushEnv = {
      isSecureContext: true,
      hasPushManager: true,
      isStandalone: false,
      isIosLike: false,
      notification: { permission: 'denied', requestPermission: async () => 'denied' },
      serviceWorker: {
        register: async () => ({} as any),
        getRegistration: async () => null as any,
        ready: Promise.resolve({} as any),
      },
    };

    const deps: WebPushDeps = {
      getEnv: () => env,
      getVapidPublicKey: () => TEST_VAPID_PUBLIC_KEY,
      rpc: async () => ({ data: null, error: null }),
      warn: () => {},
    };

    const service = createWebPushService(deps);
    const state = await service.getDeviceState();
    assert.equal(state.kind, 'denied', 'Debe resolver como denied');
  });

  // ── CASO E: AISLAMIENTO MULTI-DISPOSITIVO EN BACKEND ────────────────────────

  test('Caso E: Dos dispositivos del mismo usuario -> desactivar uno no afecta al otro', async () => {
    await setAuthContext(regularUser);

    const endpoint1 = 'https://fcm.googleapis.com/fcm/send/user-phone-device-1';
    const endpoint2 = 'https://fcm.googleapis.com/fcm/send/user-laptop-device-2';
    const p256dh = 'BMk65z1e4vW-7vFv7q_1';
    const auth = 'AbCdEf123456';

    // 1. Registrar dispositivo 1 (teléfono)
    const reg1 = await db.query<{ res: any }>(`
      SELECT public.registrar_web_push_subscription_seguro('${endpoint1}', '${p256dh}', '${auth}') AS res;
    `);
    assert.equal(reg1.rows[0].res.ok, true);

    // 2. Registrar dispositivo 2 (laptop)
    const reg2 = await db.query<{ res: any }>(`
      SELECT public.registrar_web_push_subscription_seguro('${endpoint2}', '${p256dh}', '${auth}') AS res;
    `);
    assert.equal(reg2.rows[0].res.ok, true);

    // Verificar que ambos están activos
    const statusBefore = await db.query<{ res: any }>(`
      SELECT public.get_web_push_device_status_seguro('${endpoint1}') AS res;
    `);
    assert.equal(statusBefore.rows[0].res.subscribed, true);
    assert.equal(statusBefore.rows[0].res.active_device_count, 2);

    // 3. Desactivar SOLO el dispositivo 1
    const revoke1 = await db.query<{ res: any }>(`
      SELECT public.revocar_web_push_subscription_seguro('${endpoint1}') AS res;
    `);
    assert.equal(revoke1.rows[0].res.ok, true);

    // 4. Verificar estado cruzado: Dispositivo 1 revocado, Dispositivo 2 sigue ACTIVO
    const status1After = await db.query<{ res: any }>(`
      SELECT public.get_web_push_device_status_seguro('${endpoint1}') AS res;
    `);
    assert.equal(status1After.rows[0].res.subscribed, false, 'Dispositivo 1 debe figurar inactivo');
    assert.equal(status1After.rows[0].res.active_device_count, 1, 'Queda 1 dispositivo activo');

    const status2After = await db.query<{ res: any }>(`
      SELECT public.get_web_push_device_status_seguro('${endpoint2}') AS res;
    `);
    assert.equal(status2After.rows[0].res.subscribed, true, 'Dispositivo 2 debe permanecer activo');
  });

  // ── ACCIÓN DE PRUEBA Y TRAZABILIDAD OUTBOX (QA INTERNO) ────────────────────

  test('QA Action: enviar_qa_web_push_prueba_seguro rechaza usuarios no autorizados', async () => {
    // Caso no autenticado
    await setAuthContext(null);
    const unauth = await db.query<{ res: any }>(`
      SELECT public.enviar_qa_web_push_prueba_seguro() AS res;
    `);
    assert.equal(unauth.rows[0].res.ok, false);
    assert.equal(unauth.rows[0].res.error, 'authentication_required');

    // Caso usuario regular sin rol QA
    await setAuthContext(regularUser);
    const regular = await db.query<{ res: any }>(`
      SELECT public.enviar_qa_web_push_prueba_seguro() AS res;
    `);
    assert.equal(regular.rows[0].res.ok, false);
    assert.equal(regular.rows[0].res.error, 'unauthorized');
  });

  test('QA Action: enviar_qa_web_push_prueba_seguro requiere al menos un dispositivo activo', async () => {
    await setAuthContext(qaUser);
    // QA user aún no registró ningún dispositivo activo
    const noDevice = await db.query<{ res: any }>(`
      SELECT public.enviar_qa_web_push_prueba_seguro() AS res;
    `);
    assert.equal(noDevice.rows[0].res.ok, false);
    assert.equal(noDevice.rows[0].res.error, 'no_active_device');
  });

  test('QA Action: enviar_qa_web_push_prueba_seguro ejecuta pipeline real y genera outbox', async () => {
    await setAuthContext(qaUser);

    const qaEndpoint = 'https://fcm.googleapis.com/fcm/send/qa-operator-device-abc';
    const p256dh = 'BMk65z1e4vW-7vFv7q_1';
    const auth = 'AbCdEf123456';

    // Registrar dispositivo activo para el operador QA
    await db.query(`
      SELECT public.registrar_web_push_subscription_seguro('${qaEndpoint}', '${p256dh}', '${auth}');
    `);

    // Disparar notificación de prueba
    const pushTest = await db.query<{ res: any }>(`
      SELECT public.enviar_qa_web_push_prueba_seguro() AS res;
    `);
    assert.equal(pushTest.rows[0].res.ok, true);
    assert.equal(pushTest.rows[0].res.active_devices_count, 1);
    assert.equal(pushTest.rows[0].res.endpoint_origin, 'https://fcm.googleapis.com');
    assert.equal(pushTest.rows[0].res.outbox_status, 'pending');

    const inboxId = pushTest.rows[0].res.inbox_notification_id;
    assert.ok(inboxId, 'Debe haber creado un inbox_notification_id');

    // Consultar el estado del outbox mediante get_qa_web_push_delivery_status_seguro
    const deliveryStatus = await db.query<{ res: any }>(`
      SELECT public.get_qa_web_push_delivery_status_seguro('${inboxId}') AS res;
    `);
    assert.equal(deliveryStatus.rows[0].res.ok, true);
    assert.equal(deliveryStatus.rows[0].res.deliveries.length, 1);
    assert.equal(deliveryStatus.rows[0].res.deliveries[0].status, 'pending');
    assert.equal(deliveryStatus.rows[0].res.deliveries[0].endpoint_origin, 'https://fcm.googleapis.com');
    assert.equal(deliveryStatus.rows[0].res.deliveries[0].attempt_count, 0);
  });
});
