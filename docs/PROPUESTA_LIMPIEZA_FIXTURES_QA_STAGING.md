# Propuesta: Limpieza Segura y Prevención de Fixtures QA en Supabase Staging

## 1. Diagnóstico de la Situación Actual

Durante la investigación de **DIF-18** en Supabase Staging (`wougfhfwqgmxhgvjqoua`), se identificó la presencia de:
- 10 registros de encuentros abiertos titulados `"Encuentro T24"` (para el 14/11/2026, zona Güemes, `locality_id: 'loc_cba_guemes'`).
- 10 registros de encuentros abiertos titulados `"Encuentro T27"` (para el 16/11/2026, zona Güemes, `locality_id: 'loc_cba_guemes'`).

### Causa Raíz
- No se trata de un bug de la RPC `get_discovery_encuentros_abiertos` ni de una duplicación de renderizado en React.
- La RPC devuelve exactamente 36 filas con 36 UUIDs únicos e independientes.
- Los registros fueron generados por ejecuciones sucesivas del script de validación `scripts/validate-staging-15c-collision.ts` (u homólogos de pruebas de concurrencia/colisión) que crearon fixtures en Staging sin realizar teardown/cleanup al finalizar.

---

## 2. Propuesta de Limpieza Segura (Para ejecución posterior bajo autorización)

> **Regla de oro:** No ejecutar esta limpieza sin autorización explícita previa. Cumplir estrictamente las invariantes de [`.agents/rules/staging-qa-fixtures.md`](../.agents/rules/staging-qa-fixtures.md): **prohibido `DELETE` sobre `public.encuentros`** y **prohibido mutar los 26 fixtures protegidos de la lista blanca**.

### Enfoque No Destructivo Obligatorio (Soft Cleanup)
En lugar de un `DELETE` directo o de alterar `estado = 'cancelado'` (que rompe la auditoría e integridad referencial histórica y puede disparar efectos secundarios), la higiene no destructiva desactiva la visibilidad pública conservando `estado = 'activo'`:

```sql
-- Ejecutar exclusivamente en Staging (wougfhfwqgmxhgvjqoua) bajo autorización explícita
-- NUNCA usar DELETE en encuentros ni modificar los 26 UUIDs de la lista blanca inviolable.
UPDATE public.encuentros
SET
  is_open = false,
  updated_at = NOW()
WHERE
  id = ANY($1::uuid[])
  AND NOT (id = ANY($2::uuid[])) -- Lista blanca de los 26 fixtures protegidos (fail-closed)
  AND estado = 'activo'
  AND is_open = true;
```

**Por qué funciona de forma limpia:**
1. La RPC `get_discovery_encuentros_abiertos` filtra por `is_open = true` y `estado = 'activo'`, por lo que al pasar `is_open = false` desaparecen de Discovery preservando íntegramente `estado = 'activo'`, `participantes`, `solicitudes_encuentro_abierto` y claves foráneas.
2. Protege de forma explícita e irrevocable los **26 registros protegidos** definidos en `.agents/rules/staging-qa-fixtures.md`.
3. Se orquesta únicamente mediante scripts aprobados que invoquen `assertStagingEnvironment()` en la primera línea.

---

## 3. Estrategia de Prevención de Fixtures Persistentes

Para evitar que futuras pruebas automatizadas saturen el Discovery de Staging con tarjetas de prueba acumuladas:

1. **Patrón `try / finally` no destructivo en scripts QA:**
   Todo script de prueba o validación que inserte datos en Staging debe almacenar los IDs explícitos generados y desactivarlos (sin `DELETE` en `encuentros`) en el bloque `finally`, verificando que no pertenezcan a la lista blanca protegida:
   ```ts
   const createdEncounterIds: string[] = [];
   try {
     // ejecución del test...
   } finally {
     if (createdEncounterIds.length > 0) {
       await stagingClient
         .from('encuentros')
         .update({ is_open: false })
         .in('id', createdEncounterIds);
     }
   }
   ```

2. **Nomenclatura y Tagging Estandarizado (según `.agents/rules/staging-qa-fixtures.md`):**
   Todos los encuentros de prueba deben llevar su prefijo obligatorio en `titulo` y `open_public_title`:
   - `[QA-E2E:<runId>]` para corridas automatizadas de CI/Playwright.
   - `[QA-DYN:<suiteId>]` para pruebas transaccionales dinámicas.
   - `[QA-TMP]` para pruebas manuales exploratorias (desactivadas manualmente tras concluir la prueba).

3. **Sin Automatizaciones con Escritura Autónoma:**
   Conforme a la política permanente de fixtures, **no se configuran cron jobs ni triggers de limpieza automática con escritura** en Staging. Toda limpieza de residuos `[QA-E2E]` / `[QA-DYN]` / `[QA-TMP]` se planifica mediante dry-run de solo lectura sobre manifiestos o UUIDs explícitos y se ejecuta únicamente con autorización humana expresa.
