import type { EncounterInterpreterProvider, ProviderInterpretationResult } from "./base.ts";
import { sanitizeSchemaForOpenAI, cleanNullProperties } from "../validation.ts";

export class OpenAiProvider implements EncounterInterpreterProvider {
  name = "openai";
  model: string;
  private apiKey: string;

  constructor(apiKey: string, model: string = "gpt-5.6-luna") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async interpret(params: {
    message: string;
    currentDraft?: Record<string, unknown>;
    systemPrompt: string;
    jsonSchema: Record<string, unknown>;
  }): Promise<ProviderInterpretationResult> {
    const url = "https://api.openai.com/v1/chat/completions";

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
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content returned by OpenAI API");
    }

    const rawParsed = JSON.parse(content);
    const patch = cleanNullProperties(rawParsed);
    const usage = data.usage || {};

    return {
      patch,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      rawResponse: content
    };
  }
}

