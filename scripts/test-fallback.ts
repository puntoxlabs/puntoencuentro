import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import type {
  EncounterInterpreterProvider,
  ProviderInterpretationResult,
} from '../supabase/functions/ai-interpret/providers/base.ts';
import {
  ProviderError,
  classifyProviderError,
} from '../supabase/functions/ai-interpret/providers/base.ts';
import {
  interpretWithFallback,
  resolveProviders,
  createProvider,
  callWithTimeout,
} from '../supabase/functions/ai-interpret/fallback.ts';
import { ENCOUNTER_DRAFT_PATCH_SCHEMA } from '../supabase/functions/ai-interpret/validation.ts';
import { mergeDraftPatch } from '../src/lib/draftMerger.ts';
import { createEmptyEncounterDraft } from '../src/lib/encounterDraft.ts';
import { createDefaultInvitationConfig } from '../src/lib/encounterDraft.ts';

// Helper mock provider
class MockProvider implements EncounterInterpreterProvider {
  name: string;
  model: string;
  callCount = 0;
  lastMessageReceived?: string;
  lastDraftReceived?: Record<string, unknown>;
  private behavior: (params: any) => Promise<ProviderInterpretationResult>;

  constructor(
    name: string,
    model: string,
    behavior: (params: any) => Promise<ProviderInterpretationResult>
  ) {
    this.name = name;
    this.model = model;
    this.behavior = behavior;
  }

  async interpret(params: any): Promise<ProviderInterpretationResult> {
    this.callCount++;
    this.lastMessageReceived = params.message;
    this.lastDraftReceived = params.currentDraft;
    return this.behavior(params);
  }
}

const dummyPrompt = 'system prompt';
const dummySchema = ENCOUNTER_DRAFT_PATCH_SCHEMA;

// =============================================================================
// SUITE 1: ERROR TAXONOMY & CLASSIFICATION TESTS
// =============================================================================
describe('Runtime Fallback Multi-Provider: Error Taxonomy & Classification', () => {
  test('passes existing ProviderError instances through untouched', () => {
    const original = new ProviderError({
      message: 'Custom safety error',
      type: 'safety_refusal',
      provider: 'openai',
      httpStatus: 400,
    });
    const classified = classifyProviderError(original, 'openai');
    assert.equal(classified, original);
    assert.equal(classified.type, 'safety_refusal');
    assert.equal(classified.retryable, false);
  });

  test('classifies timeout and abort as retryable_technical', () => {
    const err1 = classifyProviderError(new Error('Timeout after 10000ms'), 'openai');
    assert.equal(err1.type, 'retryable_technical');
    assert.equal(err1.retryable, true);

    const err2 = classifyProviderError(new Error('The user aborted a request.'), 'openai');
    assert.equal(err2.type, 'retryable_technical');
    assert.equal(err2.retryable, true);
  });

  test('classifies network failures as retryable_technical', () => {
    const err1 = classifyProviderError(new TypeError('fetch failed'), 'openai');
    assert.equal(err1.type, 'retryable_technical');
    assert.equal(err1.retryable, true);

    const err2 = classifyProviderError(new Error('connect ECONNREFUSED 127.0.0.1:443'), 'deepseek');
    assert.equal(err2.type, 'retryable_technical');
    assert.equal(err2.retryable, true);
  });

  test('classifies HTTP 429 rate limit as retryable_technical', () => {
    const err = classifyProviderError(new Error('OpenAI API error (429): Rate limit exceeded'), 'openai');
    assert.equal(err.type, 'retryable_technical');
    assert.equal(err.retryable, true);
    assert.equal(err.httpStatus, 429);
  });

  test('classifies HTTP 5xx server errors as retryable_technical', () => {
    const err1 = classifyProviderError(new Error('OpenAI API error (500): Internal Server Error'), 'openai');
    assert.equal(err1.type, 'retryable_technical');
    assert.equal(err1.retryable, true);

    const err2 = classifyProviderError(new Error('DeepSeek API error (503): Service Unavailable'), 'deepseek');
    assert.equal(err2.type, 'retryable_technical');
    assert.equal(err2.retryable, true);
  });

  test('classifies content policy, safety, and moderation as safety_refusal', () => {
    const err1 = classifyProviderError(new Error('content_policy_violation: Prompt violated policies'), 'openai');
    assert.equal(err1.type, 'safety_refusal');
    assert.equal(err1.retryable, false);

    const err2 = classifyProviderError(new Error('Candidate was blocked due to safety guidelines'), 'google');
    assert.equal(err2.type, 'safety_refusal');
    assert.equal(err2.retryable, false);

    const err3 = classifyProviderError(new Error('OpenAI refusal: I cannot generate this'), 'openai');
    assert.equal(err3.type, 'safety_refusal');
    assert.equal(err3.retryable, false);
  });

  test('classifies HTTP 401, 403, and invalid keys as auth_config', () => {
    const err1 = classifyProviderError(new Error('OpenAI API error (401): Unauthorized'), 'openai');
    assert.equal(err1.type, 'auth_config');
    assert.equal(err1.retryable, false);

    const err2 = classifyProviderError(new Error('DeepSeek API error (403): Forbidden / country not supported'), 'deepseek');
    assert.equal(err2.type, 'auth_config');
    assert.equal(err2.retryable, false);

    const err3 = classifyProviderError(new Error('Missing DEEPSEEK_API_KEY in environment'), 'deepseek');
    assert.equal(err3.type, 'auth_config');
    assert.equal(err3.retryable, false);
  });

  test('classifies HTTP 400 non-policy bad request as non_retryable', () => {
    const err = classifyProviderError(new Error('OpenAI API error (400): Invalid request format'), 'openai');
    assert.equal(err.type, 'non_retryable');
    assert.equal(err.retryable, false);
  });
});

