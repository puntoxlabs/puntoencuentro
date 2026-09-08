# Especificación: Crear con IA — Entrega A (Beta)

> **Documento:** `docs/specs/ai-assisted-encounter-creation.md`  
> **Estado:** Aprobado para Implementación  
> **Versión:** 2.1 (con Ajustes Finales)  
> **Fase:** Etapa 1.0 — Entrega A  

---

## 1. Visión y Principios Rectores

PuntoEncuentro introduce la alternativa **"Crear con IA · Beta"** para complementar el formulario manual existente:
- **"Crear manualmente"** (wizard actual de 4 pasos)
- **"Crear con IA · Beta"** (asistente conversacional transaccional)

### Principio Rector
> *"La IA decide qué interpretar o intentar; la lógica de negocio determina qué puede ejecutarse."*

### Reglas de Arquitectura
1. **Intérprete semántico puro:** El LLM extrae intención y estructura en tokens semánticos. No aplica reglas de negocio, no calcula fechas relativas, no completa campos con defaults silenciosos, no valida completitud final.
2. **Backend seguro y desacoplado:** La llamada a IA se realiza a través de una Supabase Edge Function (`ai-interpret`) con API key estrictamente server-side.
3. **Sin acceso a DB:** El LLM no lee ni escribe directamente en Supabase, no ejecuta SQL, ni tiene permisos administrativos.
4. **Misma vía de creación:** La creación definitiva utiliza `encuentrosService.createEncuentro(...)` y la función PostgreSQL `crear_encuentro_seguro` existente.
5. **Creación manual siempre disponible:** Una falla de IA nunca bloquea la funcionalidad de PuntoEncuentro. Fallback inmediato con precarga de datos interpretados válidos.

---

## 2. Ajustes Obligatorios de Implementación

### Ajuste 1: Mínimo Privilegio para Metering
- El registro de sesiones y telemetría de IA no utiliza `service_role` de forma indiscriminada.
- Se implementan RPCs específicas con alcance acotado:
  - `registrar_sesion_ai_inicio`: Inicia la sesión para el usuario autenticado (anónimo o permanente).
  - `registrar_sesion_ai_fin`: Cierra la sesión (completed, fallback_manual, error) con métricas acumuladas.
- RLS estricta sobre la tabla `ai_creation_sessions`.

### Ajuste 2: Abandono Derivado
- No se depende de `beforeunload` o eventos de cierre de ventana para marcar `status = 'abandoned'`.
- Sesiones con `status = 'started'` que no se completen en un período razonable (ej. > 2 horas) se derivan como abandonadas en las consultas de analítica.
- El cliente actualiza explícitamente `status = 'completed'`, `'fallback_manual'` o `'error'` cuando el evento ocurre en la aplicación.

### Ajuste 3: Fechas Absolutas sin Año Inventado
- Si el usuario indica una fecha sin año (ej. "15 de septiembre"), el LLM emite un token semántico con día y mes, pero **sin año**.
- El código determinístico (`dateResolver.ts`) resuelve el año adecuado usando la fecha actual en `America/Argentina/Buenos_Aires`:
  - Si el día/mes en el año corriente es futuro respecto a hoy, usa el año corriente.
  - Si ya pasó en el año corriente, evalúa el año siguiente.
- Solo se acepta un año explícito si el usuario lo declaró inequívocamente.

### Ajuste 4: Mapeo Canónico de Visibilidad de Respuestas
- Al traducir `InvitationConfig` al DTO y backend existente:
  - `visibilidad_respuestas_invitados` = `responseVisibility` (`'hidden' | 'summary' | 'detail'`)
  - `mostrar_respuestas_a_invitados` = `(responseVisibility !== 'hidden')`
- Esto garantiza compatibilidad bidireccional exacta con las RPCs existentes `crear_encuentro_seguro` y `set_visibilidad_respuestas_invitados`.

---

## 3. Modelo de Dominio y Contratos

### 3.1 Contratos de Interpretación (Salida del LLM)

```typescript
export type FieldConfidence = 'explicit' | 'inferred_high' | 'inferred_low' | 'ambiguous';

export interface InterpretedField<T> {
  value: T;
  confidence: FieldConfidence;
  originalText?: string;
  alternatives?: T[];
}

export type RelativeDateToken =
  | 'today'
  | 'tomorrow'
  | 'day_after_tomorrow'
  | 'this_weekend'
  | 'next_weekend'
  | 'next_week';

export type DateIntent =
  | { type: 'absolute'; day: number; month: number; year?: number }
  | { type: 'relative'; value: RelativeDateToken }
  | { type: 'weekday'; weekday: string; modifier?: 'this' | 'next' }
  | { type: 'range'; values: string[] }
  | { type: 'vague'; description: string };

export type TimeIntent =
  | { type: 'exact'; hour: number; minute: number }
  | { type: 'approximate'; hour: number; minute: number }
  | { type: 'period'; value: 'morning' | 'afternoon' | 'evening' | 'night' }
  | { type: 'after'; hour: number; minute: number }
  | { type: 'range'; startHour: number; startMinute: number; endHour: number; endMinute: number }
  | { type: 'vague'; description: string };

export interface EncounterDraftPatch {
  title?: InterpretedField<string>;
  description?: InterpretedField<string>;
  dateIntent?: InterpretedField<DateIntent>;
  timeIntent?: InterpretedField<TimeIntent>;
  dateModeSignal?: InterpretedField<'fixed' | 'coordination'>;
  modality?: InterpretedField<'presencial' | 'virtual'>;
  locationText?: InterpretedField<string>;
  virtualLink?: InterpretedField<string>;
  themeHint?: InterpretedField<string>;
}
```

