import { supabase } from '@/lib/supabase';
import { validateEncounterDate } from '@/lib/formatDate';

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
  reemplaza_a?: string | null;
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
    return (data as any[]) || [];
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
    return (data as any[]) || [];
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
      p_campos: campos
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
};
