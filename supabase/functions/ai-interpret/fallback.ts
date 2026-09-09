import type {
  EncounterInterpreterProvider,
  ProviderInterpretationResult,
  ProviderErrorType,
} from "./providers/base.ts";
import { ProviderError, classifyProviderError } from "./providers/base.ts";
import { validatePatchOutput, sanitizeTemporalIntents } from "./validation.ts";
import { OpenAiProvider } from "./providers/openai.ts";
import { DeepSeekProvider } from "./providers/deepseek.ts";
import { GoogleGeminiProvider } from "./providers/google.ts";
import { MistralProvider } from "./providers/mistral.ts";

export interface FallbackExecutionOptions {
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
  primaryTimeoutMs?: number;
  fallbackTimeoutMs?: number;
}

export interface FallbackExecutionResult {
  ok: boolean;
  scope?: 'encounter' | 'off_topic' | 'unclear';
  patch?: Record<string, unknown>;
  providerUsed?: string;
  modelUsed?: string;
  fallbackUsed: boolean;
  primaryProvider: string;
  primaryModel?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  primaryError?: string;
  primaryFailureType?: ProviderErrorType;
  fallbackError?: string;
  fallbackFailureType?: ProviderErrorType;
  primaryLatencyMs: number;
  fallbackLatencyMs?: number;
  totalLatencyMs: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  error?: string;
  message?: string;
}

export interface ProviderResolutionConfig {
  primaryProvider: EncounterInterpreterProvider;
  fallbackProvider: EncounterInterpreterProvider | null;
  primaryTimeoutMs: number;
  fallbackTimeoutMs: number;
}

export interface EnvGetter {
  get: (key: string) => string | undefined;
}

/**
 * Executes an async function with an AbortSignal tied to a timeout.
 * Rejects with a clear TimeoutError if the timeout duration expires.
 */
