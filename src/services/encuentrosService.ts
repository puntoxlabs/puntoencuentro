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

  async getEncuentrosByHostIds(host_ids: string[]) {
    // Filtrar ids vacíos/null y deduplicar
    const ids = [...new Set(host_ids.filter(Boolean))];
    if (ids.length === 0) return [];

    const { data, error } = await supabase
      .from('encuentros')
      .select('*')
      .in('host_id', ids)
      .order('creado_en', { ascending: false });

    if (error) {
      console.error('Error fetching encuentros by host ids:', error);
      throw error;
    }

    // Deduplicar por id (por si acaso haya solapamiento futuro)
    const seen = new Set<string>();
    return (data || []).filter(enc => {
      if (seen.has(enc.id)) return false;
      seen.add(enc.id);
      return true;
    });
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
      console.error("[CANCEL ERROR FULL]", error);
      alert(error.message || JSON.stringify(error));
      throw error;
    }

    if (!data || data.length === 0) {
      console.error("[CANCEL ERROR FULL]", "No se actualizó ningún registro (data vacío)");
      alert("Error Supabase: No se modificaron filas. Verifique permisos RLS para UPDATE en la tabla 'encuentros'.");
      throw new Error("No se pudo cancelar. Verifique los permisos o si el encuentro existe.");
    }

    console.log('[CANCEL] Cancelación exitosa. Resultado:', data[0]);
    return data[0];
  },

  async deleteEncuentro(id: string) {
    console.log('[DELETE] encuentroId:', id);

    const { data, error } = await supabase
      .from('encuentros')
      .delete()
      .eq('id', id)
      .select();

    console.log('[DELETE] data:', data);
    console.log('[DELETE] error:', error);

    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('DELETE ejecutado pero no eliminó filas. Revisar RLS o id.');
    }
    return data;
  },

  async getEncuentrosParticipados(userId: string) {
    if (!userId) return [];

    const { data, error } = await supabase
      .from('participantes')
      .select('encuentros(*)')
      .eq('user_id', userId)
      .eq('estado', 'confirmado');

    if (error) {
      console.error('Error fetching encuentros participados:', error);
      throw error;
    }

    // Mapear a Encuentro[], filtrar nulls y deduplicar
    const seen = new Set<string>();
    const encuentros = (data || [])
      .map(p => p.encuentros as any)
      .filter((enc): enc is any => {
        if (!enc || seen.has(enc.id)) return false;
        seen.add(enc.id);
        return true;
      });

    return encuentros;
  },

  async linkAnonymousEncuentros(anonId: string, userId: string) {
    if (!anonId || !userId || anonId === userId) return;

    console.log(`[LINK] Vinculando encuentros de ${anonId} a ${userId}`);

    const { data, error } = await supabase
      .from('encuentros')
      .update({ host_id: userId })
      .eq('host_id', anonId);

    if (error) {
      console.error('Error linking anonymous encuentros:', error);
      throw error;
    }

    return data;
  },
};
