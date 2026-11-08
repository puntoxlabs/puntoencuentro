import { supabase } from '@/lib/supabase';
import { ensureHostSession } from '@/lib/ensureHostSession';
import { collectAllLocalInvitationTokens } from '@/lib/participatedTokens';
import {
  getTargetMigrationOrigin,
  isTrustedBridgeOrigin,
} from '@/config/domainConfig';
import {
  ENABLE_DOMAIN_MIGRATION_BRIDGE,
  ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK,
} from '@/config/features';

export const RETIRED_LOCAL_SESSION_PREFIX = 'puntoencuentro_identity_retired_user_';
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

export interface PrepareResourcesResult {
  ok: boolean;
  error?: string;
  linkedCount: number;
  alreadyLinkedCount: number;
  skippedCount: number;
  totalTokens: number;
  hasUnrecoveredTokens: boolean;
  isComplete: boolean;
}

export interface CancelMigrationResult {
  ok: boolean;
  revokedCount?: number;
  error?: string;
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
  bridge_nonce: string;
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
    case 'popup_closed':
      return 'Se cerró la ventana de traslado antes de completarlo. Podés iniciar nuevamente cuando quieras.';
    case 'authentication_required':
      return 'Iniciando sesión segura para continuar…';
    case 'untrusted_source_origin':
    case 'untrusted_target_origin':
      return 'No pudimos verificar la autenticidad del sitio para la transferencia.';
    case 'bridge_nonce_mismatch':
      return 'La sesión de transferencia cambió. Iniciá el traslado nuevamente.';
    case 'cancel_failed':
    case 'revoke_failed':
    case 'revoke_rpc_error':
      return 'No se pudo confirmar la cancelación en el servidor. Por seguridad, volvé a intentar cancelar antes de generar una nueva llave.';
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
 * Comprueba si la sesión del usuario especificado fue retirada y congelada tras una migración.
 * Cada sesión se aísla por su UUID para que otro usuario en el mismo navegador no herede el estado.
 */
export function isLocalSessionRetired(userId?: string | null): boolean {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const storage = typeof localStorage !== 'undefined' ? localStorage : win?.localStorage;
  if (!storage) return false;
  try {
    if (userId) {
      return storage.getItem(`${RETIRED_LOCAL_SESSION_PREFIX}${userId}`) !== null;
    }
    // Si no se provee userId, se verifica la clave global histórica (compatibilidad previa)
    return storage.getItem(RETIRED_LOCAL_SESSION_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Marca la sesión del usuario especificado como retirada.
 * IMPORTANTE: Nunca invoca signOut(), preservando la sesión local para evitar
 * que un clic accidental genere otra cuenta anónima huérfana en el dominio viejo.
 */
export function markLocalSessionRetired(userId?: string | null): void {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const storage = typeof localStorage !== 'undefined' ? localStorage : win?.localStorage;
  if (!storage) return;
  try {
    if (userId) {
      storage.setItem(
        `${RETIRED_LOCAL_SESSION_PREFIX}${userId}`,
        JSON.stringify({ retired_at: new Date().toISOString() })
      );
    } else {
      storage.setItem(RETIRED_LOCAL_SESSION_KEY, 'true');
    }
  } catch {
    /* fail-open */
  }
}

let globalHandshakeSequence = 0;

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
   * Ante errores de red o RPC, reporta estado 'error_recoverable' con reintento,
   * NUNCA 'empty_clean'.
   */
  async detectInventory(): Promise<{
    state: BridgeSourceState;
    inventory: MigrationInventory | null;
    user: any;
    error?: string;
  }> {
    const localTokens = collectAllLocalInvitationTokens();

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

    // Caso 2: Sesión ya retirada localmente para este usuario
    if (user && isLocalSessionRetired(user.id)) {
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
      if (error) {
        return {
          state: 'error_recoverable',
          error: error.message || 'network_error',
          inventory: null,
          user,
        };
      }

      if (!data || typeof data !== 'object') {
        return {
          state: 'error_recoverable',
          error: 'invalid_rpc_response',
          inventory: null,
          user,
        };
      }

      const res = data as any;
      if (res.ok === false) {
        return {
          state: 'error_recoverable',
          error: res.error || 'get_upgrade_state_failed',
          inventory: null,
          user,
        };
      }

      if (res.already_migrated) {
        markLocalSessionRetired(user.id);
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
            lastMigratedAt: res.last_migrated_at,
          },
          user,
        };
      }

      const hasTransferable = Boolean(
        res.has_transferable_resources || localTokens.length > 0
      );

      return {
        state: hasTransferable ? 'ready_to_migrate' : 'empty_clean',
        inventory: {
          isAnonymous: true,
          hasOwnedEncounters: Boolean(res.has_owned_encounters),
          hasParticipantLinks: Boolean(res.has_participant_links || localTokens.length > 0),
          localTokensCount: localTokens.length,
          hasServerZones: Boolean(res.has_server_zones),
          hasMessages: Boolean(res.has_messages),
          hasWhatsappContacts: Boolean(res.has_whatsapp_contacts),
          hasCustomTemplates: Boolean(res.has_custom_templates),
          hasTransferableResources: hasTransferable,
          alreadyMigrated: false,
        },
        user,
      };
    } catch (err: any) {
      return {
        state: 'error_recoverable',
        error: err?.message || 'network_error',
        inventory: null,
        user,
      };
    }
  },

  /**
   * Prepara y sincroniza los recursos locales antes de emitir cualquier ticket.
   * Valida estrictamente { data, error } y data.ok === true de cada RPC.
   * Si la sincronización o vinculación falla, detiene el flujo y NUNCA emite llaves.
   * Conserva los datos locales intactos hasta la confirmación de la transferencia.
   */
  async prepareSourceResources(): Promise<PrepareResourcesResult> {
    const localTokens = collectAllLocalInvitationTokens();

    let {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.user && localTokens.length > 0) {
      try {
        const hostSession = await ensureHostSession();
        session = { user: hostSession.user } as any;
      } catch (err: any) {
        return {
          ok: false,
          error: err?.message || 'ensure_session_failed',
          linkedCount: 0,
          alreadyLinkedCount: 0,
          skippedCount: 0,
          totalTokens: localTokens.length,
          hasUnrecoveredTokens: false,
          isComplete: false,
        };
      }
    }

    if (!session?.user) {
      if (localTokens.length > 0) {
        return {
          ok: false,
          error: 'authentication_required',
          linkedCount: 0,
          alreadyLinkedCount: 0,
          skippedCount: 0,
          totalTokens: localTokens.length,
          hasUnrecoveredTokens: false,
          isComplete: false,
        };
      }
      return {
        ok: true,
        totalTokens: 0,
        linkedCount: 0,
        alreadyLinkedCount: 0,
        skippedCount: 0,
        hasUnrecoveredTokens: false,
        isComplete: true,
      };
    }

    // 1. Sincronizar zonas locales si existen en localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const rawZones = localStorage.getItem(USER_ZONES_KEY);
        if (rawZones) {
          const parsedZones = JSON.parse(rawZones);
          if (Array.isArray(parsedZones) && parsedZones.length > 0) {
            const { data: zoneData, error: zoneError } = await supabase.rpc(
              'set_user_localidades_seguro',
              {
                p_locality_ids: parsedZones,
                p_user_id: session.user.id,
              }
            );

            if (zoneError) {
              return {
                ok: false,
                error: zoneError.message || 'set_localities_error',
                linkedCount: 0,
                alreadyLinkedCount: 0,
                skippedCount: 0,
                totalTokens: localTokens.length,
                hasUnrecoveredTokens: false,
                isComplete: false,
              };
            }
            if (!zoneData || typeof zoneData !== 'object' || (zoneData as any).ok !== true) {
              const err = (zoneData as any)?.error || 'set_localities_failed';
              if (err === 'anonymous_session_already_migrated') {
                markLocalSessionRetired(session.user.id);
              }
              return {
                ok: false,
                error: err,
                linkedCount: 0,
                alreadyLinkedCount: 0,
                skippedCount: 0,
                totalTokens: localTokens.length,
                hasUnrecoveredTokens: false,
                isComplete: false,
              };
            }
          }
        }
      } catch (err: any) {
        return {
          ok: false,
          error: err?.message || 'parse_zones_failed',
          linkedCount: 0,
          alreadyLinkedCount: 0,
          skippedCount: 0,
          totalTokens: localTokens.length,
          hasUnrecoveredTokens: false,
          isComplete: false,
        };
      }
    }

