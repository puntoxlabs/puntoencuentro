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

const PENDING_TRANSFER_TICKET_KEY = 'pe_pending_transfer_ticket';

/**
 * Contexto del estado de recursos de un usuario anónimo antes del upgrade.
 * Devuelto por checkAnonymousUpgradeState.
 */
export interface AnonymousUpgradeState {
  isAnonymous: boolean;
  hasOwnedEncounters: boolean;
  hasServerZones: boolean;
  hasParticipantLinks: boolean;
  hasOpenRequests: boolean;
  hasCustomTemplates: boolean;
  hasAiSessions: boolean;
  hasCreationSessions: boolean;
  hasOtherTransferableResources: boolean;
  hasTransferableResources: boolean;
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
   *   - Anónimo SIN recursos transferibles: signOut seguro + OAuth.
   *   - Anónimo CON recursos transferibles: emite Transfer Ticket y procede a OAuth SIN signOut destructivo.
   *   - Ya permanente: no hace nada (retorna alreadyLoggedIn).
   */
  signInWithGoogleForDiscovery: () => Promise<GoogleSignInResult>;
  /**
   * Verifica server-side si el usuario anónimo actual tiene recursos transferibles.
   */
  checkAnonymousUpgradeState: () => Promise<AnonymousUpgradeState | null>;
  /**
   * Genera un ticket de transferencia seguro para la sesión anónima actual.
   */
  createTransferTicket: () => Promise<{ ok: boolean; ticket_token?: string; error?: string }>;
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
  createTransferTicket: async () => ({ ok: false, error: 'not_initialized' }),
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

            // 0. Canjear Transfer Ticket si el usuario unificó cuenta anónima con Google
            const pendingTransferTicket = sessionStorage.getItem(PENDING_TRANSFER_TICKET_KEY);
            if (pendingTransferTicket) {
              try {
                const { data: claimData, error: claimErr } = await supabase.rpc('claim_anonymous_transfer', {
                  p_transfer_token: pendingTransferTicket,
                });
                if (claimErr || (claimData && !claimData.ok)) {
                  console.warn('[Auth] claim_anonymous_transfer result:', claimData || claimErr);
                } else if (import.meta.env.DEV) {
                  console.log('[Auth] Recursos transferidos con éxito a la cuenta permanente:', claimData);
                }
              } catch (err) {
                console.error('[Auth] Error claiming anonymous transfer ticket:', err);
              } finally {
                sessionStorage.removeItem(PENDING_TRANSFER_TICKET_KEY);
              }
            }

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
   * Verifica server-side si el usuario anónimo tiene recursos transferibles.
   * Llama a get_anonymous_upgrade_state() con el inventario completo.
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
        hasParticipantLinks: Boolean(d.has_participant_links),
        hasOpenRequests: Boolean(d.has_open_requests),
        hasCustomTemplates: Boolean(d.has_custom_templates),
        hasAiSessions: Boolean(d.has_ai_sessions),
        hasCreationSessions: Boolean(d.has_creation_sessions),
        hasOtherTransferableResources: Boolean(d.has_other_transferable_resources),
        hasTransferableResources: Boolean(d.has_transferable_resources),
      };
    } catch {
      return null;
    }
  };

  /**
   * Genera un ticket de transferencia criptográfico para la sesión anónima actual.
   * Guarda el token resultante en sessionStorage (nunca en URL o logs).
   */
  const createTransferTicket = async (): Promise<{ ok: boolean; ticket_token?: string; error?: string }> => {
    if (!user?.is_anonymous) {
      return { ok: false, error: 'anonymous_user_required' };
    }
    try {
      const { data, error } = await supabase.rpc('create_anonymous_transfer_ticket');
      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as any;
      if (res?.ok && res.ticket_token) {
        sessionStorage.setItem(PENDING_TRANSFER_TICKET_KEY, res.ticket_token);
      }
      return res;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  };

  /**
   * Flujo de login para Discovery (solicitar sumarse a un encuentro abierto).
   *
   * Estrategia de seguridad e identidad:
   *   - Ya permanente: no hace nada (retorna alreadyLoggedIn).
   *   - Anónimo CON recursos transferibles: emite Transfer Ticket y procede a OAuth SIN signOut
   *     destructivo (si el usuario cancela en Google, conserva su sesión anónima en localStorage).
   *   - Anónimo SIN recursos transferibles: signOut limpio seguro + OAuth directo.
   */
  const signInWithGoogleForDiscovery = async (): Promise<GoogleSignInResult> => {
    if (user && !user.is_anonymous) {
      return { ok: true, alreadyLoggedIn: true };
    }

    if (user?.is_anonymous) {
      const upgradeState = await checkAnonymousUpgradeState();

      if (upgradeState?.hasTransferableResources) {
        if (import.meta.env.DEV) console.log('[Auth] Anónimo con recursos transferibles — emitiendo ticket');
        try {
          const res = await createTransferTicket();
          if (!res.ok && res.error !== 'transfer_ticket_already_pending') {
            console.warn('[Auth] Transfer ticket warning:', res.error);
          }
        } catch (err) {
          console.error('[Auth] Error generating transfer ticket:', err);
        }
        // IMPORTANTE: NO hacer signOut(); preserva la sesión anónima en localStorage
        // en caso de que el usuario cierre o cancele el consentimiento en Google.
      } else {
        if (import.meta.env.DEV) console.log('[Auth] Anónimo sin recursos transferibles — signOut seguro');
        await supabase.auth.signOut();
      }
    }

    // Iniciar OAuth directo a Google
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
      createTransferTicket,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);

/** Clave de sessionStorage para pending_open_request */
export const PENDING_OPEN_REQUEST_KEY_EXPORT = PENDING_OPEN_REQUEST_KEY;
