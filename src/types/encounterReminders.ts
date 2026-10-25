/**
 * Tipos de dominio para Recordatorios y Prevención de Inasistencias (Mini-Sprint E).
 */

export type ReminderType = 'reminder_24h' | 'reminder_2h';
export type ReminderStatus = 'sent' | 'failed' | 'invalidated' | 'suppressed_quiet_hours';

export interface EncounterReminderItem {
  id: string;
  reminder_type: ReminderType;
  sent_at: string;
  status: ReminderStatus;
  scheduled_for_date: string;
  scheduled_for_time: string;
}

export interface EncounterRemindersResponse {
  ok: boolean;
  encuentro_id?: string;
  reminders?: EncounterReminderItem[];
  error?: string;
}

export interface ProcessRemindersResponse {
  ok: boolean;
  reminders_24h_sent?: number;
  reminders_2h_sent?: number;
  suppressed_quiet_hours?: number;
  skipped?: number;
  processed_at?: string;
  status?: string;
  message?: string;
  error?: string;
}
