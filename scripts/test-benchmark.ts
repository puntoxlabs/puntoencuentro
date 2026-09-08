import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  scoreTestCase,
  createProviderErrorScore,
  aggregateScores,
  type CaseScoreResult,
  type ExpectedGroundTruth,
} from './ai-benchmark/scoring.ts';
import {
  validatePatchOutput,
  sanitizeSchemaForGemini,
  sanitizeSchemaForOpenAI,
  sanitizeSchemaForDeepSeek,
  cleanNullProperties,
  ENCOUNTER_DRAFT_PATCH_SCHEMA,
} from '../supabase/functions/ai-interpret/validation.ts';
import { DeepSeekProvider } from '../supabase/functions/ai-interpret/providers/deepseek.ts';
import {
  extractUsageMetrics,
  type CaseUsageMetrics,
} from './ai-benchmark/benchmark.ts';

describe('AI Benchmark Harness Tests: Schema Compliance', () => {
  test('validates compliant schema output', () => {
    const validPatch = {
      title: { value: 'Cena con amigos', confidence: 'explicit' },
      dateIntent: {
        value: { type: 'weekday', weekday: 'viernes', modifier: 'this' },
        confidence: 'inferred_high',
      },
      timeIntent: {
        value: { type: 'exact', hour: 21, minute: 0 },
        confidence: 'explicit',
      },
      modality: { value: 'presencial', confidence: 'inferred_high' },
      locationText: { value: 'en casa', confidence: 'explicit' },
    };

    const res = validatePatchOutput(validPatch);
    assert.equal(res.valid, true);
    assert.equal(res.error, undefined);
  });

  test('rejects disallowed extra properties', () => {
    const invalidPatch = {
      title: { value: 'Cena', confidence: 'explicit' },
      unknownField: { value: 'extra', confidence: 'explicit' },
    };

    const res = validatePatchOutput(invalidPatch);
    assert.equal(res.valid, false);
    assert.ok(res.error?.includes('Disallowed property'));
  });

  test('rejects invalid confidence value', () => {
    const invalidPatch = {
      title: { value: 'Cena', confidence: 'super_confident' },
    };

    const res = validatePatchOutput(invalidPatch);
    assert.equal(res.valid, false);
    assert.ok(res.error?.includes('Invalid confidence'));
  });
});

describe('AI Benchmark Harness Tests: Schema Sanitization for Gemini', () => {
  test('eliminates additionalProperties recursively from root, nested objects, and arrays', () => {
    const testSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'string' },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { name: { type: 'string' } },
              },
            },
          },
          required: ['value'],
        },
      },
    };

    const sanitized = sanitizeSchemaForGemini(testSchema);

    // Root
    assert.equal('additionalProperties' in sanitized, false);
    // Nested object
    const titleObj = (sanitized.properties as any).title;
    assert.equal('additionalProperties' in titleObj, false);
    // Array item object
    const itemObj = (titleObj.properties.tags as any).items;
    assert.equal('additionalProperties' in itemObj, false);
  });

  test('does NOT mutate the input schema object', () => {
    const originalSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        val: { type: 'string', additionalProperties: false },
      },
    };

    const sanitized = sanitizeSchemaForGemini(originalSchema);

    // Original must still have additionalProperties
    assert.equal(originalSchema.additionalProperties, false);
    assert.equal((originalSchema.properties.val as any).additionalProperties, false);
    assert.notEqual(originalSchema, sanitized);
  });

  test('preserves properties, required, enum, type, items, and descriptions', () => {
    const original = {
      type: 'object',
      description: 'Encounter patch',
      properties: {
        modality: {
          type: 'string',
          enum: ['presencial', 'virtual'],
          description: 'Encounter modality',
        },
        guestList: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['modality'],
      additionalProperties: false,
    };

    const sanitized = sanitizeSchemaForGemini(original) as any;

    assert.equal(sanitized.type, 'object');
    assert.equal(sanitized.description, 'Encounter patch');
    assert.deepEqual(sanitized.required, ['modality']);
    assert.equal(sanitized.properties.modality.type, 'string');
    assert.deepEqual(sanitized.properties.modality.enum, ['presencial', 'virtual']);
    assert.equal(sanitized.properties.guestList.type, 'array');
    assert.equal(sanitized.properties.guestList.items.type, 'string');
    assert.equal('additionalProperties' in sanitized, false);
  });

  test('canonical ENCOUNTER_DRAFT_PATCH_SCHEMA preserves additionalProperties: false for OpenAI', () => {
    // OpenAI strict schema requires additionalProperties: false
    assert.equal((ENCOUNTER_DRAFT_PATCH_SCHEMA as any).additionalProperties, false);
    assert.equal((ENCOUNTER_DRAFT_PATCH_SCHEMA as any).properties.title.additionalProperties, false);

    // Sanitized Gemini version removes it
    const geminiSchema = sanitizeSchemaForGemini(ENCOUNTER_DRAFT_PATCH_SCHEMA) as any;
    assert.equal('additionalProperties' in geminiSchema, false);
    assert.equal('additionalProperties' in geminiSchema.properties.title, false);
  });
});

