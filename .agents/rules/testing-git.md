---
trigger: model_decision
description: Estrategia de verificación proporcional, compuertas de regresión y buenas prácticas de Git.
---

# Verificación Proporcional y Gestión de Git

## 1. Verificación Proporcional al Riesgo
- **Ajustes localizados (UI / CSS / Textos):** Ejecutar exclusivamente los tests unitarios del componente o pantalla modificada.
- **Cambios estructurales / Seguridad / DB / Cross-Stack:**
  1. Tests específicos de la funcionalidad o migración.
  2. Comprobación de tipos: `npx tsc -b`.
  3. Verificación de build: `npm run build`.
  4. Suite de integración global (`node scripts/run-tests.mjs`) solo cuando el impacto lo justifique.
- **Optimización de tiempo:** Evitar ejecutar repetidamente la suite completa de 790+ tests cuando solo se editaron archivos aislados.

## 2. Disciplina en Control de Versiones (Git)
- **Aislamiento de tareas:** Antes de stagear, revisar `git status`. Stagear exclusivamente los archivos intervenidos por la tarea actual (`git add <archivo>`).
- **Respeto a cambios ajenos:** Si existen archivos modificados o sin trackear pertenecientes a otra tarea, **no modificarlos, no revertirlos y no incluirlos en el commit**.
- **Reglas de ramas:**
  - Prohibido hacer push directo a la rama `main`.
  - Prohibido el uso de `git push --force`.
  - Desarrollos y pruebas se integran en la rama `staging`.
- **Formato de Commit:** Seguir Conventional Commits (ej. `feat(auth):`, `fix(ui):`, `chore(security):`).
