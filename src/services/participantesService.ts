import { supabase } from '@/lib/supabase';

export const participantesService = {
  async addParticipanteIndividual(encuentro_id: string, host_id: string, nombre_invitado: string) {
    // RPC SECURITY DEFINER — verifica ownership y genera token server-side
    const { data, error } = await supabase.rpc(
      'crear_participante_individual_seguro',
      {
        p_encuentro_id: encuentro_id,
        p_host_id: host_id,
        p_nombre: nombre_invitado,
      }
    );

    if (error) {
      console.error('Error adding participante (RPC):', error);
      throw error;
    }

    return data as any;
  },

  async getParticipantesByEncuentro(encuentro_id: string, hostId: string) {
    if (!hostId) {
      throw new Error("hostId requerido para getParticipantesByEncuentro bajo arquitectura RPC-first");
    }

    const { data, error } = await supabase.rpc('get_participantes_host_seguro', {
      p_encuentro_id: encuentro_id,
      p_host_id: hostId
    });
    if (error) throw error;
    if ((data as any)?.error) {
      if (import.meta.env.DEV) console.warn('[PART] RPC error:', (data as any).error);
      return [];
    }
    return (data as any[]) || [];
  },

  async deleteParticipante(participanteId: string, hostId: string) {
    if (!hostId) {
      throw new Error('hostId requerido para eliminar participante bajo arquitectura RPC-first');
    }
    
    const { data, error } = await supabase.rpc('eliminar_participante_seguro', {
      p_participante_id: participanteId,
      p_host_id: hostId
    });

    if (error) {
      console.error('Error deleting participante (RPC):', error);
      throw error;
    }
    
    const result = data as any;
    if (!result?.ok) {
      const msg = result?.error || 'delete_failed';
      console.error('[DELETE PART] RPC Error:', msg);
      throw new Error(msg);
    }
    
    return result;
  },

  async getParticipanteByToken(token: string) {
    if (import.meta.env.DEV) console.log('Token consultado en backend:', token);

    // Usar SOLO la RPC — eliminar intento directo
    const { data, error } = await supabase.rpc('get_participante_seguro', { p_token: token });

    if (import.meta.env.DEV) console.log('Resultado de búsqueda RPC en DB:', error ? 'error' : 'ok');

    if (error) {
      console.error('Error fetching participante by token:', error);
      throw error;
    }

    return data;
  },

  /**
   * @deprecated Fallback SELECT directo bloqueado por RLS en Etapa D. Use getParticipanteByToken.
   */
  async getParticipanteById(_id: string) {
    throw new Error('getParticipanteById está deprecado en la arquitectura RPC-first.');
  },

  /**
   * @deprecated Lógica reemplazada por validaciones internas en Supabase RPCs.
   */
  async validateEncuentroActivo(_encuentro_id: string) {
    throw new Error('validateEncuentroActivo está deprecado.');
  },

  async responderInvitacion(
    token: string,
    estado: 'confirmado' | 'rechazado',
    nombre?: string,
    mensaje?: string
  ) {
    const { data, error } = await supabase.rpc('responder_participante_seguro', {
      p_token: token,
      p_estado: estado,
      p_nombre: nombre ?? null,
      p_mensaje_respuesta: mensaje ?? null
    });
    if (error) throw error;
    const result = data as any;
    if (!result?.ok) {
      throw new Error(result?.error || 'response_failed');
    }
    return result;
  },

  /**
   * @deprecated UPDATE directo bloqueado en Etapa D. Use responderInvitacion (RPC).
   */
  async updateParticipanteEstado(_id: string, _estado: 'confirmado' | 'rechazado', _user_id?: string | null, _nombre_invitado?: string, _mensaje_respuesta?: string) {
    throw new Error('updateParticipanteEstado está deprecado en la arquitectura RPC-first. Use responderInvitacion.');
  },

  async addParticipanteGenerico(
    _encuentro_id: string,
    nombre_invitado: string,
    estado: 'confirmado' | 'rechazado',
    _user_id?: string | null,
    mensaje_respuesta?: string,
    public_token?: string  // parámetro opcional para usar RPC segura
  ) {
    // Si hay public_token disponible, usar RPC segura
    if (public_token) {
      const result = await this.responderInvitacion(
        public_token, estado, nombre_invitado, mensaje_respuesta
      );
      return result;
    }

    throw new Error('addParticipanteGenerico sin public_token está deprecado en la arquitectura RPC-first.');
  },

  async linkUserToParticipante(participantId: string, userId: string) {
    if (!participantId || !userId) return;
    if (import.meta.env.DEV) console.log(`[LINK_PART] Vinculando participante ${participantId} a user ${userId}`);

    const { error } = await supabase
      .from('participantes')
      .update({ user_id: userId })
      .eq('id', participantId)
      .is('user_id', null); // Solo vincular si aún no tiene user_id (evita sobreescribir)

    if (error) {
      console.error('Error linking user to participante:', error);
      throw error;
    }
  },
};
