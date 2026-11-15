# PuntoEncuentro — PWA de Organización y Descubrimiento de Encuentros

Aplicación Progressive Web App (PWA) orientada a organizar encuentros privados mediante enlaces sin fricción y descubrir planes abiertos cercanos, construida con arquitectura **RPC-first** y **RLS restrictivo** sobre Supabase.

---

## Stack Principal

- **Frontend:** React 19, TypeScript, Vite, React Router, Zustand, i18next (`es`), Lucide Icons, GSAP.
- **Backend:** Supabase PostgreSQL (RLS + funciones `SECURITY DEFINER` con `auth.uid()` y `SET search_path = ''`), Edge Functions en Deno (`ai-interpret`, `domain-events-worker`, `moderate-public-content`, `web-push-worker`), `pg_cron` y `pg_net`.
- **Hosting y Preview Social:** Vercel (`vercel.json` + función serverless `api/open-encounter.ts` para metadatos Open Graph y redirecciones N→1 cuando correspondan).
- **Motor de Pruebas Locales:** `@electric-sql/pglite` (PostgreSQL en memoria sin red), Vite SSR test runner (`node:test`) y Playwright Chromium.

---

## Topología de Entornos

| Entorno | Rama Git | URL | Proyecto Supabase | Estado |
| :--- | :--- | :--- | :--- | :--- |
| **Staging (Release Candidate)** | `staging` | `https://staging.puntoencuentro.com.ar` | `wougfhfwqgmxhgvjqoua` | Protegido en PRE-LAUNCH (3 capas) |
| **Producción (Protegida)** | `main` | `https://puntoencuentro.com.ar` | `aurbicjwftjhwryhyjiq` | **Intocable** sin orden explícita |
| **Local** | — | `http://localhost:5173` | PGlite en memoria / Staging vía `.env.local` | Desarrollo y QA automatizado |

Ver detalle operativo en [docs/DEPLOYMENT_ENVIRONMENTS.md](./docs/DEPLOYMENT_ENVIRONMENTS.md), [AGENTS.md](./AGENTS.md) y [docs/GUIA_ACCESO_QA_MANUAL_PRE_LANZAMIENTO.md](./docs/GUIA_ACCESO_QA_MANUAL_PRE_LANZAMIENTO.md).

---

## Variables de Entorno Locales

Crear `.env.local` (ignorado por Git) tomando `.env.example` como base. Nunca versionar ni imprimir secretos, JWTs administrativos ni claves legacy:

- `VITE_SUPABASE_URL` — URL del proyecto Supabase Staging.
- `VITE_SUPABASE_PUBLISHABLE_KEY` (o `VITE_SUPABASE_ANON_KEY`) — clave pública/publishable de cliente.
- `VITE_APP_ENV` — `development` o `staging`.
- `SUPABASE_STAGING_SECRET_KEY` — requerida únicamente para scripts QA locales autorizados en Staging (junto con `assertStagingEnvironment()`).

---

## Comandos de Validación y Pruebas

> **Nota en Windows/PowerShell:** si la configuración global de npm tiene `workspaces=true`, anteponer `--workspaces=false` en los comandos `npm` y `npx`.

### Verificación Estática y Compilación
```bash
npx --workspaces=false tsc -b
npm --workspaces=false run build
npm --workspaces=false run lint
```

### Pruebas Unitarias y SQL Locales (PGlite, sin red)
```bash
npm --workspaces=false run test:unit:access-gate
npm --workspaces=false run test:unit:domain-readiness
npm --workspaces=false run test:unit:domain-bridge-ui
npm --workspaces=false run test:sql:domain-bridge
npm --workspaces=false run test:sql:security-h1-h10
npm --workspaces=false run test:sql:schema-parity
```

Para correr el paquete completo registrado en el runner histórico:
```bash
node scripts/run-tests.mjs
```

### QA de Navegador Local y Diagnósticos de Solo Lectura en Staging
```bash
npm --workspaces=false run qa:browser:local
npm --workspaces=false run qa:preflight:staging
npm --workspaces=false run qa:audit:staging
```

---

## Documentación Clave del Repositorio

- [Reglas universales del agente](./AGENTS.md)
- [Seguridad de entornos y credenciales](./.agents/rules/environment-security.md)
- [Gestión de fixtures en Staging](./.agents/rules/staging-qa-fixtures.md)
- [Auditoría Global Pre-QA y Release Candidate](./docs/AUDITORIA_GLOBAL_PRE_QA_RELEASE_CANDIDATE.md)
- [Plan de Promoción a Producción V1](./docs/PLAN_PROMOCION_PRODUCCION_CORREGIDO_V1.md)
- [Documentación de Cambio de Dominio](./docs/migracion-dominio/PLAN_CAMBIO_DOMINIO.md)
