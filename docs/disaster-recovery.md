# Runbook Operativo de Recuperación y Continuidad de Negocio (Disaster Recovery)

> **ADVERTENCIAS CRÍTICAS DE SEGURIDAD OPERATIVA:**
> - **NUNCA EJECUTAR `supabase db reset --linked` CONTRA PRODUCTION (`aurbicjwftjhwryhyjiq`).**
> - **NO EJECUTAR `supabase migration repair` EN PRODUCTION SIN AUDITORÍA PREVIA (T7-C).**
> - **TODO CAMBIO O PRUEBA PREVIA SE REALIZA EXCLUSIVAMENTE EN STAGING (`wougfhfwqgmxhgvjqoua`) O POSTGRESQL LOCAL AISLADO.**

---

## 1. Alcance y Métricas Clave
Este runbook establece los procedimientos concretos de mitigación y recuperación ante incidentes de datos, fallos de infraestructura o pérdida de componentes para los entornos de **PuntoEncuentro**:
- **Producción:** `aurbicjwftjhwryhyjiq` (`puntoencuentro.com.ar`)
- **Staging:** `wougfhfwqgmxhgvjqoua` (`staging.puntoencuentro.com.ar`)

### Estado de Métricas de Recuperación
- **RPO Production (Recovery Point Objective):** **PENDIENTE DE VERIFICACIÓN** (no asumir backups diarios ni PITR activos hasta completar la verificación manual en el Dashboard de Supabase).
- **RTO Production (Recovery Time Objective):** **NO MEDIDO** (el tiempo de restauración ante desastre en Producción no ha sido medido y dependerá del tamaño de la base y el mecanismo disponible).
- **RTO Replay Local (Técnico):** **34.3 segundos** (medido durante `supabase db reset --local` con las 68 migraciones aplicadas de forma secuencial sobre el stack Supabase local real).
- **Evidencia de Reconstrucción de Schema:** Certificada al 100% (68/68 migraciones aplicadas en orden cronológico en Supabase Local Real con Docker; PGlite se considera únicamente evidencia parcial de apoyo en memoria).

---

## 2. Qué está Respaldado por Git
El repositorio versiona el 100% de la lógica declarativa:
1. **Schema de base de datos:** 68 migraciones secuenciales en `supabase/migrations/` (incluye catálogo inicial de localidades y políticas de rate limit).
2. **Código de Edge Functions:** `supabase/functions/ai-interpret/` con su lógica de fallback, limiters y validadores.
3. **Código de Frontend:** Código fuente React / Vite / GSAP en `src/`.
4. **Configuración de plataforma:** `supabase/config.toml` y configuraciones de linters / TypeScript.

> **Regla de oro:** Git reconstruye el *schema* y el *código*, pero **NO** almacena datos de usuarios, sesiones ni archivos de Storage.

---

## 3. Qué Depende de Supabase Backup
La continuidad de los datos transaccionales depende exclusivamente de Supabase:
- Registros de `encuentros`, `participantes`, `opciones_fecha_coordinacion`.
- `solicitudes_encuentro_abierto`, `intenciones`, `intencion_intereses`.
- `alertas_compatibilidad`, `reportes_encuentro`, `bloqueos_usuario`.
- Contadores de uso de IA (`ai_monthly_usage`, `ai_rate_limit_buckets`) y buckets de rate limiting.
- Cuentas de usuario y metadatos en schema `auth` (`auth.users`, `auth.identities`).

---

## 4. Qué NO Incluye un DB Backup
1. **Archivos binarios de Supabase Storage:** Las imágenes subidas por usuarios se almacenan en S3/object storage, no en las filas de PostgreSQL.
2. **Secrets y API Keys del Vault:** Variables como API keys de OpenAI/Mistral residen en el Vault de Supabase y no en dumps estándar.
3. **Configuraciones de Proveedores Externos:** Configuración de DNS, Google OAuth Console, Vercel Environment Variables.

---

