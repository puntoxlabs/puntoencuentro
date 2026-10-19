import type { TFunction } from 'i18next';

const KNOWN_ERRORS = new Set([
  'not_authenticated',
  'anonymous_user_not_allowed',
  'invalid_template_name',
  'template_name_taken',
  'template_limit_reached',
  'template_not_found',
  'encuentro_not_found_or_not_owner',
  'rate_limit_exceeded',
  'coordination_unavailable',
]);

/** Mensaje amigable (i18n) para un código de error de las RPCs de plantillas. Nunca expone texto técnico. */
export function reuseErrorMessage(t: TFunction, code?: string | null): string {
  const key = code && KNOWN_ERRORS.has(code) ? code : 'unknown_error';
  return t(`encounter_reuse.errors.${key}`);
}
