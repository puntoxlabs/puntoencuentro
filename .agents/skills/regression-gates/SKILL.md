---
name: regression-gates
description: Protocolo de verificación y compuertas de calidad proporcional al riesgo del cambio (tests específicos, comprobación TypeScript, build de producción y suite de regresión). Usar antes de dar por concluida una tarea o preparar un commit.
---

# Protocolo de Compuertas de Regresión (Regression Gates)

Este protocolo asegura que los cambios introducidos no generen regresiones, aplicando un nivel de validación proporcional al alcance del cambio para optimizar tiempo y cuota de ejecución.

## 1. Clasificación del Alcance

| Nivel de Riesgo | Tipo de Cambio | Compuertas Requeridas |
| :--- | :--- | :--- |
| **Nivel 1 (Local)** | UI, estilos, textos, corrección menor en un componente | Tests específicos del componente |
| **Nivel 2 (Medio)** | Servicios, Zustand stores, hooks, parsers | Tests específicos + `tsc -b` |
| **Nivel 3 (Alto)** | Base de datos, Auth, seguridad, Edge Functions, cross-stack | Tests específicos + `tsc -b` + `npm run build` + suite de integración |

## 2. Ejecución Paso a Paso

### Paso 1: Tests Específicos
Ejecutar la suite o script de prueba que cubre directamente el módulo modificado:
```bash
node scripts/test-<modulo>.mjs
# o ejecutar el archivo de test directo con node / vite
```
Asegurar que los tests específicos pasen al 100% antes de avanzar.

### Paso 2: Comprobación Estricta de Tipos (Nivel 2 y 3)
Verificar que no existan errores de compilación TypeScript en todo el proyecto:
```bash
npx --workspaces=false tsc -b
```
Criterio de éxito: Salida con código 0 y 0 errores.

### Paso 3: Verificación de Build de Producción (Nivel 3)
Asegurar que la aplicación empaqueta sin dependencias rotas ni errores de importación estática:
```bash
npm --workspaces=false run build
```
Criterio de éxito: Salida `built in X ms` con código 0.

### Paso 4: Suite Global de Integración (Nivel 3 cuando se justifique)
Solo para cambios de alta sensibilidad o previo a despliegues mayores:
```bash
node scripts/run-tests.mjs
```
Verificar que la totalidad de pruebas reporten `fail: 0`.

## 3. Criterio de Finalización
Documentar en el informe final el estado de cada compuerta ejecutada (`PASS` / `FAIL`). Si alguna compuerta falla, corregir la causa raíz antes de proponer cualquier commit.
