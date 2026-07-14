import { create } from 'zustand';

interface DetailCache {
  encuentro: any;
  participantes: any[];
  lastFetch: number;
  scrollPosition: number;
}

interface DetailState {
  cache: Record<string, DetailCache>;
  setDetailData: (id: string, encuentro: any, participantes: any[]) => void;
  setScrollPosition: (id: string, position: number) => void;
  getValidCache: (id: string) => DetailCache | null;
  invalidateCache: (id: string) => void;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const useDetailStore = create<DetailState>((set, get) => ({
  cache: {},
  setDetailData: (id, encuentro, participantes) =>
    set((state) => ({
      cache: {
        ...state.cache,
        [id]: {
          ...(state.cache[id] || { scrollPosition: 0 }),
          encuentro,
          participantes,
          lastFetch: Date.now(),
        }
      }
    })),
  setScrollPosition: (id, position) =>
    set((state) => {
      const existing = state.cache[id];
      if (!existing) return state;
      return {
        cache: {
          ...state.cache,
          [id]: { ...existing, scrollPosition: position }
        }
      };
    }),
  getValidCache: (id) => {
    const cached = get().cache[id];
    if (cached && (Date.now() - cached.lastFetch < CACHE_DURATION)) {
      return cached;
    }
    return null;
  },
  invalidateCache: (id) =>
    set((state) => {
      const newCache = { ...state.cache };
      if (newCache[id]) {
        newCache[id].lastFetch = 0;
      }
      return { cache: newCache };
    }),
}));
