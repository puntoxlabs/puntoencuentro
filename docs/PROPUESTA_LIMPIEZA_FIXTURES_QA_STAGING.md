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

> **Regla de oro:** No ejecutar esta limpieza en la rama ni en el PR de DIF-18. Requiere autorización explícita previa.

### Enfoque No Destructivo Recomendado (Soft Cleanup)
En lugar de un `DELETE` directo en tablas relacionales que pueda disparar cascadas o violar llaves foráneas históricas, la vía más segura y limpia es la transición de estado:

```sql
-- Ejecutar exclusivamente en Staging (wougfhfwqgmxhgvjqoua)
UPDATE public.encuentros
SET 
  estado = 'cancelado',
  cancellation_reason = 'qa_fixture_cleanup_dif18',
  inscriptions_closed = true,
  updated_at = NOW()
WHERE 
  titulo IN ('Encuentro T24', 'Encuentro T27')
  AND created_at < '2026-11-10 00:00:00+00';
```

**Por qué funciona de forma limpia:**
1. La RPC `get_discovery_encuentros_abiertos` filtra por encuentros activos y abiertos (`e.estado = 'abierto'` / `is_open = true`), por lo que desaparecen inmediatamente de Discovery sin romper relaciones de base de datos.
2. No requiere modificar esquemas ni migraciones complejas.
3. Se puede orquestar con un script Node/TS (`scripts/cleanup-staging-qa-fixtures.ts`) con el guard obligatorio `assertStagingEnvironment()`.

---

## 3. Estrategia de Prevención de Fixtures Persistentes

Para evitar que futuras pruebas automatizadas saturen el Discovery de Staging con tarjetas de prueba acumuladas:

1. **Patrón `try / finally` obligatorio en scripts QA:**
   Todo script de prueba o validación que inserte datos en Staging debe almacenar los IDs generados en un arreglo y eliminarlos o cancelarlos en el bloque `finally`:
   ```ts
   const createdEncounterIds: string[] = [];
   try {
     // ejecución del test...
   } finally {
     if (createdEncounterIds.length > 0) {
       await stagingClient.from('encuentros').delete().in('id', createdEncounterIds);
     }
   }
   ```

2. **Nomenclatura y Tagging Estandarizado:**
   Todos los encuentros de prueba creados automáticamente deben llevar un prefijo detectable:
   `[QA-EPHEMERAL] <titulo>` y un metadato en una columna de auditoría o descripción.

3. **Script de Higiene Programada (Sweep):**
   Un script `scripts/sweep-stale-qa-encounters.ts` que busque encuentros creados por usuarios QA o con prefijo `[QA-EPHEMERAL]` con más de 48 horas de vida y los archive automáticamente.
