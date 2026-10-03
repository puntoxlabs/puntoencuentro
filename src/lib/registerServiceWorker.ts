import {
  SERVICE_WORKER_SCOPE,
  SERVICE_WORKER_URL,
  type ServiceWorkerContainerLike,
} from '../services/webPushService';

/**
 * Registra el Service Worker (idempotente: el navegador reutiliza el registro existente).
 * Nunca lanza: un fallo de registro no debe romper la app.
 */
export async function registerServiceWorker(
  serviceWorker: ServiceWorkerContainerLike | undefined
): Promise<boolean> {
  if (!serviceWorker) return false;
  try {
    await serviceWorker.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE });
    return true;
  } catch {
    console.warn('[PWA] No se pudo registrar el Service Worker');
    return false;
  }
}

/**
 * Inicialización desde main.tsx. Solo en builds de producción (en dev el SW no aporta
 * y podría confundir el hot reload). Se difiere a `load` para no competir con el render.
 * NO solicita ningún permiso.
 */
export function initServiceWorker(): void {
  const meta = typeof import.meta !== 'undefined' ? (import.meta as unknown as { env?: { PROD?: boolean } }) : undefined;
  if (!meta?.env?.PROD) return;
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const run = () => {
    void registerServiceWorker(navigator.serviceWorker as unknown as ServiceWorkerContainerLike);
  };

  if (document.readyState === 'complete') {
    run();
  } else {
    window.addEventListener('load', run, { once: true });
  }
}