    // 2. Pre-vincular lote de tokens de invitados locales (lotes de máximo 50 tokens por SQL LIMIT 50)
    const TOKEN_BATCH_SIZE = 50;
    let totalLinked = 0;
    let totalAlreadyLinked = 0;
    let totalSkipped = 0;

    if (localTokens.length > 0) {
      try {
        for (let i = 0; i < localTokens.length; i += TOKEN_BATCH_SIZE) {
          const chunk = localTokens.slice(i, i + TOKEN_BATCH_SIZE);
          const { data: linkData, error: linkError } = await supabase.rpc(
            'vincular_tokens_participante_lote_seguro',
            {
              p_tokens: chunk,
            }
          );

          if (linkError) {
            return {
              ok: false,
              error: linkError.message || 'link_tokens_error',
              linkedCount: totalLinked,
              alreadyLinkedCount: totalAlreadyLinked,
              skippedCount: totalSkipped,
              totalTokens: localTokens.length,
              hasUnrecoveredTokens: false,
              isComplete: false,
            };
          }

          if (!linkData || typeof linkData !== 'object' || (linkData as any).ok !== true) {
            const err = (linkData as any)?.error || 'link_tokens_failed';
            if (err === 'anonymous_session_already_migrated') {
              markLocalSessionRetired(session.user.id);
            }
            return {
              ok: false,
              error: err,
              linkedCount: totalLinked,
              alreadyLinkedCount: totalAlreadyLinked,
              skippedCount: totalSkipped,
              totalTokens: localTokens.length,
              hasUnrecoveredTokens: false,
              isComplete: false,
            };
          }

          const res = linkData as any;
          totalLinked += Number(res.linked_count) || 0;
          totalAlreadyLinked += Number(res.already_linked_count) || 0;
          totalSkipped += Number(res.skipped_count) || 0;
        }
      } catch (err: any) {
        return {
          ok: false,
          error: err?.message || 'link_tokens_exception',
          linkedCount: totalLinked,
          alreadyLinkedCount: totalAlreadyLinked,
          skippedCount: totalSkipped,
          totalTokens: localTokens.length,
          hasUnrecoveredTokens: false,
          isComplete: false,
        };
      }
    }

