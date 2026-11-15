# Auditoría Global Pre-QA, Hardening y Preparación de Release Candidate — PuntoEncuentro

**Fecha de emisión:** 2026-11-15  
**Entorno auditado como Release Candidate:** Staging (`staging` / `wougfhfwqgmxhgvjqoua` / `https://staging.puntoencuentro.com.ar`)  
**Entorno protegido (intocable en esta auditoría):** Producción (`main` / `aurbicjwftjhwryhyjiq` / `https://puntoencuentro.com.ar`)  
**Modalidad:** Solo lectura sobre entornos remotos; cambios exclusivamente locales y verificaciones determinísticas.

---

## 1. Resumen ejecutivo

### Estado real de Staging como futura Release Candidate
La base de código en la rama `staging` y su respaldo de base de datos en Supabase Staging (`wougfhfwqgmxhgvjqoua`) presentan una arquitectura madura **RPC-first con RLS restrictivo**, defensa en profundidad PRE-LAUNCH en 3 capas (`Vercel Deployment Protection` + `AccessGate` desacoplado de hostnames + `platform_access_control` / `qa_authorized_users`), aislamiento estricto frente a Producción y un puente de identidad cross-origin (`Mini-Sprint 2B`) ya implementado y aplicado en Staging con feature flags y kill switches SQL apagados en `false`.

### Línea base verificada en Git y Staging
- **Rama activa:** `staging` (`tracking origin/staging`, estado **`ahead 2`** antes de esta auditoría).
- **`HEAD` actual:** `d37fc95bb6e6e501f02b892f3d77f437c7bcdcea` (`d37fc95`).
- **`origin/staging` remoto:** `0fec19765a87d729bebfc204a5130ae37553fb6f` (`0fec197`).
- **Commits locales no pusheados preexistentes:**
  1. `80affde` (`test(qa): add automated web post-deploy and playwright browser test suites`)
  2. `d37fc95` (`docs(security): clarify Vercel SSO exclusivity and restrict automation secret distribution`)
- **Archivos untracked preexistentes:** `30` archivos previos (`INFORME_E2E-005.md`..`008.md`, `scratch/*`, `scripts/*`), preservados íntegramente sin alteración ni borrado.
- **Esquema en Staging (`wougfhfwqgmxhgvjqoua`):** Validado en modo solo lectura mediante `scripts/staging-preflight-domain-bridge.ts` (`283` rutas en catálogo OpenAPI de PostgREST, migraciones 2B-1 aplicadas `OK_MIGRADO`, RLS activo `PROTECTED_RLS`, `cross_origin_bridge_enabled = false`) y `scripts/audit-staging-security-state.ts` (`SATISFACTORIO`, kill switches `false`, `0` tickets activos pendientes).
- **Migraciones locales versionadas:** `160` archivos `.sql` cronológicos en `supabase/migrations/` (últimas: `20261112120000_platform_pre_launch_access_control_v1.sql` y `20261112130000_fix_solicitar_sumarse_canonical_contract.sql`, más subdirectorio `rollback/`).

### Dictamen de cierre técnico y publicación en Staging
**GO PARA ACTUALIZAR STAGING (Y CON ELLO HABILITAR QA MANUAL):**  
Staging no presenta vulnerabilidades P0 abiertas en código ni regresiones estructurales en los contratos críticos verificados tras el cierre técnico final (`tsc -b`, `vite build`, ESLint focalizado `0` errores en todos los archivos TS/JS tocados, `6/6` suites determinísticas/PGlite simuladas en entorno CI limpio sin `.env.local` y Playwright local `9/9 PASS`). La única precondición antes de iniciar el QA manual en `https://staging.puntoencuentro.com.ar` es **aprobar el commit de los 16 archivos de la lista blanca y el push hacia `origin/staging`** (que publicará los `2` commits locales previos `80affde`, `d37fc95` más los cambios de esta auditoría), y habilitar a los testers humanos (Vercel Team + clave de `AccessGate` + registro en `public.qa_authorized_users`).

---

## 2. Matriz de hallazgos

> **Criterios de estado:** `IMPLEMENTADO`, `VALIDADO LOCALMENTE`, `VALIDADO SOBRE STAGING REAL`, `PENDIENTE DE QA MANUAL`, `BLOQUEADO POR ENTORNO`, `NO IMPLEMENTADO`, `NO VERIFICADO`.  
> **Criterios de oportunidad:** `ANTES DEL QA MANUAL`, `ANTES DEL LANZAMIENTO PÚBLICO`, `DESPUÉS DEL LANZAMIENTO`, `PENDIENTE DE DECISIÓN DE PRODUCTO`, `BLOQUEADO POR VALIDACIÓN EXTERNA`.

