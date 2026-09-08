import { supabase } from '@/lib/supabase';
import type { EncounterDraftPatch } from '@/lib/encounterDraftPatch';
import type { EncounterDraft } from '@/lib/encounterDraft';

export interface AiInterpretationResponse {
  ok: boolean;
  patch?: EncounterDraftPatch;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  provider?: string;
  model?: string;
  error?: string;
  details?: string;
}

export interface FinishAiSessionParams {
  sessionId: string;
  status: 'completed' | 'abandoned' | 'error' | 'fallback_manual';
  encounterId?: string | null;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  elapsedMs?: number;
  errorType?: string;
  provider?: string;
  model?: string;
}

export const aiService = {
  /**
   * Invokes the Supabase Edge Function `ai-interpret` to extract an EncounterDraftPatch.
   */
  async interpretMessage(
    message: string,
    currentDraft?: EncounterDraft
  ): Promise<AiInterpretationResponse> {
    try {
      const { data, error } = await supabase.functions.invoke('ai-interpret', {
        body: {
          message: message.trim(),
          currentDraft,
        },
      });

      if (error) {
        console.warn('[aiService] Edge Function invoke error:', error);
        return {
          ok: false,
          error: 'service_unavailable',
          details: error.message,
        };
      }

      if (!data || data.ok === false) {
        return {
          ok: false,
          error: data?.error || 'interpretation_failed',
          details: data?.details || data?.message,
        };
      }

      return {
        ok: true,
        patch: data.patch as EncounterDraftPatch,
        usage: data.usage,
        provider: data.provider,
        model: data.model,
      };
    } catch (err) {
      console.error('[aiService] Unexpected exception calling ai-interpret:', err);
      return {
        ok: false,
        error: 'network_error',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Minimum-privilege RPC to record AI session initiation.
   * Fails silently without blocking the user flow if telemetry table/RPC is not yet migrated.
   */
  async startSession(sessionId: string, provider?: string, model?: string): Promise<void> {
    try {
      const { error } = await supabase.rpc('registrar_sesion_ai_inicio', {
        p_session_id: sessionId,
        p_provider: provider ?? null,
        p_model: model ?? null,
      });

      if (error) {
        console.warn('[aiService.startSession] Telemetry warning (non-blocking):', error.message);
      }
    } catch (err) {
      console.warn('[aiService.startSession] Non-blocking telemetry error:', err);
    }
  },

  /**
   * Minimum-privilege RPC to record AI session completion, fallback, or error.
   */
  async finishSession(params: FinishAiSessionParams): Promise<void> {
    try {
      const { error } = await supabase.rpc('registrar_sesion_ai_fin', {
        p_session_id: params.sessionId,
        p_status: params.status,
        p_encounter_id: params.encounterId ?? null,
        p_turns: params.turns ?? null,
        p_input_tokens: params.inputTokens ?? null,
        p_output_tokens: params.outputTokens ?? null,
        p_latency_ms: params.latencyMs ?? null,
        p_elapsed_ms: params.elapsedMs ?? null,
        p_error_type: params.errorType ?? null,
        p_provider: params.provider ?? null,
        p_model: params.model ?? null,
      });

      if (error) {
        console.warn('[aiService.finishSession] Telemetry warning (non-blocking):', error.message);
      }
    } catch (err) {
      console.warn('[aiService.finishSession] Non-blocking telemetry error:', err);
    }
  },
};
