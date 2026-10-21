import { DATE_COORDINATION_ENABLED } from '@/config/features';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { useWizardStore } from '@/store/wizardStore';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import { useRepeatEncounterStore } from '@/store/repeatEncounterStore';
import type {
  EncounterTemplateConfig,
  ResponseVisibility,
  ReusablePayload,
} from '@/types/encounterTemplates';
import type { SendInternalInvitationResponse } from '@/types/internalInvitations';

export const MAX_FAVORITE_NAME_LENGTH = 80;

export function defaultFavoriteName(title: string | null | undefined): string {
  return (title ?? '').trim().slice(0, MAX_FAVORITE_NAME_LENGTH);
}

export function newRepeatToken(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `rt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Una plantilla de coordinación solo puede aplicarse si la coordinación está habilitada. */
export function canApplyPayload(payload: ReusablePayload): boolean {
  return payload.date_mode !== 'coordination' || DATE_COORDINATION_ENABLED;
}

/** ¿Hay un borrador propio en curso que la repetición reemplazaría? */
export function hasDraftInProgress(): boolean {
  const w = useWizardStore.getState();
  const c = useCoordinationWizardStore.getState().draft;
  return Boolean((w.titulo && w.titulo.trim()) || (c.title && c.title.trim()));
}

const VISIBILITIES: ResponseVisibility[] = ['hidden', 'summary', 'detail'];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function validTime(v: unknown): string {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : '';
}

function validTipo(v: unknown): 'individual' | 'link_general' | null {
  return v === 'individual' || v === 'link_general' ? v : null;
}

/**
 * Extrae el único dato sensible que requiere confirmación explícita: el enlace de reunión virtual.
 */
function linkCandidateOf(config: EncounterTemplateConfig): string | null {
  if (config.modalidad !== 'virtual') return null;
  const link = str(config.link_virtual).trim();
  return link || null;
}

/**
 * Precarga el wizard correspondiente con la configuración reutilizable.
 *
 * Reglas (todas verificadas por tests):
 *  - Siempre un encuentro NUEVO: se limpia `encuentro_id`, `sourceIntentionId` y la referencia
 *    `cancel_reference` (no se hereda "reemplaza_a").
 *  - La fecha concreta, opciones de coordinación y plazos NO se copian; el organizador debe
 *    elegir fechas nuevas (validadas como futuras por el wizard y por las RPCs de creación).
 *  - El enlace de videollamada NO se completa automáticamente: queda como candidato en memoria
 *    que el organizador debe aceptar con un clic.
 *  - No se envían invitaciones: los correos quedan pendientes de confirmación expresa.
 *  - El encuentro nace privado: ninguna configuración de "abierto" se copia.
 *
 * @returns ruta y state para `navigate`.
 */
export function applyReusablePayload(
  payload: ReusablePayload,
  opts: { ownerUserId: string | null; includeGuests: boolean }
): { route: string; navState: Record<string, unknown>; token: string } {
  const token = newRepeatToken();
  const config = payload.config;
  const guests = opts.includeGuests && opts.ownerUserId ? payload.invitados : [];

  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem('cancel_reference');
  }

  useRepeatEncounterStore.getState().start({
    ownerUserId: opts.ownerUserId,
    sessionToken: token,
    guestEmails: guests,
    linkCandidate: linkCandidateOf(config),
  });

  const modalidad = config.modalidad === 'virtual' ? 'virtual' : 'presencial';

  if (payload.date_mode === 'coordination') {
    const store = useCoordinationWizardStore.getState();
    store.resetDraft();
    store.updateDraft({
      dateMode: 'coordination',
      title: str(config.titulo),
      description: str(config.descripcion),
      modality: modalidad,
      locationText: modalidad === 'presencial' ? str(config.lugar_texto) : '',
      virtualLink: '',
      options: [],
      responseDeadline: null,
      durationMinutes:
        typeof config.duration_minutes === 'number' ? config.duration_minutes : null,
      invitationType: validTipo(config.tipo_invitacion) ?? 'link_general',
      invitationTheme: ((str(config.tema_invitacion) || 'classic') as InvitationTheme),
      invitationTemplate: str(config.invitation_template),
      personalMessage: '',
      hostAlias: '',
      mostrarRespuestasAInvitados: Boolean(config.mostrar_respuestas_a_invitados),
      visibilidadRespuestas: VISIBILITIES.includes(
        config.visibilidad_respuestas_invitados as ResponseVisibility
      )
        ? (config.visibilidad_respuestas_invitados as ResponseVisibility)
        : 'hidden',
      repeatToken: token,
    });
    return { route: '/create/coordination', navState: { seeded: true, fromReuse: true }, token };
  }

  const wizard = useWizardStore.getState();
  wizard.reset();
  const set = wizard.setField;
  set('titulo', str(config.titulo));
  set('descripcion', str(config.descripcion));
  set('fecha', '');
  set('hora', validTime(config.hora));
  set('modalidad', modalidad);
  set('lugar_texto', modalidad === 'presencial' ? str(config.lugar_texto) : '');
  set('link_virtual', '');
  set('tipo_invitacion', validTipo(config.tipo_invitacion));
  set('tema', str(config.tema) || 'blue');
  set('tema_invitacion', (str(config.tema_invitacion) || 'classic') as InvitationTheme);
  set('invitation_template', str(config.invitation_template) || null);
  set('encuentro_id', null);
  set('sourceIntentionId', null);
  set('creation_source', 'manual');
  set('repeat_token', token);
  set('step', 1);
  return { route: '/create', navState: { autoFocusTitle: false, fromReuse: true, seeded: true }, token };
}

export interface PendingInvitationsResult {
  sent: string[];
  alreadyInvited: string[];
  failed: { email: string; error: string }[];
  stoppedEarly: boolean;
  remaining: string[];
}

type Sender = (encuentroId: string, email: string) => Promise<SendInternalInvitationResponse>;

/**
 * Envía las invitaciones confirmadas por el organizador reutilizando la RPC existente
 * `enviar_invitacion_interna_seguro` (con todas sus validaciones: propiedad, anónimos,
 * bloqueos, duplicados, cupo y rate limit). Secuencial; se detiene ante límites de tasa
 * o pérdida de sesión, preservando todos los correos aún no enviados en `remaining` y
 * notificando cada correo procesado (`onProcessed`) de inmediato para evitar duplicados
 * en reintentos.
 */
export async function sendConfirmedInvitations(
  encuentroId: string,
  emails: string[],
  send: Sender,
  onProcessed?: (email: string) => void
): Promise<PendingInvitationsResult> {
  const normalized = Array.from(
    new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))
  );
  const result: PendingInvitationsResult = {
    sent: [],
    alreadyInvited: [],
    failed: [],
    stoppedEarly: false,
    remaining: [],
  };
  const fatal = new Set([
    'rate_limit_exceeded',
    'not_authenticated',
    'anonymous_user_not_allowed',
    'no_spots_available',
    'encuentro_not_active',
    'encuentro_passed',
    'encuentro_not_found_or_not_owner',
  ]);

  for (let i = 0; i < normalized.length; i++) {
    const email = normalized[i];
    let res: SendInternalInvitationResponse;
    try {
      res = await send(encuentroId, email);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : 'unknown_error' };
    }
    if (res.ok) {
      result.sent.push(email);
      onProcessed?.(email);
      continue;
    }
    const code = res.error ?? 'unknown_error';
    if (code === 'invitation_already_pending' || code === 'user_already_participant') {
      result.alreadyInvited.push(email);
      onProcessed?.(email);
      continue;
    }
    result.failed.push({ email, error: code });
    if (fatal.has(code)) {
      result.stoppedEarly = true;
      result.remaining = [
        ...result.failed.map((f) => f.email),
        ...normalized.slice(i + 1),
      ];
      return result;
    }
  }
  result.remaining = result.failed.map((f) => f.email);
  return result;
}