| ID | Prioridad | Componente | Descripción | Evidencia | Impacto | Solución propuesta | Estado | Momento recomendado |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **F-01** | **P1** | `src/services/platformAccessService.ts` vs `scripts/qa-web-post-deploy.ts` | `qa-web-post-deploy.ts` invocaba `isPlatformPublicLaunchActive(deadClient)` para probar fail-closed de red, pero la función no aceptaba argumentos y consultaba siempre el singleton `supabase`. | Inspección de `platformAccessService.ts` y `qa-web-post-deploy.ts` (línea 356). | La prueba de caída de red contra cliente desconectado no aislaba el cliente inyectado y contaminaba/leía el cache global. | Agregar parámetro opcional `clientOverride?: PlatformAccessRpcClient` sin tocar cache global y cubrirlo con test unitario `1.5` en `test-access-gate-pre-launch.ts`. | `VALIDADO LOCALMENTE` | `ANTES DEL QA MANUAL` |
| **F-02** | **P2** | `src/App.tsx` | `<Routes>` carecía de ruta fallback `<Route path="*" />`, dejando pantalla vacía ante rutas inexistentes o enlaces rotos. | Inspección de `src/App.tsx` (líneas 114–161). | Mala experiencia de usuario si un enlace antiguo o mal escrito cae en una ruta desconocida. | Agregar componente `NotFoundFallback` en español con `EmptyState` y botón de retorno a `'/'` bajo `<Route path="*" />`. | `VALIDADO LOCALMENTE` | `ANTES DEL QA MANUAL` |
| **F-03** | **P2** | `index.html` | `<html lang="en" translate="no">` contradecía `manifest.webmanifest` (`"lang": "es-AR"`), `api/open-encounter.ts` (`lang="es"`) e `i18n.ts` (`lng: 'es'`). | Lectura directa de `index.html` línea 2. | Señal incorrecta a lectores de pantalla, navegadores y detectores de idioma. | Actualizar a `<html lang="es-AR" translate="no">`. | `VALIDADO LOCALMENTE` | `ANTES DEL QA MANUAL` |
| **F-04** | **P1** | `docs/PROPUESTA_LIMPIEZA_FIXTURES_QA_STAGING.md` | El documento proponía `DELETE` sobre `encuentros` y `SET estado = 'cancelado'`, violando la regla vigente `.agents/rules/staging-qa-fixtures.md` §6 y §8. | Lectura de `PROPUESTA_LIMPIEZA_FIXTURES_QA_STAGING.md` líneas 25–56 vs `staging-qa-fixtures.md` líneas 61–88. | Riesgo operativo de que un operador o agente ejecute borrados destructivos o altere los 26 fixtures protegidos. | Reescribir secciones 2 y 3 exigiendo `UPDATE SET is_open = false` conservando `estado = 'activo'`, allowlist de 26 UUIDs protegidos y `assertStagingEnvironment()`. | `IMPLEMENTADO` | `ANTES DEL QA MANUAL` |
| **F-05** | **P2** | `docs/DEPLOYMENT_ENVIRONMENTS.md` | La sección 2 afirmaba que Staging tenía acceso público sin Vercel login requerido. | Lectura de `DEPLOYMENT_ENVIRONMENTS.md` línea 35 vs `playwright-qa-runner.ts` (HTTP 307 a `vercel.com/login`). | Contradicción directa con el perímetro real de Staging y la guía `GUIA_ACCESO_QA_MANUAL_PRE_LANZAMIENTO.md`. | Documentar ref `wougfhfwqgmxhgvjqoua` y la defensa en 3 capas (`Vercel SSO` + `AccessGate` + `platform_access_control`). | `IMPLEMENTADO` | `ANTES DEL QA MANUAL` |
| **F-06** | **P2** | `docs/migracion-dominio/*` | `PLAN_CAMBIO_DOMINIO.md`, `CHECKLIST_MIGRACION_DOMINIO.md` y `PLAN_MINI_SPRINT_2B_PUENTE_IDENTIDAD.md` figuraban como "No iniciado / Diseñado pero pendiente" para Mini-Sprint 2B, pese a estar implementado y aplicado en Staging. | Migraciones `20261107120000` / `20261108163000` en Staging (`OK_MIGRADO`), `domainMigrationBridgeService.ts` y suites 20/20 + 59/59 PASS. | Riesgo de reimplementar un puente de identidad ya construido o desconocer los kill switches vigentes. | Actualizar estado a implementado y aplicado en Staging (desactivado por feature flags y kill switches en `false`). | `IMPLEMENTADO` | `ANTES DEL QA MANUAL` |
| **F-07** | **P2** | `docs/PLAN_PROMOCION_PRODUCCION_CORREGIDO_V1.md` | El §4 punto 1 seguía indicando editar `AccessGate.tsx` para chequear hostname/env, pese a que `AccessGate.tsx` ya fue desacoplado de hostnames vía `is_public_launch_open()`. | Lectura de `PLAN_PROMOCION_PRODUCCION_CORREGIDO_V1.md` línea 178 vs `AccessGate.tsx` y migración `20261112120000`. | Instrucción obsoleta podría inducir a reintroducir checks frágiles por hostname al promover a Producción. | Actualizar el checklist para indicar el control centralizado mediante `set_platform_launch_phase(true, ...)`. | `IMPLEMENTADO` | `ANTES DEL QA MANUAL` |
| **F-08** | **P3** | `README.md` | Contenía la plantilla genérica inicial de React + TypeScript + Vite sin documentación del proyecto. | Lectura de `README.md` (73 líneas). | Falta de punto de entrada claro para desarrolladores y QA respecto de entornos, scripts y reglas. | Reemplazar por documentación técnica de arquitectura, entornos, variables y comandos por categoría. | `IMPLEMENTADO` | `ANTES DEL QA MANUAL` |
| **F-09** | **P1** | `scripts/playwright-qa-runner.ts` | Fallaba al no existir el binario exacto `chromium_headless_shell-1254`, aun existiendo `chromium-1248` / `chromium_headless_shell-1248` en `%LOCALAPPDATA%\ms-playwright`. | Ejecución inicial fallida vs sonda `chrome.exe` `156.0.8078.4` exitosa. | Bloqueaba la ejecución automatizada local de Playwright sin descarga adicional. | Agregar `resolveChromiumLaunchOptions()` con fallback local y ampliar checks (`html[lang]`, overflow móvil, ruta `*`). | `VALIDADO LOCALMENTE` | `ANTES DEL QA MANUAL` |
| **F-10** | **P1** | Alineación Local vs Remoto (`origin/staging`) | `HEAD` (`d37fc95`) está 2 commits adelante de `origin/staging` (`0fec197`) y los cambios locales de esta auditoría siguen en el working tree. | `git status -sb` (`ahead 2`) y `git log -n 4`. | Lo actualmente desplegado en `https://staging.puntoencuentro.com.ar` no refleja los cambios locales ni los últimos ajustes. | Revisar `git diff` y autorizar `git commit` + `git push origin staging` tras esta auditoría (respetando restricción `NO COMMIT / NO PUSH` actual). | `BLOQUEADO POR ENTORNO` | `ANTES DEL QA MANUAL` |
| **F-11** | **P1** | `PWA-ANDROID-001` (`public/manifest.webmanifest`, `public/sw.js`, Vercel SSO) | Reporte previo de "No se puede instalar esta app" en Chrome Android. `manifest.webmanifest` (`id: "/"`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, íconos `any`/`maskable` 192/512) y `sw.js` (sin `fetch` handler) están íntegros localmente; en Staging, Vercel Authentication responde `307` hacia `vercel.com/login` a fetchers anónimos (incluido el instalador WebAPK/Play Services si no hereda cookie SSO). | Lectura de `manifest.webmanifest`, `sw.js` y redirect SSO observado en Playwright. | Impide validar instalación PWA nativa en Staging mientras Vercel Authentication proteja `/manifest.webmanifest` o sin cookie SSO en WebAPK; en Producción sin Vercel Auth el comportamiento diferirá. | **No modificado** en código según restricción. Probar manualmente en dispositivo Android físico (con sesión Vercel y evaluando Producción/Preview sin SSO antes de apertura pública). | `PENDIENTE DE QA MANUAL` | `ANTES DEL LANZAMIENTO PÚBLICO` |
| **F-12** | **P0** | Páginas legales (`/privacidad`, `/terminos`) y `docs/PROPUESTA_PAGINAS_LEGALES_V1.md` | Solo existe un borrador Markdown con marcadores `[PENDIENTE REVISIÓN HUMANA]` (razón social, CUIT, domicilio, jurisdicción) y **no existen rutas ni vistas implementadas** en `src/App.tsx`. | Búsqueda en `src/App.tsx` y lectura de `PROPUESTA_PAGINAS_LEGALES_V1.md`. | Bloqueante legal y requisito para OAuth consent screen de Google en lanzamiento público; **no** bloquea QA manual interno. | Completar datos jurídicos humanos y crear rutas públicas `/privacidad` y `/terminos` con enlaces visibles antes de abrir Producción. | `NO IMPLEMENTADO` | `ANTES DEL LANZAMIENTO PÚBLICO` (`PENDIENTE DE DECISIÓN DE PRODUCTO`) |
| **F-13** | **P2** | `src/App.tsx` (rutas experimentales `/preview/home-d`, `/preview/home-gsap`) | Expone vistas de comparación visual `PreviewHomeD` (`stitch`) y `PreviewHomeGsap` (`gsap`) en producción compilada, aunque con `<meta name="robots" content="noindex, nofollow">`. | Lectura de `src/App.tsx` líneas 118–119, `PreviewHomeD.tsx`, `PreviewHomeGsap.tsx`. | Superficie de UI experimental innecesaria en URLs públicas de Producción. | Deshabilitar `/preview/*` cuando `resolveAppEnvironment() === 'production'` o retirarlas tras cerrar diseño. | `IMPLEMENTADO` | `ANTES DEL LANZAMIENTO PÚBLICO` |
| **F-14** | **P2** | Rendimiento y Code-Splitting (`vite.config.ts` / `src/App.tsx`) | El build genera un chunk principal `dist/assets/index-DnTl9SCb.js` de `2,095.44 kB` (`521.46 kB` gzip) y emite 3 avisos `INEFFECTIVE_DYNAMIC_IMPORT` (`participantesService.ts`, `participatedTokens.ts`, `factualTrajectoryService.ts`). | Salida real de `npm --workspaces=false run build`. | Mayor tiempo de descarga/parseo en primer acceso móvil 3G/4G. | Aplicar `React.lazy()` en rutas secundarias (`/create/*`, `/internal/*`, `/coordination/*`) y revisar imports mixtos estáticos/dinámicos tras estabilizar el QA. | `NO IMPLEMENTADO` | `DESPUÉS DEL LANZAMIENTO` |
| **F-15** | **P2** | Calidad estática (`eslint`) y archivo residual raíz `test_supabase.js` | `eslint .` (con `qa-evidence/**` y `scratch/**` ya ignorados) reporta `3,933` errores preexistentes (`726` errores / `47` warnings en `src/`, mayormente `@typescript-eslint/no-explicit-any` y `no-empty`), más error de sintaxis en `test_supabase.js`. Todos los archivos modificados en esta auditoría (`App.tsx`, `platformAccessService.ts`, `playwright-qa-runner.ts`, `test-access-gate-pre-launch.ts`, `eslint.config.js`) tienen `0` errores y `0` warnings ESLint. | Salidas reales de `eslint .`, `eslint src` y `eslint` focalizado. | Deuda de tipado que impide usar `eslint .` como gate bloqueante inmediato en CI hasta sanearla; `tsc -b` ya pasa en `0`. | Usar `.github/workflows/ci-quality-gate.yml` con `tsc -b` + `build` + suites determinísticas ahora, y programar limpieza gradual de `any` + retiro de `test_supabase.js`. | `NO IMPLEMENTADO` | `DESPUÉS DEL LANZAMIENTO` |
| **F-16** | **P2** | Internacionalización (`src/i18n/locales/*`) | Conteo real de claves hoja: `es.json` = `975`, `en.json` = `972` (faltan 3), `pt-BR.json` = `722` (faltan `253` vs `es`). No hay selector `changeLanguage` expuesto en `src/`. | Conteo programático sobre `src/i18n/locales/*.json` y `git grep changeLanguage src/`. | Sin riesgo actual porque la UI corre fija en `es` con fallback `en`, pero bloquearía habilitar selector `pt-BR`. | Mantener sin selector de idioma público en V1; completar 253 claves si se habilita portugués. | `VALIDADO LOCALMENTE` | `DESPUÉS DEL LANZAMIENTO` |
| **F-17** | **P1** | Continuidad / Disaster Recovery (`docs/disaster-recovery.md` + Producción) | `disaster-recovery.md` referencia conteos históricos (`68` migraciones, `ai-interpret` como única Edge Function) frente a `160` archivos `.sql` de migración y `4` Edge Functions actuales (`ai-interpret`, `domain-events-worker`, `moderate-public-content`, `web-push-worker`). RPO/RTO de Producción siguen pendientes de validación humana antes de abrir al público. | Lectura de `docs/disaster-recovery.md` e inspección de `supabase/migrations/` y `supabase/functions/`. | Riesgo documental y necesidad obligatoria de correr `scripts/backup-production.bat` antes de tocar Producción. | Actualizar `disaster-recovery.md` y ejecutar respaldo preventivo + verificación PITR/plan en Dashboard Producción previo al lanzamiento. | `PENDIENTE DE QA MANUAL` | `ANTES DEL LANZAMIENTO PÚBLICO` |
| **F-18** | **P1** | Seguridad Backend, RLS, RPCs `SECURITY DEFINER`, Edge Functions y Open Graph (`api/open-encounter.ts`) | Controles críticos auditados: `auth.uid()` y `SET search_path = ''` en RPCs críticas, `can_access_pre_launch()` fail-closed en migración `20261112120000` + contrato canónico restaurado en `20261112130000`; `web-push-worker` con comparación timing-safe de `x-worker-secret`, payload genérico neutral en pantalla bloqueada, pre-check `verificar_delivery_activo_seguro` y revocación solo en `404/410`; `domain-events-worker` con `FOR UPDATE SKIP LOCKED`; `moderate-public-content` leyendo desde BD sin exponer logística privada; `ai-interpret` exigiendo `!user.is_anonymous`, anti-abuso y liberación de reserva si falla proveedor u `off_topic`; `api/open-encounter.ts` blindado contra Host Header Injection y fuga de `lugar_texto`/`link_virtual`. | Lectura de fuentes y migraciones + `staging-preflight-domain-bridge.ts` + `audit-staging-security-state.ts`. | Arquitectura de seguridad sólida; la ejecución real con usuarios OAuth de Google, entregas push en Android físico y scrapers reales de WhatsApp/Telegram requiere prueba humana integrada. | Mantener sin cambios de contrato y ejecutar el plan acotado de QA manual (Sección 7). | `VALIDADO SOBRE STAGING REAL` | `PENDIENTE DE QA MANUAL` (`BLOQUEADO POR VALIDACIÓN EXTERNA` para bots y APNs/FCM) |

