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
import http from 'node:http';
import type * as net from 'node:net';
import {
  ENCOUNTER_DRAFT_PATCH_SCHEMA,
  cleanNullProperties,
  isSentinelValue,
  validatePatchOutput,
  hasDateEvidence,
  hasTimeEvidence,
  sanitizeTemporalIntents,
} from '../supabase/functions/ai-interpret/validation.ts';
import { MistralProvider } from '../supabase/functions/ai-interpret/providers/mistral.ts';
import { mergeDraftPatch } from '../src/lib/draftMerger.ts';
import { createEmptyEncounterDraft } from '../src/lib/encounterDraft.ts';
import { createDefaultInvitationConfig } from '../src/lib/encounterDraft.ts';
import { addDaysToIsoDate } from '../src/lib/dateResolver.ts';
import { getArgentinaTodayISO } from '../src/lib/argentinaDateTime.ts';

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

  test('Provider resolution: defaults to mistral as fallback with ministral-8b-2512 and timeouts (10000ms / 8000ms)', () => {
    const mockEnv = {
      get: (key: string) => {
        const envMap: Record<string, string> = {
          OPENAI_API_KEY: 'test-openai-key',
          MISTRAL_API_KEY: 'test-mistral-key',
        };
        return envMap[key];
      },
    };

    const { primaryProvider, fallbackProvider, primaryTimeoutMs, fallbackTimeoutMs } =
      resolveProviders(mockEnv);

    assert.equal(primaryProvider.name, 'openai');
    assert.equal(primaryProvider.model, 'gpt-5.6-luna');
    assert.equal(fallbackProvider?.name, 'mistral');
    assert.equal(fallbackProvider?.model, 'ministral-8b-2512');
    assert.equal(primaryTimeoutMs, 10000);
    assert.equal(fallbackTimeoutMs, 8000);
  });

  test('createProvider: instantiates MistralProvider with custom model and checks missing key', () => {
    const mockEnvWithModel = {
      get: (key: string) => {
        if (key === 'MISTRAL_API_KEY') return 'test-key';
        if (key === 'MISTRAL_MODEL') return 'ministral-8b-custom';
        return undefined;
      },
    };
    const provider = createProvider('mistral', mockEnvWithModel);
    assert.equal(provider.name, 'mistral');
    assert.equal(provider.model, 'ministral-8b-custom');

    const mockEnvWithoutKey = {
      get: () => undefined,
    };
    assert.throws(
      () => createProvider('mistral', mockEnvWithoutKey),
      /Missing MISTRAL_API_KEY/
    );
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

  test('Observability: exposes primaryModel and fallbackModel in execution result', async () => {
    const validPatch = { title: { value: 'Asado', confidence: 'explicit' } };
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI 500',
        type: 'retryable_technical',
        provider: 'openai',
      });
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: validPatch,
      inputTokens: 80,
      outputTokens: 40,
    }));

    const res = await interpretWithFallback('Asado', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.primaryProvider, 'openai');
    assert.equal(res.primaryModel, 'gpt-5.6-luna');
    assert.equal(res.fallbackProvider, 'mistral');
    assert.equal(res.fallbackModel, 'ministral-8b-2512');
  });
});

