# Checklist Reutilizable de Migración de Dominio

Utilizar esta lista de control en cada migración (`Dominio A → B` o `Dominio B → C`). Cada ítem indica su estado actual respecto de esta preparación técnica.

**Leyenda de estados:**
- `[Implementado]` — Ya resuelto y probado en el repositorio.
- `[Diseñado - pendiente]` — Especificado técnicamente; requiere implementación antes del corte.
- `[Requiere nuevo dominio]` — Bloqueado hasta confirmar nombre de marca y dominio definitivo.
- `[Requiere validación externa]` — Configuración en paneles externos (Vercel, DNS, Supabase, Google).
- `[Requiere autorización]` — Operación sobre Producción que exige orden explícita.

---

## 1. Código y Configuración Centralizada
- [x] `[Implementado]` Módulo único de configuración de dominio, orígenes históricos y marca (`src/config/domainConfig.ts`).
- [x] `[Implementado]` Generadores de enlaces públicos centralizados (`src/lib/shareHelper.ts`, `DetailHost.tsx`, `CancelSummary.tsx`).
- [x] `[Implementado]` Separación estricta entre variables públicas `VITE_*` y variables de servidor (`PUBLIC_APP_ORIGIN`, `LEGACY_APP_ORIGINS`).
- [x] `[Implementado]` Validación fail-closed en `vite.config.ts` ante orígenes inválidos o mezcla Staging/Producción.
- [x] `[Implementado]` Script de auditoría de solo lectura disponible en `scripts/auditar-dependencias-dominio.mjs`.
- [ ] `[Requiere nuevo dominio]` Ejecutar `node scripts/auditar-dependencias-dominio.mjs --dominio <anterior> --marca <anterior>` y actualizar textos visibles i18n/UI, `manifest.webmanifest`, íconos e imagen `public/images/og-share.png` (1200x630 PNG).

## 2. DNS, TLS y Vercel
- [ ] `[Requiere nuevo dominio]` Registrar dominio nuevo con auto-renovación y *registrar lock*; verificar vigencia >= 12 meses del dominio anterior.
- [ ] `[Requiere validación externa]` Configurar registros DNS de `staging.<nuevo-dominio>` y `<nuevo-dominio>` hacia Vercel (incluyendo registros `CAA` si existen).
- [ ] `[Requiere validación externa]` Confirmar emisión activa de certificados TLS/HTTPS automáticos en Vercel tanto para el dominio nuevo como para todos los dominios históricos.
- [ ] `[Requiere validación externa]` Configurar en Vercel Staging: `VITE_APP_ENV=staging`, `VITE_APP_URL`, `VITE_REQUIRE_EXPLICIT_APP_URL=true`, `PUBLIC_APP_ORIGIN`, `LEGACY_APP_ORIGINS`.
- [ ] `[Requiere autorización]` Configurar variables homólogas en Vercel Production sin activar redirecciones permanentes en el día 1.

## 3. Supabase Auth y Google Cloud OAuth
- [ ] `[Requiere validación externa]` En Supabase **Staging** (`wougfhfwqgmxhgvjqoua`): añadir `https://staging.<nuevo-dominio>` y `https://staging.<nuevo-dominio>/**` en *Redirect URLs* sin borrar aún el subdominio anterior.
- [ ] `[Requiere validación externa]` En Google Cloud Console (OAuth Client): añadir el nuevo origen en *Authorized JavaScript origins* y confirmar que el callback de Supabase (`https://<project-ref>.supabase.co/auth/v1/callback`) permanece intacto.
- [ ] `[Requiere validación externa]` Actualizar nombre visible de la aplicación y dominio autorizado en la pantalla de consentimiento OAuth de Google (*OAuth Consent Screen*).
- [ ] `[Requiere validación externa]` Revisar plantillas de correo transaccional / SMTP en Supabase si se habilitan flujos por email en el futuro.
- [ ] `[Requiere autorización]` Replicar alta de *Redirect URLs* y posterior cambio de *Site URL* en Supabase **Producción** (`aurbicjwftjhwryhyjiq`).