### Síntesis de revisión por los 20 recorridos críticos y situaciones adversariales (Etapa B)
- **Sesión anónima, OAuth Google y Transfer Ticket:** `AuthContext.tsx`, `usePostAuthRedirect.ts` y `domainMigrationBridgeService.ts` cubren visitante sin sesión, sesión anónima bajo demanda (`ensureHostSession`), redirecciones post-auth con allowlist estricta (`isValidPostAuthRedirect`), transferencia `oauth_upgrade` y puente cross-origin (`ADV-01`..`ADV-20`). **Brecha a probar en humano:** callback OAuth real en navegador con Google Cloud Console (Staging/Producción) y retorno post-redirect tras `solicitar_sumarse`.
- **Ciclo de vida de encuentros, cupos, listas de espera, reconfirmación, mensajería, recordatorios y controversias:** Validado por suites locales PGlite dedicadas (`test-quotas-and-multi-seat.ts`, `test-waitlist-and-recovery.ts`, `test-attendance-disputes.ts`, `test-open-encounters-messages-dif-17.ts`, `test-lifecycle-notifications-h4-h6-h7.ts`, `test-pre-staging-verification-h1-h10.ts`), más migración de contrato `20261112130000` aplicada en Staging. **Caso límite clave restante:** validación E2E multi-dispositivo real (anfitrión + 2 postulantes en vivo) tras despliegue del build actualizado.

---

## 3. Mejoras implementadas localmente

### A. Archivos modificados o creados en esta auditoría (sin commit ni push)

