import { supabase } from '@/lib/supabase';
import type {
  PerfilConfianzaResult,
  CrearReporteParams,
  CrearReporteResult,
  ContextualBlockState,
  ContextualBlockActionResult,
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

  /**
   * Consulta el estado propio de bloqueo a partir de una solicitud (Fase 2.0-C1 T3-B).
   *
   * SEGURIDAD:
   * - Solo envía solicitudId.
   * - La contraparte y la pertenencia a la solicitud se derivan server-side.
   * - blocked_by_me indica EXCLUSIVAMENTE si el usuario autenticado bloqueó a la contraparte.
   */
  async getEstadoBloqueoDesdeSolicitud(solicitudId: string): Promise<ContextualBlockState> {
    if (!solicitudId) {
      return { ok: false, blockedByMe: false, error: 'invalid_solicitud_id' };
    }

    try {
      const { data, error } = await supabase.rpc('get_estado_bloqueo_desde_solicitud_seguro', {
        p_solicitud_id: solicitudId,
      });

      if (error) {
        return { ok: false, blockedByMe: false, error: error.message };
      }

      if (!data || typeof data !== 'object') {
        return { ok: false, blockedByMe: false, error: 'invalid_response_format' };
      }

      return {
        ok: Boolean(data.ok),
        blockedByMe: Boolean(data.blocked_by_me),
      };
    } catch (err: any) {
      return { ok: false, blockedByMe: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Bloquea a la contraparte derivándola server-side desde la solicitud (T3-A1 / T3-B).
   *
   * SEGURIDAD:
   * - Solo envía solicitudId.
   * - No requiere ni recibe UUID de contraparte.
   */
  async bloquearDesdeSolicitud(solicitudId: string): Promise<ContextualBlockActionResult> {
    if (!solicitudId) {
      return { ok: false, blocked: false, error: 'invalid_solicitud_id' };
    }

    try {
      const { data, error } = await supabase.rpc('bloquear_desde_solicitud_seguro', {
        p_solicitud_id: solicitudId,
      });

      if (error) {
        return { ok: false, blocked: false, error: error.message };
      }

      if (!data || typeof data !== 'object') {
        return { ok: false, blocked: false, error: 'invalid_response_format' };
      }

      return {
        ok: Boolean(data.ok),
        blocked: Boolean(data.blocked ?? true),
      };
    } catch (err: any) {
      return { ok: false, blocked: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Desbloquea a la contraparte derivándola server-side desde la solicitud (T3-B0 / T3-B).
   *
   * SEGURIDAD:
   * - Solo envía solicitudId.
   * - Elimina exclusivamente el bloqueo propio (blocker_id = auth.uid()).
   * - Es idempotente.
   */
  async desbloquearDesdeSolicitud(solicitudId: string): Promise<ContextualBlockActionResult> {
    if (!solicitudId) {
      return { ok: false, blocked: false, error: 'invalid_solicitud_id' };
    }

    try {
      const { data, error } = await supabase.rpc('desbloquear_desde_solicitud_seguro', {
        p_solicitud_id: solicitudId,
      });

      if (error) {
        return { ok: false, blocked: false, error: error.message };
      }

      if (!data || typeof data !== 'object') {
        return { ok: false, blocked: false, error: 'invalid_response_format' };
      }

      return {
        ok: Boolean(data.ok),
        blocked: Boolean(data.blocked ?? false),
      };
    } catch (err: any) {
      return { ok: false, blocked: false, error: err?.message || 'network_error' };
    }
  },
};
