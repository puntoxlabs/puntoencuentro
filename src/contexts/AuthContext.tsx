import React, { createContext, useContext, useEffect, useState } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { participantesService } from '@/services/participantesService';

const RECENT_PARTICIPANT_KEY = 'pending_participant_invitation_token';

export type GoogleSignInResult =
  | {
      ok: true;
      alreadyLoggedIn?: boolean;
    }
  | {
      ok: false;
      error:
        | 'anonymous_account_linking_pending'
        | 'oauth_start_failed';
    };

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAuthenticated: boolean;
  isAnonymousUser: boolean;
  isPermanentUser: boolean;
  signInWithGoogle: () => Promise<GoogleSignInResult>;
  signInWithGoogleForCoordination: () => Promise<GoogleSignInResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  isAuthenticated: false,
  isAnonymousUser: false,
  isPermanentUser: false,
  signInWithGoogle: async () => ({ ok: false, error: 'oauth_start_failed' }),
  signInWithGoogleForCoordination: async () => ({ ok: false, error: 'oauth_start_failed' }),
  signOut: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Obtener sesión inicial
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    // Escuchar cambios de estado
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      setLoading(false);

      if (
        event === 'SIGNED_IN' ||
        event === 'INITIAL_SESSION' ||
        event === 'TOKEN_REFRESHED'
      ) {
        window.setTimeout(() => {
          void (async () => {
            const pendingToken = sessionStorage.getItem(RECENT_PARTICIPANT_KEY);
            if (pendingToken && newSession?.user?.id) {
              try {
                await participantesService.linkParticipantTokenToCurrentUser(pendingToken);
                sessionStorage.removeItem(RECENT_PARTICIPANT_KEY); // Éxito o idempotente
              } catch (err: any) {
                if (err.message === 'participant_already_linked' || err.message === 'invalid_participant_token') {
                  sessionStorage.removeItem(RECENT_PARTICIPANT_KEY); // No reintentar si ya pertenece a otro o es inválido
                }
                // Fallo silencioso (por ej. red temporal), conservamos el token para reintentar
              }
            }
          })();
        }, 0);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = async (): Promise<GoogleSignInResult> => {
    if (user?.is_anonymous) {
      if (import.meta.env.DEV) console.log('Bloqueo temporal: no se permite login sobre sesión anónima');
      return { ok: false, error: 'anonymous_account_linking_pending' };
    }
    if (user && !user.is_anonymous) {
      return { ok: true, alreadyLoggedIn: true };
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (error) {
      return { ok: false, error: 'oauth_start_failed' };
    }

    return { ok: true };
  };

  const signInWithGoogleForCoordination = async (): Promise<GoogleSignInResult> => {
    if (user?.is_anonymous) {
      await supabase.auth.signOut();
    }
    if (user && !user.is_anonymous) {
      return { ok: true, alreadyLoggedIn: true };
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (error) {
      return { ok: false, error: 'oauth_start_failed' };
    }

    return { ok: true };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const isAuthenticated = Boolean(user);
  const isAnonymousUser = Boolean(user?.is_anonymous);
  const isPermanentUser = Boolean(user && !user.is_anonymous);

  return (
    <AuthContext.Provider value={{
      user, session, loading,
      isAuthenticated, isAnonymousUser, isPermanentUser,
      signInWithGoogle, signInWithGoogleForCoordination, signOut
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