// =============================================================================
// SUITE 5: MISTRAL PROVIDER ADAPTER & ERROR TAXONOMY
// =============================================================================
describe('Mistral Provider Adapter: Error Taxonomy & Serialization', () => {
  const originalFetch = globalThis.fetch;

  test('MistralProvider parses successful structured output and cleans nulls', async () => {
    const mockApiResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: { value: 'Cena de equipo', confidence: 'explicit' },
              description: null,
              modality: { value: 'presencial', confidence: 'inferred_high' },
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
      },
    };

    globalThis.fetch = async (url: any, opts: any) => {
      assert.ok(String(url).includes('api.mistral.ai'));
      const parsedBody = JSON.parse(opts.body);
      assert.equal(parsedBody.model, 'ministral-8b-2512');
      assert.equal(opts.headers.Authorization, 'Bearer test-mistral-key');
      return new Response(JSON.stringify(mockApiResponse), { status: 200 });
    };

    try {
      const provider = new MistralProvider('test-mistral-key', 'ministral-8b-2512');
      const result = await provider.interpret({
        message: 'Cena de equipo',
        systemPrompt: dummyPrompt,
        jsonSchema: dummySchema,
      });

      assert.equal((result.patch.title as any)?.value, 'Cena de equipo');
      assert.equal('description' in result.patch, false);
      assert.equal(result.inputTokens, 120);
      assert.equal(result.outputTokens, 45);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('MistralProvider maps 401 / 403 to auth_config', async () => {
    for (const status of [401, 403]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status });

      try {
        const provider = new MistralProvider('invalid-key');
        await assert.rejects(
          () =>
            provider.interpret({
              message: 'Hola',
              systemPrompt: dummyPrompt,
              jsonSchema: dummySchema,
            }),
          (err: any) => {
            assert.equal(err.type, 'auth_config');
            assert.equal(err.httpStatus, status);
            return true;
          }
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test('MistralProvider maps 429 to retryable_technical', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 429 });

    try {
      const provider = new MistralProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Hola',
            systemPrompt: dummyPrompt,
            jsonSchema: dummySchema,
          }),
        (err: any) => {
          assert.equal(err.type, 'retryable_technical');
          assert.equal(err.httpStatus, 429);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('MistralProvider maps 5xx to retryable_technical', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'Internal Server Error' } }), { status: 500 });

    try {
      const provider = new MistralProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Hola',
            systemPrompt: dummyPrompt,
            jsonSchema: dummySchema,
          }),
        (err: any) => {
          assert.equal(err.type, 'retryable_technical');
          assert.equal(err.httpStatus, 500);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('MistralProvider maps safety refusal to safety_refusal', async () => {
    // 1. Via HTTP 400 content policy
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'content_policy_violation' } }), { status: 400 });

    try {
      const provider = new MistralProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Violating message',
            systemPrompt: dummyPrompt,
            jsonSchema: dummySchema,
          }),
        (err: any) => {
          assert.equal(err.type, 'safety_refusal');
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 2. Via refusal field in message
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { refusal: 'Cannot generate harmful content' } }],
        }),
        { status: 200 }
      );

    try {
      const provider = new MistralProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Violating message',
            systemPrompt: dummyPrompt,
            jsonSchema: dummySchema,
          }),
        (err: any) => {
          assert.equal(err.type, 'safety_refusal');
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 3. Via content_filter finish_reason
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{}' }, finish_reason: 'content_filter' }],
        }),
        { status: 200 }
      );

    try {
      const provider = new MistralProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Violating message',
            systemPrompt: dummyPrompt,
            jsonSchema: dummySchema,
          }),
        (err: any) => {
          assert.equal(err.type, 'safety_refusal');
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('MistralProvider maps non-safety 400 to non_retryable', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid parameter foo' } }), { status: 400 });

    try {
      const provider = new MistralProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Hola',
            systemPrompt: dummyPrompt,
            jsonSchema: dummySchema,
          }),
        (err: any) => {
          assert.equal(err.type, 'non_retryable');
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('MistralProvider maps empty or invalid JSON to retryable_technical', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'not valid json' } }] }), {
        status: 200,
      });

    try {
      const provider = new MistralProvider('test-key');
      await assert.rejects(
        () =>
          provider.interpret({
            message: 'Hola',
            systemPrompt: dummyPrompt,
            jsonSchema: dummySchema,
          }),
        (err: any) => {
          assert.equal(err.type, 'retryable_technical');
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// =============================================================================
// SUITE 6: MISTRAL FALLBACK RUNTIME INTEGRATION MATRIX (SCENARIOS A TO L)
// =============================================================================
describe('Mistral Fallback Runtime Integration Matrix (Scenarios A to L)', () => {
  const validOpenAiPatch = {
    title: { value: 'Cena con amigos', confidence: 'explicit' },
    modality: { value: 'presencial', confidence: 'explicit' },
  };
  const validMistralPatch = {
    title: { value: 'Cena con amigos vía Mistral', confidence: 'explicit' },
    modality: { value: 'presencial', confidence: 'explicit' },
  };

  // A. Primary (OpenAI) responde OK -> Mistral NO es llamado
  test('Scenario A: Primary (OpenAI) responds OK -> Mistral is NOT called', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: validOpenAiPatch,
      inputTokens: 100,
      outputTokens: 50,
    }));
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => {
      throw new Error('Mistral should not be called when primary succeeds');
    });

    const res = await interpretWithFallback('Cena con amigos', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.providerUsed, 'openai');
    assert.equal(res.modelUsed, 'gpt-5.6-luna');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 0);
  });

  // B. Primary (OpenAI) falla con 429 -> Mistral ES llamado y responde OK
  test('Scenario B: Primary (OpenAI) fails with 429 -> Mistral IS called and responds OK', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI rate limit (429)',
        type: 'retryable_technical',
        provider: 'openai',
        httpStatus: 429,
      });
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: validMistralPatch,
      inputTokens: 90,
      outputTokens: 45,
    }));

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.providerUsed, 'mistral');
    assert.equal(res.modelUsed, 'ministral-8b-2512');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 1);
  });

  // C. Primary (OpenAI) falla con 500/502/503/504 -> Mistral ES llamado y responde OK
  test('Scenario C: Primary (OpenAI) fails with 500/502/503/504 -> Mistral IS called and responds OK', async () => {
    for (const status of [500, 502, 503, 504]) {
      const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
        throw new ProviderError({
          message: `OpenAI server error (${status})`,
          type: 'retryable_technical',
          provider: 'openai',
          httpStatus: status,
        });
      });
      const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
        patch: validMistralPatch,
        inputTokens: 80,
        outputTokens: 40,
      }));

      const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
        systemPrompt: dummyPrompt,
        jsonSchema: dummySchema,
      });

      assert.equal(res.ok, true);
      assert.equal(res.fallbackUsed, true);
      assert.equal(res.providerUsed, 'mistral');
      assert.equal(primary.callCount, 1);
      assert.equal(fallback.callCount, 1);
    }
  });

  // D. Primary (OpenAI) timeout -> Mistral ES llamado y responde OK
  test('Scenario D: Primary (OpenAI) timeout -> Mistral IS called and responds OK', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async ({ signal }) => {
      await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Timeout after 20ms')));
      });
      return { patch: {}, inputTokens: 0, outputTokens: 0 };
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: validMistralPatch,
      inputTokens: 95,
      outputTokens: 50,
    }));

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
      primaryTimeoutMs: 20,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.providerUsed, 'mistral');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 1);
  });

  // E. Primary (OpenAI) invalid JSON / schema fail -> Mistral ES llamado y responde OK
  test('Scenario E: Primary (OpenAI) invalid JSON / schema fail -> Mistral IS called and responds OK', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI schema validation failed: missing confidence',
        type: 'retryable_technical',
        provider: 'openai',
      });
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: validMistralPatch,
      inputTokens: 90,
      outputTokens: 40,
    }));

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.providerUsed, 'mistral');
    assert.equal(primary.callCount, 1);
    assert.equal(fallback.callCount, 1);
  });

  // F. Primary (OpenAI) safety refusal -> Mistral NUNCA es llamado
  test('Scenario F: Primary (OpenAI) safety refusal -> Mistral is NEVER called', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI safety refusal (400): content_policy_violation',
        type: 'safety_refusal',
        provider: 'openai',
        httpStatus: 400,
        code: 'content_policy_violation',
      });
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => {
      throw new Error('SECURITY VIOLATION: Mistral must NEVER be called after safety refusal!');
    });

    const res = await interpretWithFallback('Inappropriate prompt', undefined, primary, fallback, {
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

  // G. Primary (OpenAI) 401/403 -> Mistral NUNCA es llamado
  test('Scenario G: Primary (OpenAI) 401/403 auth error -> Mistral is NEVER called', async () => {
    for (const status of [401, 403]) {
      const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
        throw new ProviderError({
          message: `OpenAI API error (${status}): Invalid API key`,
          type: 'auth_config',
          provider: 'openai',
          httpStatus: status,
        });
      });
      const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => {
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
    }
  });

  // H. Primary (OpenAI) 400 bad request no safety -> Mistral NUNCA es llamado
  test('Scenario H: Primary (OpenAI) 400 bad request non-safety -> Mistral is NEVER called', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI request error (400): Malformed parameter',
        type: 'non_retryable',
        provider: 'openai',
        httpStatus: 400,
      });
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => {
      throw new Error('Fallback must not be called on non-retryable 400');
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

  // I. Primary falla retryable + Mistral responde OK -> fallbackUsed=true, patch válido
  test('Scenario I: Primary fails retryable + Mistral responds OK -> fallbackUsed=true, valid patch', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI API error (503): Service Unavailable',
        type: 'retryable_technical',
        provider: 'openai',
        httpStatus: 503,
      });
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: validMistralPatch,
      inputTokens: 110,
      outputTokens: 48,
    }));

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.providerUsed, 'mistral');
    assert.equal(res.modelUsed, 'ministral-8b-2512');
    assert.deepEqual(res.patch, validMistralPatch);
    assert.equal(res.primaryFailureType, 'retryable_technical');
    assert.ok(typeof res.primaryLatencyMs === 'number');
    assert.ok(typeof res.fallbackLatencyMs === 'number');
  });

  // J. Primary falla retryable + Mistral también falla -> double failure controlado, no crash, fallbackUsed=true
  test('Scenario J: Primary fails retryable + Mistral also fails -> controlled double failure, no crash', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI API error (500): Server error',
        type: 'retryable_technical',
        provider: 'openai',
      });
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => {
      throw new ProviderError({
        message: 'Mistral API error (503): Backend offline',
        type: 'retryable_technical',
        provider: 'mistral',
      });
    });

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.primaryProvider, 'openai');
    assert.equal(res.fallbackProvider, 'mistral');
    assert.equal(res.primaryFailureType, 'retryable_technical');
    assert.equal(res.fallbackFailureType, 'retryable_technical');
    assert.equal(res.error, 'interpretation_failed');
    assert.equal(res.message, 'No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.');
  });

  // K. Mistral timeout independiente respetado (AI_FALLBACK_TIMEOUT_MS)
  test('Scenario K: Mistral independent fallback timeout respected (AI_FALLBACK_TIMEOUT_MS)', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'Primary timeout',
        type: 'retryable_technical',
        provider: 'openai',
      });
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async ({ signal }) => {
      await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Timeout after 40ms')));
      });
      return { patch: {}, inputTokens: 0, outputTokens: 0 };
    });

    const res = await interpretWithFallback('Cena', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
      primaryTimeoutMs: 100,
      fallbackTimeoutMs: 40,
    });

    assert.equal(res.ok, false);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.fallbackFailureType, 'retryable_technical');
    assert.ok(res.fallbackError?.includes('Timeout'));
  });

  // L. Normalización de sentinels ("null" / "undefined") probada con test unitario específico
  test('Scenario L: Sentinel normalization converts "null" / "undefined" to absence cleanly', () => {
    // 1. Raw LLM output with string sentinels
    const rawOutputWithSentinels = {
      title: { value: 'null', confidence: 'ambiguous' },
      description: { value: ' undefined ', confidence: 'inferred_low' },
      modality: { value: 'NULL', confidence: 'ambiguous' },
      locationText: { value: 'Null Island', confidence: 'explicit' }, // legitimate string containing word
      dateIntent: {
        value: {
          type: 'weekday',
          weekday: 'viernes',
          day: 'null',
          month: null,
          year: 'undefined',
        },
        confidence: 'explicit',
      },
      timeIntent: {
        value: {
          type: 'exact',
          hour: 21,
          minute: 0,
        },
        confidence: 'explicit',
      },
    };

    const cleaned = cleanNullProperties(rawOutputWithSentinels) as any;

    // Sentinels stripped from top-level field wrappers
    assert.equal('title' in cleaned, false, 'title with "null" value must be omitted');
    assert.equal('description' in cleaned, false, 'description with " undefined " must be omitted');
    assert.equal('modality' in cleaned, false, 'modality with "NULL" must be omitted');

    // Legitimate string containing "Null Island" is preserved
    assert.equal(cleaned.locationText.value, 'Null Island');
    assert.equal(cleaned.locationText.confidence, 'explicit');

    // Inner object properties stripped
    assert.equal('day' in cleaned.dateIntent.value, false);
    assert.equal('month' in cleaned.dateIntent.value, false);
    assert.equal('year' in cleaned.dateIntent.value, false);
    assert.equal(cleaned.dateIntent.value.weekday, 'viernes');

    // Valid fields remain intact
    assert.equal(cleaned.timeIntent.value.hour, 21);

    // Schema validation succeeds on cleaned object
    const validation = validatePatchOutput(cleaned);
    assert.equal(validation.valid, true);
  });
});

