export const PUSH_PROMPT_DISMISSED_KEY = 'pe_push_prompt_dismissed_until_v1';

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
