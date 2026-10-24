/**
 * Tipos de dominio para el Cierre Posterior de Encuentros y Registro de Asistencia Efectiva (Mini-Sprint A).
 */

export type PostEventClosureStatus =
  | 'not_applicable'
  | 'pending'
  | 'completed'
  | 'overdue'
  | 'auto_closed';

export type PostEventRealizationStatus =
  | 'realized'
  | 'not_realized'
  | 'unconfirmed';

export type PostEventClosureType =
  | 'within_deadline'
  | 'overdue'
  | 'administrative_auto';

export type AttendanceStatus =
  | 'unmarked'
  | 'attended'
  | 'advance_notice_absent'
  | 'reported_absent'
  | 'unverified';

export interface ParticipantAttendanceItem {
  participante_id: string;
  status: AttendanceStatus;
  notes?: string | null;
}

export interface ParticipantClosureDetail {
  id: string;
  nombre_invitado: string;
  seat_count: number;
  user_id: string | null;
  tipo_invitacion: string;
  reconfirmation_status: string;
  attendance_status: AttendanceStatus;
  attendance_notes?: string | null;
  is_multi_seat: boolean;
}

export interface DetalleCierrePostEvento {
  ok: boolean;
  encuentro_id?: string;
  titulo?: string;
  open_public_title?: string | null;
  fecha?: string | null;
  hora?: string | null;
  duration_minutes?: number | null;
  modalidad?: string;
  is_open?: boolean;
  has_started?: boolean;
  post_event_closure_status?: PostEventClosureStatus;
  post_event_realization_status?: PostEventRealizationStatus | null;
  post_event_unrealized_reason?: string | null;
  post_event_closed_at?: string | null;
  post_event_closure_deadline?: string | null;
  post_event_closure_type?: PostEventClosureType | null;
  post_event_closed_responsibly?: boolean;
  is_overdue?: boolean;
  confirmed_seats_count?: number;
  has_confirmed_participants?: boolean;
  participantes?: ParticipantClosureDetail[];
  error?: string;
}

export interface CerrarPostEventoPayload {
  encuentroId: string;
  realizationStatus: PostEventRealizationStatus;
  unrealizedReason?: string | null;
  asistencias?: ParticipantAttendanceItem[];
}

export interface CerrarPostEventoResult {
  ok: boolean;
  encuentro_id?: string;
  post_event_closure_status?: PostEventClosureStatus;
  post_event_realization_status?: PostEventRealizationStatus;
  closure_type?: PostEventClosureType;
  closed_responsibly?: boolean;
  attendees_count?: number;
  reported_absent_count?: number;
  advance_notice_absent_count?: number;
  unverified_count?: number;
  error?: string;
  message?: string;
}

export interface PendingClosureItem {
  id: string;
  titulo: string;
  open_public_title?: string | null;
  fecha: string | null;
  hora: string | null;
  duration_minutes?: number | null;
  closure_deadline: string | null;
  is_overdue: boolean;
  post_event_closure_status: PostEventClosureStatus;
  confirmed_count: number;
}

export interface PendingClosuresResponse {
  ok: boolean;
  pending_closures: PendingClosureItem[];
  error?: string;
}
