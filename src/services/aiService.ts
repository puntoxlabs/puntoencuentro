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
  scope?: 'encounter' | 'off_topic' | 'unclear';
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

export const CLIENT_AI_TIMEOUT_MS = 25000;

export const aiService = {
  /**
   * Invokes the Supabase Edge Function `ai-interpret` to extract an EncounterDraftPatch.
   * Enforces a client-side timeout via AbortController and guarantees controlled error classification.
   */
  async interpretMessage(
    message: string,
    currentDraft?: EncounterDraft,
    sessionId?: string,
    customTimeoutMs: number = CLIENT_AI_TIMEOUT_MS
  ): Promise<AiInterpretationResponse> {
    const startTime = Date.now();
    const controller = new AbortController();
    let isTimedOut = false;

    console.log('[aiService] requestStarted:', {
      hasMessage: Boolean(message),
      messageLength: message?.length,
      hasCurrentDraft: Boolean(currentDraft),
      hasSessionId: Boolean(sessionId),
      timeoutMs: customTimeoutMs,
    });

    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, customTimeoutMs);

    let logResult: string = 'unknown';

    try {
      console.log('[aiService] invokeStarted');
      const { data, error } = await supabase.functions.invoke('ai-interpret', {
        body: {
          message: message.trim(),
          currentDraft,
          sessionId,
        },
        signal: controller.signal,
        timeout: customTimeoutMs,
      });

      console.log('[aiService] invokeResolved:', {
        dataPresent: Boolean(data),
        errorPresent: Boolean(error),
        errorName: error?.name,
        errorMessage: error?.message,
      });

      if (error) {
        console.warn('[aiService] Edge Function invoke error:', error);

        // 1. Client-side timeout / abort
        if (
          isTimedOut ||
          controller.signal.aborted ||
          (error as any)?.context?.name === 'AbortError' ||
          error.name === 'AbortError'
        ) {
          logResult = 'timeout_client';
          return {
            ok: false,
            error: 'timeout_client',
            details: 'No pude procesar el mensaje a tiempo. Podés intentar nuevamente o continuar manualmente.',
          };
        }

        // 2. Parse status code and error body if present
        let errorBody: any = null;
        let statusCode: number | undefined = undefined;
        try {
          if (typeof (error as any).context?.json === 'function') {
            errorBody = await (error as any).context.json();
          }
          if ((error as any).context?.status) {
            statusCode = (error as any).context.status;
          }
        } catch (_) {}

        // HTTP 429 Rate limiting / Session limits
        if (
          statusCode === 429 ||
          errorBody?.error === 'rate_limit_exceeded' ||
          errorBody?.error === 'session_limit_reached' ||
          errorBody?.error === 'session_locked_off_topic'
        ) {
          logResult = 'http_429';
          return {
            ok: false,
            error: errorBody?.error || 'rate_limit_exceeded',
            details:
              errorBody?.message ||
              'Alcanzaste el límite de consultas permitidas. Podés continuar manualmente.',
          };
        }

        // HTTP 503 Service unavailable / Rate limit RPC offline
        if (statusCode === 503 || errorBody?.error === 'rate_limit_unavailable') {
          logResult = 'http_503';
          return {
            ok: false,
            error: errorBody?.error || 'rate_limit_unavailable',
            details:
              errorBody?.message ||
              'El servicio de IA no está disponible temporalmente. Podés continuar manualmente.',
          };
        }

        if (errorBody?.error === 'input_too_long') {
          logResult = 'invalid_response';
          return {
            ok: false,
            error: 'input_too_long',
            details:
              errorBody.message ||
              'El mensaje es demasiado largo. Contame brevemente qué querés organizar o cambiar.',
          };
        }

        // Network failure
        const isNetworkError =
          error.name === 'FunctionsFetchError' ||
          (error as any).context instanceof TypeError ||
          /failed to fetch|network|load failed/i.test(error.message || '');

        if (isNetworkError) {
          logResult = 'network_error';
          return {
            ok: false,
            error: 'network_error',
            details:
              'No pudimos conectarnos con Crear con IA. Revisá tu conexión e intentá nuevamente.',
          };
        }

        if (errorBody?.message) {
          logResult = 'provider_error';
          return {
            ok: false,
            error: errorBody.error || 'service_error',
            details: errorBody.message,
          };
        }

        logResult = 'http_503';
        return {
          ok: false,
          error: 'service_unavailable',
          details:
            'No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.',
        };
      }

      // Check data structure
      if (!data || typeof data !== 'object') {
        logResult = 'invalid_response';
        return {
          ok: false,
          error: 'invalid_response',
          details:
            'Respuesta inesperada del servicio de IA. Podés intentar nuevamente o continuar manualmente.',
        };
      }

      if (data.ok === false) {
        logResult = 'provider_error';
        return {
          ok: false,
          error: data?.error || 'interpretation_failed',
          details:
            data?.message ||
            data?.details ||
            'No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.',
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

      if (!data.patch || typeof data.patch !== 'object') {
        logResult = 'invalid_response';
        return {
          ok: false,
          error: 'invalid_response',
          details:
            'Respuesta inesperada del servicio de IA. Podés intentar nuevamente o continuar manualmente.',
        };
      }

      logResult = 'success';
      return {
        ok: true,
        scope: data.scope || (data.patch as any)?.scope || 'encounter',
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
    } catch (err: any) {
      console.warn('[aiService] catch error:', {
        name: err?.name,
        message: err?.message,
        constructor: err?.constructor?.name,
      });
      if (
        isTimedOut ||
        controller.signal.aborted ||
        err?.name === 'AbortError' ||
        err?.message?.includes('aborted')
      ) {
        logResult = 'timeout_client';
        return {
          ok: false,
          error: 'timeout_client',
          details: 'No pude procesar el mensaje a tiempo. Podés intentar nuevamente o continuar manualmente.',
        };
      }

      const isNetwork =
        err?.name === 'FunctionsFetchError' ||
        err instanceof TypeError ||
        /failed to fetch|network|load failed/i.test(err?.message || '');

      if (isNetwork) {
        logResult = 'network_error';
        return {
          ok: false,
          error: 'network_error',
          details:
            'No pudimos conectarnos con Crear con IA. Revisá tu conexión e intentá nuevamente.',
        };
      }

      logResult = 'invalid_response';
      return {
        ok: false,
        error: 'invalid_response',
        details:
          'Ocurrió un error inesperado al conectar con el servicio. Podés intentar nuevamente o continuar manualmente.',
      };
    } finally {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;
      console.log('[aiService] Request completed:', {
        durationMs,
        result: logResult,
      });
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

