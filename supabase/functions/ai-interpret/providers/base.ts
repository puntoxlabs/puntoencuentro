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
  }): Promise<ProviderInterpretationResult>;
}
