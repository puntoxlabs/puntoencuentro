import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import type { EncounterDraftPatch } from '@/lib/encounterDraftPatch';
import { resolveDateIntent, resolveTimeIntent } from '@/lib/dateResolver';
import { isInvitationTheme, type InvitationTheme } from '@/lib/invitationThemes';

export interface MergeResult {
  draft: EncounterDraft;
  config: InvitationConfig;
  ambiguities: {
    field: string;
    reason: string;
    options?: string[];
  }[];
  coordinationDetected: boolean;
  pastDateDetected: boolean;
}

/**
 * Merges an EncounterDraftPatch into the current EncounterDraft deterministically.
 *
 * Rules:
 * 1. Modality has NO silent default: if neither location nor modality is mentioned, modality remains null.
 * 2. If a physical location is provided ("en casa", "en el bar"), modality is inferred as 'presencial'.
 * 3. If a virtual link or video mention is provided ("por Zoom", "meet"), modality is inferred as 'virtual'.
 * 4. Dates and times are resolved through deterministic resolution logic.
 * 5. Coordination signals (e.g. "jueves o viernes", "cuando podamos") are detected for handoff.
 */
export function mergeDraftPatch(
  currentDraft: EncounterDraft,
  currentConfig: InvitationConfig,
  patch: EncounterDraftPatch
): MergeResult {
  const draft: EncounterDraft = { ...currentDraft };
  const config: InvitationConfig = { ...currentConfig };
  const ambiguities: MergeResult['ambiguities'] = [];
  let coordinationDetected = false;
  let pastDateDetected = false;

  // 1. Coordination signal check
  if (
    patch.dateModeSignal?.value === 'coordination' ||
    patch.dateIntent?.value.type === 'range'
  ) {
    coordinationDetected = true;
  }

  // 2. Title
  if (patch.title?.value && patch.title.value.trim()) {
    draft.title = patch.title.value.trim();
  }

  // 3. Description
  if (patch.description?.value && patch.description.value.trim()) {
    draft.description = patch.description.value.trim();
  }

  // 4. Modality, Location & Virtual Link
  if (patch.modality?.value) {
    draft.modality = patch.modality.value;
  }

  if (patch.locationText?.value && patch.locationText.value.trim()) {
    draft.locationText = patch.locationText.value.trim();
    // Contextual inference: physical place provided -> presencial
    if (!draft.modality) {
      draft.modality = 'presencial';
    }
  }

  if (patch.virtualLink?.value && patch.virtualLink.value.trim()) {
    draft.virtualLink = patch.virtualLink.value.trim();
    // Contextual inference: virtual link provided -> virtual
    if (!draft.modality) {
      draft.modality = 'virtual';
    }
  }

  // 5. Date Intent Resolution
  if (patch.dateIntent?.value) {
    const dateRes = resolveDateIntent(patch.dateIntent.value);
    if (dateRes.resolved && dateRes.date) {
      draft.date = dateRes.date;
    } else {
      if (dateRes.isPast) {
        pastDateDetected = true;
      }
      if (dateRes.ambiguityReason) {
        ambiguities.push({
          field: 'date',
          reason: dateRes.ambiguityReason,
          options: dateRes.ambiguousOptions,
        });
      }
    }
  }

  // 6. Time Intent Resolution
  if (patch.timeIntent?.value) {
    const timeRes = resolveTimeIntent(patch.timeIntent.value);
    if (timeRes.resolved && timeRes.time) {
      draft.time = timeRes.time;
    } else if (timeRes.ambiguityReason) {
      ambiguities.push({
        field: 'time',
        reason: timeRes.ambiguityReason,
        options: timeRes.ambiguousOptions,
      });
    }
  }

  // 7. Theme hint (optional cosmetic hint)
  if (patch.themeHint?.value && isInvitationTheme(patch.themeHint.value)) {
    config.invitationTheme = patch.themeHint.value as InvitationTheme;
  }

  return {
    draft,
    config,
    ambiguities,
    coordinationDetected,
    pastDateDetected,
  };
}
