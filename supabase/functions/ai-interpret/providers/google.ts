import type { EncounterInterpreterProvider, ProviderInterpretationResult } from "./base.ts";
import { ProviderError } from "./base.ts";
import { sanitizeSchemaForGemini, cleanNullProperties, validatePatchOutput } from "../validation.ts";

export class GoogleGeminiProvider implements EncounterInterpreterProvider {
  name = "google";
  model: string;
  private apiKey: string;

  constructor(apiKey: string, model: string = "gemini-3.8-flash") {
    if (!apiKey) {
      throw new ProviderError({
        message: "Missing GEMINI_API_KEY",
        type: "auth_config",
        provider: "google",
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    const userContent = params.currentDraft && Object.keys(params.currentDraft).length > 0
      ? `Estado actual del encuentro acumulado: ${JSON.stringify(params.currentDraft)}\n\nNuevo mensaje del usuario: "${params.message}"`
      : `Mensaje del usuario: "${params.message}"`;

    const requestBody = {
      systemInstruction: {
        parts: [{ text: params.systemPrompt }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userContent }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: sanitizeSchemaForGemini(params.jsonSchema),
        temperature: 0.1,
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey
      },
      body: JSON.stringify(requestBody),
      signal: params.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      const status = response.status;

      if (status === 401 || status === 403) {
        throw new ProviderError({
          message: `Google Gemini authentication/authorization error (${status}): ${errorText}`,
          type: "auth_config",
          provider: this.name,
          httpStatus: status,
        });
      }

      if (status === 429) {
        throw new ProviderError({
          message: `Google Gemini rate limit error (${status}): ${errorText}`,
          type: "retryable_technical",
          provider: this.name,
          httpStatus: status,
        });
      }

      if (status >= 500 && status <= 599) {
        throw new ProviderError({
          message: `Google Gemini server error (${status}): ${errorText}`,
          type: "retryable_technical",
          provider: this.name,
          httpStatus: status,
        });
      }

      const isSafety = /safety|block|policy|violat/i.test(errorText);
      if (isSafety) {
        throw new ProviderError({
          message: `Google Gemini safety refusal (${status}): ${errorText}`,
          type: "safety_refusal",
          provider: this.name,
          httpStatus: status,
        });
      }

      throw new ProviderError({
        message: `Google Gemini API error (${status}): ${errorText}`,
        type: "non_retryable",
        provider: this.name,
        httpStatus: status,
      });
    }

    const data = await response.json();

    if (data.promptFeedback?.blockReason) {
      throw new ProviderError({
        message: `Google Gemini blocked prompt: ${data.promptFeedback.blockReason}`,
        type: "safety_refusal",
        provider: this.name,
        httpStatus: 200,
        code: data.promptFeedback.blockReason,
      });
    }

    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === "SAFETY") {
      throw new ProviderError({
        message: "Google Gemini candidate blocked by SAFETY",
        type: "safety_refusal",
        provider: this.name,
        httpStatus: 200,
        code: "SAFETY",
      });
    }

    const text = candidate?.content?.parts?.[0]?.text;
    if (!text || !text.trim()) {
      throw new ProviderError({
        message: "No text returned by Google Gemini API",
        type: "retryable_technical",
        provider: this.name,
      });
    }

    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(text);
    } catch (parseErr: any) {
      throw new ProviderError({
        message: `Failed to parse JSON response from Google Gemini: ${parseErr.message}`,
        type: "retryable_technical",
        provider: this.name,
        cause: parseErr,
      });
    }

    if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
      throw new ProviderError({
        message: "Google Gemini response must be a valid JSON object",
        type: "retryable_technical",
        provider: this.name,
      });
    }

    const patch = cleanNullProperties(rawParsed as Record<string, unknown>);
    const validation = validatePatchOutput(patch);
    if (!validation.valid) {
      throw new ProviderError({
        message: `Google Gemini response does not conform to EncounterDraftPatch schema: ${validation.error}`,
        type: "retryable_technical",
        provider: this.name,
      });
    }

    const usage = data.usageMetadata || {};

    return {
      patch,
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      rawResponse: text
    };
  }
}

