import { supabase } from '@/lib/supabase';
import type {
  GetMensajesResponse,
  PublicarMensajeResponse,
  EditarMensajeResponse,
  EliminarMensajeResponse,
  DestacarMensajeResponse,
} from '@/types/mensajes';

export const mensajesService = {
  /**
   * Obtiene la lista cronológica de mensajes, mensajes destacados y capacidades del actor.
   */
  async getMensajes(
    encuentroId: string,
    tokenInvitacion?: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<GetMensajesResponse> {
    try {
      const { data, error } = await supabase.rpc('get_mensajes_encuentro_seguro', {
        p_encuentro_id: encuentroId,
        p_token_invitacion: tokenInvitacion || null,
        p_limit: limit,
        p_offset: offset,
      });

      if (error) {
        if (import.meta.env.DEV) console.error('[mensajesService] getMensajes RPC error:', error);
        return {
          ok: false,
          is_host: false,
          can_write: false,
          writing_window_closed: false,
          destacados: [],
          mensajes: [],
          total_count: 0,
          has_more: false,
          error: error.message || 'error_obteniendo_mensajes',
        };
      }

      const res = (typeof data === 'string' ? JSON.parse(data) : data) as GetMensajesResponse;
      return res;
    } catch (err: any) {
      if (import.meta.env.DEV) console.error('[mensajesService] getMensajes unexpected error:', err);
      return {
        ok: false,
        is_host: false,
        can_write: false,
        writing_window_closed: false,
        destacados: [],
        mensajes: [],
        total_count: 0,
        has_more: false,
        error: err?.message || 'error_inesperado',
      };
    }
  },

  /**
   * Publica un mensaje en el encuentro (hasta 500 caracteres, opcionalmente respondiendo a parent_id).
   */
  async publicarMensaje(
    encuentroId: string,
    contenido: string,
    parentId?: string,
    tokenInvitacion?: string
  ): Promise<PublicarMensajeResponse> {
    try {
      const { data, error } = await supabase.rpc('publicar_mensaje_encuentro_seguro', {
        p_encuentro_id: encuentroId,
        p_contenido: contenido.trim(),
        p_parent_id: parentId || null,
        p_token_invitacion: tokenInvitacion || null,
      });

      if (error) {
        if (import.meta.env.DEV) console.error('[mensajesService] publicarMensaje RPC error:', error);
        return { ok: false, error: error.message || 'error_publicando_mensaje' };
      }

      const res = (typeof data === 'string' ? JSON.parse(data) : data) as PublicarMensajeResponse;
      return res;
    } catch (err: any) {
      if (import.meta.env.DEV) console.error('[mensajesService] publicarMensaje unexpected error:', err);
      return { ok: false, error: err?.message || 'error_inesperado' };
    }
  },

  /**
   * Edita un mensaje propio dentro de los primeros 15 minutos.
   */
  async editarMensaje(
    mensajeId: string,
    contenido: string,
    tokenInvitacion?: string
  ): Promise<EditarMensajeResponse> {
    try {
      const { data, error } = await supabase.rpc('editar_mensaje_encuentro_seguro', {
        p_mensaje_id: mensajeId,
        p_contenido: contenido.trim(),
        p_token_invitacion: tokenInvitacion || null,
      });

      if (error) {
        if (import.meta.env.DEV) console.error('[mensajesService] editarMensaje RPC error:', error);
        return { ok: false, error: error.message || 'error_editando_mensaje' };
      }

      const res = (typeof data === 'string' ? JSON.parse(data) : data) as EditarMensajeResponse;
      return res;
    } catch (err: any) {
      if (import.meta.env.DEV) console.error('[mensajesService] editarMensaje unexpected error:', err);
      return { ok: false, error: err?.message || 'error_inesperado' };
    }
  },

  /**
   * Elimina un mensaje (el autor puede borrar los propios; el organizador puede moderar cualquiera).
   */
  async eliminarMensaje(
    mensajeId: string,
    tokenInvitacion?: string
  ): Promise<EliminarMensajeResponse> {
    try {
      const { data, error } = await supabase.rpc('eliminar_mensaje_encuentro_seguro', {
        p_mensaje_id: mensajeId,
        p_token_invitacion: tokenInvitacion || null,
      });

      if (error) {
        if (import.meta.env.DEV) console.error('[mensajesService] eliminarMensaje RPC error:', error);
        return { ok: false, error: error.message || 'error_eliminando_mensaje' };
      }

      const res = (typeof data === 'string' ? JSON.parse(data) : data) as EliminarMensajeResponse;
      return res;
    } catch (err: any) {
      if (import.meta.env.DEV) console.error('[mensajesService] eliminarMensaje unexpected error:', err);
      return { ok: false, error: err?.message || 'error_inesperado' };
    }
  },

  /**
   * Destaca o des-destaca un mensaje (exclusivo para el organizador, hasta 3 simultáneos).
   */
  async destacarMensaje(
    mensajeId: string,
    destacado: boolean
  ): Promise<DestacarMensajeResponse> {
    try {
      const { data, error } = await supabase.rpc('destacar_mensaje_encuentro_seguro', {
        p_mensaje_id: mensajeId,
        p_destacado: destacado,
      });

      if (error) {
        if (import.meta.env.DEV) console.error('[mensajesService] destacarMensaje RPC error:', error);
        return { ok: false, error: error.message || 'error_destacando_mensaje' };
      }

      const res = (typeof data === 'string' ? JSON.parse(data) : data) as DestacarMensajeResponse;
      return res;
    } catch (err: any) {
      if (import.meta.env.DEV) console.error('[mensajesService] destacarMensaje unexpected error:', err);
      return { ok: false, error: err?.message || 'error_inesperado' };
    }
  },
};