// =============================================================================
// SUITE 2: MANDATORY SAFETY & SECURITY TESTS (A TO I)
// =============================================================================
describe('Runtime Fallback Multi-Provider: Mandatory Safety & Security Tests', () => {
  // A. Primary safety refusal -> OpenAI returns refusal/policy block -> DeepSeek is NOT called
  test('A. Primary safety refusal: OpenAI content policy refusal NEVER calls DeepSeek fallback', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI safety refusal (400): content_policy_violation',
        type: 'safety_refusal',
        provider: 'openai',
        httpStatus: 400,
        code: 'content_policy_violation',
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('SECURITY VIOLATION: DeepSeek must NEVER be called after safety refusal!');
    });

    const res = await interpretWithFallback('Violating prompt', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.error, 'safety_refusal');
    assert.equal(res.primaryFailureType, 'safety_refusal');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 0);
    // User-facing message must be controlled without leaking internal details
    assert.ok(res.message?.includes('políticas de contenido'));
  });

  // B. Primary HTTP 401 -> DeepSeek is NOT called
  test('B. Primary HTTP 401: authentication error NEVER calls fallback', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI API error (401): Unauthorized',
        type: 'auth_config',
        provider: 'openai',
        httpStatus: 401,
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('Fallback must not be called on auth_config error');
    });

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.primaryFailureType, 'auth_config');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 0);
  });

  // C. Primary HTTP 403 -> DeepSeek is NOT called
  test('C. Primary HTTP 403: forbidden/country block NEVER calls fallback', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI API error (403): Region not supported',
        type: 'auth_config',
        provider: 'openai',
        httpStatus: 403,
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('Fallback must not be called on 403 forbidden');
    });

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.primaryFailureType, 'auth_config');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 0);
  });

  // D. Primary HTTP 400 non-retryable -> DeepSeek is NOT called
  test('D. Primary HTTP 400 non-retryable request error: does NOT call fallback', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI request error (400): Unknown parameter passed in payload',
        type: 'non_retryable',
        provider: 'openai',
        httpStatus: 400,
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('Fallback must not be called on non-retryable request error');
    });

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.primaryFailureType, 'non_retryable');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 0);
  });

  // E. Primary HTTP 429 -> DeepSeek IS called
  test('E. Primary HTTP 429 rate limit: automatically calls fallback provider', async () => {
    const validPatch = { title: { value: 'Asado', confidence: 'explicit' } };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI API error (429): Rate limit exceeded / credit exhausted',
        type: 'retryable_technical',
        provider: 'openai',
        httpStatus: 429,
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => ({
      patch: validPatch,
      inputTokens: 100,
      outputTokens: 40,
    }));

    const res = await interpretWithFallback('Asado', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.providerUsed, 'deepseek');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 1);
  });

  // F. Primary 500/502/503/504 -> DeepSeek IS called
  test('F. Primary HTTP 500/502/503/504 server error: automatically calls fallback provider', async () => {
    const validPatch = { title: { value: 'Almuerzo', confidence: 'explicit' } };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI API error (503): Service Unavailable',
        type: 'retryable_technical',
        provider: 'openai',
        httpStatus: 503,
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => ({
      patch: validPatch,
      inputTokens: 90,
      outputTokens: 35,
    }));

    const res = await interpretWithFallback('Almuerzo', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.providerUsed, 'deepseek');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 1);
  });

  // G. Primary timeout/network -> DeepSeek IS called
  test('G. Primary timeout/network error: automatically calls fallback provider', async () => {
    const validPatch = { title: { value: 'Partido de paddle', confidence: 'explicit' } };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async ({ signal }) => {
      await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Timeout after 30ms')));
      });
      return { patch: {}, inputTokens: 0, outputTokens: 0 };
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => ({
      patch: validPatch,
      inputTokens: 110,
      outputTokens: 45,
    }));

    const res = await interpretWithFallback('Paddle', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
      primaryTimeoutMs: 30,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.providerUsed, 'deepseek');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 1);
  });

  // H. Primary invalid JSON / invalid patch -> DeepSeek IS called
  test('H. Primary invalid JSON / invalid schema: automatically calls fallback provider', async () => {
    const validPatch = { title: { value: 'Café', confidence: 'explicit' } };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI response does not conform to EncounterDraftPatch schema: missing confidence',
        type: 'retryable_technical',
        provider: 'openai',
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => ({
      patch: validPatch,
      inputTokens: 85,
      outputTokens: 30,
    }));

    const res = await interpretWithFallback('Café', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.providerUsed, 'deepseek');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 1);
  });

  // I. Safety refusal con HTTP 200 (structured refusal) -> DeepSeek is NOT called
  test('I. Safety refusal with HTTP 200: structured refusal field NEVER calls DeepSeek fallback', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: "OpenAI refusal: I'm sorry, I cannot generate sexually explicit or violent content.",
        type: 'safety_refusal',
        provider: 'openai',
        httpStatus: 200,
        code: 'refusal',
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('SECURITY VIOLATION: Fallback must not execute on structured refusal');
    });

    const res = await interpretWithFallback('Bad prompt', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.error, 'safety_refusal');
    assert.equal(res.primaryFailureType, 'safety_refusal');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 0);
  });
});

