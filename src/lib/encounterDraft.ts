import type { CreateEncuentroDTO, VisibilidadRespuestas, CoordinationCreatePayload, CoordinationOptionPayload } from '@/services/encuentrosService';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { resolveInvitationTemplateForTheme } from '@/lib/invitationThemes';
import type { WizardState } from '@/store/wizardStore';
import type { CoordinationDraft } from '@/store/coordinationWizardStore';

export interface DateOption {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
}

/**
 * EncounterDraft represents the validated business data of an encounter.
 * Decoupled from visual themes, host session metadata, or UI wizard step indicators.
 */
export interface EncounterDraft {
  // Qué
  title: string | null;
  description: string | null;

  // Cuándo
  dateMode: 'fixed' | 'coordination' | null;

  // Fixed mode fields
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:MM

  // Multi-turn temporal metadata:
  baseDate?: string | null; // Semantic anchor date before day-rollover (e.g. 'hoy' = 2026-09-09)
  appliedDayRollover?: boolean; // True if date was bumped +1 day due to 24:00 (or midnight rollover)
  pendingDayRollover?: boolean; // Indicates a +1 day rollover is pending when date arrives
  pendingTimeOptions?: string[] | null; // Multi-hour alternatives pending common date (e.g. ['10:00', '11:00'])

  // Coordination mode fields (retained for architectural compatibility with Stage 1.0 Entrega B)
  dateOptions: DateOption[] | null;
  responseDeadline: string | null;
  durationMinutes: number | null;
  coordinationCandidate?: boolean;
  coordinationPendingConfirm?: boolean;

  // Dónde / Cómo
  modality: 'presencial' | 'virtual' | null;
  locationText: string | null;
  virtualLink: string | null;
}

/**
 * InvitationConfig governs the visual theme, invitation mechanics and guest visibility.
 */
export interface InvitationConfig {
  invitationType: 'individual' | 'link_general';
  invitationTheme: InvitationTheme;
  invitationTemplate: string | null;
  responseVisibility: VisibilidadRespuestas; // 'hidden' | 'summary' | 'detail'
}

/**
 * CreationMetadata contains session/host contextual information injected at creation time.
 */
export interface CreationMetadata {
  hostId: string;
  replacesEncounterId: string | null;
  postEventActiveMinutes: number;
}

/**
 * Creates a clean, empty EncounterDraft with no silent defaults.
 */
export function createEmptyEncounterDraft(): EncounterDraft {
  return {
    title: null,
    description: null,
    dateMode: 'fixed',
    date: null,
    time: null,
    baseDate: null,
    appliedDayRollover: false,
    pendingDayRollover: false,
    pendingTimeOptions: null,
    dateOptions: null,
    responseDeadline: null,
    durationMinutes: null,
    modality: null,
    locationText: null,
    virtualLink: null,
  };
}

/**
 * Creates standard default invitation configuration.
 */
export function createDefaultInvitationConfig(): InvitationConfig {
  return {
    invitationType: 'link_general',
    invitationTheme: 'classic',
    invitationTemplate: null,
    responseVisibility: 'hidden',
  };
}

/**
 * Determines whether the user has provided or confirmed meaningful encounter data
 * that should be protected from accidental exit/discard.
 *
 * Excludes purely technical defaults, empty strings, and initial session boilerplate.
 */
export function hasMeaningfulDraftData(
  draft?: EncounterDraft | null,
  config?: InvitationConfig | null
): boolean {
  if (draft) {
    if (typeof draft.title === 'string' && draft.title.trim().length > 0) return true;
    if (typeof draft.description === 'string' && draft.description.trim().length > 0) return true;
    if (typeof draft.date === 'string' && draft.date.trim().length > 0) return true;
    if (typeof draft.time === 'string' && draft.time.trim().length > 0) return true;
    if (draft.modality === 'presencial' || draft.modality === 'virtual') return true;
    if (typeof draft.locationText === 'string' && draft.locationText.trim().length > 0) return true;
    if (typeof draft.virtualLink === 'string' && draft.virtualLink.trim().length > 0) return true;
    if (Array.isArray(draft.dateOptions) && draft.dateOptions.length > 0) return true;
    if (Array.isArray(draft.pendingTimeOptions) && draft.pendingTimeOptions.length > 0) return true;
    if (typeof draft.responseDeadline === 'string' && draft.responseDeadline.trim().length > 0) return true;
    if (typeof draft.durationMinutes === 'number' && draft.durationMinutes > 0) return true;
    if (typeof draft.baseDate === 'string' && draft.baseDate.trim().length > 0) return true;
  }
  if (config) {
    if (config.invitationTheme && config.invitationTheme !== 'classic') return true;
    if (config.invitationTemplate !== null && config.invitationTemplate !== undefined) return true;
    if (config.invitationType && config.invitationType !== 'link_general') return true;
    if (config.responseVisibility && config.responseVisibility !== 'hidden') return true;
  }
  return false;
}


