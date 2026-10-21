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
    const snapshot: AiDraftSnapshot = {
      draft,
      config,
      savedAt: Date.now(),
    };
    storage.setItem(AI_DRAFT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('[draftRecovery] Error al guardar snapshot de IA:', err);
  }
}

/**
 * Recupera el snapshot del borrador de IA desde localStorage si existe y no expiró.
 */
export function getAiDraftSnapshot(): AiDraftSnapshot | null {
  const storage = getLocalStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(AI_DRAFT_SNAPSHOT_KEY);
    if (!raw) return null;

    const parsed: AiDraftSnapshot = JSON.parse(raw);
    if (!parsed || !parsed.draft || !parsed.config) {
      clearAiDraftSnapshot();
      return null;
    }

    if (parsed.savedAt && Date.now() - parsed.savedAt > AI_DRAFT_SNAPSHOT_MAX_AGE_MS) {
      clearAiDraftSnapshot();
      return null;
    }

    if (!hasMeaningfulDraftData(parsed.draft, parsed.config)) {
      clearAiDraftSnapshot();
      return null;
    }

    return parsed;
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
