import { create } from 'zustand';
import type {
  ContactsAndSuggestionsPayload,
  ContactSuggestion,
  GuestList,
  GuestListsPayload,
  GuestListSuggestion,
  UserContact,
} from '@/types/userContacts';
import {
  normalizeContactEmail,
  normalizeGuestEmailList,
  sortContacts,
  sortGuestLists,
} from '@/services/userContactsService';

function canonicalSetKey(emails: string[]): string {
  return [...normalizeGuestEmailList(emails)].sort().join('|');
}

/**
 * Estado en memoria (nunca persistido en localStorage) de la agenda de contactos
 * frecuentes, listas reutilizables de invitados y selección de destinatarios del
 * usuario permanente actual.
 * Se limpia automáticamente al cerrar o cambiar de sesión.
 */
interface ContactsState {
  ownerUserId: string | null;
  contacts: UserContact[];
  suggestions: ContactSuggestion[];
  lists: GuestList[];
  listSuggestions: GuestListSuggestion[];
  alreadyInvitedEmails: string[];
  selectedEmails: string[];
  ensureSession: (userId: string | null) => void;
  setData: (userId: string, payload: ContactsAndSuggestionsPayload) => void;
  setListsData: (userId: string, payload: GuestListsPayload) => void;
  upsertContact: (contact: UserContact) => void;
  updateFavorite: (id: string, esFavorito: boolean) => void;
  removeContact: (id: string) => void;
  upsertList: (list: GuestList) => void;
  removeList: (id: string) => void;
  selectList: (listOrEmails: GuestList | string[]) => void;
  unselectList: (listOrEmails: GuestList | string[]) => void;
  toggleSelectEmail: (email: string) => void;
  selectEmails: (emails: string[]) => void;
  unselectEmail: (email: string) => void;
  clearSelection: () => void;
  reset: () => void;
}

const EMPTY_STATE = {
  ownerUserId: null as string | null,
  contacts: [] as UserContact[],
  suggestions: [] as ContactSuggestion[],
  lists: [] as GuestList[],
  listSuggestions: [] as GuestListSuggestion[],
  alreadyInvitedEmails: [] as string[],
  selectedEmails: [] as string[],
};

