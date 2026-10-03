import { supabase } from '../lib/supabase';
import type {
  WebPushActivateError,
  WebPushActivateResult,
  WebPushDeactivateResult,
  WebPushDeviceState,
  WebPushUnsupportedReason,
} from '../types/webPush';

/**
 * Capa dedicada Web Push (Fase 3A). Sin React.
 *
 * Reglas de privacidad:
 *  - Nunca se loguea endpoint, claves ni mensajes de error del backend (pueden contener la fila).
 *  - Notification.requestPermission() solo se invoca desde activate(), que a su vez solo
 *    debe ser llamado desde un gesto explícito del usuario.
 */

export const SERVICE_WORKER_URL = '/sw.js';
export const SERVICE_WORKER_SCOPE = '/';

// ── Interfaces estructurales mínimas (compatibles con DOM; facilitan tests) ──────────────

export interface PushSubscriptionLike {
  endpoint: string;
  options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array;
  }): Promise<PushSubscriptionLike>;
}

export interface ServiceWorkerRegistrationLike {
  pushManager: PushManagerLike;
}

export interface ServiceWorkerContainerLike {
  register(url: string, options?: { scope?: string }): Promise<ServiceWorkerRegistrationLike>;
  getRegistration(): Promise<ServiceWorkerRegistrationLike | undefined>;
  ready: Promise<ServiceWorkerRegistrationLike>;
}

export interface NotificationLike {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

export interface WebPushEnv {
  isSecureContext: boolean;
  serviceWorker?: ServiceWorkerContainerLike;
  /** true si `PushManager` existe en el contexto global (feature detection) */
  hasPushManager: boolean;
  notification?: NotificationLike;
  isStandalone: boolean;
  /** Solo afina el mensaje al usuario; NO decide soporte */
  isIosLike: boolean;
}

export interface WebPushDeps {
  getEnv(): WebPushEnv;
  getVapidPublicKey(): string | null;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  /** Diagnóstico seguro: solo contexto + código, jamás datos de la suscripción */
  warn(context: string, code: string): void;
  revokeTimeoutMs?: number;
}

// ── Utilidades ───────────────────────────────────────────────────────────────────────────

/** Decodifica una VAPID public key (base64url) a Uint8Array para pushManager.subscribe. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** Una VAPID public key válida es un punto P-256 sin comprimir: 65 bytes, prefijo 0x04. */
function decodeVapidKey(raw: string | null): Uint8Array | null {
  if (!raw) return null;
  try {
    const bytes = urlBase64ToUint8Array(raw.trim());
    return bytes.length === 65 && bytes[0] === 0x04 ? bytes : null;
  } catch {
    return null;
  }
}

function sameKey(existing: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!existing) return true; // sin información: asumir compatible
  const a = new Uint8Array(existing);
  if (a.length !== expected.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== expected[i]) return false;
  }
  return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ── Servicio ─────────────────────────────────────────────────────────────────────────────

