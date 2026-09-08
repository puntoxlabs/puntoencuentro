import type { EncounterInterpreterProvider, ProviderInterpretationResult } from "./base.ts";
import { sanitizeSchemaForDeepSeek, cleanNullProperties, validatePatchOutput } from "../validation.ts";

export class DeepSeekProvider implements EncounterInterpreterProvider {
  name = "deepseek";
  model: string;
  private apiKey: string;

  constructor(apiKey: string, model: string = "deepseek-v4-flash") {
    if (!apiKey) {
      throw new Error("Missing DEEPSEEK_API_KEY");
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  async interpret(params: {
    message: string;
    currentDraft?: Record<string, unknown>;
    systemPrompt: string;
    jsonSchema: Record<string, unknown>;
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
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;

    if (!rawContent || rawContent.trim() === "") {
      throw new Error("Empty or missing content returned by DeepSeek API");
    }

    // Strip markdown code fences if present (e.g. ```json ... ```)
    const cleanedContent = rawContent.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();

    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(cleanedContent);
    } catch (parseErr) {
      throw new Error(`Failed to parse JSON response from DeepSeek: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }

    if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
      throw new Error("DeepSeek response must be a valid JSON object");
    }

    const patch = cleanNullProperties(rawParsed as Record<string, unknown>);

    // Local deterministic schema validation against EncounterDraftPatch
    const validation = validatePatchOutput(patch);
    if (!validation.valid) {
      throw new Error(`DeepSeek response does not conform to EncounterDraftPatch schema: ${validation.error}`);
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
