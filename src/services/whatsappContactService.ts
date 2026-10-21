import { supabase } from '@/lib/supabase';

export interface WhatsappContactResult {
  ok: boolean;
  is_host?: boolean;
  has_contact?: boolean;
  opt_in?: boolean;
  telefono?: string | null;
  wa_link?: string | null;
  error?: string;
}

export const whatsappContactService = {
  /**
   * Obtiene la configuración de contacto de WhatsApp para el host o el link seguro para un participante confirmado.
   */
  async obtenerContacto(encuentroId: string, tokenInvitacion?: string): Promise<WhatsappContactResult> {
    try {
      if (!encuentroId) {
        return { ok: false, error: 'invalid_parameters' };
      }

      const { data, error } = await supabase.rpc('obtener_contacto_whatsapp_seguro', {
        p_encuentro_id: encuentroId,
        p_token_invitacion: tokenInvitacion || null,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      return data as WhatsappContactResult;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Guarda o actualiza el teléfono de WhatsApp del anfitrión y su opt-in.
   */
  async guardarContacto(encuentroId: string, telefono: string, optIn: boolean): Promise<WhatsappContactResult> {
    try {
      if (!encuentroId) {
        return { ok: false, error: 'invalid_parameters' };
      }

      const { data, error } = await supabase.rpc('guardar_contacto_whatsapp_host_seguro', {
        p_encuentro_id: encuentroId,
        p_telefono: telefono,
        p_opt_in: optIn,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      return data as WhatsappContactResult;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Retira definitivamente el contacto de WhatsApp del anfitrión.
   */
  async retirarContacto(encuentroId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!encuentroId) {
        return { ok: false, error: 'invalid_parameters' };
      }

      const { data, error } = await supabase.rpc('retirar_contacto_whatsapp_host_seguro', {
        p_encuentro_id: encuentroId,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      return data as { ok: boolean; error?: string };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Normaliza un número telefónico removiendo caracteres no numéricos y prefijos internacionales '00'.
   */
  normalizarTelefonoCliente(input: string): string {
    if (!input) return '';
    let digits = input.replace(/[^0-9]/g, '');
    if (digits.startsWith('00')) {
      digits = digits.substring(2);
    }
    return digits;
  },

  /**
   * Valida preliminarmente en cliente si el formato corresponde a un teléfono internacional válido E.164.
   */
  validarTelefonoCliente(input: string): { valid: boolean; normalized: string; error?: string } {
    const normalized = this.normalizarTelefonoCliente(input);
    if (!normalized) {
      return { valid: false, normalized: '', error: 'phone_required' };
    }
    if (normalized.length < 8 || normalized.length > 15) {
      return { valid: false, normalized, error: 'invalid_phone_length' };
    }
    if (/^0+$/.test(normalized)) {
      return { valid: false, normalized, error: 'invalid_phone_format' };
    }
    return { valid: true, normalized };
  },
};