// =============================================================================
// SUITE: TEMPORAL NON-INFERENCE & EVIDENCE INTEGRITY (MANDATORY CASES A TO E)
// =============================================================================
describe('Runtime Fallback Multi-Provider: Temporal Non-Inference & Evidence Integrity (Mandatory Cases A to E)', () => {
  // Caso A: "Cena por Zoom con la familia"
  // modality: virtual, dateIntent: ausente, timeIntent: ausente
  test('Case A: "Cena por Zoom con la familia" -> modality: virtual, dateIntent: absent, timeIntent: absent', async () => {
    const input = 'Cena por Zoom con la familia';

    // Verify evidence detectors
    assert.equal(hasDateEvidence(input), false, 'Must not detect date evidence in Case A');
    assert.equal(hasTimeEvidence(input), false, 'Must not detect time evidence in Case A');

    // Simulate LLM output that incorrectly emitted vague date/time
    const rawPatch = {
      title: { value: 'Cena con la familia', confidence: 'explicit' },
      description: { value: 'Reunión familiar para cenar por videollamada', confidence: 'explicit' },
      modality: { value: 'virtual', confidence: 'explicit' },
      virtualLink: { value: 'Zoom', confidence: 'explicit' },
      dateIntent: {
        value: { type: 'vague', value: 'today', description: 'Sin fecha específica' },
        confidence: 'ambiguous',
      },
      timeIntent: {
        value: { type: 'vague', value: 'evening', description: 'Hora de cena' },
        confidence: 'inferred_high',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI 503',
        type: 'retryable_technical',
        provider: 'openai',
      });
    });

    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: rawPatch,
      inputTokens: 100,
      outputTokens: 50,
    }));

    const res = await interpretWithFallback(input, undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.equal(res.fallbackUsed, true);
    assert.ok(res.patch);
    assert.equal(res.patch.modality?.value, 'virtual');
    assert.equal(res.patch.virtualLink?.value, 'Zoom');
    assert.equal('dateIntent' in res.patch, false, 'dateIntent must be absent');
    assert.equal('timeIntent' in res.patch, false, 'timeIntent must be absent');

    // Verify draft merger result
    const emptyDraft = createEmptyEncounterDraft();
    const emptyConfig = createDefaultInvitationConfig();
    const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, res.patch as any);
    assert.equal(draft.modality, 'virtual');
    assert.equal(draft.virtualLink, null, 'Zoom platform name sets modality=virtual but leaves virtualLink null');
    assert.equal(draft.date, null);
    assert.equal(draft.time, null);
  });

  // Caso B: "Cena con amigos"
  // modality: presencial, dateIntent: ausente, timeIntent: ausente
  test('Case B: "Cena con amigos" -> modality: presencial, dateIntent: absent, timeIntent: absent', async () => {
    const input = 'Cena con amigos';

    assert.equal(hasDateEvidence(input), false, 'Must not detect date evidence in Case B');
    assert.equal(hasTimeEvidence(input), false, 'Must not detect time evidence in Case B');

    const rawPatch = {
      title: { value: 'Cena con amigos', confidence: 'explicit' },
      description: { value: 'Cena entre amigos', confidence: 'inferred_high' },
      modality: { value: 'presencial', confidence: 'explicit' },
      dateIntent: {
        value: { type: 'relative', value: 'today', modifier: 'this' },
        confidence: 'inferred_low',
      },
      timeIntent: {
        value: { type: 'exact', hour: 21, minute: 0 },
        confidence: 'inferred_low',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: rawPatch,
      inputTokens: 80,
      outputTokens: 40,
    }));
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: {},
      inputTokens: 0,
      outputTokens: 0,
    }));

    const res = await interpretWithFallback(input, undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.ok(res.patch);
    assert.equal(res.patch.modality?.value, 'presencial');
    assert.equal('dateIntent' in res.patch, false, 'dateIntent must be stripped due to lack of evidence');
    assert.equal('timeIntent' in res.patch, false, 'timeIntent must be stripped due to lack of evidence');

    const emptyDraft = createEmptyEncounterDraft();
    const emptyConfig = createDefaultInvitationConfig();
    const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, res.patch as any);
    assert.equal(draft.modality, 'presencial');
    assert.equal(draft.date, null);
    assert.equal(draft.time, null);
  });

  // Caso C: "Desayuno mañana"
  // modality: presencial, dateIntent: relative -> tomorrow, timeIntent: ausente
  test('Case C: "Desayuno mañana" -> modality: presencial, dateIntent: relative tomorrow, timeIntent: absent', async () => {
    const input = 'Desayuno mañana';

    assert.equal(hasDateEvidence(input), true, 'Must detect date evidence ("mañana")');
    assert.equal(hasTimeEvidence(input), false, 'Must not detect time evidence');

    const rawPatch = {
      title: { value: 'Desayuno', confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'explicit' },
      dateIntent: {
        value: { type: 'relative', value: 'tomorrow', modifier: 'this', description: 'mañana' },
        confidence: 'explicit',
      },
      timeIntent: {
        value: { type: 'vague', value: 'morning', description: 'Horario matutino' },
        confidence: 'inferred_low',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: rawPatch,
      inputTokens: 75,
      outputTokens: 35,
    }));
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: {},
      inputTokens: 0,
      outputTokens: 0,
    }));

    const res = await interpretWithFallback(input, undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.ok(res.patch);
    assert.equal(res.patch.modality?.value, 'presencial');
    assert.ok(res.patch.dateIntent, 'dateIntent must be preserved when evidence exists');
    assert.equal(res.patch.dateIntent.value.type, 'relative');
    assert.equal(res.patch.dateIntent.value.value, 'tomorrow');
    assert.equal('timeIntent' in res.patch, false, 'timeIntent must be absent');

    const emptyDraft = createEmptyEncounterDraft();
    const emptyConfig = createDefaultInvitationConfig();
    const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, res.patch as any);
    assert.equal(draft.modality, 'presencial');
    assert.ok(draft.date !== null);
    assert.equal(draft.time, null);
  });

  // Caso D: "Cena a las 21"
  // modality: presencial, dateIntent: ausente, timeIntent: exact -> 21:00
  test('Case D: "Cena a las 21" -> modality: presencial, dateIntent: absent, timeIntent: exact 21:00', async () => {
    const input = 'Cena a las 21';

    assert.equal(hasDateEvidence(input), false, 'Must not detect date evidence');
    assert.equal(hasTimeEvidence(input), true, 'Must detect time evidence ("a las 21")');

    const rawPatch = {
      title: { value: 'Cena', confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'explicit' },
      dateIntent: {
        value: { type: 'vague', value: 'today', description: 'Hoy por defecto' },
        confidence: 'inferred_low',
      },
      timeIntent: {
        value: { type: 'exact', hour: 21, minute: 0, description: '21:00' },
        confidence: 'explicit',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: rawPatch,
      inputTokens: 75,
      outputTokens: 35,
    }));
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: {},
      inputTokens: 0,
      outputTokens: 0,
    }));

    const res = await interpretWithFallback(input, undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.ok(res.patch);
    assert.equal(res.patch.modality?.value, 'presencial');
    assert.equal('dateIntent' in res.patch, false, 'dateIntent must be absent');
    assert.ok(res.patch.timeIntent, 'timeIntent must be preserved when evidence exists');
    assert.equal(res.patch.timeIntent.value.type, 'exact');
    assert.equal(res.patch.timeIntent.value.hour, 21);
    assert.equal(res.patch.timeIntent.value.minute, 0);

    const emptyDraft = createEmptyEncounterDraft();
    const emptyConfig = createDefaultInvitationConfig();
    const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, res.patch as any);
    assert.equal(draft.modality, 'presencial');
    assert.equal(draft.date, null);
    assert.equal(draft.time, '21:00');
  });

  // Caso E: "Partido de pádel"
  // modality: presencial, dateIntent: ausente, timeIntent: ausente
  test('Case E: "Partido de pádel" -> modality: presencial, dateIntent: absent, timeIntent: absent', async () => {
    const input = 'Partido de pádel';

    assert.equal(hasDateEvidence(input), false, 'Must not detect date evidence in Case E');
    assert.equal(hasTimeEvidence(input), false, 'Must not detect time evidence in Case E');

    const rawPatch = {
      title: { value: 'Partido de pádel', confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'explicit' },
      themeHint: { value: 'sports', confidence: 'explicit' },
      dateIntent: {
        value: { type: 'vague', description: 'Sin fecha' },
        confidence: 'ambiguous',
      },
      timeIntent: {
        value: { type: 'vague', description: 'Sin hora' },
        confidence: 'ambiguous',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: rawPatch,
      inputTokens: 80,
      outputTokens: 40,
    }));
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: {},
      inputTokens: 0,
      outputTokens: 0,
    }));

    const res = await interpretWithFallback(input, undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.ok(res.patch);
    assert.equal(res.patch.modality?.value, 'presencial');
    assert.equal('dateIntent' in res.patch, false, 'dateIntent must be absent');
    assert.equal('timeIntent' in res.patch, false, 'timeIntent must be absent');

    const emptyDraft = createEmptyEncounterDraft();
    const emptyConfig = createDefaultInvitationConfig();
    const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, res.patch as any);
    assert.equal(draft.modality, 'presencial');
    assert.equal(draft.date, null);
    assert.equal(draft.time, null);
  });
});

