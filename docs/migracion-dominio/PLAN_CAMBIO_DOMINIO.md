# Plan Operativo Reutilizable de Cambio de Dominio y Marca

Este procedimiento está diseñado para ejecutarse tanto en la primera migración (`puntoencuentro.com.ar` → `Dominio B`) como en cualquier migración posterior (`Dominio B` → `Dominio C`), apoyándose en configuración centralizada sin refactorizar la lógica de negocio.

---

## Clasificación de Estado Actual

| Categoría | Elementos |
| :--- | :--- |
| **Implementado** | Configuración centralizada (`src/config/domainConfig.ts`), constructores de enlaces (`shareHelper.ts`, pantallas), blindaje anti-Host-Header-Injection en `api/open-encounter.ts`, metadatos HTML dinámicos por entorno (`vite.config.ts`), motor N→1 de redirección histórica (inactivo), redacción de tokens en logs, parametrización de marca/contacto en `web-push-worker`, auditoría de solo lectura (`scripts/auditar-dependencias-dominio.mjs`) y suite automatizada (`scripts/test-domain-migration-readiness.ts`). |
| **Diseñado pero pendiente** | Implementación del Mini-Sprint 2B (`PLAN_MINI_SPRINT_2B_PUENTE_IDENTIDAD.md`): puente dual de identidad (`MIGRACION_IDENTIDAD_DISENO.md`), recorridos de recuperación (`RECORRIDOS_UX_RECUPERACION_DOMINIO.md`), motor SQL unificado (`mensajes_encuentro`, `encuentros_contacto_whatsapp`, `participante_disponibilidades`, `coverage_requests`, `inbox_notifications`), paridad de tokens locales de invitados y banner de transición PWA/Web Push. |
| **Requiere nuevo dominio** | Definición definitiva de nombre marcario y dominio DNS, assets gráficos finales (`og-share.png`, íconos PWA, logotipo), actualización de `public/manifest.webmanifest`, `public/sw.js` (título visible) y textos visibles i18n/UI. |
| **Requiere validación externa** | Alta de registros DNS (`A`/`CNAME`/`CAA`), emisión de certificados TLS en Vercel, `Site URL` y `Redirect URLs` en Supabase Auth, orígenes/callbacks en Google Cloud Console OAuth, buzón de soporte/DMARC/SPF y pruebas reales de preview en WhatsApp/Telegram. |
| **Requiere autorización** | Cualquier cambio sobre Producción (`main`, proyecto Supabase `aurbicjwftjhwryhyjiq`), activación de redirecciones `302` o `308` y retiro futuro del puente de rescate. |

---

## Fases de Ejecución cuando se Defina el Nuevo Dominio

### Fase 0 — Pre-requisitos Legales y de Infraestructura (Sin impacto en usuarios)
1. Confirmar disponibilidad marcaria y registrar el nuevo dominio con renovación automática activa y bloqueo de transferencia (*registrar lock*).
2. Mantener **renovado y activo** el dominio histórico (`puntoencuentro.com.ar` y cualquier dominio intermedio previo) por un mínimo de **12 a 24 meses** (idealmente indefinido mientras existan invitaciones compartidas).
3. Configurar correo público de soporte (`soporte@<nuevo-dominio>`) con SPF, DKIM y DMARC válidos.

### Fase 1 — Ensayo Completo en Staging (`staging.<nuevo-dominio>`)
1. En Vercel (Preview / rama `staging`): asociar `staging.<nuevo-dominio>` sin quitar `staging.puntoencuentro.com.ar`.
2. En Supabase **Staging** (`wougfhfwqgmxhgvjqoua`): agregar `https://staging.<nuevo-dominio>` y `https://staging.<nuevo-dominio>/**` en **Authentication → URL Configuration → Redirect URLs** (conservando `https://staging.puntoencuentro.com.ar/**`).
3. En Google Cloud Console (credencial OAuth de Staging): agregar `https://staging.<nuevo-dominio>` en *Authorized JavaScript origins*.
4. Configurar en Vercel (entorno `staging`):
   - `VITE_APP_ENV=staging`
   - `VITE_APP_URL=https://staging.<nuevo-dominio>`
   - `VITE_REQUIRE_EXPLICIT_APP_URL=true`
   - `PUBLIC_APP_ORIGIN=https://staging.<nuevo-dominio>`
   - `LEGACY_APP_ORIGINS=https://staging.puntoencuentro.com.ar`
   - `ENABLE_LEGACY_DOMAIN_REDIRECT=false` (modo dual interactivo inicial)
5. Desplegar el puente de rescate de identidad y validar la matriz completa de QA en Staging (anónimos con y sin recursos, Google OAuth, links `/join`, `/invite`, `/coordination/*`, `/e/:id`, WhatsApp OG bot, PWA y Web Push).

### Fase 2 — Convivencia Dual y Rescate Activo en Producción (Cero Redirect Global)
*(Requiere autorización expresa del responsable del proyecto)*
1. Asociar `<nuevo-dominio>` en Vercel Production junto con `puntoencuentro.com.ar` (ambos sirviendo la aplicación con HTTPS válido, **sin redirección automática entre dominios**).
2. Agregar `https://<nuevo-dominio>` en Google Cloud OAuth y en Supabase Producción (`Redirect URLs`), **manteniendo** `https://puntoencuentro.com.ar` activo para no interrumpir sesiones ni callbacks vigentes.
3. Desplegar el banner de transición y rescate de identidad en `puntoencuentro.com.ar` mientras ambos orígenes son interactivos:
   - Usuarios Google: re-login limpio en `<nuevo-dominio>`.
   - Usuarios anónimos con encuentros o participaciones locales: rescate explícito verificado antes de abandonar el origen antiguo (`MIGRACION_IDENTIDAD_DISENO.md`).
   - Usuarios con PWA instalada: guía paso a paso (1° asegurar cuenta en nuevo sitio → 2° instalar nueva PWA y activar avisos → 3° desactivar avisos / desinstalar app anterior).

