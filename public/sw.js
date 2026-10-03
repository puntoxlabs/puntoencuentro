/* PuntoEncuentro — Service Worker (Fase 3B: Fundación PWA + Delivery Web Push)
 *
 * Política deliberadamente mínima:
 *  - SIN caché de ningún tipo (ni app shell, ni llamadas de red, ni datos privados).
 *    No hay handler "fetch": toda petición va directo a la red, por lo que una versión
 *    vieja del JS nunca puede quedar atrapada por este worker.
 *  - Actualización inmediata: skipWaiting() + clients.claim().
 *  - Limpieza defensiva de cualquier Cache Storage que hubiese creado una versión previa.
 *  - Manejo seguro de eventos "push" y "notificationclick".
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
        body: event.data.text() || 'Tenés una nueva notificación',
        deep_link: '/',
      };
    }
  }

  const title = data.title || 'PuntoEncuentro';
  const body = data.body || 'Tenés una nueva notificación';
  const deepLink =
    typeof data.deep_link === 'string' &&
    data.deep_link.startsWith('/') &&
    !data.deep_link.startsWith('//')
      ? data.deep_link
      : '/';

  const notificationOptions = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || (data.notification_id ? `pe-notif-${data.notification_id}` : 'pe-general'),
    data: {
      deep_link: deepLink,
      notification_id: data.notification_id || null,
    },
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, notificationOptions));
});

// ============================================================
// Evento "notificationclick": interacción y deep link seguro
// ============================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const rawLink = event.notification.data?.deep_link;
  const safeLink =
    typeof rawLink === 'string' && rawLink.startsWith('/') && !rawLink.startsWith('//')
      ? rawLink
      : '/';

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      const targetUrl = new URL(safeLink, self.location.origin).href;

      // Si ya hay una ventana abierta en el mismo origen, enfocarla y navegar
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          await client.focus();
          if ('navigate' in client && client.url !== targetUrl) {
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