// =============================================================================
// SUITE: REAL ORCHESTRATOR TIMEOUT VALIDATION (8000 MS)
// =============================================================================
describe('Runtime Fallback Multi-Provider: Real Orchestrator Timeout Validation (8000ms)', () => {
  test('Mistral fallback respects 8000ms timeout with real TCP/HTTP server and yields controlled double failure', async () => {
    // Start real local HTTP server that hangs/delays for 12 seconds
    const server = http.createServer((req, res) => {
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
        }
      }, 12000);

      req.on('close', () => {
        clearTimeout(timer);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as net.AddressInfo;
    const serverUrl = `http://127.0.0.1:${address.port}`;

    try {
      // Primary fails with retryable technical error to trigger fallback
      const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
        throw new ProviderError({
          message: 'Primary OpenAI 503 Service Unavailable',
          type: 'retryable_technical',
          provider: 'openai',
          httpStatus: 503,
        });
      });

      // Real MistralProvider pointing to our local hanging server
      const fallback = new MistralProvider('test-key', 'ministral-8b-2512', serverUrl);

      const startTime = Date.now();
      const res = await interpretWithFallback('Cena con amigos', undefined, primary, fallback, {
        systemPrompt: dummyPrompt,
        jsonSchema: dummySchema,
        fallbackTimeoutMs: 8000,
      });
      const elapsed = Date.now() - startTime;

      // Verification assertions
      assert.equal(res.ok, false, 'Result must be ok: false on double failure');
      assert.equal(res.fallbackUsed, true, 'fallbackUsed must be true');
      assert.equal(res.primaryProvider, 'openai');
      assert.equal(res.fallbackProvider, 'mistral');
      assert.equal(res.primaryFailureType, 'retryable_technical');
      assert.equal(res.fallbackFailureType, 'retryable_technical');
      assert.equal(res.error, 'interpretation_failed');
      assert.equal(
        res.message,
        'No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.'
      );
      assert.ok(
        res.fallbackError?.includes('Timeout after 8000ms'),
        `Fallback error should mention timeout: ${res.fallbackError}`
      );

      // Verify elapsed time is approximately 8000ms (7800ms - 9500ms tolerance)
      assert.ok(
        elapsed >= 7800 && elapsed <= 9500,
        `Elapsed time ${elapsed}ms must be between 7800ms and 9500ms`
      );
    } finally {
      // Cleanly close server and connections
      server.closeAllConnections?.();
      server.close();
    }
  });
});

