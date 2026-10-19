import type { TFunction } from 'i18next';
import type { ContactsErrorCode } from '@/types/userContacts';

const KNOWN_CODES: Set<string> = new Set<ContactsErrorCode>([
  'not_authenticated',
  'anonymous_user_not_allowed',
  'invalid_contact_name',
  'invalid_email',
  'contact_not_found',
  'contact_email_taken',
  'contact_limit_reached',
  'encuentro_not_found_or_not_owner',
  'rate_limit_exceeded',
  'unknown_error',
]);

export function contactsErrorMessage(t: TFunction, code?: string): string {
  const key = code && KNOWN_CODES.has(code) ? code : 'unknown_error';
  return t(`contacts.errors.${key}`);
}
