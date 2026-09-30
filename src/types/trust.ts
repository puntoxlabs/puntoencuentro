/**
 * Tipos de dominio para Ficha Factual de Actividad del Solicitante (Fase 2.0-C1 T1).
 * Modelo estructurado, sanitizado y no opinable.
 */

export interface PerfilConfianzaSolicitante {
  member_since_month: string | null; // Formato "YYYY-MM", ej. "2026-08"
  approved_open_encounters_previous: number;
  hosted_open_encounters_previous: number;
  no_prior_open_history: boolean;
}

export interface PerfilConfianzaResult {
  ok: boolean;
  data?: PerfilConfianzaSolicitante;
  error?: string;
}

/**
 * Contextos de reporte disponibles en la plataforma.
 */
export type ContextoReporte = 'pre_solicitud' | 'post_encuentro';

/**
 * Motivos permitidos en pre_solicitud (exclusivamente 3).
 */
export type MotivoReportePre =
  | 'commercial_spam'
  | 'inappropriate_behavior'
  | 'safety_concern';

/**
 * Motivos permitidos en post_encuentro.
 */
export type MotivoReportePost =
  | 'inappropriate_behavior'
  | 'commercial_spam'
  | 'safety_concern'
  | 'other';

export interface CrearReporteParams {
  solicitudId: string;
  contexto: ContextoReporte;
  motivo: MotivoReportePre | MotivoReportePost;
  detalle?: string | null;
}

export interface CrearReporteResult {
  ok: boolean;
  estado?: 'pending';
  error?: string;
}

/**
 * Estado contextual de bloqueo para la UI (Fase 2.0-C1 T3-B).
 * Exclusivamente refleja si el usuario autenticado bloqueó a la contraparte.
 */
export interface ContextualBlockState {
  ok: boolean;
  blockedByMe: boolean;
  error?: string;
}

/**
 * Resultado de acción de bloqueo o desbloqueo contextual.
 */
export interface ContextualBlockActionResult {
  ok: boolean;
  blocked: boolean;
  error?: string;
}
