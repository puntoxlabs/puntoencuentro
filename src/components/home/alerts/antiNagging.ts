export const PUSH_PROMPT_DISMISSED_KEY = 'pe_push_prompt_dismissed_until_v1';
export const ANDROID_PUSH_GUIDE_DISMISSED_KEY = 'pe_android_push_guide_dismissed_v1';
export const DESKTOP_PUSH_GUIDE_DISMISSED_KEY = 'pe_desktop_push_guide_dismissed_v1';
export const IOS_PUSH_GUIDE_DISMISSED_KEY = 'pe_ios_push_guide_dismissed_v1';
export const PUSH_GUIDE_VIEWED_KEY = 'pe_push_guide_viewed_v1';
export const PUSH_PROMPT_SHOWN_KEY = 'pe_push_prompt_shown_v1';
export const HOST_FIRST_ENCOUNTER_KEY = 'pe_host_first_encounter_created_v1';
export const PARTICIPANT_FIRST_CONFIRMATION_KEY = 'pe_participant_first_confirmed_v1';
export const OPEN_PARTICIPATION_NOTIFIED_KEY = 'pe_open_participation_notified_v1';
export const SOUND_VISIBILITY_ASSISTANT_DISMISSED_KEY = 'pe_sound_visibility_assistant_dismissed_until_v1';
export const ASSISTANT_SAVED_STEP_KEY = 'pe_assistant_saved_step_v1';

export type PushPlatform = 'android' | 'windows' | 'macos' | 'ios' | 'other';

/**
 * Genera una clave con prefijo o sufijo de usuario para aislar las decisiones
 * de configuración y anti-insistencia en dispositivos compartidos.
 */
export function getScopedKey(baseKey: string, userId?: string | null): string {
  if (!userId) return baseKey;
  return `${baseKey}_${userId}`;
}

/**
 * Determina la plataforma del sistema operativo para contextualizar
 * las guías de visibilidad de notificaciones (Android, Windows, macOS e iOS).
 */
export function getPushPlatform(): PushPlatform {
  if (typeof navigator === 'undefined') return 'other';

  const nav = navigator as any;
  const ua = nav.userAgent || '';

  // 1. Detección precisa de iOS (iPhone, iPad, iPod o iPadOS como MacIntel con touch points)
  const isIos =
    /iPad|iPhone|iPod/i.test(ua) ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
  if (isIos) return 'ios';

  // 2. Client Hints / UserAgentData (Chromium moderno en Windows, macOS, Android)
  if (nav.userAgentData?.platform) {
    const p = String(nav.userAgentData.platform).toLowerCase();
    if (p.includes('android')) return 'android';
    if (p.includes('windows')) return 'windows';
    if (p.includes('mac') || p.includes('macos')) return 'macos';
  }

  // 3. UserAgent y platform legacy
  if (/Android/i.test(ua)) return 'android';
  if (/Windows NT|Windows/i.test(ua) || /Win32|Win64/i.test(nav.platform || '')) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua) || /MacIntel|MacPPC/i.test(nav.platform || '')) return 'macos';

  return 'other';
}

/**
 * Retorna true si la plataforma cuenta con una guía contextual especializada
 * (Android, Windows, macOS o iOS).
 */
export function isPushGuideSupportedPlatform(platform: PushPlatform = getPushPlatform()): boolean {
  return platform === 'android' || platform === 'windows' || platform === 'macos' || platform === 'ios';
}

/**
 * Retorna true si el dispositivo actual es un entorno Android.
 * Conservado por compatibilidad con código y pruebas existentes.
 */
export function isAndroidDevice(): boolean {
  return getPushPlatform() === 'android';
}

/**
 * Retorna true si el dispositivo actual es un entorno iOS / iPadOS.
 */
export function isIosDevice(): boolean {
  return getPushPlatform() === 'ios';
}

/**
 * Retorna true si la aplicación se ejecuta en modo standalone / pantalla de inicio (PWA).
 */
export function isIosStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined;
  const standaloneMedia = !!window.matchMedia?.('(display-mode: standalone)').matches;
  const standaloneIos = nav?.standalone === true;
  return standaloneMedia || standaloneIos;
}

/**
 * Retorna true si la guía contextual de visibilidad ya fue configurada / completada
 * para la plataforma actual (respetando identidad de usuario si está disponible).
 */
export function isPushVisibilityGuideDismissed(
  platform: PushPlatform = getPushPlatform(),
  userId?: string | null
): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    let key = DESKTOP_PUSH_GUIDE_DISMISSED_KEY;
    if (platform === 'android') {
      key = ANDROID_PUSH_GUIDE_DISMISSED_KEY;
    } else if (platform === 'ios') {
      key = IOS_PUSH_GUIDE_DISMISSED_KEY;
    }

    // Aislamiento estricto por usuario: si hay userId, consultar EXCLUSIVAMENTE
    // la clave con scope del usuario, sin heredar claves globales de otras cuentas.
    if (userId) {
      return localStorage.getItem(getScopedKey(key, userId)) === 'true';
    }
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/**
 * Registra que la guía ya fue resuelta o descartada voluntariamente.
 */
