import { supabase } from '@/lib/supabase';
import type { EncounterDraftPatch } from '@/lib/encounterDraftPatch';
import type { EncounterDraft } from '@/lib/encounterDraft';

export interface SessionTelemetryMetadata {
  fallbackUsed?: boolean;
  primaryProvider?: string;
  fallbackProvider?: string;
  providerUsed?: string;
  modelUsed?: string;
  primaryLatencyMs?: number;
  fallbackLatencyMs?: number;
  totalLatencyMs?: number;
  primaryFailureType?: string;
  fallbackFailureType?: string;
}

export interface AiInterpretationResponse {
  ok: boolean;
  patch?: EncounterDraftPatch;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    primaryLatencyMs?: number;
    fallbackLatencyMs?: number;
  };
  provider?: string;
  model?: string;
  fallbackUsed?: boolean;
  primaryProvider?: string;
  fallbackProvider?: string;
  primaryLatencyMs?: number;
  fallbackLatencyMs?: number;
  totalLatencyMs?: number;
  primaryFailureType?: string;
  fallbackFailureType?: string;
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
  metadata?: SessionTelemetryMetadata;
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
          details: 'No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.',
        };
      }

      if (!data || data.ok === false) {
        return {
          ok: false,
          error: data?.error || 'interpretation_failed',
          details: data?.message || data?.details || 'No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.',
          fallbackUsed: data?.fallbackUsed,
          primaryProvider: data?.primaryProvider,
          fallbackProvider: data?.fallbackProvider,
          primaryLatencyMs: data?.primaryLatencyMs,
          fallbackLatencyMs: data?.fallbackLatencyMs,
          totalLatencyMs: data?.totalLatencyMs ?? data?.latencyMs,
          primaryFailureType: data?.primaryFailureType,
          fallbackFailureType: data?.fallbackFailureType,
        };
      }

      return {
        ok: true,
        patch: data.patch as EncounterDraftPatch,
        usage: data.usage,
        provider: data.provider,
        model: data.model,
        fallbackUsed: data.fallbackUsed,
        primaryProvider: data.primaryProvider,
        fallbackProvider: data.fallbackProvider,
        primaryLatencyMs: data.primaryLatencyMs ?? data.usage?.primaryLatencyMs,
        fallbackLatencyMs: data.fallbackLatencyMs ?? data.usage?.fallbackLatencyMs,
        totalLatencyMs: data.totalLatencyMs ?? data.usage?.latencyMs,
        primaryFailureType: data.primaryFailureType,
        fallbackFailureType: data.fallbackFailureType,
      };
    } catch (err) {
      console.error('[aiService] Unexpected exception calling ai-interpret:', err);
      return {
        ok: false,
        error: 'network_error',
        details: 'No pudimos conectar con el servicio de IA en este momento. Podés continuar manualmente.',
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
      const basePayload: Record<string, any> = {
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
      };

      if (params.metadata) {
        const { error } = await supabase.rpc('registrar_sesion_ai_fin', {
          ...basePayload,
          p_metadata: params.metadata,
        });

        if (!error) return;
        console.warn('[aiService.finishSession] RPC with p_metadata error, retrying without p_metadata:', error.message);
      }

      const { error } = await supabase.rpc('registrar_sesion_ai_fin', basePayload);
      if (error) {
        console.warn('[aiService.finishSession] Telemetry warning (non-blocking):', error.message);
      }
    } catch (err) {
      console.warn('[aiService.finishSession] Non-blocking telemetry error:', err);
    }
  },
};