export function createWebPushService(deps: WebPushDeps) {
  const revokeTimeoutMs = deps.revokeTimeoutMs ?? 3000;

  const detectUnsupported = (env: WebPushEnv): WebPushUnsupportedReason | null => {
    if (!env.isSecureContext) return 'insecure_context';
    if (!env.serviceWorker) return 'no_service_worker';
    if (!env.hasPushManager) return 'no_push_manager';
    if (!env.notification) return 'no_notification';
    return null;
  };

  const getCurrentSubscription = async (
    sw: ServiceWorkerContainerLike
  ): Promise<PushSubscriptionLike | null> => {
    const reg = await sw.getRegistration();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  };

  const revokeRemote = async (endpoint: string): Promise<boolean> => {
    try {
      const { data, error } = await withTimeout(
        Promise.resolve(deps.rpc('revocar_web_push_subscription_seguro', { p_endpoint: endpoint })),
        revokeTimeoutMs
      );
      const res = data as { ok?: boolean } | null;
      if (error || !res?.ok) {
        deps.warn('revoke', error ? 'rpc_error' : 'rpc_rejected');
        return false;
      }
      return true;
    } catch (err) {
      deps.warn('revoke', (err as Error)?.message === 'timeout' ? 'timeout' : 'exception');
      return false;
    }
  };

  /**
   * Estado actual del dispositivo. Solo lectura: NUNCA solicita permiso ni registra el SW.
   */
  async function getDeviceState(): Promise<WebPushDeviceState> {
    const env = deps.getEnv();
    const unsupported = detectUnsupported(env);
    if (unsupported) {
      return {
        kind: 'unsupported',
        reason: unsupported,
        iosInstallHint: env.isIosLike && !env.isStandalone,
      };
    }

    if (!decodeVapidKey(deps.getVapidPublicKey())) {
      return { kind: 'not_configured' };
    }

    const permission = env.notification!.permission;
    if (permission === 'denied') return { kind: 'denied' };
    if (permission === 'default') return { kind: 'default' };

    try {
      const sub = await getCurrentSubscription(env.serviceWorker!);
      if (!sub) return { kind: 'granted_unsubscribed' };

      const { data, error } = await deps.rpc('get_web_push_device_status_seguro', {
        p_endpoint: sub.endpoint,
      });
      const res = data as { ok?: boolean; subscribed?: boolean } | null;
      if (!error && res?.ok && res.subscribed) return { kind: 'subscribed' };
      return { kind: 'granted_unsubscribed' };
    } catch {
      deps.warn('status', 'exception');
      return { kind: 'granted_unsubscribed' };
    }
  }

  /**
   * Activa Web Push en ESTE dispositivo. Debe invocarse únicamente desde una acción
   * explícita del usuario (es el único lugar donde se llama requestPermission).
   */
  async function activate(): Promise<WebPushActivateResult> {
    const env = deps.getEnv();
    if (detectUnsupported(env)) return { ok: false, error: 'unsupported' };

    const vapidKey = decodeVapidKey(deps.getVapidPublicKey());
    if (!vapidKey) return { ok: false, error: 'push_not_configured' };

    const notification = env.notification!;
    if (notification.permission === 'denied') {
      // Bloqueado desde el navegador: no volver a preguntar.
      return { ok: false, error: 'permission_denied' };
    }

    if (notification.permission === 'default') {
      const result = await notification.requestPermission();
      if (result === 'denied') return { ok: false, error: 'permission_denied' };
      if (result !== 'granted') return { ok: false, error: 'permission_dismissed' };
    }

    let registration: ServiceWorkerRegistrationLike;
    try {
      const sw = env.serviceWorker!;
      await sw.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE });
      registration = await sw.ready;
    } catch {
      deps.warn('activate', 'service_worker_failed');
      return { ok: false, error: 'service_worker_failed' };
    }

    let subscription: PushSubscriptionLike;
    try {
      let existing = await registration.pushManager.getSubscription();
      if (existing && !sameKey(existing.options?.applicationServerKey, vapidKey)) {
        // Suscripción creada con otra VAPID key: no sirve para nuestro servidor.
        await existing.unsubscribe();
        existing = null;
      }
      subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey,
        }));
    } catch {
      deps.warn('activate', 'subscribe_failed');
      return { ok: false, error: 'subscribe_failed' };
    }

    const json = subscription.toJSON();
    const endpoint = json.endpoint ?? subscription.endpoint;
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      deps.warn('activate', 'invalid_subscription');
      return { ok: false, error: 'invalid_subscription' };
    }

    try {
      const { data, error } = await deps.rpc('registrar_web_push_subscription_seguro', {
        p_endpoint: endpoint,
        p_p256dh: p256dh,
        p_auth: auth,
      });
      const res = data as { ok?: boolean; error?: string } | null;
      if (error || !res?.ok) {
        deps.warn('activate', error ? 'rpc_error' : 'rpc_rejected');
        const code = res?.error;
        const mapped: WebPushActivateError =
          code === 'authentication_required' || code === 'permanent_account_required'
            ? code
            : 'register_failed';
        return { ok: false, error: mapped };
      }
      return { ok: true };
    } catch {
      deps.warn('activate', 'exception');
      return { ok: false, error: 'register_failed' };
    }
  }

  /**
   * Desactiva SOLO este dispositivo: revoca su endpoint en backend y desuscribe localmente.
   * Si el backend falla, igualmente desuscribe localmente (no se reciben más pushes aquí).
   */
  async function deactivate(): Promise<WebPushDeactivateResult> {
    const env = deps.getEnv();
    if (detectUnsupported(env)) return { ok: true, remoteRevoked: true };

    try {
      const sub = await getCurrentSubscription(env.serviceWorker!);
      if (!sub) return { ok: true, remoteRevoked: true };

      const remoteRevoked = await revokeRemote(sub.endpoint);
      const unsubscribed = await sub.unsubscribe();
      return { ok: unsubscribed, remoteRevoked };
    } catch {
      deps.warn('deactivate', 'exception');
      return { ok: false, remoteRevoked: false };
    }
  }

  /**
   * Cierre de sesión (o cambio de cuenta) en un dispositivo posiblemente compartido.
   * Mejor esfuerzo, acotado en tiempo y NUNCA lanza: no puede bloquear el logout.
   * Debe invocarse ANTES de supabase.auth.signOut() para poder autenticar la revocación.
   */
  async function cleanupOnSignOut(): Promise<void> {
    try {
      await deactivate();
    } catch {
      deps.warn('signout', 'exception');
    }
  }

  /**
   * Cuando la sesión ya terminó (expiración, otra pestaña): no hay cómo autenticar la
   * revocación remota, pero sí se puede cortar la suscripción local del navegador.
   */
  async function unsubscribeLocalOnly(): Promise<void> {
    try {
      const env = deps.getEnv();
      if (detectUnsupported(env)) return;
      const sub = await getCurrentSubscription(env.serviceWorker!);
      if (sub) await sub.unsubscribe();
    } catch {
      deps.warn('signout_local', 'exception');
    }
  }

  return { getDeviceState, activate, deactivate, cleanupOnSignOut, unsubscribeLocalOnly };
}