export function dismissPushVisibilityGuide(
  platform: PushPlatform = getPushPlatform(),
  userId?: string | null
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    let key = DESKTOP_PUSH_GUIDE_DISMISSED_KEY;
    if (platform === 'android') {
      key = ANDROID_PUSH_GUIDE_DISMISSED_KEY;
    } else if (platform === 'ios') {
      key = IOS_PUSH_GUIDE_DISMISSED_KEY;
    }
    const targetKey = getScopedKey(key, userId);
    localStorage.setItem(targetKey, 'true');
    // Para compatibilidad hacia atrás si no hay userId
    if (!userId) {
      localStorage.setItem(key, 'true');
    }
  } catch {}
}

/**
 * Reinicia la marca de la guía para propósitos de pruebas o QA.
 */
export function resetPushVisibilityGuideDismissal(
  platform?: PushPlatform,
  userId?: string | null
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const removeKey = (k: string) => {
      if (userId) {
        localStorage.removeItem(getScopedKey(k, userId));
      } else {
        localStorage.removeItem(k);
      }
    };

    if (!platform || platform === 'android') {
      removeKey(ANDROID_PUSH_GUIDE_DISMISSED_KEY);
    }
    if (!platform || platform === 'ios') {
      removeKey(IOS_PUSH_GUIDE_DISMISSED_KEY);
    }
    if (!platform || (platform !== 'android' && platform !== 'ios')) {
      removeKey(DESKTOP_PUSH_GUIDE_DISMISSED_KEY);
    }
  } catch {}
}

/**
 * Wrappers de compatibilidad histórica para Android.
 */
export function isAndroidPushGuideDismissed(): boolean {
  return isPushVisibilityGuideDismissed('android');
}

export function dismissAndroidPushGuide(): void {
  dismissPushVisibilityGuide('android');
}

export function resetAndroidPushGuideDismissal(): void {
  resetPushVisibilityGuideDismissal('android');
}

// ── 5 DIMENSIONES DE POLÍTICA ANTI-INSISTENCIA ───────────────────────────────

/**
 * 1. Registra que la invitación fue presentada al usuario en un contexto dado.
 */
export function recordPushPromptShown(context: string, userId?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const key = getScopedKey(PUSH_PROMPT_SHOWN_KEY, userId);
    const data = {
      context,
      timestamp: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(data));
  } catch {}
}

/**
 * 2. Retorna true si el usuario descartó previamente el prompt de Web Push («Ahora no»)
 * y el período de descanso todavía está vigente.
 */
export function isPushPromptDismissed(userId?: string | null): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    // Aislamiento estricto por usuario: si hay userId, consultar EXCLUSIVAMENTE
    // la clave con scope del usuario para no heredar períodos de descarte de otras cuentas.
    if (userId) {
      const val = localStorage.getItem(getScopedKey(PUSH_PROMPT_DISMISSED_KEY, userId));
      if (!val) return false;
      const until = parseInt(val, 10);
      return Number.isFinite(until) && Date.now() < until;
    }
    const val = localStorage.getItem(PUSH_PROMPT_DISMISSED_KEY);
    if (!val) return false;
    const until = parseInt(val, 10);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

/**
 * Registra que el usuario presionó «Ahora no» o descartó la invitación,
 * silenciando los prompts durante un período de descanso (14 días por defecto).
 */
export function dismissPushPrompt(days = 14, userId?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const ms = days * 24 * 60 * 60 * 1000;
    const until = String(Date.now() + ms);
    const key = getScopedKey(PUSH_PROMPT_DISMISSED_KEY, userId);
    localStorage.setItem(key, until);
    if (!userId) {
      localStorage.setItem(PUSH_PROMPT_DISMISSED_KEY, until);
    }
  } catch {}
}

/**
 * Limpia la marca de descarte temporal cuando el usuario activa manualmente o cambia preferencia.
 */
export function clearPushPromptDismissal(userId?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (userId) {
      localStorage.removeItem(getScopedKey(PUSH_PROMPT_DISMISSED_KEY, userId));
    } else {
      localStorage.removeItem(PUSH_PROMPT_DISMISSED_KEY);
    }
  } catch {}
}

/**
 * Cooldown independiente del Asistente de Sonido y Visibilidad (P1-B).
 * Retorna true si el asistente fue pospuesto («Ahora no» o «Lo revisaré después»)
 * y el período de descanso (14 días) sigue activo para este usuario/dispositivo.
 */
export function isSoundVisibilityAssistantDismissed(userId?: string | null): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (userId) {
      const val = localStorage.getItem(getScopedKey(SOUND_VISIBILITY_ASSISTANT_DISMISSED_KEY, userId));
      if (!val) return false;
      const until = parseInt(val, 10);
      return Number.isFinite(until) && Date.now() < until;
    }
    const val = localStorage.getItem(SOUND_VISIBILITY_ASSISTANT_DISMISSED_KEY);
    if (!val) return false;
    const until = parseInt(val, 10);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

/**
 * Registra que el usuario pospuso el asistente de sonido y visibilidad (14 días por defecto).
 */