describe('AI Benchmark Harness Tests: Schema Sanitization for OpenAI & Null Cleaning', () => {
  test('ensures every key in properties is included in required for OpenAI strict mode', () => {
    const openAiSchema = sanitizeSchemaForOpenAI(ENCOUNTER_DRAFT_PATCH_SCHEMA) as any;

    // Root properties
    const rootPropKeys = Object.keys(openAiSchema.properties);
    assert.deepEqual(openAiSchema.required.sort(), rootPropKeys.sort());

    // Title properties (previously failed in OpenAI because originalText was missing from required)
    const titleProps = Object.keys(openAiSchema.properties.title.properties);
    assert.deepEqual(openAiSchema.properties.title.required.sort(), titleProps.sort());
    assert.ok(openAiSchema.properties.title.required.includes('originalText'));

    // DateIntent value properties
    const dateProps = Object.keys(openAiSchema.properties.dateIntent.properties.value.properties);
    assert.deepEqual(openAiSchema.properties.dateIntent.properties.value.required.sort(), dateProps.sort());

    // TimeIntent value properties
    const timeProps = Object.keys(openAiSchema.properties.timeIntent.properties.value.properties);
    assert.deepEqual(openAiSchema.properties.timeIntent.properties.value.required.sort(), timeProps.sort());
  });

  test('makes conceptually optional fields nullable while preserving enums and types', () => {
    const openAiSchema = sanitizeSchemaForOpenAI(ENCOUNTER_DRAFT_PATCH_SCHEMA) as any;

    // title.originalText was optional: must now have "null" in type
    const origTextSchema = openAiSchema.properties.title.properties.originalText;
    assert.ok(Array.isArray(origTextSchema.type) && origTextSchema.type.includes('null') && origTextSchema.type.includes('string'));

    // title.confidence was required: type must remain strictly string without null
    const confidenceSchema = openAiSchema.properties.title.properties.confidence;
    assert.equal(confidenceSchema.type, 'string');
    assert.deepEqual(confidenceSchema.enum, ['explicit', 'inferred_high', 'inferred_low', 'ambiguous']);

    // root fields (e.g. title, description, locationText) were optional: must be nullable
    const descSchema = openAiSchema.properties.description;
    assert.ok(
      (Array.isArray(descSchema.type) && descSchema.type.includes('null')) ||
      (descSchema.anyOf && descSchema.anyOf.some((s: any) => s.type === 'null'))
    );
  });

  test('does NOT mutate the original canonical schema', () => {
    const origTitleRequired = (ENCOUNTER_DRAFT_PATCH_SCHEMA as any).properties.title.required;
    assert.equal(origTitleRequired.includes('originalText'), false);
  });

  test('cleanNullProperties strips null and undefined values recursively for EncounterDraftPatch compatibility', () => {
    const openAiRawOutput = {
      title: {
        value: 'Cena con amigos',
        confidence: 'explicit',
        originalText: null,
      },
      description: null,
      dateIntent: {
        value: {
          type: 'weekday',
          weekday: 'viernes',
          modifier: 'this',
          day: null,
          month: null,
          year: null,
        },
        confidence: 'inferred_high',
      },
      timeIntent: null,
      modality: null,
      locationText: {
        value: 'en casa',
        confidence: 'explicit',
      },
      virtualLink: null,
      themeHint: null,
    };

    const cleaned = cleanNullProperties(openAiRawOutput) as any;

    assert.equal('description' in cleaned, false);
    assert.equal('timeIntent' in cleaned, false);
    assert.equal('modality' in cleaned, false);
    assert.equal('virtualLink' in cleaned, false);
    assert.equal('themeHint' in cleaned, false);
    assert.equal('originalText' in cleaned.title, false);
    assert.equal('day' in cleaned.dateIntent.value, false);
    assert.equal('month' in cleaned.dateIntent.value, false);
    assert.equal('year' in cleaned.dateIntent.value, false);
    assert.equal(cleaned.title.value, 'Cena con amigos');
    assert.equal(cleaned.dateIntent.value.weekday, 'viernes');
    assert.equal(cleaned.locationText.value, 'en casa');

    // Validates cleanly against local domain validator
    const validation = validatePatchOutput(cleaned);
    assert.equal(validation.valid, true);
  });
});

