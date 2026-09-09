export const ENCOUNTER_DRAFT_PATCH_SCHEMA = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["encounter", "off_topic", "unclear"],
      description: "Classifies whether the user message is about creating/modifying an encounter, completely off-topic, or unclear."
    },
    title: {
      type: "object",
      properties: {
        value: { type: "string" },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] },
        originalText: { type: "string" }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    },
    description: {
      type: "object",
      properties: {
        value: { type: "string" },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    },
    dateIntent: {
      type: "object",
      properties: {
        value: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["absolute", "relative", "weekday", "range", "vague"] },
            day: { type: "integer" },
            month: { type: "integer" },
            year: { type: "integer" },
            value: { type: "string", enum: ["today", "tomorrow", "day_after_tomorrow", "this_weekend", "next_weekend", "next_week"] },
            weekday: { type: "string" },
            modifier: { type: "string", enum: ["this", "next"] },
            values: { type: "array", items: { type: "string" } },
            description: { type: "string" }
          },
          required: ["type"],
          additionalProperties: false
        },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    },
    timeIntent: {
      type: "object",
      properties: {
        value: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["exact", "approximate", "period", "after", "range", "vague"] },
            hour: { type: "integer" },
            minute: { type: "integer" },
            value: { type: "string", enum: ["morning", "afternoon", "evening", "night"] },
            startHour: { type: "integer" },
            startMinute: { type: "integer" },
            endHour: { type: "integer" },
            endMinute: { type: "integer" },
            description: { type: "string" }
          },
          required: ["type"],
          additionalProperties: false
        },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    },
    dateModeSignal: {
      type: "object",
      properties: {
        value: { type: "string", enum: ["fixed", "coordination"] },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    },
    modality: {
      type: "object",
      properties: {
        value: { type: "string", enum: ["presencial", "virtual"] },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    },
    locationText: {
      type: "object",
      properties: {
        value: { type: "string" },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    },
    virtualLink: {
      type: "object",
      properties: {
        value: { type: "string" },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    },
    themeHint: {
      type: "object",
      properties: {
        value: { type: "string" },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    },
    templateHint: {
      type: "object",
      properties: {
        value: { type: "string" },
        confidence: { type: "string", enum: ["explicit", "inferred_high", "inferred_low", "ambiguous"] }
      },
      required: ["value", "confidence"],
      additionalProperties: false
    }
  },
  additionalProperties: false
};

/**
 * Defensive schema validator ensuring the LLM output conforms strictly to ENCOUNTER_DRAFT_PATCH_SCHEMA.
 */
export function validatePatchOutput(data: unknown): { valid: boolean; error?: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, error: 'Output is not an object' };
  }

  const record = data as Record<string, unknown>;
  const allowedKeys = new Set([
    'scope',
    'title',
    'description',
    'dateIntent',
    'timeIntent',
    'dateModeSignal',
    'modality',
    'locationText',
    'virtualLink',
    'themeHint',
    'templateHint'
  ]);

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return { valid: false, error: `Disallowed property: ${key}` };
    }

    const field = record[key];

    if (key === 'scope') {
      if (typeof field !== 'string' || !['encounter', 'off_topic', 'unclear'].includes(field)) {
        return { valid: false, error: `Invalid scope: ${field}` };
      }
      continue;
    }

    if (typeof field !== 'object' || field === null) {
      return { valid: false, error: `Property ${key} must be an object` };
    }

    const fieldRecord = field as Record<string, unknown>;
    if (!('value' in fieldRecord) || !('confidence' in fieldRecord)) {
      return { valid: false, error: `Property ${key} must have value and confidence` };
    }

    const validConfidences = ['explicit', 'inferred_high', 'inferred_low', 'ambiguous'];
    if (!validConfidences.includes(String(fieldRecord.confidence))) {
      return { valid: false, error: `Invalid confidence in ${key}: ${fieldRecord.confidence}` };
    }
  }

  return { valid: true };
}

/**
 * Recursively deep-clones a JSON Schema object and removes `additionalProperties`
 * for compatibility with Google Gemini REST API's protobuf schema definition.
 * Does not mutate the original schema.
 */
export function sanitizeSchemaForGemini<T = Record<string, unknown>>(schema: T): T {
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'additionalProperties') {
      continue;
    }
    result[key] = sanitizeSchemaForGemini(value);
  }

  return result as T;
}

