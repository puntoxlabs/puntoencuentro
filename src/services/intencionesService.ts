import { supabase } from '../lib/supabase';
import type {
  Intencion,
  CrearIntencionPayload,
  EditarIntencionPayload,
  EstadoIntencion,
  IntencionesServiceResult,
} from '../types/intenciones';

export const intencionesService = {
  /**
   * Obtiene las intenciones propias del usuario autenticado vía RPC segura.
   */
  async getMisIntenciones(): Promise<IntencionesServiceResult<Intencion[]>> {
    try {
      const { data, error } = await supabase.rpc('get_mis_intenciones_seguro');
      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as { ok: boolean; intenciones?: Intencion[]; error?: string };
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'unknown_error' };
      }
      return { ok: true, data: res.intenciones || [] };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Crea una nueva intención vinculada automáticamente a auth.uid().
   * Nunca envía user_id desde cliente.
   */
  async crearIntencion(payload: CrearIntencionPayload): Promise<IntencionesServiceResult<string>> {
    try {
      const { data, error } = await supabase.rpc('crear_intencion_segura', {
        p_titulo: payload.titulo,
        p_descripcion: payload.descripcion ?? null,
        p_temporalidad_texto: payload.temporalidad_texto ?? null,
        p_fecha_desde: payload.fecha_desde ?? null,
        p_fecha_hasta: payload.fecha_hasta ?? null,
        p_modalidad: payload.modalidad ?? 'presencial',
        p_locality_id: payload.locality_id ?? null,
      });

      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as { ok: boolean; id?: string; error?: string };
      if (!res?.ok || !res.id) {
        return { ok: false, error: res?.error || 'creation_failed' };
      }
      return { ok: true, data: res.id };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Modifica el contenido de una intención existente perteneciente a auth.uid().
   * Sólo envía campos permitidos de contenido.
   */
  async editarIntencion(payload: EditarIntencionPayload): Promise<IntencionesServiceResult<string>> {
    try {
      const { data, error } = await supabase.rpc('editar_intencion_segura', {
        p_id: payload.id,
        p_titulo: payload.titulo,
        p_descripcion: payload.descripcion ?? null,
        p_temporalidad_texto: payload.temporalidad_texto ?? null,
        p_fecha_desde: payload.fecha_desde ?? null,
        p_fecha_hasta: payload.fecha_hasta ?? null,
        p_modalidad: payload.modalidad ?? 'presencial',
        p_locality_id: payload.locality_id ?? null,
      });

      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as { ok: boolean; id?: string; error?: string };
      if (!res?.ok || !res.id) {
        return { ok: false, error: res?.error || 'edit_failed' };
      }
      return { ok: true, data: res.id };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Cambia el estado del ciclo de vida de una intención propia.
   */
  async cambiarEstado(id: string, nuevoEstado: EstadoIntencion): Promise<IntencionesServiceResult<EstadoIntencion>> {
    try {
      const { data, error } = await supabase.rpc('cambiar_estado_intencion_segura', {
        p_id: id,
        p_nuevo_estado: nuevoEstado,
      });

      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as { ok: boolean; id?: string; estado?: EstadoIntencion; error?: string };
      if (!res?.ok || !res.estado) {
        return { ok: false, error: res?.error || 'state_change_failed' };
      }
      return { ok: true, data: res.estado };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Pausa temporalmente una intención activa.
   */
  async pausarIntencion(id: string): Promise<IntencionesServiceResult<EstadoIntencion>> {
    return this.cambiarEstado(id, 'pausada');
  },

  /**
   * Reactiva una intención pausada.
   */
  async reactivarIntencion(id: string): Promise<IntencionesServiceResult<EstadoIntencion>> {
    return this.cambiarEstado(id, 'activa');
  },

  /**
   * Cierra una intención (soft delete mediante estado 'cerrada').
   * NO ejecuta DELETE físico en base de datos.
   */
  async cerrarIntencion(id: string): Promise<IntencionesServiceResult<EstadoIntencion>> {
    return this.cambiarEstado(id, 'cerrada');
  },

  /**
   * Convierte una intención propia (activa o pausada) a un encuentro real existente
   * perteneciente al mismo usuario, invocando la RPC convertir_intencion_a_encuentro.
   */
  async convertirIntencionAEncuentro(
    intencionId: string,
    encuentroId: string
  ): Promise<IntencionesServiceResult<{ id: string; estado: EstadoIntencion; encuentro_id: string; idempotent?: boolean }>> {
    try {
      const { data, error } = await supabase.rpc('convertir_intencion_a_encuentro', {
        p_intencion_id: intencionId,
        p_encuentro_id: encuentroId,
      });

      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as {
        ok: boolean;
        id?: string;
        estado?: EstadoIntencion;
        encuentro_id?: string;
        idempotent?: boolean;
        error?: string;
      };
      if (!res?.ok || !res.id || !res.estado || !res.encuentro_id) {
        return { ok: false, error: res?.error || 'conversion_failed' };
      }
      return {
        ok: true,
        data: {
          id: res.id,
          estado: res.estado,
          encuentro_id: res.encuentro_id,
          idempotent: res.idempotent,
        },
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },
};
