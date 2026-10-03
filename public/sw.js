/* PuntoEncuentro — Service Worker (Fase 3B: Fundación PWA + Delivery Web Push)
 *
 * Política deliberadamente mínima:
 *  - SIN caché de ningún tipo (ni app shell, ni llamadas de red, ni datos privados).
 *    No hay handler "fetch": toda petición va directo a la red, por lo que una versión
 *    vieja del JS nunca puede quedar atrapada por este worker.
 *  - Actualización inmediata: skipWaiting() + clients.claim().
 *  - Limpieza defensiva de cualquier Cache Storage que hubiese creado una versión previa.
 *  - Manejo seguro de eventos "push" y "notificationclick" con validación estricta same-origin.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch (_err) {
        // Cache Storage no disponible: nada que limpiar.
      }
      await self.clients.claim();
    })()
  );
});

/**
 * Valida de forma estricta que una URL relativa o absoluta pertenezca exactamente
 * al mismo origen y utilice protocolo http/https, mitigando variantes de bypass
 * (open redirects, backslashes, schemes no seguros como javascript: o data:).
 */
function sanitizeDeepLink(rawLink, baseOrigin) {
  if (typeof rawLink !== 'string' || !rawLink.trim()) {
    return '/';
  }
  try {
    const resolvedUrl = new URL(rawLink, baseOrigin);
    // 1. Debe coincidir exactamente con el origen actual (mismo origin)
    if (resolvedUrl.origin !== baseOrigin) {
      return '/';
    }
    // 2. Solo protocolos http o https (rechaza javascript:, data:, etc.)
    if (resolvedUrl.protocol !== 'https:' && resolvedUrl.protocol !== 'http:') {
      return '/';
    }
    return resolvedUrl.pathname + resolvedUrl.search + resolvedUrl.hash;
  } catch (_err) {
    return '/';
  }
}

// ============================================================
// Evento "push": recepción de mensajes Web Push
// ============================================================
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_err) {
      data = {
        title: 'PuntoEncuentro',
        body: 'Tenés una nueva notificación',
      };
    }
  }

  // Copy genérico por privacidad de pantalla de bloqueo y datos en tránsito
  const title = 'PuntoEncuentro';
  const body = 'Tenés una nueva notificación';

  const notificationOptions = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'pe-notification',
    data: {},
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, notificationOptions));
});

// ============================================================
// Evento "notificationclick": interacción neutral y segura
// ============================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Privacidad estricta: NO se confía en ningún deep_link del payload push.
  // Siempre abre/enfoca la bandeja genérica neutral (/?notifications=1),
  // garantizando que la visualización dependa exclusivamente de la sesión
  // activa en el cliente con RLS y control de acceso.
  const targetUrl = new URL('/?notifications=1', self.location.origin).href;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Si ya hay una ventana abierta en el mismo origen, enfocarla y navegar
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) {
            await client.navigate(targetUrl);
          }
          return;
        }
      }

      // Si no hay ventana abierta, abrir una nueva
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});