/**
 * Transforms a canonical JSON Schema into a strict-mode compatible JSON Schema for OpenAI Structured Outputs.
 * In OpenAI strict mode:
 * 1. Every object with `properties` MUST list all keys in `required`.
 * 2. Conceptually optional properties (those not in the original `required`) are made nullable
 *    (e.g., type: [type, "null"] or anyOf: [...anyOf, { type: "null" }]).
 * 3. `additionalProperties: false` is enforced on all objects.
 * 4. Does not mutate the original schema.
 */
export function sanitizeSchemaForOpenAI<T = Record<string, unknown>>(schema: T): T {
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForOpenAI(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  const record = schema as Record<string, unknown>;

  for (const [key, value] of Object.entries(record)) {
    result[key] = sanitizeSchemaForOpenAI(value);
  }

  if (result.type === 'object' && result.properties && typeof result.properties === 'object') {
    const origRequired = new Set(Array.isArray(record.required) ? (record.required as string[]) : []);
    const properties = result.properties as Record<string, unknown>;
    const allKeys = Object.keys(properties);
    const newProperties: Record<string, unknown> = {};

    for (const key of allKeys) {
      const propSchema = properties[key] as Record<string, unknown>;
      if (origRequired.has(key)) {
        newProperties[key] = propSchema;
      } else {
        // Conceptually optional: make nullable in strict mode
        if (propSchema.anyOf && Array.isArray(propSchema.anyOf)) {
          newProperties[key] = {
            ...propSchema,
            anyOf: [...propSchema.anyOf, { type: 'null' }],
          };
        } else if (propSchema.type) {
          const types = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type];
          if (!types.includes('null')) {
            newProperties[key] = {
              ...propSchema,
              type: [...types, 'null'],
            };
          } else {
            newProperties[key] = propSchema;
          }
        } else {
          newProperties[key] = {
            anyOf: [propSchema, { type: 'null' }],
          };
        }
      }
    }

    result.properties = newProperties;
    result.required = allKeys;
    result.additionalProperties = false;
  }

  return result as T;
}

/**
 * Detects whether a value is null, undefined, or a string sentinel ("null" / "undefined")
 * representing structural absence rather than genuine text content.
 */
export function isSentinelValue(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') {
    const trimmed = val.trim().toLowerCase();
    return trimmed === 'null' || trimmed === 'undefined';
  }
  return false;
}

/**
 * Strips null, undefined, and sentinel string values ("null", "undefined") recursively.
 * Translates model outputs back to the canonical EncounterDraftPatch structure.
 *
 * Specific rules:
 * 1. Omit null or undefined values.
 * 2. Omit string values that exactly match "null" or "undefined" (case-insensitive, trimmed).
 * 3. If a property is an EncounterDraftPatch wrapper object containing a 'value' property
 *    (e.g., title: { value: "null", confidence: "ambiguous" }), and its 'value' is a sentinel
 *    or null, omit the entire wrapper property from the patch so absence does not create
 *    hallucinated values or fail schema validation.
 * 4. Legitimate strings containing the word (e.g., "Null Island", "null pointer") are preserved.
 * 5. Does not mutate the original object.
 */
export function cleanNullProperties<T = unknown>(obj: T): T {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj
      .filter((item) => !isSentinelValue(item))
      .map(cleanNullProperties) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    // 1. Skip direct sentinel null / undefined values
    if (isSentinelValue(value)) {
      continue;
    }

    // 2. If property is a field wrapper object with a 'value' property
    // (e.g. title: { value: "null", ... } or modality: { value: null, ... })
    // and its 'value' is a sentinel null/undefined, drop the entire field wrapper
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'value' in (value as Record<string, unknown>) &&
      isSentinelValue((value as Record<string, unknown>).value)
    ) {
      continue;
    }

    // 3. Otherwise recursively clean
    result[key] = cleanNullProperties(value);
  }

  return result as T;
}

/**
 * Sanitizer for DeepSeek JSON mode.
 * Creates an isolated deep clone of the canonical schema without mutation,
 * maintaining optional properties without forcing them into required/nullable.
 */
export function sanitizeSchemaForDeepSeek<T = Record<string, unknown>>(schema: T): T {
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }
  return JSON.parse(JSON.stringify(schema));
}

/**
 * Patterns matching explicit temporal evidence for dates in user messages (Spanish).
 */
