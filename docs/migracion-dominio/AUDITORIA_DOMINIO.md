# Auditoría Técnica de Dependencias de Dominio y Marca

**Proyecto:** PuntoEncuentro / Proyecto Encuentros  
**Rama base auditada:** `staging` (commit de partida `0a41aa7`)  
**Rama de trabajo:** `chore/domain-migration-readiness`  
**Herramienta complementaria incorporada:** `scripts/auditar-dependencias-dominio.mjs` (solo lectura; 790 archivos escaneados).

---

## 1. Contraste entre `PLAN_MIGRACION_DOMINIO.md` y el Código Real

La inspección directa del código fuente y de las 155 migraciones SQL en `supabase/migrations/` confirmó los lineamientos generales del plan de referencia y reveló hallazgos críticos adicionales:

1. **`puntoencuentro_host_id` ya NO es la fuente de autoridad en PostgreSQL:**  
   - En `supabase/migrations/20260713145000_harden_host_auth_and_data_access.sql` se revocó y eliminó `transferir_encuentros_anonimos_seguro(uuid, uuid)`.
   - Todas las RPCs vigentes de anfitrión (`get_encuentros_host_seguro`, `get_detalle_host_seguro`, `actualizar_encuentro_seguro`, `cancelar_encuentro_seguro`, `eliminar_encuentro_seguro`) ignoran cualquier ID enviado por el cliente y validan exclusivamente `host_id = auth.uid()`.
   - Los anfitriones sin cuenta Google operan mediante **Supabase Anonymous Auth** (`ensureHostSession()` → `supabase.auth.signInAnonymously()`), cuya sesión JWT (`sb-<project-ref>-auth-token`) vive en el `localStorage` del origen web.
2. **Vulnerabilidad real en `api/open-encounter.ts` (corregida en esta misión):**  
   - Antes de esta intervención, `api/open-encounter.ts` construía `origin` directamente desde `req.headers['x-forwarded-host'] || req.headers['host']` y `req.headers['x-forwarded-proto']`, habilitando redirecciones `302` hacia hosts arbitrarios y posible contaminación de caché CDN en `og:url`. Se blindó con validación estricta de lista blanca (`resolveServerCanonicalOrigin`).
3. **Enlaces compartidos con origen disperso en pantallas (corregido en esta misión):**  
   - Además de `src/lib/shareHelper.ts`, existían concatenaciones manuales en `src/screens/DetailHost.tsx` (`import.meta.env.VITE_APP_URL || window.location.origin`) y `src/screens/CancelSummary.tsx` (`window.location.origin`). Todas fueron centralizadas en `shareHelper.ts` + `domainConfig.ts`.
4. **Cobertura real de `claim_anonymous_transfer` y tablas posteriores:**  
   - La RPC `public.claim_anonymous_transfer` (`20260928180000_anonymous_account_transfer.sql`) transfiere atómicamente 7 tablas hacia cuentas permanentes (`is_anonymous = false`), pero rechaza destinos anónimos (`permanent_account_required`) y no actualiza `autor_user_id` en `public.encuentro_mensajes` (tabla añadida en `20261020100000`).
5. **UID de eventos de calendario `.ics` (RFC 5545):**  
   - `src/lib/calendarExport.ts` genera `UID:pe-<id>@puntoencuentro.com.ar`. En RFC 5545 este sufijo actúa como *namespace* persistente de identidad de evento, no como URL navegable; cambiarlo duplicaría eventos ya agendados. Se desacopló explícitamente como `PERSISTENT_CALENDAR_UID_NAMESPACE` independiente del dominio web activo.

---

## 2. Inventario Exhaustivo de Dependencias de Dominio, URLs y Marca

