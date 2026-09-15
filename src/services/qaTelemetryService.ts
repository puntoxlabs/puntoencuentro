import { supabase } from '@/lib/supabase';

// Key used in sessionStorage
const SESSION_STORAGE_KEY = 'pe-qa-creation-session-v1';

interface QaSessionContext {
  sessionId: string;
  clientToken: string;
  started?: boolean;
}

export type EventType =
  | 'session_started'
  | 'turn_resolved'
  | 'clarification_requested'
  | 'provider_fallback'
  | 'technical_error'
  | 'encounter_created'
  | 'session_cancelled';

export type EventSource = 'deterministic' | 'llm_openai' | 'llm_mistral' | 'ui_manual' | 'system';
export type EventResult = 'success' | 'needs_clarification' | 'technical_error' | 'off_topic' | 'unclear' | 'cancelled';
export type CreationSource = 'ai' | 'manual';
export type InitialRoute = '/create' | '/create/coordination' | '/create/ai';
export type SessionStatus = 'started' | 'completed' | 'cancelled';
export type DateMode = 'fixed' | 'coordination';

export interface QaTelemetryEventParams {
  event_type: EventType;
  source: EventSource;
  creation_source?: CreationSource;
  initial_route?: InitialRoute;
  turn_number?: number;
  operation?: string; // Max 60 chars
  result?: EventResult;
  provider?: string; // Max 30 chars
  fallback_used?: boolean;
  latency_ms?: number;
  fields_changed?: string[]; // Max 15 items
  metadata?: Record<string, string | number | boolean | null>;
  date_mode?: DateMode;
  encounter_id?: string;
  status?: SessionStatus;
  elapsed_ms?: number;
  frontend_version?: string;
  edge_version?: string;
}

const ALLOWED_METADATA_KEYS = new Set([
  'ambiguity_type',
  'ambiguity_reason',
  'error_code',
  'input_length',
  'resolver',
  'action_status',
  'turn_intent',
]);

class QaTelemetryService {
  private getSessionContext(): QaSessionContext {
    try {
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.warn('[QaTelemetry] Error reading session storage', e);
    }

    // Create new session if none exists
    const newSession: QaSessionContext = {
      sessionId: crypto.randomUUID(),
      // 32 hex chars (128 bits) -> fits "length must be between 16 and 128 characters"
      clientToken: Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(''),
    };

    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newSession));
    } catch (e) {
      console.warn('[QaTelemetry] Error writing session storage', e);
    }
    return newSession;
  }

  public getSessionId(): string {
    return this.getSessionContext().sessionId;
  }

  public clearSession(): void {
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) {
      // ignore
    }
  }

  private filterMetadata(raw?: Record<string, any>): Record<string, any> | undefined {
    if (!raw) return undefined;
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (ALLOWED_METADATA_KEYS.has(k)) {
        // Enforce strings max 500 chars, reject objects/arrays/functions
        if (typeof v === 'string') {
          clean[k] = v.substring(0, 500);
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          clean[k] = v;
        } else if (v === null || v === undefined) {
          // skip
        } else {
          // Strict privacy: Do NOT stringify objects or arrays. Just discard.
          console.warn(`[QaTelemetry] Discarding invalid metadata type for key: ${k}`);
        }
      }
    }
    return Object.keys(clean).length > 0 ? clean : undefined;
  }

  public trackEvent(params: QaTelemetryEventParams): void {
    // FAIL-OPEN: Capture immutable snapshot immediately to avoid race conditions with clearSession()
    const sessionCtx = this.getSessionContext();
    const { sessionId, clientToken } = sessionCtx;

    if (params.event_type === 'session_started') {
      if (sessionCtx.started) {
        return; // Already started this session across reloads
      }
      sessionCtx.started = true;
      try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionCtx));
      } catch (e) {}
    }

    const payload = {
      p_session_id: sessionId,
      p_event_type: params.event_type,
      p_source: params.source,
      p_creation_source: params.creation_source || null,
      p_initial_route: params.initial_route || null,
      p_turn_number: params.turn_number || 0,
      p_operation: params.operation ? params.operation.substring(0, 60) : null,
      p_result: params.result || null,
      p_provider: params.provider ? params.provider.substring(0, 30) : null,
      p_fallback_used: params.fallback_used || false,
      p_latency_ms: params.latency_ms || null,
      p_fields_changed: params.fields_changed ? params.fields_changed.slice(0, 15) : null,
      p_metadata: this.filterMetadata(params.metadata) || null,
      p_date_mode: params.date_mode || null,
      p_encounter_id: params.encounter_id || null,
      p_status: params.status || null,
      p_elapsed_ms: params.elapsed_ms || null,
      p_frontend_version: params.frontend_version || '1.0.0', // Provide default if not set
      p_edge_version: params.edge_version || null,
      p_client_token: clientToken,
    };

    let retryCount = 0;
    const MAX_RETRIES = 1;

    // Never block UX, run asynchronously without setTimeout wrapper for better terminal event reliability
    const send = async () => {
      try {
        const { error } = await supabase.rpc('registrar_evento_creacion', payload);
        if (error) {
          throw error;
        }
      } catch (err: any) {
        console.warn('[QaTelemetry] trackEvent error:', err);

        // PostgrestError doesn't have 'FunctionsFetchError'.
        // It has 'code' (string), and potentially network fetch error (TypeError).
        const isNetworkError = err instanceof TypeError && err.message.toLowerCase().includes('fetch');
        const isServerError = err?.code?.startsWith('5') || err?.code === '08006'; // 5xxxx are internal errors, 08006 is connection failure

        if ((isNetworkError || isServerError) && retryCount < MAX_RETRIES) {
          retryCount++;
          setTimeout(send, 1000); // 1 sec delay before retry
        }
      }
    };

    send().catch(err => {
      console.warn('[QaTelemetry] Unhandled async error:', err);
    });
  }
}

export const qaTelemetryService = new QaTelemetryService();