export function dismissSoundVisibilityAssistant(days = 14, userId?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const ms = days * 24 * 60 * 60 * 1000;
    const until = String(Date.now() + ms);
    const key = getScopedKey(SOUND_VISIBILITY_ASSISTANT_DISMISSED_KEY, userId);
    localStorage.setItem(key, until);
    if (!userId) {
      localStorage.setItem(SOUND_VISIBILITY_ASSISTANT_DISMISSED_KEY, until);
    }
  } catch {}
}

export function clearSoundVisibilityAssistantDismissal(userId?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (userId) {
      localStorage.removeItem(getScopedKey(SOUND_VISIBILITY_ASSISTANT_DISMISSED_KEY, userId));
    } else {
      localStorage.removeItem(SOUND_VISIBILITY_ASSISTANT_DISMISSED_KEY);
    }
  } catch {}
}

/**
 * Persistencia del paso en curso del Asistente (1, 2 o 3) en sessionStorage.
 * Permite al usuario salir a Ajustes de Android/Windows/iOS y regresar sin reiniciar el asistente.
 */
export function getAssistantSavedStep(userId?: string | null): 1 | 2 | 3 {
  if (typeof sessionStorage === 'undefined') return 1;
  try {
    const key = getScopedKey(ASSISTANT_SAVED_STEP_KEY, userId);
    const val = sessionStorage.getItem(key);
    if (val === '2' || val === '3') return Number(val) as 2 | 3;
    return 1;
  } catch {
    return 1;
  }
}

export function saveAssistantStep(step: 1 | 2 | 3, userId?: string | null): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const key = getScopedKey(ASSISTANT_SAVED_STEP_KEY, userId);
    sessionStorage.setItem(key, String(step));
  } catch {}
}

export function clearAssistantSavedStep(userId?: string | null): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const key = getScopedKey(ASSISTANT_SAVED_STEP_KEY, userId);
    sessionStorage.removeItem(key);
  } catch {}
}

/**
 * 3. Registra que la guía fue consultada/abierta por el usuario.
 * REGLA CRÍTICA: Abrir la guía NO equivale a completar la configuración ni a silenciarla.
 */
export function recordPushGuideViewed(
  platform: PushPlatform = getPushPlatform(),
  userId?: string | null
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const key = getScopedKey(PUSH_GUIDE_VIEWED_KEY, userId);
    const state = {
      platform,
      viewedAt: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(state));
  } catch {}
}

/**
 * Retorna true si la guía fue consultada al menos una vez en este dispositivo/usuario.
 */
export function isPushGuideViewed(
  platform: PushPlatform = getPushPlatform(),
  userId?: string | null
): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const key = getScopedKey(PUSH_GUIDE_VIEWED_KEY, userId);
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.platform === platform;
  } catch {
    return false;
  }
}

/**
 * 4. Registra que el usuario indicó haber completado la configuración (click en «Entendido»).
 */
export function recordPushGuideCompleted(
  platform: PushPlatform = getPushPlatform(),
  userId?: string | null
): void {
  dismissPushVisibilityGuide(platform, userId);
}

/**
 * 5. Registra que Web Push quedó efectivamente activado en este dispositivo.
 * Limpia cualquier período de descanso previo.
 */
export function recordWebPushActivated(userId?: string | null): void {
  clearPushPromptDismissal(userId);
}

// ── RASTREO DE PRIMERAS ACCIONES CONTEXTUALES ────────────────────────────────

/**
 * Anfitrión: Verifica si el anfitrión ya ha creado un encuentro previamente
 * registrado en este cliente para no repetir la invitación en futuros encuentros.
 */
export function hasEncounterCreatedBefore(userId?: string | null): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const key = getScopedKey(HOST_FIRST_ENCOUNTER_KEY, userId);
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function recordEncounterCreated(userId?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const key = getScopedKey(HOST_FIRST_ENCOUNTER_KEY, userId);
    localStorage.setItem(key, 'true');
  } catch {}
}

/**
 * Participante: Verifica si el participante ya confirmó asistencia previamente
 * registrado en este cliente.
 */
export function hasParticipationConfirmedBefore(userId?: string | null): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const key = getScopedKey(PARTICIPANT_FIRST_CONFIRMATION_KEY, userId);
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function recordParticipationConfirmed(userId?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const key = getScopedKey(PARTICIPANT_FIRST_CONFIRMATION_KEY, userId);
    localStorage.setItem(key, 'true');
  } catch {}
}

/**
 * Encuentros Abiertos: Verifica si ya se notificó/ofreció al participante
 * cuando fue aprobada su participación en un encuentro abierto específico.
 */
export function hasOpenParticipationNotified(encounterId: string, userId?: string | null): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const key = getScopedKey(`${OPEN_PARTICIPATION_NOTIFIED_KEY}_${encounterId}`, userId);
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function recordOpenParticipationNotified(encounterId: string, userId?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const key = getScopedKey(`${OPEN_PARTICIPATION_NOTIFIED_KEY}_${encounterId}`, userId);
    localStorage.setItem(key, 'true');
  } catch {}
}
