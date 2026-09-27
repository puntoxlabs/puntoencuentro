# Arquitectura de Despliegue y Entornos

Este documento describe la topología de 3 capas de PuntoEncuentro, el flujo de ramas Git, la aplicación de migraciones y la configuración de variables de entorno.

```
Producción
puntoencuentro.com.ar  ──→  Rama: main     ──→  Supabase Producción

Staging
staging.puntoencuentro.com.ar  ──→  Rama: staging  ──→  Supabase Staging

Local
localhost:5173 / 4173  ──→  Rama de trabajo ──→  Supabase Staging / PGlite / Local
```

---

## 1. Producción
- **Dominio:** `https://puntoencuentro.com.ar`
- **Hosting:** Vercel (Production Deployment).
- **Rama Git:** `main`.
- **Backend:** Supabase Producción (`aurbicjwftjhwryhyjiq`).
- **Datos:** Exclusivamente usuarios y encuentros reales. Cero datos de prueba.

---

## 2. Staging
- **Dominio:** `https://staging.puntoencuentro.com.ar`
- **Hosting:** Vercel (Preview / Branch Deployment asignado a `staging`).
- **Rama Git:** `staging`.
- **Backend:** Supabase Staging (proyecto independiente).
- **Datos:** Datos de prueba/demo, validaciones QA de producto y pruebas de integración.
- **Indexación:** Bloqueada con `<meta name="robots" content="noindex, nofollow" />`.
- **Identificador visual:** Pie de página muestra `STAGING · {commit} · {fecha/hora build}`.

---

## 3. Local
- **URL:** `http://localhost:5173` (dev) o `http://localhost:4173` (preview).
- **Backend:**
  - Tests unitarios y de componentes: Ejecutan sobre motor PostgreSQL en memoria (`@electric-sql/pglite`), 100% aislados y sin red.
  - Desarrollo interactivo: Apunta a Supabase Staging vía `.env.local`.

---

## 4. Supabase por Entorno
| Entorno | Proyecto Supabase | Propósito |
| :--- | :--- | :--- |
| **Producción** | `aurbicjwftjhwryhyjiq` | Base de datos real de usuarios |
| **Staging** | Proyecto Staging dedicado | Testing funcional, QA, demo data |
| **Local** | Staging o PGlite local | Desarrollo sin riesgo de alterar producción |

---

## 5. Mapeo de Ramas Git
```text
feature/* (desarrollo local)
    ↓ PR / merge
staging (despliegue automático a staging.puntoencuentro.com.ar)
    ↓ QA y validación externa
main (despliegue a puntoencuentro.com.ar)
```

---

## 6. Cómo Probar una Feature
1. Desarrollar en la rama `feature/<nombre>`.
2. Validar que la suite pase al 100%:
   ```bash
   npm --workspaces=false test
   npm --workspaces=false run build
   ```
3. Mergear la rama de feature en `staging`:
   ```bash
   git checkout staging
   git merge feature/<nombre>
   git push origin staging
   ```
4. Vercel desplegará automáticamente en `https://staging.puntoencuentro.com.ar`.
5. Probar el flujo completo en web desde cualquier dispositivo.

---

## 7. Cómo Promover de Staging a Producción
1. Validar que la instancia de Staging haya sido aprobada funcional y visualmente.
2. Aplicar las nuevas migraciones SQL en Supabase Producción (ver sección 8).
3. Crear Pull Request de `staging` hacia `main`.
4. Una vez mergeado en `main`, Vercel desplegará automáticamente la nueva versión en `https://puntoencuentro.com.ar`.

---

## 8. Cómo Aplicar Migraciones
Las migraciones residen en `supabase/migrations/` ordenadas cronológicamente por timestamp.

### En Staging:
```bash
npx supabase db push --project-ref <STAGING_PROJECT_REF>
```

### En Producción:
Solo una vez validado staging:
```bash
npx supabase db push --project-ref aurbicjwftjhwryhyjiq
```

---

## 9. Configuración de Variables de Entorno
El repositorio solo versiona `.env.example`. Los secretos reales nunca se commitean.

### En Vercel:
- **Environment: Production (rama main):**
  - `VITE_SUPABASE_URL`: URL de Supabase Producción
  - `VITE_SUPABASE_ANON_KEY`: Anon key de Supabase Producción
  - `VITE_APP_ENV`: `production`
- **Environment: Preview (rama staging):**
  - `VITE_SUPABASE_URL`: URL de Supabase Staging
  - `VITE_SUPABASE_ANON_KEY`: Anon key de Supabase Staging
  - `VITE_APP_ENV`: `staging`

### En Local:
Crear archivo `.env.local` (ignorado por Git):
```dotenv
VITE_SUPABASE_URL=https://<staging-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<staging-anon-key>
VITE_APP_ENV=development
```

---

## 10. Cómo Verificar qué Build se está Viendo
En la esquina inferior de la pantalla principal (Home):
- **En Staging:** Se lee `STAGING · <hash-corto> · <timestamp>`, por ejemplo:
  `STAGING · b3c1a8f · 27/9/2026, 14:30:15`
- **En Producción:** Se lee únicamente `Build: <timestamp>`, por ejemplo:
  `Build: 27/9/2026, 02:16:46`
