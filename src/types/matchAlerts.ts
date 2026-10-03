/**
 * Tipos y DTOs para el sistema de suscripciones de alerta 'Avisame' (Fase 2A).
 * Matching determinístico sin IA y administración segura de alertas.
 */

export type MatchAlertStatus = 'active' | 'paused' | 'expired' | 'cancelled';
export type MatchAlertModalidad = 'presencial' | 'virtual' | 'indistinto';

export const PENDING_AVISAME_DRAFT_KEY = 'puntoencuentro_pending_avisame_draft';

export interface MatchAlertSubscription {
  id: string;
  userId: string;
  status: MatchAlertStatus;
  effectiveStatus?: MatchAlertStatus;
  modalidad: MatchAlertModalidad | null;
  localityId: string | null;
  localityNombre?: string | null;
  fechaDesde: string | null;
  fechaHasta: string | null;
  horaDesde: string | null;
  horaHasta: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrearAlertaParams {
  modalidad?: MatchAlertModalidad | null;
  localityId?: string | null;
  fechaDesde?: string | null;
  fechaHasta?: string | null;
  horaDesde?: string | null;
  horaHasta?: string | null;
  expiresAt?: string | null;
}

export interface CrearAlertaResponse {
  ok: boolean;
  subscription?: MatchAlertSubscription;
  error?: string;
}

export interface GetMisAlertasResponse {
  ok: boolean;
  subscriptions: MatchAlertSubscription[];
  error?: string;
}

export interface AlertaLifecycleResponse {
  ok: boolean;
  id?: string;
  status?: MatchAlertStatus;
  error?: string;
}