// =============================================================================
// SUITE 3: CORE ORCHESTRATION & FUNCTIONAL TESTS
// =============================================================================
describe('Runtime Fallback Multi-Provider: Core Orchestration Tests', () => {
  test('Primary success returns primary result immediately without touching fallback', async () => {
    const validPatch = {
      title: { value: 'Cena con amigos', confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'explicit' },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: validPatch,
      inputTokens: 100,
      outputTokens: 50,
    }));

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('Should never be called');
    });

    const res = await interpretWithFallback('Cena con amigos', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.providerUsed, 'openai');
    assert.equal(res.modelUsed, 'gpt-5.6-luna');
    assert.deepEqual(res.patch, validPatch);
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 0);
  });

  test('Primary valid but incomplete patch does NOT activate fallback', async () => {
    const incompletePatch = {
      title: { value: 'Organizamos algo', confidence: 'explicit' },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: incompletePatch,
      inputTokens: 100,
      outputTokens: 25,
    }));

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('Fallback must NEVER be called on valid incomplete patch');
    });

    const res = await interpretWithFallback('Organizamos algo', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.providerUsed, 'openai');
    assert.deepEqual(res.patch, incompletePatch);
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 0);
  });

  test('Primary functional ambiguity does NOT activate fallback', async () => {
    const ambiguousPatch = {
      title: { value: 'Nos vemos tipo 9', confidence: 'explicit' },
      timeIntent: {
        value: { type: 'approximate', hour: 21, minute: 0 },
        confidence: 'ambiguous',
        clarificationQuestion: '¿A las 9 de la mañana o a las 21 hs?',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: ambiguousPatch,
      inputTokens: 120,
      outputTokens: 60,
    }));

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('Fallback must NEVER be called on functional ambiguity');
    });

    const res = await interpretWithFallback('Nos vemos tipo 9', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.providerUsed, 'openai');
    assert.deepEqual(res.patch, ambiguousPatch);
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 0);
  });

  test('Primary failure + fallback failure returns controlled double failure without crash', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new Error('OpenAI timeout');
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('DeepSeek 503 Server Error');
    });

    const res = await interpretWithFallback('Hola', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.primaryProvider, 'openai');
    assert.equal(res.fallbackProvider, 'deepseek');
    assert.ok(res.primaryError?.includes('timeout'));
    assert.ok(res.fallbackError?.includes('503'));
    assert.equal(res.error, 'interpretation_failed');
    assert.equal(res.message, 'No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.');
  });

  test('Maximum one fallback: stops after fallback failure and never calls third provider', async () => {
    let tertiaryCalled = false;
    const tertiary = new MockProvider('google', 'gemini-3.8-flash', async () => {
      tertiaryCalled = true;
      return { patch: {}, inputTokens: 0, outputTokens: 0 };
    });

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new Error('Primary 500');
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('Fallback 500');
    });

    const res = await interpretWithFallback('Test', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 1);
    assert.equal(tertiaryCalled, false);
    assert.equal(tertiary.callCount, 0);
  });

  test('Draft/input preservation: double failure preserves accumulated draft and user text', async () => {
    const existingDraft = {
      title: 'Cumpleaños de Sofi',
      date: '2026-09-15',
      time: '20:00',
      modality: 'presencial' as const,
      locationText: 'Palermo',
    };

    const userInput = 'Cambiemos la hora a las 21 hs por favor';

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new Error('Primary network error');
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new Error('Fallback network error');
    });

    const res = await interpretWithFallback(userInput, existingDraft, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);

    // Verify existing draft is intact and unchanged
    const emptyConfig = createDefaultInvitationConfig();
    const merged = mergeDraftPatch(existingDraft, emptyConfig, (res.patch as any) || {});

    assert.equal(merged.draft.title, 'Cumpleaños de Sofi');
    assert.equal(merged.draft.date, '2026-09-15');
    assert.equal(merged.draft.time, '20:00');
    assert.equal(merged.draft.locationText, 'Palermo');

    // Verify user input was received by both providers
    assert.equal(primary.lastMessageReceived, userInput);
    assert.equal(fallback.lastMessageReceived, userInput);
  });

  test('Provider resolution: resolveProviders configures primary, fallback, and timeouts from env', () => {
    const mockEnv = {
      get: (key: string) => {
        const envMap: Record<string, string> = {
          PRIMARY_AI_PROVIDER: 'openai',
          FALLBACK_AI_PROVIDER: 'deepseek',
          OPENAI_MODEL: 'gpt-5.6-luna',
          DEEPSEEK_MODEL: 'deepseek-v4-flash',
          OPENAI_API_KEY: 'test-openai-key',
          DEEPSEEK_API_KEY: 'test-deepseek-key',
          AI_PRIMARY_TIMEOUT_MS: '9000',
          AI_FALLBACK_TIMEOUT_MS: '7000',
        };
        return envMap[key];
      },
    };

    const { primaryProvider, fallbackProvider, primaryTimeoutMs, fallbackTimeoutMs } =
      resolveProviders(mockEnv);

    assert.equal(primaryProvider.name, 'openai');
    assert.equal(primaryProvider.model, 'gpt-5.6-luna');
    assert.equal(fallbackProvider?.name, 'deepseek');
    assert.equal(fallbackProvider?.model, 'deepseek-v4-flash');
    assert.equal(primaryTimeoutMs, 9000);
    assert.equal(fallbackTimeoutMs, 7000);
  });

  test('Provider resolution: handles fallback disabled via "none"', () => {
    const mockEnv = {
      get: (key: string) => {
        const envMap: Record<string, string> = {
          PRIMARY_AI_PROVIDER: 'openai',
          FALLBACK_AI_PROVIDER: 'none',
          OPENAI_API_KEY: 'test-openai-key',
        };
        return envMap[key];
      },
    };

    const { primaryProvider, fallbackProvider } = resolveProviders(mockEnv);

    assert.equal(primaryProvider.name, 'openai');
    assert.equal(fallbackProvider, null);
  });
});

