# Plan Operativo Reutilizable de Cambio de Dominio y Marca

Este procedimiento está diseñado para ejecutarse tanto en la primera migración (`puntoencuentro.com.ar` → `Dominio B`) como en cualquier migración posterior (`Dominio B` → `Dominio C`), apoyándose en configuración centralizada sin refactorizar la lógica de negocio.

---

## Clasificación de Estado Actual

| Categoría | Elementos |
| :--- | :--- |
| **Implementado** | Configuración centralizada (`src/config/domainConfig.ts`), constructores de enlaces (`shareHelper.ts`, pantallas), blindaje anti-Host-Header-Injection en `api/open-encounter.ts`, metadatos HTML dinámicos por entorno (`vite.config.ts`), motor N→1 de redirección histórica (inactivo), redacción de tokens en logs, parametrización de marca/contacto en `web-push-worker`, auditoría de solo lectura (`scripts/auditar-dependencias-dominio.mjs`) y suite automatizada (`scripts/test-domain-migration-readiness.ts`). |
| **Diseñado pero pendiente** | Puente interactivo de rescate de sesiones anónimas entre orígenes (`MIGRACION_IDENTIDAD_DISENO.md`), banner de transición PWA/Web Push y actualización aditiva de `encuentro_mensajes.autor_user_id` en transferencia anónima. |
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
1. Asociar `<nuevo-dominio>` en Vercel Production junto con `puntoencuentro.com.ar` (ambos sirviendo la aplicación con HTTPS válido, **sin redirección entre dominios**).
2. Agregar `https://<nuevo-dominio>` en Google Cloud OAuth y en Supabase Producción (`Redirect URLs`), **manteniendo** `https://puntoencuentro.com.ar` activo para no interrumpir sesiones ni callbacks vigentes.
3. Desplegar el banner de transición y rescate de identidad en `puntoencuentro.com.ar` mientras ambos orígenes son interactivos:
   - Usuarios Google: re-login limpio en `<nuevo-dominio>`.
   - Usuarios anónimos con encuentros: rescate explícito verificado antes de abandonar el origen antiguo.
   - Usuarios con PWA instalada: guía paso a paso (1° asegurar cuenta en nuevo sitio → 2° instalar nueva PWA y activar avisos → 3° desactivar avisos / desinstalar app anterior).

### Fase 3 — Cambio de Origen Canónico para Nuevos Enlaces
1. Actualizar en Vercel Production:
   - `VITE_APP_URL=https://<nuevo-dominio>`
   - `VITE_REQUIRE_EXPLICIT_APP_URL=true`
   - `PUBLIC_APP_ORIGIN=https://<nuevo-dominio>`
   - `LEGACY_APP_ORIGINS=https://puntoencuentro.com.ar` (o lista separada por comas de todos los históricos `A, B`)
   - `VITE_APP_BRAND_NAME=<NuevaMarca>` y `APP_BRAND_NAME=<NuevaMarca>`
2. Actualizar `Site URL` en Supabase Auth al nuevo dominio canónico (conservando el histórico en `Redirect URLs` durante toda la ventana de transición).
3. A partir de este momento, **todo enlace compartido nuevo** (`/join`, `/invite`, `/coordination/*`, `/e/:id`) y toda URL canónica Open Graph apunta exclusivamente al nuevo dominio.

### Fase 4 — Redirecciones Temporales Reversibles (`302`)
1. Una vez verificada la adopción y habiendo dado ventana suficiente de rescate interactivo en el dominio antiguo, activar redirecciones **temporales `302`** para rutas de invitación y encuentros (`/join/*`, `/invite/*`, `/coordination/*`, `/e/*`, `/invitation/*`), **manteniendo exentas** `/auth/domain-bridge`, `/sw.js`, `/manifest.webmanifest` y callbacks OAuth en vuelo (`?code=`).
2. Monitorear métricas de enlaces antiguos abiertos, errores OAuth, entregas Web Push y reportes de soporte durante al menos 2 a 4 semanas.

### Fase 5 — Corte Consolidado (`308` Directo N→1) y Retención Histórica
1. Cuando la cohorte residual en el origen antiguo sea nula o despreciable, pasar la redirección de dominios históricos a **`308 Permanent Redirect`**, conservando método, path y query string 1:1.
2. **Regla para un tercer dominio futuro (`Dominio C`):**  
   Al migrar a `Dominio C`, actualizar la redirección de `Dominio A` para que apunte **directamente a `Dominio C`** y agregar `Dominio B → Dominio C` (`LEGACY_APP_ORIGINS=https://puntoencuentro.com.ar,https://dominio-b.tld`). Nunca encadenar `A → B → C`.
