# Adopción de Home V3-C como Home Principal de Staging

## 1. Resumen ejecutivo

Se promovió **Home V3-C Responsive** como experiencia predeterminada de `/` exclusivamente en el entorno **Staging** (`https://staging.puntoencuentro.com.ar/`), habilitando al mismo tiempo la ruta protegida `/preview/home-v2` como acceso directo y respaldo operativo hacia **Home V2 + GSAP**.

- **Producción (`https://puntoencuentro.com.ar` / rama `main`, commit `34d1d72eceecd8daf5bbc32c38e3f7d98013ac23`):** no fue modificada; conserva **Home V2 + GSAP** como predeterminada y mantiene bloqueadas todas las rutas `/preview/home-v2`, `/preview/home-v3a`, `/preview/home-v3b` y `/preview/home-v3c`.
- **Seguridad e infraestructura:** sin cambios en Vercel, variables de entorno, DNS, Supabase, RPC, RLS, OAuth, Web Push, `AccessGate` (`public_launch_active = false`), `cross_origin_bridge_enabled = false` ni switches de lanzamiento.

---

## 2. Decisión de producto

Tras completar los mini-sprints previos de diseño responsive dual-path, optimización mobile-first del Hero ([HOME_V3C_OPTIMIZACION_UX_MOBILE.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/HOME_V3C_OPTIMIZACION_UX_MOBILE.md)) y compactación final de Discovery y Mi espacio ([HOME_V3C_DISCOVERY_MI_ESPACIO_FINAL.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/HOME_V3C_DISCOVERY_MI_ESPACIO_FINAL.md)):

- Se aprueba Home V3-C como Home principal **exclusivamente en Staging** para iniciar el **QA funcional integral**.
- Se mantiene intacta la propuesta dual-path aprobada (**Organizá con tu gente** sin registro para invitados + **Tengo ganas de…** con texto y voz), Discovery y Mi espacio, sin introducir rediseños adicionales.
- Esta promoción habilita el QA funcional en Staging y **no** constituye lanzamiento público ni autorización para Producción.

---

## 3. Arquitectura de selección de Home

La resolución de variante en [src/screens/Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx) se centralizó en funciones puras exportadas y auditables:

1. **`STAGING_DEFAULT_HOME_VARIANT` (`'v3c' | 'v2' = 'v3c'`):** constante única que gobierna qué variante asume Staging cuando no hay override explícito.
2. **`isHomeV3PreviewAllowed(options)`:** continúa autorizando rutas de preview y selección V3 únicamente cuando:
   - El entorno efectivo (`__APP_ENV__` / `resolveAppEnvironment()`) es `'staging'` o `'development'` (nunca `'production'`).
   - El origen/host en navegador corresponde exactamente a `https://staging.puntoencuentro.com.ar` (`staging.puntoencuentro.com.ar`) o a `localhost` / `127.0.0.1` / `[::1]` en desarrollo local (jamás `https://puntoencuentro.com.ar`).
3. **`isStagingDefaultV3CAllowed(options)`:** exige simultáneamente `isHomeV3PreviewAllowed(options) === true` **y** `effectiveEnv === 'staging'`. De este modo:
   - Un build de Producción (`effectiveEnv === 'production'`) retorna `false` de forma incondicional.
   - El dominio `https://puntoencuentro.com.ar` retorna `false` incluso ante una integración futura hacia `main`.
4. **`resolveEffectiveHomeVariant(params)`:** orden estricto de precedencia sin anular selecciones válidas:
   1. `?homeVariant=v1` o `propHomeVariant="v1"` → `'v1'`
   2. `/preview/home-v2` (`propHomeVariant="v2"`), `?homeVariant=v2` o `?homePreview=v2` → `'v2'`
   3. `v3Allowed && propHomeVariant` en `v3a | v3b | v3c` → esa variante V3
   4. `v3Allowed && queryHomePreview / queryHomeVariant` en `v3a | v3b | v3c` → esa variante V3
   5. `isStagingDefaultV3CAllowed()` → `STAGING_DEFAULT_HOME_VARIANT` (`'v3c'`)
   6. Fallback universal por defecto → `'v2'`
5. **`isV2Variant`:** se conserva intacto (`propHomeVariant !== 'v1' && queryHomeVariant !== 'v1'`), ya que Home V3-C reutiliza la estructura modular, Discovery, Mi espacio y recorridos funcionales de V2.

---

