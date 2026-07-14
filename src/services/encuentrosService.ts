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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePostgresTimeToHHMM(timeString: string): string | null {
  if (typeof timeString !== 'string') return null;
  // Regex to match HH:MM or HH:MM:SS or HH:MM:SS.ffffff
  const match = timeString.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

export function validateCoordinationCreateResult(value: unknown): CoordinationCreateResult {
  if (!isUnknownRecord(value)) {
    return { ok: false, error: 'invalid_response_format' };
  }

  const record = value;

  if (record.ok === false) {
    return {
      ok: false,
      error: typeof record.error === 'string' ? record.error : 'unknown_error'
    };
  }

  if (record.ok === true) {
    if (!isUnknownRecord(record.encuentro)) return { ok: false, error: 'invalid_response_format' };
    const enc = record.encuentro;

    if (typeof enc.id !== 'string' || !enc.id.trim()) return { ok: false, error: 'invalid_encounter_id' };
    if (typeof enc.public_token !== 'string' || !enc.public_token.trim()) return { ok: false, error: 'invalid_public_token' };
    if (enc.date_mode !== 'coordination') return { ok: false, error: 'invalid_date_mode' };
    if (enc.coordination_status !== 'open') return { ok: false, error: 'invalid_coordination_status' };
    if (enc.response_deadline !== null && typeof enc.response_deadline !== 'string') return { ok: false, error: 'invalid_response_deadline' };

    if (!Array.isArray(record.opciones)) return { ok: false, error: 'invalid_options_format' };
    const rawOps = record.opciones;

    if (rawOps.length < 2 || rawOps.length > 3) return { ok: false, error: 'invalid_options_length' };

    const ops: CoordinationCreatedOption[] = [];
    const seenIds = new Set<string>();
    const seenOrders = new Set<number>();

    for (const rawOp of rawOps) {
      if (!isUnknownRecord(rawOp)) return { ok: false, error: 'invalid_option_format' };

      const { id, fecha, hora_inicio, orden } = rawOp;

      if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'invalid_option_id' };
      if (typeof fecha !== 'string' || typeof hora_inicio !== 'string') return { ok: false, error: 'invalid_option_date' };

      const normalizedTime = normalizePostgresTimeToHHMM(hora_inicio);
      if (!normalizedTime) return { ok: false, error: 'invalid_option_date' };

      if (!isValidDateTime(fecha, normalizedTime)) return { ok: false, error: 'invalid_option_date' };
      if (
        typeof orden !== 'number' ||
        !Number.isInteger(orden) ||
        orden < 1 ||
        orden > 3
      ) {
        return {
          ok: false,
          error: 'invalid_option_order',
        };
      }

      if (seenIds.has(id)) return { ok: false, error: 'duplicate_option_id' };
      seenIds.add(id);

      if (seenOrders.has(orden)) return { ok: false, error: 'duplicate_option_order' };
      seenOrders.add(orden);

      ops.push({
        id,
        fecha,
        hora_inicio: normalizedTime,
        orden
      });
    }

    const sortedOrders = [...seenOrders].sort((a, b) => a - b);
    const hasExpectedOrders = sortedOrders.every((order, index) => order === index + 1);

    if (!hasExpectedOrders) {
      return {
        ok: false,
        error: 'invalid_option_order_sequence',
      };
    }

    const validatedEncounter: CoordinationCreatedEncounter = {
      id: enc.id,
      public_token: enc.public_token,
      date_mode: 'coordination',
      coordination_status: 'open',
      response_deadline: enc.response_deadline as string | null
    };

    return {
      ok: true,
      encuentro: validatedEncounter,
      opciones: ops,
    };
  }

  return { ok: false, error: 'invalid_response_format' };
}

export function getCoordinationCreateErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'not_authenticated':
      return 'Necesitás iniciar sesión para coordinar una fecha.';
    case 'permanent_account_required':
      return 'Necesitás una cuenta permanente para coordinar una fecha.';
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
      return 'Todas las opciones deben ser futuras.';
    case 'duplicate_options':
      return 'No puede haber dos opciones iguales.';
    case 'invalid_deadline':
      return 'Revisá el plazo para responder.';
    case 'deadline_after_first_option':
      return 'El plazo debe finalizar antes de la primera opción.';
    case 'invalid_modality':
      return 'Revisá la modalidad del encuentro.';
    case 'location_required':
      return 'Indicá el lugar del encuentro.';
    case 'virtual_link_required':
      return 'Indicá el enlace de la reunión.';
    case 'invalid_invitation_type':
      return 'Revisá el tipo de invitación.';
    case 'invalid_theme':
      return 'Revisá el diseño de la invitación.';
    case 'invalid_date_mode':
      return 'Este encuentro no corresponde a una coordinación.';
    case 'not_owner':
      return 'No tenés permiso para administrar este encuentro.';
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
  };
  coordination_status?: string;
  response_deadline?: string | null;
  selected_option_id?: string | null;
  fecha?: string | null;
  hora?: string | null;
  derived_status?: string;
  opciones?: CoordinationHostOption[];
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
    const { data, error } = await supabase.rpc('crear_encuentro_con_opciones_seguro', {
      p_data: payload,
      p_opciones: opciones
    });

    if (error) {
      console.error('[encuentrosService] Error en crear_encuentro_con_opciones_seguro:', error);
      return { ok: false, error: 'rpc_error' };
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
  }
};
