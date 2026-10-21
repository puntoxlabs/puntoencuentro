/**
 * Gestión de Horarios Silenciosos para Notificaciones y Avisame.
 *
 * REGLA FUNDAMENTAL DE DOMINIO:
 * Las notificaciones críticas de cancelación, cambios de fecha/hora y otros eventos urgentes
 * NUNCA se silencian ni se pierden, incluso durante los horarios silenciosos.
 */

export interface QuietHoursPreference {
  enabled: boolean;
  startTime: string; // HH:MM, por defecto 22:00
  endTime: string;   // HH:MM, por defecto 08:00
}

export const DEFAULT_QUIET_HOURS: QuietHoursPreference = {
  enabled: false,
  startTime: '22:00',
  endTime: '08:00',
};

export const QUIET_HOURS_STORAGE_KEY_PREFIX = 'pe_quiet_hours_prefs';

/**
 * Valida formato de hora HH:MM (24 horas).
 */
export function isValidTimeString(time?: string | null): boolean {
  if (!time || typeof time !== 'string') return false;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time.trim());
}

/**
 * Sanitiza y normaliza un objeto de preferencias de horarios silenciosos.
 */
export function sanitizeQuietHoursPreference(
  pref?: Partial<QuietHoursPreference> | null
): QuietHoursPreference {
  if (!pref || typeof pref !== 'object') {
    return { ...DEFAULT_QUIET_HOURS };
  }

  return {
    enabled: Boolean(pref.enabled),
    startTime: isValidTimeString(pref.startTime) ? pref.startTime!.trim() : DEFAULT_QUIET_HOURS.startTime,
    endTime: isValidTimeString(pref.endTime) ? pref.endTime!.trim() : DEFAULT_QUIET_HOURS.endTime,
  };
}

/**
 * Determina si una notificación califica como CRÍTICA.
 * Abarca cancelaciones de encuentros, cambios de fecha/hora o eventos marcados prioritarios.
 */
export function isCriticalNotification(notification?: {
  notificationType?: string | null;
  payload?: any;
}): boolean {
  if (!notification) return false;

  const type = notification.notificationType?.toLowerCase();
  if (
    type === 'encounter_cancelled_for_participant' ||
    type === 'open_encounter_request_cancelled_by_host' ||
    type === 'encounter_schedule_changed'
  ) {
    return true;
  }

  if (notification.payload?.priority === 'critical' || notification.payload?.is_critical === true) {
    return true;
  }

  return false;
}

/**
 * Comprueba si una fecha y hora dadas caen dentro del horario silencioso activo.
 * Utiliza la zona horaria canónica de Argentina ('America/Argentina/Buenos_Aires').
 */
export function isInQuietHours(
  nowDate?: Date,
  preference: QuietHoursPreference = DEFAULT_QUIET_HOURS
): boolean {
  if (!preference.enabled) return false;

  const validPref = sanitizeQuietHoursPreference(preference);
  const now = nowDate || new Date();

  // Extraer hora y minutos en zona horaria de Argentina
  let currentHours = now.getHours();
  let currentMinutes = now.getMinutes();

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.format(now).split(':');
    if (parts.length === 2) {
      currentHours = parseInt(parts[0], 10);
      currentMinutes = parseInt(parts[1], 10);
    }
  } catch {
    // Si Intl falla o no soporta timeZone, fallback a hora local
  }

  const currentTotalMinutes = currentHours * 60 + currentMinutes;

  const [startH, startM] = validPref.startTime.split(':').map((s) => parseInt(s, 10));
  const [endH, endM] = validPref.endTime.split(':').map((s) => parseInt(s, 10));

  const startTotalMinutes = startH * 60 + startM;
  const endTotalMinutes = endH * 60 + endM;

  if (startTotalMinutes === endTotalMinutes) {
    // Intervalo de 0 minutos: no silenciar
    return false;
  }

  if (startTotalMinutes < endTotalMinutes) {
    // Mismo día (ej: 14:00 a 16:00)
    return currentTotalMinutes >= startTotalMinutes && currentTotalMinutes < endTotalMinutes;
  } else {
    // Cruza la medianoche (ej: 22:00 a 08:00)
    return currentTotalMinutes >= startTotalMinutes || currentTotalMinutes < endTotalMinutes;
  }
}

/**
 * Evalúa si una notificación entrante debe ser silenciada en el cliente debido al horario silencioso.
 * Retorna true ÚNICAMENTE si la notificación es no-crítica y el horario está activo.
 */
export function shouldSuppressForQuietHours(
  notification: { notificationType?: string | null; payload?: any },
  preference: QuietHoursPreference = DEFAULT_QUIET_HOURS,
  nowDate?: Date
): boolean {
  // REGLA CRÍTICA: Las notificaciones críticas NUNCA se silencian
  if (isCriticalNotification(notification)) {
    return false;
  }

  // Notificaciones no-críticas: silenciar si cae en ventana
  return isInQuietHours(nowDate, preference);
}