export const useContactsStore = create<ContactsState>()((set, get) => ({
  ...EMPTY_STATE,

  ensureSession: (userId) => {
    const current = get().ownerUserId;
    if (!userId || (current && current !== userId)) {
      set({ ...EMPTY_STATE, ownerUserId: userId ?? null });
    } else if (!current && userId) {
      set({ ownerUserId: userId });
    }
  },

  setData: (userId, payload) => {
    const savedSet = new Set(payload.contactos.map((c) => normalizeContactEmail(c.email)));
    const alreadySet = new Set(
      payload.ya_invitados_encuentro.map((e) => normalizeContactEmail(e)).filter(Boolean)
    );
    const prevSelected = get().ownerUserId === userId ? get().selectedEmails : [];
    const prevLists = get().ownerUserId === userId ? get().lists : [];
    const prevListSuggestions = get().ownerUserId === userId ? get().listSuggestions : [];
    set({
      ownerUserId: userId,
      contacts: sortContacts(payload.contactos),
      suggestions: payload.sugerencias.filter(
        (s) => !savedSet.has(normalizeContactEmail(s.email))
      ),
      lists: prevLists,
      listSuggestions: prevListSuggestions,
      alreadyInvitedEmails: Array.from(alreadySet),
      selectedEmails: prevSelected.filter((e) => !alreadySet.has(e)),
    });
  },

  setListsData: (userId, payload) => {
    const prev = get();
    const isSameOwner = prev.ownerUserId === userId;
    const nextLists = sortGuestLists(
      payload.listas.map((l) => {
        const cleanEmails = normalizeGuestEmailList(l.destinatarios_emails);
        return {
          ...l,
          destinatarios_emails: cleanEmails,
          destinatarios_count: cleanEmails.length,
        };
      })
    );
    const savedKeys = new Set(
      nextLists.map((l) => canonicalSetKey(l.destinatarios_emails))
    );
    const seenSugKeys = new Set<string>();
    const nextListSuggestions: GuestListSuggestion[] = [];
    for (const sg of payload.sugerencias_listas) {
      const cleanEmails = normalizeGuestEmailList(sg.emails);
      if (cleanEmails.length < 2) continue;
      const key = canonicalSetKey(cleanEmails);
      if (savedKeys.has(key) || seenSugKeys.has(key)) continue;
      seenSugKeys.add(key);
      nextListSuggestions.push({
        ...sg,
        emails: cleanEmails,
        destinatarios_count: cleanEmails.length,
      });
    }
    const alreadySet = new Set(
      (payload.ya_invitados_encuentro.length > 0
        ? payload.ya_invitados_encuentro
        : isSameOwner
        ? prev.alreadyInvitedEmails
        : []
      )
        .map((e) => normalizeContactEmail(e))
        .filter(Boolean)
    );
    const prevSelected = isSameOwner ? prev.selectedEmails : [];

    set({
      ownerUserId: userId,
      contacts: isSameOwner ? prev.contacts : [],
      suggestions: isSameOwner ? prev.suggestions : [],
      lists: nextLists,
      listSuggestions: nextListSuggestions,
      alreadyInvitedEmails: Array.from(alreadySet),
      selectedEmails: prevSelected.filter((e) => !alreadySet.has(e)),
    });
  },

  upsertContact: (contact) =>
    set((s) => {
      const cleanEmail = normalizeContactEmail(contact.email);
      const filtered = s.contacts.filter(
        (c) => c.id !== contact.id && normalizeContactEmail(c.email) !== cleanEmail
      );
      const nextContacts = sortContacts([
        ...filtered,
        { ...contact, email: cleanEmail },
      ]);
      const nextSuggestions = s.suggestions.filter(
        (sg) => normalizeContactEmail(sg.email) !== cleanEmail
      );
      // Las listas guardadas son independientes de contactos_usuario y nunca se alteran
      return {
        contacts: nextContacts,
        suggestions: nextSuggestions,
      };
    }),

  updateFavorite: (id, esFavorito) =>
    set((s) => ({
      contacts: sortContacts(
        s.contacts.map((c) => (c.id === id ? { ...c, es_favorito: esFavorito } : c))
      ),
    })),

  removeContact: (id) =>
    set((s) => ({
      // Eliminar un contacto nunca altera las listas guardadas
      contacts: s.contacts.filter((c) => c.id !== id),
    })),

  upsertList: (list) =>
    set((s) => {
      const cleanEmails = normalizeGuestEmailList(list.destinatarios_emails);
      const normalizedList: GuestList = {
        ...list,
        nombre: list.nombre.trim(),
        destinatarios_emails: cleanEmails,
        destinatarios_count: cleanEmails.length,
      };
      const filtered = s.lists.filter(
        (l) =>
          l.id !== normalizedList.id &&
          l.nombre.trim().toLowerCase() !== normalizedList.nombre.toLowerCase()
      );
      const nextLists = sortGuestLists([...filtered, normalizedList]);
      const savedKeys = new Set(
        nextLists.map((l) => canonicalSetKey(l.destinatarios_emails))
      );
      const nextListSuggestions = s.listSuggestions.filter(
        (sg) => !savedKeys.has(canonicalSetKey(sg.emails))
      );
      return {
        lists: nextLists,
        listSuggestions: nextListSuggestions,
      };
    }),

  removeList: (id) =>
    set((s) => ({
      lists: s.lists.filter((l) => l.id !== id),
    })),

  selectList: (listOrEmails) =>
    set((s) => {
      const emails = Array.isArray(listOrEmails)
        ? listOrEmails
        : listOrEmails.destinatarios_emails;
      const already = new Set(s.alreadyInvitedEmails);
      const merged = new Set(s.selectedEmails);
      for (const raw of emails) {
        const clean = normalizeContactEmail(raw);
        if (clean && !already.has(clean)) {
          merged.add(clean);
        }
      }
      return { selectedEmails: Array.from(merged) };
    }),

  unselectList: (listOrEmails) =>
    set((s) => {
      const emails = Array.isArray(listOrEmails)
        ? listOrEmails
        : listOrEmails.destinatarios_emails;
      const toRemove = new Set(emails.map((e) => normalizeContactEmail(e)).filter(Boolean));
      return {
        selectedEmails: s.selectedEmails.filter((e) => !toRemove.has(e)),
      };
    }),

  toggleSelectEmail: (email) =>
    set((s) => {
      const clean = normalizeContactEmail(email);
      if (!clean || s.alreadyInvitedEmails.includes(clean)) return s;
      const exists = s.selectedEmails.includes(clean);
      return {
        selectedEmails: exists
          ? s.selectedEmails.filter((e) => e !== clean)
          : [...s.selectedEmails, clean],
      };
    }),

  selectEmails: (emails) =>
    set((s) => {
      const already = new Set(s.alreadyInvitedEmails);
      const merged = new Set(s.selectedEmails);
      for (const raw of emails) {
        const clean = normalizeContactEmail(raw);
        if (clean && !already.has(clean)) {
          merged.add(clean);
        }
      }
      return { selectedEmails: Array.from(merged) };
    }),

  unselectEmail: (email) =>
    set((s) => {
      const clean = normalizeContactEmail(email);
      return { selectedEmails: s.selectedEmails.filter((e) => e !== clean) };
    }),

  clearSelection: () => set({ selectedEmails: [] }),

  reset: () => set({ ...EMPTY_STATE }),
}));
