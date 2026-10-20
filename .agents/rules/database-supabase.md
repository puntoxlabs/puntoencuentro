---
trigger: glob
globs: "**/supabase/migrations/**, **/supabase/**/*.sql"
description: Directivas para migraciones SQL, RPCs, RLS y esquemas de base de datos Supabase.
---

# Base de Datos y Supabase (SQL)

## 1. Migraciones Increamentales
- **Inmutabilidad:** Las migraciones versionadas son inalterables. Todo cambio de esquema, corrección de bug o nueva función debe plasmarse en una **nueva migración aditiva** con formato `YYYYMMDDHHMMSS_<nombre>.sql`.
- **Despliegue ordenado:** Las migraciones se prueban y aplican en Staging (`npx supabase db push`) antes de considerar cualquier cambio en producción.

## 2. Identidad y Autorización
- **Fuente de verdad:** La identidad del usuario se obtiene exclusivamente de `auth.uid()`.
- **Parámetros no confiables:** Jamás autorizar una mutación basándose en parámetros como `p_user_id` o `p_host_id` suministrados por el cliente. Validar siempre que `auth.uid() = host_id` o `auth.uid() = user_id`.

## 3. Seguridad en Funciones (RPCs)
- **Search Path Seguro:** Toda función `SECURITY DEFINER` debe incluir obligatoriamente:
  `SET search_path = ''` (o calificar esquemas explícitamente con `pg_catalog.` y `public.`) para prevenir ataques de secuestro de search_path.
- **Mínimo Privilegio:** Revocar ejecución pública por defecto:
  `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated;`
  y otorgar `GRANT EXECUTE` solo al rol que lo requiera (`authenticated` para usuarios normales, `service_role` para operaciones administrativas internas).

## 4. Row Level Security (RLS), Privilegios y Tablas RPC-Only
- **RLS Explícita:** Toda tabla en el esquema `public` debe tener obligatoriamente `ALTER TABLE public.<tabla> ENABLE ROW LEVEL SECURITY;`.
- **REVOKE Explícito:** Toda nueva tabla debe ejecutar un `REVOKE ALL ON TABLE public.<tabla> FROM PUBLIC, anon, authenticated;` explícito para cerrar cualquier privilegio predeterminado o residual del motor.
- **GRANT Mínimo:** Si existe un acceso directo legítimo desde frontend o suscripciones Realtime (ej. `supabase.from()` o `postgres_changes`), otorgar únicamente el permiso mínimo indispensable (ej. `GRANT SELECT ON TABLE public.<tabla> TO authenticated;` o `anon`).
- **Documentación de Tablas RPC-Only:** Si una tabla está diseñada para acceso exclusivamente interno o gobernada por RPCs `SECURITY DEFINER`, debe documentarse formalmente en los comentarios de la migración (`-- RPC-only / Acceso exclusivamente interno`) y otorgar permisos solo a roles autorizados del sistema (`GRANT ALL ON TABLE public.<tabla> TO postgres, service_role;`), sin otorgar ningún GRANT a `anon` ni `authenticated`.
- **Compatibilidad con Reconstrucciones y `db reset`:** Toda migración debe ser completamente determinista e idempotente en reconstrucciones de esquema desde cero (`supabase db reset`), sin asumir privilegios predeterminados, grants implícitos o configuraciones variables entre motores locales y remotos.
- **Protección de Ledgers y Mutaciones Directas:** Denegar mutación directa a clientes (`REVOKE INSERT, UPDATE, DELETE`) en tablas donde el estado deba controlarse por RPCs del sistema. Tablas de facturación o uso mensual (`ai_monthly_usage`) no deben usar `ON DELETE CASCADE` desde tablas de telemetría o sesiones efímeras; usar `ON DELETE RESTRICT` para preservar la trazabilidad.

## 5. Concurrencia y Bloqueos
- En flujos con cuotas, límites de participantes o reservas en vuelo, implementar serialización transaccional mediante `pg_advisory_xact_lock(hashtext(...))` o `FOR UPDATE` para garantizar cero sobrecupo bajo concurrencia.