## 4. Usuarios Anónimos y Puente de Identidad
- [x] `[Implementado]` Claves de `localStorage` existentes preservadas intactas en su origen.
- [x] `[Implementado]` Validación estricta de rutas post-login (`isValidPostAuthRedirect`), incluyendo `/e/:id` y `/?open_encounter=:uuid`.
- [x] `[Implementado]` Auditoría de seguridad y diseño definitivo del puente dual (`Anónimo → Google` y `Anónimo A → Anónimo B`), recorridos UX y matriz adversarial completados en Mini-Sprint 2A (`MIGRACION_IDENTIDAD_DISENO.md`, `RECORRIDOS_UX_RECUPERACION_DOMINIO.md`, `PLAN_MINI_SPRINT_2B_PUENTE_IDENTIDAD.md`).
- [ ] `[Diseñado - pendiente]` Ejecutar Mini-Sprint 2B: migración aditiva del motor unificado en Staging primero (asociación al destinatario `intended_target_user_id`, congelamiento post-migración `is_retired_anonymous_source`, serialización concurrente y cobertura sin pérdidas de `mensajes_encuentro`, `encuentros_contacto_whatsapp`, `participante_disponibilidades`, `solicitudes_encuentro_abierto` waitlist, `asistencia_controversias`, `coverage_requests` e `inbox_notifications`).
- [ ] `[Diseñado - pendiente]` Ejecutar Mini-Sprint 2B en frontend (bajo feature flag `false` por defecto): colector completo de tokens locales (`participated_tokens`, `puntoencuentro_guest_token_by_public_*`, `puntoencuentro_coordination_guest_token_by_public_*`), carga de participaciones en `Home.tsx` para sesiones anónimas, bloqueo de altas en sesiones ya migradas y rutas `/auth/domain-bridge` + `/migrate-receive`.

## 5. Enlaces, Redirecciones y Open Graph Social
- [x] `[Implementado]` `api/open-encounter.ts` valida estrictamente el origen canónico e ignora encabezados `Host` / `X-Forwarded-Host` no autorizados.
- [x] `[Implementado]` `resolveLegacyDomainRedirect` preparado para redirección directa N→1 sin cadenas (`Dominio A → C`, `Dominio B → C`) con exenciones OAuth/PKCE, puente y Service Worker.
- [ ] `[Requiere validación externa]` Probar vista previa real de `/e/:uuid` en WhatsApp (iOS/Android/Web), Telegram y validadores Open Graph sobre `staging.<nuevo-dominio>`, verificando cero exposición de `lugar_texto` o `link_virtual`.
- [ ] `[Requiere autorización]` Cumplir compuertas de convivencia preventiva (`PLAN_CAMBIO_DOMINIO.md`: >= 30 días dual interactivo + `0` encuentros futuros anónimos sin migrar), activar `302` selectivo primero y `308` únicamente cuando el rescate diario sea residual durante 14 días.

## 6. PWA y Web Push
- [x] `[Implementado]` `public/sw.js` opera sin caché de red (`fetch` ausente), limpia cachés previas en `activate` y navega exclusivamente a `/?notifications=1` en `self.location.origin`.
- [x] `[Implementado]` `supabase/functions/web-push-worker/index.ts` admite `APP_BRAND_NAME` y `PUBLIC_SUPPORT_EMAIL` / `VAPID_SUBJECT` por variables de entorno sin exigir rotación de claves VAPID.
- [ ] `[Diseñado - pendiente]` Desplegar banner de transición para instalaciones PWA antiguas guiando: 1° rescate/login en nuevo origen, 2° instalación nueva PWA, 3° reactivación explícita de Web Push y baja del dispositivo en el origen viejo para evitar entregas duplicadas.

## 7. Seguridad, Monitoreo y Rollback
- [x] `[Implementado]` Suite automatizada `scripts/test-domain-migration-readiness.ts`, `npx tsc -b` y `npm run build` en verde.
- [x] `[Implementado]` Sanitización de tokens sensibles mediante `redactSensitiveUrlForLogs`.
- [ ] `[Requiere validación externa]` Tomar snapshot documental (sin volcar secretos) de la configuración vigente de Vercel, DNS y Supabase antes del corte.
- [ ] `[Requiere validación externa]` Monitorear durante 72 h post-corte: tasa de errores OAuth, fallos `404/410/401/403` en `web-push-worker`, accesos residuales al dominio histórico y ausencias de cadenas de redirección (`curl -I`).