| Archivo | Tipo de cambio | Descripción técnica | Validación aplicada |
| :--- | :--- | :--- | :--- |
| [index.html](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/index.html) | Modificado | Cambia `<html lang="en" translate="no">` a `<html lang="es-AR" translate="no">`. | `vite build` y Playwright local (`html[lang]="es-AR"` PASS). |
| [platformAccessService.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/services/platformAccessService.ts) | Modificado | Agrega parámetro opcional `clientOverride?: PlatformAccessRpcClient` en `isPlatformPublicLaunchActive()` para aislar pruebas fail-closed sin usar ni contaminar el cache global. | `tsc -b`, ESLint (`0` errores) y `test-access-gate-pre-launch.ts` (`10/10 PASS`). |
| [App.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/App.tsx) | Modificado | Agrega `NotFoundFallback` y `<Route path="*" element={<NotFoundFallback />} />` evitando pantallas en blanco en rutas inexistentes. | `tsc -b`, ESLint (`0` errores) y Playwright local (`/ruta-inexistente-qa-404` -> `"Página no encontrada"` + botón `"Ir al inicio"` PASS). |
| [playwright-qa-runner.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/playwright-qa-runner.ts) | Modificado | Agrega `resolveChromiumLaunchOptions()` (fallback a Chromium local en `%LOCALAPPDATA%\ms-playwright`), limpia 2 errores ESLint preexistentes (`const reqPath`, variable no usada) y verifica `lang="es-AR"`, overflow móvil `375x667` y ruta `*`. | `tsc -b`, ESLint (`0` errores) y ejecución completa `9/9 PASS`. |
| [test-access-gate-pre-launch.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-access-gate-pre-launch.ts) | Modificado | Agrega caso `1.5` validando `isPlatformPublicLaunchActive(deadClient)` fail-closed y no contaminación del cache; reemplaza 18 casts `as any` mediante interfaces tipadas `MutableGlobal` y `MutableSupabase`. | ESLint (`0` errores / `0` warnings) y ejecución con `run-tests.mjs`: `10/10 PASS`. |
| [eslint.config.js](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/eslint.config.js) | Modificado | Actualiza `globalIgnores(['dist'])` a `globalIgnores(['dist', 'qa-evidence/**', 'scratch/**'])`. | ESLint focalizado (`0` errores) y `npx --workspaces=false eslint . --quiet`. |
| [package.json](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/package.json) | Modificado | Conserva scripts previos y agrega scripts por categoría (`typecheck`, `test:unit:*`, `test:sql:*`, `qa:preflight:staging`, `qa:audit:staging`, `qa:browser:local`). | JSON válido verificado (`JSON.parse` PASS) y comandos verificados. |
| [ci-quality-gate.yml](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/.github/workflows/ci-quality-gate.yml) | Creado | Pipeline GitHub Actions de solo lectura (`contents: read`) para PR/push en `staging`/`main`: `npm ci --workspaces=false`, `tsc -b`, `vite build` y 6 suites determinísticas con `env` dummy y `VITE_IGNORE_LOCAL_ENV_FILES: 'true'` sin red ni secretos. | Simulación local de build y las 6 suites con `VITE_IGNORE_LOCAL_ENV_FILES=true` PASS (`0` fallos). |
| [README.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/README.md) | Modificado | Reemplaza plantilla genérica Vite por documentación real del stack, entornos, variables `.env.local` y comandos de validación. | Inspección directa. |
| [DEPLOYMENT_ENVIRONMENTS.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/DEPLOYMENT_ENVIRONMENTS.md) | Modificado | Corrige sección Staging con ref `wougfhfwqgmxhgvjqoua` y defensa PRE-LAUNCH en 3 capas. | Inspección directa. |
| [PROPUESTA_LIMPIEZA_FIXTURES_QA_STAGING.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/PROPUESTA_LIMPIEZA_FIXTURES_QA_STAGING.md) | Modificado | Sustituye propuestas inválidas (`DELETE` / `estado = 'cancelado'`) por higiene no destructiva (`is_open = false`, `estado = 'activo'`, protección de 26 fixtures). | Contrastado contra `.agents/rules/staging-qa-fixtures.md`. |
| [PLAN_CAMBIO_DOMINIO.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/migracion-dominio/PLAN_CAMBIO_DOMINIO.md) | Modificado | Actualiza estado de Mini-Sprint 2B a implementado y aplicado en Staging con kill switches/flags en `false`. | Contrastado contra código, migraciones y preflight. |
| [CHECKLIST_MIGRACION_DOMINIO.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/migracion-dominio/CHECKLIST_MIGRACION_DOMINIO.md) | Modificado | Marca ítems 2B backend/frontend completados y deja pendiente solo ensayo real cross-origin con dominio/entorno dual. | Contrastado contra código y pruebas. |
| [PLAN_MINI_SPRINT_2B_PUENTE_IDENTIDAD.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/migracion-dominio/PLAN_MINI_SPRINT_2B_PUENTE_IDENTIDAD.md) | Modificado | Actualiza cabecera de "No iniciado" a estado real implementado y aplicado en Staging (flags en `false`). | Contrastado contra código y pruebas. |
| [PLAN_PROMOCION_PRODUCCION_CORREGIDO_V1.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/PLAN_PROMOCION_PRODUCCION_CORREGIDO_V1.md) | Modificado | Corrige punto 1 del §4 para reflejar `AccessGate.tsx` ya desacoplado de hostnames vía `set_platform_launch_phase`. | Contrastado contra `AccessGate.tsx` y `20261112120000`. |
| [AUDITORIA_GLOBAL_PRE_QA_RELEASE_CANDIDATE.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/AUDITORIA_GLOBAL_PRE_QA_RELEASE_CANDIDATE.md) | Creado | Informe consolidado de auditoría global pre-QA y preparación de Release Candidate (este documento). | Verificado tras todas las pruebas ejecutadas. |

### B. Trabajo local preexistente preservado intacto
- **Commits locales previos (`ahead 2` de `origin/staging`):** `80affde` y `d37fc95`.
- **30 archivos untracked previos:** `INFORME_E2E-005.md`, `INFORME_E2E-006.md`, `INFORME_E2E-007.md`, `INFORME_E2E-008.md`, `scratch/host-test.png`, `scratch/postvalidate-phase4-staging.ts`, `scripts/lib/qa-suite-lock.ts` y 23 scripts en `scripts/` (`backup-pre-dif17-*`, `check-live-staging.mjs`, `comprehensive-staging-qa.ts`, `e2e-005..008-staging-runner.ts`, `e2e-phase4-staging-runner.ts`, scripts de estudio tipográfico/brand, etc.). Ninguno fue sobrescrito ni eliminado.

---

## 4. Resultados de pruebas

### Clasificación del inventario automatizado del repositorio
El directorio `scripts/` contiene `149` archivos `test-*.{ts,mjs,tsx}` y `83` scripts operativos/QA (`staging-*`, `validate-*`, `verify-*`, `e2e-*`, `qa-*`), distribuibles en:
1. **Unitarias y contratos JS/TS (sin red):** `test-access-gate-pre-launch.ts`, `test-domain-migration-readiness.ts`, `test-domain-bridge-frontend.ts`, `test-ai-input-abuse-gate.ts`, `test-domain.ts`, `test-fallback.ts`, `test-resilience-and-polling.tsx`, etc. (aislan telemetría mediante `scripts/setup-telemetry-mock.ts`).
2. **SQL local en memoria (`@electric-sql/pglite`):** `test-domain-identity-bridge.ts`, `test-schema-parity-guard.ts`, `test-pre-staging-verification-h1-h10.ts`, `test-postgres-concurrency.ts`, `test-quotas-and-multi-seat.ts`, `test-waitlist-and-recovery.ts`, `test-attendance-disputes.ts`, `test-ai-tables-permissions-gate.ts`, entre otras. *Limitación inherente:* PGlite emula PostgreSQL en memoria sin GoTrue HTTP real ni pooler PgBouncer de Supabase.
3. **E2E local con Playwright (`dist/` o Vite local):** `scripts/playwright-qa-runner.ts`, `scripts/run-e2e-local.ts`.
4. **Diagnósticos de solo lectura sobre Staging:** `scripts/staging-preflight-domain-bridge.ts`, `scripts/audit-staging-security-state.ts`, `scripts/preflight-pre-launch-staging.ts`.
5. **Integración y E2E con escritura sobre Staging (`[NO EJECUTADO — PROHIBIDO SIN AUTORIZACIÓN]`):** `scripts/qa-web-post-deploy.ts`, `scripts/comprehensive-staging-qa.ts`, `scripts/e2e-005..008-staging-runner.ts`, `scripts/e2e-domain-bridge-real-staging.ts`, `scripts/staging-qa-*.ts`.

