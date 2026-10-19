import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Contexto efímero de una repetición "con invitados".
 *
 * - Los correos viven SOLO en sessionStorage (se borran al cerrar la pestaña) y expiran.
 * - Nunca se envían invitaciones desde aquí: el organizador debe confirmarlas expresamente
 *   en la pantalla del encuentro ya creado (PendingGuestsReview).
 * - `sessionToken` enlaza este contexto con el borrador del wizard que lo originó, de modo que
 *   un encuentro creado por otra vía nunca reciba invitados pendientes por error.
 * - `linkCandidate` (enlace de reunión virtual anterior) vive solo en memoria y requiere un
 *   clic explícito para reutilizarse.
 */
export const REPEAT_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

interface RepeatPersisted {
  ownerUserId: string | null;
  sessionToken: string | null;
  guestEmails: string[];
  targetEncuentroId: string | null;
  createdAt: number | null;
}

interface RepeatEncounterState extends RepeatPersisted {
  linkCandidate: string | null;
  start: (p: {
    ownerUserId: string | null;
    sessionToken: string;
    guestEmails: string[];
    linkCandidate: string | null;
  }) => void;
  /** Enlaza los invitados pendientes con el encuentro recién creado. Devuelve true si enlazó. */
  bindEncuentro: (encuentroId: string, wizardToken: string | null | undefined) => boolean;
  removeGuest: (email: string) => void;
  clearGuests: () => void;
  clearLinkCandidate: () => void;
  reset: () => void;
}

const EMPTY: RepeatPersisted = {
  ownerUserId: null,
  sessionToken: null,
  guestEmails: [],
  targetEncuentroId: null,
  createdAt: null,
};

const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, v); },
  };
};

export const useRepeatEncounterStore = create<RepeatEncounterState>()(
  persist(
    (set, get) => ({
      ...EMPTY,
      linkCandidate: null,
      start: ({ ownerUserId, sessionToken, guestEmails, linkCandidate }) =>
        set({
          ownerUserId,
          sessionToken,
          guestEmails: Array.from(new Set(guestEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))),
          targetEncuentroId: null,
          createdAt: Date.now(),
          linkCandidate,
        }),
      bindEncuentro: (encuentroId, wizardToken) => {
        const s = get();
        if (!wizardToken || wizardToken !== s.sessionToken) return false;
        if (s.guestEmails.length === 0) return false;
        set({ targetEncuentroId: encuentroId });
        return true;
      },
      removeGuest: (email) =>
        set((s) => ({ guestEmails: s.guestEmails.filter((e) => e !== email) })),
      clearGuests: () => set({ ...EMPTY, linkCandidate: get().linkCandidate }),
      clearLinkCandidate: () => set({ linkCandidate: null }),
      reset: () => set({ ...EMPTY, linkCandidate: null }),
    }),
    {
      name: 'pe-repeat-encounter-context',
      version: 1,
      storage: createJSONStorage(() =>
        typeof sessionStorage !== 'undefined' ? sessionStorage : memoryStorage()
      ),
      // El enlace privado NUNCA se persiste.
      partialize: (s): RepeatPersisted => ({
        ownerUserId: s.ownerUserId,
        sessionToken: s.sessionToken,
        guestEmails: s.guestEmails,
        targetEncuentroId: s.targetEncuentroId,
        createdAt: s.createdAt,
      }),
    }
  )
);

/**
 * Invitados pendientes de confirmación para un encuentro dado, respetando propietario y vigencia.
 */
export function getPendingGuestsFor(
  state: Pick<RepeatPersisted, 'ownerUserId' | 'guestEmails' | 'targetEncuentroId' | 'createdAt'>,
  encuentroId: string | undefined,
  userId: string | undefined,
  now: number = Date.now()
): string[] {
  if (!encuentroId || !userId) return [];
  if (state.targetEncuentroId !== encuentroId) return [];
  if (state.ownerUserId !== userId) return [];
  if (!state.createdAt || now - state.createdAt > REPEAT_CONTEXT_TTL_MS) return [];
  return state.guestEmails;
}