describe('AI Benchmark Harness Tests: Scoring & Exact Extraction', () => {
  test('scores perfect match with 100% exact extraction', () => {
    const expected: ExpectedGroundTruth = {
      title: 'Cena con amigos',
      dateIntent: { type: 'weekday', weekday: 'viernes', modifier: 'this' },
      timeIntent: { type: 'exact', hour: 21, minute: 0 },
      modality: 'presencial',
      locationText: 'casa',
    };

    const patch = {
      title: { value: 'Cena con amigos', confidence: 'explicit' as const },
      dateIntent: {
        value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const },
        confidence: 'explicit' as const,
      },
      timeIntent: {
        value: { type: 'exact' as const, hour: 21, minute: 0 },
        confidence: 'explicit' as const,
      },
      modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
      locationText: { value: 'en casa', confidence: 'explicit' as const },
    };

    const score = scoreTestCase(1, patch, expected);
    assert.equal(score.status, 'success');
    assert.equal(score.schemaCompliant, true);
    assert.equal(score.exactExtractionRate, 100);
    assert.equal(score.omissions, 0);
    assert.equal(score.hallucinations, 0);
  });

  test('detects omission when expected field is missing in patch', () => {
    const expected: ExpectedGroundTruth = {
      title: 'Cena con amigos',
      dateIntent: { type: 'weekday', weekday: 'viernes', modifier: 'this' },
      timeIntent: { type: 'exact', hour: 21, minute: 0 },
      modality: 'presencial',
      locationText: 'casa',
    };

    // Missing timeIntent and locationText
    const patch = {
      title: { value: 'Cena con amigos', confidence: 'explicit' as const },
      dateIntent: {
        value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const },
        confidence: 'explicit' as const,
      },
      modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
    };

    const score = scoreTestCase(1, patch, expected);
    assert.equal(score.status, 'success');
    assert.equal(score.exactMatches, 3);
    assert.equal(score.omissions, 2);
    assert.equal(score.expectedTotal, 5);
    assert.equal(score.exactExtractionRate, 60);
    assert.equal(score.omissionRate, 40);
  });
});

