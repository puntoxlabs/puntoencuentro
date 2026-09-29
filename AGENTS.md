# PuntoEncuentro — Reglas Universales del Agente

Este archivo define las invariantes esenciales que gobiernan cualquier tarea en el repositorio.

---

## 1. Entornos y Protección de Producción
- **Staging primero:** Todo cambio de backend, migraciones o pruebas remotas se aplica exclusivamente a Staging (`wougfhfwqgmxhgvjqoua` / rama `staging`).
- **Producción protegida:** Producción (`aurbicjwftjhwryhyjiq` / rama `main`) **NUNCA** se modifica sin una orden directa y explícita del usuario.
- **Sin secretos:** Jamás imprimir, registrar en logs ni versionar secretos, JWTs administrativos o service_role keys. Utilizar variables de entorno locales no versionadas (`.env.local`).

## 2. Base de Datos y Backend Supabase
- **Migraciones inmutables:** Las migraciones ya creadas o aplicadas son históricas e inalterables. Todo cambio de esquema o función se realiza mediante una nueva migración aditiva con timestamp.
- **Autorización server-side:** La única fuente legítima de identidad para RLS y RPCs es `auth.uid()`. Nunca confiar en parámetros de usuario o IDs enviados desde el cliente.
- **Infraestructura existente:** Reutilizar tablas, RPCs y contextos existentes antes de proponer esquemas o abstracciones paralelas.

## 3. Modo de Trabajo y Contexto
- **Lectura focalizada:** Si el prompt especifica archivos, leer primero esos archivos. No explorar `src/`, `supabase/` ni directorios completos salvo que exista una dependencia directa no resuelta.
- **Diagnóstico vs. Implementación:**
  - Si el prompt indica `AUDITAR`, `DISEÑAR`, `PROPONER` o `NO IMPLEMENTAR`: realizar el análisis y detenerse antes de modificar código productivo o base de datos.
  - Si el prompt indica `DISEÑO APROBADO` o `IMPLEMENTAR`: ejecutar la implementación sin reabrir debates arquitectónicos ya resueltos.
- **Cambios mínimos y no oportunistas:** Limitar las modificaciones al objetivo específico. No realizar refactors de código circundante ni alterar archivos locales ajenos a la tarea.
- **Validación proporcional:** Ejecutar primero pruebas específicas del módulo. Reservar TypeScript (`tsc -b`), build y suites completas para cambios de integración, seguridad o DB.
- **Stop condition:** Concluir la ejecución inmediatamente una vez satisfechos los criterios del prompt y aprobadas las compuertas correspondientes.

## 4. Execution and Approval Flow
Work autonomously within the scope explicitly authorized by the user.

### If a plan is generated before implementation:
1. Produce the complete implementation plan.
2. Stop exactly once before executing it.
3. Wait for user approval.
4. After approval, execute the approved plan end-to-end without asking for intermediate confirmations.

Do not request approval for individual files, commands, edits, tests, builds, screenshots, or validation steps already covered by the approved plan.

### If no formal plan is necessary:
Execute the task directly and autonomously within the authorized scope.

### Stop again only when:
- A material product or architectural decision appears that was not covered by the approved plan;
- A real ambiguity or conflict could change expected behavior;
- An unauthorized destructive operation would be required;
- Credentials or permissions are missing;
- Validation failure requires a substantial change to the approved plan.

Explicit gates from the task always take precedence (e.g., `NO COMMIT`, `NO PUSH`, `NO DEPLOY` means stop before those operations, not before every intermediate step).

## 5. Agent Execution Metrics
Report only metrics that are actually available from the current interface or runtime.

Allowed metrics may include:
- `model`
- `num_turns`
- `input_tokens`
- `output_tokens`
- `thinking_tokens`
- `cache_read_tokens`
- `total_tokens`
- `duration_seconds`

If a metric is unavailable, use exactly:
`"no disponible desde esta interfaz"`

Never estimate or approximate unavailable metrics.
Forbidden examples:
- `~180 seconds`
- `approximately 50k tokens`
- `estimated 4 turns`

Do not present guessed values as real execution metrics.
