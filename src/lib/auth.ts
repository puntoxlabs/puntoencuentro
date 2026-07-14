import { supabase } from '@/lib/supabase';

/**
 * Gets the current host_id from localStorage, or generates a new one if it doesn't exist.
 * Used as anonymous identifier when no authenticated session is present.
 */
export const getHostId = (): string => {
  const HOST_KEY = 'puntoencuentro_host_id';
  let hostId = localStorage.getItem(HOST_KEY);

  if (!hostId) {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      hostId = crypto.randomUUID();
    } else {
      hostId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    localStorage.setItem(HOST_KEY, hostId);
  }

  return hostId;
};

/**
 * Returns the authenticated Supabase user's ID if there is an active session, or null otherwise.
 * This is an async call — use it in async contexts (e.g. service calls, effect hooks).
 */
export const getCurrentUserId = async (): Promise<string | null> => {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
};
