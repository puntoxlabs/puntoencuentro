import type { EncounterInterpreterProvider, ProviderInterpretationResult } from "./base.ts";
import { ProviderError } from "./base.ts";
import { sanitizeSchemaForOpenAI, cleanNullProperties, validatePatchOutput, sanitizeTemporalIntents } from "../validation.ts";

export class MistralProvider implements EncounterInterpreterProvider {
  name = "mistral";
  model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(
    apiKey: string,
    model: string = "ministral-8b-2512",
    baseUrl: string = "https://api.mistral.ai/v1"
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async interpret(params: {
    message: string;
    currentDraft?: Record<string, unknown>;
    systemPrompt: string;
    jsonSchema: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ProviderInterpretationResult> {
    const url = `${this.baseUrl}/chat/completions`;

    const userContent = params.currentDraft && Object.keys(params.currentDraft).length > 0
      ? `Estado actual del encuentro acumulado: ${JSON.stringify(params.currentDraft)}\n\nNuevo mensaje del usuario: "${params.message}"`
      : `Mensaje del usuario: "${params.message}"`;

    const requestBody = {
      model: this.model,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: userContent }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "encounter_draft_patch",
          strict: true,
          schema: sanitizeSchemaForOpenAI(params.jsonSchema)
        }
      },
      temperature: 0.1
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: params.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: any = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        // non-JSON error response
      }

      const status = response.status;
      const errorObj = errorJson?.error || errorJson || {};
      const code = errorObj.code || undefined;
      const message = errorObj.message || errorText;

      if (status === 401 || status === 403) {
        throw new ProviderError({
          message: `Mistral API error (${status}): ${message}`,
          type: "auth_config",
          provider: this.name,
          httpStatus: status,
          code,
        });
      }

      if (status === 429) {
        throw new ProviderError({
          message: `Mistral API error (${status}): ${message}`,
          type: "retryable_technical",
          provider: this.name,
          httpStatus: status,
          code,
        });
      }

      if (status >= 500 && status <= 599) {
        throw new ProviderError({
          message: `Mistral API error (${status}): ${message}`,
          type: "retryable_technical",
          provider: this.name,
          httpStatus: status,
          code,
        });
      }

      if (status === 400) {
        const isSafety =
          code === "content_policy_violation" ||
          /content.*policy|safety|moderation|violat/i.test(message);
        if (isSafety) {
          throw new ProviderError({
            message: `Mistral safety refusal (${status}): ${message}`,
            type: "safety_refusal",
            provider: this.name,
            httpStatus: status,
            code,
          });
        }
        throw new ProviderError({
          message: `Mistral request error (${status}): ${message}`,
          type: "non_retryable",
          provider: this.name,
          httpStatus: status,
          code,
        });
      }

      throw new ProviderError({
        message: `Mistral API error (${status}): ${message}`,
        type: "non_retryable",
        provider: this.name,
        httpStatus: status,
        code,
      });
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const messageObj = choice?.message;

    // Check for refusal field or content_filter finish_reason
    if (messageObj?.refusal) {
      throw new ProviderError({
        message: `Mistral refusal: ${messageObj.refusal}`,
        type: "safety_refusal",
        provider: this.name,
        httpStatus: 200,
        code: "refusal",
      });
    }

    if (choice?.finish_reason === "content_filter") {
      throw new ProviderError({
        message: "Mistral finish_reason: content_filter",
        type: "safety_refusal",
        provider: this.name,
        httpStatus: 200,
        code: "content_filter",
      });
    }

    const content = messageObj?.content;
    if (!content || !content.trim()) {
      throw new ProviderError({
        message: "No content returned by Mistral API",
        type: "retryable_technical",
        provider: this.name,
      });
    }

    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(content);
    } catch (parseErr: any) {
      throw new ProviderError({
        message: `Failed to parse JSON response from Mistral: ${parseErr.message}`,
        type: "retryable_technical",
        provider: this.name,
        cause: parseErr,
      });
    }

    if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
      throw new ProviderError({
        message: "Mistral response must be a valid JSON object",
        type: "retryable_technical",
        provider: this.name,
      });
    }

    const cleaned = cleanNullProperties(rawParsed as Record<string, unknown>);
    const patch = sanitizeTemporalIntents(cleaned, params.message);
    const validation = validatePatchOutput(patch);
    if (!validation.valid) {
      throw new ProviderError({
        message: `Mistral response does not conform to EncounterDraftPatch schema: ${validation.error}`,
        type: "retryable_technical",
        provider: this.name,
      });
    }

    const usage = data.usage || {};

    return {
      patch,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      rawResponse: content
    };
  }
}
