/* PuntoEncuentro — Service Worker (Fase 3A: fundación PWA + Web Push)
 *
 * Política deliberadamente mínima:
 *  - SIN caché de ningún tipo (ni app shell, ni llamadas de red, ni datos privados).
 *    No hay handler "fetch": toda petición va directo a la red, por lo que una versión
 *    vieja del JS nunca puede quedar atrapada por este worker.
 *  - Actualización inmediata: skipWaiting() + clients.claim().
 *  - Limpieza defensiva de cualquier Cache Storage que hubiese creado una versión previa.
 *  - Sin promesa de funcionamiento offline.
 *
 * Extensión futura (Fase 3B): los eventos "push" y "notificationclick" se agregarán
 * aquí. En esta fase NO se muestran notificaciones.
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