| Área | Archivo y Ubicación | Impacto al Migrar Dominio/Marca | Criticidad | Acción Recomendada | Estado |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Configuración central | `src/config/domainConfig.ts` | Fuente única de origen canónico, marca, hosts confiables, orígenes históricos y redirección N→1 | Crítica | Mantener como única fuente de verdad para cliente, servidor y build | **Implementado** |
| Generación de links | `src/lib/shareHelper.ts` (`getBaseAppUrl`, `build*Url`) | Enlaces `/join/:token`, `/invite/:token`, `/coordination/*`, `/meet/:id`, `/e/:id` | Crítica | Delegar en `domainConfig.ts`; proyectar siempre origen canónico | **Implementado** |
| Enlaces de anfitrión | `src/screens/DetailHost.tsx` (líneas 668, 918) | Links enviados por WhatsApp/portapapeles al invitar o reemplazar encuentro | Alta | Sustituir concatenación manual por `buildGeneralInvitationUrl`, `buildHostEncounterUrl`, `buildIndividualInvitationUrl` | **Implementado** |
| Aviso de cancelación | `src/screens/CancelSummary.tsx` (línea 78) | Link `/join/:token` compartido al notificar cancelación | Media | Sustituir `window.location.origin` por `buildGeneralInvitationUrl` | **Implementado** |
| Coordinación host | `src/screens/DetailHostCoordination.tsx` (líneas 150, 172) | Link `/coordination/join/:token` centralizado; copy visible menciona `PuntoEncuentro` | Media | URL ya centralizada; actualizar copy de marca solo cuando se defina nueva marca | **Implementado (URL)** / **Requiere nuevo dominio (copy)** |
| Open Graph dinámico | `api/open-encounter.ts` | Previews WhatsApp/Telegram/redes y redirect 302 a SPA para encuentros abiertos | Crítica | Validar `Host` contra lista blanca (`resolveServerCanonicalOrigin`) y leer marca desde `resolveBrandConfig()` | **Implementado** |
| HTML base y SEO | `index.html` + `vite.config.ts` (`transformIndexHtml`) | `og:url`, `og:image`, `twitter:image`, `canonical`, `title`, `apple-mobile-web-app-title` | Alta | Conservar defaults estáticos actuales en `index.html` e inyectar canónica/marca por entorno en `vite build` | **Implementado** |
| No-index en Staging | `src/App.tsx` (línea 73) | Evitar indexación buscadores en subdominios de prueba | Media | Evaluar `isNonProductionEnvironment()` además de hostname `staging` | **Implementado** |
| OAuth Google | `src/contexts/AuthContext.tsx` (línea 538) | `signInWithOAuth` envía `redirectTo: window.location.origin` | Crítica | Mantener callback *same-origin* para no romper PKCE; registrar nuevo dominio en Supabase Auth y Google Cloud antes del corte | **Implementado (código)** / **Requiere nuevo dominio (paneles)** |
| Redirección post-auth | `src/hooks/usePostAuthRedirect.ts` | Navegación interna tras login Google y espera de `transferClaimStatus` | Alta | Admitir `/e/:id` y `/?open_encounter=:uuid` manteniendo bloqueo anti-open-redirect | **Implementado** |
| Identidad anónima | `src/lib/ensureHostSession.ts` + `supabase` (`sb-*-auth-token`) | Sesión JWT anónima aislada por origen del navegador | Crítica | Diseñar puente seguro de rescate antes de activar redirecciones globales | **Diseñado pero pendiente** |
| Clave host legacy | `src/lib/auth.ts` (`puntoencuentro_host_id`) y `src/lib/meetHostsStorage.ts` (`puntoencuentro_meet_hosts`) | Compatibilidad local de navegación en cliente; no otorga permisos en DB por sí sola | Alta | Prohibido renombrar o borrar claves; preservar compatibilidad | **Implementado (conservado)** |
| Tokens locales invitado | `src/lib/participatedTokens.ts`, `JoinGeneral.tsx`, `JoinCoordination/index.tsx` | Invitados sin cuenta guardan tokens en `localStorage` por origen | Alta | Conservar claves; contemplar rescate opcional de participaciones en puente migratorio | **Diseñado pero pendiente** |
| Manifiesto PWA | `public/manifest.webmanifest` | `name`, `short_name`, `id: "/"`, `scope: "/"`, íconos | Media | Conservar marca actual; al cambiar dominio tratar como nueva instalación PWA | **Requiere nuevo dominio** |
| Service Worker | `public/sw.js` + `src/lib/registerServiceWorker.ts` | Registro en `/sw.js`, sin caché `fetch`, click neutral a `/?notifications=1` | Alta | Mantener política sin caché y navegación `self.location.origin`; actualizar título visible al confirmar marca | **Implementado (seguridad)** / **Requiere nuevo dominio (copy)** |
| Web Push cliente | `src/services/webPushService.ts` | Suscripción ligada al SW del origen; requiere permiso explícito en nuevo dominio | Alta | No pedir permiso automático; guiar reactivación consciente en nuevo dominio | **Diseñado pero pendiente** |
| Web Push Worker | `supabase/functions/web-push-worker/index.ts` | `VAPID_SUBJECT` (`mailto:soporte@...`) y título genérico push | Media | Soportar `APP_BRAND_NAME` y `PUBLIC_SUPPORT_EMAIL` por entorno conservando par VAPID | **Implementado** |
| Exportación `.ics` | `src/lib/calendarExport.ts` | `UID:pe-<id>@puntoencuentro.com.ar` y `PRODID` | Baja | Mantener `calendarUidNamespace` persistente y parametrizar marca en `PRODID`/descripción | **Implementado** |
| Enrutamiento Vercel | `vercel.json` | Rewrites `/e/:id`, `/?open_encounter` para bots y SPA fallback | Alta | No activar redirecciones globales ahora; aplicar redirección N→1 en etapa de corte | **Implementado (sin redirect prematuro)** |
| Sanitización feedback/logs | `src/services/feedbackService.ts` + `redactSensitiveUrlForLogs` | Evitar exposición de tokens de invitación en telemetría o logs | Alta | Enmascarar rutas `/invite/*`, `/join/*`, `/coordination/*` y normalizar `/e/:id` | **Implementado** |
| Textos UI / i18n | `src/i18n/`, componentes UI (`Footer`, `Home`, modales) | ~120 apariciones visibles de `"PuntoEncuentro"` en textos de interfaz | Baja | No alterar hoy (Restricción 3); migrar por lote controlado cuando exista marca definitiva | **Requiere nuevo dominio** |
| Scripts QA / E2E | `scripts/e2e-*.ts`, `scripts/staging-qa-*.ts`, `scripts/check-*.ts` | Apuntan a `https://staging.puntoencuentro.com.ar` o `https://puntoencuentro.com.ar` | Baja | Correcto mientras el dominio actual siga activo; parametrizar al dar de alta `staging.<nuevo-dominio>` | **Requiere nuevo dominio** |

