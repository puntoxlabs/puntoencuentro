import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { InvitationTheme } from '@/lib/invitationThemes';

export interface CoordinationDateOption {
  localId: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
}

export interface CoordinationDraft {
  dateMode: 'coordination';
  title: string;
  description: string;
  modality: 'presencial' | 'virtual';
  locationText: string;
  virtualLink: string;
  options: CoordinationDateOption[];
  responseDeadline: string | null;
  durationMinutes: number | null;
  invitationType: 'individual' | 'link_general';
  invitationTheme: InvitationTheme;
  invitationTemplate: string;

  // Helpers temporales para la UI, no se envían al backend
  personalMessage: string;
  hostAlias: string;
}

interface CoordinationWizardStore {
  draft: CoordinationDraft;
  updateDraft: (updates: Partial<CoordinationDraft>) => void;
  resetDraft: () => void;
  setOptions: (options: CoordinationDateOption[]) => void;
}

const initialDraft: CoordinationDraft = {
  dateMode: 'coordination',
  title: '',
  description: '',
  modality: 'presencial',
  locationText: '',
  virtualLink: '',
  options: [],
  responseDeadline: null,
  durationMinutes: null,
  invitationType: 'link_general',
  invitationTheme: 'classic',
  invitationTemplate: '',
  personalMessage: '',
  hostAlias: '',
};

export const useCoordinationWizardStore = create<CoordinationWizardStore>()(
  persist(
    (set) => ({
      draft: { ...initialDraft },
      updateDraft: (updates) =>
        set((state) => ({ draft: { ...state.draft, ...updates } })),
      setOptions: (options) =>
        set((state) => ({ draft: { ...state.draft, options } })),
      resetDraft: () => set({ draft: { ...initialDraft } }),
    }),
    {
      name: 'pe-coordination-wizard-storage',
    }
  )
);
