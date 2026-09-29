# Registro de Eficiencia y Consumo — Antigravity

Este documento permite auditar y registrar el consumo de cuota, iteraciones y efectividad del agente por tarea realizada en PuntoEncuentro.

> **Nota:** Este archivo es de consulta y registro manual. No se carga automáticamente como regla en el contexto del agente.
> **Regla de métricas:** Registrar únicamente valores reales provistos por la interfaz. Si una métrica no está disponible, asentar exactamente: `"no disponible desde esta interfaz"`. Jamás estimar ni aproximar valores.

---

## Plantilla de Registro por Tarea

Copiar y completar este bloque al finalizar cada sesión o tarea significativa:

```markdown
### [YYYY-MM-DD] — <Nombre de la Tarea>

- **Fecha:** YYYY-MM-DD
- **Proyecto:** PuntoEncuentro
- **Tarea:** <Descripción breve de la tarea>
- **Categoría:** <mechanical | frontend | bug | cross-stack | database | security | architecture>
- **Modelo:** <Nombre del modelo utilizado, ej. Claude 3.7 Sonnet / Gemini 3.8 Flash>
- **Effort / Reasoning:** <low | medium | high | none>

- **Cuota 5h antes:** XX% (o "no disponible desde esta interfaz")
- **Cuota 5h después:** YY% (o "no disponible desde esta interfaz")
- **Delta 5h:** -ZZ% (o "no disponible desde esta interfaz")

- **Cuota semanal antes:** XX% (o "no disponible desde esta interfaz")
- **Cuota semanal después:** YY% (o "no disponible desde esta interfaz")
- **Delta semanal:** -ZZ% (o "no disponible desde esta interfaz")

- **Duración:** XXs (o "no disponible desde esta interfaz")
- **Prompts necesarios:** N (o "no disponible desde esta interfaz")

- **Resultado:** <first-pass | correction-needed | failed>
- **Observaciones:** <Comentarios sobre desvíos, exploraciones innecesarias o lecciones aprendidas>
```

---

## Historial de Tareas

*(Los registros completados se incorporan a continuación manteniendo orden cronológico)*
