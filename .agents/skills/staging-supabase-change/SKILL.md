---
name: staging-supabase-change
description: Procedimiento seguro para crear, aplicar y validar cambios de base de datos o migraciones SQL en Supabase Staging sin tocar Producción. Usar cuando el usuario solicite crear o aplicar migraciones en la base de datos.
---

# Procedimiento de Cambio en Supabase Staging

Este procedimiento estandariza la creación y aplicación de cambios de base de datos garantizando que Producción (`aurbicjwftjhwryhyjiq`) permanezca completamente aislada e intacta.

## 1. Verificación Previa de Entorno
1. Confirmar que la rama actual es `staging`.
2. Confirmar que el target remoto es Supabase Staging (`wougfhfwqgmxhgvjqoua`).
3. Todo script que interactúe con la base de datos debe importar y ejecutar `assertStagingEnvironment()`. Si el target contiene `aurbicjwftjhwryhyjiq`, abortar inmediatamente.

## 2. Creación de Migración Incremental
1. Generar un nuevo archivo SQL en `supabase/migrations/` con timestamp UTC:
   ```text
   supabase/migrations/YYYYMMDDHHMMSS_<nombre_descriptivo>.sql
   ```
2. **Invariantes del archivo SQL:**
   - Envolver en bloque transaccional `BEGIN; ... COMMIT;`.
   - Activar RLS en toda nueva tabla: `ALTER TABLE public.<tabla> ENABLE ROW LEVEL SECURITY;`.
   - Funciones `SECURITY DEFINER` deben incluir `SET search_path = ''`.
   - Revocar permisos públicos y otorgar solo el mínimo requerido:
     ```sql
     REVOKE ALL ON FUNCTION public.<func>(...) FROM PUBLIC, anon, authenticated;
     GRANT EXECUTE ON FUNCTION public.<func>(...) TO authenticated; -- o service_role
     ```
   - Nunca modificar ni renombrar migraciones históricas preexistentes.

## 3. Aplicación a Staging
Ejecutar la migración en el proyecto vinculado de Staging:
```bash
npx --workspaces=false supabase db push
```
Verificar que la salida confirme la migración específica aplicada sin errores (`Finished supabase db push`).

## 4. Verificación y Validación
1. Comprobar la creación de tablas o funciones con una consulta de verificación de esquema:
   ```bash
   npx --workspaces=false supabase db query --linked "SELECT to_regclass('public.<tabla>');"
   ```
2. Ejecutar los tests unitarios o scripts de validación asociados al cambio.

## 5. Reporte
Informar el nombre exacto del archivo de migración aplicado, los objetos creados y la confirmación de que Producción no fue alterada.