## 4. Cambios realizados

| Archivo | Cambio realizado |
|---|---|
| [src/screens/Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx) | Agregados `EffectiveHomeVariant`, `STAGING_DEFAULT_HOME_VARIANT = 'v3c'`, `isStagingDefaultV3CAllowed()` y `resolveEffectiveHomeVariant()`, conectados al cálculo de `effectiveHomeVariant` y `v3Variant`. |
| [src/App.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/App.tsx) | Registrada la ruta protegida `<Route path="/preview/home-v2" element={<Home homeVariant="v2" forcedVariant="gsap" />} />` dentro del guard `{v3PreviewAllowed && (...)}`, manteniendo intactas `/`, `/e/:id`, `/solicitudes` y demás rutas de aplicación. |
| [scripts/test-home-integration.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-home-integration.ts) | Actualizados los tests `15.S`, `16.B` y `16.E` al nuevo comportamiento predeterminado de Staging (`v3c`), y añadido el test **`16.H`** cubriendo guards Staging/Producción, precedencia de `/preview/home-v2`, `?homePreview=v2`, `?homeVariant=v1`, rutas `/solicitudes` y `/e/:id` y bloqueo de Producción. |
| [docs/HOME_V3C_ADOPCION_STAGING.md](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/HOME_V3C_ADOPCION_STAGING.md) | Documentación de arquitectura, pruebas, rollback y checklist para iniciar QA funcional en Staging. |

---

## 5. Rutas disponibles

| Ruta | Staging (`staging.puntoencuentro.com.ar`) | Producción (`puntoencuentro.com.ar`) | Local (`localhost` dev) |
|---|---|---|---|
| `/` | **Home V3-C** (predeterminada) | **Home V2 + GSAP** (predeterminada) | Home V2 + GSAP (default) |
| `/preview/home-v2` | **Home V2 + GSAP** (backup utilizable) | Bloqueada (`Página no encontrada`) | Home V2 + GSAP |
| `/preview/home-v3a` | Home V3-A | Bloqueada (`Página no encontrada`) | Home V3-A |
| `/preview/home-v3b` | Home V3-B | Bloqueada (`Página no encontrada`) | Home V3-B |
| `/preview/home-v3c` | Home V3-C | Bloqueada (`Página no encontrada`) | Home V3-C |
| `/?homeVariant=v1` | Home V1 (override técnico) | Home V1 (override técnico) | Home V1 |
| `/e/:id` | Deep link encuentro + Home V3-C | Deep link encuentro + Home V2 | Deep link encuentro |
| `/solicitudes` | Home V3-C en pestaña *Mis solicitudes* | Home V2 en pestaña *Mis solicitudes* | Home en pestaña *Mis solicitudes* |

---

## 6. Protección de Producción

1. **Independiente del nombre de rama Git:** `isHomeV3PreviewAllowed` y `isStagingDefaultV3CAllowed` verifican `__APP_ENV__` (inyectado en build), `resolveAppEnvironment()` y el origen/hostname en tiempo de ejecución (`window.location.origin` / `hostname`).
2. **Doble bloqueo sobre `puntoencuentro.com.ar`:** aunque este código se integre posteriormente a `main`, en Producción `__APP_ENV__ === 'production'` y el host `puntoencuentro.com.ar` desactivan V3-C y las rutas `/preview/home-v*`.
3. **Aislamiento de fixtures de autenticación:** `?previewAuth=permanent` continúa restringido estrictamente a `import.meta.env.DEV && appEnv === 'development' && http: localhost/127.0.0.1` (`isLocalDevAuthFixtureAllowed`); auditoría de bundles compilados de Staging y Producción confirmó `0` ocurrencias de `preview-permanent-user` o `Ana García`.
4. **Reglas, datos y switches intactos:** sin cambios en Vercel, env vars, RLS, RPC, OAuth, `public_launch_active = false`, `cross_origin_bridge_enabled = false`, ni scripts destructivos.

---

## 7. Pruebas automatizadas ejecutadas

Todas las compuertas siguientes se ejecutaron y aprobaron íntegramente tras las modificaciones en `Home.tsx`, `App.tsx` y `test-home-integration.ts`:

