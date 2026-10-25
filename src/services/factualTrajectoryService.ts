/**
 * Servicio de Trayectoria Factual en Encuentros Abiertos (Mini-Sprint D).
 * Conecta con la RPC segura get_trayectoria_encuentros_abiertos_seguro.
 */

import { supabase } from '@/lib/supabase';
import type { FactualTrajectoryResponse } from '@/types/factualTrajectory';

export const factualTrajectoryService = {
  /**
   * Obtiene la base factual y trayectoria en Encuentros Abiertos del usuario actual
   * o de un target_id específico si el llamador es moderador autorizado.
   */
  async getTrayectoria(userId?: string): Promise<FactualTrajectoryResponse> {
    try {
      const { data, error } = await supabase.rpc('get_trayectoria_encuentros_abiertos_seguro', {
        p_user_id: userId || null,
      });

      if (error) {
        console.error('[factualTrajectoryService] Error RPC:', error);
        return {
          ok: false,
          error: error.message,
        };
      }

      return (data as FactualTrajectoryResponse) || {
        ok: false,
        error: 'empty_response',
      };
    } catch (err: any) {
      console.error('[factualTrajectoryService] Error inesperado:', err);
      return {
        ok: false,
        error: err?.message || 'network_error',
      };
    }
  },
};
