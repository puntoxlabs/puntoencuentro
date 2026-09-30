import { supabase } from '../lib/supabase';
import type {
  AlertaCompatibilidad,
  AlertasServiceResult,
  MarcarLeidaResult,
} from '../types/alertas';

export const alertasService = {
  /**
   * Obtiene las alertas privadas del usuario autenticado vía RPC segura.
   * La identidad proviene exclusivamente de auth.uid() server-side.
   * Nunca envía user_id desde el cliente.
   */
  async getMisAlertas(): Promise<AlertasServiceResult<AlertaCompatibilidad[]>> {
    try {
      const { data, error } = await supabase.rpc('get_mis_alertas_seguro');
      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as {
        ok: boolean;
        alertas?: AlertaCompatibilidad[];
        data?: AlertaCompatibilidad[];
        error?: string;
      };
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'unknown_error' };
      }
      return { ok: true, data: res.alertas || res.data || [] };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Marca una alerta como leída vía RPC segura.
   * Valida pertenencia server-side, idempotente.
   * Nunca permite alterar user_id ni campos del target.
   */
  async marcarLeida(alertaId: string): Promise<AlertasServiceResult<MarcarLeidaResult>> {
    try {
      if (!alertaId) {
        return { ok: false, error: 'invalid_alerta_id' };
      }
      const { data, error } = await supabase.rpc('marcar_alerta_leida_seguro', {
        p_alerta_id: alertaId,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as {
        ok: boolean;
        id?: string;
        leida?: boolean;
        idempotent?: boolean;
        error?: string;
      };
      if (!res?.ok || !res.id) {
        return { ok: false, error: res?.error || 'unknown_error' };
      }
      return {
        ok: true,
        data: { id: res.id, leida: res.leida ?? true },
        idempotent: res.idempotent,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },
};
