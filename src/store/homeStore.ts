import { create } from 'zustand';

interface HomeState {
  encuentros: any[];
  participatedEncuentros: any[];
  lastFetch: number;
  scrollPosition: number;
  filterStatus: 'all' | 'active' | 'finished' | 'cancelled';
  filterType: 'all' | 'fixed' | 'coordination';
  filterCoordinationState: 'all' | 'open' | 'expired' | 'closed';
  sortBy: 'date_upcoming' | 'date_distant' | 'name_asc' | 'name_desc';
  setEncuentros: (organized: any[], participated?: any[]) => void;
  setScrollPosition: (position: number) => void;
  setFilterStatus: (status: 'all' | 'active' | 'finished' | 'cancelled') => void;
  setFilterType: (type: 'all' | 'fixed' | 'coordination') => void;
  setFilterCoordinationState: (state: 'all' | 'open' | 'expired' | 'closed') => void;
  setSortBy: (sortBy: 'date_upcoming' | 'date_distant' | 'name_asc' | 'name_desc') => void;
  resetFilters: () => void;
  invalidateCache: () => void;
  getValidCache: () => { organized: any[], participated: any[] } | null;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const useHomeStore = create<HomeState>((set, get) => ({
  encuentros: [],
  participatedEncuentros: [],
  lastFetch: 0,
  scrollPosition: 0,
  filterStatus: 'all',
  filterType: 'all',
  filterCoordinationState: 'all',
  sortBy: 'date_upcoming',
  setEncuentros: (organized, participated = []) => set({
    encuentros: organized,
    participatedEncuentros: participated,
    lastFetch: Date.now()
  }),
  setScrollPosition: (position) => set({ scrollPosition: position }),
  setFilterStatus: (status) => set({ filterStatus: status }),
  setFilterType: (type) => set({ filterType: type, filterCoordinationState: 'all' }),
  setFilterCoordinationState: (state) => set({ filterCoordinationState: state }),
  setSortBy: (sortBy) => set({ sortBy }),
  resetFilters: () => set({ filterStatus: 'all', filterType: 'all', filterCoordinationState: 'all', sortBy: 'date_upcoming' }),
  invalidateCache: () => set({ lastFetch: 0 }),
  getValidCache: () => {
    const { encuentros, participatedEncuentros, lastFetch } = get();
    if (lastFetch > 0 && (Date.now() - lastFetch < CACHE_DURATION)) {
      return {
        organized: encuentros || [],
        participated: participatedEncuentros || []
      };
    }
    return null;
  }
}));
