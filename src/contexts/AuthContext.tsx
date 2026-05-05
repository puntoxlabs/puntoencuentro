import React, { createContext, useContext, useEffect, useState } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { participantesService } from '@/services/participantesService';

const RECENT_PARTICIPANT_KEY = 'puntoencuentro_recent_participant_id';

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  signInWithGoogle: async () => {},
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

      // Vinculación post-login: solo si el usuario acaba de iniciar sesión
      if (event === 'SIGNED_IN' && newSession?.user?.id) {
        const recentParticipantId = sessionStorage.getItem(RECENT_PARTICIPANT_KEY);
        if (recentParticipantId) {
          // Limpiar antes de vincular para evitar reintentos en refrescos
          sessionStorage.removeItem(RECENT_PARTICIPANT_KEY);
          participantesService
            .linkUserToParticipante(recentParticipantId, newSession.user.id)
            .then(() => {
              console.log('[AUTH] Participante reciente vinculado a usuario:', newSession.user.id);
            })
            .catch((err) => {
              console.error('[AUTH] Error al vincular participante reciente:', err);
              // No mostramos alert — fallo silencioso para no romper el flujo
            });
        }
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