### 3.2 Contratos Canónicos del Encuentro

```typescript
export interface EncounterDraft {
  title: string | null;
  description: string | null;
  dateMode: 'fixed' | 'coordination' | null;
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:MM
  modality: 'presencial' | 'virtual' | null;
  locationText: string | null;
  virtualLink: string | null;
}

export interface InvitationConfig {
  invitationType: 'individual' | 'link_general'; // default: 'link_general'
  invitationTheme: InvitationTheme;               // default: 'classic'
  invitationTemplate: string | null;              // default: auto por tema
  responseVisibility: 'hidden' | 'summary' | 'detail'; // default: 'hidden'
}

export interface CreationMetadata {
  hostId: string;
  replacesEncounterId: string | null;
  postEventActiveMinutes: number;
}
```

---

## 4. Arquitectura de Resolución y Validación Determinística

```
Usuario escribe
      │
      ▼
Edge Function (ai-interpret)
  - Auth JWT check
  - Rate limiting
  - Llama LLM con JSON Schema
  - Retorna EncounterDraftPatch + usage
      │
      ▼
Frontend Domain Engine
  1. draftMerger.ts: Aplica patch acumulativo al EncounterDraft
  2. dateResolver.ts: Resuelve DateIntent / TimeIntent en America/Argentina/Buenos_Aires
  3. draftFieldEngine.ts:
     - Evalúa completitud según modalidad y reglas
     - Detecta campos 'missing', 'ambiguous', 'needs_confirmation'
     - Si hay señal de coordinación -> deriva a wizard coordinación
     - Si faltan datos -> emite pregunta determinística en orden de prioridad
     - Si está completo -> emite resumen listo para confirmar
      │
      ▼
Usuario confirma en resumen
      │
      ▼
Traducción determinística a CreateEncuentroDTO
      │
      ▼
encuentrosService.createEncuentro() -> RPC crear_encuentro_seguro
```

### 4.1 Prioridad de Preguntas Determinísticas
1. `title`: Si no hay título -> "¿Cómo se llama el encuentro?"
2. `dateMode`: Si hay intención de coordinar -> Handoff a `/create/coordination`
3. `date`: Si no hay fecha -> "¿Qué día sería?"
4. `time`: Si no hay hora -> "¿A qué hora?"
5. `modality`: **Sin default silencioso**. Si no se deduce por contexto -> "¿Va a ser presencial o virtual?"
6. `locationText` / `virtualLink`: Según modalidad -> "¿Dónde se encuentran?" o "¿Cuál es el link?"

---

## 5. Telemetría y Metering (Entrega A)

Tabla en PostgreSQL: `ai_creation_sessions`

| Columna | Tipo | Restricción / Propósito |
|---|---|---|
| `id` | `uuid` | PK default `gen_random_uuid()` |
| `user_id` | `uuid` | FK a `auth.users(id)` |
| `status` | `text` | `CHECK (status IN ('started', 'completed', 'abandoned', 'error', 'fallback_manual'))` |
| `date_mode` | `text` | `'fixed'` |
| `encounter_id` | `uuid` | FK opcional a `encuentros(id)` |
| `turns` | `int` | Turnos acumulados de interacción |
| `total_input_tokens` | `int` | Tokens de entrada |
| `total_output_tokens`| `int` | Tokens de salida |
| `provider` | `text` | Identificador del proveedor utilizado |
| `model` | `text` | Identificador del modelo |
| `total_latency_ms` | `int` | Latencia acumulada |
| `elapsed_ms` | `int` | Tiempo total transcurrido |
| `error_type` | `text` | Clasificación de error si hubo |
| `created_at` | `timestamptz` | Inicio de sesión |
| `completed_at` | `timestamptz` | Conclusión de sesión |

---

## 6. Criterios de Aceptación de Entrega A
- [x] Documentación versionada creada en `docs/specs/ai-assisted-encounter-creation.md`.
- [x] Contratos TypeScript separados (Draft, Patch, Intent, Metadata).
- [x] Lógica de resolución y merging determinística con tests unitarios.
- [x] Edge function con validación estricta y JSON Schema.
- [x] Benchmark harness reproducible implementado con 60 casos, ground truth y motor de scoring (ejecución empírica pendiente de credenciales).
- [x] Pantalla `/create/ai` operativa, mobile-first con feedback reactivo.
- [x] Handoff claro a coordinación si se detecta intención de coordinar.
- [x] Fallback transparente a wizard manual sin pérdida de datos.
- [x] Creación real mediante `encuentrosService.createEncuentro` y RPC existente.
- [x] `npm run build` sin errores de compilación ni linting.
