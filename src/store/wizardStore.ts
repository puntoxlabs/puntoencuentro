import { create } from 'zustand';

interface WizardState {
  step: number;
  titulo: string;
  fecha: string;
  hora: string;
  descripcion: string;
  modalidad: 'presencial' | 'virtual' | null;
  lugar_texto: string;
  link_virtual: string;
  tipo_invitacion: 'individual' | 'link_general' | null;
  setField: (field: string, value: any) => void;
  nextStep: () => void;
  prevStep: () => void;
  reset: () => void;
}

export const useWizardStore = create<WizardState>((set) => ({
  step: 1,
  titulo: '',
  fecha: '',
  hora: '',
  descripcion: '',
  modalidad: null,
  lugar_texto: '',
  link_virtual: '',
  tipo_invitacion: null,
  setField: (field, value) => set({ [field]: value }),
  nextStep: () => set((state) => ({ step: state.step < 4 ? state.step + 1 : state.step })),
  prevStep: () => set((state) => ({ step: state.step > 1 ? state.step - 1 : state.step })),
  reset: () => set({
    step: 1,
    titulo: '',
    fecha: '',
    hora: '',
    descripcion: '',
    modalidad: null,
    lugar_texto: '',
    link_virtual: '',
    tipo_invitacion: null,
  }),
}));