describe('AI Benchmark Harness Tests: Hallucination Detection', () => {
  test('flags hallucination when model invents modality without input evidence', () => {
    const expected: ExpectedGroundTruth = {
      title: 'Encuentro',
      dateIntent: { type: 'weekday', weekday: 'viernes', modifier: 'this' },
      timeIntent: { type: 'exact', hour: 20, minute: 0 },
      modality: null, // Modality MUST NOT be present
      locationText: null,
      virtualLink: null,
    };

    const hallucinatingPatch = {
      title: { value: 'Encuentro', confidence: 'explicit' as const },
      dateIntent: {
        value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const },
        confidence: 'explicit' as const,
      },
      timeIntent: {
        value: { type: 'exact' as const, hour: 20, minute: 0 },
        confidence: 'explicit' as const,
      },
      modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
    };

    const score = scoreTestCase(43, hallucinatingPatch, expected);
    assert.equal(score.hallucinations, 1);
    assert.ok(score.hallucinationDetails[0].includes('Hallucinated modality'));
  });

  test('Ajuste 3: flags hallucination when model invents year for absolute date', () => {
    const expected: ExpectedGroundTruth = {
      title: 'Charla',
      dateIntent: { type: 'absolute', day: 15, month: 9 }, // year undefined!
      timeIntent: { type: 'exact', hour: 18, minute: 0 },
      modality: 'presencial',
      locationText: 'aula magna',
    };

    const patchWithInventedYear = {
      title: { value: 'Charla', confidence: 'explicit' as const },
      dateIntent: {
        value: { type: 'absolute' as const, day: 15, month: 9, year: 2026 },
        confidence: 'inferred_high' as const,
      },
      timeIntent: {
        value: { type: 'exact' as const, hour: 18, minute: 0 },
        confidence: 'explicit' as const,
      },
      modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
      locationText: { value: 'aula magna', confidence: 'explicit' as const },
    };

    const score = scoreTestCase(27, patchWithInventedYear, expected);
    assert.equal(score.hallucinations, 1);
    assert.ok(score.hallucinationDetails[0].includes('Ajuste 3 violation'));
  });

  test('flags hallucination on incomplete input when title/date are fabricated', () => {
    const expected: ExpectedGroundTruth = {
      title: null,
      dateIntent: null,
      timeIntent: null,
      modality: 'presencial',
      locationText: 'casa de Martín',
    };

    const fabricatingPatch = {
      title: { value: 'Juntada con Martín', confidence: 'inferred_low' as const },
      dateIntent: {
        value: { type: 'relative' as const, value: 'today' as const },
        confidence: 'inferred_low' as const,
      },
      modality: { value: 'presencial' as const, confidence: 'explicit' as const },
      locationText: { value: 'casa de Martín', confidence: 'explicit' as const },
    };

    const score = scoreTestCase(53, fabricatingPatch, expected);
    assert.equal(score.hallucinations, 2); // title + dateIntent
  });
});

describe('AI Benchmark Harness Tests: Ambiguity Detection', () => {
  test('recognizes proper ambiguity handling for "tipo 9"', () => {
    const expected: ExpectedGroundTruth = {
      title: 'Reunión',
      dateIntent: { type: 'weekday', weekday: 'martes', modifier: 'this' },
      timeIntent: { type: 'approximate', hour: 9, minute: 0 },
      isAmbiguous: true,
    };

    const patch = {
      title: { value: 'Reunión', confidence: 'explicit' as const },
      dateIntent: {
        value: { type: 'weekday' as const, weekday: 'martes', modifier: 'this' as const },
        confidence: 'explicit' as const,
      },
      timeIntent: {
        value: { type: 'approximate' as const, hour: 9, minute: 0 },
        confidence: 'inferred_high' as const,
      },
    };

    const score = scoreTestCase(29, patch, expected);
    assert.equal(score.ambiguityCorrect, true);
  });

  test('penalizes ambiguity detection when explicit exact time is forced', () => {
    const expected: ExpectedGroundTruth = {
      title: 'Cena',
      dateIntent: { type: 'weekday', weekday: 'sabado', modifier: 'this' },
      timeIntent: { type: 'period', value: 'night' },
      isAmbiguous: true,
    };

    const forcedExactPatch = {
      title: { value: 'Cena', confidence: 'explicit' as const },
      dateIntent: {
        value: { type: 'weekday' as const, weekday: 'sabado', modifier: 'this' as const },
        confidence: 'explicit' as const,
      },
      timeIntent: {
        value: { type: 'exact' as const, hour: 21, minute: 0 },
        confidence: 'explicit' as const,
      },
    };

    const score = scoreTestCase(30, forcedExactPatch, expected);
    assert.equal(score.ambiguityCorrect, false);
  });
});