| Suite / Verificación | Resultado | Cobertura / Evidencia |
|---|---|---|
| TypeScript (`tsc -b`) | **OK (exit 0)** | Compilación estricta de tipos en todo el proyecto. |
| ESLint focalizado | **OK (exit 0)** | `src/App.tsx`, `src/components/home/HomeDualPathHeroPreview.tsx`, `src/components/home/HomeCreateOrOpenInfo.tsx` sin errores ni warnings. |
| [test-home-integration.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-home-integration.ts) | **82/82 PASS** | Suites 1–16 incluyendo adopción `16.B`/`16.H`, `/preview/home-v2`, V3-A/B/C, V1 y blindaje de Producción. |
| [test-quick-nav-menu.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-quick-nav-menu.ts) | **9/9 PASS** | Integridad de menú rápido, V2/V3-C y accesos directos. |
| [test-access-gate-pre-launch.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-access-gate-pre-launch.ts) | **10/10 PASS** | Compuerta `AccessGate` fail-closed pre-lanzamiento. |
| [test-mi-espacio-mobile.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-mi-espacio-mobile.ts) | **20/20 PASS** | Pestañas, solicitudes, Mis ganas y semántica de cupos en móvil. |
| [test-home-inspirational-discovery-ux.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-home-inspirational-discovery-ux.tsx) | **11/11 PASS** | Discovery vacío, ideas, zonas no configuradas y aislamiento. |
| [test-mini-sprint-1-identity.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-mini-sprint-1-identity.ts) | **47/47 PASS** | Identidad, sesiones y validaciones de acceso pre-lanzamiento. |
| [test-domain-migration-readiness.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-domain-migration-readiness.ts) | **PASS** | Guardas de dominio, orígenes canónicos y allowlist. |
| [test-domain-identity-bridge.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-domain-identity-bridge.ts) | **20/20 PASS (PGlite SQL)** | Bridge backend y matriz adversarial ADV-01..ADV-20 con kill switch apagado. |
| [test-domain-bridge-frontend.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-domain-bridge-frontend.ts) | **59/59 PASS** | Bridge frontend, redirecciones y cabeceras anti-framing. |
| Build Staging (`vite build --mode staging`) + Playwright (`verify-staging-default-v3c.mjs --mode staging`) | **OK (`STAGING_DEFAULT_V3C_VERIFIED`)** | Verificados los **7 viewports** (`360×640`, `375×667`, `390×844`, `430×932`, `768×1024`, `1024×768`, `1440×900`) sobre `/` mostrando V3-C sin overflow (`0px`) ni colisiones; verificados `/preview/home-v2` (V2+GSAP), `/preview/home-v3a|v3b|v3c`, `?homeVariant=v1`, bloqueo `?previewAuth=permanent`, auditoría de bundle y recorridos A–D + `/solicitudes` con 0 HTTP 403. |
| Build Producción simulada (`VITE_APP_ENV=production vite build`) + Playwright (`--mode production`) | **OK (`PRODUCTION_LOCKDOWN_VERIFIED`)** | Confirmado `/` con Home V2 + GSAP (`0` V3/V3-C), `/preview/home-v2|v3a|v3b|v3c` bloqueadas (`Página no encontrada`), `?homePreview=v3c` / `?homeVariant=v3c` / `?previewAuth=permanent` ignorados, y `0` fixtures de auth en bundle. |

---

## 8. Resultados del deployment

- **Rama base al iniciar:** `staging` en `b91e962d0a6d95fb051d58e61f1153c89c43231c`.
- **Rama Producción (`main`):** intacta en `34d1d72eceecd8daf5bbc32c38e3f7d98013ac23`.
- **Backup Git V2:** `backup/home-v2-gsap-8048777` intacto en `8048777e7362c1bb5d0ca9081683de11e135c709`.
- **Commit de esta adopción:** mensaje `feat(home): promote v3c as staging default with v2 fallback` (SHA final, run de GitHub Actions y estado del deployment de Vercel verificados e informados tras el push).

---

## 9. Procedimiento de rollback

Para revertir temporalmente `/` en Staging a **Home V2 + GSAP** sin restaurar todos los archivos ni revertir los avances de V3-C:

### Opción rápida (cambio de 1 línea — mantiene `/preview/home-v3c` disponible para comparar)
1. Abrir [src/screens/Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx) y localizar `STAGING_DEFAULT_HOME_VARIANT` (línea ~481):
   ```ts
   export const STAGING_DEFAULT_HOME_VARIANT: 'v3c' | 'v2' = 'v2';
   ```
