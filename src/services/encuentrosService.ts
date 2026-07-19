import { supabase } from '@/lib/supabase';
import { validateEncounterDate } from '@/lib/formatDate';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { resolveInvitationTemplateForTheme } from '@/lib/invitationThemes';

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
  duration_minutes?: number | null;
  mostrar_respuestas_a_invitados?: boolean;
}

export interface CoordinationOptionPayload {
  fecha: string;
  hora_inicio: string;
}

export type CoordinationDateMode = 'coordination';
export type CoordinationStatus = 'open' | 'closed';

// Minimal response from the creation RPC — only id and public_token are guaranteed.
// Fields like date_mode, coordination_status, response_deadline and opciones are NOT
// returned by the RPC and must not be validated here.
export interface CoordinationCreatedEncounter {
  id: string;
  public_token: string;
}

export type CoordinationCreateResult =
  | {
      ok: true;
      encuentro: CoordinationCreatedEncounter;
    }
  | {
      ok: false;
      error: string;
      details?: string;
    };

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Validates the minimal response contract from crear_encuentro_con_opciones_seguro.
// The RPC only guarantees {ok, encuentro: {id, public_token}}.
// date_mode, coordination_status, response_deadline and opciones are NOT returned by the RPC.
export function validateCoordinationCreateResult(value: unknown): CoordinationCreateResult {
  if (!isUnknownRecord(value)) {
    return { ok: false, error: 'invalid_response_format' };
  }

  const record = value;

  if (record.ok === false) {
    return {
      ok: false,
      error: typeof record.error === 'string' ? record.error : 'unknown_error',
      details: typeof record.details === 'string' ? record.details : undefined,
    };
  }

  if (record.ok === true) {
    if (!isUnknownRecord(record.encuentro)) return { ok: false, error: 'invalid_response_format' };
    const enc = record.encuentro;

    if (typeof enc.id !== 'string' || !enc.id.trim()) return { ok: false, error: 'invalid_encounter_id' };
    if (typeof enc.public_token !== 'string' || !enc.public_token.trim()) return { ok: false, error: 'invalid_public_token' };

    return {
      ok: true,
      encuentro: {
        id: enc.id as string,
        public_token: enc.public_token as string,
      },
    };
  }

  return { ok: false, error: 'invalid_response_format' };
}

export function getCoordinationCreateErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'not_authenticated':
      return 'Necesitás iniciar sesión para crear una coordinación.';
    case 'permanent_account_required':
      return 'Para coordinar fechas necesitás iniciar sesión con Google.';
    case 'invalid_data':
      return 'Revisá los datos del encuentro.';
    case 'invalid_options':
      return 'Revisá las opciones propuestas.';
    case 'minimum_two_options':
      return 'Agregá al menos dos opciones.';
    case 'maximum_three_options':
      return 'Podés proponer hasta tres opciones.';
    case 'invalid_option_date':
      return 'Revisá la fecha de las opciones.';
    case 'invalid_option_time':
      return 'Revisá el horario de las opciones.';
    case 'option_in_past':
      return 'Una de las fechas propuestas ya pasó.';
    case 'duplicate_options':
      return 'No puede haber dos opciones iguales.';
    case 'invalid_deadline':
      return 'Revisá el plazo para responder.';
    case 'deadline_in_past':
      return 'El plazo para responder debe ser futuro.';
    case 'deadline_after_first_option':
    case 'deadline_after_options':
      return 'El plazo debe ser anterior a las fechas propuestas.';
    case 'invalid_modality':
      return 'Revisá la modalidad del encuentro.';
    case 'invalid_theme':
      return 'El tema o diseño seleccionado no es válido.';
    case 'location_required':
      return 'Indicá el lugar del encuentro.';
    case 'virtual_link_required':
      return 'Indicá el enlace de la reunión.';
    case 'invalid_invitation_type':
      return 'Revisá el tipo de invitación.';
    case 'invalid_date_mode':
      return 'Este encuentro no corresponde a una coordinación.';
    case 'not_owner':
      return 'No tenés permiso para administrar este encuentro.';
    case 'invalid_duration_minutes':
      return 'La duración no es válida.';
    case 'invalid_option_order':
    case 'duplicate_option_order':
    case 'invalid_option_order_sequence':
    default:
      return 'No pudimos crear la coordinación. Intentá nuevamente.';
  }
}

export interface CoordinationHostOption {
  id: string;
  fecha: string;
  hora_inicio: string;
  orden: number;
  selected: boolean;
  available_count: number;
  maybe_count: number;
  unavailable_count: number;
  preferred_count: number;
}

