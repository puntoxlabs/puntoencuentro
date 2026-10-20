export type ContactsErrorCode =
  | 'not_authenticated'
  | 'anonymous_user_not_allowed'
  | 'invalid_contact_name'
  | 'invalid_email'
  | 'contact_not_found'
  | 'contact_email_taken'
  | 'contact_limit_reached'
  | 'invalid_list_name'
  | 'list_not_found'
  | 'list_name_taken'
  | 'list_limit_reached'
  | 'list_empty_recipients'
  | 'list_recipient_limit_reached'
  | 'encuentro_not_found_or_not_owner'
  | 'rate_limit_exceeded'
  | 'unknown_error';

export interface UserContact {
  id: string;
  nombre: string;
  email: string;
  es_favorito: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ContactSuggestion {
  email: string;
  veces_invitado: number;
  ultima_invitacion_at: string;
}

export interface ContactsAndSuggestionsPayload {
  contactos: UserContact[];
  sugerencias: ContactSuggestion[];
  ya_invitados_encuentro: string[];
}

export interface GuestList {
  id: string;
  nombre: string;
  destinatarios_emails: string[];
  destinatarios_count: number;
  created_at?: string;
  updated_at?: string;
}

export interface GuestListSuggestion {
  emails: string[];
  destinatarios_count: number;
  veces_usado: number;
  ultima_invitacion_at: string;
  nombre_sugerido: string;
}

export interface GuestListsPayload {
  listas: GuestList[];
  sugerencias_listas: GuestListSuggestion[];
  ya_invitados_encuentro: string[];
}

export interface ContactsServiceResult<T = void> {
  ok: boolean;
  data?: T;
  error?: ContactsErrorCode;
}
