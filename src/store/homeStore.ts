import { create } from 'zustand';

interface HomeState {
  encuentros: any[];
  lastFetch: number;
  scrollPosition: number;
  setEncuentros: (encuentros: any[]) => void;
  setScrollPosition: (position: number) => void;
  invalidateCache: () => void;
  getValidCache: () => any[] | null;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const useHomeStore = create<HomeState>((set, get) => ({
  encuentros: [],
  lastFetch: 0,
  scrollPosition: 0,
  setEncuentros: (encuentros) => set({ encuentros, lastFetch: Date.now() }),
  setScrollPosition: (position) => set({ scrollPosition: position }),
  invalidateCache: () => set({ lastFetch: 0 }),
  getValidCache: () => {
    const { encuentros, lastFetch } = get();
    if (lastFetch > 0 && (Date.now() - lastFetch < CACHE_DURATION)) {
      return encuentros;
    }
    return null;
  }
}));
