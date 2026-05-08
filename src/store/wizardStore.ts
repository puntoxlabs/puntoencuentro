import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

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
  tema: string;
  encuentro_id: string | null;
  setField: (field: string, value: any) => void;
  nextStep: () => void;
  prevStep: () => void;
  reset: () => void;
}

export const useWizardStore = create<WizardState>()(
  persist(
    (set) => ({
      step: 1,
      titulo: '',
      fecha: '',
      hora: '',
      descripcion: '',
      modalidad: null,
      lugar_texto: '',
      link_virtual: '',
      tipo_invitacion: null,
      tema: 'blue',
      encuentro_id: null,
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
        tema: 'blue',
        encuentro_id: null,
      }),
    }),
    {
      name: 'wizard-storage',
      version: 1,
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          try {
            const val = localStorage.getItem(name);
            if (!val) return null;
            // Validate it's at least an object with expected properties if needed, 
            // but migrate handles the object structure.
            JSON.parse(val); 
            return val;
          } catch (e) {
            console.warn('wizardStore: Invalid local storage data, clearing...', e);
            localStorage.removeItem(name);
            return null;
          }
        },
        setItem: (name, value) => {
          try { localStorage.setItem(name, value); } catch (e) {}
        },
        removeItem: (name) => {
          try { localStorage.removeItem(name); } catch (e) {}
        }
      })),
      migrate: (persistedState: any, version: number) => {
        console.log(`[wizardStore] Migrating version ${version}`, persistedState);
        
        // Initial state for fallback
        const initialState: WizardState = {
          step: 1,
          titulo: '',
          fecha: '',
          hora: '',
          descripcion: '',
          modalidad: null,
          lugar_texto: '',
          link_virtual: '',
          tipo_invitacion: null,
          tema: 'blue',
          encuentro_id: null,
          setField: () => {},
          nextStep: () => {},
          prevStep: () => {},
          reset: () => {},
        };

        if (version === 0 || !persistedState || typeof persistedState !== 'object') {
          return initialState;
        }

        // Ensure all fields are valid strings or expected types
        const state = persistedState as any;
        return {
          ...initialState,
          ...state,
          step: typeof state.step === 'number' ? state.step : 1,
          titulo: typeof state.titulo === 'string' ? state.titulo : '',
          fecha: typeof state.fecha === 'string' ? state.fecha : '',
          hora: typeof state.hora === 'string' ? state.hora : '',
          descripcion: typeof state.descripcion === 'string' ? state.descripcion : '',
          modalidad: (state.modalidad === 'presencial' || state.modalidad === 'virtual') ? state.modalidad : null,
          lugar_texto: typeof state.lugar_texto === 'string' ? state.lugar_texto : '',
          link_virtual: typeof state.link_virtual === 'string' ? state.link_virtual : '',
          tipo_invitacion: (state.tipo_invitacion === 'individual' || state.tipo_invitacion === 'link_general') ? state.tipo_invitacion : null,
          tema: typeof state.tema === 'string' ? state.tema : 'blue',
          encuentro_id: typeof state.encuentro_id === 'string' ? state.encuentro_id : null,
        };
      },
    }
  )
);

