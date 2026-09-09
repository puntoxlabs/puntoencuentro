import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import type { EncounterDraftPatch } from '@/lib/encounterDraftPatch';
import { resolveDateIntent, resolveTimeIntent, addDaysToIsoDate } from '@/lib/dateResolver';
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
 * Detects whether a URL or text represents a recognized virtual meeting platform or virtual signal.
 * Generic URLs (e.g. restaurant websites, ticket sales, Google Maps) return false.
 */
export function isRecognizedVirtualPlatform(linkOrText: string): boolean {
  if (!linkOrText || typeof linkOrText !== 'string') return false;
  const trimmed = linkOrText.trim().toLowerCase();
  if (!trimmed) return false;

  // Recognizable virtual meeting URL patterns
  const virtualUrlPatterns = [
    /^(https?:\/\/)?([a-z0-9-]+\.)?meet\.google\.com(\/.*)?$/i,
    /^(https?:\/\/)?([a-z0-9-]+\.)?zoom\.us(\/.*)?$/i,
    /^(https?:\/\/)?teams\.microsoft\.com(\/.*)?$/i,
    /^(https?:\/\/)?teams\.live\.com(\/.*)?$/i,
    /^(https?:\/\/)?([a-z0-9-]+\.)?webex\.com(\/.*)?$/i,
    /^(https?:\/\/)?([a-z0-9-]+\.)?whereby\.com(\/.*)?$/i,
    /^(https?:\/\/)?discord\.(gg|com)(\/.*)?$/i,
    /^(https?:\/\/)?facetime\.apple\.com(\/.*)?$/i,
    /^(https?:\/\/)?([a-z0-9-]+\.)?skype\.com(\/.*)?$/i,
    /^(https?:\/\/)?([a-z0-9-]+\.)?jitsi\.org(\/.*)?$/i,
    /^(https?:\/\/)?meet\.jit\.si(\/.*)?$/i,
  ];

  if (virtualUrlPatterns.some((pattern) => pattern.test(trimmed))) {
    return true;
  }

  // Keywords that denote virtual meeting if passed as platform/link text
  const virtualKeywords = [
    'meet',
    'google meet',
    'zoom',
    'teams',
    'microsoft teams',
    'videollamada',
    'videocall',
    'virtual',
    'online',
    'discord',
    'skype',
    'webex',
    'whereby',
    'jitsi',
  ];

  if (virtualKeywords.includes(trimmed)) {
    return true;
  }

  return false;
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
    const rawLink = patch.virtualLink.value.trim();
    if (isRecognizedVirtualPlatform(rawLink)) {
      draft.virtualLink = rawLink;
      // Real virtual link overrides any implicit modality
      draft.modality = 'virtual';
    } else {
      // Non-virtual URL passed as virtualLink (e.g. restaurant website, ticket link, Google Maps)
      // Do NOT set draft.virtualLink, and do NOT allow it to force modality to virtual
      const isMaps = /maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(rawLink);
      if (isMaps && !draft.locationText) {
        draft.locationText = rawLink;
      }
      // If modality was marked virtual solely due to a non-virtual URL, correct it
      if (draft.modality === 'virtual' && patch.modality?.value === 'virtual') {
        draft.modality = isMaps || draft.locationText ? 'presencial' : null;
      }
    }
  }

  // 5. Date Intent Resolution
  if (patch.dateIntent?.value) {
    const dateRes = resolveDateIntent(patch.dateIntent.value);
    if (dateRes.resolved && dateRes.date) {
      draft.date = dateRes.date;
      // If there is a pending end-of-day rollover from an earlier turn without a date,
      // and this patch does NOT specify a new timeIntent, apply the rollover now:
      if (!patch.timeIntent?.value && draft.pendingDayRollover) {
        draft.date = addDaysToIsoDate(draft.date, 1);
        draft.pendingDayRollover = false;
      }
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
    if (patch.timeIntent.confidence === 'ambiguous') {
      const desc =
        patch.timeIntent.value.type === 'vague' && patch.timeIntent.value.description
          ? patch.timeIntent.value.description
          : 'Mencionaste las 12. ¿Te referís al mediodía (12:00) o a la medianoche (00:00)?';
      ambiguities.push({
        field: 'time',
        reason: desc,
        options: ['12:00', '00:00'],
      });
    } else {
      const timeRes = resolveTimeIntent(patch.timeIntent.value);
      if (timeRes.resolved && timeRes.time) {
        draft.time = timeRes.time;
        if (timeRes.dayOffset) {
          if (draft.date) {
            draft.date = addDaysToIsoDate(draft.date, timeRes.dayOffset);
            draft.pendingDayRollover = false;
          } else {
            draft.pendingDayRollover = true;
          }
        } else {
          draft.pendingDayRollover = false;
        }
      } else if (timeRes.ambiguityReason) {
        ambiguities.push({
          field: 'time',
          reason: timeRes.ambiguityReason,
          options: timeRes.ambiguousOptions,
        });
      }
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