export interface CoordinationHostParticipant {
  id: string;
  nombre_invitado: string;
  tipo_invitacion: string;
  estado: string;
  respondio_disponibilidad: boolean;
  respuestas: {
    opcion_fecha_id: string;
    respuesta: 'available' | 'maybe' | 'unavailable';
    es_preferida: boolean;
  }[];
}

export interface CoordinationHostDetail {
  ok: boolean;
  error?: string;
  encuentro?: {
    id: string;
    titulo: string;
    descripcion: string | null;
    estado: string;
    modalidad: string;
    lugar_texto: string | null;
    link_virtual: string | null;
    tema: string | null;
    tipo_invitacion: string;
    tema_invitacion: string;
    invitation_template: string | null;
    public_token?: string;
    duration_minutes?: number | null;
    mostrar_respuestas_a_invitados?: boolean;
  };
  coordination_status?: string;
  response_deadline?: string | null;
  selected_option_id?: string | null;
  fecha?: string | null;
  hora?: string | null;
  derived_status?: string;
  opciones?: CoordinationHostOption[];
  respondent_count?: number;
  participantes?: CoordinationHostParticipant[];
}

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
  available_count?: number;
  maybe_count?: number;
  unavailable_count?: number;
  preferred_count?: number;
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
      mostrar_respuestas_a_invitados?: boolean;
      derived_status: 'open' | 'closed' | 'deadline_passed';
      opciones: CoordinationOption[];
    }
  | {
      ok: false;
      error: string;
      failedField?: string;
      details?: string;
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
      mostrar_respuestas_a_invitados?: boolean;
      derived_status: 'open' | 'closed' | 'deadline_passed';
      opciones: CoordinationOption[];
      mis_respuestas: CoordinationAvailabilityInput[];
    }
  | {
      ok: false;
      error: string;
      failedField?: string;
      details?: string;
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


function parseRpcJson(data: unknown): unknown {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}



// Accepts null or undefined (fields omitted by some RPC versions) as null.
function isNullableString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === 'string';
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
  const seenResponseOptionIds = new Set<string>();

  let preferredCount = 0;
  for (const resp of value) {
    if (!isUnknownRecord(resp)) continue;
    if (!isNonEmptyString(resp.opcion_fecha_id)) continue;
    if (validOptionIds && !validOptionIds.has(resp.opcion_fecha_id)) continue;
    if (seenResponseOptionIds.has(resp.opcion_fecha_id)) continue;
    seenResponseOptionIds.add(resp.opcion_fecha_id);

    const rawResp = resp.respuesta ?? null;
    const validRes = rawResp === 'available' || rawResp === 'maybe' || rawResp === 'unavailable';
    if (!validRes) continue;

    const esPref = resp.es_preferida ?? false;
    if (typeof esPref !== 'boolean') continue;
    if (rawResp === 'unavailable' && esPref) continue;
    if (esPref) preferredCount++;

    resps.push({
      opcion_fecha_id: resp.opcion_fecha_id,
      respuesta: rawResp as 'available' | 'maybe' | 'unavailable',
      es_preferida: esPref
    });
  }

  if (preferredCount > 1) return null;

  return resps;
}