## 5. Auth (Autenticación e Identidad)
- Los usuarios residen en `auth.users`.
- **Restauración desde backup Supabase:** Conserva los UUIDs originales de los usuarios y sus identidades.
- **Reconstrucción desde migraciones:** Deja el schema `auth` vacío. Si no se restaura un dump de `auth.users`, los registros transaccionales perderían su relación de clave foránea (`host_id`, `user_id`).
- **Proveedores OAuth:** En un proyecto nuevo se deben reconfigurar manualmente Client ID y Client Secret de Google en Supabase Dashboard.

---

## 6. Storage (Archivos de Usuario)
- Bucket en uso: `custom-invitation-templates` (público, límite 5 MB, formatos JPEG/PNG/WebP).
- **Clasificación:** `REQUIERE BACKUP DE OBJETOS`. Las imágenes son subidas directamente por los usuarios y no pueden regenerarse por código.
- **Estrategia de Backup:** Export periódico mediante Supabase CLI o cliente S3 API hacia almacenamiento secundario.
- **Restauración:**
  1. Recrear bucket (la migración `20260710000002_custom_storage_policies.sql` lo crea automáticamente en BD).
  2. Subir los objetos respetando la estructura `{user_id}/{design_id}-full.jpg` y `{user_id}/{design_id}-thumb.jpg`.

---

## 7. Edge Functions
- Función actual: `ai-interpret`.
- **Procedimiento de Redeploy:**
  ```bash
  npx supabase functions deploy ai-interpret --project-ref <PROJECT_REF>
  ```
- No requiere dependencias externas para desplegarse; todo el árbol de código está en `supabase/functions/ai-interpret/`.

---