### Ejecuciones reales observadas en esta auditoría

> Nota de entorno Windows: debido a `workspaces=true` en el `.npmrc` global del entorno, los comandos `npm`/`npx` deben ejecutarse con `--workspaces=false`.

| Suite / Comando | Entorno real | Resultado | Casos / Salida verificada | Limitaciones |
| :--- | :--- | :--- | :--- | :--- |
| `npx --workspaces=false tsc -b` | Local | **PASS (`exit 0`)** | Re-ejecutado en regresión final sin errores de tipo. | Chequeo estático de tipos; no valida edge functions Deno ni runtime remoto. |
| `npm --workspaces=false run build` | Local | **PASS (`exit 0`)** | Construido en `755ms` (`2578` módulos), `dist/index.html` `2.97 kB`, `index-CGJgONc-.js` `2,095.44 kB` (`521.46 kB` gzip). Emite 3 notices `INEFFECTIVE_DYNAMIC_IMPORT`. | — |
| `npm --workspaces=false run build` con `VITE_IGNORE_LOCAL_ENV_FILES=true` | Local (Simulación CI sin `.env.local`) | **PASS (`exit 0`)** | Construido en `750ms` (`2578` módulos) usando las variables `env` de `.github/workflows/ci-quality-gate.yml`. | Emulación local del runner Ubuntu (CI remoto ejecutará `npm ci --workspaces=false` con `node-version: '22'`). |
| `npx --workspaces=false eslint src/App.tsx src/services/platformAccessService.ts scripts/playwright-qa-runner.ts scripts/test-access-gate-pre-launch.ts eslint.config.js` | Local | **PASS (`exit 0`)** | `0` errores y `0` warnings en todos los archivos TS/JS/config tocados en la auditoría. | Focalizado únicamente en archivos modificados. |
| `npx --workspaces=false eslint src` / `eslint . --quiet` | Local | **FAIL (`exit 1`)** | Auditoría previa del repo completo: `src/` (`726` errores / `47` warnings) y repo completo con ignores (`3,933` errores preexistentes, incluyendo `test_supabase.js`). | Deuda técnica histórica previa a esta auditoría; no bloquea `tsc -b` ni `vite build` y queda fuera de alcance refactorizarla masivamente. |
| `node scripts/run-tests.mjs ./scripts/test-access-gate-pre-launch.ts` | Local (SSR/Mock, `VITE_IGNORE_LOCAL_ENV_FILES=true`) | **PASS (`exit 0`)** | `10/10` tests en `5` suites (`49.4563ms`), incluido nuevo test `1.5` de `clientOverride`. | Mockea `supabase.rpc` y `localStorage` en Node. |
| `node scripts/run-tests.mjs ./scripts/test-domain-migration-readiness.ts` | Local (`VITE_IGNORE_LOCAL_ENV_FILES=true`) | **PASS (`exit 0`)** | `12/12` bloques aprobados. | Valida configuración, `api/open-encounter.ts`, rutas y bundle sin despliegue real. |
| `node scripts/run-tests.mjs ./scripts/test-domain-bridge-frontend.ts` | Local (Mock RPC, `VITE_IGNORE_LOCAL_ENV_FILES=true`) | **PASS (`exit 0`)** | `59/59` tests en `15` suites (`208.1272ms`), incluido ensayo simulado dual `localhost:5173 <-> 127.0.0.1:5174`. | Mockea respuestas RPC y popups en Node; no reemplaza prueba cross-origin en dos pestañas reales. |
| `node scripts/run-tests.mjs ./scripts/test-domain-identity-bridge.ts` | Local (`PGlite`, `VITE_IGNORE_LOCAL_ENV_FILES=true`) | **PASS (`exit 0`)** | `20/20` tests (`ADV-01`..`ADV-20`, `11163.7682ms`) con migraciones reales aplicadas en PGlite. | Motor PGlite en memoria sin pooling ni HTTP GoTrue real. |
| `node scripts/run-tests.mjs ./scripts/test-schema-parity-guard.ts` | Local (`VITE_IGNORE_LOCAL_ENV_FILES=true`) | **PASS (`exit 0`)** | `4/4` tests (`85.6429ms`). | Inspecciona migraciones y mocks locales. |
| `node scripts/run-tests.mjs ./scripts/test-pre-staging-verification-h1-h10.ts` | Local (`PGlite`, `VITE_IGNORE_LOCAL_ENV_FILES=true`) | **PASS (`exit 0`)** | `3/3` bloques (`10916.2108ms`). | Motor PGlite en memoria. |
| `npx --workspaces=false tsx scripts/playwright-qa-runner.ts` | Local (`dist/` en `127.0.0.1:4173`) + lectura `staging.puntoencuentro.com.ar` | **PASS (`exit 0`)** | `9/9` checks PASS tras reconstruir `dist/` usando `chromium_headless_shell-1248`: SSO redirect en Staging (`vercel.com/login`), `html[lang]="es-AR"`, AccessGate visible, clave incorrecta rechazada, desbloqueo y persistencia tras reload, móvil `375x667` con `scrollWidth=375 <= clientWidth=375`, `/create`, y fallback `*` (`/ruta-inexistente-qa-404` -> `"Página no encontrada"` + botón `"Ir al inicio"` -> `/`). | La Parte 2 corre contra `dist/` local (no autenticado contra backend tras el AccessGate); usa binario `1248` de caché local en vez del `1254` ausente. |
| `npx --workspaces=false tsx scripts/staging-preflight-domain-bridge.ts` | Staging remoto (Solo lectura) | **PASS (`exit 0`)** | `[DIAGNÓSTICO POST-MIGRACIÓN SATISFACTORIO]`, `283` rutas OpenAPI, estructuras base + Mini-Sprint 2B-1 `OK_MIGRADO`, RLS `PROTECTED_RLS`, kill switch `false`. | Solo lectura de catálogo y flags; no ejecuta escrituras transaccionales. |
| `npx --workspaces=false tsx scripts/audit-staging-security-state.ts` | Staging remoto (Solo lectura) | **PASS (`exit 0`)** | `SATISFACTORIO`, ambos kill switches en `false`, `0` tickets pendientes/no expirados, 6/6 RPCs en PostgREST, `0` manifiestos residuales. | Muestra cuentas QA/anónimas históricas previas en `auth.users`. |
| Resto de suites `node scripts/run-tests.mjs` (~143 archivos restantes) y runners con escritura en Staging (`qa-web-post-deploy.ts`, `e2e-005..008`) | — | **NO EJECUTADAS** | — | No ejecutadas por restricción de no mutar Staging y priorización selectiva de Etapa D2. |

---

## 5. Clasificación de pendientes y estado operativo

