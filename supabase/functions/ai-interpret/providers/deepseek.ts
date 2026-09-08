import type { EncounterInterpreterProvider, ProviderInterpretationResult } from "./base.ts";
import { ProviderError } from "./base.ts";
import { sanitizeSchemaForDeepSeek, cleanNullProperties, validatePatchOutput } from "../validation.ts";

export class DeepSeekProvider implements EncounterInterpreterProvider {
  name = "deepseek";
  model: string;
  private apiKey: string;

  constructor(apiKey: string, model: string = "deepseek-v4-flash") {
    if (!apiKey) {
      throw new ProviderError({
        message: "Missing DEEPSEEK_API_KEY",
        type: "auth_config",
        provider: "deepseek",
      });
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  async interpret(params: {
    message: string;
    currentDraft?: Record<string, unknown>;
    systemPrompt: string;
    jsonSchema: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ProviderInterpretationResult> {
    const url = "https://api.deepseek.com/chat/completions";

    const schemaToUse = sanitizeSchemaForDeepSeek(params.jsonSchema);
    const enrichedSystemPrompt = `${params.systemPrompt}\n\nOBLIGATORIO: Debes responder ÚNICAMENTE con un JSON que cumpla este JSON Schema estricto:\n${JSON.stringify(schemaToUse)}`;

    const userContent = params.currentDraft && Object.keys(params.currentDraft).length > 0
      ? `Estado actual del encuentro acumulado: ${JSON.stringify(params.currentDraft)}\n\nNuevo mensaje del usuario: "${params.message}"`
      : `Mensaje del usuario: "${params.message}"`;

    const requestBody = {
      model: this.model,
      messages: [
        { role: "system", content: enrichedSystemPrompt },
        { role: "user", content: userContent }
      ],
      response_format: {
        type: "json_object"
      }
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
        // non-JSON error
      }

      const status = response.status;
      const errorObj = errorJson?.error || {};
      const code = errorObj.code || undefined;
      const message = errorObj.message || errorText;

      if (status === 401 || status === 403) {
        throw new ProviderError({
          message: `DeepSeek API error (${status}): ${message}`,
          type: "auth_config",
          provider: this.name,
          httpStatus: status,
          code,
        });
      }

      if (status === 429) {
        throw new ProviderError({
          message: `DeepSeek API error (${status}): ${message}`,
          type: "retryable_technical",
          provider: this.name,
          httpStatus: status,
          code,
        });
      }

      if (status >= 500 && status <= 599) {
        throw new ProviderError({
          message: `DeepSeek API error (${status}): ${message}`,
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
            message: `DeepSeek safety refusal (${status}): ${message}`,
            type: "safety_refusal",
            provider: this.name,
            httpStatus: status,
            code,
          });
        }
        throw new ProviderError({
          message: `DeepSeek request error (${status}): ${message}`,
          type: "non_retryable",
          provider: this.name,
          httpStatus: status,
          code,
        });
      }

      throw new ProviderError({
        message: `DeepSeek API error (${status}): ${message}`,
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
        message: `DeepSeek refusal: ${messageObj.refusal}`,
        type: "safety_refusal",
        provider: this.name,
        httpStatus: 200,
        code: "refusal",
      });
    }

    if (choice?.finish_reason === "content_filter") {
      throw new ProviderError({
        message: "DeepSeek finish_reason: content_filter",
        type: "safety_refusal",
        provider: this.name,
        httpStatus: 200,
        code: "content_filter",
      });
    }

    const rawContent = messageObj?.content;
    if (!rawContent || rawContent.trim() === "") {
      throw new ProviderError({
        message: "Empty or missing content returned by DeepSeek API",
        type: "retryable_technical",
        provider: this.name,
      });
    }

    // Strip markdown code fences if present (e.g. ```json ... ```)
    const cleanedContent = rawContent.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();

    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(cleanedContent);
    } catch (parseErr) {
      throw new ProviderError({
        message: `Failed to parse JSON response from DeepSeek: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        type: "retryable_technical",
        provider: this.name,
        cause: parseErr,
      });
    }

    if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
      throw new ProviderError({
        message: "DeepSeek response must be a valid JSON object",
        type: "retryable_technical",
        provider: this.name,
      });
    }

    const patch = cleanNullProperties(rawParsed as Record<string, unknown>);

    // Local deterministic schema validation against EncounterDraftPatch
    const validation = validatePatchOutput(patch);
    if (!validation.valid) {
      throw new ProviderError({
        message: `DeepSeek response does not conform to EncounterDraftPatch schema: ${validation.error}`,
        type: "retryable_technical",
        provider: this.name,
      });
    }

    const usage = data.usage || {};

    return {
      patch,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      rawResponse: rawContent
    };
  }
}

