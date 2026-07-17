import { supabase } from '@/lib/supabase';
import { validateEncounterDate } from '@/lib/formatDate';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { resolveInvitationTemplateForTheme } from '@/lib/invitationThemes';
import { isValidDateTime } from '@/lib/argentinaDateTime';

export interface CreateEncuentroDTO {
  titulo: string;
  descripcion?: string;
  fecha: string;
  hora: string;
  modalidad: 'presencial' | 'virtual';
  lugar_texto?: string;
  link_virtual?: string;
  tipo_invitacion: 'individual' | 'link_general';
  host_id: string;
  tema?: string;
  tema_invitacion?: InvitationTheme;
  invitation_template?: string | null;
  reemplaza_a?: string | null;
}

export interface CoordinationCreatePayload {
  titulo: string;
  descripcion?: string | null;
  modalidad: 'presencial' | 'virtual';
  lugar_texto?: string | null;
  link_virtual?: string | null;
  tipo_invitacion: 'individual' | 'link_general';
  tema?: string | null;
  tema_invitacion?: string | null;
  invitation_template?: string | null;
  response_deadline?: string | null;
}

export interface CoordinationOptionPayload {
  fecha: string;
  hora_inicio: string;
}

export type CoordinationDateMode = 'coordination';
export type CoordinationStatus = 'open' | 'closed';

export interface CoordinationCreatedEncounter {
  id: string;
  public_token: string;
  date_mode: 'coordination';
  coordination_status: 'open';
  response_deadline: string | null;
}

export interface CoordinationCreatedOption {
  id: string;
  fecha: string;
  hora_inicio: string;
  orden: number;
}

export type CoordinationCreateResult =
  | {
      ok: true;
      encuentro: CoordinationCreatedEncounter;
      opciones: CoordinationCreatedOption[];
    }
  | {
      ok: false;
      error: string;
    };

export type CoordinationAvailabilityValue = 'available' | 'maybe' | 'unavailable';

export interface CoordinationAvailabilityInput {
  opcion_fecha_id: string;
  respuesta: CoordinationAvailabilityValue;
  es_preferida: boolean;
}

export interface CoordinationOption {
  id: string;
  fecha: string;
  hora_inicio: string;
  orden: number;
  selected: boolean;
}

export interface CoordinationParticipantResponse {
  opcion_fecha_id: string;
  respuesta: CoordinationAvailabilityValue;
  es_preferida: boolean;
}

export type CoordinationPublicReadResult =
  | {
      ok: true;
      encuentro: {
        id: string;
        titulo: string;
        descripcion: string | null;
        estado: string;
        modalidad: string;
        lugar_texto: string | null;
        tema: string | null;
        tipo_invitacion: string;
        tema_invitacion: string;
        invitation_template: string | null;
        duration_minutes: number | null;
      };
      coordination_status: 'open' | 'closed';
      response_deadline: string | null;
      selected_option_id: string | null;
      fecha: string | null;
      hora: string | null;
      derived_status: 'open' | 'closed' | 'deadline_passed';
      opciones: CoordinationOption[];
    }
  | {
      ok: false;
      error: string;
    };

export type CoordinationParticipantReadResult =
  | {
      ok: true;
      encuentro: {
        id: string;
        titulo: string;
        descripcion: string | null;
        estado: string;
        modalidad: string;
        lugar_texto: string | null;
        tema: string | null;
        tipo_invitacion: string;
        tema_invitacion: string;
        invitation_template: string | null;
        duration_minutes: number | null;
      };
      participante: {
        id: string;
        nombre_invitado: string;
        tipo_invitacion: string;
        estado: string;
        mensaje_respuesta: string | null;
        respondio_disponibilidad: boolean;
      };
      coordination_status: 'open' | 'closed';
      response_deadline: string | null;
      selected_option_id: string | null;
      fecha: string | null;
      hora: string | null;
      derived_status: 'open' | 'closed' | 'deadline_passed';
      opciones: CoordinationOption[];
      mis_respuestas: CoordinationParticipantResponse[];
    }
  | {
      ok: false;
      error: string;
    };

export type CoordinationPublicWriteResult =
  | {
      ok: true;
      token_invitacion: string;
    }
  | {
      ok: false;
      error: string;
    };

export type CoordinationParticipantWriteResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };


function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRpcJson(value: unknown): unknown | null {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCoordinationStatus(value: unknown): value is CoordinationStatus {
  return value === 'open' || value === 'closed';
}

function isCoordinationDerivedStatus(value: unknown): value is 'open' | 'closed' | 'deadline_passed' {
  return value === 'open' || value === 'closed' || value === 'deadline_passed';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = parseInt(value.substring(0, 4), 10);
  const month = parseInt(value.substring(5, 7), 10);
  const day = parseInt(value.substring(8, 10), 10);
  if (month < 1 || month > 12) return false;
  const dateObj = new Date(year, month - 1, day);
  return dateObj.getFullYear() === year && dateObj.getMonth() === month - 1 && dateObj.getDate() === day;
}

function isValidPostgresTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(?:\.\d+)?)?$/.test(value);
}

function isValidIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function isValidDurationMinutes(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 15 && value <= 1440;
}

function normalizeCoordinationResponses(value: unknown, validOptionIds?: Set<string>): CoordinationAvailabilityInput[] | null {
  if (!Array.isArray(value)) return null;
  const resps: CoordinationAvailabilityInput[] = [];
  let preferredCount = 0;
  const seenResponseOptionIds = new Set<string>();
  
  for (const resp of value) {
    if (!isUnknownRecord(resp)) return null;
    if (!isNonEmptyString(resp.opcion_fecha_id)) return null;
    if (validOptionIds && !validOptionIds.has(resp.opcion_fecha_id)) return null;
    if (seenResponseOptionIds.has(resp.opcion_fecha_id)) return null;
    seenResponseOptionIds.add(resp.opcion_fecha_id);
    
    const validRes = resp.respuesta === 'available' || resp.respuesta === 'maybe' || resp.respuesta === 'unavailable';
    if (!validRes) return null;
    
    if (typeof resp.es_preferida !== 'boolean') return null;
    if (resp.respuesta === 'unavailable' && resp.es_preferida) return null;
    if (resp.es_preferida) preferredCount++;
    
    resps.push({
      opcion_fecha_id: resp.opcion_fecha_id,
      respuesta: resp.respuesta as 'available' | 'maybe' | 'unavailable',
      es_preferida: resp.es_preferida
    });
  }
  
  if (preferredCount > 1) return null;
  return resps;
}

  async crearDisponibilidadCoordinacionPublica(publicToken: string, nombre: string, respuestas: CoordinationAvailabilityInput[]): Promise<CoordinationPublicWriteResult> {
    if (!publicToken) return { ok: false, error: 'invalid_token' };
    if (!nombre || !nombre.trim()) return { ok: false, error: 'invalid_name' };

    const normResps = normalizeCoordinationResponses(respuestas);
    if (!normResps) return { ok: false, error: 'invalid_responses' };

    const { data, error } = await supabase.rpc('crear_disponibilidad_coordinacion_publica_seguro', {
      p_public_token: publicToken,
      p_nombre: nombre.trim(),
      p_respuestas: normResps
    });

    if (error) {
      return { ok: false, error: 'rpc_error' };
    }

    const result: unknown = parseRpcJson(data);
    if (!isUnknownRecord(result)) return { ok: false, error: 'invalid_response_format' };

    if (result.ok === false) {
      return { ok: false, error: typeof result.error === 'string' ? result.error : 'unknown_error' };
    }

    if (result.ok !== true) return { ok: false, error: 'invalid_response_format' };
    
    if (!isNonEmptyString(result.encuentro_id)) return { ok: false, error: 'invalid_response_format' };
    if (!isUuid(result.token_invitacion)) return { ok: false, error: 'invalid_response_format' };
    
    if (!isUnknownRecord(result.participante)) return { ok: false, error: 'invalid_response_format' };
    const part = result.participante;
    if (!isNonEmptyString(part.id)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(part.nombre_invitado)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(part.tipo_invitacion)) return { ok: false, error: 'invalid_response_format' };
    
    if (result.respondio_disponibilidad !== true) return { ok: false, error: 'invalid_response_format' };
    
    const retResps = normalizeCoordinationResponses(result.mis_respuestas);
    if (!retResps || retResps.length !== normResps.length) return { ok: false, error: 'invalid_response_format' };
    
    const reqIds = new Set(normResps.map(r => r.opcion_fecha_id));
    for (const r of retResps) {
      if (!reqIds.has(r.opcion_fecha_id)) return { ok: false, error: 'invalid_response_format' };
    }

    return { ok: true, token_invitacion: result.token_invitacion as string };
  },

  async guardarDisponibilidadCoordinacionParticipante(tokenInvitacion: string, respuestas: CoordinationAvailabilityInput[]): Promise<CoordinationParticipantWriteResult> {
    if (!tokenInvitacion) return { ok: false, error: 'invalid_token' };

    const { data, error } = await supabase.rpc('guardar_disponibilidad_coordinacion_participante_seguro', {
      p_token: tokenInvitacion,
      p_respuestas: respuestas
    });

    if (error) {
      return { ok: false, error: 'rpc_error' };
    }

    const result: unknown = parseRpcJson(data);
    if (!isUnknownRecord(result)) return { ok: false, error: 'invalid_response_format' };

    if (result.ok === false) {
      return { ok: false, error: typeof result.error === 'string' ? result.error : 'unknown_error' };
    }

    if (result.ok !== true) return { ok: false, error: 'invalid_response_format' };
    if (typeof result.encuentro_id !== 'string') return { ok: false, error: 'invalid_response_format' };
    if (typeof result.participante_id !== 'string') return { ok: false, error: 'invalid_response_format' };
    if (result.respondio_disponibilidad !== true) return { ok: false, error: 'invalid_response_format' };
    if (!Array.isArray(result.mis_respuestas)) return { ok: false, error: 'invalid_response_format' };

    return { ok: true };
  }
};
