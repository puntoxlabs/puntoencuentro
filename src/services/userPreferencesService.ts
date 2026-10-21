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
   * Si se especifica un userId, busca de forma aislada sin heredar de sesiones anónimas.
   */
  getLocalQuietHours(userId?: string | null): QuietHoursPreference {
    const storage = getStorage();
    if (!storage) {
      return { ...DEFAULT_QUIET_HOURS };
    }

    try {
      const normalizedUserId = userId && userId.trim() ? userId.trim() : null;
      const key = normalizedUserId
        ? `${QUIET_HOURS_STORAGE_KEY_PREFIX}:${normalizedUserId}`
        : `${QUIET_HOURS_STORAGE_KEY_PREFIX}:anon`;

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
  ): Promise<{ ok: boolean; data: QuietHoursPreference; error?: string; synced: boolean }> {
    const sanitized = sanitizeQuietHoursPreference(preference);
    const normalizedUserId = userId && userId.trim() ? userId.trim() : null;

    // 1. Guardar en storage local inmediato con aislamiento estricto
    const storage = getStorage();
    if (storage) {
      try {
        const key = normalizedUserId
          ? `${QUIET_HOURS_STORAGE_KEY_PREFIX}:${normalizedUserId}`
          : `${QUIET_HOURS_STORAGE_KEY_PREFIX}:anon`;
        storage.setItem(key, JSON.stringify(sanitized));
      } catch (err) {
        console.warn('[userPreferencesService] Error guardando preferencia local:', err);
      }
    }

    // 2. Si el usuario es permanente, sincronizar con user_metadata en Supabase Auth
    if (isPermanentUser && normalizedUserId) {
      try {
        const { error } = await supabase.auth.updateUser({
          data: {
            quiet_hours: sanitized,
          },
        });
        if (error) {
          console.warn('[userPreferencesService] Error sincronizando con Supabase Auth:', error.message);
          return { ok: true, data: sanitized, error: error.message, synced: false };
        }
        return { ok: true, data: sanitized, synced: true };
      } catch (err: any) {
        console.warn('[userPreferencesService] Excepción sincronizando con Auth:', err);
        return { ok: true, data: sanitized, error: err?.message, synced: false };
      }
    }

    return { ok: true, data: sanitized, synced: false };
  },

  /**
   * Inicializa las preferencias hidratando desde user_metadata de Auth si existe,
   * o recuperando la clave local aislada para el usuario.
   */
  resolveInitialQuietHours(userMetadata?: any, userId?: string | null): QuietHoursPreference {
    const normalizedUserId = userId && userId.trim() ? userId.trim() : null;

    if (!normalizedUserId) {
      return this.getLocalQuietHours(null);
    }

    if (userMetadata?.quiet_hours) {
      const fromAuth = sanitizeQuietHoursPreference(userMetadata.quiet_hours);
      // Hidratar o refrescar cache local aislada
      const storage = getStorage();
      if (storage) {
        try {
          storage.setItem(`${QUIET_HOURS_STORAGE_KEY_PREFIX}:${normalizedUserId}`, JSON.stringify(fromAuth));
        } catch {}
      }
      return fromAuth;
    }

    return this.getLocalQuietHours(normalizedUserId);
  },

  /**
   * Limpia el almacenamiento de un usuario (para pruebas o cierres limpios de sesión).
   */
  clearUserQuietHours(userId?: string | null): void {
    const storage = getStorage();
    if (storage) {
      try {
        const key = userId && userId.trim()
          ? `${QUIET_HOURS_STORAGE_KEY_PREFIX}:${userId.trim()}`
          : `${QUIET_HOURS_STORAGE_KEY_PREFIX}:anon`;
        storage.removeItem(key);
      } catch {}
    }
  },
};
