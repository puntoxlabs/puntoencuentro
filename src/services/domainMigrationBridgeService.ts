import { supabase } from '@/lib/supabase';
import { ensureHostSession } from '@/lib/ensureHostSession';
import { collectAllLocalInvitationTokens } from '@/lib/participatedTokens';
import {
  resolveDomainConfig,
  getTargetMigrationOrigin,
  isTrustedBridgeOrigin,
} from '@/config/domainConfig';
import {
  ENABLE_DOMAIN_MIGRATION_BRIDGE,
  ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK,
} from '@/config/features';

export const RETIRED_LOCAL_SESSION_KEY = 'puntoencuentro_identity_migrated_v1';
const USER_ZONES_KEY = 'puntoencuentro_zones_v1';

export type BridgeFlowMode = 'cross_origin_bridge' | 'cross_origin_manual' | 'oauth_upgrade';

export type BridgeSourceState =
  | 'detecting_inventory'
  | 'google_ready'
  | 'empty_clean'
  | 'ready_to_migrate'
  | 'awaiting_handshake'
  | 'manual_code_fallback'
  | 'already_migrated'
  | 'error_recoverable';

export type BridgeReceiveState =
  | 'initializing'
  | 'receiving_auto'
  | 'awaiting_manual_code'
  | 'completed'
  | 'lost_access_help'
  | 'error_recoverable';

export interface MigrationInventory {
  isAnonymous: boolean;
  hasOwnedEncounters: boolean;
  ownedEncountersCount?: number;
  hasParticipantLinks: boolean;
  localTokensCount: number;
  hasServerZones: boolean;
  hasMessages: boolean;
  hasWhatsappContacts: boolean;
  hasCustomTemplates: boolean;
  hasTransferableResources: boolean;
  alreadyMigrated: boolean;
  lastMigratedAt?: string | null;
}

export interface BridgeReadyMessage {
  type: 'PE_BRIDGE_READY';
  target_user_id: string;
  bridge_nonce: string;
}

export interface BridgeCodeMessage {
  type: 'PE_BRIDGE_CODE';
  ticket_token: string;
  bridge_nonce: string;
}

export interface BridgeCompletedMessage {
  type: 'PE_BRIDGE_COMPLETED';
}

export type BridgeMessage =
  | BridgeReadyMessage
  | BridgeCodeMessage
  | BridgeCompletedMessage;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_REGEX = /^[0-9a-f]{32}$/i;
const TOKEN_64_REGEX = /^[0-9a-f]{64}$/i;

/**
 * Traduce códigos técnicos de error a mensajes claros y empáticos para el usuario.
 * Cero jerga técnica (sin "token", "hash", "RPC", "SQL").
 */
export function getMigrationUserMessage(errorCode: string): string {
  switch (errorCode) {
    case 'network_error':
    case 'timeout':
      return 'Se cortó la conexión un segundo mientras verificábamos el traslado. Podés reintentar ahora.';
    case 'ticket_expired':
      return 'Esta llave temporal venció por seguridad. Tus encuentros siguen a salvo en la pestaña anterior.';
    case 'ticket_target_mismatch':
      return 'Esta llave estaba vinculada a otra pestaña. Generá una llave nueva para completar el traslado acá.';
    case 'ticket_already_used':
      return 'Esta llave ya fue utilizada. Si acabás de usarla acá, tus encuentros ya deberían aparecer en el inicio.';
    case 'ticket_revoked':
      return 'Esta llave fue cancelada por seguridad. Podés generar una nueva desde el sitio anterior.';
    case 'anonymous_session_already_migrated':
    case 'source_already_migrated':
      return 'Tus encuentros de este navegador ya pasaron al nuevo sitio. Continuá directamente allá para no dejar nada atrás.';
    case 'target_session_retired':
      return 'Esta sesión ya completó un traslado previo.';
    case 'transfer_ticket_already_pending':
      return 'Tenías un traslado en curso. ¿Querés generar una llave nueva?';
    case 'invalid_token_format':
    case 'ticket_not_found':
      return 'No pudimos reconocer esa llave. Revisá haberla copiado completa desde el botón "Copiar llave".';
    case 'rate_limit_exceeded':
      return 'Hiciste varios intentos seguidos. Esperá unos minutos antes de volver a probar; tus encuentros siguen seguros.';
    case 'no_transferable_resources':
      return 'No encontramos encuentros pendientes de trasladar en este navegador.';
    case 'cross_origin_migration_disabled':
    case 'manual_migration_disabled':
      return 'El traslado entre dominios no está habilitado en este momento.';
    case 'bridge_feature_disabled':
      return 'La funcionalidad de migración de dominio no está activa.';
    case 'popup_blocked':
      return 'El navegador bloqueó la apertura de la nueva ventana. Habilitá las ventanas emergentes o intentá nuevamente.';
    case 'authentication_required':
      return 'Iniciando sesión segura para continuar…';
    default:
      return 'Ocurrió un inconveniente al conectar con el servidor. Tus encuentros no sufrieron ningún cambio.';
  }
}

