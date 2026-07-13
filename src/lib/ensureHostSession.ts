import { supabase } from './supabase';
import type { User } from '@supabase/supabase-js';

export type HostSessionResult = {
  user: User;
  isAnonymous: boolean;
};

let pendingHostSession: Promise<HostSessionResult> | null = null;

export async function ensureHostSession(captchaToken?: string): Promise<HostSessionResult> {
  if (pendingHostSession) {
    return pendingHostSession;
  }

  pendingHostSession = (async () => {
    try {
      // Intentar obtener la sesión actual
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError) {
        throw sessionError;
      }

      const user = session?.user;

      // Si existe una sesión (permanente o anónima), la reutilizamos.
      if (user && session) {
        return {
          user,
          isAnonymous: Boolean(user.is_anonymous),
        };
      }

      // Si no hay sesión, creamos una cuenta anónima de Supabase
      console.log('[HostSession] anonymous sign-in start');
      const { data: anonData, error: anonError } = await supabase.auth.signInAnonymously({
        options: {
          captchaToken,
        },
      });
      console.log('[HostSession] anonymous sign-in completed');

      if (anonError) {
        throw anonError;
      }

      if (!anonData.user || !anonData.session) {
        throw new Error('No se pudo crear la sesión anónima de Supabase.');
      }

      return {
        user: anonData.user,
        isAnonymous: Boolean(anonData.user.is_anonymous),
      };
    } finally {
      pendingHostSession = null;
    }
  })();

  return pendingHostSession;
}
