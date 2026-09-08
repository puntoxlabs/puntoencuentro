import type { EncounterInterpreterProvider, ProviderInterpretationResult } from "./base.ts";
import { sanitizeSchemaForGemini } from "../validation.ts";

export class GoogleGeminiProvider implements EncounterInterpreterProvider {
  name = "google";
  model: string;
  private apiKey: string;

  constructor(apiKey: string, model: string = "gemini-3.8-flash") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async interpret(params: {
    message: string;
    currentDraft?: Record<string, unknown>;
    systemPrompt: string;
    jsonSchema: Record<string, unknown>;
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
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Gemini API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error("No text returned by Google Gemini API");
    }

    const patch = JSON.parse(text);
    const usage = data.usageMetadata || {};

    return {
      patch,
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      rawResponse: text
    };
  }
}
