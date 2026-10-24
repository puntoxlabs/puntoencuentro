import { supabase } from '@/lib/supabase';
import type {
  DetalleCierrePostEvento,
  CerrarPostEventoPayload,
  CerrarPostEventoResult,
  PendingClosuresResponse,
  PendingClosureItem,
} from '@/types/postEventClosure';

export const postEventClosureService = {
  /**
   * Obtiene el detalle de cierre posterior para el anfitrión autorizado.
   */
  async getDetalleCierre(encuentroId: string): Promise<DetalleCierrePostEvento> {
    if (!encuentroId) {
      return { ok: false, error: 'invalid_encuentro_id' };
    }

    try {
      const { data, error } = await supabase.rpc('get_detalle_cierre_post_evento_seguro', {
        p_encuentro_id: encuentroId,
      });

      if (error) {
        console.error('[postEventClosureService] Error fetching detalle cierre:', error);
        return { ok: false, error: error.message };
      }

      return (data as DetalleCierrePostEvento) || { ok: false, error: 'empty_response' };
    } catch (err: any) {
      console.error('[postEventClosureService] Exception in getDetalleCierre:', err);
      return { ok: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Cierra de forma segura y transaccional el ciclo posterior del encuentro y registra asistencias.
   */
  async cerrarEncuentro(payload: CerrarPostEventoPayload): Promise<CerrarPostEventoResult> {
    const { encuentroId, realizationStatus, unrealizedReason, asistencias } = payload;
    if (!encuentroId) {
      return { ok: false, error: 'invalid_encuentro_id' };
    }

    try {
      const { data, error } = await supabase.rpc('cerrar_encuentro_post_evento_seguro', {
        p_encuentro_id: encuentroId,
        p_realization_status: realizationStatus,
        p_unrealized_reason: unrealizedReason ?? null,
        p_asistencias: asistencias ?? [],
      });

      if (error) {
        console.error('[postEventClosureService] Error cerrando encuentro post-evento:', error);
        return { ok: false, error: error.message };
      }

      return (data as CerrarPostEventoResult) || { ok: false, error: 'empty_response' };
    } catch (err: any) {
      console.error('[postEventClosureService] Exception in cerrarEncuentro:', err);
      return { ok: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Consulta si el anfitrión tiene cierres pendientes o vencidos.
   */
  async getCierresPendientesHost(): Promise<PendingClosureItem[]> {
    try {
      const { data, error } = await supabase.rpc('get_cierres_pendientes_host_seguro');
      if (error) {
        console.warn('[postEventClosureService] Error fetching pending closures:', error);
        return [];
      }

      const res = data as PendingClosuresResponse;
      if (!res?.ok || !Array.isArray(res.pending_closures)) {
        return [];
      }

      return res.pending_closures;
    } catch (err) {
      console.warn('[postEventClosureService] Exception in getCierresPendientesHost:', err);
      return [];
    }
  },
};