// =============================================================================
// SUITE: RUNTIME FALLBACK MULTI-PROVIDER: 24:00 SEMANTICS & TEMPORAL GUARD INTEGRATION
// =============================================================================
describe('Runtime Fallback Multi-Provider: 24:00 Semantics & Temporal Guard Integration', () => {
  test('"Cena familia hoy 24 horas" on Primary preserves timeIntent and resolves to tomorrow 00:00', async () => {
    const input = 'Cena familia hoy 24 horas';
    const rawPatch = {
      title: { value: 'Cena familia', confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'inferred_high' },
      dateIntent: {
        value: { type: 'relative', value: 'today' },
        confidence: 'explicit',
      },
      timeIntent: {
        value: { type: 'exact', hour: 24, minute: 0 },
        confidence: 'explicit',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: rawPatch,
      inputTokens: 100,
      outputTokens: 50,
    }));
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: {},
      inputTokens: 0,
      outputTokens: 0,
    }));

    const res = await interpretWithFallback(input, undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.ok(res.patch);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.patch.modality?.value, 'presencial');
    assert.equal(res.patch.timeIntent?.value?.hour, 24);
    assert.equal(res.patch.timeIntent?.value?.minute, 0);

    const emptyDraft = createEmptyEncounterDraft();
    const emptyConfig = createDefaultInvitationConfig();
    const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, res.patch as any);

    const today = getArgentinaTodayISO();
    const tomorrow = addDaysToIsoDate(today, 1);
    assert.equal(draft.time, '00:00');
    assert.equal(draft.date, tomorrow);
    assert.equal(draft.modality, 'presencial');
  });

  test('"Cena familia hoy 24 horas" on Fallback (Mistral) preserves timeIntent and resolves to tomorrow 00:00', async () => {
    const input = 'Cena familia hoy 24 horas';
    const fallbackPatch = {
      title: { value: 'Cena familia', confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'inferred_high' },
      dateIntent: {
        value: { type: 'relative', value: 'today' },
        confidence: 'explicit',
      },
      timeIntent: {
        value: { type: 'exact', hour: 24, minute: 0 },
        confidence: 'explicit',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => {
      throw new ProviderError({
        message: 'OpenAI 500 Internal Error',
        type: 'retryable_technical',
        provider: 'openai',
        httpStatus: 500,
      });
    });
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: fallbackPatch,
      inputTokens: 110,
      outputTokens: 55,
    }));

    const res = await interpretWithFallback(input, undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.ok(res.patch);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.fallbackProvider, 'mistral');
    assert.equal(res.patch.timeIntent?.value?.hour, 24);

    const emptyDraft = createEmptyEncounterDraft();
    const emptyConfig = createDefaultInvitationConfig();
    const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, res.patch as any);

    const today = getArgentinaTodayISO();
    const tomorrow = addDaysToIsoDate(today, 1);
    assert.equal(draft.time, '00:00');
    assert.equal(draft.date, tomorrow);
  });

  test('"24 personas" with model returning timeIntent -> sanitized away deterministically', async () => {
    const input = 'Asado para 24 personas';
    const hallucinatedPatch = {
      title: { value: 'Asado', confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'inferred_high' },
      timeIntent: {
        value: { type: 'exact', hour: 24, minute: 0 },
        confidence: 'explicit',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: hallucinatedPatch,
      inputTokens: 80,
      outputTokens: 30,
    }));
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: {},
      inputTokens: 0,
      outputTokens: 0,
    }));

    const res = await interpretWithFallback(input, undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.ok(res.patch);
    assert.equal('timeIntent' in res.patch, false, 'timeIntent must be pruned for "24 personas"');

    const emptyDraft = createEmptyEncounterDraft();
    const emptyConfig = createDefaultInvitationConfig();
    const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, res.patch as any);
    assert.equal(draft.time, null);
  });

  test('"durante 24 horas" with model returning timeIntent -> sanitized away deterministically', async () => {
    const input = 'Hackathon durante 24 horas';
    const hallucinatedPatch = {
      title: { value: 'Hackathon', confidence: 'explicit' },
      timeIntent: {
        value: { type: 'exact', hour: 24, minute: 0 },
        confidence: 'explicit',
      },
    };

    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: hallucinatedPatch,
      inputTokens: 80,
      outputTokens: 30,
    }));
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({
      patch: {},
      inputTokens: 0,
      outputTokens: 0,
    }));

    const res = await interpretWithFallback(input, undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });

    assert.equal(res.ok, true);
    assert.ok(res.patch);
    assert.equal('timeIntent' in res.patch, false, 'timeIntent must be pruned for "durante 24 horas"');

    const emptyDraft = createEmptyEncounterDraft();
    const emptyConfig = createDefaultInvitationConfig();
    const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, res.patch as any);
    assert.equal(draft.time, null);
  });

  test('Multi-turn fallback integration: Turn 1 "Cena a las 24" + Turn 2 "viernes" -> sábado 00:00', async () => {
    // Turn 1
    const primary1 = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: {
        title: { value: 'Cena', confidence: 'explicit' },
        modality: { value: 'presencial', confidence: 'inferred_high' },
        timeIntent: { value: { type: 'exact', hour: 24, minute: 0 }, confidence: 'explicit' },
      },
      inputTokens: 80,
      outputTokens: 40,
    }));
    const fallback1 = new MockProvider('mistral', 'ministral-8b-2512', async () => ({ patch: {} }));

    const res1 = await interpretWithFallback('Cena a las 24', undefined, primary1, fallback1, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });
    assert.equal(res1.ok, true);

    const draft0 = createEmptyEncounterDraft();
    const config0 = createDefaultInvitationConfig();
    const merge1 = mergeDraftPatch(draft0, config0, res1.patch as any);
    assert.equal(merge1.draft.time, '00:00');
    assert.equal(merge1.draft.date, null);
    assert.equal(merge1.draft.pendingDayRollover, true);

    // Turn 2
    const primary2 = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: {
        dateIntent: { value: { type: 'weekday', weekday: 'viernes', modifier: 'this' }, confidence: 'inferred_high' },
      },
      inputTokens: 80,
      outputTokens: 40,
    }));
    const fallback2 = new MockProvider('mistral', 'ministral-8b-2512', async () => ({ patch: {} }));

    const res2 = await interpretWithFallback('viernes', merge1.draft, primary2, fallback2, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });
    assert.equal(res2.ok, true);

    const merge2 = mergeDraftPatch(merge1.draft, merge1.config, res2.patch as any);
    assert.equal(merge2.draft.time, '00:00');
    const today = getArgentinaTodayISO();
    // Friday date + 1 day -> Saturday
    assert.ok(merge2.draft.date);
    assert.equal(merge2.draft.pendingDayRollover, false);
  });

  test('Ambiguous 12 integration: "Cena a las 12" keeps draft.time null and records ambiguity', async () => {
    const primary = new MockProvider('openai', 'gpt-5.6-luna', async () => ({
      patch: {
        title: { value: 'Cena', confidence: 'explicit' },
        timeIntent: {
          value: { type: 'vague', description: '¿Te referís al mediodía o a la medianoche?' },
          confidence: 'ambiguous',
        },
      },
      inputTokens: 80,
      outputTokens: 40,
    }));
    const fallback = new MockProvider('mistral', 'ministral-8b-2512', async () => ({ patch: {} }));

    const res = await interpretWithFallback('Cena a las 12', undefined, primary, fallback, {
      systemPrompt: dummyPrompt,
      jsonSchema: dummySchema,
    });
    assert.equal(res.ok, true);

    const draft0 = createEmptyEncounterDraft();
    const config0 = createDefaultInvitationConfig();
    const merge = mergeDraftPatch(draft0, config0, res.patch as any);
    assert.equal(merge.draft.time, null);
    assert.equal(merge.ambiguities.length, 1);
    assert.equal(merge.ambiguities[0].field, 'time');
  });
});