### 5.1 Listo para QA manual
- **Base funcional y seguridad PRE-LAUNCH verificadas:** `tsc -b`, `vite build`, ESLint focalizado (`0` errores en los `5` archivos TS/JS/config tocados), `6/6` suites unitarias/PGlite (`108` casos acumulados entre `test-access-gate-pre-launch.ts`, `test-domain-migration-readiness.ts`, `test-domain-bridge-frontend.ts`, `test-domain-identity-bridge.ts`, `test-schema-parity-guard.ts` y `test-pre-staging-verification-h1-h10.ts`), y Playwright local `9/9 PASS` (`html[lang]="es-AR"`, AccessGate fail-closed, viewport móvil `375x667`, ruta profunda `/create` y fallback 404 `*`).
- **Precondición operativa inmediata (no de código):** aprobar commit y push hacia `origin/staging` con la lista blanca de la Sección 10, invitar testers al Vercel Team, entregar clave de `AccessGate` por canal privado y autorizar cuentas en `public.qa_authorized_users` según [GUIA_ACCESO_QA_MANUAL_PRE_LANZAMIENTO.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/GUIA_ACCESO_QA_MANUAL_PRE_LANZAMIENTO.md).

### 5.2 Pendiente de QA manual
- **`PWA-ANDROID-001` (`PENDIENTE DE QA MANUAL`):** comprobar instalación PWA nativa en Chrome Android físico (comparando sesión Vercel autenticada en Staging vs comportamiento sin Vercel SSO en `manifest.webmanifest` / `sw.js`). No modificado en código durante esta auditoría.
- **Google OAuth real + upgrade anónimo → permanente:** validar callback OAuth en navegador, conservación de encuentros/mensajes/participaciones y resolución de `TransferClaimBanner`.
- **Web Push en Android físico bloqueado (Nivel 4):** verificar recepción de notificación genérica neutral (`"Tenés una nueva notificación"`), badge y apertura de `/?notifications=1` sin pisado entre avisos.
- **Preview social Open Graph real (`api/open-encounter.ts`):** validar tarjetas en WhatsApp/Telegram con zona orientativa y cero fuga de dirección exacta o link virtual, más carga de fallback `*` ante URL inexistente.
- **Concurrencia multi-usuario y moderación en vivo:** cupos múltiples, lista de espera FIFO, mensajería interna y reportes de moderación usando prefijo `[QA-TMP]` y cierre no destructivo (`is_open = false`).
- **Puente cross-origin real (`Mini-Sprint 2B`):** cuando se habilite ensayo dual entre dos orígenes HTTPS, validar popup bloqueado, fallback manual 3 min e inventario mixto.

### 5.3 Bloqueante de lanzamiento (a Producción pública)
> Estos ítems **no bloquean** actualizar Staging ni iniciar el QA manual; **sí bloquean** abrir `https://puntoencuentro.com.ar` al público general.
1. **Páginas legales (`/privacidad` y `/terminos`):** completar datos jurídicos humanos en `PROPUESTA_PAGINAS_LEGALES_V1.md` e implementar las vistas/rutas reales en `src/App.tsx` (también necesario para OAuth consent screen público).
2. **Resolución y verificación de `PWA-ANDROID-001` fuera de Vercel Authentication:** validar instalación nativa sin redirect 307 sobre `/manifest.webmanifest` antes de apertura pública.
3. **Restricción o retiro de rutas experimentales `/preview/home-d` y `/preview/home-gsap`:** deshabilitarlas cuando `resolveAppEnvironment() === 'production'` o retirarlas tras cerrar el diseño.
4. **Respaldo preventivo y auditoría de Producción (`aurbicjwftjhwryhyjiq`):** ejecutar `.\scripts\backup-production.bat`, confirmar extensiones `pg_cron`/`pg_net`, secretos de las 4 Edge Functions, `vault.decrypted_secrets` y `supabase db push --dry-run`.
5. **Apertura controlada (`PUBLIC-LAUNCH`):** mantener `public_launch_active = false` durante todo el QA en Staging y habilitar `SELECT public.set_platform_launch_phase(true, ...)` en Producción solo tras aprobación explícita.

### 5.4 Mejora posterior (no bloqueante)
1. **Saneamiento gradual de deuda ESLint histórica:** reducir los `726` errores (`47` warnings) heredados en `src/` y el total de `3,933` errores preexistentes (principalmente `@typescript-eslint/no-explicit-any` y `test_supabase.js` en raíz) hasta poder incorporar `eslint` al gate CI.
2. **Optimización de bundle y code-splitting:** dividir el chunk principal de `2,095.44 kB` (`521.46 kB` gzip) mediante `React.lazy()` en rutas secundarias y eliminar los 3 avisos `INEFFECTIVE_DYNAMIC_IMPORT`.
3. **Completitud i18n `pt-BR` e historial documental DR:** completar las `253` claves faltantes en `pt-BR.json` antes de habilitar selector de idioma, y alinear conteos históricos en `docs/disaster-recovery.md` y el banner UX de transición PWA de cambio de dominio.

---

## 6. Preparación del cambio de dominio

| Pieza / Capacidad | Diseñado | Implementado | Aplicado en Staging | Probado (PGlite / Unit) | Desactivado por Flag / Kill Switch | Pendiente validación 2 orígenes reales | Pendiente del dominio definitivo |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Config centralizada de orígenes y marca (`src/config/domainConfig.ts`, `vite.config.ts`) | Sí | Sí | N/A (build/frontend) | Sí (`12/12` bloques `test-domain-migration-readiness.ts`) | N/A (canónico actual vigente) | No (usa env vars estándar) | `VITE_APP_URL`, `PUBLIC_APP_ORIGIN`, `LEGACY_APP_ORIGINS`, marca nueva |
| Constructores de links centralizados y Open Graph (`shareHelper.ts`, `api/open-encounter.ts`) | Sí | Sí | N/A (serverless Vercel) | Sí (`test-domain-migration-readiness.ts`) | N/A | Prueba real bots WhatsApp/Telegram sobre dominio nuevo | Dominio destino + `public/images/og-share.png` nuevo |
| Motor N→1 de redirección histórica (`resolveLegacyDomainRedirect`, sin `A→B→C`) | Sí | Sí | N/A | Sí (`test-domain-migration-readiness.ts`, `test-domain-bridge-frontend.ts`) | Sí (`ENABLE_LEGACY_DOMAIN_REDIRECT=false`) | Validar headers/status `302`/`308` tras convivencia | Lista final `LEGACY_APP_ORIGINS` |
| Esquema SQL puente dual 2B (`domain_migration_settings`, `flow_mode`, `intended_target_user_id`, `is_retired_anonymous_source`, 6 RPCs) | Sí | Sí | **Sí** (`20261107120000`, `20261108163000`, `OK_MIGRADO` en OpenAPI Staging) | Sí (`20/20` `ADV-01..20` en `test-domain-identity-bridge.ts`) | Sí (`cross_origin_bridge_enabled = false`, `cross_origin_manual_enabled = false`) | **Sí** (`e2e-domain-bridge-real-staging.ts` con dos orígenes HTTPS) | No (independiente del nombre del dominio) |
| Frontend puente dual (`/auth/domain-bridge`, `/migrate-receive`, `domainMigrationBridgeService.ts`, colector 6 fuentes de tokens) | Sí | Sí | Listo en rama `staging` | Sí (`59/59` `test-domain-bridge-frontend.ts`) | Sí (`VITE_ENABLE_DOMAIN_MIGRATION_BRIDGE=false`, `VITE_ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK=false`) | **Sí** (popup/postMessage + fallback manual en navegador real entre 2 orígenes) | Activar `VITE_MIGRATION_TARGET_ORIGIN` al migrar |
| Banner UX de transición PWA + Web Push + guía de re-activación | Sí | No (pendiente UX final) | No | No | Sí | Sí | **Sí** (copy, nombre de marca e íconos nuevos en `manifest.webmanifest` / `sw.js`) |

