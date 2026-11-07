# Arquitectura Reutilizable de Dominios, Marca, PWA y Web Push

**Módulo central:** `src/config/domainConfig.ts`  
**Consumidores:** `src/lib/shareHelper.ts`, `api/open-encounter.ts`, `vite.config.ts`, `src/lib/calendarExport.ts`, `src/App.tsx`.

---

## 1. Principio Rector: Separación entre Identidad de Negocio y Dominio Web

1. **Identificadores agnósticos del dominio:**  
   Los recursos en PostgreSQL se identifican mediante `encuentros.id` (UUID), `encuentros.public_token` (token opaco/UUID), `participantes.token_invitacion` (UUID) e `invitaciones_internas.id` (UUID). Ninguna tabla de negocio almacena el dominio web como parte de la clave primaria o foránea.
2. **Separación entre configuración activa e histórica:**  
   - **Configuración activa:** `PUBLIC_APP_ORIGIN` / `VITE_APP_URL` define el único origen canónico donde nacen los enlaces nuevos y hacia donde apuntan `og:url` y `<link rel="canonical">`.
   - **Configuración histórica (`LEGACY_APP_ORIGINS`):** lista plana de dominios propios retirados. Nunca se utiliza para generar enlaces nuevos ni como permiso de redirección abierta.
3. **Separación entre variables públicas de Vite y variables de servidor:**  
   - Cliente (`VITE_*`): exclusivamente metadatos públicos (`VITE_APP_ENV`, `VITE_APP_URL`, `VITE_APP_BRAND_NAME`, `VITE_APP_SHORT_NAME`, `VITE_PUBLIC_SUPPORT_EMAIL`, `VITE_VAPID_PUBLIC_KEY`). Jamás secretos.
   - Servidor (`process.env` / `Deno.env`): `PUBLIC_APP_ORIGIN`, `PUBLIC_STAGING_ORIGIN`, `LEGACY_APP_ORIGINS`, `ENABLE_LEGACY_DOMAIN_REDIRECT`, `VAPID_PRIVATE_KEY`, `WEB_PUSH_WORKER_SECRET`.

---

## 2. Aislamiento por Ambiente y Validación Fail-Closed

| Ambiente | Origen Canónico Actual | Reglas de Validación (`validateOriginForEnvironment`) |
| :--- | :--- | :--- |
| `production` | `https://puntoencuentro.com.ar` | Exige `https://`, dominio público válido (no IP), rechaza `localhost`, `staging.*` y `*.vercel.app`. |
| `staging` | `https://staging.puntoencuentro.com.ar` | Exige `https://`, rechaza `localhost` y rechaza el dominio de Producción. Indexación bloqueada (`noindex, nofollow`). |
| `preview` | `https://puntoencuentro-git-*.vercel.app` | Exige `https://`, rechaza `localhost` y rechaza el dominio de Producción. |
| `development` | `http://localhost:5173` | Admite `http://` únicamente sobre `localhost` / `127.0.0.1` / `[::1]`. |

### Compuertas de Seguridad en Build y Runtime
- **`validateBuildDomainConfig` (`vite.config.ts`):** Durante `vite build`, cualquier `VITE_APP_URL` malformada, con esquema inseguro (`http:`, `javascript:`, `data:`, `ftp:`), con credenciales (`user:pass@host`), subrutas o cruce Staging/Producción aborta inmediatamente la compilación (`DomainConfigError`).
- **Modo explícito de corte (`VITE_REQUIRE_EXPLICIT_APP_URL=true`):** Al habilitar esta bandera durante la migración al nuevo dominio, `vite build` falla cerrado si `VITE_APP_URL` está ausente o vacía.
- **Resolución Server-Side (`resolveServerCanonicalOrigin` en `api/open-encounter.ts`):** Nunca confía en encabezados `Host` o `X-Forwarded-Host` arbitrarios. Si llega un host no incluido en la lista blanca activa/histórica, ignora el encabezado y responde usando el origen HTTPS canónico registrado, eliminando vectores de *Open Redirect* y *OG Cache Poisoning*.

---

## 3. Matriz de Compatibilidad 1:1 de Rutas y Enlaces

Todas las rutas preservan su estructura exacta entre Dominio A, Dominio B y un eventual Dominio C:

| Ruta / Patrón | Propósito | Generador Centralizado | Sensibilidad del Parámetro |
| :--- | :--- | :--- | :--- |
| `/join/:public_token` | Invitación grupal de fecha fija | `buildGeneralInvitationUrl(token, 'fixed')` | Token compartido de encuentro privado (`redactSensitiveUrlForLogs` en logs) |
| `/invite/:token` | Invitación individual personalizada | `buildIndividualInvitationUrl(token, 'fixed')` | **Secreto de capacidad individual** (prohibido en logs/analítica/OG) |
| `/coordination/join/:token` | Invitación grupal para votar fechas | `buildGeneralInvitationUrl(token, 'coordination')` | Token compartido de coordinación privada |
| `/coordination/invite/:token` | Invitación individual para votar fechas | `buildIndividualInvitationUrl(token, 'coordination')` | **Secreto de capacidad individual** |
| `/invitation/:id` | Invitación interna entre usuarios autenticados | `buildPublicAppUrl('/invitation/' + id)` | Protegida por RLS/`auth.uid()` en backend |
| `/e/:id` | Enlace social canónico de encuentro abierto | `buildOpenEncounterUrl(id)` | Público (UUID); proyecta solo `open_public_title`, zona aproximada y fecha pública |
| `/?open_encounter=:uuid` | Deep link SPA de encuentro abierto | `buildOpenEncounterQueryUrl(id)` | Público (UUID); reescrito a `/api/open-encounter` solo para User-Agents de bots |
| `/meet/:id` | Panel de administración del organizador | `buildHostEncounterUrl(id)` | Requiere titularidad `host_id = auth.uid()` en RPC |
| `/share/:id` | Redirección interna hacia `/meet/:id?share=1` | Navegación interna React Router | Requiere titularidad `host_id = auth.uid()` |
| `/auth/domain-bridge` | Emisor del puente de identidad en dominio histórico (2B) | Uso interno de transición (`LEGACY_REDIRECT_EXEMPT_PATHS`) | Sin secretos en URL; protegido por feature flag y anti-framing |
| `/migrate-receive` | Receptor del puente de identidad en dominio vigente (2B) | Uso interno de transición (`MIGRACION_IDENTIDAD_DISENO.md`) | Transporte exclusivo `postMessage` con origen exacto o POST HTTPS |

