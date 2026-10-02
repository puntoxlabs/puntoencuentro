import { supabase } from '../lib/supabase';
import type {
  MatchAlertSubscription,
  CrearAlertaParams,
  CrearAlertaResponse,
  GetMisAlertasResponse,
  AlertaLifecycleResponse,
} from '../types/matchAlerts';

export const matchAlertsService = {
  /**
   * Crea una nueva suscripción explícita 'Avisame' para el usuario autenticado permanente.
   */
  async crearAlerta(params: CrearAlertaParams): Promise<CrearAlertaResponse> {
    try {
      const { data, error } = await supabase.rpc('crear_alerta_suscripcion_seguro', {
        p_modalidad: params.modalidad || null,
        p_locality_id: params.localityId || null,
        p_fecha_desde: params.fechaDesde || null,
        p_fecha_hasta: params.fechaHasta || null,
        p_hora_desde: params.horaDesde || null,
        p_hora_hasta: params.horaHasta || null,
        p_expires_at: params.expiresAt || null,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      const res = data as { ok: boolean; subscription?: any; error?: string };
      if (!res?.ok || !res.subscription) {
        return { ok: false, error: res?.error || 'unknown_error' };
      }

      return {
        ok: true,
        subscription: {
          id: res.subscription.id,
          userId: res.subscription.user_id,
          status: res.subscription.status,
          modalidad: res.subscription.modalidad,
          localityId: res.subscription.locality_id,
          fechaDesde: res.subscription.fecha_desde,
          fechaHasta: res.subscription.fecha_hasta,
          horaDesde: res.subscription.hora_desde,
          horaHasta: res.subscription.hora_hasta,
          expiresAt: res.subscription.expires_at,
          createdAt: res.subscription.created_at,
          updatedAt: res.subscription.updated_at,
        },
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Obtiene las alertas del usuario autenticado con su estado de vigencia actualizado.
   */
  async getMisAlertas(): Promise<GetMisAlertasResponse> {
    try {
      const { data, error } = await supabase.rpc('get_mis_alertas_suscripciones_seguro');

      if (error) {
        return { ok: false, subscriptions: [], error: error.message };
      }

      const res = data as { ok: boolean; subscriptions?: any[]; error?: string };
      if (!res?.ok) {
        return { ok: false, subscriptions: [], error: res?.error || 'unknown_error' };
      }

      const subscriptions: MatchAlertSubscription[] = (res.subscriptions || []).map((row) => ({
        id: row.id,
        userId: row.user_id,
        status: row.status,
        modalidad: row.modalidad,
        localityId: row.locality_id,
        localityNombre: row.locality_nombre,
        fechaDesde: row.fecha_desde,
        fechaHasta: row.fecha_hasta,
        horaDesde: row.hora_desde,
        horaHasta: row.hora_hasta,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return { ok: true, subscriptions };
    } catch (err: any) {
      return { ok: false, subscriptions: [], error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Pausa una alerta activa propia.
   */
  async pausarAlerta(subscriptionId: string): Promise<AlertaLifecycleResponse> {
    try {
      const { data, error } = await supabase.rpc('pausar_alerta_suscripcion_seguro', {
        p_subscription_id: subscriptionId,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      const res = data as { ok: boolean; id?: string; status?: any; error?: string };
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'unknown_error' };
      }

      return { ok: true, id: res.id, status: res.status };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Reactiva una alerta pausada propia.
   */
  async reactivarAlerta(subscriptionId: string): Promise<AlertaLifecycleResponse> {
    try {
      const { data, error } = await supabase.rpc('reactivar_alerta_suscripcion_seguro', {
        p_subscription_id: subscriptionId,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      const res = data as { ok: boolean; id?: string; status?: any; error?: string };
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'unknown_error' };
      }

      return { ok: true, id: res.id, status: res.status };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Cancela permanentemente una alerta propia.
   */
  async cancelarAlerta(subscriptionId: string): Promise<AlertaLifecycleResponse> {
    try {
      const { data, error } = await supabase.rpc('cancelar_alerta_suscripcion_seguro', {
        p_subscription_id: subscriptionId,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      const res = data as { ok: boolean; id?: string; status?: any; error?: string };
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'unknown_error' };
      }

      return { ok: true, id: res.id, status: res.status };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },
};