/**
 * Ajuste 4: Mapping between modern responseVisibility and legacy database/RPC fields.
 *
 * Relationship:
 * - `visibilidad_respuestas_invitados` = responseVisibility ('hidden' | 'summary' | 'detail')
 * - `mostrar_respuestas_a_invitados` = (responseVisibility !== 'hidden')
 */
export function mapResponseVisibilityToLegacyFields(visibility: VisibilidadRespuestas): {
  visibilidad_respuestas_invitados: VisibilidadRespuestas;
  mostrar_respuestas_a_invitados: boolean;
} {
  return {
    visibilidad_respuestas_invitados: visibility,
    mostrar_respuestas_a_invitados: visibility !== 'hidden',
  };
}

/**
 * Translates an EncounterDraft + InvitationConfig + CreationMetadata into the canonical CreateEncuentroDTO.
 * Validates that all required fields for fixed-date creation are present.
 */
export function translateToCreateEncuentroDTO(
  draft: EncounterDraft,
  config: InvitationConfig,
  meta: CreationMetadata
): CreateEncuentroDTO {
  if (!draft.title || !draft.title.trim()) {
    throw new Error('El título del encuentro es obligatorio');
  }
  if (!draft.date) {
    throw new Error('La fecha del encuentro es obligatoria');
  }
  if (!draft.time) {
    throw new Error('La hora del encuentro es obligatoria');
  }
  if (!draft.modality) {
    throw new Error('La modalidad (presencial o virtual) es obligatoria');
  }
  if (draft.modality === 'presencial' && (!draft.locationText || !draft.locationText.trim())) {
    throw new Error('El lugar del encuentro es obligatorio para encuentros presenciales');
  }
  if (draft.modality === 'virtual' && (!draft.virtualLink || !draft.virtualLink.trim())) {
    throw new Error('El enlace de la videollamada es obligatorio para encuentros virtuales');
  }
  if (!meta.hostId) {
    throw new Error('El identificador del organizador (hostId) es obligatorio');
  }

  const resolvedTemplate = resolveInvitationTemplateForTheme(
    config.invitationTheme,
    config.invitationTemplate
  );

  return {
    titulo: draft.title.trim(),
    descripcion: draft.description ? draft.description.trim() : undefined,
    fecha: draft.date,
    hora: draft.time,
    modalidad: draft.modality,
    lugar_texto: draft.modality === 'presencial' && draft.locationText ? draft.locationText.trim() : undefined,
    link_virtual: draft.modality === 'virtual' && draft.virtualLink ? draft.virtualLink.trim() : undefined,
    tipo_invitacion: config.invitationType,
    host_id: meta.hostId,
    tema: 'blue',
    tema_invitacion: config.invitationTheme,
    invitation_template: resolvedTemplate,
    reemplaza_a: meta.replacesEncounterId,
    post_event_active_minutes: meta.postEventActiveMinutes,
  };
}

/**
 * Translates the current AI draft into the state expected by the manual 4-step wizard.
 * Allows seamless fallback to manual creation without data loss.
 */
export function draftToWizardState(
  draft: EncounterDraft,
  config: InvitationConfig
): Partial<WizardState> {
  const resolvedTemplate = resolveInvitationTemplateForTheme(
    config.invitationTheme,
    config.invitationTemplate
  );

  return {
    titulo: draft.title || '',
    fecha: draft.date || '',
    hora: draft.time || '',
    descripcion: draft.description || '',
    modalidad: draft.modality,
    lugar_texto: draft.locationText || '',
    link_virtual: draft.virtualLink || '',
    tipo_invitacion: config.invitationType,
    tema: 'blue',
    tema_invitacion: config.invitationTheme,
    invitation_template: resolvedTemplate,
  };
}

/**
 * Translates compatible AI draft fields into the date coordination wizard draft.
 * Used when the AI detects coordination intent and handoffs to /create/coordination.
 */
