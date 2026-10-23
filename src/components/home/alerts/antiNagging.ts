export const PUSH_PROMPT_DISMISSED_KEY = 'pe_push_prompt_dismissed_until_v1';
export const ANDROID_PUSH_GUIDE_DISMISSED_KEY = 'pe_android_push_guide_dismissed_v1';

/**
 * Retorna true si el dispositivo actual es un entorno Android.
 * Se excluyen explícitamente Desktop, iOS y otros entornos no Android.
 */
export function isAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Android/i.test(ua);
}

/**
 * Retorna true si la guía contextual de Android ya fue ofrecida o resuelta
 * (tanto al presionar "Ver cómo configurarlas" como "Ahora no").
 */
export function isAndroidPushGuideDismissed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(ANDROID_PUSH_GUIDE_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Registra que la guía ya fue presentada y resuelta en este navegador/dispositivo.
 * No volverá a ofrecerse automáticamente.
 */
export function dismissAndroidPushGuide(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ANDROID_PUSH_GUIDE_DISMISSED_KEY, 'true');
  } catch {}
}

/**
 * Reinicia la marca de la guía para propósitos de pruebas o QA.
 */
export function resetAndroidPushGuideDismissal(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(ANDROID_PUSH_GUIDE_DISMISSED_KEY);
  } catch {}
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
