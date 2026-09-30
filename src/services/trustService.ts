import { supabase } from '@/lib/supabase';
import type {
  PerfilConfianzaResult,
  CrearReporteParams,
  CrearReporteResult,
} from '@/types/trust';

export const trustService = {
  /**
   * Obtiene la ficha factual de actividad previa de un solicitante.
   *
   * SEGURIDAD:
   * - Solo se envía el solicitud_id.
   * - La identidad del solicitante y la autorización del host se validan en PostgreSQL server-side.
   * - Acceso exclusivo mediante RPC segura (RPC-only, sin acceso directo a tablas).
   */
  async getPerfilConfianzaSolicitante(solicitudId: string): Promise<PerfilConfianzaResult> {
    if (!solicitudId) {
      return { ok: false, error: 'invalid_solicitud_id' };
    }

    try {
      const { data, error } = await supabase.rpc('get_perfil_confianza_solicitante', {
        p_solicitud_id: solicitudId,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      if (!data || typeof data !== 'object') {
        return { ok: false, error: 'invalid_response_format' };
      }

      return data as PerfilConfianzaResult;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Crea un reporte contextual seguro mediante RPC.
   *
   * SEGURIDAD:
   * - Solo envía solicitudId, contexto, motivo y detalle.
   * - NO envía reporter_id, reported_id ni encuentro_id (se derivan server-side).
   * - Acceso exclusivo RPC-only (sin SELECT ni INSERT directo a tablas).
   */
  async crearReporteSeguro(params: CrearReporteParams): Promise<CrearReporteResult> {
    const { solicitudId, contexto, motivo, detalle } = params;
    if (!solicitudId) {
      return { ok: false, error: 'invalid_solicitud_id' };
    }

    try {
      const { data, error } = await supabase.rpc('crear_reporte_seguro', {
        p_solicitud_id: solicitudId,
        p_contexto: contexto,
        p_motivo: motivo,
        p_detalle: detalle ? detalle.trim() : null,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      if (!data || typeof data !== 'object') {
        return { ok: false, error: 'invalid_response_format' };
      }

      return data as CrearReporteResult;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'network_error' };
    }
  },
};