### Fase 3 — Cambio de Origen Canónico y *Soft Freeze* de Altas en el Dominio Saliente
1. Actualizar en Vercel Production:
   - `VITE_APP_URL=https://<nuevo-dominio>`
   - `VITE_REQUIRE_EXPLICIT_APP_URL=true`
   - `PUBLIC_APP_ORIGIN=https://<nuevo-dominio>`
   - `LEGACY_APP_ORIGINS=https://puntoencuentro.com.ar` (o lista separada por comas de todos los históricos `A, B`)
   - `VITE_APP_BRAND_NAME=<NuevaMarca>` y `APP_BRAND_NAME=<NuevaMarca>`
2. Actualizar `Site URL` en Supabase Auth al nuevo dominio canónico (conservando el histórico en `Redirect URLs` durante toda la ventana de transición).
3. **Bloqueo preventivo de nuevos encuentros en el dominio saliente (*Soft Freeze*):** A partir de esta fase, cuando la app carga en un origen perteneciente a `LEGACY_APP_ORIGINS`, las acciones de crear encuentros nuevos redirigen primero al flujo de traslado/nuevo dominio para que **ningún encuentro anónimo nuevo nazca en el dominio histórico**. Todo enlace compartido nuevo (`/join`, `/invite`, `/coordination/*`, `/e/:id`) apunta exclusivamente al nuevo dominio.

### Fase 4 — Redirecciones Temporales Selectivas (`302`) Protegiendo el Rescate Local
1. Una vez cumplida la ventana mínima preventiva (ver sección inferior), activar redirecciones **temporales `302` (`Cache-Control: no-store`) únicamente sobre rutas de invitación portadoras de token** (`/join/*`, `/invite/*`, `/coordination/*`, `/e/*`, `/invitation/*`), ya que esos enlaces transportan su propia credencial de capacidad en la ruta y funcionan de inmediato en `<nuevo-dominio>`.
2. **Protección obligatoria de rutas de titularidad local (`/`, `/meet/*`, `/auth/domain-bridge`):** No redirigir a nivel CDN/servidor `/` ni `/meet/*` mientras exista rescate activo; en su lugar, el cliente en el dominio histórico inspecciona `get_anonymous_upgrade_state()` y los tokens locales: si detecta recursos pendientes de migrar, presenta el puente de rescate en 1 clic; solo si el navegador está vacío o ya migrado (`already_migrated = true`), redirige automáticamente al nuevo dominio. Se mantienen siempre exentas `/auth/domain-bridge`, `/sw.js`, `/manifest.webmanifest` y callbacks OAuth en vuelo (`?code=`).
3. Monitorear métricas de enlaces antiguos abiertos, canjes del puente, errores OAuth y entregas Web Push durante al menos 2 a 4 semanas adicionales.

### Fase 5 — Corte Consolidado (`308` Directo N→1) y Retención Histórica
1. Pasar a **`308 Permanent Redirect`** global solo tras superar las compuertas cuantitativas de la estrategia preventiva (abajo), conservando método, path y query string 1:1.
2. **Regla para un tercer dominio futuro (`Dominio C`):**  
   Al migrar a `Dominio C`, actualizar la redirección de `Dominio A` para que apunte **directamente a `Dominio C`** y agregar `Dominio B → Dominio C` (`LEGACY_APP_ORIGINS=https://puntoencuentro.com.ar,https://dominio-b.tld`). Nunca encadenar `A → B → C`.

---

## Estrategia Preventiva de Convivencia para Proteger Sesiones Anónimas

Dado que un organizador anónimo que pierda definitivamente el acceso al navegador del origen anterior **no podrá recuperar criptográficamente su titularidad (`host_id`)** (`MIGRACION_IDENTIDAD_DISENO.md`, §4.5), es obligatorio cumplir estas 4 compuertas preventivas antes de retirar la interactividad del dominio saliente:

1. **Ventana mínima de convivencia dual interactiva:** Mínimo **30 días corridos** con ambos dominios activos, HTTPS válido y banner proactivo en `Home` y `DetailHost` del dominio anterior.
2. **Compuerta SQL de encuentros futuros anónimos en cero:** Prohibido activar redirección forzada sobre `/` o `/meet/*` mientras existan encuentros activos con fecha futura cuyo `host_id` sea una cuenta anónima aún no migrada (`NOT is_retired_anonymous_source(host_id)`), verificable mediante consulta agregada `COUNT(*)` sin exponer PII.
3. **Congelamiento temprano de altas nuevas en el origen viejo:** Desde Fase 3 (*Soft Freeze*) y de forma definitiva tras completar cada transferencia (`'anonymous_session_already_migrated'`), impedir que se generen recursos anónimos nuevos en el origen histórico.
4. **Criterio objetivo para el corte final `308`:** Recién cuando el conteo de encuentros futuros anónimos sin migrar sea `0` **y** los canjes diarios en `/auth/domain-bridge` sean nulos o residuales durante **14 días consecutivos**, habilitar `308` manteniendo el dominio histórico renovado con TLS activo por un mínimo de **12 a 24 meses**.