---

## 3. Inventario Completo de Almacenamiento en Navegador (`localStorage` y `sessionStorage`)

Los navegadores aíslan ambos almacenamientos por tupla `(scheme, host, port)`. Ninguna clave se transfiere automáticamente al cambiar de dominio:

### 3.1 `localStorage` (Persistente en el origen actual)

| Clave | Archivo Principal | Contenido y Rol | Sensibilidad | Estrategia ante Cambio de Dominio |
| :--- | :--- | :--- | :--- | :--- |
| `sb-<project-ref>-auth-token` | `@supabase/supabase-js` | JWT + `refresh_token` de sesión permanente (Google) o anónima | **Crítica (Secreta)** | Google: re-login limpio en nuevo origen. Anónimo: rescate vía puente server-side (jamás copiar JWT por URL). |
| `puntoencuentro_host_id` | `src/lib/auth.ts` | UUID local histórico de anfitrión | Media | No borrar ni renombrar. La titularidad real vive en `encuentros.host_id = auth.uid()`. |
| `puntoencuentro_meet_hosts` | `src/lib/meetHostsStorage.ts` | Mapa `{ [encuentroId]: hostId }` para hidratación rápida | Baja | Se reconstruye automáticamente desde el backend al autenticarse. |
| `participated_tokens` | `src/lib/participatedTokens.ts` | Array de `token_invitacion` individuales | **Alta (Capacidad)** | Si el usuario inició sesión, ya están vinculados vía `participantes.user_id`. Si no, rescatables vía enlace original o lote autenticado. |
| `encuentros_general` | `src/screens/JoinGeneral.tsx` | Mapa de respuestas a links grupales `/join/:public_token` | **Alta (Capacidad)** | Igual que `participated_tokens`. |
| `encuentros_coordination_general` | `src/screens/JoinCoordination/index.tsx` | Mapa de participaciones en coordinaciones grupales | **Alta (Capacidad)** | Igual que `participated_tokens`. |
| `pe_joined_<public_token>` / `pe_coord_joined_<token>` | `JoinGeneral.tsx` / `JoinCoordination` | Token individual emitido tras responder link general | **Alta (Capacidad)** | Igual que `participated_tokens`. |
| `puntoencuentro_shared_invites` | `src/screens/DetailHost.tsx` | Marca visual local de invitaciones ya compartidas por el host | Baja | Efímero de UX; aceptable reiniciar en nuevo origen. |
| `puntoencuentro_host_alias` | `src/lib/hostAliasStorage.ts` | Alias visible del organizador para mensajes de WhatsApp | Baja | Preferencia local no crítica; reingresable. |
| `puntoencuentro_post_event_minutes` | `src/lib/preferencesStorage.ts` | Ventana post-evento predeterminada del host | Baja | Preferencia local con default seguro (45 min). |
| `puntoencuentro_user_zones` | `src/services/openEncountersService.ts` | Caché local de `usuario_localidades` | Baja | Se sincroniza automáticamente desde `public.usuario_localidades` al iniciar sesión. |
| `pe_quiet_hours_prefs:*` | `src/services/userPreferencesService.ts` | Preferencia de horario silencioso | Baja | Sincronizada con `auth.users.user_metadata` en cuentas permanentes. |
| `wizard-storage`, `coordination-wizard-storage`, `pe-repeat-encounter-storage`, `pe_ai_draft_snapshot` | `src/store/*`, `src/lib/draftRecovery.ts` | Borradores locales de creación en curso | Media | Borradores transitorios; advertir en banner si existe borrador sin publicar. |
| `pe_push_prompt_*`, `pe_*_push_guide_*`, `pe_sound_visibility_*` | `src/components/home/alerts/antiNagging.ts` | Banderas anti-insistencia de avisos | Baja | Deseable que inicien limpias en el nuevo origen para guiar reactivación de Push. |
| `puntoencuentro_test_access_v1`, `app_storage_version` | `AccessGate.tsx`, `main.tsx` | Control de acceso de prueba y versión de esquema local | Baja | Se inicializan limpiamente en el nuevo dominio. |

