import {
  hasMeaningfulDraftData,
  type EncounterDraft,
  type InvitationConfig,
  type PendingTemporalAlternative,
} from '@/lib/encounterDraft';
import type { EncounterDraftPatch, TemporalAlternative, ActionApplicationResult } from '@/lib/encounterDraftPatch';
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

export type MergeOperationType =
  | 'INITIAL_CREATION'
  | 'FIELD_COMPLETION'
  | 'FIELD_MODIFICATION'
  | 'CHANGE_FIXED'
  | 'CONVERT_FIXED_TO_COORD'
  | 'CONVERT_COORD_TO_FIXED'
  | 'ADD_OPTION'
  | 'MODIFY_OPTION'
  | 'REMOVE_OPTION'
  | 'NO_CHANGE';

export interface MergeOperationMetadata {
  operationType: MergeOperationType;
  primaryField?: 'title' | 'schedule' | 'location' | 'modality' | 'theme' | 'template' | 'options' | 'description';
  changedFields?: string[];
  isDuplicateOption?: boolean;
  addedOption?: { date: string; time: string };
  removedOptionDate?: string;
  modifiedOption?: { date: string; time: string };
  selectedOption?: { date: string; time: string };
  optionsCount?: number;
  fixedSchedule?: { date: string; time: string };
  previousFixedSchedule?: { date: string; time: string };
}

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
  /** Per-action outcomes for granular date operations — used by the reply accumulator. */
  actionResults?: ActionApplicationResult[];
  /** Semantic operation classification for assistant reply composition and telemetry. */
  operationMetadata: MergeOperationMetadata;
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
  pendingTemporalAlternatives: PendingTemporalAlternative[] | null;
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
  currentDraftDate?: string | null,
  currentDraftTime?: string | null
): ResolveAlternativesResult {
  const ambiguities: MergeResult['ambiguities'] = [];
  const parsedItems: Array<{
    date: string | null;
    time: string | null;
    rawDateRef?: string | null;
    rawTimeRef?: string | null;
    ambiguity: { field: 'date' | 'time'; reason: string; options: string[] } | null;
  }> = [];

  let globalDate: string | null = null;
  let globalTime: string | null = null;

  for (let idx = 0; idx < alternatives.length; idx++) {
    const alt = alternatives[idx];
    let optDate: string | null = null;
    let optTime: string | null = null;
    let altAmbiguity: { field: 'date' | 'time'; reason: string; options: string[] } | null = null;

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
            altAmbiguity = {
              field: 'date',
              reason: res.ambiguityReason,
              options: res.ambiguousOptions || [],
            };
            ambiguities.push(altAmbiguity);
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
          // Keep literal time null and record ambiguity question with contextual prefix if applicable
          let qText = contextual.questionText || '¿A qué hora te referís?';
          if (alt.dateRef && idx > 0) {
            const rawRef = alt.dateRef.trim().toLowerCase();
            const datePrefix = rawRef.includes('mañana')
              ? 'Para el día de mañana, '
              : rawRef === 'hoy'
              ? 'Para el día de hoy, '
              : `Para ${alt.dateRef.trim()}, `;
            if (!qText.toLowerCase().startsWith('para')) {
              qText = `${datePrefix}${qText}`;
            }
          }
          altAmbiguity = {
            field: 'time',
            reason: qText,
            options: contextual.options || [],
          };
          ambiguities.push(altAmbiguity);
        } else {
          optTime = timeParsed.time;
        }
      }
      if (optTime && !globalTime) {
        globalTime = optTime;
      }
    }

    parsedItems.push({
      date: optDate,
      time: optTime,
      rawDateRef: alt.dateRef,
      rawTimeRef: alt.timeRef,
      ambiguity: altAmbiguity,
    });
  }

  // Propagation of shared date / time across candidates:
  const effectiveDate = globalDate || currentDraftDate || null;
  const distinctDates = new Set(parsedItems.map((p) => p.date).filter(Boolean));
  const distinctTimes = new Set(parsedItems.map((p) => p.time).filter(Boolean));

  for (const item of parsedItems) {
    if (!item.date && effectiveDate && distinctDates.size <= 1 && item.time) {
      item.date = effectiveDate;
    }
    if (!item.time && globalTime && distinctTimes.size <= 1 && item.date && !item.ambiguity) {
      item.time = globalTime;
    }
  }

  // Case 0: If any alternative has an unresolved ambiguity
  const hasAmbiguity = parsedItems.some((p) => p.ambiguity !== null);
  if (hasAmbiguity) {
    const pendingTemporalAlternatives: PendingTemporalAlternative[] = parsedItems.map((p) => ({
      date: p.date,
      time: p.time,
      rawDateRef: p.rawDateRef,
      rawTimeRef: p.rawTimeRef,
      ambiguity: p.ambiguity,
    }));
    const hasOverflow = Boolean(overflowFlag || alternatives.length > 3);
    return {
      dateOptions: [],
      pendingTimeOptions: null,
      pendingTemporalAlternatives,
      ambiguities,
      coordinationDetected: true,
      coordinationPendingConfirm: false,
      temporalAlternativesOverflow: hasOverflow,
      hasPastOptions: false,
    };
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
      pendingTemporalAlternatives: null,
      ambiguities,
      coordinationDetected: true,
      coordinationPendingConfirm: validFutureOptions.length >= 2,
      temporalAlternativesOverflow: hasOverflow,
      hasPastOptions: hasPast,
    };
  }

  // Case A1: 1 option with date+time when current draft has a fixed date+time -> combine into 2 options
  if (itemsWithDateTime.length === 1 && currentDraftDate && currentDraftTime) {
    const validFutureOptions: Array<{ date: string; time: string }> = [];
    const seen = new Set<string>();
    let hasPast = false;

    // Option 1: existing fixed date/time
    const key1 = `${currentDraftDate}_${currentDraftTime}`;
    seen.add(key1);
    validFutureOptions.push({ date: currentDraftDate, time: currentDraftTime });

    // Option 2: the new alternative
    const item = itemsWithDateTime[0];
    const key2 = `${item.date}_${item.time}`;
    if (!seen.has(key2)) {
      seen.add(key2);
      const isInFuture = validateResolvedDateTimeInFuture(item.date!, item.time!);
      if (isInFuture) {
        validFutureOptions.push({ date: item.date!, time: item.time! });
      } else {
        hasPast = true;
      }
    }

    if (validFutureOptions.length >= 2) {
      return {
        dateOptions: validFutureOptions,
        pendingTimeOptions: null,
        pendingTemporalAlternatives: null,
        ambiguities,
        coordinationDetected: true,
        coordinationPendingConfirm: true,
        temporalAlternativesOverflow: Boolean(overflowFlag || alternatives.length > 3),
        hasPastOptions: hasPast,
      };
    }
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
      pendingTemporalAlternatives: null,
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
    pendingTemporalAlternatives: null,
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
      operationMetadata: {
        operationType: 'NO_CHANGE',
        changedFields: [],
      },
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
  if (patch.description) {
    if (patch.description.action === 'clear') {
      draft.description = null;
    } else if (patch.description.value && patch.description.value.trim()) {
      draft.description = patch.description.value.trim();
    }
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
      draft.date,
      draft.time
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
      draft.pendingTemporalAlternatives = null;
      coordinationPendingConfirm = altsRes.coordinationPendingConfirm;
      hasResolvedAlternatives = true;
    } else if (altsRes.pendingTimeOptions && altsRes.pendingTimeOptions.length >= 2) {
      draft.pendingTimeOptions = altsRes.pendingTimeOptions;
      draft.dateOptions = null;
      draft.date = null;
      draft.time = null;
      draft.pendingTemporalAlternatives = null;
      hasResolvedAlternatives = true;
    } else if (altsRes.pendingTemporalAlternatives && altsRes.pendingTemporalAlternatives.length >= 2) {
      draft.pendingTemporalAlternatives = altsRes.pendingTemporalAlternatives;
      draft.dateOptions = null;
      draft.date = null;
      draft.time = null;
      draft.pendingTimeOptions = null;
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

  // 9. Invitation Type hint
  if (
    patch.invitationTypeHint?.value &&
    patch.invitationTypeHint.confidence !== 'inferred_low' &&
    patch.invitationTypeHint.confidence !== 'ambiguous'
  ) {
    config.invitationType = patch.invitationTypeHint.value;
  }

  // 10. Granular Actions Processing
  const actionResults: ActionApplicationResult[] = [];
  let explicitActionOpType: MergeOperationType | null = null;
  let addedOptionMeta: { date: string; time: string } | undefined = undefined;
  let removedOptionDateMeta: string | undefined = undefined;
  let modifiedOptionMeta: { date: string; time: string } | undefined = undefined;
  let selectedOptionMeta: { date: string; time: string } | undefined = undefined;
  let isDuplicateOptionMeta = false;

  if (patch.actions && patch.actions.length > 0) {
    // Step -1: Apply select_fixed_option (convert coordination to fixed)
    for (const action of patch.actions) {
      if (action.type === 'select_fixed_option') {
        let selectedDate: string | null = null;
        let selectedTime: string | null = null;
        let isAmbiguous = false;
        let ambiguityReason = '';

        const originalSnapshot = draft.dateOptions ? [...draft.dateOptions] : [];

        // 1. Target resolution
        if (action.target) {
          if ('position' in action.target && typeof action.target.position === 'number') {
            const pos = action.target.position;
            if (pos >= 0 && pos < originalSnapshot.length) {
              selectedDate = originalSnapshot[pos].date;
              selectedTime = originalSnapshot[pos].time;
            }
          } else if ('date' in action.target && typeof action.target.date === 'string') {
            const tDate = action.target.date;
            const tTime = 'time' in action.target ? action.target.time : undefined;
            const matches = originalSnapshot.filter(
              (opt) => opt.date === tDate && (!tTime || opt.time === tTime)
            );
            if (matches.length === 1) {
              selectedDate = matches[0].date;
              selectedTime = matches[0].time;
            } else if (matches.length > 1) {
              isAmbiguous = true;
              ambiguityReason = 'Hay más de una opción en esa fecha. Se necesita especificar la hora.';
            }
          }
        }

        // 2. Changes resolution (new schedule or override)
        if (!selectedDate || !selectedTime || action.changes) {
          if (action.changes) {
            if (action.changes.dateRef) {
              const raw = action.changes.dateRef.trim();
              if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
                selectedDate = raw;
              } else {
                const intent = parseDeterministicDateIntent(raw);
                if (intent) {
                  const resolved = resolveDateIntent(intent, undefined);
                  if (resolved.date) selectedDate = resolved.date;
                }
              }
            }
            if (action.changes.timeRef) {
              const raw = action.changes.timeRef.trim();
              if (/^\d{2}:\d{2}$/.test(raw)) {
                selectedTime = raw;
              } else {
                const intent = parseDeterministicTimeInput(raw);
                if (intent && intent.kind === 'exact') {
                  if (intent.sourceForm === 'ambiguous_12h_word') {
                    const res = resolveContextualHour(
                      intent.hour,
                      intent.sourceForm,
                      { title: draft.title, description: draft.description },
                      intent.minute,
                      intent.dayOffset || 0
                    );
                    if (res.resolvedHour !== null) {
                      selectedTime = `${pad(res.resolvedHour)}:${pad(res.minute)}`;
                    }
                  } else {
                    selectedTime = intent.time;
                  }
                }
              }
            }
          }
        }

        // Fallback to scalar draft date/time if available
        if (!selectedDate && draft.date) selectedDate = draft.date;
        if (!selectedTime && draft.time) selectedTime = draft.time;

        if (isAmbiguous) {
          actionResults.push({ status: 'needs_clarification', action, reason: ambiguityReason });
          ambiguities.push({
            field: 'schedule',
            reason: ambiguityReason,
            options: [],
          });
          continue;
        }

        if (!selectedDate || !selectedTime) {
          actionResults.push({
            status: 'rejected',
            action,
            reason: 'No se pudo determinar la fecha y hora seleccionada.',
          });
          continue;
        }

        const isInFuture = validateResolvedDateTimeInFuture(selectedDate, selectedTime);
        if (!isInFuture) {
          actionResults.push({
            status: 'rejected',
            action,
            reason: 'La fecha y hora deben ser futuras.',
          });
          continue;
        }

        // Apply transition coordination -> fixed
        draft.dateMode = 'fixed';
        draft.date = selectedDate;
        draft.time = selectedTime;
        draft.baseDate = selectedDate;
        draft.dateOptions = null;
        draft.pendingTimeOptions = null;
        draft.pendingTemporalAlternatives = null;
        coordinationDetected = false;
        coordinationPendingConfirm = false;
        explicitActionOpType = 'CONVERT_COORD_TO_FIXED';
        selectedOptionMeta = { date: selectedDate, time: selectedTime };
        actionResults.push({ status: 'applied', action });
      }
    }

    // Step 0: Apply additions (add_date_option)
    for (const action of patch.actions) {
      if (action.type === 'add_date_option') {
        const changes = action.changes;
        if (!changes || (!changes.dateRef && !changes.timeRef)) {
          actionResults.push({ status: 'rejected', action, reason: 'No se proporcionaron cambios para la opción' });
          continue;
        }

        let parsedDate: string | null = null;
        let parsedTime: string | null = null;

        if (changes.dateRef) {
          const raw = changes.dateRef.trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
            parsedDate = raw;
          } else {
            const intent = parseDeterministicDateIntent(raw);
            if (intent) {
              const resolved = resolveDateIntent(intent, undefined);
              if (resolved.date) parsedDate = resolved.date;
            }
          }
        }

        if (changes.timeRef) {
          const raw = changes.timeRef.trim();
          if (/^\d{2}:\d{2}$/.test(raw)) {
            parsedTime = raw;
          } else {
            const intent = parseDeterministicTimeInput(raw);
            if (intent && intent.kind === 'exact') {
              if (intent.sourceForm === 'ambiguous_12h_word') {
                const res = resolveContextualHour(
                  intent.hour,
                  intent.sourceForm,
                  { title: draft.title, description: draft.description },
                  intent.minute,
                  intent.dayOffset || 0
                );
                if (res.resolvedHour !== null) {
                  parsedTime = `${pad(res.resolvedHour)}:${pad(res.minute)}`;
                }
              } else {
                parsedTime = intent.time;
              }
            }
          }
        }

        if (!parsedDate && draft.date) {
          parsedDate = draft.date;
        }
        if (!parsedTime && draft.time) {
          parsedTime = draft.time;
        }

        if (!parsedDate || !parsedTime) {
          actionResults.push({ status: 'needs_clarification', action, reason: 'Se requiere fecha y hora para la opción alternativa' });
          continue;
        }

        const isInFuture = validateResolvedDateTimeInFuture(parsedDate, parsedTime);
        if (!isInFuture) {
          actionResults.push({ status: 'rejected', action, reason: 'La fecha y hora deben ser futuras' });
          continue;
        }

        const newOption = { date: parsedDate, time: parsedTime };

        // Subcase A: Current draft is fixed (convert fixed to coordination)
        if (draft.dateMode === 'fixed' && draft.date && draft.time) {
          const isDup = draft.date === parsedDate && draft.time === parsedTime;
          if (isDup) {
            isDuplicateOptionMeta = true;
            actionResults.push({ status: 'rejected', action, reason: 'Esa opción ya está incluida en la coordinación.' });
          } else {
            const fixedOpt = { date: draft.date, time: draft.time };
            draft.dateMode = 'coordination';
            draft.date = null;
            draft.time = null;
            draft.dateOptions = [fixedOpt, newOption];
            coordinationDetected = true;
            explicitActionOpType = 'CONVERT_FIXED_TO_COORD';
            addedOptionMeta = newOption;
            actionResults.push({ status: 'applied', action });
          }
        } else if (draft.dateOptions && draft.dateOptions.length > 0) {
          // Subcase B: Current draft already has dateOptions
          const isDup = draft.dateOptions.some((o) => o.date === parsedDate && o.time === parsedTime);
          if (isDup) {
            isDuplicateOptionMeta = true;
            actionResults.push({ status: 'rejected', action, reason: 'Esa opción ya está incluida en la coordinación.' });
          } else if (draft.dateOptions.length >= 3) {
            actionResults.push({
              status: 'rejected',
              action,
              reason: 'Por ahora podés incluir hasta 3 opciones para coordinar. Podés cambiar o eliminar una de las opciones existentes.',
            });
          } else {
            draft.dateOptions.push(newOption);
            coordinationDetected = true;
            explicitActionOpType = 'ADD_OPTION';
            addedOptionMeta = newOption;
            actionResults.push({ status: 'applied', action });
          }
        }
      }
    }

    // Step 1: For modify and remove actions, require dateOptions
    if (draft.dateOptions && draft.dateOptions.length > 0) {
      const originalSnapshot = [...draft.dateOptions];
      const modifyAndRemoveActions = patch.actions.filter(
        (a) => a.type === 'modify_date_option' || a.type === 'remove_date_option'
      );

      const resolvedActions = modifyAndRemoveActions.map((action) => {
        let targetIndex = -1;

        if (action.target && 'position' in action.target && typeof action.target.position === 'number') {
          if (action.target.position >= 0 && action.target.position < originalSnapshot.length) {
            targetIndex = action.target.position;
          }
        } else if (action.target && 'date' in action.target) {
          const target = action.target as { date: string; time?: string };
          const matches = originalSnapshot.reduce((acc, opt, idx) => {
            if (opt.date === target.date && (!target.time || opt.time === target.time)) {
              acc.push(idx);
            }
            return acc;
          }, [] as number[]);

          if (matches.length === 1) {
            targetIndex = matches[0];
          } else if (matches.length > 1) {
            return {
              action,
              targetIndex: -1,
              status: 'needs_clarification' as const,
              reason: 'Multiple opciones coinciden con la fecha. Se necesita la hora.',
            };
          }
        }

        if (targetIndex === -1) {
          return { action, targetIndex, status: 'rejected' as const, reason: 'No se encontró la opción a modificar/eliminar.' };
        }
        return { action, targetIndex, status: 'ok' as const };
      });

      // Apply modifications
      for (const item of resolvedActions) {
        if (item.status !== 'ok') {
          actionResults.push({ status: item.status, action: item.action, reason: item.reason });
          continue;
        }

        if (item.action.type === 'modify_date_option') {
          const changes = item.action.changes;
          if (!changes || (!changes.dateRef && !changes.timeRef)) {
            actionResults.push({ status: 'rejected', action: item.action, reason: 'No changes provided' });
            continue;
          }

          let parsedDate: string | null = null;
          let parsedTime: string | null = null;
          let hasAmbiguity = false;
          let ambiguityReason = '';

          if (changes.dateRef) {
            const raw = changes.dateRef.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
              parsedDate = raw;
            } else {
              const intent = parseDeterministicDateIntent(raw);
              if (intent) {
                const resolved = resolveDateIntent(intent, undefined);
                if (!resolved.resolved && resolved.ambiguityReason) {
                  hasAmbiguity = true;
                  ambiguityReason = resolved.ambiguityReason;
                } else if (resolved.date) {
                  parsedDate = resolved.date;
                }
              }
            }
          }

          if (changes.timeRef) {
            const raw = changes.timeRef.trim();
            if (/^\d{2}:\d{2}$/.test(raw)) {
              parsedTime = raw;
            } else {
              const intent = parseDeterministicTimeInput(raw);
              if (intent && intent.kind === 'exact') {
                if (intent.sourceForm === 'ambiguous_12h_word') {
                  const res = resolveContextualHour(
                    intent.hour,
                    intent.sourceForm,
                    { title: null, description: null },
                    intent.minute,
                    intent.dayOffset || 0
                  );
                  if (res.requiresConfirmation) {
                    hasAmbiguity = true;
                    ambiguityReason = res.questionText || 'Ambigüedad en la hora.';
                  } else if (res.resolvedHour !== null) {
                    parsedTime = `${pad(res.resolvedHour)}:${pad(res.minute)}`;
                  }
                } else {
                  parsedTime = intent.time;
                }
              }
            }
          }

          const newDate = parsedDate || originalSnapshot[item.targetIndex].date;
          const newTime = parsedTime || originalSnapshot[item.targetIndex].time;

          if (hasAmbiguity) {
            actionResults.push({ status: 'needs_clarification', action: item.action, reason: ambiguityReason });
            ambiguities.push({
              field: changes.dateRef && !parsedDate ? 'date' : 'time',
              reason: ambiguityReason,
              options: [],
            });
          } else {
            const isInFuture = validateResolvedDateTimeInFuture(newDate, newTime);
            if (!isInFuture) {
              actionResults.push({ status: 'rejected', action: item.action, reason: 'Date is in the past' });
              continue;
            }

            const targetOriginal = originalSnapshot[item.targetIndex];
            const currIndex = draft.dateOptions.findIndex(
              (o) => o.date === targetOriginal.date && o.time === targetOriginal.time
            );

            if (currIndex !== -1) {
              const isDuplicate = draft.dateOptions.some(
                (o, i) => i !== currIndex && o.date === newDate && o.time === newTime
              );
              if (isDuplicate) {
                isDuplicateOptionMeta = true;
                actionResults.push({
                  status: 'rejected',
                  action: item.action,
                  reason: 'Modified option duplicates an existing option',
                });
              } else {
                draft.dateOptions[currIndex] = { date: newDate, time: newTime };
                actionResults.push({ status: 'applied', action: item.action });
                explicitActionOpType = 'MODIFY_OPTION';
                modifiedOptionMeta = { date: newDate, time: newTime };
              }
            }
          }
        }
      }

      // Apply removals
      for (const item of resolvedActions) {
        if (item.status === 'ok' && item.action.type === 'remove_date_option') {
          const targetOriginal = originalSnapshot[item.targetIndex];
          const currIndex = draft.dateOptions.findIndex(
            (o) => o.date === targetOriginal.date && o.time === targetOriginal.time
          );

          if (currIndex !== -1) {
            removedOptionDateMeta = targetOriginal.date;
            draft.dateOptions.splice(currIndex, 1);
            actionResults.push({ status: 'applied', action: item.action });
            explicitActionOpType = 'REMOVE_OPTION';
          } else {
            actionResults.push({ status: 'rejected', action: item.action, reason: 'Option no longer exists' });
          }
        }
      }

      // Step 3: Collapse to fixed if only 1 option remains
      if (draft.dateOptions && draft.dateOptions.length === 1) {
        draft.dateMode = 'fixed';
        draft.date = draft.dateOptions[0].date;
        draft.time = draft.dateOptions[0].time;
        draft.dateOptions = null;
        explicitActionOpType = 'CHANGE_FIXED';
      } else if (draft.dateOptions && draft.dateOptions.length === 0) {
        draft.dateOptions = null;
      }
    }
  }

  // Fallback for coordination -> fixed without explicit actions (e.g. LLM set dateIntent + timeIntent or dateModeSignal='fixed')
  if (
    currentDraft.dateMode === 'coordination' &&
    draft.date &&
    draft.time &&
    !hasResolvedAlternatives &&
    (!patch.temporalAlternatives || !patch.temporalAlternatives.value || patch.temporalAlternatives.value.length === 0)
  ) {
    draft.dateMode = 'fixed';
    draft.dateOptions = null;
    draft.pendingTimeOptions = null;
    draft.pendingTemporalAlternatives = null;
    coordinationDetected = false;
    coordinationPendingConfirm = false;
    if (!explicitActionOpType) {
      explicitActionOpType = 'CONVERT_COORD_TO_FIXED';
    }
    if (!selectedOptionMeta) {
      selectedOptionMeta = { date: draft.date, time: draft.time };
    }
  }

  // 11. Operation Classification
  const prevHadData = hasMeaningfulDraftData(currentDraft, currentConfig);
  const nowHasData = hasMeaningfulDraftData(draft, config);

  let operationType: MergeOperationType = 'NO_CHANGE';
  let primaryField: MergeOperationMetadata['primaryField'];
  const changedFields: string[] = [];

  if (!prevHadData && nowHasData) {
    operationType = 'INITIAL_CREATION';
  } else if (prevHadData) {
    if (explicitActionOpType) {
      operationType = explicitActionOpType;
      if (
        operationType === 'CONVERT_FIXED_TO_COORD' ||
        operationType === 'CONVERT_COORD_TO_FIXED' ||
        operationType === 'ADD_OPTION' ||
        operationType === 'REMOVE_OPTION' ||
        operationType === 'MODIFY_OPTION'
      ) {
        primaryField = 'options';
      } else if (operationType === 'CHANGE_FIXED') {
        primaryField = 'schedule';
      }
    } else if (
      currentDraft.dateMode === 'coordination' &&
      draft.dateMode === 'fixed' &&
      draft.date &&
      draft.time
    ) {
      operationType = 'CONVERT_COORD_TO_FIXED';
      primaryField = 'options';
      selectedOptionMeta = { date: draft.date, time: draft.time };
    } else if (
      currentDraft.dateMode === 'fixed' &&
      draft.dateMode === 'coordination' &&
      draft.dateOptions &&
      draft.dateOptions.length >= 2
    ) {
      operationType = 'CONVERT_FIXED_TO_COORD';
      primaryField = 'options';
      if (draft.dateOptions.length >= 2) {
        addedOptionMeta = draft.dateOptions[draft.dateOptions.length - 1];
      }
    } else if (
      currentDraft.dateMode === 'fixed' &&
      (draft.date !== currentDraft.date || draft.time !== currentDraft.time) &&
      (draft.date || draft.time)
    ) {
      if (!currentDraft.date && !currentDraft.time) {
        operationType = 'FIELD_COMPLETION';
        primaryField = 'schedule';
        changedFields.push('schedule');
      } else {
        operationType = 'CHANGE_FIXED';
        primaryField = 'schedule';
        changedFields.push('schedule');
      }
    }

    if (draft.title !== currentDraft.title) {
      changedFields.push('title');
      if (!currentDraft.title && draft.title) {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_COMPLETION';
        if (!primaryField) primaryField = 'title';
      } else {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_MODIFICATION';
        if (!primaryField) primaryField = 'title';
      }
    }
    if (draft.locationText !== currentDraft.locationText) {
      changedFields.push('location');
      if (!currentDraft.locationText && draft.locationText) {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_COMPLETION';
        if (!primaryField) primaryField = 'location';
      } else {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_MODIFICATION';
        if (!primaryField) primaryField = 'location';
      }
    }
    if (draft.virtualLink !== currentDraft.virtualLink) {
      changedFields.push('virtualLink');
      if (!currentDraft.virtualLink && draft.virtualLink) {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_COMPLETION';
        if (!primaryField) primaryField = 'location';
      } else {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_MODIFICATION';
        if (!primaryField) primaryField = 'location';
      }
    }
    if (draft.modality !== currentDraft.modality) {
      changedFields.push('modality');
      if (!currentDraft.modality && draft.modality) {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_COMPLETION';
        if (!primaryField) primaryField = 'modality';
      } else {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_MODIFICATION';
        if (!primaryField) primaryField = 'modality';
      }
    }
    if (config.invitationTheme !== currentConfig.invitationTheme) {
      changedFields.push('theme');
      operationType = 'FIELD_MODIFICATION';
      if (!primaryField) primaryField = 'theme';
    }
    if (config.invitationTemplate !== currentConfig.invitationTemplate) {
      changedFields.push('template');
      operationType = 'FIELD_MODIFICATION';
      if (!primaryField) primaryField = 'template';
    }
    if (draft.description !== currentDraft.description) {
      changedFields.push('description');
      if (!currentDraft.description && draft.description) {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_COMPLETION';
        if (!primaryField) primaryField = 'description';
      } else {
        if (operationType === 'NO_CHANGE') operationType = 'FIELD_MODIFICATION';
        if (!primaryField) primaryField = 'description';
      }
    }

    if (changedFields.length > 1) {
      operationType = 'FIELD_MODIFICATION';
    }
  }

  const operationMetadata: MergeOperationMetadata = {
    operationType,
    primaryField,
    changedFields: changedFields.length > 0 ? changedFields : undefined,
    isDuplicateOption: isDuplicateOptionMeta || undefined,
    addedOption: addedOptionMeta,
    removedOptionDate: removedOptionDateMeta,
    modifiedOption: modifiedOptionMeta,
    selectedOption: selectedOptionMeta,
    optionsCount: draft.dateOptions?.length,
    fixedSchedule: draft.date && draft.time ? { date: draft.date, time: draft.time } : undefined,
    previousFixedSchedule:
      currentDraft.date && currentDraft.time ? { date: currentDraft.date, time: currentDraft.time } : undefined,
  };

  return {
    draft,
    config,
    ambiguities,
    coordinationDetected,
    pastDateDetected,
    coordinationPendingConfirm,
    temporalAlternativesOverflow: draft.temporalAlternativesOverflow,
    actionResults: actionResults.length > 0 ? actionResults : undefined,
    operationMetadata,
  };
}