// ── Instancia real (lectura perezosa del entorno del navegador) ─────────────────────────

function readBrowserEnv(): WebPushEnv {
  const w = typeof window !== 'undefined' ? window : undefined;
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const ua = nav?.userAgent ?? '';
  const isIosLike =
    /iPad|iPhone|iPod/.test(ua) || (nav?.platform === 'MacIntel' && (nav?.maxTouchPoints ?? 0) > 1);

  const standaloneMedia = !!w?.matchMedia?.('(display-mode: standalone)').matches;
  const standaloneIos = (nav as unknown as { standalone?: boolean } | undefined)?.standalone === true;

  return {
    isSecureContext: !!w?.isSecureContext,
    serviceWorker:
      nav && 'serviceWorker' in nav
        ? (nav.serviceWorker as unknown as ServiceWorkerContainerLike)
        : undefined,
    hasPushManager: !!w && 'PushManager' in w,
    notification: w && 'Notification' in w ? (w.Notification as unknown as NotificationLike) : undefined,
    isStandalone: standaloneMedia || standaloneIos,
    isIosLike,
  };
}

export const webPushService = createWebPushService({
  getEnv: readBrowserEnv,
  // La VAPID PUBLIC key puede estar en el bundle. La PRIVATE jamás (nunca VITE_*).
  getVapidPublicKey: () => {
    const meta = typeof import.meta !== 'undefined' ? (import.meta as unknown as { env?: Record<string, string | undefined> }) : undefined;
    return (meta?.env?.VITE_VAPID_PUBLIC_KEY as string | undefined)?.trim() || null;
  },
  rpc: (name, args) => supabase.rpc(name, args) as unknown as Promise<{ data: unknown; error: { message: string } | null }>,
  warn: (context, code) => {
    console.warn(`[WebPush] ${context} failed: ${code}`);
  },
});
