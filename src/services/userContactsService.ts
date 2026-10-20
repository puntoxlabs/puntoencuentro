import { supabase } from '@/lib/supabase';
import type {
  ContactsAndSuggestionsPayload,
  ContactsErrorCode,
  ContactsServiceResult,
  ContactSuggestion,
  GuestList,
  GuestListsPayload,
  GuestListSuggestion,
  UserContact,
} from '@/types/userContacts';

export const MAX_CONTACT_NAME_LENGTH = 80;
export const MAX_CONTACTS_PER_USER = 200;
export const MAX_GUEST_LIST_NAME_LENGTH = 80;
export const MAX_GUEST_LISTS_PER_USER = 30;
export const MAX_RECIPIENTS_PER_GUEST_LIST = 50;

function parseRpc(data: unknown): any {
  return typeof data === 'string' ? JSON.parse(data) : data;
}

export function normalizeContactEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

export function isValidContactEmail(email: string | null | undefined): boolean {
  const clean = normalizeContactEmail(email);
  if (clean.length < 3 || clean.length > 254 || clean.includes(' ')) return false;
  const atPos = clean.indexOf('@');
  if (atPos < 1) return false;
  const domain = clean.slice(atPos + 1);
  if (domain.includes('@') || domain.endsWith('.')) return false;
  const dotPos = domain.indexOf('.');
  return dotPos >= 1 && dotPos < domain.length - 1;
}

export function normalizeGuestEmailList(
  emails: (string | null | undefined)[]
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of emails) {
    const clean = normalizeContactEmail(raw);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

export function parseEmailInputBatch(raw: string): {
  valid: string[];
  invalid: string[];
} {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((t) => normalizeContactEmail(t))
    .filter(Boolean);
  const validSet = new Set<string>();
  const invalidSet = new Set<string>();
  for (const token of tokens) {
    if (isValidContactEmail(token)) {
      validSet.add(token);
    } else {
      invalidSet.add(token);
    }
  }
  return {
    valid: Array.from(validSet),
    invalid: Array.from(invalidSet),
  };
}

export function sortGuestLists(lists: GuestList[]): GuestList[] {
  return [...lists].sort((a, b) =>
    a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })
  );
}

export function filterGuestListsByQuery(
  lists: GuestList[],
  query: string
): GuestList[] {
  const q = query.trim().toLowerCase();
  const sorted = sortGuestLists(lists);
  if (!q) return sorted;
  return sorted.filter(
    (l) =>
      l.nombre.toLowerCase().includes(q) ||
      l.destinatarios_emails.some((e) => e.toLowerCase().includes(q))
  );
}

export function combineGuestSelections(
  ...sources: (string[] | GuestList | null | undefined)[]
): string[] {
  const flat: string[] = [];
  for (const src of sources) {
    if (!src) continue;
    if (Array.isArray(src)) {
      flat.push(...src);
    } else if (Array.isArray(src.destinatarios_emails)) {
      flat.push(...src.destinatarios_emails);
    }
  }
  return normalizeGuestEmailList(flat);
}

/**
 * Sugiere un nombre o alias inicial editable a partir de la parte local del correo.
 * Ej: "maria.gomez@ejemplo.com" -> "Maria Gomez".
 */
export function defaultAliasFromEmail(email: string | null | undefined): string {
  const clean = normalizeContactEmail(email);
  const atIdx = clean.indexOf('@');
  const local = (atIdx > 0 ? clean.slice(0, atIdx) : clean)
    .replace(/[._+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!local) return '';
  const formatted = local
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return formatted.slice(0, MAX_CONTACT_NAME_LENGTH);
}

export function sortContacts(contacts: UserContact[]): UserContact[] {
  return [...contacts].sort((a, b) => {
    if (a.es_favorito !== b.es_favorito) {
      return a.es_favorito ? -1 : 1;
    }
    return a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });
  });
}

export function filterContactsByQuery(
  contacts: UserContact[],
  query: string
): UserContact[] {
  const q = query.trim().toLowerCase();
  const sorted = sortContacts(contacts);
  if (!q) return sorted;
  return sorted.filter(
    (c) =>
      c.nombre.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q)
  );
}

export function filterSuggestionsByQuery(
  suggestions: ContactSuggestion[],
  savedEmails: Set<string>,
  query: string
): ContactSuggestion[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const result: ContactSuggestion[] = [];
  for (const s of suggestions) {
    const email = normalizeContactEmail(s.email);
    if (!email || savedEmails.has(email) || seen.has(email)) continue;
    if (q && !email.includes(q)) continue;
    seen.add(email);
    result.push({ ...s, email });
  }
  return result;
}

