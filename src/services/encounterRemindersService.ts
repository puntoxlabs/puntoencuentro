import { supabase } from '@/lib/supabase';
import type {
  EncounterRemindersResponse,
  ProcessRemindersResponse,
} from '@/types/encounterReminders';

export const encounterRemindersService = {
  /**
   * Consulta el registro de recordatorios asociados a un encuentro.
   * - Anfitrión: resumen global del encuentro.
   * - Participante: sus propios recordatorios recibidos.
   */
  async getEncounterReminders(encuentroId: string): Promise<EncounterRemindersResponse> {
    try {
      const { data, error } = await supabase.rpc('get_recordatorios_encuentro_seguro', {
        p_encuentro_id: encuentroId,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      return (data as EncounterRemindersResponse) || { ok: false, error: 'No data returned' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Error al consultar recordatorios' };
    }
  },

  /**
   * Dispara el procesamiento durable de recordatorios 24h y 2h.
   * Utilizado principalmente por tareas de fondo (cron/worker) o pruebas de integración.
   */
  async processOpenEncounterReminders(workerId: string = 'client-worker'): Promise<ProcessRemindersResponse> {
    try {
      const { data, error } = await supabase.rpc('procesar_recordatorios_encuentros_abiertos_seguro', {
        p_worker_id: workerId,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      return (data as ProcessRemindersResponse) || { ok: false, error: 'No data returned' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Error al procesar recordatorios' };
    }
  },
};
