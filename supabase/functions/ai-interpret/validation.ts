export const ENCOUNTER_DRAFT_PATCH_SCHEMA = {
  type: "object",
  properties: {
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
    'title',
    'description',
    'dateIntent',
    'timeIntent',
    'dateModeSignal',
    'modality',
    'locationText',
    'virtualLink',
    'themeHint'
  ]);

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return { valid: false, error: `Disallowed property: ${key}` };
    }

    const field = record[key];
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
 * Strips null and undefined values from an object recursively.
 * Used to translate OpenAI strict outputs (where optional fields return null)
 * back to the canonical EncounterDraftPatch structure.
 */
export function cleanNullProperties<T = unknown>(obj: T): T {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(cleanNullProperties) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== null && value !== undefined) {
      result[key] = cleanNullProperties(value);
    }
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
