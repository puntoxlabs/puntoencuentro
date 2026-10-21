import { supabase } from '@/lib/supabase';
import {
  type QuietHoursPreference,
  DEFAULT_QUIET_HOURS,
  QUIET_HOURS_STORAGE_KEY_PREFIX,
  sanitizeQuietHoursPreference,
} from '@/lib/quietHours';

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {}
  return null;
}

export const userPreferencesService = {
  /**
   * Obtiene las preferencias de horarios silenciosos almacenadas localmente.
   */
  getLocalQuietHours(userId?: string | null): QuietHoursPreference {
    const storage = getStorage();
    if (!storage) {
      return { ...DEFAULT_QUIET_HOURS };
    }

    try {
      const key = `${QUIET_HOURS_STORAGE_KEY_PREFIX}:${userId || 'anon'}`;
      const raw = storage.getItem(key);
      if (!raw) return { ...DEFAULT_QUIET_HOURS };
      const parsed = JSON.parse(raw);
      return sanitizeQuietHoursPreference(parsed);
    } catch {
      return { ...DEFAULT_QUIET_HOURS };
    }
  },

  /**
   * Guarda las preferencias de horarios silenciosos localmente y las sincroniza con auth.users
   * si el usuario está registrado (cuenta permanente).
   */
  async saveQuietHours(
    preference: Partial<QuietHoursPreference>,
    userId?: string | null,
    isPermanentUser: boolean = false
  ): Promise<{ ok: boolean; data: QuietHoursPreference; error?: string }> {
    const sanitized = sanitizeQuietHoursPreference(preference);

    // 1. Guardar en storage local inmediato
    const storage = getStorage();
    if (storage) {
      try {
        const key = `${QUIET_HOURS_STORAGE_KEY_PREFIX}:${userId || 'anon'}`;
        storage.setItem(key, JSON.stringify(sanitized));
      } catch (err) {
        console.warn('[userPreferencesService] Error guardando preferencia local:', err);
      }
    }

    // 2. Si el usuario es permanente, sincronizar con user_metadata en Supabase Auth
    if (isPermanentUser && userId) {
      try {
        const { error } = await supabase.auth.updateUser({
          data: {
            quiet_hours: sanitized,
          },
        });
        if (error) {
          console.warn('[userPreferencesService] Error sincronizando con Supabase Auth:', error.message);
          return { ok: true, data: sanitized, error: error.message };
        }
      } catch (err: any) {
        console.warn('[userPreferencesService] Excepción sincronizando con Auth:', err);
        return { ok: true, data: sanitized, error: err?.message };
      }
    }

    return { ok: true, data: sanitized };
  },

  /**
   * Inicializa las preferencias fusionando user_metadata de Auth con el storage local.
   */
  resolveInitialQuietHours(userMetadata?: any, userId?: string | null): QuietHoursPreference {
    const local = this.getLocalQuietHours(userId);

    if (userMetadata?.quiet_hours) {
      const fromAuth = sanitizeQuietHoursPreference(userMetadata.quiet_hours);
      // Actualizar cache local
      const storage = getStorage();
      if (storage && userId) {
        try {
          storage.setItem(`${QUIET_HOURS_STORAGE_KEY_PREFIX}:${userId}`, JSON.stringify(fromAuth));
        } catch {}
      }
      return fromAuth;
    }

    return local;
  },
};
