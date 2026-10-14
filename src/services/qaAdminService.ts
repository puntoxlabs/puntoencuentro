import { supabase } from '../lib/supabase';

// ============================================================
// Tipos de Datos (Contrato Estricto con Backend)
// ============================================================

export interface QADashboardMetrics {
  ok: boolean;
  period_days: number;
  total_sessions: number;
  completed_sessions: number;
  abandoned_sessions: number;
  probable_abandonment_heuristic_minutes: number;
  cancelled_sessions: number;
  conversion_rate: number;
  ai_sessions: number;
  manual_sessions: number;
  fixed_encounters: number;
  coordination_encounters: number;
  deterministic_events: number;
  llm_events: number;
  fallback_events: number;
  clarification_events: number;
  avg_latency_ms: number;
  p90_latency_ms: number;
}

export interface QASession {
  id: string;
  creation_source: 'ai' | 'manual';
  initial_route: string;
  status: 'started' | 'completed' | 'cancelled';
  date_mode: 'fixed' | 'coordination' | null;
  encounter_id: string | null;
  turns: number;
  elapsed_ms: number;
  frontend_version: string | null;
  edge_version: string | null;
  created_at: string;
  completed_at: string | null;
  last_event_at: string;
  is_problematic: boolean;
  needs_review: boolean;
}

export interface QASessionsResponse {
  ok: boolean;
  total: number;
  limit: number;
  offset: number;
  sessions: QASession[];
}

export interface QASessionDetail {
  id: string;
  creation_source: 'ai' | 'manual';
  initial_route: string;
  status: 'started' | 'completed' | 'cancelled';
  date_mode: 'fixed' | 'coordination' | null;
  encounter_id: string | null;
  turns: number;
  elapsed_ms: number;
  frontend_version: string | null;
  edge_version: string | null;
  created_at: string;
  completed_at: string | null;
  last_event_at: string;
}

export interface QATimelineEvent {
  id: number;
  turn_number: number;
  event_type: 'session_started' | 'turn_resolved' | 'clarification_requested' | 'provider_fallback' | 'technical_error' | 'encounter_created' | 'session_cancelled';
  source: 'deterministic' | 'llm_openai' | 'llm_mistral' | 'ui_manual' | 'system';
  operation: string | null;
  result: 'success' | 'needs_clarification' | 'technical_error' | 'off_topic' | 'unclear' | 'cancelled' | null;
  provider: string | null;
  fallback_used: boolean;
  latency_ms: number | null;
  fields_changed: string[] | null;
  metadata: Record<string, any>; // Whitelisted by backend: ambiguity_type, ambiguity_reason, error_code, input_length, resolver, action_status, turn_intent
  created_at: string;
}

export interface QASessionTimelineResponse {
  ok: boolean;
  session: QASessionDetail;
  events: QATimelineEvent[];
}

// ============================================================
// Funciones de Lectura (Read-only, Admin/QA)
// ============================================================

/**
 * Timeout defensivo para la verificación de autorización QA (en ms).
 */
export const QA_AUTH_TIMEOUT_MS = 6000;

/**
 * Verifica si el usuario actual tiene permisos de QA.
 * Aplica timeout defensivo configurable para evitar que la UI quede congelada.
 */
export const checkQAAuthorization = async (timeoutMs: number = QA_AUTH_TIMEOUT_MS): Promise<boolean> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('qa_auth_timeout'));
      }, timeoutMs);
    });

    const rpcPromise = (async () => {
      const { data, error } = await supabase.rpc('is_qa_authorized');
      if (error) throw error;
      return data === true;
    })();

    const result = await Promise.race([rpcPromise, timeoutPromise]);
    return result;
  } catch (error: any) {
    if (error?.message === 'qa_auth_timeout') {
      console.warn(`[qaAdminService] QA Authorization check timed out after ${timeoutMs}ms`);
      throw error;
    }
    console.error('[qaAdminService] QA Authorization check failed:', error);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

/**
 * Obtiene métricas agregadas del panel de QA.
 */
export const getQADashboardMetrics = async (days: number = 7): Promise<QADashboardMetrics> => {
  const { data, error } = await supabase.rpc('get_qa_dashboard_metrics', { p_days: days });
  if (error) throw error;
  if (!data?.ok) throw new Error('Failed to fetch dashboard metrics');
  return data as QADashboardMetrics;
};

/**
 * Obtiene listado paginado de sesiones de creación con flags de fricción y abandono pre-calculados.
 */
export const getQASessions = async (
  days: number = 7,
  status: 'started' | 'completed' | 'cancelled' | null = null,
  source: 'ai' | 'manual' | null = null,
  limit: number = 50,
  offset: number = 0
): Promise<QASessionsResponse> => {
  const { data, error } = await supabase.rpc('get_qa_sessions', {
    p_days: days,
    p_status: status,
    p_source: source,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  if (!data?.ok) throw new Error('Failed to fetch sessions');
  return data as QASessionsResponse;
};

/**
 * Obtiene el detalle y la línea de tiempo (eventos) de una sesión específica.
 */
export const getQASessionTimeline = async (sessionId: string): Promise<QASessionTimelineResponse> => {
  const { data, error } = await supabase.rpc('get_qa_session_timeline', {
    p_session_id: sessionId,
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(`Failed to fetch timeline for session ${sessionId}`);
  return data as QASessionTimelineResponse;
};

// ============================================================
// Diagnóstico y Prueba Web Push (Fase QA / Staging)
// ============================================================

export interface QAPushTestResponse {
  ok: boolean;
  inbox_notification_id?: string;
  active_devices_count?: number;
  outbox_id?: string;
  outbox_status?: string;
  endpoint_origin?: string;
  created_at?: string;
  error?: string;
  message?: string;
}

export interface QAPushDeliveryItem {
  outbox_id: string;
  status: 'pending' | 'processing' | 'delivered' | 'retry' | 'failed' | 'cancelled';
  attempt_count: number;
  created_at: string;
  processing_started_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  endpoint_origin: string | null;
  subscription_status: string;
  device_last_seen: string | null;
}

export interface QAPushDeliveryStatusResponse {
  ok: boolean;
  inbox_notification_id?: string;
  deliveries?: QAPushDeliveryItem[];
  error?: string;
}

/**
 * Dispara una notificación push de prueba hacia los dispositivos activos del operador QA.
 * Utiliza el pipeline canónico completo (Inbox -> Outbox -> Worker).
 */
export const sendQAPushTest = async (): Promise<QAPushTestResponse> => {
  const { data, error } = await supabase.rpc('enviar_qa_web_push_prueba_seguro');
  if (error) throw error;
  return data as QAPushTestResponse;
};

/**
 * Consulta el estado y trazabilidad del outbox para una notificación de prueba de QA.
 */
export const getQAPushDeliveryStatus = async (
  inboxNotificationId: string
): Promise<QAPushDeliveryStatusResponse> => {
  const { data, error } = await supabase.rpc('get_qa_web_push_delivery_status_seguro', {
    p_inbox_notification_id: inboxNotificationId,
  });
  if (error) throw error;
  return data as QAPushDeliveryStatusResponse;
};
