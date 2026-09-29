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