    const hasUnrecoveredTokens = totalSkipped > 0;
    const isComplete = totalSkipped === 0;

    return {
      ok: true,
      totalTokens: localTokens.length,
      linkedCount: totalLinked,
      alreadyLinkedCount: totalAlreadyLinked,
      skippedCount: totalSkipped,
      hasUnrecoveredTokens,
      isComplete,
    };
  },

  /**
   * Inicia el flujo automático del puente (Dominio A -> Dominio B).
   * Admite ventana popup abierta sincrónicamente en el gesto de clic (iOS / Android).
   * Registra listeners inmediatamente para prevenir carreras con PE_BRIDGE_READY.
   * Valida estrictamente event.origin (protocolo, host y puerto exactos),
   * event.source, nonces y estados de sesión. NUNCA emite hacia targetOrigin = '*'.
   */
  startBridgeHandshake(options: {
    popupWindow?: Window | null;
    targetOrigin?: string;
    onStateChange: (state: BridgeSourceState) => void;
    onError: (errorCode: string, rawError?: any) => void;
    onManualFallbackReady?: (manualToken: string, expiresAt: string) => void;
    onResourcesPrepared?: (result: PrepareResourcesResult) => void;
  }): { cancel: () => Promise<CancelMigrationResult> | void } {
    let isCancelled = false;
    const currentOpId = ++globalHandshakeSequence;
    let fallbackTimeoutId: any = null;
    let windowWatchdogId: any = null;
    let messageListener: ((evt: MessageEvent) => void) | null = null;
    let transferStage: 'awaiting_ready' | 'code_sent' | 'completed' | 'cancelled' = 'awaiting_ready';
    let activeNonce: string | null = null;
    let activeTargetUserId: string | null = null;

    const rawTarget = options.targetOrigin || getTargetMigrationOrigin();
    let expectedTargetOrigin: string;
    try {
      expectedTargetOrigin = new URL(rawTarget).origin.toLowerCase();
    } catch {
      options.onError('invalid_target_origin');
      return { cancel: () => {} };
    }

    if (!isTrustedBridgeOrigin(expectedTargetOrigin)) {
      options.onError('untrusted_target_origin');
      return { cancel: () => {} };
    }

    const cleanup = () => {
      if (fallbackTimeoutId) {
        clearTimeout(fallbackTimeoutId);
        fallbackTimeoutId = null;
      }
      if (windowWatchdogId) {
        clearInterval(windowWatchdogId);
        windowWatchdogId = null;
      }
      if (messageListener && typeof window !== 'undefined') {
        window.removeEventListener('message', messageListener);
        messageListener = null;
      }
    };

    const switchToManualFallback = async () => {
      cleanup();
      transferStage = 'cancelled';
      options.onStateChange('manual_code_fallback');

      try {
        const prep = await domainMigrationBridgeService.prepareSourceResources();
        options.onResourcesPrepared?.(prep);
        if (isCancelled || currentOpId !== globalHandshakeSequence) return;
        if (!prep.ok) {
          options.onError(prep.error || 'prepare_resources_failed');
          return;
        }

        const revokeRes = await domainMigrationBridgeService.cancelPendingMigration();
        if (isCancelled || currentOpId !== globalHandshakeSequence) return;
        if (!revokeRes.ok) {
          options.onError(revokeRes.error || 'revoke_failed');
          return;
        }

        const { data, error } = await supabase.rpc(
          'create_domain_migration_ticket_seguro',
          {
            p_flow_mode: 'cross_origin_manual',
            p_intended_target_user_id: null,
          }
        );

        if (isCancelled || currentOpId !== globalHandshakeSequence) {
          try {
            await domainMigrationBridgeService.cancelPendingMigration();
          } catch {}
          return;
        }

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
        if (isCancelled || currentOpId !== globalHandshakeSequence) return;
        options.onError(err?.message || 'manual_ticket_failed');
      }
    };

    options.onStateChange('awaiting_handshake');

    // Iniciar pre-sincronización de recursos en paralelo y notificar al suscriptor
    const prepPromise = domainMigrationBridgeService.prepareSourceResources().then((res) => {
      options.onResourcesPrepared?.(res);
      return res;
    });

    // Resolver popup window (sincrónicamente provista o fallback si no está presente)
    let popupWindow: Window | null = options.popupWindow || null;
    if (!popupWindow && typeof window !== 'undefined') {
      const sourceOrigin = window.location?.origin || '';
      const targetUrl = `${expectedTargetOrigin}/migrate-receive?mode=popup${sourceOrigin ? `&source_origin=${encodeURIComponent(sourceOrigin)}` : ''}`;
      try {
        popupWindow = window.open(targetUrl, 'puntoencuentro_bridge_popup');
      } catch {
        popupWindow = null;
      }
    }

    if (!popupWindow) {
      if (domainMigrationBridgeService.isManualFallbackEnabled()) {
        void switchToManualFallback();
      } else {
        cleanup();
        options.onError('popup_blocked');
      }
      return {
        cancel: () => {
          isCancelled = true;
          cleanup();
        },
      };
    }

    // Vigilar si el usuario cierra el popup antes de completar
    windowWatchdogId = setInterval(() => {
      if (isCancelled) return;
      if (popupWindow && popupWindow.closed && transferStage !== 'completed') {
        cleanup();
        options.onError('popup_closed');
      }
    }, 500);

    // Watchdog de handshake (3.500 ms)
    fallbackTimeoutId = setTimeout(() => {
      if (isCancelled || transferStage !== 'awaiting_ready') return;
      if (domainMigrationBridgeService.isManualFallbackEnabled()) {
        void switchToManualFallback();
      } else {
        cleanup();
        options.onError('timeout');
      }
    }, 3500);

    // Listener postMessage seguro — registrado INMEDIATAMENTE
    messageListener = async (event: MessageEvent) => {
      if (isCancelled || transferStage === 'completed') return;

      // 1. Validar origen estricto contra allowlist autorizada
      if (!isTrustedBridgeOrigin(event.origin)) {
        return;
      }

      // 2. Validar que el origen del evento coincida exactamente con el destino configurado
      if (event.origin.toLowerCase() !== expectedTargetOrigin) {
        return;
      }

      // 3. Validar que la ventana emisora sea exactamente el popup creado
      if (popupWindow && event.source !== popupWindow) {
        return;
      }

      const data = event.data;
      if (!data || typeof data !== 'object') return;

      // --- HANDSHAKE: PE_BRIDGE_READY ---
      if (data.type === 'PE_BRIDGE_READY') {
        if (transferStage !== 'awaiting_ready') {
          // Descartar mensajes READY duplicados o tardíos
          return;
        }

        if (fallbackTimeoutId) {
          clearTimeout(fallbackTimeoutId);
          fallbackTimeoutId = null;
        }

        const targetUserId = data.target_user_id;
        const bridgeNonce = data.bridge_nonce;

        if (!targetUserId || !UUID_REGEX.test(targetUserId)) {
          cleanup();
          options.onError('invalid_target_user');
          return;
        }

        if (!bridgeNonce || !NONCE_REGEX.test(bridgeNonce)) {
          cleanup();
          options.onError('invalid_bridge_nonce');
          return;
        }

        activeNonce = bridgeNonce;
        activeTargetUserId = targetUserId;

        // Esperar resolución de la sincronización antes de emitir tickets
        const prep = await prepPromise;
        if (isCancelled || currentOpId !== globalHandshakeSequence || (popupWindow && popupWindow.closed)) {
          return;
        }

        if (!prep.ok) {
          transferStage = 'cancelled';
          cleanup();
          options.onError(prep.error || 'prepare_resources_failed');
          return;
        }

        // Emitir ticket cross_origin_bridge atado al target específico
        try {
          const { data: ticketData, error: ticketError } = await supabase.rpc(
            'create_domain_migration_ticket_seguro',
            {
              p_flow_mode: 'cross_origin_bridge',
              p_intended_target_user_id: activeTargetUserId,
            }
          );

          const ticketRes = ticketData as any;

          // Verificación estricta post-await de cancelación o popup cerrado
          if (isCancelled || currentOpId !== globalHandshakeSequence || (popupWindow && popupWindow.closed)) {
            if (ticketRes?.ticket_token) {
              try {
                await domainMigrationBridgeService.cancelPendingMigration();
              } catch {}
            }
            return;
          }

          if (ticketError) {
            transferStage = 'cancelled';
            cleanup();
            options.onError(ticketError.message);
            return;
          }

          if (!ticketRes?.ok || !ticketRes.ticket_token) {
            transferStage = 'cancelled';
            cleanup();
            options.onError(ticketRes?.error || 'ticket_creation_failed');
            return;
          }

          transferStage = 'code_sent';

          // Entregar código temporal por postMessage hacia expectedTargetOrigin (NUNCA '*')
          const codeMessage: BridgeCodeMessage = {
            type: 'PE_BRIDGE_CODE',
            ticket_token: ticketRes.ticket_token,
            bridge_nonce: activeNonce || bridgeNonce,
          };

          popupWindow?.postMessage(codeMessage, expectedTargetOrigin);
        } catch (err: any) {
          if (isCancelled || currentOpId !== globalHandshakeSequence) return;
          transferStage = 'cancelled';
          cleanup();
          options.onError(err?.message || 'ticket_creation_failed');
        }
        return;
      }

      // --- CONFIRMACIÓN: PE_BRIDGE_COMPLETED ---
      if (data.type === 'PE_BRIDGE_COMPLETED') {
        // Rechazar si no había una transferencia con código entregado
        if (transferStage !== 'code_sent') {
          return;
        }

        // Rechazar si el nonce no coincide con el de la transferencia activa
        if (!data.bridge_nonce || data.bridge_nonce !== activeNonce) {
          return;
        }

        transferStage = 'completed';
        cleanup();

        // Obtener usuario emisor y marcar su sesión como retirada
        const {
          data: { session },
        } = await supabase.auth.getSession();
        markLocalSessionRetired(session?.user?.id);

        options.onStateChange('already_migrated');
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('message', messageListener);
    }

    return {
      cancel: async (): Promise<CancelMigrationResult> => {
        isCancelled = true;
        transferStage = 'cancelled';
        globalHandshakeSequence++;
        cleanup();
        const res = await domainMigrationBridgeService.cancelPendingMigration();
        if (res.ok) {
          options.onStateChange('ready_to_migrate');
        } else {
          options.onError(res.error || 'cancel_failed');
        }
        return res;
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
    prepSummary?: PrepareResourcesResult;
  }> {
    if (!domainMigrationBridgeService.isManualFallbackEnabled()) {
      return { ok: false, error: 'manual_migration_disabled' };
    }

    try {
      const prep = await domainMigrationBridgeService.prepareSourceResources();
      if (!prep.ok) {
        return { ok: false, error: prep.error || 'prepare_resources_failed', prepSummary: prep };
      }

      const revokeRes = await domainMigrationBridgeService.cancelPendingMigration();
      if (!revokeRes.ok) {
        return { ok: false, error: revokeRes.error || 'revoke_failed', prepSummary: prep };
      }

      const { data, error } = await supabase.rpc(
        'create_domain_migration_ticket_seguro',
        {
          p_flow_mode: 'cross_origin_manual',
          p_intended_target_user_id: null,
        }
      );
      if (error) return { ok: false, error: error.message, prepSummary: prep };
      const res = data as any;
      if (!res?.ok) return { ok: false, error: res?.error || 'unknown_error', prepSummary: prep };
      return {
        ok: true,
        ticket_token: res.ticket_token,
        expires_at: res.expires_at,
        prepSummary: prep,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Revoca cualquier ticket pendiente del usuario emisor en el servidor.
   * Valida estrictamente { data, error } y data.ok === true.
   * Falla de modo cerrado si la respuesta es nula, hay error de PostgREST o error funcional.
   */
  async cancelPendingMigration(): Promise<CancelMigrationResult> {
    try {
      const { data, error } = await supabase.rpc('revoke_my_pending_transfer_ticket');
      if (error) {
        return { ok: false, error: error.message || 'revoke_rpc_error' };
      }
      if (!data || typeof data !== 'object') {
        return { ok: false, error: 'invalid_rpc_response' };
      }
      const res = data as any;
      if (res.ok !== true) {
        return { ok: false, error: res.error || 'revoke_failed' };
      }
      return {
        ok: true,
        revokedCount: Number(res.revoked_count) || 0,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'cancel_exception' };
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
   * Si falla por corte de red, intenta confirmar de forma idempotente con
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
   * Determina el origen de Dominio A sin depender de document.referrer (vía parámetro seguro sourceOrigin).
   * Valida estrictamente event.origin, event.source y bridge_nonce.
   * Prohíbe en todos los casos targetOrigin = '*'.
   */
  listenForBridgeCodeOnReceive(options: {
    sourceOpener: Window;
    targetUserId: string;
    sourceOrigin?: string;
    onCodeReceived: (ticketToken: string) => void;
    onError: (errorCode: string) => void;
  }): {
    nonce: string;
    authorizedSourceOrigin: string;
    notifyCompleted: () => void;
    cleanup: () => void;
  } {
    const bridgeNonce = generateBridgeNonce();
    let isCleanedUp = false;
    let codeReceived = false;

    // Determinar origen autorizado del emisor
    let authorizedSourceOrigin: string | null = null;
    if (options.sourceOrigin && typeof options.sourceOrigin === 'string') {
      try {
        const parsed = new URL(options.sourceOrigin);
        if (isTrustedBridgeOrigin(parsed.origin)) {
          authorizedSourceOrigin = parsed.origin.toLowerCase();
        }
      } catch {}
    }

    if (!authorizedSourceOrigin && typeof document !== 'undefined' && document.referrer) {
      try {
        const refParsed = new URL(document.referrer);
        if (isTrustedBridgeOrigin(refParsed.origin)) {
          authorizedSourceOrigin = refParsed.origin.toLowerCase();
        }
      } catch {}
    }

    if (!authorizedSourceOrigin) {
      options.onError('untrusted_source_origin');
      return {
        nonce: '',
        authorizedSourceOrigin: '',
        notifyCompleted: () => {},
        cleanup: () => {},
      };
    }

    const messageListener = (event: MessageEvent) => {
      if (isCleanedUp) return;

      // 1. Validar origen confiable
      if (!isTrustedBridgeOrigin(event.origin)) {
        return;
      }

      // 2. Validar que coincida exactamente con el origen autorizado del emisor
      if (event.origin.toLowerCase() !== authorizedSourceOrigin) {
        return;
      }

      // 3. Validar que provenga de la ventana opener
      if (event.source !== options.sourceOpener) {
        return;
      }

      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'PE_BRIDGE_CODE') {
        if (codeReceived) return;

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

        codeReceived = true;
        options.onCodeReceived(token);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('message', messageListener);
    }

    // Enviar PE_BRIDGE_READY al opener estrictamente hacia authorizedSourceOrigin (NUNCA '*')
    const readyMessage: BridgeReadyMessage = {
      type: 'PE_BRIDGE_READY',
      target_user_id: options.targetUserId,
      bridge_nonce: bridgeNonce,
    };

    options.sourceOpener.postMessage(readyMessage, authorizedSourceOrigin);

    return {
      nonce: bridgeNonce,
      authorizedSourceOrigin,
      notifyCompleted: () => {
        if (isCleanedUp) return;
        try {
          const completedMessage: BridgeCompletedMessage = {
            type: 'PE_BRIDGE_COMPLETED',
            bridge_nonce: bridgeNonce,
          };
          options.sourceOpener.postMessage(completedMessage, authorizedSourceOrigin);
        } catch {
          /* fail-open */
        }
      },
      cleanup: () => {
        isCleanedUp = true;
        if (typeof window !== 'undefined') {
          window.removeEventListener('message', messageListener);
        }
      },
    };
  },
};
