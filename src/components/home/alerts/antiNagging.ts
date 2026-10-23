export const PUSH_PROMPT_DISMISSED_KEY = 'pe_push_prompt_dismissed_until_v1';
export const ANDROID_PUSH_GUIDE_DISMISSED_KEY = 'pe_android_push_guide_dismissed_v1';
export const DESKTOP_PUSH_GUIDE_DISMISSED_KEY = 'pe_desktop_push_guide_dismissed_v1';

export type PushPlatform = 'android' | 'windows' | 'macos' | 'other';

/**
 * Determina la plataforma del sistema operativo para contextualizar
 * las guías de visibilidad de notificaciones.
 * Excluye explícitamente iOS de las guías de escritorio y Android.
 */
export function getPushPlatform(): PushPlatform {
  if (typeof navigator === 'undefined') return 'other';

  const nav = navigator as any;
  const ua = nav.userAgent || '';

  // 1. Exclusión estricta de iOS (iPhone, iPad, iPod o iPadOS como MacIntel con touch points)
  const isIos =
    /iPad|iPhone|iPod/i.test(ua) ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
  if (isIos) return 'other';

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
 * (Android, Windows o macOS). Excluye iOS y plataformas desconocidas.
 */
export function isPushGuideSupportedPlatform(platform: PushPlatform = getPushPlatform()): boolean {
  return platform === 'android' || platform === 'windows' || platform === 'macos';
}

/**
 * Retorna true si el dispositivo actual es un entorno Android.
 * Conservado por compatibilidad con código y pruebas existentes.
 */
export function isAndroidDevice(): boolean {
  return getPushPlatform() === 'android';
}

/**
 * Retorna true si la guía contextual de visibilidad ya fue ofrecida o resuelta
 * para la plataforma actual (respetando la marca previa de Android).
 */
export function isPushVisibilityGuideDismissed(platform: PushPlatform = getPushPlatform()): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (platform === 'android') {
      return localStorage.getItem(ANDROID_PUSH_GUIDE_DISMISSED_KEY) === 'true';
    }
    return localStorage.getItem(DESKTOP_PUSH_GUIDE_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Registra que la guía ya fue presentada y resuelta en este navegador/dispositivo.
 * No volverá a ofrecerse automáticamente.
 */
export function dismissPushVisibilityGuide(platform: PushPlatform = getPushPlatform()): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (platform === 'android') {
      localStorage.setItem(ANDROID_PUSH_GUIDE_DISMISSED_KEY, 'true');
    } else {
      localStorage.setItem(DESKTOP_PUSH_GUIDE_DISMISSED_KEY, 'true');
    }
  } catch {}
}

/**
 * Reinicia la marca de la guía para propósitos de pruebas o QA.
 */
export function resetPushVisibilityGuideDismissal(platform?: PushPlatform): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (!platform || platform === 'android') {
      localStorage.removeItem(ANDROID_PUSH_GUIDE_DISMISSED_KEY);
    }
    if (!platform || platform !== 'android') {
      localStorage.removeItem(DESKTOP_PUSH_GUIDE_DISMISSED_KEY);
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

/**
 * Retorna true si el usuario descartó previamente el prompt de Web Push
 * y el período anti-molestia (30 días por defecto) todavía está vigente.
 */
export function isPushPromptDismissed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const val = localStorage.getItem(PUSH_PROMPT_DISMISSED_KEY);
    if (!val) return false;
    const until = parseInt(val, 10);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

/**
 * Registra que el usuario presionó "Ahora no" o descartó el prompt,
 * silenciando el popup durante un período razonable (30 días).
 */
export function dismissPushPrompt(days = 30): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const ms = days * 24 * 60 * 60 * 1000;
    localStorage.setItem(PUSH_PROMPT_DISMISSED_KEY, String(Date.now() + ms));
  } catch {}
}

/**
 * Limpia la marca de descarte cuando el usuario decide activar manualmente.
 */
export function clearPushPromptDismissal(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(PUSH_PROMPT_DISMISSED_KEY);
  } catch {}
}
