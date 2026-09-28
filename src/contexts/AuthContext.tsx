import React, { createContext, useContext, useEffect, useState } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { participantesService } from '@/services/participantesService';

const RECENT_PARTICIPANT_KEY = 'pending_participant_invitation_token';
const PENDING_OPEN_REQUEST_KEY = 'pending_open_request';

export type GoogleSignInResult =
  | {
      ok: true;
      alreadyLoggedIn?: boolean;
    }
  | {
      ok: false;
      error:
        | 'anonymous_account_linking_pending'
        | 'oauth_start_failed'
        | 'anonymous_has_critical_resources';
    };

/**
 * Contexto del estado de recursos de un usuario anónimo antes del upgrade.
 * Devuelto por checkAnonymousUpgradeState.
 */
export interface AnonymousUpgradeState {
  isAnonymous: boolean;
  hasOwnedEncounters: boolean;
  hasServerZones: boolean;
}

/**
 * Contexto de una solicitud pendiente de sumarse a un encuentro.
 * Se persiste en sessionStorage para sobrevivir el redirect OAuth.
 */
export interface PendingOpenRequest {
  encounterId: string;
  applicantName?: string;
  applicantMessage?: string;
  action: 'request_join';
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAuthenticated: boolean;
  isAnonymousUser: boolean;
  isPermanentUser: boolean;
  signInWithGoogle: () => Promise<GoogleSignInResult>;
  signInWithGoogleForCoordination: () => Promise<GoogleSignInResult>;
  /**
   * Inicia el flujo de login/upgrade hacia Google para Discovery.
   *
   * Estrategia según estado del usuario anónimo:
   *   - Sin sesión: OAuth directo.
   *   - Anónimo SIN recursos críticos: signOut seguro + OAuth.
   *   - Anónimo CON encuentros propios: linkIdentity (preserva UUID).
   *   - Ya permanente: no hace nada (retorna alreadyLoggedIn).
   *
   * El llamador debe guardar el pendingOpenRequest en sessionStorage
   * ANTES de llamar a este método.
   */
  signInWithGoogleForDiscovery: () => Promise<GoogleSignInResult>;
  /**
   * Verifica server-side si el usuario anónimo actual tiene recursos
   * que deben preservarse antes de hacer signOut.
   */
  checkAnonymousUpgradeState: () => Promise<AnonymousUpgradeState | null>;
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
  signInWithGoogleForDiscovery: async () => ({ ok: false, error: 'oauth_start_failed' }),
  checkAnonymousUpgradeState: async () => null,
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
            const newUser = newSession?.user;
            if (!newUser || newUser.is_anonymous) return;

            // 1. Vincular token de participante pendiente (invitaciones privadas)
            const pendingToken = sessionStorage.getItem(RECENT_PARTICIPANT_KEY);
            if (pendingToken) {
              try {
                await participantesService.linkParticipantTokenToCurrentUser(pendingToken);
                sessionStorage.removeItem(RECENT_PARTICIPANT_KEY);
              } catch (err: any) {
                if (
                  err.message === 'participant_already_linked' ||
                  err.message === 'invalid_participant_token'
                ) {
                  sessionStorage.removeItem(RECENT_PARTICIPANT_KEY);
                }
                // Fallo silencioso en red temporal — conservar token para reintentar
              }
            }

            // 2. Recuperar pending_open_request (Discovery — solicitar sumarse)
            // El componente que lee este storage es HomeOpenEncounterDetailSheet,
            // que lo consume cuando el encuentro se reabre con encounterId en estado.
            // Aquí solo dejamos la marca; el componente consumidor es responsable de leerla.
            // (No navegamos aquí para no romper flujos de redirección ya existentes.)
          })();
        }, 0);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Métodos de login ──────────────────────────────────────────────────────

  const signInWithGoogle = async (): Promise<GoogleSignInResult> => {
    if (user?.is_anonymous) {
      if (import.meta.env.DEV) console.log('[Auth] Bloqueo: no se permite login sobre sesión anónima via signInWithGoogle');
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

  /**
   * Verifica server-side si el usuario anónimo tiene recursos críticos.
   * Llama a get_anonymous_upgrade_state() que solo devuelve booleanos de existencia.
   */
  const checkAnonymousUpgradeState = async (): Promise<AnonymousUpgradeState | null> => {
    if (!user?.is_anonymous) return null;
    try {
      const { data, error } = await supabase.rpc('get_anonymous_upgrade_state');
      if (error || !data) return null;
      const d = data as any;
      return {
        isAnonymous: Boolean(d.is_anonymous),
        hasOwnedEncounters: Boolean(d.has_owned_encounters),
        hasServerZones: Boolean(d.has_server_zones),
      };
    } catch {
      return null;
    }
  };

  /**
   * Flujo de login para Discovery (solicitar sumarse a un encuentro abierto).
   *
   * Estrategia:
   *   - Ya permanente: no hace nada.
   *   - Sin sesión: OAuth directo.
   *   - Anónimo SIN encuentros propios: signOut + OAuth (caso A — simple).
   *     Las zonas vienen de localStorage y se re-sincronizan post-login.
   *   - Anónimo CON encuentros propios: linkIdentity (caso B — preserva UUID).
   *     Requiere que "Manual Linking" esté habilitado en el proyecto Supabase.
   *     Si linkIdentity falla, retorna 'anonymous_has_critical_resources' para
   *     que la UI muestre un mensaje de error sin perder datos.
   */
  const signInWithGoogleForDiscovery = async (): Promise<GoogleSignInResult> => {
    // Ya autenticado permanente
    if (user && !user.is_anonymous) {
      return { ok: true, alreadyLoggedIn: true };
    }

    if (user?.is_anonymous) {
      // Verificar recursos server-side
      const upgradeState = await checkAnonymousUpgradeState();

      if (upgradeState?.hasOwnedEncounters) {
        // Caso B: tiene encuentros propios — intentar linking para preservar UUID
        if (import.meta.env.DEV) console.log('[Auth] Anónimo con encuentros propios — usando linkIdentity');
        const { error } = await supabase.auth.linkIdentity({
          provider: 'google',
          options: {
            redirectTo: window.location.origin,
          },
        });
        if (error) {
          console.error('[Auth] linkIdentity falló:', error.message);
          // No hacer signOut destructivo — retornar error para que la UI informe
          return { ok: false, error: 'anonymous_has_critical_resources' };
        }
        // linkIdentity inicia redirect OAuth — el usuario conservará su UUID
        return { ok: true };
      }

      // Caso A: anónimo sin encuentros propios — signOut seguro + OAuth
      if (import.meta.env.DEV) console.log('[Auth] Anónimo sin encuentros críticos — signOut + OAuth');
      await supabase.auth.signOut();
    }

    // Sin sesión o después de signOut — OAuth directo
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
      signInWithGoogle,
      signInWithGoogleForCoordination,
      signInWithGoogleForDiscovery,
      checkAnonymousUpgradeState,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);

/** Clave de sessionStorage para pending_open_request */
export const PENDING_OPEN_REQUEST_KEY_EXPORT = PENDING_OPEN_REQUEST_KEY;
