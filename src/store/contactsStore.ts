import { create } from 'zustand';
import type {
  ContactsAndSuggestionsPayload,
  ContactSuggestion,
  UserContact,
} from '@/types/userContacts';
import { normalizeContactEmail, sortContacts } from '@/services/userContactsService';

/**
 * Estado en memoria (nunca persistido en localStorage) de la agenda de contactos
 * frecuentes y selección de destinatarios del usuario permanente actual.
 * Se limpia automáticamente al cerrar o cambiar de sesión.
 */
interface ContactsState {
  ownerUserId: string | null;
  contacts: UserContact[];
  suggestions: ContactSuggestion[];
  alreadyInvitedEmails: string[];
  selectedEmails: string[];
  ensureSession: (userId: string | null) => void;
  setData: (userId: string, payload: ContactsAndSuggestionsPayload) => void;
  upsertContact: (contact: UserContact) => void;
  updateFavorite: (id: string, esFavorito: boolean) => void;
  removeContact: (id: string) => void;
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
    set({
      ownerUserId: userId,
      contacts: sortContacts(payload.contactos),
      suggestions: payload.sugerencias.filter(
        (s) => !savedSet.has(normalizeContactEmail(s.email))
      ),
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
      contacts: s.contacts.filter((c) => c.id !== id),
    })),

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
