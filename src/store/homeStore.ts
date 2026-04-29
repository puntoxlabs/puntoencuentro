import { create } from 'zustand';

interface HomeState {
  encuentros: any[];
  lastFetch: number;
  scrollPosition: number;
  filterStatus: 'all' | 'active' | 'finished' | 'cancelled';
  sortBy: 'date_upcoming' | 'date_distant' | 'name_asc' | 'name_desc';
  setEncuentros: (encuentros: any[]) => void;
  setScrollPosition: (position: number) => void;
  setFilterStatus: (status: 'all' | 'active' | 'finished' | 'cancelled') => void;
  setSortBy: (sortBy: 'date_upcoming' | 'date_distant' | 'name_asc' | 'name_desc') => void;
  resetFilters: () => void;
  invalidateCache: () => void;
  getValidCache: () => any[] | null;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const useHomeStore = create<HomeState>((set, get) => ({
  encuentros: [],
  lastFetch: 0,
  scrollPosition: 0,
  filterStatus: 'all',
  sortBy: 'date_upcoming',
  setEncuentros: (encuentros) => set({ encuentros, lastFetch: Date.now() }),
  setScrollPosition: (position) => set({ scrollPosition: position }),
  setFilterStatus: (status) => set({ filterStatus: status }),
  setSortBy: (sortBy) => set({ sortBy }),
  resetFilters: () => set({ filterStatus: 'all', sortBy: 'date_upcoming' }),
  invalidateCache: () => set({ lastFetch: 0 }),
  getValidCache: () => {
    const { encuentros, lastFetch } = get();
    if (lastFetch > 0 && (Date.now() - lastFetch < CACHE_DURATION)) {
      return encuentros;
    }
    return null;
  }
}));
