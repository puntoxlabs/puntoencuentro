# Plan de Rollback y Reversibilidad de Migración de Dominio

**Principio esencial de reversibilidad:** Ningún paso irreversible (borrado de dominio antiguo, baja de TLS antiguo, eliminación de *Redirect URLs* anteriores en Supabase o emisión de redirecciones permanentes `301`/`308` cacheadas por los navegadores) se ejecuta antes de validar estabilidad completa en producción.

---

## 1. Reglas Preventivas que Garantizan un Rollback Limpio

1. **No rotar claves VAPID ni cambiar de proyecto Supabase:**  
   Al conservar el mismo proyecto Supabase y el mismo par de claves VAPID, todas las cuentas (`auth.users`), encuentros, tokens de invitación y suscripciones Web Push preexistentes siguen siendo 100% válidas en el dominio original si se revierte el cambio.
2. **Mantener ambos dominios en listas blancas durante la transición:**  
   Tanto `puntoencuentro.com.ar` como `<nuevo-dominio>` deben coexistir en:
   - Dominios con TLS activo en Vercel.
   - *Redirect URLs* de Supabase Auth.
   - *Authorized JavaScript origins* de Google Cloud OAuth.
3. **Usar `302 Found` (no cacheable) antes que `308`/`301`:**  
   Un `301` o `308` queda almacenado indefinidamente en la caché interna del navegador de los usuarios, impidiendo volver a abrir el dominio anterior aunque se revierta el servidor. Durante la etapa piloto y las primeras semanas solo se admiten redirecciones `302` con `Cache-Control: no-cache, no-store, must-revalidate`.
4. **No borrar ni renombrar claves de `localStorage` en el dominio anterior:**  
   Si se revierte al dominio anterior, los usuarios que conservaban su sesión o tokens locales en el origen original recuperan su estado de inmediato sin pérdida.

---

## 2. Procedimientos de Rollback según la Fase en Curso

### Escenario A — Fallo detectado en Staging (`staging.<nuevo-dominio>`)
- **Impacto en usuarios reales:** Cero (Producción aislada).
- **Acción inmediata:**
  1. Revertir `VITE_APP_URL` y `PUBLIC_APP_ORIGIN` en Vercel Staging a `https://staging.puntoencuentro.com.ar`.
  2. Redeploy del último commit estable de `staging`.
  3. Verificar `https://staging.puntoencuentro.com.ar/e/<uuid>` y login Google en Staging.

### Escenario B — Incidente durante Convivencia Dual o Cambio de `PUBLIC_APP_ORIGIN` (Antes de activar redirecciones)
- **Síntomas disparadores:** Fallo en login Google OAuth en `<nuevo-dominio>`, error TLS/DNS intermitente, previsualización rota en WhatsApp o anomalía en el puente de rescate.
- **Tiempo estimado de recuperación (RTO):** < 5 minutos.
- **Pasos exactos:**
  1. En **Vercel Production**: restaurar variables de entorno a los valores previos:
     - `VITE_APP_URL=https://puntoencuentro.com.ar`
     - `PUBLIC_APP_ORIGIN=https://puntoencuentro.com.ar`
     - `LEGACY_APP_ORIGINS=` (vacío)
     - `ENABLE_LEGACY_DOMAIN_REDIRECT=false`
     - Restaurar `VITE_APP_BRAND_NAME` / `APP_BRAND_NAME` si se habían modificado.
  2. En **Supabase Auth (Producción)**: restaurar `Site URL` a `https://puntoencuentro.com.ar` (**sin quitar** `https://<nuevo-dominio>/**` de *Redirect URLs*, para no romper a usuarios que hayan quedado con una pestaña abierta en el dominio nuevo).
  3. Promover/redesplegar en Vercel el deployment productivo inmediatamente anterior (o redeploy con las variables restauradas).
  4. Si algún usuario ya había iniciado sesión con Google o creado un encuentro en `<nuevo-dominio>`, **no pierde ningún dato**: la base de datos y su `auth.uid()` son los mismos, y los enlaces que haya compartido desde `<nuevo-dominio>` seguirán respondiendo si `<nuevo-dominio>` permanece conectado en Vercel (o redirigiendo temporalmente `302` de `<nuevo-dominio>` → `https://puntoencuentro.com.ar`).

### Escenario C — Incidente tras Activar Redirecciones Temporales `302`
- **Pasos exactos:**
  1. Desactivar inmediatamente la regla `302` en Vercel / `ENABLE_LEGACY_DOMAIN_REDIRECT=false` (como se emitió con `302` + `no-store`, los navegadores dejan de redirigir de forma instantánea).
  2. Ejecutar los pasos 1 a 4 del **Escenario B**.
  3. Mantener una redirección temporal inversa `302` desde `<nuevo-dominio>` hacia `https://puntoencuentro.com.ar` preservando path y query (`/:path*` → `https://puntoencuentro.com.ar/:path*`) para que cualquier invitación compartida durante la ventana del piloto continúe abriendo sin error `404`.

### Escenario D — Incidente en Web Push post-migración
- **Síntoma:** Usuarios no reciben notificaciones o reciben entregas duplicadas.
- **Pasos exactos:**
  1. Verificar en logs de `supabase/functions/web-push-worker` si existen errores HTTP `401`/`403` (configuración `VAPID_SUBJECT` malformada): restaurar `VAPID_SUBJECT=mailto:soporte@puntoencuentro.com.ar` en secretos de Edge Functions (efecto inmediato en el siguiente lote del outbox, sin redesplegar frontend).
  2. Como `web-push-worker` no revoca suscripciones ante `401`/`403` (solo ante `404`/`410`), ninguna suscripción de usuario habrá sido destruida por un error de configuración VAPID.

---

## 3. Verificación Post-Rollback Obligatoria

Tras ejecutar cualquier rollback, comprobar en orden:
1. `https://puntoencuentro.com.ar` carga Home con código HTTP `200` y certificado TLS válido.
2. Un enlace `/join/:public_token` y un enlace `/invite/:token` abren correctamente.
3. `curl -A "WhatsApp/2.24" https://puntoencuentro.com.ar/e/<uuid-valido>` devuelve `og:url` apuntando a `https://puntoencuentro.com.ar/e/<uuid-valido>`.
4. Inicio de sesión con Google completa ida y vuelta en `https://puntoencuentro.com.ar`.
5. Cero exposición de secretos o tokens privados en encabezados y respuestas.
