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
    const { data, error } = await supabase
      .rpc('get_participante_seguro', { p_token: token });

    console.log('Resultado de búsqueda en DB:', { data, error });

    if (error) {
      console.error('Error fetching participante by token:', error);
      throw error;
    }

    return data;
  },

  async updateParticipanteEstado(id: string, estado: 'confirmado' | 'rechazado') {
    const respondido_en = new Date().toISOString();
    const { data, error } = await supabase
      .from('participantes')
      .update({ estado, respondido_en })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating participante estado:', error);
      throw error;
    }

    return data;
  },

  async addParticipanteGenerico(encuentro_id: string, nombre_invitado: string, estado: 'confirmado' | 'rechazado') {
    const respondido_en = new Date().toISOString();
    const token_invitacion = crypto.randomUUID();
    const { data, error } = await supabase
      .from('participantes')
      .insert([{
        encuentro_id,
        nombre_invitado,
        tipo_invitacion: 'generico',
        estado,
        respondido_en,
        token_invitacion
      }])
      .select()
      .single();

    if (error) {
      console.error('Error adding participante generico:', error);
      throw error;
    }

    return data;
  }
};
