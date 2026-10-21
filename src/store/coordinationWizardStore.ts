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
  mostrarRespuestasAInvitados: boolean;
  visibilidadRespuestas: 'hidden' | 'summary' | 'detail';

  // Marca el borrador originado por Repetir encuentro / Favoritos (enlaza invitados pendientes)
  repeatToken: string | null;
}

interface CoordinationWizardStore {
  draft: CoordinationDraft;
  step: number;
  updateDraft: (updates: Partial<CoordinationDraft>) => void;
  setStep: (step: number | ((prev: number) => number)) => void;
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
  mostrarRespuestasAInvitados: false,
  visibilidadRespuestas: 'hidden',
  repeatToken: null,
};

export const useCoordinationWizardStore = create<CoordinationWizardStore>()(
  persist(
    (set) => ({
      draft: { ...initialDraft },
      step: 1,
      updateDraft: (updates) =>
        set((state) => ({ draft: { ...state.draft, ...updates } })),
      setStep: (stepOrFn) =>
        set((state) => ({
          step: Math.max(1, Math.min(4, typeof stepOrFn === 'function' ? stepOrFn(state.step || 1) : stepOrFn)),
        })),
      setOptions: (options) =>
        set((state) => ({ draft: { ...state.draft, options } })),
      resetDraft: () => set({ draft: { ...initialDraft }, step: 1 }),
    }),
    {
      name: 'pe-coordination-wizard-storage',
    }
  )
);