### 3.2 `sessionStorage` (Efímero por pestaña y origen)

| Clave | Archivo Principal | Rol | Impacto Cross-Origin |
| :--- | :--- | :--- | :--- |
| `pe_pending_transfer_ticket` | `src/contexts/AuthContext.tsx` | Token secreto hexadecimal (64 chars) durante upgrade anónimo → Google *same-origin* | **Crítico:** Vive solo en la pestaña del origen iniciador; **NO sirve por sí solo para cruzar de Dominio A a Dominio B**. |
| `pe_transfer_claim_retries` | `src/contexts/AuthContext.tsx` | Contador de reintentos de `claim_anonymous_transfer` | Local a la pestaña de OAuth. |
| `post_auth_redirect` | `src/hooks/usePostAuthRedirect.ts` | Ruta interna validada a restaurar tras OAuth | Local al origen que inició el login. |
| `pending_participant_invitation_token` | `AuthContext.tsx`, `InviteGuest.tsx`, `JoinGeneral.tsx` | Vincula automáticamente un `token_invitacion` tras OAuth | Local al flujo OAuth *same-origin*. |
| `pending_open_request`, `pending_open_report`, `puntoencuentro_pending_intention`, `puntoencuentro_pending_avisame_draft`, `puntoencuentro_pending_ai_intent` | Pantallas de Home / Discovery | Intenciones pendientes mientras el usuario completa login Google | Locales a la pestaña donde se inició OAuth (exención de redirect obligatoria si OAuth está en vuelo). |
| `pe-usage-telemetry-session-v1`, `pe-qa-creation-session-v1` | Servicios de telemetría | Contexto anónimo de sesión sin PII | Se regenera por pestaña sin impacto funcional. |
