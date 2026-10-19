export type EncounterTemplateDateMode = 'fixed' | 'coordination';

export type ResponseVisibility = 'hidden' | 'summary' | 'detail';

/**
 * Configuración reutilizable (whitelist construida en el servidor).
 * Nunca contiene ids, tokens, fechas concretas, respuestas ni estados.
 */
export interface EncounterTemplateConfig {
  titulo: string;
  descripcion?: string | null;
  modalidad: 'presencial' | 'virtual';
  lugar_texto?: string | null;
  link_virtual?: string | null;
  tipo_invitacion?: 'individual' | 'link_general' | null;
  tema?: string | null;
  tema_invitacion?: string | null;
  invitation_template?: string | null;
  /** HH:MM — solo encuentros de fecha fija */
  hora?: string | null;
  /** Solo coordinación */
  duration_minutes?: number | null;
  mostrar_respuestas_a_invitados?: boolean | null;
  visibilidad_respuestas_invitados?: ResponseVisibility | null;
}

/** Modalidad elegida por el organizador al guardar o repetir. */
export type ReuseMode = 'template_only' | 'template_with_guests';

/** Carga común (desde un encuentro propio o desde un favorito) para precargar un wizard. */
export interface ReusablePayload {
  origen: 'encuentro' | 'plantilla';
  id?: string;
  nombre?: string;
  date_mode: EncounterTemplateDateMode;
  config: EncounterTemplateConfig;
  /** Cantidad de invitados recuperables (siempre disponible). */
  invitados_count: number;
  /** Correos: solo se llenan si se solicitó la modalidad con invitados. */
  invitados: string[];
}

export interface EncounterTemplateSummary {
  id: string;
  nombre: string;
  date_mode: EncounterTemplateDateMode;
  titulo?: string | null;
  modalidad?: 'presencial' | 'virtual' | null;
  invitados_count: number;
  created_at: string;
  updated_at: string;
}

export type EncounterTemplateErrorCode =
  | 'not_authenticated'
  | 'anonymous_user_not_allowed'
  | 'invalid_template_name'
  | 'template_name_taken'
  | 'template_limit_reached'
  | 'template_not_found'
  | 'encuentro_not_found_or_not_owner'
  | 'rate_limit_exceeded'
  | 'unknown_error';

export interface TemplateServiceResult<T = Record<string, never>> {
  ok: boolean;
  error?: EncounterTemplateErrorCode | string;
  data?: T;
}