---

## 7. QA manual optimizado

La siguiente lista concentra **exclusivamente** lo que no puede sustituirse con PGlite ni mocks locales:

| Prioridad | Caso Manual | Qué validar exactamente | Prerrequisitos |
| :--- | :--- | :--- | :--- |
| **1 (Alta)** | **`PWA-ANDROID-001` (Instalación PWA en Chrome Android)** | Verificar si Chrome Android ofrece "Instalar aplicación" (en vez de "Agregar a pantalla principal" o error) y comparar entre Staging tras login Vercel vs despliegue sin Vercel SSO. Confirmar que el Service Worker queda activo y el `manifest.webmanifest` responde HTTP 200 JSON sin redirect 307. | Dispositivo Android real + Chrome actualizado. |
| **2 (Alta)** | **Google OAuth + Upgrade Anónimo → Permanente** | Crear encuentro como sesión anónima autorizada QA → tocar "Continuar con Google" → completar login Google → verificar llegada a `/` / `/solicitudes`, resolución automática de `TransferClaimBanner` (`transferClaimStatus === 'success'`) y conservación 100% del encuentro, mensajes y participaciones. | Tester dado de alta en Vercel SSO y `qa_authorized_users` + Origin autorizado en Google OAuth. |
| **3 (Alta)** | **Web Push en Android Físico (Nivel 4)** | Suscribirse desde perfil/ajustes → activar prueba QA → bloquear pantalla y esperar 1–2 min → verificar banner nativo `"PuntoEncuentro / Tenés una nueva notificación"` (sin fuga de `lugar_texto`), badge nítido y que al tocar abra `/?notifications=1`. Repetir con 2 avisos críticos seguidos para comprobar no pisado (`tag: undefined`). | Android físico fuera de modo ahorro extremo / notificaciones permitidas. |
| **4 (Media)** | **Preview Social Open Graph real (`api/open-encounter.ts`)** | Compartir enlace `/e/:uuid` de un encuentro abierto aprobado (`[QA-STABLE]`) en un chat privado de WhatsApp y Telegram; comprobar título, zona orientativa (`open_public_zone`), imagen `og-share.png` y **cero exposición** de dirección exacta o link virtual; validar que un toque desde humano abre la SPA y URLs inválidas cargan `NotFoundFallback` (`*`). | Encuentro abierto `[QA-STABLE]`, enlace público tras bypass o en validación sin SSO edge. |
| **5 (Media)** | **Concurrencia Multi-Usuario y Moderación Real** | En dos dispositivos simultáneos (Anfitrión A y Postulante B permanente): solicitud de múltiples plazas, agotamiento de último cupo / ingreso a lista de espera `waitlist_waiting`, retiro voluntario y oferta automática FIFO; probar mensajería interna y envío de reporte de moderación. Usar prefijo `[QA-TMP]` y cerrar con `is_open = false` al terminar. | Dos sesiones QA distintas autorizadas en `qa_authorized_users`. |
| **6 (Baja)** | **Puente Cross-Origin Real (Cuando se habilite ensayo)** | Solo cuando se habilite temporalmente en prueba dual (`localhost:5173 <-> 127.0.0.1:5174` o `vercel.app <-> staging`), probar popup bloqueado + fallback manual 3 min y traslado con inventario mixto. | Variables `VITE_ENABLE_DOMAIN_MIGRATION_*` en entorno de prueba específico. |

---

## 8. Preparación de promoción a Producción

> **Invariantes absolutas:** **NO copiar datos ni fixtures** desde Staging (`wougfhfwqgmxhgvjqoua`) hacia Producción (`aurbicjwftjhwryhyjiq`). En PostgreSQL / Supabase CLI, las migraciones secuenciales **NO constituyen una única transacción atómica global**: cada archivo `.sql` se ejecuta en su propia transacción y un fallo parcial deja confirmadas las migraciones previas. Ver detalle completo en [PLAN_PROMOCION_PRODUCCION_CORREGIDO_V1.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/PLAN_PROMOCION_PRODUCCION_CORREGIDO_V1.md).

1. **Respaldo preventivo obligatorio:** Ejecutar `.\scripts\backup-production.bat` y validar `BACKUP OK` + `SHA256SUMS.txt` + segunda copia externa cifrada antes de cualquier DDL/despliegue.
2. **Inspección de migraciones remotas:** Ejecutar `npx --workspaces=false supabase migration list --project-ref aurbicjwftjhwryhyjiq` para conocer el historial real en Producción (no usar `migration repair` salvo ausencia comprobada de `20260424000000` con tablas previas existentes).
3. **Verificación de extensiones en Supabase Dashboard Prod:** Confirmar `pg_cron` y `pg_net` en estado **Active** antes de `db push`.
4. **Verificación de secretos en Edge Functions (Producción):** Confirmar `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `WEB_PUSH_WORKER_SECRET` y `DOMAIN_EVENTS_WORKER_SECRET`.
5. **Configuración de `vault.decrypted_secrets` en Producción:** Registrar `web_push_worker_url`, `web_push_worker_secret`, `domain_events_worker_url` y `domain_events_worker_secret` apuntando a `aurbicjwftjhwryhyjiq.supabase.co`.
6. **Validación de Google OAuth y Supabase Auth:** Confirmar `Site URL = https://puntoencuentro.com.ar`, Redirect URLs y orígenes/callbacks autorizados en Google Cloud Console.
7. **Simulación sin mutación:** Ejecutar `npx --workspaces=false supabase db push --project-ref aurbicjwftjhwryhyjiq --dry-run` y auditar cada archivo propuesto.
8. **Aplicación controlada de migraciones:** Ejecutar `npx --workspaces=false supabase db push --project-ref aurbicjwftjhwryhyjiq` (recordando ausencia de rollback automático global ante fallo intermedio; corregir con *forward fix* aditivo si ocurriera).
9. **Despliegue de las 4 Edge Functions:** `ai-interpret`, `domain-events-worker`, `moderate-public-content` y `web-push-worker` con `--project-ref aurbicjwftjhwryhyjiq`.
10. **Páginas legales y limpieza pre-pública:** Verificar rutas `/privacidad` y `/terminos` aprobadas y restringir `/preview/*` fuera de Producción antes del merge final.
11. **Promoción Git (`staging` → `main`) y variables Vercel Production:** Verificar `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_ENV=production`, `VITE_APP_URL=https://puntoencuentro.com.ar`, `PUBLIC_APP_ORIGIN=https://puntoencuentro.com.ar` y features de cambio de dominio en `false`.
12. **Verificación post-deploy hermética (aún en PRE-LAUNCH):** Comprobar build tag en footer (sin etiqueta `STAGING`), resolver `PWA-ANDROID-001` en Producción sin Vercel Auth, y verificar smoke de solo lectura y logs de Edge Functions sin errores `500`.
13. **Apertura pública controlada (`PUBLIC-LAUNCH`):** Únicamente tras aprobación explícita, activar `SELECT public.set_platform_launch_phase(true, 'Apertura pública V1');` en Producción (`aurbicjwftjhwryhyjiq`), manteniendo `public_launch_active = false` en Staging.