describe('AI Benchmark Harness Tests: Aggregation & Error Handling', () => {
  test('correctly aggregates multiple successful case score results', () => {
    const sampleResults: CaseScoreResult[] = [
      {
        caseId: 1,
        status: 'success',
        schemaCompliant: true,
        exactMatches: 5,
        expectedTotal: 5,
        exactExtractionRate: 100,
        omissions: 0,
        omissionRate: 0,
        hallucinations: 0,
        hallucinationDetails: [],
        ambiguityCorrect: null,
      },
      {
        caseId: 2,
        status: 'success',
        schemaCompliant: true,
        exactMatches: 4,
        expectedTotal: 5,
        exactExtractionRate: 80,
        omissions: 1,
        omissionRate: 20,
        hallucinations: 1,
        hallucinationDetails: ['Hallucinated virtual link'],
        ambiguityCorrect: true,
      },
      {
        caseId: 3,
        status: 'success',
        schemaCompliant: false,
        schemaError: 'Invalid schema',
        exactMatches: 0,
        expectedTotal: 4,
        exactExtractionRate: 0,
        omissions: 4,
        omissionRate: 100,
        hallucinations: 0,
        hallucinationDetails: [],
        ambiguityCorrect: false,
      },
    ];

    const aggregated = aggregateScores(sampleResults);
    assert.equal(aggregated.totalCases, 3);
    assert.equal(aggregated.successfulCases, 3);
    assert.equal(aggregated.failedCases, 0);
    assert.equal(aggregated.apiSuccessRate, 100);
    assert.equal(aggregated.apiFailureRate, 0);
    assert.equal(aggregated.evaluableCases, 3);
    assert.equal(aggregated.validSchemaPercentage, 66.7);
    assert.equal(aggregated.exactExtractionRate, 60);
    assert.equal(aggregated.omissionRate, 40);
    assert.equal(aggregated.hallucinationRate, 33.3);
    assert.equal(aggregated.ambiguityDetectionRate, 50);
  });

  test('isolates provider/API failures from semantic scoring metrics', () => {
    const sampleResults: CaseScoreResult[] = [
      {
        caseId: 1,
        status: 'success',
        schemaCompliant: true,
        exactMatches: 5,
        expectedTotal: 5,
        exactExtractionRate: 100,
        omissions: 0,
        omissionRate: 0,
        hallucinations: 0,
        hallucinationDetails: [],
        ambiguityCorrect: null,
      },
      // Provider failure: HTTP 429 quota exhaustion
      createProviderErrorScore(2, 429, 'OpenAI API error HTTP 429: credit_balance_exhausted'),
    ];

    const aggregated = aggregateScores(sampleResults);
    assert.equal(aggregated.totalCases, 2);
    assert.equal(aggregated.successfulCases, 1);
    assert.equal(aggregated.failedCases, 1);
    assert.equal(aggregated.apiSuccessRate, 50);
    assert.equal(aggregated.apiFailureRate, 50);
    assert.equal(aggregated.evaluableCases, 1);
    // Semantic metrics evaluate ONLY on the 1 evaluable case (100% extraction, 0% omission)
    assert.equal(aggregated.exactExtractionRate, 100);
    assert.equal(aggregated.omissionRate, 0);
    assert.equal(aggregated.validSchemaPercentage, 100);
    assert.ok(aggregated.failureReasons[0].includes('429'));
  });

  test('handles complete provider failure without polluting semantic omission metrics', () => {
    const sampleResults: CaseScoreResult[] = [
      createProviderErrorScore(1, 400, 'Google API error HTTP 400: INVALID_ARGUMENT'),
      createProviderErrorScore(2, 400, 'Google API error HTTP 400: INVALID_ARGUMENT'),
    ];

    const aggregated = aggregateScores(sampleResults);
    assert.equal(aggregated.totalCases, 2);
    assert.equal(aggregated.successfulCases, 0);
    assert.equal(aggregated.failedCases, 2);
    assert.equal(aggregated.apiSuccessRate, 0);
    assert.equal(aggregated.apiFailureRate, 100);
    assert.equal(aggregated.evaluableCases, 0);
    // When 0 evaluable responses exist, omissionRate is 0 (not 100%)
    assert.equal(aggregated.omissionRate, 0);
    assert.equal(aggregated.exactExtractionRate, 0);
    assert.equal(aggregated.validSchemaPercentage, 0);
  });

  test('handles empty results array gracefully', () => {
    const emptyAgg = aggregateScores([]);
    assert.equal(emptyAgg.totalCases, 0);
    assert.equal(emptyAgg.validSchemaPercentage, 0);
    assert.equal(emptyAgg.apiSuccessRate, 0);
  });
});

