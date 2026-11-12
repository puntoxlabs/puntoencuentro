---
trigger: model_decision
description: Directivas para la gestión, nomenclatura, trazabilidad, ciclo de vida e higiene no destructiva de datos de prueba (fixtures QA) en Supabase Staging.
---

# Gestión Permanente de Fixtures y Datos QA en Staging

Este documento formaliza la política de gobierno de datos para el desarrollo, pruebas automatizadas y aseguramiento de calidad (QA) sobre el entorno de desarrollo remoto de Supabase Staging.

---

## 1. Topología de Entornos y Bloqueo de Producción
- **Staging Único (`wougfhfwqgmxhgvjqoua`):** Destino exclusivo para fixtures, seeds de prueba y ejecuciones de QA.
- **Producción Inviolable (`aurbicjwftjhwryhyjiq`):** Queda estrictamente prohibida la creación, modificación, reseteo o eliminación de fixtures en Producción.
- **Fail-Closed:** Todo script o herramienta de mantenimiento debe importar e invocar `assertStagingEnvironment()` de `scripts/lib/environment-guard.ts` antes de cualquier interacción con la base de datos remota.

---

## 2. Nomenclatura y Prefijos Obligatorios
Todo encuentro creado con propósitos de prueba o automatización debe incluir inequívocamente en su `titulo` y `open_public_title` uno de los siguientes prefijos estandarizados:

1. **`[QA-STABLE]` (Canónicos Permanentes):**
   - Reservado exclusivamente a los 4 escenarios de referencia arquitectónica (Virtual, Cupo Lleno, Solicitudes, Presencial Localidad).
   - UUIDs deterministas fijos (`e0000000-0000-4000-8000-000000000001` a `...0004`).
   - Administrados mediante scripts idempotentes (`WHERE (...) IS DISTINCT FROM (...)`).
   - No deben ser mutados destructivamente por pruebas temporales.
2. **`[QA-E2E:<runId>]` (Pruebas Automatizadas de Integración / CI):**
   - Generados por pipelines o runners de Playwright. Deben incorporar obligatoriamente un runId o timestamp verificable (ej. `[QA-E2E:1794266665965]`).
   - Vida útil: acotada a la duración de la corrida de pruebas.
3. **`[QA-DYN:<suiteId>]` (Pruebas Dinámicas Transaccionales):**
   - Utilizados para evaluar flujos con mutaciones de estado (postulación, aprobación, cancelaciones, cambios de cupos).
   - Deben crearse con UUIDs dedicados para no contaminar los fixtures `[QA-STABLE]`.
4. **`[QA-TMP]` (Pruebas Manuales Exploratorias):**
   - Creados por desarrolladores o testers para validaciones ad-hoc. Deben desactivarse al concluir la verificación.

---

## 3. Identificación Verificable de Propiedad y Procedencia
- **Cuentas Sintéticas Aisladas:** Todo fixture debe pertenecer exclusivamente a cuentas sintéticas dedicadas del dominio de pruebas (`qa-*@puntoencuentro.test`).
- **Prohibición Absoluta sobre Cuentas Reales:** Jamás asociar fixtures ni solicitudes de prueba a cuentas de usuarios reales ni a los administradores del proyecto (`2a4073ae-d1fb-42be-b19b-6dbb4fc66101` / Leandro Vega).
- **Trazabilidad:** Cada runner debe registrar en consola y en artefactos de auditoría el `runId`, el autor técnico del script y los UUIDs generados.

---

## 4. Reutilización vs. Aislamiento de Fixtures
- **Pruebas de Solo Lectura:** Las suites de regresión funcional, discovery, inspección visual de carrusel y chequeo de permisos deben **reutilizar los 4 fixtures `[QA-STABLE]` en modo lectura** en lugar de generar nuevos registros en cada corrida.
- **Pruebas de Mutación Dinámica:** Las pruebas que requieran alterar estados (aprobar postulantes, cerrar inscripciones, cancelar encuentros) deben **crear un fixture transaccional dedicado `[QA-DYN]`** o ejecutar un procedimiento atómico de reset inmediatamente posterior para devolver el fixture a su línea base.

