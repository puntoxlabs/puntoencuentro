export interface ProviderInterpretationResult {
  patch: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  rawResponse?: string;
}

export interface EncounterInterpreterProvider {
  name: string;
  model: string;
  interpret(params: {
    message: string;
    currentDraft?: Record<string, unknown>;
    systemPrompt: string;
    jsonSchema: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ProviderInterpretationResult>;
}

export type ProviderErrorType =
  | "retryable_technical"
  | "safety_refusal"
  | "auth_config"
  | "non_retryable";

export interface ProviderErrorOptions {
  message: string;
  type: ProviderErrorType;
  provider: string;
  httpStatus?: number;
  code?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly type: ProviderErrorType;
  readonly provider: string;
  readonly httpStatus?: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    this.name = "ProviderError";
    this.type = options.type;
    this.provider = options.provider;
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.retryable = options.type === "retryable_technical";
    if (options.cause) {
      (this as any).cause = options.cause;
    }
  }
}

/**
 * Classifies an unknown error or raw exception into a typed ProviderError.
 */
export function classifyProviderError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // 1. Timeout or abort
  if (lower.includes("timeout") || lower.includes("aborted") || lower.includes("abort")) {
    return new ProviderError({
      message,
      type: "retryable_technical",
      provider,
    });
  }

  // 2. Network / connection errors
  if (
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("connection refused") ||
    lower.includes("network error")
  ) {
    return new ProviderError({
      message,
      type: "retryable_technical",
      provider,
    });
  }

  // 3. Safety / content refusal
  if (
    lower.includes("content_policy_violation") ||
    lower.includes("content_filter") ||
    lower.includes("content policy") ||
    lower.includes("safety") ||
    lower.includes("moderation") ||
    lower.includes("refusal")
  ) {
    return new ProviderError({
      message,
      type: "safety_refusal",
      provider,
    });
  }

  // 4. Auth / credentials / configuration (401, 403, api key)
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("api key") ||
    lower.includes("missing")
  ) {
    return new ProviderError({
      message,
      type: "auth_config",
      provider,
    });
  }

  // 5. Rate limits (429)
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
    return new ProviderError({
      message,
      type: "retryable_technical",
      provider,
      httpStatus: 429,
    });
  }

  // 6. Server errors 5xx
  if (
    /50[0-4]/.test(message) ||
    lower.includes("server error") ||
    lower.includes("service unavailable") ||
    lower.includes("gateway")
  ) {
    return new ProviderError({
      message,
      type: "retryable_technical",
      provider,
    });
  }

  // 7. Empty or parsing/validation errors
  if (
    lower.includes("empty patch") ||
    lower.includes("empty or missing") ||
    lower.includes("no content") ||
    lower.includes("no text") ||
    lower.includes("unexpected token") ||
    lower.includes("schema validation failed") ||
    lower.includes("does not conform") ||
    lower.includes("failed to parse json")
  ) {
    return new ProviderError({
      message,
      type: "retryable_technical",
      provider,
    });
  }

  // 8. Request errors 400
  if (lower.includes("400") || lower.includes("bad request") || lower.includes("invalid_request")) {
    return new ProviderError({
      message,
      type: "non_retryable",
      provider,
      httpStatus: 400,
    });
  }

  // Default non-retryable
  return new ProviderError({
    message,
    type: "non_retryable",
    provider,
  });
}

