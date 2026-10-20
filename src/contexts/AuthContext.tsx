import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { participantesService } from '@/services/participantesService';
import { webPushService } from '@/services/webPushService';
import { useContactsStore } from '@/store/contactsStore';
import { useRepeatEncounterStore } from '@/store/repeatEncounterStore';

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
        | 'anonymous_has_critical_resources'
        | 'ticket_creation_failed'
        | 'inventory_check_failed'
        | string;
    };

export type TransferClaimStatus =
  | 'idle'
  | 'claiming'
  | 'success'
  | 'error_transient'
  | 'error_terminal';

const PENDING_TRANSFER_TICKET_KEY = 'pe_pending_transfer_ticket';
const TRANSFER_CLAIM_RETRIES_KEY = 'pe_transfer_claim_retries';
const MAX_CLAIM_RETRIES = 3;

const TERMINAL_CLAIM_ERRORS = new Set([
  'ticket_expired',
  'ticket_revoked',
  'ticket_already_used',
  'ticket_not_found',
  'source_no_longer_anonymous',
  'source_user_not_found',
  'invalid_token_format',
  'permanent_account_required',
  'cannot_transfer_to_same_user',
]);

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
  /** Compatibilidad: true mientras se procesa activamente el canje del ticket */
  isTransferClaimPending: boolean;
  /** Estado discriminado del reclamo de transferencia post-OAuth */
  transferClaimStatus: TransferClaimStatus;
  /** Código de error del último intento de transferencia si falló */
  transferClaimError: string | null;
  /** Permite al usuario reintentar manualmente la vinculación en caso de fallo transitorio */
  retryTransferClaim: () => Promise<boolean>;
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

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  isTransferClaimPending: false,
  transferClaimStatus: 'idle',
  transferClaimError: null,
  retryTransferClaim: async () => false,
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
  const [transferClaimStatus, setTransferClaimStatus] = useState<TransferClaimStatus>(() => {
    return typeof window !== 'undefined' && Boolean(sessionStorage.getItem(PENDING_TRANSFER_TICKET_KEY))
      ? 'claiming'
      : 'idle';
  });
  const [transferClaimError, setTransferClaimError] = useState<string | null>(null);

  // Guardias de concurrencia y reentrancia
  const claimInFlightRef = useRef<Promise<boolean> | null>(null);
  const claimSucceededRef = useRef<boolean>(false);
  const authDebounceTimerRef = useRef<number | null>(null);

  /**
   * Ejecuta el reclamo del ticket de transferencia pendiente.
   * Maneja de forma atómica la concurrencia evitando llamadas duplicadas,
   * actualiza transferClaimStatus de forma explícita y conserva el token
   * en fallos de red o errores transitorios para permitir reintentos manuales.
   */
  const executeTransferClaim = useCallback(async (isManualRetry = false): Promise<boolean> => {
    // 1. Si ya se canjeó exitosamente en esta sesión:
    if (claimSucceededRef.current) {
      setTransferClaimStatus('success');
      setTransferClaimError(null);
      return true;
    }

    // 2. Si ya hay una solicitud en vuelo, unirse a esa promesa para evitar carreras
    if (claimInFlightRef.current) {
      return claimInFlightRef.current;
    }

    const runClaim = async (): Promise<boolean> => {
      const pendingTransferTicket = typeof window !== 'undefined'
        ? sessionStorage.getItem(PENDING_TRANSFER_TICKET_KEY)
        : null;

      if (!pendingTransferTicket) {
        setTransferClaimStatus('idle');
        setTransferClaimError(null);
        return false;
      }

      setTransferClaimStatus('claiming');
      setTransferClaimError(null);

      const retryCount = parseInt(sessionStorage.getItem(TRANSFER_CLAIM_RETRIES_KEY) || '0', 10);
      if (!isManualRetry && retryCount >= MAX_CLAIM_RETRIES) {
        if (import.meta.env.DEV) {
          console.warn('[Auth] Límite de reintentos automáticos alcanzado para el transfer ticket en esta sesión');
        }
        setTransferClaimStatus('error_transient');
        setTransferClaimError('max_retries_reached');
        return false;
      }

      try {
        const { data: claimData, error: claimErr } = await supabase.rpc('claim_anonymous_transfer', {
          p_transfer_token: pendingTransferTicket,
        });

        if (claimData?.ok === true) {
          if (import.meta.env.DEV) {
            console.log('[Auth] Recursos transferidos con éxito a la cuenta permanente:', claimData);
          }
          sessionStorage.removeItem(PENDING_TRANSFER_TICKET_KEY);
          sessionStorage.removeItem(TRANSFER_CLAIM_RETRIES_KEY);
          claimSucceededRef.current = true;
          setTransferClaimStatus('success');
          setTransferClaimError(null);
          return true;
        } else {
          const errCode = claimData?.error || claimErr?.message || 'unknown_claim_error';
          console.warn('[Auth] claim_anonymous_transfer error:', errCode);

          if (TERMINAL_CLAIM_ERRORS.has(errCode)) {
            // Error terminal irreversible: limpiar storage local para no intentar en vano
            sessionStorage.removeItem(PENDING_TRANSFER_TICKET_KEY);
            sessionStorage.removeItem(TRANSFER_CLAIM_RETRIES_KEY);
            setTransferClaimStatus('error_terminal');
            setTransferClaimError(errCode);
            return false;
          } else {
            // Error transitorio/recuperable: incrementar reintentos y conservar secret
            sessionStorage.setItem(TRANSFER_CLAIM_RETRIES_KEY, String(retryCount + 1));
            setTransferClaimStatus('error_transient');
            setTransferClaimError(errCode);
            return false;
          }
        }
      } catch (err: any) {
        console.error('[Auth] Error claiming anonymous transfer ticket (transient):', err);
        // En fallo de red/5xx/timeout: conservar secret para reintentar
        sessionStorage.setItem(TRANSFER_CLAIM_RETRIES_KEY, String(retryCount + 1));
        setTransferClaimStatus('error_transient');
        setTransferClaimError('network_error');
        return false;
      } finally {
        claimInFlightRef.current = null;
      }
    };

    claimInFlightRef.current = runClaim();
    return claimInFlightRef.current;
  }, []);

  const retryTransferClaim = useCallback(async (): Promise<boolean> => {
    return executeTransferClaim(true);
  }, [executeTransferClaim]);

  useEffect(() => {
    // Obtener sesión inicial
    supabase.auth.getSession().then(({ data }) => {
      const initialUser = data.session?.user ?? null;
      setSession(data.session);
      setUser(initialUser);
      useContactsStore.getState().ensureSession(
        initialUser && !initialUser.is_anonymous ? initialUser.id : null
      );
      setLoading(false);
    });

    // Escuchar cambios de estado
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      const nextUser = newSession?.user ?? null;
      setSession(newSession);
      setUser(nextUser);
      useContactsStore.getState().ensureSession(
        nextUser && !nextUser.is_anonymous ? nextUser.id : null
      );
      setLoading(false);

      if (event === 'SIGNED_OUT') {
        void webPushService.unsubscribeLocalOnly();
        // Privacidad en dispositivos compartidos: sin sesión no se puede autenticar la
        // revocación remota, pero sí cortar la suscripción push local del navegador
        // y limpiar el estado de contactos y repetición.
        useContactsStore.getState().reset();
        useRepeatEncounterStore.getState().reset();
        setTransferClaimStatus('idle');
        setTransferClaimError(null);
        claimSucceededRef.current = false;
        if (authDebounceTimerRef.current) {
          window.clearTimeout(authDebounceTimerRef.current);
          authDebounceTimerRef.current = null;
        }
      }

      if (
        event === 'SIGNED_IN' ||
        event === 'INITIAL_SESSION' ||
        event === 'TOKEN_REFRESHED'
      ) {
        const checkPendingTicket = Boolean(
          typeof window !== 'undefined' && sessionStorage.getItem(PENDING_TRANSFER_TICKET_KEY)
        );
        if (nextUser && !nextUser.is_anonymous && checkPendingTicket && !claimSucceededRef.current) {
          setTransferClaimStatus('claiming');
        }

        if (authDebounceTimerRef.current) {
          window.clearTimeout(authDebounceTimerRef.current);
        }

        // Debounce de 50ms para unificar eventos casi simultáneos (OAuth callback / INITIAL_SESSION / TOKEN_REFRESHED)
        authDebounceTimerRef.current = window.setTimeout(() => {
          void (async () => {
            const newUser = newSession?.user;
            if (!newUser || newUser.is_anonymous) {
              setTransferClaimStatus('idle');
              return;
            }

            // 0. Canjear Transfer Ticket si el usuario unificó cuenta anónima con Google
            await executeTransferClaim(false);

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
        }, 50);
      }
    });

    return () => {
      subscription.unsubscribe();
      if (authDebounceTimerRef.current) {
        window.clearTimeout(authDebounceTimerRef.current);
      }
    };
  }, [executeTransferClaim]);

  // ── Métodos de inventario y transferencia ─────────────────────────────────

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
      if (d?.ok === false) return null;
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
      let { data, error } = await supabase.rpc('create_anonymous_transfer_ticket');
      let res = data as any;

      // Si ya hay un ticket pendiente en DB:
      if (res?.error === 'transfer_ticket_already_pending') {
        const localSecret = sessionStorage.getItem(PENDING_TRANSFER_TICKET_KEY);
        if (localSecret) {
          // Caso A: sessionStorage ya posee el secret del ticket vigente
          return { ok: true, ticket_token: localSecret };
        }

        // Caso B: DB tiene pending pero sessionStorage está vacío (pérdida local).
        // Recuperación segura: revocar el propio ticket pendiente en DB y reintentar creación limpia.
        if (import.meta.env.DEV) console.log('[Auth] Pending ticket sin secret local. Revocando para emitir nuevo...');
        const { data: revokeData } = await supabase.rpc('revoke_my_pending_transfer_ticket');
        const revokeRes = revokeData as any;
        if (!revokeRes?.ok) {
          return { ok: false, error: revokeRes?.error || 'revoke_pending_failed' };
        }

        // Reintentar creación de ticket nuevo
        const retryRes = await supabase.rpc('create_anonymous_transfer_ticket');
        res = retryRes.data as any;
        error = retryRes.error;
      }

      if (error) {
        return { ok: false, error: error.message };
      }

      if (res?.ok && res.ticket_token) {
        sessionStorage.setItem(PENDING_TRANSFER_TICKET_KEY, res.ticket_token);
        sessionStorage.removeItem(TRANSFER_CLAIM_RETRIES_KEY);
        setTransferClaimStatus('claiming');
      }
      return res || { ok: false, error: 'unknown_creation_error' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  };

  // ── Métodos de login unificados ───────────────────────────────────────────

  /**
   * Flujo unificado y seguro de inicio de sesión con Google.
   *
   * Reglas:
   * - Usuario permanente: conservar sesión (ok: true, alreadyLoggedIn: true).
   * - Usuario sin sesión: OAuth directo con Google.
   * - Usuario anónimo CON recursos transferibles: emite Transfer Ticket y procede a OAuth
   *   SIN signOut destructivo (preserva sesión en caso de cancelación en Google).
   * - Usuario anónimo SIN recursos: signOut limpio seguro + OAuth directo.
   * - Si falla la consulta del inventario de recursos: ABORTAR cambio de identidad sin cerrar sesión anónima.
   * - Si falla la emisión del ticket: ABORTAR OAuth y mostrar error recuperable.
   * - Si el usuario cancela Google: preserva su sesión y recursos intactos.
   * - Si falla el canje post-auth: conserva el ticket recuperable en storage para evitar pérdida silenciosa.
   */
  const unifiedSignInWithGoogle = async (): Promise<GoogleSignInResult> => {
    // 1. Usuario permanente: conservar sesión
    if (user && !user.is_anonymous) {
      return { ok: true, alreadyLoggedIn: true };
    }

    // 2. Usuario anónimo: evaluar recursos
    if (user?.is_anonymous) {
      let upgradeState: AnonymousUpgradeState | null = null;
      try {
        upgradeState = await checkAnonymousUpgradeState();
      } catch (err) {
        console.error('[Auth] Error consultando inventario de recursos anónimos:', err);
        upgradeState = null;
      }

      // Si falla la consulta del inventario: ABORTAR de inmediato sin cerrar sesión anónima
      if (!upgradeState) {
        console.error('[Auth] Abortando autenticación Google: falla al consultar inventario de recursos');
        return { ok: false, error: 'inventory_check_failed' };
      }

      if (upgradeState.hasTransferableResources) {
        if (import.meta.env.DEV) console.log('[Auth] Anónimo con recursos — emitiendo y asegurando Transfer Ticket');
        const res = await createTransferTicket();
        const hasSecret = Boolean(sessionStorage.getItem(PENDING_TRANSFER_TICKET_KEY));

        if (!res.ok || !hasSecret) {
          console.error('[Auth] Abortando OAuth: no se pudo asegurar el ticket de transferencia local:', res.error);
          return { ok: false, error: res.error || 'ticket_creation_failed' };
        }
        setTransferClaimStatus('claiming');
        // IMPORTANTE: NO hacer signOut(); preserva la sesión anónima en localStorage
        // en caso de que el usuario cierre o cancele el consentimiento en Google.
      } else {
        if (import.meta.env.DEV) console.log('[Auth] Anónimo sin recursos transferibles — signOut seguro');
        await supabase.auth.signOut();
      }
    }

    // 3. Iniciar OAuth directo a Google
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

  const signInWithGoogle = unifiedSignInWithGoogle;
  const signInWithGoogleForCoordination = unifiedSignInWithGoogle;
  const signInWithGoogleForDiscovery = unifiedSignInWithGoogle;

  const signOut = async () => {
    // Antes de cerrar sesión (necesitamos el JWT para revocar en backend). Nunca lanza.
    await webPushService.cleanupOnSignOut();
    await supabase.auth.signOut();
  };

  const isAuthenticated = Boolean(user);
  const isAnonymousUser = Boolean(user?.is_anonymous);
  const isPermanentUser = Boolean(user && !user.is_anonymous);

  return (
    <AuthContext.Provider value={{
      user, session, loading,
      isTransferClaimPending: transferClaimStatus === 'claiming',
      transferClaimStatus,
      transferClaimError,
      retryTransferClaim,
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
