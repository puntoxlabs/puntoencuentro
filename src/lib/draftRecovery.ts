import type { WizardState } from '@/store/wizardStore';
import type { CoordinationDraft } from '@/store/coordinationWizardStore';
import { hasMeaningfulDraftData } from '@/lib/encounterDraft';
import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';

export const AI_DRAFT_SNAPSHOT_KEY = 'pe_ai_draft_snapshot';
export const AI_DRAFT_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

export interface AiDraftSnapshot {
  draft: EncounterDraft;
  config: InvitationConfig;
  savedAt: number;
}

/**
 * Determina si el estado del wizard manual contiene un borrador recuperable no publicado.
 * Si encuentro_id ya existe, el encuentro fue creado previamente y no califica como borrador.
 */
export function hasRecoverableManualDraft(state: Partial<WizardState> | null | undefined): boolean {
  if (!state) return false;
  if (state.encuentro_id) return false;

  return Boolean(
    state.titulo?.trim() ||
    state.descripcion?.trim() ||
    state.fecha?.trim() ||
    state.lugar_texto?.trim() ||
    state.link_virtual?.trim()
  );
}

/**
 * Determina si el borrador de coordinación de fechas tiene datos significativos.
 */
export function hasRecoverableCoordinationDraft(draft: Partial<CoordinationDraft> | null | undefined): boolean {
  if (!draft) return false;

  return Boolean(
    draft.title?.trim() ||
    draft.description?.trim() ||
    draft.locationText?.trim() ||
    draft.virtualLink?.trim() ||
    (Array.isArray(draft.options) && draft.options.length > 0)
  );
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {}
  return null;
}

/**
 * Sanitiza el borrador para el snapshot persistido.
 * Extrae únicamente campos de negocio validados, omitiendo identificadores de sesión,
 * mensajes conversacionales, tokens de autenticación o metadatos internos no serializables.
 */
export function sanitizeDraftForSnapshot(draft: Partial<EncounterDraft>): EncounterDraft {
  return {
    title: typeof draft.title === 'string' && draft.title.trim() ? draft.title.trim() : null,
    description: typeof draft.description === 'string' && draft.description.trim() ? draft.description.trim() : null,
    dateMode: draft.dateMode === 'coordination' ? 'coordination' : 'fixed',
    date: typeof draft.date === 'string' ? draft.date : null,
    time: typeof draft.time === 'string' ? draft.time : null,
    dateOptions: Array.isArray(draft.dateOptions)
      ? draft.dateOptions
          .filter((opt) => opt && typeof opt.date === 'string' && typeof opt.time === 'string')
          .map((opt) => ({ date: opt.date, time: opt.time }))
      : null,
    responseDeadline: typeof draft.responseDeadline === 'string' ? draft.responseDeadline : null,
    durationMinutes: typeof draft.durationMinutes === 'number' && Number.isFinite(draft.durationMinutes) ? draft.durationMinutes : null,
    modality: draft.modality === 'presencial' || draft.modality === 'virtual' ? draft.modality : null,
    locationText: typeof draft.locationText === 'string' && draft.locationText.trim() ? draft.locationText.trim() : null,
    virtualLink: typeof draft.virtualLink === 'string' && draft.virtualLink.trim() ? draft.virtualLink.trim() : null,
    coordinationCandidate: Boolean(draft.coordinationCandidate),
    coordinationPendingConfirm: Boolean(draft.coordinationPendingConfirm),
  };
}

/**
 * Sanitiza la configuración de invitación para el snapshot.
 */
export function sanitizeConfigForSnapshot(config?: Partial<InvitationConfig> | null): InvitationConfig {
  return {
    invitationType: config?.invitationType === 'individual' ? 'individual' : 'link_general',
    invitationTheme: (config?.invitationTheme as any) || 'classic',
    invitationTemplate: typeof config?.invitationTemplate === 'string' ? config.invitationTemplate : null,
    responseVisibility:
      config?.responseVisibility === 'detail' || config?.responseVisibility === 'summary'
        ? config.responseVisibility
        : 'hidden',
  };
}

