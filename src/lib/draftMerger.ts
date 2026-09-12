import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import type { EncounterDraftPatch, TemporalAlternative } from '@/lib/encounterDraftPatch';
import {
  resolveDateIntent,
  resolveTimeIntent,
  addDaysToIsoDate,
  parseDeterministicDateIntent,
  parseDeterministicTimeInput,
  resolveContextualHour,
  validateResolvedDateTimeInFuture,
  pad,
} from '@/lib/dateResolver';
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
  coordinationPendingConfirm?: boolean;
  temporalAlternativesOverflow?: boolean;
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

export interface ResolveAlternativesResult {
  dateOptions: Array<{ date: string; time: string }>;
  pendingTimeOptions: string[] | null;
  ambiguities: MergeResult['ambiguities'];
  coordinationDetected: boolean;
  coordinationPendingConfirm: boolean;
  temporalAlternativesOverflow: boolean;
  hasPastOptions: boolean;
}

/**
 * Resolves an array of TemporalAlternative objects (extracted by the LLM) into canonical
 * date options or pending time options using deterministic date/time resolvers.
 */
export function resolveTemporalAlternatives(
  alternatives: TemporalAlternative[],
  draftContext: { title?: string | null; description?: string | null },
  baseDateParts?: { year: number; month: number; day: number },
  overflowFlag?: boolean,
  currentDraftDate?: string | null
): ResolveAlternativesResult {
  const ambiguities: MergeResult['ambiguities'] = [];
  const parsedItems: Array<{
    date: string | null;
    time: string | null;
  }> = [];

  let globalDate: string | null = null;
  let globalTime: string | null = null;

  for (const alt of alternatives) {
    let optDate: string | null = null;
    let optTime: string | null = null;

    // 1. Resolve dateRef if present
    if (alt.dateRef && alt.dateRef.trim()) {
      const rawDate = alt.dateRef.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        optDate = rawDate;
      } else {
        const intent = parseDeterministicDateIntent(rawDate);
        if (intent) {
          const res = resolveDateIntent(intent, baseDateParts);
          if (res.resolved && res.date) {
            optDate = res.date;
          } else if (res.ambiguityReason) {
            ambiguities.push({
              field: 'date',
              reason: res.ambiguityReason,
              options: res.ambiguousOptions,
            });
          }
        }
      }
      if (optDate && !globalDate) {
        globalDate = optDate;
      }
    }

    // 2. Resolve timeRef if present
    if (alt.timeRef && alt.timeRef.trim()) {
      let cleanTime = alt.timeRef.trim();
      // Strip leading approximations like "tipo", "alrededor de", "cerca de"
      cleanTime = cleanTime.replace(/^(?:tipo|alrededor\s+de(?:\s+las?)?|cerca\s+de(?:\s+las?)?)\s+/i, '').trim();

      const timeParsed = parseDeterministicTimeInput(cleanTime);
      if (timeParsed.kind === 'exact') {
        const contextual = resolveContextualHour(
          timeParsed.hour,
          timeParsed.sourceForm,
          draftContext,
          timeParsed.minute,
          timeParsed.dayOffset || 0
        );

        if (contextual.resolvedHour !== null) {
          optTime = `${pad(contextual.resolvedHour)}:${pad(contextual.minute)}`;
          if (contextual.dayOffset && optDate) {
            optDate = addDaysToIsoDate(optDate, contextual.dayOffset);
          }
        } else if (contextual.requiresConfirmation) {
          // Keep literal time and record ambiguity question
          optTime = `${pad(timeParsed.hour)}:${pad(timeParsed.minute)}`;
          ambiguities.push({
            field: 'time',
            reason: contextual.questionText || '¿A qué hora te referís?',
            options: contextual.options,
          });
        } else {
          optTime = timeParsed.time;
        }
      }
      if (optTime && !globalTime) {
        globalTime = optTime;
      }
    }

    parsedItems.push({ date: optDate, time: optTime });
  }

  // Propagation of shared date / time across candidates:
  const effectiveDate = globalDate || currentDraftDate || null;
  const distinctDates = new Set(parsedItems.map((p) => p.date).filter(Boolean));
  const distinctTimes = new Set(parsedItems.map((p) => p.time).filter(Boolean));

  for (const item of parsedItems) {
    if (!item.date && effectiveDate && distinctDates.size <= 1 && item.time) {
      item.date = effectiveDate;
    }
    if (!item.time && globalTime && distinctTimes.size <= 1 && item.date) {
      item.time = globalTime;
    }
  }

  // Case A: Options with both Date and Time
  const itemsWithDateTime = parsedItems.filter((p) => p.date && p.time);
  if (itemsWithDateTime.length >= 2) {
    const validFutureOptions: Array<{ date: string; time: string }> = [];
    const seen = new Set<string>();
    let hasPast = false;

    for (const item of itemsWithDateTime) {
      const key = `${item.date}_${item.time}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isInFuture = validateResolvedDateTimeInFuture(item.date!, item.time!);
      if (isInFuture) {
        validFutureOptions.push({ date: item.date!, time: item.time! });
      } else {
        hasPast = true;
      }
    }

    const hasOverflow = Boolean(overflowFlag || alternatives.length > 3 || validFutureOptions.length > 3);

    return {
      dateOptions: validFutureOptions,
      pendingTimeOptions: null,
      ambiguities,
      coordinationDetected: true,
      coordinationPendingConfirm: validFutureOptions.length >= 2,
      temporalAlternativesOverflow: hasOverflow,
      hasPastOptions: hasPast,
    };
  }

  // Case B: Options with Time only, no Date (e.g. "a las 10 o a las 11")
  const itemsWithTimeOnly = parsedItems.filter((p) => p.time && !p.date);
  if (itemsWithTimeOnly.length >= 2) {
    const seenTimes = new Set<string>();
    const validTimes: string[] = [];
    for (const item of itemsWithTimeOnly) {
      if (!seenTimes.has(item.time!)) {
        seenTimes.add(item.time!);
        validTimes.push(item.time!);
      }
    }
    const hasOverflow = Boolean(overflowFlag || alternatives.length > 3 || validTimes.length > 3);
    return {
      dateOptions: [],
      pendingTimeOptions: validTimes,
      ambiguities,
      coordinationDetected: true,
      coordinationPendingConfirm: false,
      temporalAlternativesOverflow: hasOverflow,
      hasPastOptions: false,
    };
  }

  // Case C: Date only, or partially resolved
  return {
    dateOptions: [],
    pendingTimeOptions: null,
    ambiguities,
    coordinationDetected: true,
    coordinationPendingConfirm: false,
    temporalAlternativesOverflow: Boolean(overflowFlag || alternatives.length > 3),
    hasPastOptions: false,
  };
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
    patch.dateIntent?.value.type === 'range' ||
    (patch.dateOptions?.value && patch.dateOptions.value.length > 0) ||
    (patch.temporalAlternatives?.value && patch.temporalAlternatives.value.length > 0)
  ) {
    coordinationDetected = true;
  }

  if (patch.dateOptions?.value && patch.dateOptions.value.length > 0) {
    const resolvedOpts: Array<{ date: string; time: string }> = [];
    for (const opt of patch.dateOptions.value) {
      if (opt.date && opt.time) {
        resolvedOpts.push({ date: opt.date, time: opt.time });
      }
    }
    if (resolvedOpts.length >= 2) {
      draft.dateOptions = resolvedOpts;
      draft.dateMode = 'coordination';
      draft.date = null;
      draft.time = null;
    }
  }

  if (patch.durationMinutesHint?.value) {
    draft.durationMinutes = patch.durationMinutesHint.value;
  }

  if (patch.responseDeadlineHint?.value) {
    draft.responseDeadline = patch.responseDeadlineHint.value;
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

  let coordinationPendingConfirm: boolean | undefined = undefined;
  let hasResolvedAlternatives = false;

  // 4b. Temporal Alternatives Resolution (LLM Fallback coordination)
  if (patch.temporalAlternatives?.value && patch.temporalAlternatives.value.length > 0) {
    coordinationDetected = true;
    const altsRes = resolveTemporalAlternatives(
      patch.temporalAlternatives.value,
      { title: draft.title, description: draft.description },
      undefined,
      patch.temporalAlternativesOverflow?.value,
      draft.date
    );

    if (altsRes.ambiguities.length > 0) {
      ambiguities.push(...altsRes.ambiguities);
    }
    if (altsRes.hasPastOptions) {
      pastDateDetected = true;
    }
    if (altsRes.temporalAlternativesOverflow) {
      draft.temporalAlternativesOverflow = true;
    }

    if (altsRes.dateOptions && altsRes.dateOptions.length >= 2) {
      draft.dateOptions = altsRes.dateOptions;
      draft.dateMode = 'coordination';
      draft.date = null;
      draft.time = null;
      draft.pendingTimeOptions = null;
      coordinationPendingConfirm = altsRes.coordinationPendingConfirm;
      hasResolvedAlternatives = true;
    } else if (altsRes.pendingTimeOptions && altsRes.pendingTimeOptions.length >= 2) {
      draft.pendingTimeOptions = altsRes.pendingTimeOptions;
      draft.dateOptions = null;
      draft.date = null;
      draft.time = null;
      hasResolvedAlternatives = true;
    }
  }

  // 5. Date Intent Resolution
  if (!hasResolvedAlternatives && patch.dateIntent?.value) {
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
  if (!hasResolvedAlternatives && patch.timeIntent?.value) {
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
    coordinationPendingConfirm,
    temporalAlternativesOverflow: draft.temporalAlternativesOverflow,
  };
}