## 8. Secrets (Gestión y Resguardo)
Los siguientes secrets deben estar resguardados en un gestor de contraseñas seguro (1Password, Bitwarden):
- `OPENAI_API_KEY`
- `MISTRAL_API_KEY`
- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEYS`
- `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEYS`

**Carga de secrets en proyecto nuevo:**
```bash
npx supabase secrets set OPENAI_API_KEY=... MISTRAL_API_KEY=... --project-ref <PROJECT_REF>
```

---

## 9. Vercel y Frontend
- En caso de corrupción o pérdida del proyecto Vercel:
  1. Importar repositorio `puntoxlabs/puntoencuentro` desde GitHub.
  2. Configurar variables de entorno:
     - `VITE_SUPABASE_URL`
     - `VITE_SUPABASE_ANON_KEY`
     - `VITE_APP_ENV` (`production` o `staging`)
  3. Asociar dominios `puntoencuentro.com.ar` o `staging.puntoencuentro.com.ar`.
  4. Redesplegar la rama correspondiente (`main` o `staging`).

---

## 10. Escenario A — Error Lógico o Borrado Accidental de Datos
1. **Identificar timestamp exacto** del incidente.
2. Si **PITR está activo:**
   - Crear un proyecto temporal "in-place" o clonar al minuto previo al incidente desde el Dashboard de Supabase.
   - Extraer las filas afectadas mediante `pg_dump` con filtros `COPY` o script selectivo.
   - Reinsertar los datos en el proyecto productivo.
3. Si **sólo hay Daily Backups:**
   - Descargar el último backup diario desde el Dashboard.
   - Restaurar en base local o proyecto temporal, extraer registros perdidos y reincorporar.

---

## 11. Escenario B — Migración Fallida o Schema Parcialmente Roto
1. **NO intentar revertir modificando migraciones históricas ya aplicadas.**
2. Crear una nueva migración aditiva correctiva con timestamp actual:
   `supabase/migrations/<TIMESTAMP>_fix_remedy.sql`
3. Probar la migración en PostgreSQL local o Staging.
4. Aplicar roll-forward controlado:
   ```bash
   npx supabase db push --project-ref <PROJECT_REF>
   ```

---

## 12. Escenario C — Pérdida Completa de Proyecto Supabase
1. **Crear nuevo proyecto** en Supabase (`<NEW_REF>`).
2. **Aplicar migraciones completas desde Git:**
   ```bash
   npx supabase db push --project-ref <NEW_REF>
   ```
3. **Restaurar datos transaccionales y Auth:**
   - Restaurar dump de `auth.users` y tablas de `public` respetando claves foráneas.
4. **Desplegar Edge Functions y Secrets:**
   ```bash
   npx supabase secrets set ... --project-ref <NEW_REF>
   npx supabase functions deploy ai-interpret --project-ref <NEW_REF>
   ```
5. **Actualizar frontend:**
   - Cambiar `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` en Vercel y redesplegar.

---

## 13. Escenario D — Pérdida o Caída Exclusiva de Frontend (Vercel)
1. Supabase permanece intacto; no realizar operaciones en base de datos.
2. En el Dashboard de Vercel, seleccionar el deployment funcional inmediato anterior y presionar **Instant Rollback**.
3. Si Vercel sufriera caída total, desplegar el build estático en proveedor alternativo (Cloudflare Pages, Netlify) configurando las mismas 3 variables de entorno.

---

## 14. Checklist Pre-Deploy a Producción
Antes de promover cambios de Staging a Producción (`main` / `aurbicjwftjhwryhyjiq`):
- [ ] Working tree de Git 100% limpio en rama `staging`.
- [ ] Todas las compuertas funcionales de QA aprobadas en Staging.
- [ ] Export / backup manual de Producción generado y descargado a ubicación segura.
- [ ] Auditoría de Baseline Production ejecutada (ver sección 17).
- [ ] Secrets de Edge Functions verificados y actualizados.

---

## 15. Acciones Prohibidas
- ❌ **PROHIBIDO:** Ejecutar `supabase db reset --linked` en cualquier terminal.
- ❌ **PROHIBIDO:** Ejecutar `supabase db push` contra Production sin haber completado la auditoría de baseline T7-C.
- ❌ **PROHIBIDO:** Ejecutar `supabase migration repair` en Production sin orden explícita y script verificado.
- ❌ **PROHIBIDO:** Commitear credenciales, dumps con emails o API keys al repositorio Git.
- ❌ **PROHIBIDO:** Modificar retroactivamente archivos de migración ya aplicados en Staging o Producción.

---

## 16. Verificaciones Manuales Pendientes en Dashboard de Supabase
Las siguientes comprobaciones deben ser realizadas por un operador humano con acceso web al proyecto de Producción (`aurbicjwftjhwryhyjiq`):

### Backups de Base de Datos
- **Ruta:** Dashboard -> Project `aurbicjwftjhwryhyjiq` -> Settings -> Database -> Backups
- [ ] **Plan:** Confirmar si el proyecto está en plan Free o Pro.
- [ ] **Backups diarios:** Confirmar si están programados y la fecha del backup más reciente.
- [ ] **Retención:** Verificar días de retención (ej. 7 días).
- [ ] **PITR (Point-in-Time Recovery):** Verificar si figura `Enabled` o `Disabled`.
- [ ] **Earliest Recovery Point:** Registrar fecha y hora del punto de recuperación más antiguo disponible.

### Secrets de Edge Functions
- **Ruta:** Dashboard -> Project `aurbicjwftjhwryhyjiq` -> Settings -> Edge Functions -> Secrets
- [ ] Confirmar presencia de `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`.
- [ ] Confirmar que las claves originales están respaldadas en el gestor de contraseñas de la organización.

---

## 17. Baseline Especial de Producción
- **Origen:** En el MVP inicial, las tablas `encuentros` y `participantes` fueron creadas manualmente en Producción antes de implementar el versionado formal de migraciones.
- Posteriormente se incorporó a Staging la migración `20260424000000_initial_schema.sql` como baseline aditivo.
- **Riesgo:** Si se ejecuta `supabase db push` ciegamente en Producción, el CLI puede intentar ejecutar la migración inicial o fallar por conflicto de timestamps.
- **Protocolo Requerido (T7-C):**
  1. Comparar mediante diff seguro los objetos físicos de Producción con `20260424000000_initial_schema.sql`.
  2. Si son equivalentes, registrar la migración como aplicada mediante:
     ```bash
     npx supabase migration repair --status applied 20260424000000 --project-ref aurbicjwftjhwryhyjiq
     ```
  3. **NO ejecutar este comando** hasta haber completado formalmente el procedimiento T7-C.
