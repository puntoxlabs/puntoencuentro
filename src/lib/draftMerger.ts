import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import type { EncounterDraftPatch } from '@/lib/encounterDraftPatch';
import { resolveDateIntent, resolveTimeIntent, addDaysToIsoDate } from '@/lib/dateResolver';
import {
  isInvitationTheme,
  getDefaultInvitationTemplate,
  resolveTemplateVariant,
  type InvitationTheme,
} from '@/lib/invitationThemes';

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
 * Normalizes a virtual meeting URL by trimming and prepending https:// if protocol is omitted.
 */
export function normalizeVirtualLink(input: string): string {
  let trimmed = input.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * Validates whether an input represents a valid virtual videocall link.
 *
 * Requirements:
 * - Valid HTTP or HTTPS scheme (or normalizable to https)
 * - No whitespace
 * - No invalid/unbalanced structural characters (e.g. unencoded parentheses, curly braces, quotes)
 * - Hostname with valid domain structure and TLD
 * - Explicitly rejects Google Maps / physical location URLs
 */
export function isValidVirtualLink(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed)) return false;
  if (/[()<>{}\\"^`|]/.test(trimmed)) return false;

  let normalized = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }
  if (!/^https?:\/\//i.test(normalized)) return false;

  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname;
    if (!hostname || !hostname.includes('.')) return false;
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(hostname)) {
      return false;
    }
    const parts = hostname.split('.');
    const tld = parts[parts.length - 1];
    if (!tld || tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) return false;
    if (/maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(normalized)) return false;
    return true;
  } catch {
    return false;
  }
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

  // 0. Off-topic & unclear guards: do not modify draft or config
  if (patch.scope === 'off_topic' || patch.scope === 'unclear') {
    return {
      draft,
      config,
      ambiguities,
      coordinationDetected: false,
      pastDateDetected: false,
    };
  }

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
    if (patch.modality.value === 'presencial') {
      draft.virtualLink = null;
    } else if (patch.modality.value === 'virtual') {
      draft.locationText = null;
    }
  }

  if (patch.locationText?.value && patch.locationText.value.trim()) {
    draft.locationText = patch.locationText.value.trim();
    // Contextual inference: physical place provided -> presencial if modality not set
    if (!draft.modality) {
      draft.modality = 'presencial';
    }
  }

  if (patch.virtualLink?.value && patch.virtualLink.value.trim()) {
    const rawLink = patch.virtualLink.value.trim();
    const isMaps = /maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(rawLink);

    if (isMaps) {
      if (!draft.locationText) {
        draft.locationText = rawLink;
      }
      if (!currentDraft.modality && draft.modality === 'virtual') {
        draft.modality = 'presencial';
      }
    } else {
      const isVirtualUrl = isValidVirtualLink(rawLink);
      const isPlatformKeyword = isRecognizedVirtualPlatform(rawLink);
      const isModalityConfirmedVirtual = currentDraft.modality === 'virtual' || patch.modality?.value === 'virtual';

      if (isVirtualUrl && (isModalityConfirmedVirtual || isPlatformKeyword)) {
        // Exclusively valid navigable URLs can populate draft.virtualLink
        draft.virtualLink = normalizeVirtualLink(rawLink);
        draft.modality = 'virtual';
      } else if (isPlatformKeyword) {
        // Platform keywords ("Zoom", "Google Meet", "Teams") indicate virtual modality,
        // but DO NOT complete virtualLink because they are not navigable URLs.
        draft.modality = 'virtual';
        draft.virtualLink = null;
      } else {
        // Non-virtual URL (e.g. restaurant website, ticket link) or invalid URL
        // Do NOT set draft.virtualLink.
        // Modality must NEVER be wiped if it was already confirmed/set!
        if (!currentDraft.modality && draft.modality === 'virtual' && patch.modality?.value === 'virtual') {
          draft.modality = draft.locationText ? 'presencial' : null;
        }
      }
    }
  }

  // 5. Date Intent Resolution
  if (patch.dateIntent?.value) {
    const dateRes = resolveDateIntent(patch.dateIntent.value);
    if (dateRes.resolved && dateRes.date) {
      draft.baseDate = dateRes.date;

      // If this patch does NOT specify a new timeIntent, preserve existing temporal semantics:
      // If 24:00 rollover was applied or pending, advance date to +1 day and keep appliedDayRollover = true.
      if (!patch.timeIntent?.value) {
        if (draft.appliedDayRollover || draft.pendingDayRollover) {
          draft.date = addDaysToIsoDate(draft.baseDate, 1);
          draft.appliedDayRollover = true;
          draft.pendingDayRollover = false;
        } else {
          draft.date = dateRes.date;
          draft.appliedDayRollover = false;
          draft.pendingDayRollover = false;
        }
      } else {
        draft.date = dateRes.date;
        draft.appliedDayRollover = false;
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

        const baseAnchor = draft.baseDate || draft.date;

        if (timeRes.dayOffset) {
          if (baseAnchor) {
            draft.baseDate = baseAnchor;
            draft.date = addDaysToIsoDate(baseAnchor, timeRes.dayOffset);
            draft.appliedDayRollover = true;
            draft.pendingDayRollover = false;
          } else {
            draft.pendingDayRollover = true;
            draft.appliedDayRollover = false;
          }
        } else {
          if (baseAnchor) {
            draft.baseDate = baseAnchor;
            // Restore date to semantic base anchor, undoing any prior 24:00 day-rollover
            draft.date = baseAnchor;
            draft.appliedDayRollover = false;
            draft.pendingDayRollover = false;
          } else {
            draft.pendingDayRollover = false;
            draft.appliedDayRollover = false;
          }
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

  // 7. Theme hint (category)
  if (patch.themeHint?.value && isInvitationTheme(patch.themeHint.value)) {
    const newTheme = patch.themeHint.value as InvitationTheme;
    if (config.invitationTheme !== newTheme) {
      config.invitationTheme = newTheme;
      config.invitationTemplate = getDefaultInvitationTemplate(newTheme);
    }
  }

  // 8. Template hint (specific variant)
  if (patch.templateHint?.value) {
    const resolved = resolveTemplateVariant(config.invitationTheme, patch.templateHint.value);
    if (resolved) {
      config.invitationTemplate = resolved;
    }
  }

  return {
    draft,
    config,
    ambiguities,
    coordinationDetected,
    pastDateDetected,
  };
}
