import { supabase } from '@/lib/supabase';

const SESSION_STORAGE_KEY = 'pe-usage-telemetry-session-v1';
const HOME_VISIT_SESSION_KEY = 'pe-usage-home-visited-v1';
const INVITE_OPENED_PREFIX = 'pe-usage-invite-opened-v1:';

interface UsageSessionContext {
  clientToken: string;
}

export type UsageEventName = 'home_visit' | 'invitation_shared' | 'invitation_opened';
export type EncounterMode = 'fixed' | 'coordination';
export type ShareChannel = 'system_share' | 'clipboard_copy';
export type InvitationType = 'individual' | 'general' | 'coordination_individual' | 'coordination_general';

export interface TrackInvitationSharedParams {
  encounterId?: string;
  encounterMode?: EncounterMode;
  shareChannel: ShareChannel;
}

export interface TrackInvitationOpenedParams {
  encounterId?: string;
  invitationType: InvitationType;
  cacheKey: string;
}

class AppUsageTelemetryService {
  private getClientToken(): string {
    try {
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (stored) {
        const parsed: UsageSessionContext = JSON.parse(stored);
        if (parsed.clientToken && parsed.clientToken.length >= 16) {
          return parsed.clientToken;
        }
      }
    } catch {
      // ignore
    }

    // Generar 32 caracteres hexadecimales aleatorios (128 bits de entropía)
    const newContext: UsageSessionContext = {
      clientToken: Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    };

    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newContext));
    } catch {
      // ignore
    }

    return newContext.clientToken;
  }

  /**
   * Registra el ingreso a la Home, deduplicado a 1 sola vez por ciclo de sesión de navegador.
   */
  public trackHomeVisit(): void {
    try {
      if (sessionStorage.getItem(HOME_VISIT_SESSION_KEY)) {
        return; // Ya registrado en esta pestaña / sesión
      }
      sessionStorage.setItem(HOME_VISIT_SESSION_KEY, '1');
    } catch {
      // En modo privado estricto, fail-open
    }

    this.sendEvent('home_visit');
  }

  /**
   * Registra el enlace compartido mediante una acción verificable (Web Share API o Clipboard).
   * PRIVACIDAD: Nunca envía URLs privadas ni tokens de invitación.
   */
  public trackInvitationShared(params: TrackInvitationSharedParams): void {
    this.sendEvent('invitation_shared', {
      encounter_id: params.encounterId,
      encounter_mode: params.encounterMode,
      share_channel: params.shareChannel,
    });
  }

  /**
   * Registra la apertura de una invitación, deduplicada por token/encuentro en esta sesión.
   * PRIVACIDAD: Nunca envía el token ni la URL. Solo el tipo de invitación y contexto.
   */
  public trackInvitationOpened(params: TrackInvitationOpenedParams): void {
    try {
      const key = `${INVITE_OPENED_PREFIX}${params.cacheKey}`;
      if (sessionStorage.getItem(key)) {
        return; // Deduplicación: ya contabilizado en esta sesión
      }
      sessionStorage.setItem(key, '1');
    } catch {
      // fail-open
    }

    this.sendEvent('invitation_opened', {
      encounter_id: params.encounterId,
      encounter_mode: params.invitationType.startsWith('coordination') ? 'coordination' : 'fixed',
      invitation_type: params.invitationType,
    });
  }

  private sendEvent(
    eventName: UsageEventName,
    extra: {
      encounter_id?: string;
      encounter_mode?: EncounterMode;
      share_channel?: ShareChannel;
      invitation_type?: InvitationType;
    } = {}
  ): void {
    const clientToken = this.getClientToken();

    // Invocación asíncrona no bloqueante
    (async () => {
      try {
        const { error } = await supabase.rpc('registrar_evento_uso', {
          p_event_name: eventName,
          p_client_token: clientToken,
          p_encounter_id: extra.encounter_id || null,
          p_encounter_mode: extra.encounter_mode || null,
          p_share_channel: extra.share_channel || null,
          p_invitation_type: extra.invitation_type || null,
        });
        if (error && import.meta.env.DEV) {
          console.warn('[AppUsageTelemetry] registrar_evento_uso notice:', error.message);
        }
      } catch (err: unknown) {
        if (import.meta.env.DEV) {
          console.warn('[AppUsageTelemetry] Unhandled error:', err);
        }
      }
    })();
  }
}

export const appUsageTelemetry = new AppUsageTelemetryService();
