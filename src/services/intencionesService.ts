import { supabase } from '../lib/supabase';
import type {
  Intencion,
  CrearIntencionPayload,
  EditarIntencionPayload,
  EstadoIntencion,
  IntencionesServiceResult,
  PublicIntencionSummary,
  SetInteresResult,
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

  /**
   * Obtiene las intenciones públicas activas para Discovery desde la RPC segura get_discovery_intenciones_activas.
   * Filtra por localidades seleccionadas si se proporcionan.
   * NUNCA expone user_id, encuentro_id, updated_at ni datos de contacto.
   */
  async getDiscoveryIntenciones(
    localityIds?: string[]
  ): Promise<IntencionesServiceResult<PublicIntencionSummary[]>> {
    try {
      const { data, error } = await supabase.rpc('get_discovery_intenciones_activas', {
        p_locality_ids: localityIds && localityIds.length > 0 ? localityIds : null,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      if (!Array.isArray(data)) {
        return { ok: true, data: [] };
      }

      const mapped: PublicIntencionSummary[] = data.map((item: any) => ({
        id: item.id,
        titulo: item.titulo,
        descripcion: item.descripcion ?? null,
        temporalidad_texto: item.temporalidad_texto ?? null,
        fecha_desde: item.fecha_desde ?? null,
        fecha_hasta: item.fecha_hasta ?? null,
        modalidad: item.modalidad,
        locality_id: item.locality_id ?? null,
        approximate_zone: item.approximate_zone,
        interested_count: Number(item.interested_count ?? 0),
        created_at: item.created_at,
        is_own: Boolean(item.is_own),
        viewer_interested: Boolean(item.viewer_interested),
      }));

      return { ok: true, data: mapped };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Registra o retira interés sobre una intención ajena de forma idempotente vía RPC set_interes_intencion.
   * NO implementa toggle en cliente: el valor 'interesado' debe enviarse explícitamente.
   */
  async setInteresIntencion(
    intencionId: string,
    interesado: boolean
  ): Promise<IntencionesServiceResult<SetInteresResult>> {
    try {
      const { data, error } = await supabase.rpc('set_interes_intencion', {
        p_intencion_id: intencionId,
        p_interesado: interesado,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      const res = data as { ok: boolean; interesado?: boolean; interested_count?: number; error?: string };
      if (!res?.ok || typeof res.interesado !== 'boolean' || typeof res.interested_count !== 'number') {
        return { ok: false, error: res?.error || 'set_interest_failed' };
      }

      return {
        ok: true,
        data: {
          ok: true,
          interesado: res.interesado,
          interested_count: res.interested_count,
        },
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },
};
