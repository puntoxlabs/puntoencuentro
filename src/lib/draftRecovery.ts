import type { WizardState } from '@/store/wizardStore';
import type { CoordinationDraft } from '@/store/coordinationWizardStore';
import { hasMeaningfulDraftData } from '@/lib/encounterDraft';
import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';

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

/**
 * Determina si el borrador de creación con IA tiene datos recuperables.
 */
export function hasRecoverableAiDraft(
  draft: EncounterDraft | null | undefined,
  config?: InvitationConfig | null
): boolean {
  if (!draft) return false;
  return hasMeaningfulDraftData(draft, config ?? undefined);
}
