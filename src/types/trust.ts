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