// =============================================================================
// SUITE 4: OBSERVABILITY & TELEMETRY TESTS
// =============================================================================
describe('Runtime Fallback Multi-Provider: Observability & Telemetry Tests', () => {
  test('Primary success persists fallbackUsed=false and latency metrics', async () => {
    const validPatch = { title: { value: 'Reunión', confidence: 'explicit' } };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: validPatch,
      inputTokens: 50,
      outputTokens: 20,
    }));

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => ({
      patch: {},
      inputTokens: 0,
      outputTokens: 0,
    }));

    const res = await interpretWithFallback('Reunión', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.primaryProvider, 'openai');
    assert.equal(res.providerUsed, 'openai');
    assert.ok(typeof res.primaryLatencyMs === 'number');
    assert.equal(res.fallbackLatencyMs, undefined);
    assert.ok(res.totalLatencyMs >= res.primaryLatencyMs);
  });

  test('Primary failure + fallback success records fallbackUsed=true and failure type', async () => {
    const validPatch = { title: { value: 'Cena', confidence: 'explicit' } };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI API error (429): Rate limit',
        type: 'retryable_technical',
        provider: 'openai',
        httpStatus: 429,
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => ({
      patch: validPatch,
      inputTokens: 60,
      outputTokens: 25,
    }));

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.primaryProvider, 'openai');
    assert.equal(res.fallbackProvider, 'deepseek');
    assert.equal(res.providerUsed, 'deepseek');
    assert.equal(res.primaryFailureType, 'retryable_technical');
    assert.ok(typeof res.primaryLatencyMs === 'number');
    assert.ok(typeof res.fallbackLatencyMs === 'number');
    assert.ok(res.totalLatencyMs >= (res.fallbackLatencyMs || 0));
  });

  test('Double failure records failure types for both providers', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI API error (503): Service Unavailable',
        type: 'retryable_technical',
        provider: 'openai',
        httpStatus: 503,
      });
    });

    const fallback = new MockProvider('deepseek', 'deepseek-v4-flash', async () => {
      throw new ProviderError({
        message: 'DeepSeek API error (500): Internal Error',
        type: 'retryable_technical',
        provider: 'deepseek',
        httpStatus: 500,
      });
    });

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.primaryFailureType, 'retryable_technical');
    assert.equal(res.fallbackFailureType, 'retryable_technical');
    assert.ok(res.primaryError?.includes('503'));
    assert.ok(res.fallbackError?.includes('500'));
  });

  test('Security & Secret Hygiene: telemetry output contains no API keys or tokens', async () => {
    const secretKey = 'sk-secret-openai-api-key-xyz123';
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      return {
        patch: { title: { value: 'Fiesta', confidence: 'explicit' } },
        inputTokens: 40,
        outputTokens: 20,
      };
    });

    const res = await interpretWithFallback('Fiesta', undefined, primary, null, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    const serialized = JSON.stringify(res);
    assert.ok(!serialized.includes(secretKey));
    assert.ok(!serialized.includes('Bearer'));
    assert.ok(!serialized.includes('reasoning_content'));
  });

  test('Fallback disabled via "none": fails gracefully without triggering fallback', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new Error('Connection failed');
    });

    const res = await interpretWithFallback('Test', undefined, primary, null, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.primaryProvider, 'openai');
    assert.equal(res.fallbackProvider, undefined);
    assert.equal(res.error, 'interpretation_failed');
  });
});
