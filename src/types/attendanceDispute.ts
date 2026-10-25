/**
 * Tipos de dominio para Controversias de Asistencia, Derecho a Respuesta y Moderación Humana (Mini-Sprint C).
 */

export type AttendanceDisputeType =
  | 'absence_reported'
  | 'encounter_not_realized'
  | 'host_no_show'
  | 'closure_data_error';

export type RealizationDisputeMotivo =
  | 'encounter_not_realized'
  | 'host_no_show'
  | 'closure_data_error';

export type AttendanceDisputeStatus =
  | 'awaiting_response'
  | 'response_received'
  | 'in_human_review'
  | 'confirmed_by_participant'
  | 'resolved_justified'
  | 'resolved_unjustified'
  | 'resolved_registration_error'
  | 'dismissed_insufficient_evidence'
  | 'rectified'
  | 'unverified_timeout';

export type AttendanceDisputeResponseDecision =
  | 'accept_absence'
  | 'notified_prior'
  | 'force_majeure'
  | 'attended_present'
  | 'request_human_review';

export type AttendanceDisputeResolution =
  | 'justified'
  | 'confirmed'
  | 'registration_error'
  | 'insufficient_evidence'
  | 'rectified';

export interface AttendanceDisputeItem {
  id: string;
  encuentro_id: string;
  encuentro_title?: string;
  encuentro_fecha?: string;
  encuentro_hora?: string;
  encuentro_modalidad?: string;
  participante_id?: string | null;
  participante_nombre?: string | null;
  host_id?: string;
  host_nombre?: string | null;
  tipo_controversia: AttendanceDisputeType;
  estado: AttendanceDisputeStatus;
  descargo_tipo?: AttendanceDisputeResponseDecision | string | null;
  descargo_texto?: string | null;
  descargo_en?: string | null;
  explicacion_contraparte?: string | null;
  explicacion_contraparte_en?: string | null;
  plazo_respuesta_vence_en: string;
  resolucion_tipo?: AttendanceDisputeResolution | 'accepted_by_user' | null;
  resolucion_fundamentacion?: string | null;
  resuelto_en?: string | null;
  created_at: string;
  is_initiator?: boolean;
  is_involved?: boolean;
  can_respond?: boolean;
  has_conflict_of_interest?: boolean;
  iniciado_por?: string;
  involucrado_id?: string;
}

export interface AttendanceDisputeDetail extends AttendanceDisputeItem {
  attendance_status?: string;
  auditoria?: Array<{
    accion: string;
    estado_anterior?: string | null;
    estado_nuevo: string;
    notas?: string | null;
    created_at: string;
  }>;
}

import type { ContextoFactual, TrayectoriaAnfitrion, TrayectoriaParticipante } from './factualTrajectory';

export interface FactualAttendanceHistory {
  ok: boolean;
  user_id?: string;
  total_encuentros_participados: number;
  asistencias_declaradas_host?: number;
  asistencias_declaradas: number;
  asistencias_verificadas: number;
  inasistencias_reportadas_pendientes: number;
  inasistencias_reconocidas: number;
  inasistencias_moderadas: number;
  registros_no_verificados?: number;
  reportes_rectificados_o_desestimados: number;
  controversias_organizador_recibidas: number;
  reclamos_no_realizacion_recibidos?: number;
  reclamos_ausencia_anfitrion_recibidos?: number;
  reclamos_error_cierre_recibidos?: number;
  controversias_organizador_iniciadas: number;
  contexto_factual?: ContextoFactual;
  trayectoria_anfitrion?: TrayectoriaAnfitrion;
  trayectoria_participante?: TrayectoriaParticipante;
  error?: string;
}

export interface DisputeQueueResponse {
  ok: boolean;
  queue: AttendanceDisputeItem[];
  error?: string;
}