/**
 * Genera un nonce criptográfico de 128 bits (32 caracteres hexadecimales)
 */
export function generateBridgeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Comprueba si la sesión del navegador actual fue retirada y congelada tras una migración.
 */
export function isLocalSessionRetired(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    return localStorage.getItem(RETIRED_LOCAL_SESSION_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Marca la sesión del navegador actual como retirada.
 * IMPORTANTE: Nunca invoca signOut(), preservando la sesión local para evitar
 * que un clic accidental genere otra cuenta anónima huérfana en el dominio viejo.
 */
export function markLocalSessionRetired(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    localStorage.setItem(RETIRED_LOCAL_SESSION_KEY, 'true');
  } catch {
    /* fail-open */
  }
}

export const domainMigrationBridgeService = {
  /**
   * Indica si el feature flag general del puente está activo.
   */
  isBridgeEnabled(): boolean {
    return ENABLE_DOMAIN_MIGRATION_BRIDGE;
  },

  /**
   * Indica si el feature flag del fallback manual está activo.
   */
  isManualFallbackEnabled(): boolean {
    return ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK;
  },

  /**
   * Inspecciona el inventario local y remoto en el dominio emisor (Dominio A).
   */
  async detectInventory(): Promise<{
    state: BridgeSourceState;
    inventory: MigrationInventory;
    user: any;
  }> {
    const localTokens = collectAllLocalInvitationTokens();
    const isRetired = isLocalSessionRetired();

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    // Caso 1: Usuario con cuenta permanente (Google)
    if (user && !user.is_anonymous) {
      return {
        state: 'google_ready',
        inventory: {
          isAnonymous: false,
          hasOwnedEncounters: false,
          hasParticipantLinks: localTokens.length > 0,
          localTokensCount: localTokens.length,
          hasServerZones: false,
          hasMessages: false,
          hasWhatsappContacts: false,
          hasCustomTemplates: false,
          hasTransferableResources: false,
          alreadyMigrated: false,
        },
        user,
      };
    }

    // Caso 2: Sesión ya retirada localmente
    if (isRetired) {
      return {
        state: 'already_migrated',
        inventory: {
          isAnonymous: true,
          hasOwnedEncounters: false,
          hasParticipantLinks: false,
          localTokensCount: localTokens.length,
          hasServerZones: false,
          hasMessages: false,
          hasWhatsappContacts: false,
          hasCustomTemplates: false,
          hasTransferableResources: false,
          alreadyMigrated: true,
        },
        user,
      };
    }

    // Caso 3: Invitado sin sesión activa pero con invitaciones en localStorage
    if (!user) {
      if (localTokens.length > 0) {
        return {
          state: 'ready_to_migrate',
          inventory: {
            isAnonymous: true,
            hasOwnedEncounters: false,
            hasParticipantLinks: true,
            localTokensCount: localTokens.length,
            hasServerZones: false,
            hasMessages: false,
            hasWhatsappContacts: false,
            hasCustomTemplates: false,
            hasTransferableResources: true,
            alreadyMigrated: false,
          },
          user: null,
        };
      }
      return {
        state: 'empty_clean',
        inventory: {
          isAnonymous: false,
          hasOwnedEncounters: false,
          hasParticipantLinks: false,
          localTokensCount: 0,
          hasServerZones: false,
          hasMessages: false,
          hasWhatsappContacts: false,
          hasCustomTemplates: false,
          hasTransferableResources: false,
          alreadyMigrated: false,
        },
        user: null,
      };
    }

    // Caso 4: Sesión anónima en Supabase -> consultar get_anonymous_upgrade_state()
    try {
      const { data, error } = await supabase.rpc('get_anonymous_upgrade_state');
      if (error || !data || data.ok === false) {
        // Fallback defensivo usando tokens locales
        const hasLocal = localTokens.length > 0;
        return {
          state: hasLocal ? 'ready_to_migrate' : 'empty_clean',
          inventory: {
            isAnonymous: true,
            hasOwnedEncounters: false,
            hasParticipantLinks: hasLocal,
            localTokensCount: localTokens.length,
            hasServerZones: false,
            hasMessages: false,
            hasWhatsappContacts: false,
            hasCustomTemplates: false,
            hasTransferableResources: hasLocal,
            alreadyMigrated: false,
          },
          user,
        };
      }

      if (data.already_migrated) {
        markLocalSessionRetired();
        return {
          state: 'already_migrated',
          inventory: {
            isAnonymous: true,
            hasOwnedEncounters: false,
            hasParticipantLinks: false,
            localTokensCount: localTokens.length,
            hasServerZones: false,
            hasMessages: false,
            hasWhatsappContacts: false,
            hasCustomTemplates: false,
            hasTransferableResources: false,
            alreadyMigrated: true,
            lastMigratedAt: data.last_migrated_at,
          },
          user,
        };
      }

      const hasTransferable = Boolean(
        data.has_transferable_resources || localTokens.length > 0
      );

      return {
        state: hasTransferable ? 'ready_to_migrate' : 'empty_clean',
        inventory: {
          isAnonymous: true,
          hasOwnedEncounters: Boolean(data.has_owned_encounters),
          hasParticipantLinks: Boolean(data.has_participant_links || localTokens.length > 0),
          localTokensCount: localTokens.length,
          hasServerZones: Boolean(data.has_server_zones),
          hasMessages: Boolean(data.has_messages),
          hasWhatsappContacts: Boolean(data.has_whatsapp_contacts),
          hasCustomTemplates: Boolean(data.has_custom_templates),
          hasTransferableResources: hasTransferable,
          alreadyMigrated: false,
        },
        user,
      };
    } catch {
      return {
        state: localTokens.length > 0 ? 'ready_to_migrate' : 'empty_clean',
        inventory: {
          isAnonymous: true,
          hasOwnedEncounters: false,
          hasParticipantLinks: localTokens.length > 0,
          localTokensCount: localTokens.length,
          hasServerZones: false,
          hasMessages: false,
          hasWhatsappContacts: false,
          hasCustomTemplates: false,
          hasTransferableResources: localTokens.length > 0,
          alreadyMigrated: false,
        },
        user,
      };
    }
  },

  /**
   * Prepara y sincroniza los recursos locales antes de emitir cualquier llave.
   * Si el usuario es null pero tiene tokens locales, inicializa ensureHostSession()
   * y llama a vincular_tokens_participante_lote_seguro.
   */
  async prepareSourceResources(): Promise<{ ok: boolean; error?: string }> {
    const localTokens = collectAllLocalInvitationTokens();

    let {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.user && localTokens.length > 0) {
      try {
        const hostSession = await ensureHostSession();
        session = { user: hostSession.user } as any;
      } catch (err: any) {
        return { ok: false, error: err?.message || 'ensure_session_failed' };
      }
    }

    if (!session?.user) {
      return { ok: true };
    }

    // Sincronizar zonas locales si existen en localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const rawZones = localStorage.getItem(USER_ZONES_KEY);
        if (rawZones) {
          const parsedZones = JSON.parse(rawZones);
          if (Array.isArray(parsedZones) && parsedZones.length > 0) {
            await supabase.rpc('set_user_localidades_seguro', {
              p_locality_ids: parsedZones,
              p_user_id: session.user.id,
            });
          }
        }
      } catch {
        /* fail-open */
      }
    }

    // Pre-vincular lote de tokens de invitados locales
    if (localTokens.length > 0) {
      try {
        await supabase.rpc('vincular_tokens_participante_lote_seguro', {
          p_tokens: localTokens,
        });
      } catch (err: any) {
        if (err?.message === 'anonymous_session_already_migrated') {
          markLocalSessionRetired();
          return { ok: false, error: 'anonymous_session_already_migrated' };
        }
        // Continuar si es transitorio
      }
    }

    return { ok: true };
  },

  /**
   * Inicia el flujo automático del puente (Dominio A -> Dominio B).
   * Abre popup, espera PE_BRIDGE_READY con uid_B y nonce, emite ticket atado
   * y entrega PE_BRIDGE_CODE con validación estricta de origen y nonce.
   */
  startBridgeHandshake(options: {
    targetOrigin?: string;
    onStateChange: (state: BridgeSourceState) => void;
    onError: (errorCode: string, rawError?: any) => void;
    onManualFallbackReady?: (manualToken: string, expiresAt: string) => void;
  }): { cancel: () => void } {
    let isCancelled = false;
    let fallbackTimeoutId: any = null;
    let popupWindow: Window | null = null;
    let messageListener: ((evt: MessageEvent) => void) | null = null;

    const targetOrigin =
      options.targetOrigin || getTargetMigrationOrigin();

    const cleanup = () => {
      if (fallbackTimeoutId) {
        clearTimeout(fallbackTimeoutId);
        fallbackTimeoutId = null;
      }
      if (messageListener && typeof window !== 'undefined') {
        window.removeEventListener('message', messageListener);
        messageListener = null;
      }
    };

    const execute = async () => {
      options.onStateChange('awaiting_handshake');

      // 1. Pre-sincronizar recursos
      const prep = await domainMigrationBridgeService.prepareSourceResources();
      if (!prep.ok) {
        cleanup();
        options.onError(prep.error || 'prepare_resources_failed');
        return;
      }

      if (isCancelled) return;

      // 2. Abrir ventana receptora en Dominio B
      const targetUrl = `${targetOrigin}/migrate-receive?mode=popup`;
      try {
        popupWindow = window.open(targetUrl, 'puntoencuentro_bridge_popup');
      } catch {
        popupWindow = null;
      }

      if (!popupWindow) {
        // Bloqueo de popup o WebView sin window.open
        if (domainMigrationBridgeService.isManualFallbackEnabled()) {
          void switchToManualFallback();
        } else {
          cleanup();
          options.onError('popup_blocked');
        }
        return;
      }

      // 3. Fallback timer a 2.500 ms si Dominio B no responde el handshake
      fallbackTimeoutId = setTimeout(() => {
        if (isCancelled) return;
        if (domainMigrationBridgeService.isManualFallbackEnabled()) {
          void switchToManualFallback();
        } else {
          cleanup();
          options.onError('timeout');
        }
      }, 2500);

      // 4. Listener postMessage seguro
      messageListener = async (event: MessageEvent) => {
        if (isCancelled) return;

        // Validar origen estricto (ADV-08)
        if (!isTrustedBridgeOrigin(event.origin)) {
          return;
        }

        // Validar ventana
        if (event.source !== popupWindow) {
          return;
        }

        const data = event.data;
        if (!data || typeof data !== 'object') return;

        // --- HANDSHAKE: PE_BRIDGE_READY ---
        if (data.type === 'PE_BRIDGE_READY') {
          if (fallbackTimeoutId) {
            clearTimeout(fallbackTimeoutId);
            fallbackTimeoutId = null;
          }

          const targetUserId = data.target_user_id;
          const bridgeNonce = data.bridge_nonce;

          if (!targetUserId || !UUID_REGEX.test(targetUserId)) {
            options.onError('invalid_target_user');
            return;
          }

          if (!bridgeNonce || !NONCE_REGEX.test(bridgeNonce)) {
            options.onError('invalid_bridge_nonce');
            return;
          }

          // Emitir ticket cross_origin_bridge atado al target
          try {
            const { data: ticketData, error: ticketError } = await supabase.rpc(
              'create_domain_migration_ticket_seguro',
              {
                p_flow_mode: 'cross_origin_bridge',
                p_intended_target_user_id: targetUserId,
              }
            );

            if (ticketError) {
              cleanup();
              options.onError(ticketError.message);
              return;
            }

            const ticketRes = ticketData as any;
            if (!ticketRes?.ok || !ticketRes.ticket_token) {
              cleanup();
              options.onError(ticketRes?.error || 'ticket_creation_failed');
              return;
            }

            // Entregar código temporal por postMessage hacia event.origin (NUNCA '*')
            const codeMessage: BridgeCodeMessage = {
              type: 'PE_BRIDGE_CODE',
              ticket_token: ticketRes.ticket_token,
              bridge_nonce: bridgeNonce,
            };

            popupWindow?.postMessage(codeMessage, event.origin);
          } catch (err: any) {
            cleanup();
            options.onError(err?.message || 'ticket_creation_failed');
          }
          return;
        }

        // --- CONFIRMACIÓN: PE_BRIDGE_COMPLETED ---
        if (data.type === 'PE_BRIDGE_COMPLETED') {
          cleanup();
          markLocalSessionRetired();
          options.onStateChange('already_migrated');
        }
      };

      window.addEventListener('message', messageListener);
    };

    const switchToManualFallback = async () => {
      cleanup();
      options.onStateChange('manual_code_fallback');

      try {
        await supabase.rpc('revoke_my_pending_transfer_ticket');
        const { data, error } = await supabase.rpc(
          'create_domain_migration_ticket_seguro',
          {
            p_flow_mode: 'cross_origin_manual',
            p_intended_target_user_id: null,
          }
        );

        if (error) {
          options.onError(error.message);
          return;
        }

        const res = data as any;
        if (res?.ok && res.ticket_token && res.expires_at) {
          options.onManualFallbackReady?.(res.ticket_token, res.expires_at);
        } else {
          options.onError(res?.error || 'manual_ticket_failed');
        }
      } catch (err: any) {
        options.onError(err?.message || 'manual_ticket_failed');
      }
    };

    void execute();

    return {
      cancel: () => {
        isCancelled = true;
        cleanup();
        void (async () => {
          try {
            await supabase.rpc('revoke_my_pending_transfer_ticket');
          } catch {}
        })();
        options.onStateChange('ready_to_migrate');
      },
    };
  },

  /**
   * Emite llave temporal manual con TTL de 3 minutos (modo manual).
   */
  async createManualMigrationTicket(): Promise<{
    ok: boolean;
    ticket_token?: string;
    expires_at?: string;
    error?: string;
  }> {
    if (!domainMigrationBridgeService.isManualFallbackEnabled()) {
      return { ok: false, error: 'manual_migration_disabled' };
    }

    try {
      await supabase.rpc('revoke_my_pending_transfer_ticket');
      const { data, error } = await supabase.rpc(
        'create_domain_migration_ticket_seguro',
        {
          p_flow_mode: 'cross_origin_manual',
          p_intended_target_user_id: null,
        }
      );
      if (error) return { ok: false, error: error.message };
      const res = data as any;
      if (!res?.ok) return { ok: false, error: res?.error || 'unknown_error' };
      return {
        ok: true,
        ticket_token: res.ticket_token,
        expires_at: res.expires_at,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Revoca cualquier ticket pendiente del usuario emisor.
   */
  async cancelPendingMigration(): Promise<boolean> {
    try {
      const { data } = await supabase.rpc('revoke_my_pending_transfer_ticket');
      return (data as any)?.ok ?? true;
    } catch {
      return false;
    }
  },

  // =========================================================================
  // MÉTODOS DEL DOMINIO RECEPTOR (Dominio B / /migrate-receive)
  // =========================================================================

  /**
   * Asegura la sesión del destinatario en Dominio B.
   * Si no hay sesión, crea una cuenta anónima técnica limpia.
   */
  async ensureTargetUser(): Promise<{ user: any; isAnonymous: boolean }> {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.user) {
      return {
        user: session.user,
        isAnonymous: Boolean(session.user.is_anonymous),
      };
    }

    const hostSession = await ensureHostSession();
    return {
      user: hostSession.user,
      isAnonymous: hostSession.isAnonymous,
    };
  },

  /**
   * Canjea un ticket de migración en Dominio B.
   * Si falla por corte de red, intenta confirmar idempotentemente con
   * confirmar_migracion_dominio_completada_seguro.
   */
  async claimMigrationTicket(ticketToken: string): Promise<{
    ok: boolean;
    alreadyCompleted?: boolean;
    resourcesTransferred?: any;
    error?: string;
  }> {
    const cleanToken = ticketToken.replace(/[\s-]+/g, '').toLowerCase();

    if (!cleanToken || !TOKEN_64_REGEX.test(cleanToken)) {
      return { ok: false, error: 'invalid_token_format' };
    }

    try {
      const { data, error } = await supabase.rpc(
        'claim_domain_migration_ticket_seguro',
        {
          p_ticket_token: cleanToken,
        }
      );

      if (error) {
        // Caída de red o 500 post-commit: intentar confirmación idempotente
        return await domainMigrationBridgeService.confirmMigrationCompleted(cleanToken);
      }

      const res = data as any;
      if (res?.ok) {
        return {
          ok: true,
          resourcesTransferred: res.resources_transferred,
        };
      }

      // Si retornó error de negocio:
      if (res?.error === 'ticket_already_used') {
        // Verificar si fue usado exitosamente por esta misma sesión
        const confirmed = await domainMigrationBridgeService.confirmMigrationCompleted(cleanToken);
        if (confirmed.ok) {
          return confirmed;
        }
      }

      return { ok: false, error: res?.error || 'claim_failed' };
    } catch {
      // Excepción de red de cliente: reintentar con confirmación idempotente
      return await domainMigrationBridgeService.confirmMigrationCompleted(cleanToken);
    }
  },

  /**
   * Confirmación idempotente de migración ante caída de red post-commit (ADV-15).
   */
  async confirmMigrationCompleted(ticketToken: string): Promise<{
    ok: boolean;
    alreadyCompleted?: boolean;
    resourcesTransferred?: any;
    error?: string;
  }> {
    const cleanToken = ticketToken.replace(/[\s-]+/g, '').toLowerCase();
    if (!cleanToken || !TOKEN_64_REGEX.test(cleanToken)) {
      return { ok: false, error: 'invalid_token_format' };
    }

    try {
      const { data, error } = await supabase.rpc(
        'confirmar_migracion_dominio_completada_seguro',
        {
          p_ticket_token: cleanToken,
        }
      );

      if (error) {
        return { ok: false, error: error.message };
      }

      const res = data as any;
      if (res?.ok && res.already_completed) {
        return {
          ok: true,
          alreadyCompleted: true,
          resourcesTransferred: res.resources_transferred,
        };
      }

      return { ok: false, error: res?.error || 'transfer_not_confirmed' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'network_error' };
    }
  },

  /**
   * Configura la escucha en Dominio B para recibir el handshake automático.
   */
  listenForBridgeCodeOnReceive(options: {
    sourceOpener: Window;
    targetUserId: string;
    onCodeReceived: (ticketToken: string) => void;
    onError: (errorCode: string) => void;
  }): { nonce: string; cleanup: () => void } {
    const bridgeNonce = generateBridgeNonce();
    let isCleanedUp = false;

    const messageListener = (event: MessageEvent) => {
      if (isCleanedUp) return;

      // Validar origen confiable
      if (!isTrustedBridgeOrigin(event.origin)) {
        return;
      }

      // Validar que provenga de la ventana opener
      if (event.source !== options.sourceOpener) {
        return;
      }

      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'PE_BRIDGE_CODE') {
        // Validar nonce
        if (data.bridge_nonce !== bridgeNonce) {
          options.onError('bridge_nonce_mismatch');
          return;
        }

        const token = data.ticket_token;
        if (!token || !TOKEN_64_REGEX.test(token)) {
          options.onError('invalid_token_format');
          return;
        }

        options.onCodeReceived(token);
      }
    };

    window.addEventListener('message', messageListener);

    // Enviar PE_BRIDGE_READY al opener
    const readyMessage: BridgeReadyMessage = {
      type: 'PE_BRIDGE_READY',
      target_user_id: options.targetUserId,
      bridge_nonce: bridgeNonce,
    };

    // Obtenemos origen seguro a partir de document.referrer o dominio canónico
    let targetOrigin = '*';
    try {
      if (document.referrer) {
        const refOrigin = new URL(document.referrer).origin;
        if (isTrustedBridgeOrigin(refOrigin)) {
          targetOrigin = refOrigin;
        }
      }
    } catch {
      targetOrigin = '*';
    }

    if (targetOrigin !== '*') {
      options.sourceOpener.postMessage(readyMessage, targetOrigin);
    } else {
      // Si el referrer no coincide con un origen confiable, usamos el canónico de config
      const cfg = resolveDomainConfig();
      options.sourceOpener.postMessage(readyMessage, cfg.canonicalOrigin);
    }

    return {
      nonce: bridgeNonce,
      cleanup: () => {
        isCleanedUp = true;
        window.removeEventListener('message', messageListener);
      },
    };
  },
};
