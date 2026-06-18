import { supabase } from '@/lib/supabase';

export const participantesService = {
  async addParticipanteIndividual(encuentro_id: string, nombre_invitado: string, token_invitacion: string) {
    const { data, error } = await supabase
      .from('participantes')
      .insert([{
        encuentro_id,
        nombre_invitado,
        tipo_invitacion: 'individual',
        token_invitacion,
        estado: 'pendiente'
      }])
      .select()
      .single();

    if (error) {
      console.error('Error adding participante:', error);
      throw error;
    }

    return data;
  },

  async getParticipantesByEncuentro(encuentro_id: string, hostId?: string) {
    // Si se provee hostId, usar RPC segura
    if (hostId) {
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
    }
    // Fallback: SELECT directo (temporal, hasta que todos los callers pasen hostId)
    const { data, error } = await supabase
      .from('participantes')
      .select('*')
      .eq('encuentro_id', encuentro_id)
      .order('creado_en', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async deleteParticipante(id: string) {
    const { error } = await supabase
      .from('participantes')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting participante:', error);
      throw error;
    }
    
    return true;
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

  async getParticipanteById(id: string) {
    const { data, error } = await supabase
      .from('participantes')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching participante by id:', error);
      throw error;
    }

    return data;
  },

  async validateEncuentroActivo(encuentro_id: string) {
    const { data: encuentro, error } = await supabase
      .from('encuentros')
      .select('estado')
      .eq('id', encuentro_id)
      .single();

    if (error || !encuentro) {
      throw new Error('meeting_not_found');
    }

    if (encuentro.estado !== 'activo') {
      throw new Error('meeting_cancelled');
    }
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

  async updateParticipanteEstado(id: string, estado: 'confirmado' | 'rechazado', user_id?: string | null, nombre_invitado?: string, mensaje_respuesta?: string) {
    // 1. Obtener el id del encuentro para validar su estado
    const { data: participante, error: pError } = await supabase
      .from('participantes')
      .select('encuentro_id')
      .eq('id', id)
      .single();

    if (pError || !participante) throw new Error('participant_not_found');

    // 2. Validar que el encuentro siga activo
    await this.validateEncuentroActivo(participante.encuentro_id);

    const respondido_en = new Date().toISOString();
    const updatePayload: Record<string, any> = { estado, respondido_en };
    if (nombre_invitado) updatePayload.nombre_invitado = nombre_invitado;
    if (mensaje_respuesta !== undefined) {
      updatePayload.mensaje_respuesta = mensaje_respuesta ? mensaje_respuesta.trim().substring(0, 120) : null;
    }
    // Solo actualizar user_id si se proporciona un id válido (no sobreescribir con null si ya existía)
    if (user_id) updatePayload.user_id = user_id;

    const { data, error } = await supabase
      .from('participantes')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating participante estado:', error);
      throw error;
    }

    return data;
  },

  async addParticipanteGenerico(
    encuentro_id: string,
    nombre_invitado: string,
    estado: 'confirmado' | 'rechazado',
    user_id?: string | null,
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

    // Fallback: INSERT directo (temporal)
    await this.validateEncuentroActivo(encuentro_id);
    const respondido_en = new Date().toISOString();
    const token_invitacion = crypto.randomUUID();
    const insertPayload: Record<string, any> = {
      encuentro_id, nombre_invitado, tipo_invitacion: 'generico',
      estado, respondido_en, token_invitacion,
    };
    if (mensaje_respuesta) insertPayload.mensaje_respuesta = mensaje_respuesta.trim().substring(0, 120);
    if (user_id !== undefined && user_id !== null) insertPayload.user_id = user_id;
    const { data, error } = await supabase.from('participantes').insert([insertPayload]).select().single();
    if (error) throw error;
    return data;
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