---

## 5. Control de Concurrencia y Aislamiento de Operaciones
- **Advisory Locks Transaccionales:** Toda operación de mantenimiento, seed masivo o suite dinámica debe adquirir un bloqueo de serialización a nivel de PostgreSQL:
  ```sql
  SELECT pg_advisory_xact_lock(hashtext('puntoencuentro_qa_fixtures_lock'));
  ```
  Esto previene condiciones de carrera o colisiones cuando múltiples agentes o pipelines operan simultáneamente en Staging.
- **Aislamiento por Manifiesto:** Los scripts de teardown o reset **nunca** deben ejecutar queries amplias basadas en patrones genéricos (`LIKE '%QA%'`). Solo deben operar sobre UUIDs explícitamente declarados en manifiestos JSON o vinculados al `runId` activo de la sesión.

---

## 6. Higiene No Destructiva (Invariante Universal)
- **Prohibido `DELETE` en la tabla `encuentros`:**
  - Los encuentros de prueba vencidos, duplicados o descartables se higienizan exclusivamente actualizando `is_open = false` y conservando `estado = 'activo'`.
  - Esto preserva íntegramente la integridad referencial histórica (`participantes`, `solicitudes_encuentro_abierto`, `reportes_encuentro`) y previene fallos por claves foráneas o triggers.
- **Sin Automatizaciones con Escritura en Background:**
  - No se configuran cron jobs, triggers de eliminación automática ni workers autónomos con permisos de escritura para limpieza.
  - La higiene se realiza de forma deliberada, asistida por scripts transaccionales y con dry-run de solo lectura previo.

---

## 7. Salvaguarda de Autorización Explícita
- Conforme a la regla universal de `AGENTS.md`, toda operación que modifique registros de fixtures en lote, ejecute resets o aplique teardowns requiere **autorización previa y explícita del usuario**.
- Antes de ejecutar, el agente debe presentar el plan, los UUIDs alcanzados, las precondiciones y el mecanismo de reversión.

---

## 8. Lista Blanca Inviolable de Datos Protegidos
Quedan formalmente declarados como **inviolables e inmutables** los siguientes conjuntos de datos en Staging:
1. **8 Encuentros Legítimos (Leandro Vega / Punto X Labs):**
   `4e30c9e2-5d0c-4702-92b9-cc5afaa1bc95`, `66cc0a49-5998-4ec8-a7de-aeb8de0f8bd9`, `6463d438-6862-4e92-97a5-deabe9649c6b`, `4c93c5dc-1669-423d-bc74-6a65c93c12c7`, `0323db67-d695-468d-85e6-132c6ec7d49f`, `951663b3-8f3e-4eb8-a2bc-004c1e6a67c9`, `d2450708-88ea-477c-ae48-a2eee47ef635`, `95ea3aea-5eed-4fd6-8531-7b16ce42b973`.
2. **6 Encuentros Inciertos:**
   `e8a238ac-e4ba-4844-9fb7-c05e594f43fb`, `49c60a88-23e5-48e3-bcf1-04fe989c1286`, `b35c498b-0e89-4704-a693-45f105215ea5`, `f75faae9-677c-4cae-b99d-ab78f6cd6253`, `da2d35ac-0e2b-42e6-b8ad-5c8ee6643526`, `ad72c95d-ddb2-4438-9731-5af91e188345`.
3. **11 Fixtures Útiles Preservados:**
   Los 5 encuentros con reportes de moderación pendientes (`fa14e64c-...`, `8569ecd9-...`, etc.) y los 6 funcionales de sprint QA.
4. **1 Fixture E2E Futuro Adicional:**
   UUID `f4123f9a-28d3-43c3-8e70-dd95b4e157cf` (`"[QA-E2E:min_mvdcts8s_4ii6] Encuentro Mínimo QA"`, fecha `2026-12-01`, `is_open: true`, `estado: activo`).

Total: **26 registros preexistentes protegidos e inviolables**. Cualquier transacción que intente modificar un registro perteneciente a la lista blanca debe abortar inmediatamente (`fail-closed`).
