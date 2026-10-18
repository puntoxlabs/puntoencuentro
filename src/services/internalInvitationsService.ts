import { supabase } from '@/lib/supabase';
import type {
  HostInternalInvitationItem,
  MyInternalInvitationItem,
  InternalInvitationDetail,
  SendInternalInvitationResponse,
  RespondInternalInvitationResponse,
} from '@/types/internalInvitations';

export const internalInvitationsService = {
  /**
   * Envía una invitación interna a un usuario registrado por correo exacto.
   * La identidad del remitente se deriva exclusivamente de auth.uid() en PostgreSQL.
   */
  async enviarInvitacion(
    encuentroId: string,
    email: string,
    mensaje?: string
  ): Promise<SendInternalInvitationResponse> {
    const { data, error } = await supabase.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: encuentroId,
      p_email: email,
      p_mensaje: mensaje ?? null,
    });

    if (error) {
      console.error('[internalInvitationsService] Error enviando invitación:', error);
      return { ok: false, sent: false, error: error.message };
    }

    const result = typeof data === 'string' ? JSON.parse(data) : data;
    return result as SendInternalInvitationResponse;
  },

  /**
   * Responde (acepta o rechaza) una invitación interna.
   */
  async responderInvitacion(
    invitationId: string,
    respuesta: 'aceptada' | 'rechazada',
    mensaje?: string
  ): Promise<RespondInternalInvitationResponse> {
    const { data, error } = await supabase.rpc('responder_invitacion_interna_seguro', {
      p_invitacion_id: invitationId,
      p_respuesta: respuesta,
      p_mensaje: mensaje ?? null,
    });

    if (error) {
      console.error('[internalInvitationsService] Error respondiendo invitación:', error);
      return { ok: false, error: error.message };
    }

    const result = typeof data === 'string' ? JSON.parse(data) : data;
    return result as RespondInternalInvitationResponse;
  },

  /**
   * Cancela una invitación interna pendiente como anfitrión.
   */
  async cancelarInvitacion(invitationId: string): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await supabase.rpc('cancelar_invitacion_interna_seguro', {
      p_invitacion_id: invitationId,
    });

    if (error) {
      console.error('[internalInvitationsService] Error cancelando invitación:', error);
      return { ok: false, error: error.message };
    }

    const result = typeof data === 'string' ? JSON.parse(data) : data;
    return result as { ok: boolean; error?: string };
  },

  /**
   * Obtiene la lista de invitaciones internas enviadas para un encuentro (vista organizador).
   */
  async getInvitacionesEncuentro(
    encuentroId: string
  ): Promise<{ ok: boolean; invitaciones: HostInternalInvitationItem[]; error?: string }> {
    const { data, error } = await supabase.rpc('get_invitaciones_internas_encuentro_seguro', {
      p_encuentro_id: encuentroId,
    });

    if (error) {
      console.error('[internalInvitationsService] Error consultando invitaciones de encuentro:', error);
      return { ok: false, invitaciones: [], error: error.message };
    }

    const result = typeof data === 'string' ? JSON.parse(data) : data;
    return {
      ok: result?.ok ?? false,
      invitaciones: (result?.invitaciones || []) as HostInternalInvitationItem[],
      error: result?.error,
    };
  },

  /**
   * Obtiene las invitaciones internas recibidas por el usuario logueado.
   */
  async getMisInvitaciones(): Promise<{
    ok: boolean;
    invitaciones: MyInternalInvitationItem[];
    error?: string;
  }> {
    const { data, error } = await supabase.rpc('get_mis_invitaciones_internas_seguro');

    if (error) {
      console.error('[internalInvitationsService] Error consultando mis invitaciones:', error);
      return { ok: false, invitaciones: [], error: error.message };
    }

    const result = typeof data === 'string' ? JSON.parse(data) : data;
    return {
      ok: result?.ok ?? false,
      invitaciones: (result?.invitaciones || []) as MyInternalInvitationItem[],
      error: result?.error,
    };
  },

  /**
   * Obtiene el detalle completo de una invitación interna (para la pantalla de respuesta).
   */
  async getDetalleInvitacion(
    invitationId: string
  ): Promise<{ ok: boolean; data?: InternalInvitationDetail; error?: string }> {
    const { data, error } = await supabase.rpc('get_detalle_invitacion_interna_seguro', {
      p_invitacion_id: invitationId,
    });

    if (error) {
      console.error('[internalInvitationsService] Error consultando detalle de invitación:', error);
      return { ok: false, error: error.message };
    }

    const result = typeof data === 'string' ? JSON.parse(data) : data;
    if (!result?.ok) {
      return { ok: false, error: result?.error || 'invitation_not_found' };
    }

    return {
      ok: true,
      data: {
        invitacion: result.invitacion,
        encuentro: result.encuentro,
      },
    };
  },
};