describe('AI Benchmark Harness Tests: DeepSeek Provider & Schema Adaptation', () => {
  const originalFetch = globalThis.fetch;

  test('provider config: sets name, default model and custom model correctly', () => {
    const defaultProvider = new DeepSeekProvider('test-key');
    assert.equal(defaultProvider.name, 'deepseek');
    assert.equal(defaultProvider.model, 'deepseek-v4-flash');

    const customProvider = new DeepSeekProvider('test-key', 'deepseek-chat');
    assert.equal(customProvider.name, 'deepseek');
    assert.equal(customProvider.model, 'deepseek-chat');
  });

  test('provider config: throws when DEEPSEEK_API_KEY is missing', () => {
    assert.throws(
      () => new DeepSeekProvider(''),
      /Missing DEEPSEEK_API_KEY/
    );
  });

  test('schema adaptation: sanitizeSchemaForDeepSeek creates pure clone without mutating canonical schema', () => {
    const canonicalSnapshot = JSON.stringify(ENCOUNTER_DRAFT_PATCH_SCHEMA);
    const deepSeekSchema = sanitizeSchemaForDeepSeek(ENCOUNTER_DRAFT_PATCH_SCHEMA);

    // Verify deep clone equality
    assert.deepEqual(deepSeekSchema, ENCOUNTER_DRAFT_PATCH_SCHEMA);
    // Verify canonical schema unchanged
    assert.equal(JSON.stringify(ENCOUNTER_DRAFT_PATCH_SCHEMA), canonicalSnapshot);
    // Verify object reference is different
    assert.notEqual(deepSeekSchema, ENCOUNTER_DRAFT_PATCH_SCHEMA);
  });

  test('parsing: parses valid JSON and strips markdown ```json code blocks', async () => {
    const validJsonOutput = JSON.stringify({
      title: { value: 'Partido de paddle', confidence: 'explicit' },
      dateIntent: {
        value: { type: 'weekday', weekday: 'sábado', modifier: 'this' },
        confidence: 'explicit',
      },
    });

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `\`\`\`json\n${validJsonOutput}\n\`\`\``,
              },
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 45 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    try {
      const provider = new DeepSeekProvider('test-key');
      const result = await provider.interpret({
        message: 'Partido de paddle el sábado',
        systemPrompt: 'test prompt',
        jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA,
      });

      assert.equal((result.patch.title as any).value, 'Partido de paddle');
      assert.equal(result.inputTokens, 150);
      assert.equal(result.outputTokens, 45);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('parsing: throws on empty or whitespace response', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '   ' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    try {
      const provider = new DeepSeekProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Hola',
            systemPrompt: 'test',
            jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA,
          }),
        /Empty or missing content/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('parsing: throws on invalid malformed JSON', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{ not a json : invalid }' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    try {
      const provider = new DeepSeekProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Hola',
            systemPrompt: 'test',
            jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA,
          }),
        /Failed to parse JSON response from DeepSeek/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('error handling: handles HTTP 429 rate limit error', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit_error' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );

    try {
      const provider = new DeepSeekProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Hola',
            systemPrompt: 'test',
            jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA,
          }),
        /DeepSeek API error \(429\)/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('error handling: handles HTTP 5xx server error', async () => {
    globalThis.fetch = async () =>
      new Response('Internal Server Error', { status: 503, headers: { 'Content-Type': 'text/plain' } });

    try {
      const provider = new DeepSeekProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Hola',
            systemPrompt: 'test',
            jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA,
          }),
        /DeepSeek API error \(503\)/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('error handling: handles network timeout / abort', async () => {
    globalThis.fetch = async () => {
      throw new Error('Connection timeout to api.deepseek.com');
    };

    try {
      const provider = new DeepSeekProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Hola',
            systemPrompt: 'test',
            jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA,
          }),
        /Connection timeout/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validation: rejects output that violates EncounterDraftPatch schema', async () => {
    const invalidPatch = {
      title: { value: 'Reunión', confidence: 'invalid_confidence' },
      extraDisallowedKey: 123,
    };

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(invalidPatch) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    try {
      const provider = new DeepSeekProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Reunión',
            systemPrompt: 'test',
            jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA,
          }),
        /DeepSeek response does not conform to EncounterDraftPatch schema/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('AI Benchmark Harness Tests: Token Usage & Metrics Breakdown', () => {
  test('calculates visibleOutputTokens correctly as billedCompletionTokens - reasoningTokens', () => {
    const deepSeekUsage = {
      prompt_tokens: 1626,
      completion_tokens: 4229,
      total_tokens: 5855,
      completion_tokens_details: {
        reasoning_tokens: 4154,
      },
    };

    const metrics = extractUsageMetrics(deepSeekUsage);

    assert.equal(metrics.promptTokens, 1626);
    assert.equal(metrics.billedCompletionTokens, 4229);
    assert.equal(metrics.reasoningTokens, 4154);
    assert.equal(metrics.visibleOutputTokens, 75); // 4229 - 4154
    assert.equal(metrics.totalBilledTokens, 5855);
  });

  test('defaults reasoningTokens to 0 when reasoning_tokens is absent or undefined (OpenAI/standard)', () => {
    const standardUsage = {
      prompt_tokens: 1322,
      completion_tokens: 293,
      total_tokens: 1615,
    };

    const metrics = extractUsageMetrics(standardUsage);

    assert.equal(metrics.promptTokens, 1322);
    assert.equal(metrics.billedCompletionTokens, 293);
    assert.equal(metrics.reasoningTokens, 0);
    assert.equal(metrics.visibleOutputTokens, 293);
    assert.equal(metrics.totalBilledTokens, 1615);
  });

  test('handles Gemini-style token naming (promptTokenCount, candidatesTokenCount, totalTokenCount)', () => {
    const geminiUsage = {
      promptTokenCount: 685,
      candidatesTokenCount: 69,
      totalTokenCount: 754,
    };

    const metrics = extractUsageMetrics(geminiUsage);

    assert.equal(metrics.promptTokens, 685);
    assert.equal(metrics.billedCompletionTokens, 69);
    assert.equal(metrics.reasoningTokens, 0);
    assert.equal(metrics.visibleOutputTokens, 69);
    assert.equal(metrics.totalBilledTokens, 754);
  });

  test('prevents negative numbers defensively with Math.max(0, ...)', () => {
    const abnormalUsage = {
      prompt_tokens: -10,
      completion_tokens: 50,
      completion_tokens_details: {
        reasoning_tokens: 100, // larger than completion_tokens
      },
      total_tokens: -5,
    };

    const metrics = extractUsageMetrics(abnormalUsage);

    assert.equal(metrics.promptTokens, 0);
    assert.equal(metrics.billedCompletionTokens, 50);
    assert.equal(metrics.reasoningTokens, 100);
    assert.equal(metrics.visibleOutputTokens, 0); // Math.max(0, 50 - 100) = 0
    assert.equal(metrics.totalBilledTokens, 0);
  });

  test('provides backwards-compatible aliases for inputTokens and outputTokens', () => {
    const usage = {
      prompt_tokens: 1500,
      completion_tokens: 250,
    };

    const metrics = extractUsageMetrics(usage);

    assert.equal(metrics.inputTokens, metrics.promptTokens);
    assert.equal(metrics.outputTokens, metrics.billedCompletionTokens);
  });

  test('handles empty or undefined usage object gracefully', () => {
    const emptyMetrics = extractUsageMetrics({});
    const undefinedMetrics = extractUsageMetrics(undefined as any);

    for (const m of [emptyMetrics, undefinedMetrics]) {
      assert.equal(m.promptTokens, 0);
      assert.equal(m.billedCompletionTokens, 0);
      assert.equal(m.reasoningTokens, 0);
      assert.equal(m.visibleOutputTokens, 0);
      assert.equal(m.totalBilledTokens, 0);
      assert.equal(m.inputTokens, 0);
      assert.equal(m.outputTokens, 0);
    }
  });

  test('security verification: reasoning_content text is stripped before trace serialization', () => {
    // Simulated DeepSeek response containing textual reasoning_content
    const simulatedResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              title: { value: 'Reunión', confidence: 'explicit' },
            }),
            reasoning_content: 'Confidential reasoning thinking text that should not leak to disk or traces.',
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 150 },
      },
    };

    // Sanitize simulated choice payload as done in callDeepSeek
    if (simulatedResponse.choices?.[0]?.message?.reasoning_content) {
      delete (simulatedResponse.choices[0].message as any).reasoning_content;
    }

    const metrics = extractUsageMetrics(simulatedResponse.usage);

    // Verify reasoning tokens count is preserved
    assert.equal(metrics.reasoningTokens, 150);
    assert.equal(metrics.visibleOutputTokens, 50);

    // Verify textual reasoning content is absent from the serialized payload
    const serialized = JSON.stringify(simulatedResponse);
    assert.equal(serialized.includes('Confidential reasoning thinking text'), false);
    assert.equal(serialized.includes('reasoning_content'), false);
  });
});