export function draftToCoordinationDraft(
  draft: EncounterDraft,
  config: InvitationConfig
): Partial<CoordinationDraft> {
  const resolvedTemplate = resolveInvitationTemplateForTheme(
    config.invitationTheme,
    config.invitationTemplate
  ) || '';

  const visibilityMapping = mapResponseVisibilityToLegacyFields(config.responseVisibility);

  return {
    dateMode: 'coordination',
    title: draft.title || '',
    description: draft.description || '',
    modality: draft.modality || 'presencial',
    locationText: draft.locationText || '',
    virtualLink: draft.virtualLink || '',
    options: (draft.dateOptions || []).map((opt, idx) => ({
      localId: `opt-${Date.now()}-${idx}`,
      date: opt.date,
      time: opt.time,
    })),
    responseDeadline: draft.responseDeadline || null,
    durationMinutes: draft.durationMinutes || null,
    invitationType: config.invitationType,
    invitationTheme: config.invitationTheme,
    invitationTemplate: resolvedTemplate,
    mostrarRespuestasAInvitados: visibilityMapping.mostrar_respuestas_a_invitados,
    visibilidadRespuestas: visibilityMapping.visibilidad_respuestas_invitados,
  };
}

/**
 * Translates an EncounterDraft + InvitationConfig + CreationMetadata into the canonical
 * payload and options expected by `encuentrosService.crearEncuentroConOpciones` (RPC `crear_encuentro_con_opciones_seguro`).
 */
export function translateToCoordinationPayload(
  draft: EncounterDraft,
  config: InvitationConfig,
  meta?: CreationMetadata
): {
  payload: CoordinationCreatePayload;
  opciones: CoordinationOptionPayload[];
} {
  if (!draft.title || !draft.title.trim()) {
    throw new Error('El título del encuentro es obligatorio');
  }
  if (!draft.dateOptions || draft.dateOptions.length < 2) {
    throw new Error('El encuentro de coordinación requiere al menos dos opciones de fecha');
  }
  if (draft.dateOptions.length > 3) {
    throw new Error('El encuentro de coordinación permite como máximo tres opciones de fecha');
  }
  if (!draft.modality) {
    throw new Error('La modalidad (presencial o virtual) es obligatoria');
  }
  if (draft.modality === 'presencial' && (!draft.locationText || !draft.locationText.trim())) {
    throw new Error('El lugar del encuentro es obligatorio para encuentros presenciales');
  }
  if (draft.modality === 'virtual' && (!draft.virtualLink || !draft.virtualLink.trim())) {
    throw new Error('El enlace de la videollamada es obligatorio para encuentros virtuales');
  }

  const resolvedTemplate = resolveInvitationTemplateForTheme(
    config.invitationTheme,
    config.invitationTemplate
  );

  const visibilityMapping = mapResponseVisibilityToLegacyFields(config.responseVisibility);

  // Deduplicate and sort options chronologically
  const uniqueMap = new Map<string, DateOption>();
  for (const opt of draft.dateOptions) {
    const key = `${opt.date}_${opt.time}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, opt);
    }
  }

  const sortedOptions = Array.from(uniqueMap.values()).sort((a, b) =>
    `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
  );

  const opciones: CoordinationOptionPayload[] = sortedOptions.map((opt) => ({
    fecha: opt.date,
    hora_inicio: opt.time,
  }));

  const payload: CoordinationCreatePayload = {
    titulo: draft.title.trim(),
    descripcion: draft.description ? draft.description.trim() : undefined,
    modalidad: draft.modality,
    lugar_texto:
      draft.modality === 'presencial' && draft.locationText ? draft.locationText.trim() : undefined,
    link_virtual:
      draft.modality === 'virtual' && draft.virtualLink ? draft.virtualLink.trim() : undefined,
    tipo_invitacion: config.invitationType,
    tema: 'blue',
    tema_invitacion: config.invitationTheme,
    invitation_template: resolvedTemplate || undefined,
    response_deadline: draft.responseDeadline || null,
    duration_minutes: draft.durationMinutes || null,
    mostrar_respuestas_a_invitados: visibilityMapping.mostrar_respuestas_a_invitados,
    visibilidad_respuestas_invitados: visibilityMapping.visibilidad_respuestas_invitados,
    post_event_active_minutes: meta?.postEventActiveMinutes ?? 45,
  };

  return { payload, opciones };
}