---

## 4. Topología de Redirección N→1 sin Cadenas (Preparada, Inactiva Hoy)

Cuando en el futuro existan múltiples migraciones sucesivas (`Dominio A` → `Dominio B` → `Dominio C`):

```text
https://puntoencuentro.com.ar (Dominio A)  ──(1 salto directo)──┐
                                                                ├──▶ https://dominio-vigente-c.tld
https://marca-anterior-b.tld  (Dominio B)  ──(1 salto directo)──┘
```

- **Implementación lista en `resolveLegacyDomainRedirect` (`src/config/domainConfig.ts`):**
  - Desactivada por defecto (`ENABLE_LEGACY_DOMAIN_REDIRECT=false`).
  - Todos los dominios retirados se agregan en `LEGACY_APP_ORIGINS` apuntando directamente al `PUBLIC_APP_ORIGIN` vigente (cero cadenas `A → B → C`).
  - Conserva `pathname`, `search` y `hash` legítimos 1:1.
  - **Excepciones protegidas obligatorias:**
    1. `/auth/domain-bridge` y `/migrate-domain`: permiten ejecutar rescate de sesión anónima en el dominio antiguo antes del retiro definitivo.
    2. Callbacks OAuth/PKCE en vuelo (`?code=`, `?error_description=`, `#access_token=`, `#refresh_token=`): garantizan que ningún inicio de sesión comenzado en el origen anterior falle a mitad del handshake.
    3. `/sw.js` y `/manifest.webmanifest`: la especificación Service Worker prohíbe redirecciones en el script del worker.

---

## 5. Estrategia de PWA y Web Push ante Cambio de Origen

### 5.1 Impacto Real en Navegadores
- **Instalaciones PWA existentes:** Un cambio de eTLD+1 (ej. `.com.ar` → `.com` o `.app`) constituye un **sitio distinto (*cross-site*)**. La migración silenciosa de PWAs de Chromium aplica únicamente a orígenes *same-site*, por lo que la PWA instalada del dominio antiguo permanecerá anclada al origen viejo hasta que el usuario instale la nueva.
- **Service Worker (`public/sw.js`):** Es una ventaja arquitectónica mayor que `public/sw.js` **no posea handler `fetch` ni almacene caché** (limpia `caches.keys()` en `activate`). Esto impide que HTML/JS obsoleto quede atrapado en dispositivos instalados.
- **Permisos de Notificación y Suscripciones Push:** `Notification.permission` y `PushSubscription` (`endpoint`, `p256dh`, `auth`) están vinculados criptográfica y operativamente al origen del navegador y al par VAPID. En el nuevo dominio, `Notification.permission` comenzará en `'default'`.
- **Claves VAPID:** Las claves VAPID identifican al servidor de aplicación ante FCM/Mozilla/APNs, **no están atadas criptográficamente al nombre de dominio DNS** (salvo `VAPID_SUBJECT` informativo `mailto:`). **No se deben rotar `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`** por cambiar de dominio, evitando invalidar abruptamente dispositivos activos durante la ventana de convivencia.

### 5.2 Flujo Verificable de Transición PWA + Push (Diseñado para Etapa de Corte)
1. **Aviso contextual en la PWA antigua:** Detectar `window.location.host` perteneciente a `LEGACY_APP_ORIGINS` y mostrar un banner no destructivo invitando a migrar al nuevo dominio.
2. **Orden estricto — Primero identidad, después instalación:** Si el usuario posee sesión anónima con recursos o cuenta activa, ejecutar primero el rescate/login en el nuevo origen; **nunca pedir desinstalar la PWA vieja antes de confirmar la identidad en la nueva**.
3. **Instalación guiada de la nueva PWA:** Una vez autenticado en el nuevo dominio, ofrecer guía de instalación (`beforeinstallprompt` en Android/Desktop e instrucciones Safari «Compartir → Agregar a inicio» en iOS).
4. **Reactivación explícita de Web Push y deduplicación:**
   - Solicitar permiso únicamente tras gesto explícito del usuario (`webPushService.activate()`).
   - Para evitar **notificaciones duplicadas** en el mismo teléfono (suscripción activa del SW viejo + suscripción activa del SW nuevo para el mismo `user_id`):
     - Al completar la migración desde el origen viejo (mientras aún está accesible), invocar `webPushService.deactivateCurrentDevice()` en el origen viejo (`revocar_web_push_subscription_seguro`), **o**
     - Añadir un paso administrativo/usuario «Desactivar avisos en versión anterior» o registrar `app_origin` en `web_push_subscriptions` (migración aditiva opcional) para revocar automáticamente endpoints del mismo usuario originados en dominios retirados una vez confirmado un endpoint activo en el dominio nuevo.
5. **Seguridad de enlaces desde notificaciones:** `public/sw.js` ignora cualquier `deep_link` externo en el payload push y abre siempre `new URL('/?notifications=1', self.location.origin).href`, preservando seguridad *same-origin* en ambos dominios.
