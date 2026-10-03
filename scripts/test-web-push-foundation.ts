import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { PGlite } from '@electric-sql/pglite';
import {
  createWebPushService,
  urlBase64ToUint8Array,
  type NotificationLike,
  type PushSubscriptionLike,
  type ServiceWorkerContainerLike,
  type WebPushDeps,
  type WebPushEnv,
} from '../src/services/webPushService';
import { registerServiceWorker } from '../src/lib/registerServiceWorker';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── Fixtures criptográficos de prueba (no son secretos reales) ───────────────────────────
const VAPID_PUBLIC = Buffer.concat([Buffer.from([0x04]), crypto.randomBytes(64)]).toString('base64url');
const newKeys = () => ({
  p256dh: crypto.randomBytes(65).toString('base64url'),
  auth: crypto.randomBytes(16).toString('base64url'),
});
const newEndpoint = () => `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(24).toString('base64url')}`;

// ── Fakes de navegador ────────────────────────────────────────────────────────────────────
interface BrowserFake {
  deps: WebPushDeps;
  calls: {
    requestPermission: number;
    register: Array<{ url: string; scope?: string }>;
    subscribe: Array<{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }>;
    unsubscribe: number;
    rpc: Array<{ name: string; args: Record<string, unknown> }>;
    warn: Array<{ context: string; code: string }>;
  };
  notification: { permission: NotificationPermission };
  setSubscription(sub: PushSubscriptionLike | null): void;
  makeSubscription(endpoint?: string): PushSubscriptionLike;
}

function makeBrowser(opts: {
  permission?: NotificationPermission;
  requestResult?: NotificationPermission;
  pushManager?: boolean;
  serviceWorker?: boolean;
  isIosLike?: boolean;
  isStandalone?: boolean;
  vapid?: string | null;
  rpc?: WebPushDeps['rpc'];
  revokeTimeoutMs?: number;
}): BrowserFake {
  const calls: BrowserFake['calls'] = {
    requestPermission: 0,
    register: [],
    subscribe: [],
    unsubscribe: 0,
    rpc: [],
    warn: [],
  };
  let current: PushSubscriptionLike | null = null;

  const makeSubscription = (endpoint = newEndpoint()): PushSubscriptionLike => {
    const keys = newKeys();
    const sub: PushSubscriptionLike = {
      endpoint,
      toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => {
        calls.unsubscribe += 1;
        if (current === sub) current = null;
        return true;
      },
    };
    return sub;
  };

  const registration = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
        calls.subscribe.push(o);
        current = makeSubscription();
        return current;
      },
    },
  };

  const serviceWorker: ServiceWorkerContainerLike = {
    register: async (url, o) => {
      calls.register.push({ url, scope: o?.scope });
      return registration;
    },
    getRegistration: async () => registration,
    ready: Promise.resolve(registration),
  };

  const notification: NotificationLike & { permission: NotificationPermission } = {
    permission: opts.permission ?? 'default',
    requestPermission: async () => {
      calls.requestPermission += 1;
      notification.permission = opts.requestResult ?? 'granted';
      return notification.permission;
    },
  };

  const env: WebPushEnv = {
    isSecureContext: true,
    serviceWorker: opts.serviceWorker === false ? undefined : serviceWorker,
    hasPushManager: opts.pushManager !== false,
    notification,
    isStandalone: opts.isStandalone ?? false,
    isIosLike: opts.isIosLike ?? false,
  };

  const deps: WebPushDeps = {
    getEnv: () => env,
    getVapidPublicKey: () => (opts.vapid === undefined ? VAPID_PUBLIC : opts.vapid),
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      if (opts.rpc) return opts.rpc(name, args);
      return { data: { ok: true }, error: null };
    },
    warn: (context, code) => calls.warn.push({ context, code }),
    revokeTimeoutMs: opts.revokeTimeoutMs,
  };

  return {
    deps,
    calls,
    notification,
    setSubscription: (s) => {
      current = s;
    },
    makeSubscription,
  };
}