export async function callWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (err: any) {
    if (controller.signal.aborted) {
      throw new Error(`Timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates an instance of EncounterInterpreterProvider based on name and environment variables.
 */
export function createProvider(
  providerName: string,
  env: EnvGetter,
  modelOverride?: string
): EncounterInterpreterProvider {
  const normalized = providerName.toLowerCase().trim();

  if (normalized === "openai") {
    const apiKey = env.get("OPENAI_API_KEY") || env.get("AI_API_KEY");
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY / AI_API_KEY in environment");
    const model = modelOverride || env.get("OPENAI_MODEL") || env.get("AI_MODEL") || "gpt-5.6-luna";
    return new OpenAiProvider(apiKey, model);
  }

  if (normalized === "mistral") {
    const apiKey = env.get("MISTRAL_API_KEY") || env.get("AI_API_KEY");
    if (!apiKey) throw new Error("Missing MISTRAL_API_KEY / AI_API_KEY in environment");
    const model = modelOverride || env.get("MISTRAL_MODEL") || env.get("AI_MODEL") || "ministral-8b-2512";
    return new MistralProvider(apiKey, model);
  }

  if (normalized === "deepseek") {
    const apiKey = env.get("DEEPSEEK_API_KEY") || env.get("AI_API_KEY");
    if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY / AI_API_KEY in environment");
    const model = modelOverride || env.get("DEEPSEEK_MODEL") || env.get("AI_MODEL") || "deepseek-v4-flash";
    return new DeepSeekProvider(apiKey, model);
  }

  if (normalized === "google" || normalized === "gemini") {
    const apiKey = env.get("GEMINI_API_KEY") || env.get("AI_API_KEY");
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY / AI_API_KEY in environment");
    const model = modelOverride || env.get("GEMINI_MODEL") || env.get("AI_MODEL") || "gemini-3.8-flash";
    return new GoogleGeminiProvider(apiKey, model);
  }

  throw new Error(`Unsupported AI provider: ${providerName}`);
}

/**
 * Resolves PRIMARY and FALLBACK providers along with their timeout configurations.
 */
export function resolveProviders(env: EnvGetter): ProviderResolutionConfig {
  const primaryName = env.get("PRIMARY_AI_PROVIDER") || env.get("AI_PROVIDER") || "openai";
  const fallbackName = env.get("FALLBACK_AI_PROVIDER") || "mistral";

  const primaryTimeoutMs = parseInt(env.get("AI_PRIMARY_TIMEOUT_MS") || "10000", 10) || 10000;
  const fallbackTimeoutMs = parseInt(env.get("AI_FALLBACK_TIMEOUT_MS") || "8000", 10) || 8000;

  const primaryProvider = createProvider(primaryName, env);

  let fallbackProvider: EncounterInterpreterProvider | null = null;
  if (
    fallbackName &&
    fallbackName.toLowerCase() !== "none" &&
    fallbackName.toLowerCase() !== primaryName.toLowerCase()
  ) {
    try {
      fallbackProvider = createProvider(fallbackName, env);
    } catch (err) {
      console.warn(`[ai-interpret] Failed to initialize fallback provider '${fallbackName}':`, err);
    }
  }

  return {
    primaryProvider,
    fallbackProvider,
    primaryTimeoutMs,
    fallbackTimeoutMs,
  };
}

/**
 * Orchestrates interpretation with maximum 1 automatic fallback.
 *
 * Rules:
 * 1. Executes PRIMARY provider with primaryTimeoutMs.
 * 2. If PRIMARY succeeds and produces a schema-valid EncounterDraftPatch:
 *    - Returns immediately (fallbackProvider is NOT called).
 *    - Incomplete patches or functional ambiguities are valid outputs and do NOT trigger fallback.
 * 3. If PRIMARY suffers an error:
 *    - Error is classified into: retryable_technical, safety_refusal, auth_config, or non_retryable.
 *    - If error is NOT retryable (safety refusal, auth/config, non-retryable 400):
 *        DO NOT CALL FALLBACK. Bypassing safety or auth checks is strictly forbidden.
 *    - If error is retryable_technical (timeout, network, 429, 5xx, invalid JSON, schema validation failure):
 *        Calls FALLBACK provider (if configured) with fallbackTimeoutMs.
 * 4. If FALLBACK succeeds:
 *    - Returns fallback result with fallbackUsed: true.
 * 5. If FALLBACK also fails:
 *    - Does NOT attempt any 3rd provider.
 *    - Returns double-failure controlled error with preserved context for manual continuation.
 */
export async function interpretWithFallback(
  message: string,
  currentDraft: Record<string, unknown> | undefined,
  primaryProvider: EncounterInterpreterProvider,
  fallbackProvider: EncounterInterpreterProvider | null,
  options: FallbackExecutionOptions
): Promise<FallbackExecutionResult> {
  const globalStartTime = Date.now();
  const primaryTimeout = options.primaryTimeoutMs ?? 10000;
  const fallbackTimeout = options.fallbackTimeoutMs ?? 8000;

  let primaryResult: ProviderInterpretationResult | null = null;
  let primaryError: string | undefined;
  let primaryFailureType: ProviderErrorType | undefined;
  let primaryLatencyMs = 0;

  // ---------------------------------------------------------------------------
  // STEP 1: Attempt PRIMARY provider
  // ---------------------------------------------------------------------------
  const primaryStartTime = Date.now();
  try {
    primaryResult = await callWithTimeout((signal) => {
      return primaryProvider.interpret({
        message,
        currentDraft,
        systemPrompt: options.systemPrompt,
        jsonSchema: options.jsonSchema,
        signal,
      });
    }, primaryTimeout);

    primaryLatencyMs = Date.now() - primaryStartTime;

    if (!primaryResult || !primaryResult.patch) {
      throw new ProviderError({
        message: "Primary provider returned empty patch",
        type: "retryable_technical",
        provider: primaryProvider.name,
      });
    }

    const primaryPatch = sanitizeTemporalIntents(primaryResult.patch, message);
    const validation = validatePatchOutput(primaryPatch);
    if (!validation.valid) {
      throw new ProviderError({
        message: `Primary schema validation failed: ${validation.error}`,
        type: "retryable_technical",
        provider: primaryProvider.name,
      });
    }

    // PRIMARY SUCCESS: return immediately without touching fallback
    return {
      ok: true,
      scope: ((primaryPatch as any).scope as any) || 'encounter',
      patch: primaryPatch,
      providerUsed: primaryProvider.name,
      modelUsed: primaryProvider.model,
      fallbackUsed: false,
      primaryProvider: primaryProvider.name,
      primaryModel: primaryProvider.model,
      fallbackProvider: fallbackProvider ? fallbackProvider.name : undefined,
      fallbackModel: fallbackProvider ? fallbackProvider.model : undefined,
      primaryLatencyMs,
      totalLatencyMs: primaryLatencyMs,
      usage: {
        inputTokens: primaryResult.inputTokens || 0,
        outputTokens: primaryResult.outputTokens || 0,
      },
    };
  } catch (err: unknown) {
    primaryLatencyMs = Date.now() - primaryStartTime;
    const classifiedError = classifyProviderError(err, primaryProvider.name);
    primaryError = classifiedError.message;
    primaryFailureType = classifiedError.type;

    console.warn(
      `[ai-interpret] Primary provider '${primaryProvider.name}' failed (${primaryLatencyMs}ms) [${classifiedError.type}]: ${classifiedError.message}`
    );

    // CRITICAL SAFETY / REFUSAL / NON-RETRYABLE RULE:
    // If the error is not retryable (e.g. safety_refusal, auth_config, non_retryable),
    // NEVER activate fallback! Fail controlled immediately.
    if (!classifiedError.retryable) {
      const totalLatencyMs = Date.now() - globalStartTime;
      const isSafety = classifiedError.type === "safety_refusal";
      return {
        ok: false,
        fallbackUsed: false,
        primaryProvider: primaryProvider.name,
        primaryModel: primaryProvider.model,
        fallbackProvider: fallbackProvider ? fallbackProvider.name : undefined,
        fallbackModel: fallbackProvider ? fallbackProvider.model : undefined,
        primaryError,
        primaryFailureType,
        primaryLatencyMs,
        totalLatencyMs,
        error: isSafety ? "safety_refusal" : "interpretation_failed",
        message: isSafety
          ? "No pudimos procesar el mensaje por políticas de contenido. Podés continuar manualmente."
          : "No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.",
      };
    }
  }

  // ---------------------------------------------------------------------------
  // STEP 2: Attempt FALLBACK provider (only if primary error is retryable)
  // ---------------------------------------------------------------------------
  if (!fallbackProvider) {
    const totalLatencyMs = Date.now() - globalStartTime;
    return {
      ok: false,
      fallbackUsed: false,
      primaryProvider: primaryProvider.name,
      primaryModel: primaryProvider.model,
      primaryError,
      primaryFailureType,
      primaryLatencyMs,
      totalLatencyMs,
      error: "interpretation_failed",
      message: "No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.",
    };
  }

  const fallbackStartTime = Date.now();
  let fallbackResult: ProviderInterpretationResult | null = null;
  let fallbackError: string | undefined;
  let fallbackFailureType: ProviderErrorType | undefined;
  let fallbackLatencyMs = 0;

  try {
    fallbackResult = await callWithTimeout((signal) => {
      return fallbackProvider.interpret({
        message,
        currentDraft,
        systemPrompt: options.systemPrompt,
        jsonSchema: options.jsonSchema,
        signal,
      });
    }, fallbackTimeout);

    fallbackLatencyMs = Date.now() - fallbackStartTime;

    if (!fallbackResult || !fallbackResult.patch) {
      throw new ProviderError({
        message: "Fallback provider returned empty patch",
        type: "retryable_technical",
        provider: fallbackProvider.name,
      });
    }

    const fallbackPatch = sanitizeTemporalIntents(fallbackResult.patch, message);
    const validation = validatePatchOutput(fallbackPatch);
    if (!validation.valid) {
      throw new ProviderError({
        message: `Fallback schema validation failed: ${validation.error}`,
        type: "retryable_technical",
        provider: fallbackProvider.name,
      });
    }

    // FALLBACK SUCCESS
    const totalLatencyMs = Date.now() - globalStartTime;
    return {
      ok: true,
      scope: ((fallbackPatch as any).scope as any) || 'encounter',
      patch: fallbackPatch,
      providerUsed: fallbackProvider.name,
      modelUsed: fallbackProvider.model,
      fallbackUsed: true,
      primaryProvider: primaryProvider.name,
      primaryModel: primaryProvider.model,
      fallbackProvider: fallbackProvider.name,
      fallbackModel: fallbackProvider.model,
      primaryError,
      primaryFailureType,
      primaryLatencyMs,
      fallbackLatencyMs,
      totalLatencyMs,
      usage: {
        inputTokens: fallbackResult.inputTokens || 0,
        outputTokens: fallbackResult.outputTokens || 0,
      },
    };
  } catch (err: unknown) {
    fallbackLatencyMs = Date.now() - fallbackStartTime;
    const classifiedFallback = classifyProviderError(err, fallbackProvider.name);
    fallbackError = classifiedFallback.message;
    fallbackFailureType = classifiedFallback.type;
    console.error(
      `[ai-interpret] Fallback provider '${fallbackProvider.name}' also failed (${fallbackLatencyMs}ms) [${classifiedFallback.type}]: ${fallbackError}`
    );
  }

  // ---------------------------------------------------------------------------
  // STEP 3: DOUBLE FAILURE (Both Primary & Fallback failed)
  // Maximum 1 fallback: DO NOT attempt any 3rd provider. Return controlled state.
  // ---------------------------------------------------------------------------
  const totalLatencyMs = Date.now() - globalStartTime;
  return {
    ok: false,
    fallbackUsed: true,
    primaryProvider: primaryProvider.name,
    primaryModel: primaryProvider.model,
    fallbackProvider: fallbackProvider.name,
    fallbackModel: fallbackProvider.model,
    primaryError,
    primaryFailureType,
    fallbackError,
    fallbackFailureType,
    primaryLatencyMs,
    fallbackLatencyMs,
    totalLatencyMs,
    error: "interpretation_failed",
    message: "No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.",
  };
}

