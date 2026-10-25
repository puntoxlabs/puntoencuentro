import { supabase } from '@/lib/supabase';
import type {
  AttendanceDisputeItem,
  AttendanceDisputeDetail,
  AttendanceDisputeResponseDecision,
  FactualAttendanceHistory,
} from '@/types/attendanceDispute';

export const attendanceDisputeService = {
  /**
   * Envía la respuesta o descargo del participante frente a un reporte de inasistencia.
   */
  async responderControversia(
    disputeId: string,
    decision: AttendanceDisputeResponseDecision,
    descargoTexto?: string
  ): Promise<{ ok: boolean; status?: string; attendance_status?: string; error?: string; message?: string }> {
    try {
      const { data, error } = await supabase.rpc('responder_controversia_asistencia_seguro', {
        p_dispute_id: disputeId,
        p_decision: decision,
        p_descargo_texto: descargoTexto ?? null,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      return (data as any) || { ok: false, error: 'empty_response' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Inicia una controversia sobre la realización de un encuentro o conducta del host.
   */
  async iniciarControversiaRealizacion(
    encuentroId: string,
    tipoControversia: 'encounter_not_realized' | 'host_no_show' | 'closure_data_error',
    motivo: string
  ): Promise<{ ok: boolean; dispute_id?: string; status?: string; error?: string; message?: string }> {
    try {
      const { data, error } = await supabase.rpc('iniciar_controversia_realizacion_seguro', {
        p_encuentro_id: encuentroId,
        p_tipo_controversia: tipoControversia,
        p_motivo: motivo,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      return (data as any) || { ok: false, error: 'empty_response' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Aporta aclaraciones por parte de la contraparte a una controversia activa.
   */
  async aportarAclaracion(
    disputeId: string,
    aclaracionTexto: string
  ): Promise<{ ok: boolean; dispute_id?: string; error?: string; message?: string }> {
    try {
      const { data, error } = await supabase.rpc('aportar_aclaracion_controversia_seguro', {
        p_dispute_id: disputeId,
        p_aclaracion_texto: aclaracionTexto,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      return (data as any) || { ok: false, error: 'empty_response' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Obtiene la lista de controversias en las que el usuario autenticado es parte.
   */
  async getMisControversias(): Promise<{ ok: boolean; controversias: AttendanceDisputeItem[]; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('get_mis_controversias_asistencia_seguro');
      if (error) {
        return { ok: false, controversias: [], error: error.message };
      }

      const res = data as any;
      return {
        ok: true,
        controversias: Array.isArray(res?.controversias) ? res.controversias : [],
      };
    } catch (err: any) {
      return { ok: false, controversias: [], error: err?.message || 'network_error' };
    }
  },

  /**
   * Obtiene el detalle completo y auditoría de una controversia.
   */
  async getDetalleControversia(disputeId: string): Promise<{ ok: boolean; dispute?: AttendanceDisputeDetail; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('get_detalle_controversia_seguro', {
        p_dispute_id: disputeId,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      const res = data as any;
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'dispute_not_found' };
      }

      return { ok: true, dispute: res as AttendanceDisputeDetail };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Proyección factual de historial de asistencia y controversias.
   */
  async getHistorialAsistenciaFactual(userId?: string): Promise<FactualAttendanceHistory> {
    try {
      const { data, error } = await supabase.rpc('get_historial_asistencia_factual_seguro', {
        p_user_id: userId ?? null,
      });

      if (error) {
        return {
          ok: false,
          total_encuentros_participados: 0,
          asistencias_declaradas: 0,
          asistencias_verificadas: 0,
          inasistencias_reportadas_pendientes: 0,
          inasistencias_reconocidas: 0,
          inasistencias_moderadas: 0,
          reportes_rectificados_o_desestimados: 0,
          controversias_organizador_recibidas: 0,
          controversias_organizador_iniciadas: 0,
          error: error.message,
        };
      }

      return (data as FactualAttendanceHistory) || {
        ok: false,
        total_encuentros_participados: 0,
        asistencias_declaradas: 0,
        asistencias_verificadas: 0,
        inasistencias_reportadas_pendientes: 0,
        inasistencias_reconocidas: 0,
        inasistencias_moderadas: 0,
        reportes_rectificados_o_desestimados: 0,
        controversias_organizador_recibidas: 0,
        controversias_organizador_iniciadas: 0,
        error: 'empty_response',
      };
    } catch (err: any) {
      return {
        ok: false,
        total_encuentros_participados: 0,
        asistencias_declaradas: 0,
        asistencias_verificadas: 0,
        inasistencias_reportadas_pendientes: 0,
        inasistencias_reconocidas: 0,
        inasistencias_moderadas: 0,
        reportes_rectificados_o_desestimados: 0,
        controversias_organizador_recibidas: 0,
        controversias_organizador_iniciadas: 0,
        error: err?.message || 'network_error',
      };
    }
  },
};