2. Actualizar en [scripts/test-home-integration.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-home-integration.ts) la aserción de `STAGING_DEFAULT_HOME_VARIANT` y las expectativas de `/` en Staging de `'v3c'` a `'v2'`.
3. Verificar localmente antes de publicar:
   - `.\node_modules\.bin\tsc.cmd -b`
   - `node scripts/run-tests.mjs ./scripts/test-home-integration.ts`
   - `node scripts/run-tests.mjs ./scripts/test-quick-nav-menu.ts`
   - Build de Staging (`VITE_APP_ENV=staging`) y comprobar `/` muestra Hero V2 (`home-hero-subtitle sr-only`) mientras `/preview/home-v3c` sigue disponible con V3-C.
4. Commitear en `staging` (identificando el SHA del commit de adopción con `git log -5 --oneline staging`) y ejecutar `git push origin staging`.

### Opción alternativa (revertir el commit completo)
- Localizar el SHA del commit con `git log --grep="promote v3c as staging default" -n 1 --oneline staging`.
- Ejecutar `git revert <SHA>` sobre `staging`, repetir `tsc -b` + `test-home-integration.ts` + `test-quick-nav-menu.ts` y pushear a `origin/staging`. *(Nota: esta opción también retira la ruta `/preview/home-v2`, mientras `backup/home-v2-gsap-8048777` conserva siempre la fotografía histórica exacta de V2).*

---

## 10. Pendientes de QA manual y propuesta para iniciar QA funcional

**Pendientes exclusivos de verificación manual (sobre Staging remoto con sesión autorizada):**
- Comprobar en navegador móvil/desktop autenticado con Vercel SSO y `AccessGate` que `https://staging.puntoencuentro.com.ar/` abre V3-C y `/preview/home-v2` abre V2 + GSAP.
- Ejecutar end-to-end los flujos reales contra Supabase Staging (estas pruebas automatizadas usaron Vite/PGlite y mocks offline para no escribir datos remotos).

**Propuesta de recorrido de QA funcional integral sobre Staging (`https://staging.puntoencuentro.com.ar/`):**
1. **Crear invitación privada:** tocar *«Crear una invitación»* desde el Hero, elegir fecha definida y completar creación sin pasar por IA.
2. **Compartir enlace por WhatsApp:** copiar/compartir link de invitación desde la pantalla de compartir en móvil.
3. **Abrir invitación sin registro:** abrir el enlace en navegador incógnito / sin sesión Google y validar visualización correcta.
4. **Confirmar asistencia:** confirmar asistencia como invitado sin registro (verificando persistencia en sesión local).
5. **Coordinar fechas:** crear encuentro con votación de múltiples fechas (cuenta permanente), votar como invitado y cerrar fecha ganadora.
6. **Gestionar invitados:** agregar, editar o revisar respuestas y cupos desde la vista anfitrión (`/meet/:id` / `/coordination/:id`).
7. **Convertir invitados en nuevos organizadores / re-uso:** verificar flujos de transferencia, listas o plantillas disponibles para anfitriones.
8. **Discovery y solicitudes:** probar filtros, configuración de zonas, *«Avisame»*, envío de solicitud para sumarse a un encuentro abierto y aceptación/rechazo desde *Mis solicitudes* / host.
9. **«Mis ganas» y creación asistida:** usar *«Tengo ganas de…»* por teclado y dictado por voz en el Hero (visitante → Google OAuth → `/create/ai`; usuario permanente → `/create/ai`) y gestión de intenciones guardadas en *Mi espacio → Mis ganas*.
10. **Notificaciones y experiencia móvil:** probar campanita in-app, permisos/avisos Web Push si están configurados, sticky header, FAB contextual `+ Crear` y deep links (`/solicitudes`, `/e/:id`).

---

## 11. Riesgos residuales

- **Diferencias de comportamiento de red real / OAuth / Vercel SSO:** las pruebas automatizadas locales cubren UI, routing, PGlite SQL y mocks de Supabase; la latencia real de OAuth, cuotas reales de IA y permisos RLS remotos deben validarse durante el QA funcional guiado en Staging.
- **Mantenimiento de `isStagingDefaultV3CAllowed`:** si en el futuro se habilitara V3-C en un nuevo dominio de preproducción distinto de `staging.puntoencuentro.com.ar`, habrá que revisarlo explícitamente junto con `isHomeV3PreviewAllowed`; para el futuro lanzamiento a Producción se requerirá una decisión explícita que habilite Producción sobre `main` / `puntoencuentro.com.ar`.
