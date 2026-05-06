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

  async getParticipantesByEncuentro(encuentro_id: string) {
    const { data, error } = await supabase
      .from('participantes')
      .select('*')
      .eq('encuentro_id', encuentro_id)
      .order('creado_en', { ascending: true });

    if (error) {
      console.error('Error fetching participantes:', error);
      throw error;
    }

    return data;
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
    console.log('Token consultado en backend:', token);
    
    // Intentamos consulta directa primero para obtener la relación anidada
    const directResult = await supabase
      .from('participantes')
      .select('*, encuentros(*)')
      .eq('token_invitacion', token)
      .single();
      
    if (!directResult.error && directResult.data) {
       console.log('Resultado de búsqueda directa en DB:', directResult);
       return directResult.data;
    }

    // Si la directa falla (por RLS u otro motivo), usamos el RPC como fallback
    const { data, error } = await supabase
      .rpc('get_participante_seguro', { p_token: token });

    console.log('Resultado de búsqueda RPC en DB:', { data, error });

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

  async updateParticipanteEstado(id: string, estado: 'confirmado' | 'rechazado', user_id?: string | null, nombre_invitado?: string) {
    const respondido_en = new Date().toISOString();
    const updatePayload: Record<string, any> = { estado, respondido_en };
    if (nombre_invitado) updatePayload.nombre_invitado = nombre_invitado;
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

  async addParticipanteGenerico(encuentro_id: string, nombre_invitado: string, estado: 'confirmado' | 'rechazado', user_id?: string | null) {
    const respondido_en = new Date().toISOString();
    const token_invitacion = crypto.randomUUID();
    const insertPayload: Record<string, any> = {
      encuentro_id,
      nombre_invitado,
      tipo_invitacion: 'generico',
      estado,
      respondido_en,
      token_invitacion,
    };
    if (user_id !== undefined && user_id !== null) insertPayload.user_id = user_id;

    const { data, error } = await supabase
      .from('participantes')
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      console.error('Error adding participante generico:', error);
      throw error;
    }

    return data;
  },

  async linkUserToParticipante(participantId: string, userId: string) {
    if (!participantId || !userId) return;
    console.log(`[LINK_PART] Vinculando participante ${participantId} a user ${userId}`);

    const { error } = await supabase
      .from('participantes')
      .update({ user_id: userId })
      .eq('id', participantId);

    if (error) {
      console.error('Error linking user to participante:', error);
      throw error;
    }
  },
};