function normalizeContactRow(raw: any): UserContact {
  return {
    id: String(raw?.id ?? ''),
    nombre: String(raw?.nombre ?? '').trim(),
    email: normalizeContactEmail(raw?.email),
    es_favorito: Boolean(raw?.es_favorito),
    created_at: typeof raw?.created_at === 'string' ? raw.created_at : undefined,
    updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : undefined,
  };
}

function normalizeSuggestionRow(raw: any): ContactSuggestion {
  return {
    email: normalizeContactEmail(raw?.email),
    veces_invitado: typeof raw?.veces_invitado === 'number' ? raw.veces_invitado : 1,
    ultima_invitacion_at: String(raw?.ultima_invitacion_at ?? ''),
  };
}

/**
 * Servicio de agenda privada de contactos frecuentes.
 * - Toda operación deriva la identidad exclusivamente de `auth.uid()` en PostgreSQL.
 * - Nunca consulta usuarios globalmente ni expone si un correo está registrado.
 * - Guardar un contacto jamás envía invitaciones automáticamente.
 */
export const userContactsService = {
  async listar(
    encuentroId?: string
  ): Promise<ContactsServiceResult<ContactsAndSuggestionsPayload>> {
    const { data, error } = await supabase.rpc('listar_contactos_y_sugerencias_seguro', {
      p_encuentro_id: encuentroId ?? null,
    });
    if (error) {
      console.error('[userContactsService] listar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok) {
      return { ok: false, error: (r?.error ?? 'unknown_error') as ContactsErrorCode };
    }
    const contactos = Array.isArray(r.contactos)
      ? r.contactos.map(normalizeContactRow).filter((c: UserContact) => c.id && c.email)
      : [];
    const savedSet = new Set<string>(contactos.map((c: UserContact) => c.email));
    const sugerencias = Array.isArray(r.sugerencias)
      ? r.sugerencias
          .map(normalizeSuggestionRow)
          .filter((s: ContactSuggestion) => s.email && !savedSet.has(s.email))
      : [];
    const yaInvitados = Array.isArray(r.ya_invitados_encuentro)
      ? r.ya_invitados_encuentro
          .map((e: unknown) => (typeof e === 'string' ? normalizeContactEmail(e) : ''))
          .filter(Boolean)
      : [];

    return {
      ok: true,
      data: {
        contactos: sortContacts(contactos),
        sugerencias,
        ya_invitados_encuentro: Array.from(new Set(yaInvitados)),
      },
    };
  },

  async guardar(params: {
    nombre: string;
    email: string;
    esFavorito?: boolean;
    contactoId?: string;
  }): Promise<ContactsServiceResult<{ contacto: UserContact }>> {
    const { data, error } = await supabase.rpc('guardar_contacto_usuario_seguro', {
      p_nombre: params.nombre.trim(),
      p_email: normalizeContactEmail(params.email),
      p_es_favorito: Boolean(params.esFavorito),
      p_contacto_id: params.contactoId ?? null,
    });
    if (error) {
      console.error('[userContactsService] guardar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok || !r?.contacto) {
      return { ok: false, error: (r?.error ?? 'unknown_error') as ContactsErrorCode };
    }
    return {
      ok: true,
      data: { contacto: normalizeContactRow(r.contacto) },
    };
  },

  async alternarFavorito(
    contactoId: string,
    esFavorito?: boolean
  ): Promise<ContactsServiceResult<{ id: string; es_favorito: boolean }>> {
    const { data, error } = await supabase.rpc(
      'alternar_favorito_contacto_usuario_seguro',
      {
        p_contacto_id: contactoId,
        p_es_favorito: typeof esFavorito === 'boolean' ? esFavorito : null,
      }
    );
    if (error) {
      console.error('[userContactsService] alternarFavorito:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok) {
      return { ok: false, error: (r?.error ?? 'unknown_error') as ContactsErrorCode };
    }
    return {
      ok: true,
      data: { id: String(r.id), es_favorito: Boolean(r.es_favorito) },
    };
  },

  async eliminar(contactoId: string): Promise<ContactsServiceResult> {
    const { data, error } = await supabase.rpc('eliminar_contacto_usuario_seguro', {
      p_contacto_id: contactoId,
    });
    if (error) {
      console.error('[userContactsService] eliminar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    return r?.ok
      ? { ok: true }
      : { ok: false, error: (r?.error ?? 'unknown_error') as ContactsErrorCode };
  },
};

function normalizeGuestListRow(raw: any): GuestList {
  const emails = Array.isArray(raw?.destinatarios_emails)
    ? normalizeGuestEmailList(
        raw.destinatarios_emails.map((e: unknown) =>
          typeof e === 'string' ? e : ''
        )
      )
    : [];
  return {
    id: String(raw?.id ?? ''),
    nombre: String(raw?.nombre ?? '').trim(),
    destinatarios_emails: emails,
    destinatarios_count:
      typeof raw?.destinatarios_count === 'number'
        ? raw.destinatarios_count
        : emails.length,
    created_at: typeof raw?.created_at === 'string' ? raw.created_at : undefined,
    updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : undefined,
  };
}

function normalizeGuestListSuggestionRow(raw: any): GuestListSuggestion {
  const emails = Array.isArray(raw?.emails)
    ? normalizeGuestEmailList(
        raw.emails.map((e: unknown) => (typeof e === 'string' ? e : ''))
      )
    : [];
  return {
    emails,
    destinatarios_count:
      typeof raw?.destinatarios_count === 'number'
        ? raw.destinatarios_count
        : emails.length,
    veces_usado: typeof raw?.veces_usado === 'number' ? raw.veces_usado : 1,
    ultima_invitacion_at: String(raw?.ultima_invitacion_at ?? ''),
    nombre_sugerido: String(raw?.nombre_sugerido ?? '').trim(),
  };
}

/**
 * Servicio de listas privadas reutilizables de invitados.
 * - Propiedad validada mediante `auth.uid()` en PostgreSQL.
 * - Correos normalizados e independientes del registro de contactos.
 * - Guardar, editar o seleccionar una lista jamás envía invitaciones automáticamente.
 */
export const guestListsService = {
  async listar(
    encuentroId?: string
  ): Promise<ContactsServiceResult<GuestListsPayload>> {
    const { data, error } = await supabase.rpc('listar_listas_invitados_seguro', {
      p_encuentro_id: encuentroId ?? null,
    });
    if (error) {
      console.error('[guestListsService] listar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok) {
      return { ok: false, error: (r?.error ?? 'unknown_error') as ContactsErrorCode };
    }
    const listas = Array.isArray(r.listas)
      ? r.listas
          .map(normalizeGuestListRow)
          .filter((l: GuestList) => l.id && l.nombre && l.destinatarios_emails.length > 0)
      : [];
    const sugerencias_listas = Array.isArray(r.sugerencias_listas)
      ? r.sugerencias_listas
          .map(normalizeGuestListSuggestionRow)
          .filter((s: GuestListSuggestion) => s.emails.length >= 2)
      : [];
    const yaInvitados = Array.isArray(r.ya_invitados_encuentro)
      ? r.ya_invitados_encuentro
          .map((e: unknown) => (typeof e === 'string' ? normalizeContactEmail(e) : ''))
          .filter(Boolean)
      : [];

    return {
      ok: true,
      data: {
        listas: sortGuestLists(listas),
        sugerencias_listas,
        ya_invitados_encuentro: Array.from(new Set(yaInvitados)),
      },
    };
  },

  async guardar(params: {
    nombre: string;
    emails: string[];
    listaId?: string;
  }): Promise<ContactsServiceResult<{ lista: GuestList }>> {
    const cleanEmails = normalizeGuestEmailList(params.emails);
    const { data, error } = await supabase.rpc('guardar_lista_invitados_seguro', {
      p_nombre: params.nombre.trim(),
      p_emails: cleanEmails,
      p_lista_id: params.listaId ?? null,
    });
    if (error) {
      console.error('[guestListsService] guardar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok || !r?.lista) {
      return { ok: false, error: (r?.error ?? 'unknown_error') as ContactsErrorCode };
    }
    return {
      ok: true,
      data: { lista: normalizeGuestListRow(r.lista) },
    };
  },

  async renombrar(
    listaId: string,
    nombre: string
  ): Promise<ContactsServiceResult<{ lista: GuestList }>> {
    const { data, error } = await supabase.rpc('renombrar_lista_invitados_seguro', {
      p_lista_id: listaId,
      p_nombre: nombre.trim(),
    });
    if (error) {
      console.error('[guestListsService] renombrar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok || !r?.lista) {
      return { ok: false, error: (r?.error ?? 'unknown_error') as ContactsErrorCode };
    }
    return {
      ok: true,
      data: { lista: normalizeGuestListRow(r.lista) },
    };
  },

  async eliminar(listaId: string): Promise<ContactsServiceResult> {
    const { data, error } = await supabase.rpc('eliminar_lista_invitados_seguro', {
      p_lista_id: listaId,
    });
    if (error) {
      console.error('[guestListsService] eliminar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    return r?.ok
      ? { ok: true }
      : { ok: false, error: (r?.error ?? 'unknown_error') as ContactsErrorCode };
  },
};
