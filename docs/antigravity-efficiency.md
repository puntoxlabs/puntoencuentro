# Registro de Eficiencia y Consumo — Antigravity

Este documento permite auditar y registrar el consumo de cuota, iteraciones y efectividad del agente por tarea realizada en PuntoEncuentro.

> **Nota:** Este archivo es de consulta y registro manual. No se carga automáticamente como regla en el contexto del agente.

---

## Plantilla de Registro por Tarea

Copiar y completar este bloque al finalizar cada sesión o tarea significativa:

```markdown
### [YYYY-MM-DD] — <Nombre de la Tarea>

- **Fecha:** YYYY-MM-DD
- **Proyecto:** PuntoEncuentro
- **Tarea:** <Descripción breve de la tarea>
- **Categoría:** <mechanical | frontend | bug | cross-stack | database | security | architecture>
- **Modelo:** <Nombre del modelo utilizado, ej. Claude 3.7 Sonnet / Gemini 2.5 Flash>
- **Effort / Reasoning:** <low | medium | high | none>

- **Cuota 5h antes:** XX%
- **Cuota 5h después:** YY%
- **Delta 5h:** -ZZ%

- **Cuota semanal antes:** XX%
- **Cuota semanal después:** YY%
- **Delta semanal:** -ZZ%

- **Duración estimada:** XX min
- **Prompts necesarios:** N (cantidad de interacciones o continuaciones)

- **Resultado:** <first-pass | correction-needed | failed>
- **Observaciones:** <Comentarios sobre desvíos, exploraciones innecesarias o lecciones aprendidas>
```

---

## Historial de Tareas

*(Los registros completados se incorporan a continuación manteniendo orden cronológico)*
