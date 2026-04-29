import { supabase } from '@/lib/supabase';

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
}

export const encuentrosService = {
  async createEncuentro(data: CreateEncuentroDTO) {
    const { data: result, error } = await supabase
      .from('encuentros')
      .insert([data])
      .select()
      .single();

    if (error) {
      console.error('Error creating encuentro:', error);
      throw error;
    }

    return result;
  },

  async getEncuentrosByHost(host_id: string) {
    const { data, error } = await supabase
      .from('encuentros')
      .select('*')
      .eq('host_id', host_id)
      .order('creado_en', { ascending: false });

    if (error) {
      console.error('Error fetching encuentros by host:', error);
      throw error;
    }

    return data;
  },

  async getEncuentroById(id: string) {
    const { data, error } = await supabase
      .from('encuentros')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching encuentro by id:', error);
      throw error;
    }

    return data;
  },

  async getEncuentroByPublicToken(public_token: string) {
    const { data, error } = await supabase
      .from('encuentros')
      .select('*')
      .eq('public_token', public_token)
      .single();

    if (error) {
      console.error('Error fetching encuentro by public token:', error);
      throw error;
    }

    return data;
  },

  async cancelarEncuentro(id: string) {
    console.log('[CANCEL] Iniciando cancelación. encuentroId:', id);
    
    const { data, error } = await supabase
      .from('encuentros')
      .update({ estado: 'cancelado' })
      .eq('id', id)
      .select();

    if (error) {
      console.error('[CANCEL] Error al cancelar encuentro:', error);
      throw error;
    }

    if (!data || data.length === 0) {
      console.error('[CANCEL] No se pudo cancelar el encuentro. No se actualizó ningún registro.');
      throw new Error('No se pudo cancelar. Verifique los permisos o si el encuentro existe.');
    }

    console.log('[CANCEL] Cancelación exitosa. Resultado:', data[0]);
    return data[0];
  },
};
