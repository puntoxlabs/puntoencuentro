import { create } from 'zustand';

interface HomeState {
  encuentros: any[];
  lastFetch: number;
  scrollPosition: number;
  setEncuentros: (encuentros: any[]) => void;
  setScrollPosition: (position: number) => void;
  invalidateCache: () => void;
}

export const useHomeStore = create<HomeState>((set) => ({
  encuentros: [],
  lastFetch: 0,
  scrollPosition: 0,
  setEncuentros: (encuentros) => set({ encuentros, lastFetch: Date.now() }),
  setScrollPosition: (position) => set({ scrollPosition: position }),
  invalidateCache: () => set({ lastFetch: 0 }),
}));