/**
 * Guarda un snapshot mínimo y validado del borrador de IA en localStorage.
 * No persiste sesiones, tokens, credenciales, mensajes ni contadores anti-abuso.
 */
export function saveAiDraftSnapshot(
  draft: EncounterDraft | null | undefined,
  config: InvitationConfig | null | undefined
): void {
  const storage = getLocalStorage();
  if (!storage) return;

  if (!draft || !config || !hasMeaningfulDraftData(draft, config)) {
    clearAiDraftSnapshot();
    return;
  }

  try {
    const cleanDraft = sanitizeDraftForSnapshot(draft);
    const cleanConfig = sanitizeConfigForSnapshot(config);

    if (!hasMeaningfulDraftData(cleanDraft, cleanConfig)) {
      clearAiDraftSnapshot();
      return;
    }

    const snapshot: AiDraftSnapshot = {
      draft: cleanDraft,
      config: cleanConfig,
      savedAt: Date.now(),
    };
    storage.setItem(AI_DRAFT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('[draftRecovery] Error al guardar snapshot de IA:', err);
  }
}

/**
 * Recupera el snapshot del borrador de IA desde localStorage si existe y es válido.
 * Valida minuciosamente integridad, TTL, ausencia de fechas futuras inválidas y estructura.
 */
export function getAiDraftSnapshot(): AiDraftSnapshot | null {
  const storage = getLocalStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(AI_DRAFT_SNAPSHOT_KEY);
    if (!raw) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      clearAiDraftSnapshot();
      return null;
    }

    // 1. Estructura raíz
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      clearAiDraftSnapshot();
      return null;
    }

    // 2. Validar que savedAt exista y sea un número finito
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) {
      clearAiDraftSnapshot();
      return null;
    }

    const now = Date.now();

    // 3. TTL: expirado (> 7 días) o irrazonablemente antiguo (< 2025-01-01)
    if (now - parsed.savedAt > AI_DRAFT_SNAPSHOT_MAX_AGE_MS || parsed.savedAt < 1735689600000) {
      clearAiDraftSnapshot();
      return null;
    }

    // 4. Fechas futuras inválidas con tolerancia de clock skew (60 segundos)
    if (parsed.savedAt > now + 60_000) {
      clearAiDraftSnapshot();
      return null;
    }

    // 5. Validar presencia y formato de draft y config
    if (!parsed.draft || typeof parsed.draft !== 'object' || Array.isArray(parsed.draft)) {
      clearAiDraftSnapshot();
      return null;
    }

    if (!parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
      clearAiDraftSnapshot();
      return null;
    }

    // 6. Sanitizar y verificar datos significativos
    const cleanDraft = sanitizeDraftForSnapshot(parsed.draft);
    const cleanConfig = sanitizeConfigForSnapshot(parsed.config);

    if (!hasMeaningfulDraftData(cleanDraft, cleanConfig)) {
      clearAiDraftSnapshot();
      return null;
    }

    return {
      draft: cleanDraft,
      config: cleanConfig,
      savedAt: parsed.savedAt,
    };
  } catch (err) {
    console.warn('[draftRecovery] Error al leer snapshot de IA:', err);
    clearAiDraftSnapshot();
    return null;
  }
}

/**
 * Elimina el snapshot del borrador de IA de localStorage.
 */
export function clearAiDraftSnapshot(): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(AI_DRAFT_SNAPSHOT_KEY);
  } catch {}
}

/**
 * Determina si el borrador de creación con IA tiene datos recuperables,
 * considerando tanto el estado activo en sessionStorage como el snapshot persistido en localStorage.
 */
export function hasRecoverableAiDraft(
  draft: EncounterDraft | null | undefined,
  config?: InvitationConfig | null
): boolean {
  if (draft && hasMeaningfulDraftData(draft, config ?? undefined)) {
    return true;
  }
  const snapshot = getAiDraftSnapshot();
  return Boolean(snapshot && hasMeaningfulDraftData(snapshot.draft, snapshot.config));
}