const DATE_EVIDENCE_PATTERNS = [
  /\b(hoy|mañana|manana|mañan|pasado\s+mañana|pasado\s+manana|pasadomanana|ayer|finde|fin\s+de\s+semana|semana)\b/i,
  /\b(lunes|martes|mi[eé]rcoles|miercoles|mie|jueves|juevs|jue|viernes|vierns|vie|s[aá]bado|sabado|sabdo|sab|domingo|domigo|dom)s?\b/i,
  /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/i,
  /\b(este|esta|pr[oó]xim[oa]|proxim[oa]|siguiente)\s+(semana|finde|mes|año|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i,
  /\b(el\s+)?\d{1,2}\s+(de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/i,
  /\b\d{1,2}[\/\-\.]\d{1,2}([\/\-\.]\d{2,4})?\b/,
  /\bentre\s+(el\s+)?\d{1,2}\s+y\s+(el\s+)?\d{1,2}\b/i,
  /\bel\s+\d{1,2}\b/i,
  /\b(cuando\s+puedan|cuando\s+podamos|votemos|coordinemos|qu[eé]\s+d[ií]a|definir\s+fecha)\b/i,
];

/**
 * Patterns matching durations or quantities of hours that must NOT be treated as a meeting start time.
 */
const DURATION_OR_QUANTITY_PATTERNS = [
  /\b(durante|por|evento\s+de|reuni[oó]n\s+de|juntada\s+de|cumplea[ñn]os\s+de|festival\s+de)\s+\d{1,2}\s*horas?\b/i,
  /\b\d{1,2}\s*(horas?\s+de\s+(duraci[oó]n|corrido)|horas?\s+seguidas?)\b/i,
];

/**
 * Patterns matching explicit temporal evidence for times in user messages (Spanish).
 */
const TIME_EVIDENCE_PATTERNS = [
  /\b(a\s+las?|alas?|tipo|tipoo|alrededor\s+de|cerca\s+de|despu[eé]s\s+de|despues\s+de|antes\s+de|entre)\s+\d{1,2}(:\d{2})?\s*(horas?)?\b/i,
  /\b(despu[eé]s\s+de\s+las?|despues\s+de\s+las?)\s+\d{1,2}\b/i,
  /\b\d{1,2}(:\d{2})\b/,
  /\b\d{1,2}\s*(hs|h|hrs|horas?|am|pm)\b/i,
  /\b(hoy|mañana|manana|ayer|este\s+\w+|el\s+\w+|esta\s+noche)\s+\d{1,2}\s*(horas?|hs|h|hrs)\b/i,
  /\b(1[0-2]|[1-9])\s*(am|pm)\b/i,
  /\b(2[0-3]|1[0-9])([0-5][0-9])\b/,
  /\b(al\s+mediod[ií]a|al\s+mediodia|mediod[ií]a|mediodia|a\s+la\s+madrugada|de\s+madrugada|a\s+medianoche|medianoche)\b/i,
  /\b(a\s+la|por\s+la|de\s+la|en\s+la)\s+(tarde|noche|mañana|manana)\b/i,
  /\b(despu[eé]s\s+del\s+laburo|despues\s+del\s+laburo)\b/i,
  /\b(tipo|a\s+la)\s+(una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/i,
];

export function hasDateEvidence(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return DATE_EVIDENCE_PATTERNS.some((p) => p.test(text));
}

export function hasTimeEvidence(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  // If the text contains duration patterns (e.g. "durante 24 horas", "evento de 24 horas"),
  // strip them first to verify if another real start-time expression exists.
  let cleaned = text;
  for (const pattern of DURATION_OR_QUANTITY_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  return TIME_EVIDENCE_PATTERNS.some((p) => p.test(cleaned));
}

/**
 * Deterministic guard that prunes hallucinated or unevidenced dateIntent and timeIntent:
 * 1. If dateIntent has type 'vague' or the user message lacks date evidence, drop dateIntent.
 * 2. If timeIntent has type 'vague' or the user message lacks time evidence, drop timeIntent.
 * Does not mutate the original patch.
 */
export function sanitizeTemporalIntents<T = Record<string, unknown>>(
  patch: T,
  message: string
): T {
  if (typeof patch !== 'object' || patch === null) return patch;

  const record = { ...(patch as Record<string, unknown>) };

  // If the interpretation is off-topic or unclear, defensively prune all draft fields
  if (record.scope === 'off_topic' || record.scope === 'unclear') {
    return { scope: record.scope } as unknown as T;
  }

  const hasDate = hasDateEvidence(message);
  const hasTime = hasTimeEvidence(message);

  if ('dateIntent' in record) {
    if (!hasDate) {
      delete record.dateIntent;
    }
  }

  if ('timeIntent' in record) {
    if (!hasTime) {
      delete record.timeIntent;
    }
  }

  return record as T;
}