---

## 9. Recomendación ejecutiva y métricas

### Respuestas ejecutivas directas

1. **¿Staging está en condiciones de iniciar el QA manual?**  
   **Sí.** A nivel funcional, de seguridad y de contratos SQL/frontend, Staging está listo para iniciar QA manual inmediatamente una vez que se autorice commitear y pushear la rama `staging` actual (`2` commits locales pendientes + mejoras locales de esta auditoría) para reflejar los últimos fixes en `https://staging.puntoencuentro.com.ar`.
2. **¿Qué conviene corregir antes de empezar el QA manual?**  
   Las correcciones locales identificadas (idioma `es-AR`, fallback 404 `*`, soporte `clientOverride` en `platformAccessService.ts`, fallback de Chromium en `playwright-qa-runner.ts` y alineación documental crítica sobre fixtures y PRE-LAUNCH) **ya quedaron implementadas localmente en esta auditoría**. Solo falta autorizar su `git commit` + `git push origin staging` y dar de alta a los testers en Vercel + `qa_authorized_users`.
3. **¿Qué se puede corregir durante o después del QA manual?**  
   Durante el QA manual: cualquier hallazgo visual menor o ajuste de `PWA-ANDROID-001` observado en dispositivo físico. Después de estabilizar QA / post-lanzamiento: code-splitting del chunk de `2.09 MB` (`React.lazy`), limpieza paulatina de los `726` errores ESLint `no-explicit-any` en `src/`, archivo raíz `test_supabase.js`, y traducción de las `253` claves faltantes en `pt-BR.json` si se decide ofrecer múltiples idiomas.
4. **¿Qué falta obligatoriamente antes del lanzamiento público en Producción?**  
   (a) Completar datos legales humanos en `PROPUESTA_PAGINAS_LEGALES_V1.md` e implementar `/privacidad` y `/terminos`; (b) comprobar y resolver `PWA-ANDROID-001` en Android real sin Vercel SSO; (c) ejecutar `scripts/backup-production.bat` y validar secretos, Vault y `pg_cron`/`pg_net` en `aurbicjwftjhwryhyjiq`; (d) deshabilitar `/preview/*` en Producción; (e) probar Google OAuth, Web Push físico y Open Graph reales; y (f) autorizar explícitamente `set_platform_launch_phase(true, ...)` al abrir al público.
5. **¿La estrategia de cambio de dominio está lista para operar sin pérdida de usuarios ni encuentros?**  
   **Sí en arquitectura y motor principal, con dos pendientes acotados.** El núcleo SQL (`20261107120000`, `20261108163000`), el motor unificado sin pérdidas y el puente frontend (`/auth/domain-bridge`, `/migrate-receive`) ya están implementados, aplicados en Staging y probados en PGlite/unitario (`20/20` + `59/59`), apagados de forma segura (`false`). Resta únicamente completar el banner UX de transición PWA, validar una corrida real entre dos orígenes HTTPS en navegador y definir el dominio/marca definitivos.
6. **¿Cuál es el camino más corto, seguro y confiable hacia el lanzamiento?**  
   (1) Revisar y aprobar el `git commit` + `git push` hacia `staging` para actualizar `staging.puntoencuentro.com.ar` -> (2) Ejecutar la checklist acotada de QA manual (Sección 7) en 1 dispositivo Android físico + 1 desktop -> (3) Mientras corre o cierra el QA manual, recabar datos legales humanos e implementar `/privacidad` + `/terminos` -> (4) Seguir en orden estricto los 13 pasos de promoción a Producción (Sección 8) sin tocar fixtures de Staging ni omitir el respaldo previo ni `--dry-run`.

---

## 10. Cierre técnico y lista blanca exacta para actualizar Staging

### 10.1 Auditoría de `.github/workflows/ci-quality-gate.yml`
- **Permisos mínimos:** `permissions: contents: read` (cero permisos de escritura).
- **Alcance seguro:** no despliega a Vercel ni a Supabase; no invoca Staging (`wougfhfwqgmxhgvjqoua`) ni Producción (`aurbicjwftjhwryhyjiq`); no requiere secretos administrativos (`SUPABASE_STAGING_SECRET_KEY` ni `service_role`).
- **Blindaje para runner limpio:** define `VITE_IGNORE_LOCAL_ENV_FILES: 'true'` y variables `env` dummy en el job (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_ENV: staging`, `VITE_APP_URL: https://staging.puntoencuentro.com.ar`), verificado localmente ejecutando build y las 6 suites determinísticas sin depender de `.env.local`.
- **Disparadores:** `push` y `pull_request` sobre `staging` y `main`, con `concurrency` (`cancel-in-progress: true`).

### 10.2 Commits locales pendientes en `origin/staging..HEAD`
1. `80affde` — `test(qa): add automated web post-deploy and playwright browser test suites` (`scripts/playwright-qa-runner.ts`, `scripts/qa-web-post-deploy.ts`).
2. `d37fc95` — `docs(security): clarify Vercel SSO exclusivity and restrict automation secret distribution` (`docs/GUIA_ACCESO_QA_MANUAL_PRE_LANZAMIENTO.md`).

### 10.3 Lista blanca exacta de archivos de esta auditoría (NO usar `git add -A`)
1. Código frontend y HTML: `index.html`, `src/App.tsx`, `src/services/platformAccessService.ts`.
2. Configuración, tooling QA/CI y pruebas unitarias: `eslint.config.js`, `package.json`, `scripts/playwright-qa-runner.ts`, `scripts/test-access-gate-pre-launch.ts`, `.github/workflows/ci-quality-gate.yml`.
3. Documentación: `README.md`, `docs/DEPLOYMENT_ENVIRONMENTS.md`, `docs/PROPUESTA_LIMPIEZA_FIXTURES_QA_STAGING.md`, `docs/PLAN_PROMOCION_PRODUCCION_CORREGIDO_V1.md`, `docs/migracion-dominio/PLAN_CAMBIO_DOMINIO.md`, `docs/migracion-dominio/CHECKLIST_MIGRACION_DOMINIO.md`, `docs/migracion-dominio/PLAN_MINI_SPRINT_2B_PUENTE_IDENTIDAD.md`, `docs/AUDITORIA_GLOBAL_PRE_QA_RELEASE_CANDIDATE.md`.

### 10.4 Archivos untracked preexistentes excluidos (preservados intactos)
Quedan fuera de Staging `30` archivos previos (`INFORME_E2E-005.md`..`INFORME_E2E-008.md`, `scratch/*` y `24` archivos en `scripts/` y `scripts/lib/`).

---

### Métricas de ejecución del agente (`AGENTS.md` §5)
- `model`: `"no disponible desde esta interfaz"`
- `num_turns`: `"no disponible desde esta interfaz"`
- `input_tokens`: `"no disponible desde esta interfaz"`
- `output_tokens`: `"no disponible desde esta interfaz"`
- `thinking_tokens`: `"no disponible desde esta interfaz"`
- `cache_read_tokens`: `"no disponible desde esta interfaz"`
- `total_tokens`: `"no disponible desde esta interfaz"`
- `duration_seconds`: `"no disponible desde esta interfaz"`