export const encuentrosService = {
  async createEncuentro(data: CreateEncuentroDTO) {
    const validationError = validateEncounterDate(data.fecha, data.hora);
    if (validationError) {
      throw new Error(validationError);
    }

    // RPC SECURITY DEFINER — evita bloqueo de RLS en SELECT post-INSERT
    const { data: result, error } = await supabase.rpc(
      'crear_encuentro_seguro',
      { p_data: data }
    );

    if (error) {
      console.error('Error creating encuentro (RPC):', error);
      throw error;
    }

    return result as any;
  },

  async getEncuentrosByHost(host_id: string) {
    const { data, error } = await supabase.rpc('get_encuentros_host_seguro', {
      p_host_ids: [host_id]
    });
    if (error) throw error;
    return (data as any[]) || [];
  },

  async getEncuentrosByHostIds(host_ids: string[]) {
    // Filtrar ids vacíos/null y deduplicar
    const ids = [...new Set(host_ids.filter(Boolean))];
    if (ids.length === 0) return [];

    const { data, error } = await supabase.rpc('get_encuentros_host_seguro', {
      p_host_ids: ids
    });
    if (error) throw error;
    if ((data as any)?.error) throw new Error((data as any).error);

    // Deduplicar por id (por si acaso haya solapamiento futuro)
    const seen = new Set<string>();
    return ((data as any[]) || []).filter(enc => {
      if (seen.has(enc.id)) return false;
      seen.add(enc.id);
      return true;
    });
  },

  /**
   * @deprecated Úsese getDetalleHostSeguro (host) o getEncuentroByPublicToken (invitados).
   * Este método usa SELECT directo que fallará bajo RLS restrictivo para usuarios anónimos.
   */
  async getEncuentroById(_id: string) {
    throw new Error('getEncuentroById está deprecado en la arquitectura RPC-first. Use getDetalleHostSeguro o getEncuentroByPublicToken.');
  },

  async getEncuentroByPublicToken(public_token: string) {
    const { data, error } = await supabase.rpc('get_encuentro_por_public_token', {
      p_public_token: public_token
    });
    if (error) throw error;
    if (!data) return null;
    if (data) {
      data.invitation_template = resolveInvitationTemplateForTheme(data.tema_invitacion, data.invitation_template);
    }
    return data;
  },

  async getDetalleHostSeguro(id: string, hostId: string) {
    if (import.meta.env.DEV) console.log('[get_detalle_host_seguro] encuentroId:', id, 'hostId:', hostId);

    const { data, error } = await supabase.rpc('get_detalle_host_seguro', {
      p_encuentro_id: id,
      p_host_id: hostId
    });

    if (import.meta.env.DEV) console.log('[get_detalle_host_seguro] raw data:', data, 'error:', error);

    if (error) throw error;

    // Parseo defensivo: Supabase puede devolver JSON como string
    const result: any = typeof data === 'string' ? JSON.parse(data) : data;

    if (result) {
      result.invitation_template = resolveInvitationTemplateForTheme(result.tema_invitacion, result.invitation_template);
    }

    if (!result || result.error) {
      const code = result?.error || 'not_found';
      const err = new Error(code);
      (err as any).code = code;
      throw err;
    }

    return result;
  },

  async cancelarEncuentro(id: string, hostId: string) {
    if (!hostId) throw new Error('host_id requerido para cancelar');
    if (import.meta.env.DEV) console.log('[CANCEL] Iniciando cancelación. encuentroId:', id);

    const { data, error } = await supabase.rpc('cancelar_encuentro_seguro', {
      p_encuentro_id: id,
      p_host_id: hostId
    });
    if (error) throw error;
    const result = data as any;
    if (!result?.ok) {
      const msg = result?.error || 'cancel_failed';
      if (import.meta.env.DEV) console.error('[CANCEL ERROR]', msg);
      throw new Error(msg);
    }
    if (import.meta.env.DEV) console.log('[CANCEL] Cancelación exitosa.');
    return result;
  },

  async deleteEncuentro(id: string, hostId: string) {
    if (!hostId) throw new Error('host_id requerido para eliminar');
    if (import.meta.env.DEV) console.log('[DELETE] encuentroId:', id);

    const { data, error } = await supabase.rpc('eliminar_encuentro_seguro', {
      p_encuentro_id: id,
      p_host_id: hostId
    });
    if (error) throw error;
    const result = data as any;
    if (!result?.ok) throw new Error(result?.error || 'delete_failed');
    return result;
  },

  async getEncuentrosParticipados(userId: string) {
    if (!userId) return [];

    // RPC sin params — usa auth.uid() internamente
    const { data, error } = await supabase.rpc('get_encuentros_participados_seguro');
    if (error) throw error;
    if (!data || (data as any).error) return [];
    const list = (data as any[]) || [];
    list.forEach(enc => {
      enc.invitation_template = resolveInvitationTemplateForTheme(enc.tema_invitacion, enc.invitation_template);
    });
    return list;
  },

  async getEncuentrosParticipadosPorTokens(tokens: string[]) {
    if (!tokens || tokens.length === 0) return [];
    const { data, error } = await supabase.rpc('get_encuentros_participados_por_tokens', {
      p_tokens: tokens
    });
    if (error) {
      if (import.meta.env.DEV) console.error('Error fetching encuentros por tokens:', error);
      return [];
    }
    const list = (data as any[]) || [];
    list.forEach(part => {
      if (part.encuentros) {
        const encs = Array.isArray(part.encuentros) ? part.encuentros : [part.encuentros];
        encs.forEach((enc: any) => {
          enc.invitation_template = resolveInvitationTemplateForTheme(enc.tema_invitacion, enc.invitation_template);
        });
      }
    });
    return list;
  },

  async linkAnonymousEncuentros(anonId: string, userId: string) {
    if (!anonId || !userId || anonId === userId) return;
    if (import.meta.env.DEV) console.log(`[LINK] Transfiriendo encuentros de ${anonId} a ${userId}`);

    const { data, error } = await supabase.rpc('transferir_encuentros_anonimos_seguro', {
      p_anon_host_id: anonId,
      p_user_id: userId
    });
    if (error) throw error;
    const result = data as any;
    if (!result?.ok) throw new Error(result?.error || 'transfer_failed');
    return result;
  },

  async updateEncuentro(id: string, campos: Partial<CreateEncuentroDTO>, hostId: string) {
    if (!hostId) throw new Error('host_id requerido para actualizar');

    const { data: result, error } = await supabase.rpc('actualizar_encuentro_seguro', {
      p_encuentro_id: id,
      p_host_id: hostId,
      p_data: campos
    });
    if (error) throw error;
    const res = result as any;
    if (!res?.ok) throw new Error(res?.error || 'update_failed');
    return res;
  },

  async setVisibilidadRespuestasInvitados(encuentroId: string, hostId: string, visible: boolean) {
    const { data, error } = await supabase.rpc('set_visibilidad_respuestas_invitados', {
      p_encuentro_id: encuentroId,
      p_host_id: hostId,
      p_visible: visible,
    });
    if (error) throw error;
    const result: any = typeof data === 'string' ? JSON.parse(data) : data;
    if (!result?.ok) throw new Error(result?.error || 'update_visibility_failed');
    return result;
  },

  async getVisibilidadInvitadosHost(encuentroId: string, hostId: string) {
    const { data, error } = await supabase.rpc('get_visibilidad_invitados_host', {
      p_encuentro_id: encuentroId,
      p_host_id: hostId,
    });
    if (error) throw error;
    const result: any = typeof data === 'string' ? JSON.parse(data) : data;
    // Devuelve { ok, visible } o { ok: false, error }
    return result;
  },

  async getCountsPorEncuentros(encuentroIds: string[]) {
    if (!encuentroIds || encuentroIds.length === 0) return {};
    const ids = [...new Set(encuentroIds)];
    const { data, error } = await supabase.rpc('get_counts_participantes_host_seguro', {
      p_encuentro_ids: ids
    });

    if (error) {
      if (import.meta.env.DEV) console.error('Error fetching counts:', error);
      return {};
    }

    // La RPC ya devuelve el diccionario { [id]: { total, confirmados } }
    return (data as Record<string, { total: number; confirmados: number }>) || {};

  },

  async crearEncuentroConOpciones(payload: CoordinationCreatePayload, opciones: CoordinationOptionPayload[]): Promise<CoordinationCreateResult> {
    console.info('[CrearCoordinacion] Enviando RPC', {
      rpc: 'crear_encuentro_con_opciones_seguro',
      p_data: payload,
      p_opciones: opciones,
    });

    const { data, error } = await supabase.rpc('crear_encuentro_con_opciones_seguro', {
      p_data: payload,
      p_opciones: opciones
    });

    if (error) {
      console.error('[CrearCoordinacion] Supabase network/auth error:', {
        supabaseError: error,
        payload,
        opciones,
      });
      return { ok: false, error: 'rpc_error' };
    }

    if (data && typeof data === 'object' && 'ok' in data) {
      if (data.ok === false) {
        // RPC returned a structured logic error — log full details for debugging
        console.error('[CrearCoordinacion] RPC devolvió error lógico:', {
          rpcError: (data as Record<string, unknown>).error,
          rpcDetails: (data as Record<string, unknown>).details,
          payload,
          opciones,
        });
      } else {
        // Creation succeeded
        console.info('[CrearCoordinacion] RPC exitosa:', data);
      }
    }

    return validateCoordinationCreateResult(data);
  },

  async getCoordinacionHost(encuentroId: string): Promise<CoordinationHostDetail> {
    const { data, error } = await supabase.rpc('get_coordinacion_host_seguro', {
      p_encuentro_id: encuentroId
    });

    if (error) {
      console.error('Error in get_coordinacion_host_seguro (RPC):', error);
      throw error;
    }

    const result = (typeof data === 'string' ? JSON.parse(data) : data) as CoordinationHostDetail;

    if (result && result.encuentro) {
      result.encuentro.invitation_template = resolveInvitationTemplateForTheme(
        result.encuentro.tema_invitacion as InvitationTheme,
        result.encuentro.invitation_template
      );
    }

    return result;
  },

  async cerrarCoordinacionHost(encuentroId: string, optionId: string): Promise<{ok: boolean, error?: string}> {
    const { data, error } = await supabase.rpc('cerrar_coordinacion_seguro', {
      p_encuentro_id: encuentroId,
      p_selected_option_id: optionId
    });

    if (error) {
      console.error('[encuentrosService] Error en cerrar_coordinacion_seguro:', error);
      return { ok: false, error: (error as any).message || (error as any).code || 'rpc_error' };
    }
    
    if (data && data.ok === false) {
      console.error('[encuentrosService] Error logico en cerrar_coordinacion_seguro:', data.error);
      return { ok: false, error: data.error };
    }

    return { ok: true };
  },

  async getCoordinacionPublica(publicToken: string): Promise<CoordinationPublicReadResult> {
    if (!publicToken) return { ok: false, error: 'invalid_token' };

    const { data, error } = await supabase.rpc('get_coordinacion_publica_seguro', {
      p_public_token: publicToken
    });

    if (error) return { ok: false, error: 'rpc_error' };

    const rawResult: unknown = parseRpcJson(data);
    if (!isUnknownRecord(rawResult)) return { ok: false, error: 'invalid_response_format' };

    if (rawResult.ok === false) {
      return { ok: false, error: typeof rawResult.error === 'string' ? rawResult.error : 'unknown_error' };
    }

    if (rawResult.ok !== true) return { ok: false, error: 'invalid_response_format' };

    const fail = (failedField: string, value: any, details?: string) => {
      console.error('[getCoordinacionPublica] invalid response format', {
        failedField,
        value,
        valueType: typeof value,
        details,
        rawResult
      });
      return { 
        ok: false as const, 
        error: 'invalid_response_format', 
        failedField, 
        details: details ?? `Invalid field: ${failedField}` 
      };
    };

    console.info('[getCoordinacionPublica] shape', {
      hasOk: typeof (rawResult as any)?.ok,
      keys: Object.keys((rawResult as any) ?? {}),
      encuentroKeys: Object.keys((rawResult as any)?.encuentro ?? {}),
      opcionesLength: Array.isArray((rawResult as any)?.opciones) ? (rawResult as any).opciones.length : 'not-array',
      firstOptionKeys: Object.keys((rawResult as any)?.opciones?.[0] ?? {}),
    });

    if (!isUnknownRecord(rawResult.encuentro)) return fail('encuentro', rawResult.encuentro);
    const enc = rawResult.encuentro;
    console.info('[getCoordinacionPublica] RPC raw response', rawResult);

    if (!isNonEmptyString(enc.titulo)) return fail('encuentro.titulo', enc.titulo);
    if (!isNonEmptyString(enc.estado)) return fail('encuentro.estado', enc.estado);
    if (enc.modalidad !== 'presencial' && enc.modalidad !== 'virtual') return fail('encuentro.modalidad', enc.modalidad);
    if (!isNonEmptyString(enc.tipo_invitacion)) return fail('encuentro.tipo_invitacion', enc.tipo_invitacion);
    if (!isNonEmptyString(enc.tema_invitacion)) return fail('encuentro.tema_invitacion', enc.tema_invitacion);
    if (!isNullableString(enc.descripcion)) return fail('encuentro.descripcion', enc.descripcion);
    if (!isNullableString(enc.lugar_texto)) return fail('encuentro.lugar_texto', enc.lugar_texto);
    if (!isNullableString(enc.tema)) return fail('encuentro.tema', enc.tema);
    if (!isNullableString(enc.invitation_template)) return fail('encuentro.invitation_template', enc.invitation_template);
    // Normalize undefined → null for fields the RPC may omit depending on version
    if (!isValidDurationMinutes(enc.duration_minutes ?? null)) return fail('encuentro.duration_minutes', enc.duration_minutes);

    if (!isCoordinationStatus(rawResult.coordination_status)) return fail('coordination_status', rawResult.coordination_status);
    const rawDeadline = rawResult.response_deadline ?? null;
    if (rawDeadline !== null && !isValidIsoDateTime(rawDeadline)) return fail('response_deadline', rawDeadline);
    const rawSelectedId = rawResult.selected_option_id ?? null;
    if (rawSelectedId !== null && (!isUuid(rawSelectedId) && !isNonEmptyString(rawSelectedId))) return fail('selected_option_id', rawSelectedId);
    const rawFecha = rawResult.fecha ?? null;
    if (rawFecha !== null && !isValidCalendarDate(rawFecha)) return fail('fecha', rawFecha);
    const rawHora = rawResult.hora ?? null;
    if (rawHora !== null && !isValidPostgresTime(rawHora)) return fail('hora', rawHora);
    if (!isCoordinationDerivedStatus(rawResult.derived_status)) return fail('derived_status', rawResult.derived_status);

    if (!Array.isArray(rawResult.opciones) || rawResult.opciones.length < 2 || rawResult.opciones.length > 3) return fail('opciones', rawResult.opciones);

    const ops: CoordinationOption[] = [];
    const seenOptionIds = new Set<string>();
    const seenOptionOrders = new Set<number>();

    let opIndex = 0;
    for (const op of rawResult.opciones) {
      if (!isUnknownRecord(op)) return fail('opciones[item]', op);
      if (!isNonEmptyString(op.id)) return fail('opcion.id', op.id);
      if (seenOptionIds.has(op.id as string)) return fail('opcion.id_duplicate', op.id);
      seenOptionIds.add(op.id as string);

      const resolvedOrden = typeof op.orden === 'number' && Number.isInteger(op.orden) ? op.orden : opIndex + 1;
      if (resolvedOrden < 1 || resolvedOrden > 3) return fail('opcion.orden', resolvedOrden);
      if (seenOptionOrders.has(resolvedOrden)) return fail('opcion.orden_duplicate', resolvedOrden);
      seenOptionOrders.add(resolvedOrden);

      if (!isValidCalendarDate(op.fecha)) return fail('opcion.fecha', op.fecha);
      if (!isValidPostgresTime(op.hora_inicio)) return fail('opcion.hora_inicio', op.hora_inicio);
      if (typeof op.selected !== 'boolean') return fail('opcion.selected', op.selected);

      ops.push({
        id: op.id as string,
        fecha: op.fecha as string,
        hora_inicio: op.hora_inicio as string,
        orden: resolvedOrden,
        selected: op.selected as boolean,
        available_count: (op.available_count as number) ?? 0,
        maybe_count: (op.maybe_count as number) ?? 0,
        unavailable_count: (op.unavailable_count as number) ?? 0,
        preferred_count: (op.preferred_count as number) ?? 0
      });
      opIndex++;
    }

    return {
      ok: true,
      encuentro: {
        titulo: enc.titulo as string,
        descripcion: enc.descripcion as string | null,
        estado: enc.estado as string,
        modalidad: enc.modalidad as string,
        lugar_texto: enc.lugar_texto as string | null,
        tema: enc.tema as string | null,
        tipo_invitacion: enc.tipo_invitacion as string,
        tema_invitacion: enc.tema_invitacion as string,
        invitation_template: resolveInvitationTemplateForTheme(
          enc.tema_invitacion as InvitationTheme,
          enc.invitation_template as string | null
        ),
        duration_minutes: enc.duration_minutes as number | null
      },
      coordination_status: rawResult.coordination_status as 'open' | 'closed',
      response_deadline: rawDeadline,
      selected_option_id: rawSelectedId,
      fecha: rawFecha,
      hora: rawHora,
      derived_status: rawResult.derived_status as 'open' | 'closed' | 'deadline_passed',
      opciones: ops
    };
  },

  async getCoordinacionParticipante(tokenInvitacion: string): Promise<CoordinationParticipantReadResult> {
    if (!tokenInvitacion) return { ok: false, error: 'invalid_token' };

    const { data, error } = await supabase.rpc('get_coordinacion_participante_seguro', {
      p_token: tokenInvitacion
    });

    if (error) return { ok: false, error: 'rpc_error' };

    const rawResult: unknown = parseRpcJson(data);
    if (!isUnknownRecord(rawResult)) return { ok: false, error: 'invalid_response_format' };

    if (rawResult.ok === false) {
      return { ok: false, error: typeof rawResult.error === 'string' ? rawResult.error : 'unknown_error' };
    }

    if (rawResult.ok !== true) return { ok: false, error: 'invalid_response_format' };

    const fail = (failedField: string, value: any, details?: string) => {
      console.error('[getCoordinacionParticipante] invalid response format', {
        failedField,
        value,
        valueType: typeof value,
        details,
        rawResult
      });
      return { 
        ok: false as const, 
        error: 'invalid_response_format', 
        failedField, 
        details: details ?? `Invalid field: ${failedField}` 
      };
    };

    console.info('[getCoordinacionParticipante] shape', {
      hasOk: typeof (rawResult as any)?.ok,
      keys: Object.keys((rawResult as any) ?? {}),
      encuentroKeys: Object.keys((rawResult as any)?.encuentro ?? {}),
      participanteKeys: Object.keys((rawResult as any)?.participante ?? {}),
      opcionesLength: Array.isArray((rawResult as any)?.opciones) ? (rawResult as any).opciones.length : 'not-array',
      firstOptionKeys: Object.keys((rawResult as any)?.opciones?.[0] ?? {}),
    });

    console.info('[getCoordinacionParticipante] RPC raw response', rawResult);

    if (!isUnknownRecord(rawResult.encuentro)) return fail('encuentro', rawResult.encuentro);
    const enc = rawResult.encuentro;
    if (!isNonEmptyString(enc.id)) return fail('encuentro.id', enc.id);
    if (!isNonEmptyString(enc.titulo)) return fail('encuentro.titulo', enc.titulo);
    if (!isNonEmptyString(enc.estado)) return fail('encuentro.estado', enc.estado);
    if (enc.modalidad !== 'presencial' && enc.modalidad !== 'virtual') return fail('encuentro.modalidad', enc.modalidad);
    if (!isNonEmptyString(enc.tipo_invitacion)) return fail('encuentro.tipo_invitacion', enc.tipo_invitacion);
    if (!isNonEmptyString(enc.tema_invitacion)) return fail('encuentro.tema_invitacion', enc.tema_invitacion);
    if (!isNullableString(enc.descripcion)) return fail('encuentro.descripcion', enc.descripcion);
    if (!isNullableString(enc.lugar_texto)) return fail('encuentro.lugar_texto', enc.lugar_texto);
    if (!isNullableString(enc.tema)) return fail('encuentro.tema', enc.tema);
    if (!isNullableString(enc.invitation_template)) return fail('encuentro.invitation_template', enc.invitation_template);
    // Normalize undefined → null for fields the RPC may omit depending on version
    if (!isValidDurationMinutes(enc.duration_minutes ?? null)) return fail('encuentro.duration_minutes', enc.duration_minutes);

    if (!isUnknownRecord(rawResult.participante)) return fail('participante', rawResult.participante);
    const part = rawResult.participante;
    if (!isNonEmptyString(part.id)) return fail('participante.id', part.id);
    if (!isNonEmptyString(part.nombre_invitado)) return fail('participante.nombre_invitado', part.nombre_invitado);
    if (!isNonEmptyString(part.tipo_invitacion)) return fail('participante.tipo_invitacion', part.tipo_invitacion);
    if (!isNonEmptyString(part.estado)) return fail('participante.estado', part.estado);
    if (!isNullableString(part.mensaje_respuesta)) return fail('participante.mensaje_respuesta', part.mensaje_respuesta);
    if (typeof part.respondio_disponibilidad !== 'boolean') return fail('participante.respondio_disponibilidad', part.respondio_disponibilidad);

    if (!isCoordinationStatus(rawResult.coordination_status)) return fail('coordination_status', rawResult.coordination_status);
    const partDeadline = rawResult.response_deadline ?? null;
    if (partDeadline !== null && !isValidIsoDateTime(partDeadline)) return fail('response_deadline', partDeadline);
    const partSelectedId = rawResult.selected_option_id ?? null;
    if (partSelectedId !== null && (!isUuid(partSelectedId) && !isNonEmptyString(partSelectedId))) return fail('selected_option_id', partSelectedId);
    const partFecha = rawResult.fecha ?? null;
    if (partFecha !== null && !isValidCalendarDate(partFecha)) return fail('fecha', partFecha);
    const partHora = rawResult.hora ?? null;
    if (partHora !== null && !isValidPostgresTime(partHora)) return fail('hora', partHora);
    if (!isCoordinationDerivedStatus(rawResult.derived_status)) return fail('derived_status', rawResult.derived_status);

    if (!Array.isArray(rawResult.opciones) || rawResult.opciones.length < 2 || rawResult.opciones.length > 3) return fail('opciones', rawResult.opciones);

    const ops: CoordinationOption[] = [];
    const seenOptionIds = new Set<string>();
    const seenOptionOrders = new Set<number>();

    let opIndex = 0;
    for (const op of rawResult.opciones) {
      if (!isUnknownRecord(op)) return fail('opciones[item]', op);
      if (!isNonEmptyString(op.id)) return fail('opcion.id', op.id);
      if (seenOptionIds.has(op.id as string)) return fail('opcion.id_duplicate', op.id);
      seenOptionIds.add(op.id as string);

      const resolvedOrden = typeof op.orden === 'number' && Number.isInteger(op.orden) ? op.orden : opIndex + 1;
      if (resolvedOrden < 1 || resolvedOrden > 3) return fail('opcion.orden', resolvedOrden);
      if (seenOptionOrders.has(resolvedOrden)) return fail('opcion.orden_duplicate', resolvedOrden);
      seenOptionOrders.add(resolvedOrden);

      if (!isValidCalendarDate(op.fecha)) return fail('opcion.fecha', op.fecha);
      if (!isValidPostgresTime(op.hora_inicio)) return fail('opcion.hora_inicio', op.hora_inicio);
      if (typeof op.selected !== 'boolean') return fail('opcion.selected', op.selected);
      ops.push({
        id: op.id as string,
        fecha: op.fecha as string,
        hora_inicio: op.hora_inicio as string,
        orden: resolvedOrden,
        selected: op.selected as boolean,
        available_count: (op.available_count as number) ?? 0,
        maybe_count: (op.maybe_count as number) ?? 0,
        unavailable_count: (op.unavailable_count as number) ?? 0,
        preferred_count: (op.preferred_count as number) ?? 0
      });
      opIndex++;
    }

    const resps = normalizeCoordinationResponses(rawResult.mis_respuestas, seenOptionIds);
    if (!resps) return fail('mis_respuestas', rawResult.mis_respuestas);

    return {
      ok: true,
      encuentro: {
        id: enc.id as string,
        titulo: enc.titulo as string,
        descripcion: enc.descripcion as string | null,
        estado: enc.estado as string,
        modalidad: enc.modalidad as string,
        lugar_texto: enc.lugar_texto as string | null,
        tema: enc.tema as string | null,
        tipo_invitacion: enc.tipo_invitacion as string,
        tema_invitacion: enc.tema_invitacion as string,
        invitation_template: resolveInvitationTemplateForTheme(
          enc.tema_invitacion as InvitationTheme,
          enc.invitation_template as string | null
        ),
        duration_minutes: enc.duration_minutes as number | null
      },
      participante: {
        id: part.id as string,
        nombre_invitado: part.nombre_invitado as string,
        tipo_invitacion: part.tipo_invitacion as string,
        estado: part.estado as string,
        mensaje_respuesta: part.mensaje_respuesta as string | null,
        respondio_disponibilidad: part.respondio_disponibilidad as boolean
      },
      coordination_status: rawResult.coordination_status as 'open' | 'closed',
      response_deadline: partDeadline,
      selected_option_id: partSelectedId,
      fecha: partFecha,
      hora: partHora,
      derived_status: rawResult.derived_status as 'open' | 'closed' | 'deadline_passed',
      opciones: ops,
      mis_respuestas: resps
    };
  },

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

    if (error) return { ok: false, error: 'rpc_error' };

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

    const normResps = normalizeCoordinationResponses(respuestas);
    if (!normResps) return { ok: false, error: 'invalid_responses' };

    const { data, error } = await supabase.rpc('guardar_disponibilidad_coordinacion_participante_seguro', {
      p_token: tokenInvitacion,
      p_respuestas: normResps
    });

    if (error) return { ok: false, error: 'rpc_error' };

    const result: unknown = parseRpcJson(data);
    if (!isUnknownRecord(result)) return { ok: false, error: 'invalid_response_format' };

    if (result.ok === false) {
      return { ok: false, error: typeof result.error === 'string' ? result.error : 'unknown_error' };
    }

    if (result.ok !== true) return { ok: false, error: 'invalid_response_format' };

    if (!isNonEmptyString(result.encuentro_id)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(result.participante_id)) return { ok: false, error: 'invalid_response_format' };
    if (result.respondio_disponibilidad !== true) return { ok: false, error: 'invalid_response_format' };

    const retResps = normalizeCoordinationResponses(result.mis_respuestas);
    if (!retResps || retResps.length !== normResps.length) return { ok: false, error: 'invalid_response_format' };

    const reqIds = new Set(normResps.map(r => r.opcion_fecha_id));
    for (const r of retResps) {
      if (!reqIds.has(r.opcion_fecha_id)) return { ok: false, error: 'invalid_response_format' };
    }

    return { ok: true };
  }
};