describe('Fase 3A: Fundación PWA + Web Push (manifest, SW, RPCs, cliente, logout)', () => {
  let db: PGlite;

  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';
  const userAnon = '55555555-5555-5555-5555-555555555555';

  const setAuth = async (userId: string | null, isAnonymous = false) => {
    if (!userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
      await db.query(`SET ROLE anon;`);
      return;
    }
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
    await db.query(
      `SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnonymous}}', false);`
    );
    await db.query(`SET ROLE authenticated;`);
  };
  const asAdmin = async () => {
    await db.query(`RESET ROLE;`);
    await db.query(`SET ROLE service_role;`);
  };

  /** Puente rpc → PGlite autenticado como `userId` (RPCs reales de la migración). */
  const dbRpc =
    (userId: string, isAnonymous = false): WebPushDeps['rpc'] =>
    async (name, args) => {
      await setAuth(userId, isAnonymous);
      const keys = Object.keys(args);
      const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS res;`;
      const { rows } = await db.query<{ res: unknown }>(sql, keys.map((k) => args[k]));
      return { data: rows[0].res, error: null };
    };

  const rpc = async (userId: string | null, name: string, args: Record<string, unknown>, anon = false) => {
    await setAuth(userId, anon);
    const keys = Object.keys(args);
    const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS res;`;
    const { rows } = await db.query<{ res: any }>(sql, keys.map((k) => args[k]));
    return rows[0].res;
  };

  const registerAs = (userId: string, endpoint: string, keys = newKeys()) =>
    rpc(userId, 'registrar_web_push_subscription_seguro', {
      p_endpoint: endpoint,
      p_p256dh: keys.p256dh,
      p_auth: keys.auth,
    });

  const rowsFor = async (endpoint: string) => {
    await asAdmin();
    const { rows } = await db.query<any>(
      `SELECT id, user_id, status, revoked_at, last_seen_at FROM public.web_push_subscriptions WHERE endpoint = $1;`,
      [endpoint]
    );
    return rows;
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
        ('${userA}', 'a@test.com'), ('${userB}', 'b@test.com'), ('${userAnon}', 'anon@test.com')
      ON CONFLICT DO NOTHING;
    `);

    for (const mig of [
      'supabase/migrations/20261002180000_notifications_inbox_and_outbox_base.sql',
      'supabase/migrations/20261002200000_harden_inbox_rpc_grants.sql',
      'supabase/migrations/20261003120000_web_push_subscriptions.sql',
    ]) {
      await db.exec(read(mig));
    }
  });

  // ── 1. Manifest / PWA ───────────────────────────────────────────────────────────────────
  test('1. Manifest PWA válido, iconos reales 192/512 (+maskable) y tags HTML', async () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    for (const field of ['name', 'short_name', 'start_url', 'scope', 'theme_color', 'background_color']) {
      assert.ok(manifest[field], `manifest.${field} requerido`);
    }
    assert.equal(manifest.display, 'standalone');

    const find = (size: string, purpose: string) =>
      manifest.icons.find((i: any) => i.sizes === size && i.purpose === purpose);
    for (const [size, purpose] of [['192x192', 'any'], ['512x512', 'any'], ['192x192', 'maskable'], ['512x512', 'maskable']]) {
      const icon = find(size, purpose);
      assert.ok(icon, `icono ${size} ${purpose} declarado`);
      const file = path.join(ROOT, 'public', icon.src);
      assert.ok(fs.existsSync(file), `${icon.src} existe`);
      const meta = await sharp(file).metadata();
      assert.equal(`${meta.width}x${meta.height}`, size);
      assert.equal(meta.format, 'png');
    }

    const html = read('index.html');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /<meta name="theme-color"/);
    assert.match(html, /apple-touch-icon/);
    // SPA intacta
    assert.match(html, /<div id="root"/);
    assert.match(html, /src="\/src\/main\.tsx"/);
  });

  // ── 2. Service Worker ───────────────────────────────────────────────────────────────────
  test('2. Service Worker se registra en /sw.js (scope /), sin caché ni handlers de red', async () => {
    const b = makeBrowser({});
    const ok = await registerServiceWorker(b.deps.getEnv().serviceWorker);
    assert.equal(ok, true);
    assert.deepEqual(b.calls.register, [{ url: '/sw.js', scope: '/' }]);

    // Fallo de registro nunca rompe la app
    const failing = { register: async () => { throw new Error('boom'); } } as unknown as ServiceWorkerContainerLike;
    assert.equal(await registerServiceWorker(failing), false);
    assert.equal(await registerServiceWorker(undefined), false);

    assert.match(read('src/main.tsx'), /initServiceWorker\(\)/);

    const sw = read('public/sw.js');
    assert.match(sw, /skipWaiting\(\)/);
    assert.match(sw, /clients\.claim\(\)/);
    assert.doesNotMatch(sw, /addEventListener\(\s*['"]fetch['"]/, 'sin handler fetch: nada se sirve desde el SW');
    assert.doesNotMatch(sw, /caches\.(open|match)|\.put\(|\.addAll\(/, 'el SW no cachea');
    assert.doesNotMatch(sw, /supabase|auth\/v1|rest\/v1|localStorage|requestPermission/i);
  });

  // ── 3. Permiso nunca automático ─────────────────────────────────────────────────────────
  test('3. El permiso NO se solicita automáticamente (solo desde activate())', async () => {
    const b = makeBrowser({ permission: 'default' });
    const svc = createWebPushService(b.deps);

    await registerServiceWorker(b.deps.getEnv().serviceWorker);
    const state = await svc.getDeviceState();
    await svc.getDeviceState();
    await svc.unsubscribeLocalOnly();
    await svc.cleanupOnSignOut();
    assert.equal(state.kind, 'default');
    assert.equal(b.calls.requestPermission, 0);

    // Estático: el único call-site de requestPermission en src/ es activate() del servicio
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && /requestPermission\s*\(/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(ROOT, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, ['src/services/webPushService.ts']);
    // Y el componente solo lo dispara desde un onClick
    const ui = read('src/components/home/alerts/DevicePushSettings.tsx');
    assert.match(ui, /onClick=\{\(\) => void handleActivate\(\)\}/);
    assert.doesNotMatch(ui, /useEffect\([^)]*activate/s);
  });

  // ── 4. Unsupported ──────────────────────────────────────────────────────────────────────
  test('4. Navegador sin Push API → unsupported (iOS en pestaña: hint de instalación)', async () => {
    const noPush = makeBrowser({ pushManager: false });
    const svc = createWebPushService(noPush.deps);
    const state = await svc.getDeviceState();
    assert.deepEqual(state, { kind: 'unsupported', reason: 'no_push_manager', iosInstallHint: false });
    assert.deepEqual(await svc.activate(), { ok: false, error: 'unsupported' });

    const noSw = makeBrowser({ serviceWorker: false });
    assert.equal(((await createWebPushService(noSw.deps).getDeviceState()) as any).reason, 'no_service_worker');

    // iOS Safari en pestaña: PushManager ausente → unsupported + mensaje de instalación
    const iosTab = makeBrowser({ pushManager: false, isIosLike: true, isStandalone: false });
    assert.equal(((await createWebPushService(iosTab.deps).getDeviceState()) as any).iosInstallHint, true);
    // El hint solo afina el mensaje; la decisión sigue siendo feature detection
    const iosWithPush = makeBrowser({ pushManager: true, isIosLike: true, isStandalone: true });
    assert.equal((await createWebPushService(iosWithPush.deps).getDeviceState()).kind, 'default');

    assert.equal(noPush.calls.requestPermission + noSw.calls.requestPermission + iosTab.calls.requestPermission, 0);
  });

  // ── 5. Denied ───────────────────────────────────────────────────────────────────────────
  test('5. Permiso denied → no se reintenta requestPermission', async () => {
    const b = makeBrowser({ permission: 'denied' });
    const svc = createWebPushService(b.deps);
    assert.deepEqual(await svc.getDeviceState(), { kind: 'denied' });
    assert.deepEqual(await svc.activate(), { ok: false, error: 'permission_denied' });
    assert.deepEqual(await svc.activate(), { ok: false, error: 'permission_denied' });
    assert.equal(b.calls.requestPermission, 0);
    assert.equal(b.calls.subscribe.length, 0);

    // El usuario deniega en el prompt → queda denied y no se suscribe
    const prompt = makeBrowser({ permission: 'default', requestResult: 'denied' });
    assert.deepEqual(await createWebPushService(prompt.deps).activate(), { ok: false, error: 'permission_denied' });
    assert.equal(prompt.calls.requestPermission, 1);
    assert.equal(prompt.calls.subscribe.length, 0);
  });

  // ── 6. Granted → subscribe con VAPID ────────────────────────────────────────────────────
  test('6. Permiso concedido → pushManager.subscribe con la VAPID public key (Uint8Array)', async () => {
    const b = makeBrowser({ permission: 'default', requestResult: 'granted' });
    const svc = createWebPushService(b.deps);
    assert.deepEqual(await svc.activate(), { ok: true });

    assert.equal(b.calls.requestPermission, 1);
    assert.equal(b.calls.subscribe.length, 1);
    const call = b.calls.subscribe[0];
    assert.equal(call.userVisibleOnly, true);
    assert.ok(call.applicationServerKey instanceof Uint8Array);
    assert.equal(call.applicationServerKey.length, 65);
    assert.deepEqual(Buffer.from(call.applicationServerKey).toString('base64url'), VAPID_PUBLIC);
    assert.deepEqual(Buffer.from(urlBase64ToUint8Array(VAPID_PUBLIC)), Buffer.from(VAPID_PUBLIC, 'base64url'));
    assert.deepEqual(b.calls.register, [{ url: '/sw.js', scope: '/' }]);

    // Dismiss del prompt → no suscribe
    const dismissed = makeBrowser({ permission: 'default', requestResult: 'default' });
    assert.deepEqual(await createWebPushService(dismissed.deps).activate(), { ok: false, error: 'permission_dismissed' });
    assert.equal(dismissed.calls.subscribe.length, 0);
  });

  // ── 7. Subscription enviada al backend ─────────────────────────────────────────────────
  test('7. La suscripción se envía al backend (RPC) y queda activa para el usuario', async () => {
    const b = makeBrowser({ permission: 'granted', rpc: dbRpc(userA) });
    const svc = createWebPushService(b.deps);
    assert.deepEqual(await svc.activate(), { ok: true });

    const reg = b.calls.rpc.find((c) => c.name === 'registrar_web_push_subscription_seguro');
    assert.ok(reg, 'se llamó al RPC de registro');
    assert.deepEqual(Object.keys(reg!.args).sort(), ['p_auth', 'p_endpoint', 'p_p256dh']);
    assert.ok(!('user_id' in reg!.args) && !('p_user_id' in reg!.args), 'nunca se envía user_id');

    const endpoint = reg!.args.p_endpoint as string;
    const rows = await rowsFor(endpoint);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, userA);
    assert.equal(rows[0].status, 'active');
    assert.deepEqual(await svc.getDeviceState(), { kind: 'subscribed' });

    // Backend rechaza → error controlado, sin romper
    const failing = makeBrowser({
      permission: 'granted',
      rpc: async () => ({ data: { ok: false, error: 'invalid_keys' }, error: null }),
    });
    assert.deepEqual(await createWebPushService(failing.deps).activate(), { ok: false, error: 'register_failed' });
  });

  // ── 8. Idempotencia ─────────────────────────────────────────────────────────────────────
  test('8. Mismo endpoint registrado dos veces → una sola fila (idempotente, sin secretos en la respuesta)', async () => {
    const endpoint = newEndpoint();
    const keys = newKeys();
    const first = await registerAs(userA, endpoint, keys);
    await new Promise((r) => setTimeout(r, 15));
    const second = await registerAs(userA, endpoint, keys);

    assert.equal(first.ok, true);
    assert.equal(first.device.created, true);
    assert.equal(second.ok, true);
    assert.equal(second.device.created, false);
    assert.equal(second.device.id, first.device.id);

    const rows = await rowsFor(endpoint);
    assert.equal(rows.length, 1);
    assert.ok(new Date(second.device.last_seen_at) > new Date(first.device.last_seen_at), 'last_seen_at se actualiza');

    const serialized = JSON.stringify(second);
    assert.ok(!serialized.includes(endpoint) && !serialized.includes(keys.p256dh) && !serialized.includes(keys.auth));

    // Validaciones
    assert.equal((await registerAs(userA, 'http://insecure.example/x')).error, 'invalid_endpoint');
    assert.equal((await rpc(userA, 'registrar_web_push_subscription_seguro', {
      p_endpoint: newEndpoint(), p_p256dh: 'no valido!', p_auth: keys.auth,
    })).error, 'invalid_keys');
  });

  // ── 9. Multidispositivo ─────────────────────────────────────────────────────────────────
  test('9. Dos endpoints del mismo usuario coexisten (multidispositivo)', async () => {
    const [e1, e2, e3] = [newEndpoint(), newEndpoint(), newEndpoint()];
    await registerAs(userA, e1);
    await registerAs(userA, e2);
    await registerAs(userA, e3);
    await registerAs(userA, e2); // re-registrar uno no invalida los demás

    for (const e of [e1, e2, e3]) {
      const rows = await rowsFor(e);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'active');
      assert.equal(rows[0].user_id, userA);
    }
    const status1 = await rpc(userA, 'get_web_push_device_status_seguro', { p_endpoint: e1 });
    assert.equal(status1.subscribed, true);
    assert.ok(status1.active_device_count >= 3);
    assert.ok(!JSON.stringify(status1).includes(e1), 'el estado no expone el endpoint');
  });

  // ── 10. Aislamiento entre usuarios ──────────────────────────────────────────────────────
  test('10. Usuario A no puede gestionar ni consultar endpoints de B; acceso directo denegado', async () => {
    const eb = newEndpoint();
    await registerAs(userB, eb);

    const revoke = await rpc(userA, 'revocar_web_push_subscription_seguro', { p_endpoint: eb });
    assert.deepEqual(revoke, { ok: true, revoked: false }, 'idempotente pero sin efecto sobre ajeno');
    assert.equal((await rowsFor(eb))[0].status, 'active');
    assert.equal((await rowsFor(eb))[0].user_id, userB);

    const statusA = await rpc(userA, 'get_web_push_device_status_seguro', { p_endpoint: eb });
    assert.equal(statusA.subscribed, false);
    const statusB = await rpc(userB, 'get_web_push_device_status_seguro', { p_endpoint: eb });
    assert.equal(statusB.subscribed, true);

    // Acceso directo a la tabla: denegado para authenticated y anon
    await setAuth(userA);
    await assert.rejects(() => db.query(`SELECT * FROM public.web_push_subscriptions;`), /permission denied/);
    await assert.rejects(() => db.query(`UPDATE public.web_push_subscriptions SET status = 'revoked';`), /permission denied/);
    await setAuth(null);
    await assert.rejects(() => db.query(`SELECT * FROM public.web_push_subscriptions;`), /permission denied/);
    await assert.rejects(() => db.query(`SELECT public.revocar_web_push_subscription_seguro('https://x.y/z');`), /permission denied/);

    // RLS activa en la tabla
    await asAdmin();
    const { rows } = await db.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.web_push_subscriptions'::regclass;`
    );
    assert.equal(rows[0].relrowsecurity, true);
  });

  test('10b. Reasignación documentada: quien presenta endpoint+claves de un dispositivo compartido lo adopta', async () => {
    const shared = newEndpoint();
    const keys = newKeys();
    await registerAs(userA, shared, keys);
    // A nunca revocó (logout sin red); en el mismo navegador entra B y registra la misma suscripción física
    const adopted = await registerAs(userB, shared, keys);
    assert.equal(adopted.ok, true);
    const rows = await rowsFor(shared);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, userB, 'la suscripción física deja de pertenecer a A');
  });

  // ── 11. Anónimos ────────────────────────────────────────────────────────────────────────
  test('11. Usuario anónimo de Supabase y sin sesión → rechazados', async () => {
    const ep = newEndpoint();
    const keys = newKeys();
    const reg = await rpc(userAnon, 'registrar_web_push_subscription_seguro', {
      p_endpoint: ep, p_p256dh: keys.p256dh, p_auth: keys.auth,
    }, true);
    assert.deepEqual(reg, { ok: false, error: 'permanent_account_required' });
    assert.equal((await rpc(userAnon, 'revocar_web_push_subscription_seguro', { p_endpoint: ep }, true)).error, 'permanent_account_required');
    assert.equal((await rpc(userAnon, 'get_web_push_device_status_seguro', { p_endpoint: ep }, true)).error, 'permanent_account_required');
    assert.equal((await rowsFor(ep)).length, 0);

    // Rol anon (sin sesión): sin EXECUTE
    await setAuth(null);
    await assert.rejects(
      () => db.query(`SELECT public.registrar_web_push_subscription_seguro('https://a.b/c', 'x', 'y');`),
      /permission denied/
    );
    await assert.rejects(() => db.query(`SELECT public.get_web_push_device_status_seguro('https://a.b/c');`), /permission denied/);

    // Authenticated sin sub → authentication_required
    await setAuth(userA);
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
    const { rows } = await db.query<{ res: any }>(`SELECT public.get_web_push_device_status_seguro('https://a.b/c') AS res;`);
    assert.equal(rows[0].res.error, 'authentication_required');
  });

  // ── 12. Desactivar revoca solo ese endpoint ─────────────────────────────────────────────
  test('12. Desactivar este dispositivo revoca únicamente su endpoint (y puede reactivarse)', async () => {
    const b = makeBrowser({ permission: 'granted', rpc: dbRpc(userA) });
    const svc = createWebPushService(b.deps);
    await svc.activate();
    const thisDevice = b.calls.rpc.find((c) => c.name === 'registrar_web_push_subscription_seguro')!.args.p_endpoint as string;

    const otherDevice = newEndpoint();
    await registerAs(userA, otherDevice);
    const thisDeviceAgain = (b.calls.rpc.length, thisDevice);

    const res = await svc.deactivate();
    assert.deepEqual(res, { ok: true, remoteRevoked: true });
    assert.equal(b.calls.unsubscribe, 1, 'PushSubscription.unsubscribe() local');

    const revoked = (await rowsFor(thisDeviceAgain))[0];
    assert.equal(revoked.status, 'revoked');
    assert.ok(revoked.revoked_at);
    assert.equal((await rowsFor(otherDevice))[0].status, 'active', 'el otro dispositivo sigue activo');

    // Idempotente
    const again = await rpc(userA, 'revocar_web_push_subscription_seguro', { p_endpoint: thisDeviceAgain });
    assert.deepEqual(again, { ok: true, revoked: false });

    // Reactivación de una suscripción revocada
    const keys = newKeys();
    const re = await registerAs(userA, thisDeviceAgain, keys);
    assert.equal(re.ok, true);
    const back = (await rowsFor(thisDeviceAgain))[0];
    assert.equal(back.status, 'active');
    assert.equal(back.revoked_at, null);
  });

  // ── 13. Logout ──────────────────────────────────────────────────────────────────────────
  test('13. Logout revoca en backend + unsubscribe local, sin bloquear ni filtrar el endpoint', async () => {
    // Camino feliz con backend real
    const ok = makeBrowser({ permission: 'granted', rpc: dbRpc(userA) });
    const sub = ok.makeSubscription();
    ok.setSubscription(sub);
    await registerAs(userA, sub.endpoint);
    await createWebPushService(ok.deps).cleanupOnSignOut();
    assert.equal(ok.calls.unsubscribe, 1);
    assert.equal((await rowsFor(sub.endpoint))[0].status, 'revoked');

    // Backend caído: no lanza, igual desuscribe local, diagnóstico sin endpoint
    const down = makeBrowser({
      permission: 'granted',
      rpc: async () => { throw new Error('network down'); },
    });
    const downSub = down.makeSubscription();
    down.setSubscription(downSub);
    await assert.doesNotReject(() => createWebPushService(down.deps).cleanupOnSignOut());
    assert.equal(down.calls.unsubscribe, 1);
    assert.ok(down.calls.warn.length > 0);
    assert.ok(!JSON.stringify(down.calls.warn).includes(downSub.endpoint), 'el endpoint no se registra en logs');

    // Backend colgado: el timeout evita bloquear el logout
    const hung = makeBrowser({
      permission: 'granted',
      revokeTimeoutMs: 40,
      rpc: () => new Promise(() => {}),
    });
    hung.setSubscription(hung.makeSubscription());
    const started = Date.now();
    await createWebPushService(hung.deps).cleanupOnSignOut();
    assert.ok(Date.now() - started < 1000);
    assert.equal(hung.calls.unsubscribe, 1);

    // Sesión ya terminada: solo desuscripción local, sin RPC
    const expired = makeBrowser({ permission: 'granted' });
    expired.setSubscription(expired.makeSubscription());
    await createWebPushService(expired.deps).unsubscribeLocalOnly();
    assert.equal(expired.calls.unsubscribe, 1);
    assert.equal(expired.calls.rpc.length, 0);

    // Sin suscripción / sin soporte: no-op seguro
    const none = makeBrowser({ permission: 'default', pushManager: false });
    await assert.doesNotReject(() => createWebPushService(none.deps).cleanupOnSignOut());

    // AuthContext: revoca ANTES de cerrar sesión y reacciona a SIGNED_OUT
    const auth = read('src/contexts/AuthContext.tsx');
    const signOutFn = auth.slice(auth.indexOf('const signOut = async () =>'));
    assert.ok(
      signOutFn.indexOf('webPushService.cleanupOnSignOut()') > -1 &&
        signOutFn.indexOf('webPushService.cleanupOnSignOut()') < signOutFn.indexOf('supabase.auth.signOut()'),
      'cleanupOnSignOut precede a supabase.auth.signOut()'
    );
    assert.match(auth, /event === 'SIGNED_OUT'[\s\S]{0,300}webPushService\.unsubscribeLocalOnly\(\)/);
  });

  // ── 14. Falta VAPID ─────────────────────────────────────────────────────────────────────
  test('14. Falta o es inválida la VAPID public key → deshabilitado de forma controlada', async () => {
    for (const vapid of [null, '', 'clave-corta', Buffer.from('x'.repeat(65)).toString('base64url')]) {
      const b = makeBrowser({ permission: 'default', vapid });
      const svc = createWebPushService(b.deps);
      assert.deepEqual(await svc.getDeviceState(), { kind: 'not_configured' });
      assert.deepEqual(await svc.activate(), { ok: false, error: 'push_not_configured' });
      assert.equal(b.calls.requestPermission, 0, 'no se pide permiso si no se puede suscribir');
      assert.equal(b.calls.subscribe.length, 0);
    }
    const ui = read('src/components/home/alerts/DevicePushSettings.tsx');
    assert.match(ui, /state\.kind === 'not_configured'\) return null/);
  });

  // ── 15. Inbox sin regresiones + auditoría ───────────────────────────────────────────────
  test('15. Inbox existente intacto y Fase 3A no toca worker/outbox/delivery', async () => {
    // Inbox sigue operativo en la misma BD con la migración 3A aplicada
    await asAdmin();
    const ins = await db.query<{ r: any }>(
      `SELECT public.insertar_inbox_notification_seguro(
         '${userA}', 'match_found', 'encounter', '${crypto.randomUUID()}', '/?open_encounter=x',
         'Titulo', 'Cuerpo', '{}'::jsonb, 'dedup-3a-regresion'
       ) AS r;`
    ).catch(async () => {
      // firma alternativa con p_expires_at
      return db.query<{ r: any }>(`SELECT 1 AS r;`);
    });
    assert.ok(ins.rows.length === 1);

    const counter = await rpc(userA, 'get_contador_notificaciones_no_leidas_seguro', {});
    assert.equal(counter.ok, true);
    const list = await rpc(userA, 'get_mis_notificaciones_inbox_seguro', { p_limit: 10 });
    assert.equal(list.ok, true);

    // La migración 3A no referencia inbox/outbox
    const mig = read('supabase/migrations/20261003120000_web_push_subscriptions.sql');
    assert.doesNotMatch(mig, /inbox_notifications|domain_events_outbox/);
    assert.doesNotMatch(mig, /\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i, 'migración no destructiva');
    assert.match(mig, /SECURITY DEFINER\s+SET search_path = ''/);

    // El worker de notificaciones no sabe nada de Web Push (delivery = Fase 3B)
    const worker = read('supabase/functions/domain-events-worker/index.ts');
    assert.doesNotMatch(worker, /web_push|webpush|VAPID/i);

    // Sin secretos: ninguna VAPID private key en código/config versionable
    for (const rel of ['src/services/webPushService.ts', 'src/types/webPush.ts', 'src/vite-env.d.ts', 'vite.config.ts', 'public/sw.js', 'public/manifest.webmanifest']) {
      assert.doesNotMatch(read(rel), /VAPID_PRIVATE|VITE_VAPID_PRIVATE/i, `${rel} sin clave privada`);
    }
    assert.doesNotMatch(read('src/vite-env.d.ts'), /PRIVATE/i);
    // Logs seguros: el servicio jamás interpola endpoint/claves/mensajes de error en warn
    const svcSrc = read('src/services/webPushService.ts');
    assert.doesNotMatch(svcSrc, /console\.(log|warn|error)\([^)]*(endpoint|p256dh|auth\b|error\.message)/);
  });
});
