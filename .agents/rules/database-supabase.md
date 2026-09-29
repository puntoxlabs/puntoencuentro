---
trigger: glob
globs:
  - "supabase/migrations/**"
  - "supabase/**/*.sql"
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

## 4. Row Level Security (RLS) e Integridad
- Toda tabla en el esquema `public` debe tener `ENABLE ROW LEVEL SECURITY`.
- Denegar mutación directa a clientes (`REVOKE INSERT, UPDATE, DELETE`) en tablas donde el estado deba controlarse exclusivamente por RPCs del sistema (ej. perfiles, cuotas, ledger).
- **Protección de Ledgers:** Tablas de facturación o uso mensual (`ai_monthly_usage`) no deben usar `ON DELETE CASCADE` desde tablas de telemetría o sesiones efímeras; usar `ON DELETE RESTRICT` para preservar la trazabilidad.

## 5. Concurrencia y Bloqueos
- En flujos con cuotas, límites de participantes o reservas en vuelo, implementar serialización transaccional mediante `pg_advisory_xact_lock(hashtext(...))` o `FOR UPDATE` para garantizar cero sobrecupo bajo concurrencia.
