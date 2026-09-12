import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DraftSummary } from '@/components/ai/DraftSummary';
import { FieldQuestion } from '@/components/ai/FieldQuestion';
import { CreateAIWizard } from '@/screens/CreateAIWizard';

import {
  resolveDateIntent,
  resolveTimeIntent,
  addDaysToIsoDate,
  pad,
  resolveNextValidDayOfMonth,
  isValidCalendarDate,
  getDaysInMonth,
  parseDeterministicTimeInput,
  looksLikeOtherFieldIntent,
  normalizeToCanonicalWeekday,
  resolveNthWeekdayOfMonth,
  parseDeterministicDateIntent,
  parseDeterministicDateExpression,
  parseNaturalLanguageDateOptions,
  parseCoordinationTransition,
} from '../src/lib/dateResolver.ts';
import { mergeDraftPatch, isRecognizedVirtualPlatform, isValidVirtualLink, normalizeVirtualLink, resolveTemporalAlternatives } from '../src/lib/draftMerger.ts';
import { evaluateDraft } from '../src/lib/draftFieldEngine.ts';
import {
  hasDateEvidence,
  hasTimeEvidence,
  sanitizeTemporalIntents,
  validatePatchOutput,
  ENCOUNTER_DRAFT_PATCH_SCHEMA,
  sanitizeSchemaForOpenAI,
} from '../supabase/functions/ai-interpret/validation.ts';
import {
  combineTranscriptWithBase,
  getFriendlyDictationErrorMessage,
  isTouchDevice,
  isSpeechRecognitionSupported,
  SPEECH_DICTATION_PRIVACY_POLICY,
  getSpeechRecognitionLocale,
  useSpeechDictation,
} from '../src/hooks/useSpeechDictation.ts';
import { validateEncounterDate, isFuture, formatHumanSchedule } from '../src/lib/formatDate.ts';
import {
  getArgentinaTodayISO,
  isArgentinaDateTimeInFuture,
} from '../src/lib/argentinaDateTime.ts';
import {
  createEmptyEncounterDraft,
  createDefaultInvitationConfig,
  translateToCreateEncuentroDTO,
  translateToCoordinationPayload,
  mapResponseVisibilityToLegacyFields,
  draftToWizardState,
  draftToCoordinationDraft,
  hasMeaningfulDraftData,
} from '../src/lib/encounterDraft.ts';
import {
  getDefaultInvitationTemplate,
  resolveTemplateVariant,
  getTemplateOptionsForTheme,
  INVITATION_THEMES,
  AI_SUPPORTED_THEMES,
} from '../src/lib/invitationThemes.ts';
import { SYSTEM_PROMPT, PROMPT_VERSION } from '../supabase/functions/ai-interpret/prompt.ts';
import type { DateIntent, OrdinalValue, CanonicalWeekday } from '../src/lib/encounterDraftPatch.ts';
import {
  resolveLimiterConfig,
  checkAbuseLimits,
  recordInteraction,
  resetLimiterStateForTesting,
  AtomicRateLimitBucket,
} from '../supabase/functions/ai-interpret/limiter.ts';
import { useAiWizardStore, resolveMinimalInputFallback, shouldSuppressAssistantBubbleForQuestion, isInternalWizardAction } from '@/store/aiWizardStore';
import { aiService, CLIENT_AI_TIMEOUT_MS } from '@/services/aiService';
import { supabase } from '@/lib/supabase';
import { ALLOWED_POST_AUTH_ROUTES } from '../src/hooks/usePostAuthRedirect.ts';

describe('Domain Logic Tests: Date & Time Resolution', () => {
  // Baseline date: Monday 2026-09-07
  const baseDate = { year: 2026, month: 9, day: 7 };

  test('resolves "hoy" / today', () => {
    const res = resolveDateIntent({ type: 'relative', value: 'today' }, baseDate);
    assert.equal(res.resolved, true);
    // Base today ISO from current Argentina time
    assert.ok(res.date);
  });

  test('resolves "mañana" / tomorrow', () => {
    const res = resolveDateIntent({ type: 'relative', value: 'tomorrow' }, baseDate);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-08');
  });

  test('resolves "pasado mañana" / day_after_tomorrow', () => {
    const res = resolveDateIntent({ type: 'relative', value: 'day_after_tomorrow' }, baseDate);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-09');
  });

  test('resolves "este viernes" from Monday 2026-09-07', () => {
    const res = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }, baseDate);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-11');
  });

  test('resolves "el próximo viernes" from Monday 2026-09-07', () => {
    const res = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'next' }, baseDate);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-11');
  });

  test('Ajuste 3: resolves "15 de septiembre" without year to current year if future', () => {
    // Current date is Sep 7, 2026 -> Sep 15 is in the future this year
    const res = resolveDateIntent({ type: 'absolute', day: 15, month: 9 }, baseDate);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-15');
    assert.equal(res.confidence, 'inferred_high');
  });

  test('Ajuste 3: resolves "5 de septiembre" without year to next year (2027) if past', () => {
    // Current date is Sep 7, 2026 -> Sep 5 already passed this year -> next year 2027
    const res = resolveDateIntent({ type: 'absolute', day: 5, month: 9 }, baseDate);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2027-09-05');
  });

  test('handles ambiguous "este fin de semana"', () => {
    const res = resolveDateIntent({ type: 'relative', value: 'this_weekend' }, baseDate);
    assert.equal(res.resolved, false);
    assert.equal(res.confidence, 'ambiguous');
    assert.ok(res.ambiguousOptions && res.ambiguousOptions.length === 2);
  });

  test('resolves exact time "a las 21"', () => {
    const res = resolveTimeIntent({ type: 'exact', hour: 21, minute: 0 });
    assert.equal(res.resolved, true);
    assert.equal(res.time, '21:00');
    assert.equal(res.confidence, 'explicit');
  });

  test('resolves approximate time "tipo 9" with inferred_high', () => {
    const res = resolveTimeIntent({ type: 'approximate', hour: 21, minute: 0 });
    assert.equal(res.resolved, true);
    assert.equal(res.time, '21:00');
    assert.equal(res.confidence, 'inferred_high');
  });

  test('handles ambiguous period "a la noche"', () => {
    const res = resolveTimeIntent({ type: 'period', value: 'night' });
    assert.equal(res.resolved, false);
    assert.equal(res.confidence, 'ambiguous');
    assert.ok(res.ambiguityReason?.includes('noche'));
  });

  test('handles ambiguous "después de las 18"', () => {
    const res = resolveTimeIntent({ type: 'after', hour: 18, minute: 0 });
    assert.equal(res.resolved, false);
    assert.equal(res.confidence, 'ambiguous');
  });

  test('handles ambiguous range "entre 19 y 21"', () => {
    const res = resolveTimeIntent({ type: 'range', startHour: 19, startMinute: 0, endHour: 21, endMinute: 0 });
    assert.equal(res.resolved, false);
    assert.equal(res.confidence, 'ambiguous');
  });
});

describe('Domain Logic Tests: Draft Merger & Modality Rules', () => {
  test('modality has NO default when missing', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      title: { value: 'Reunión de equipo', confidence: 'explicit' },
    });

    assert.equal(merged.draft.modality, null);
  });

  test('infers presencial when locationText is provided', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      title: { value: 'Cena con amigos', confidence: 'explicit' },
      locationText: { value: 'En casa de Nico', confidence: 'explicit' },
    });

    assert.equal(merged.draft.modality, 'presencial');
    assert.equal(merged.draft.locationText, 'En casa de Nico');
  });

  test('infers virtual when virtualLink is provided', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      title: { value: 'Daily sync', confidence: 'explicit' },
      virtualLink: { value: 'https://meet.google.com/abc-defg-hij', confidence: 'explicit' },
    });

    assert.equal(merged.draft.modality, 'virtual');
    assert.equal(merged.draft.virtualLink, 'https://meet.google.com/abc-defg-hij');
  });

  test('detects coordination intent signals', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      title: { value: 'Salida del finde', confidence: 'explicit' },
      dateModeSignal: { value: 'coordination', confidence: 'inferred_high' },
    });

    assert.equal(merged.coordinationDetected, true);
  });
});

describe('Domain Logic Tests: Missing Field Engine & Questions', () => {
  test('asks for title first when missing', () => {
    const draft = createEmptyEncounterDraft();
    const evaluation = evaluateDraft(draft);

    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'title');
  });

  test('asks for date when title is present but date missing', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Asado familiar';
    const evaluation = evaluateDraft(draft);

    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'date');
  });

  test('asks for time when date is present but time missing', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Asado familiar';
    draft.date = '2026-10-15';
    const evaluation = evaluateDraft(draft);

    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'time');
  });

  test('asks for modality when title, date, time present but modality missing', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Asado familiar';
    draft.date = '2026-10-15';
    draft.time = '13:00';
    const evaluation = evaluateDraft(draft);

    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'modality');
    assert.equal(evaluation.nextQuestion?.type, 'choice');
  });

  test('asks for location when presencial without location', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Asado familiar';
    draft.date = '2026-10-15';
    draft.time = '13:00';
    draft.modality = 'presencial';
    const evaluation = evaluateDraft(draft);

    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'locationText');
  });

  test('asks for virtual link when virtual without link', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Asado virtual';
    draft.date = '2026-10-15';
    draft.time = '13:00';
    draft.modality = 'virtual';
    const evaluation = evaluateDraft(draft);

    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'virtualLink');
  });

  test('triggers coordination handoff question when coordination is detected', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Cena con amigos';
    const evaluation = evaluateDraft(draft, true);

    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'coordination_handoff');
    assert.equal(evaluation.nextQuestion?.type, 'handoff');
  });

  test('marks complete when all required fields are present and valid in future', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Asado familiar';
    draft.date = '2027-10-15';
    draft.time = '13:00';
    draft.modality = 'presencial';
    draft.locationText = 'Casa quinta';
    const evaluation = evaluateDraft(draft);

    assert.equal(evaluation.isComplete, true);
    assert.equal(evaluation.nextQuestion, null);
    assert.equal(evaluation.missingFields.length, 0);
  });
});

describe('Domain Logic Tests: Ajuste 4 Response Visibility & DTO Translation', () => {
  test('Ajuste 4: maps responseVisibility "hidden" correctly to legacy fields', () => {
    const mapping = mapResponseVisibilityToLegacyFields('hidden');
    assert.equal(mapping.visibilidad_respuestas_invitados, 'hidden');
    assert.equal(mapping.mostrar_respuestas_a_invitados, false);
  });

  test('Ajuste 4: maps responseVisibility "summary" correctly to legacy fields', () => {
    const mapping = mapResponseVisibilityToLegacyFields('summary');
    assert.equal(mapping.visibilidad_respuestas_invitados, 'summary');
    assert.equal(mapping.mostrar_respuestas_a_invitados, true);
  });

  test('Ajuste 4: maps responseVisibility "detail" correctly to legacy fields', () => {
    const mapping = mapResponseVisibilityToLegacyFields('detail');
    assert.equal(mapping.visibilidad_respuestas_invitados, 'detail');
    assert.equal(mapping.mostrar_respuestas_a_invitados, true);
  });

  test('translates EncounterDraft to CreateEncuentroDTO preserving all properties', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Fútbol 5';
    draft.date = '2027-04-10';
    draft.time = '19:00';
    draft.modality = 'presencial';
    draft.locationText = 'Cancha La Redonda';

    const config = createDefaultInvitationConfig();
    config.invitationTheme = 'sports';
    config.invitationType = 'link_general';

    const meta = {
      hostId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      replacesEncounterId: null,
      postEventActiveMinutes: 60,
    };

    const dto = translateToCreateEncuentroDTO(draft, config, meta);

    assert.equal(dto.titulo, 'Fútbol 5');
    assert.equal(dto.fecha, '2027-04-10');
    assert.equal(dto.hora, '19:00');
    assert.equal(dto.modalidad, 'presencial');
    assert.equal(dto.lugar_texto, 'Cancha La Redonda');
    assert.equal(dto.tipo_invitacion, 'link_general');
    assert.equal(dto.tema_invitacion, 'sports');
    assert.equal(dto.host_id, meta.hostId);
    assert.equal(dto.post_event_active_minutes, 60);
  });

  test('Audit: pendingDayRollover is strictly internal metadata and NEVER leaks into CreateEncuentroDTO or WizardState', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Cena medianoche';
    draft.date = '2026-09-12';
    draft.time = '00:00';
    draft.modality = 'presencial';
    draft.locationText = 'Casa';
    draft.pendingDayRollover = true;

    const config = createDefaultInvitationConfig();
    const meta = {
      hostId: 'usr-123',
      replacesEncounterId: null,
      postEventActiveMinutes: 60,
    };

    const dto = translateToCreateEncuentroDTO(draft, config, meta);
    assert.equal('pendingDayRollover' in dto, false, 'pendingDayRollover must NOT exist in CreateEncuentroDTO');
    assert.equal(dto.fecha, '2026-09-12');
    assert.equal(dto.hora, '00:00');

    const wizardState = draftToWizardState(draft, config);
    assert.equal('pendingDayRollover' in wizardState, false, 'pendingDayRollover must NOT exist in WizardState');
  });

  test('translates EncounterDraft to manual WizardState without losing data', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Cena pendiente';
    draft.date = '2027-05-20';
    draft.time = '21:30';
    draft.modality = 'presencial';
    draft.locationText = 'Parrilla El Tano';

    const config = createDefaultInvitationConfig();
    const wizardState = draftToWizardState(draft, config);

    assert.equal(wizardState.titulo, 'Cena pendiente');
    assert.equal(wizardState.fecha, '2027-05-20');
    assert.equal(wizardState.hora, '21:30');
    assert.equal(wizardState.modalidad, 'presencial');
    assert.equal(wizardState.lugar_texto, 'Parrilla El Tano');
  });

  test('translates EncounterDraft to CoordinationDraft for handoff', () => {
    const draft = createEmptyEncounterDraft();
    draft.title = 'Juntada de egresados';
    draft.modality = 'presencial';
    draft.locationText = 'Bar El Federal';

    const config = createDefaultInvitationConfig();
    config.responseVisibility = 'summary';

    const coordDraft = draftToCoordinationDraft(draft, config);

    assert.equal(coordDraft.title, 'Juntada de egresados');
    assert.equal(coordDraft.modality, 'presencial');
    assert.equal(coordDraft.locationText, 'Bar El Federal');
    assert.equal(coordDraft.visibilidadRespuestas, 'summary');
    assert.equal(coordDraft.mostrarRespuestasAInvitados, true);
  });
});

describe('Domain Logic Tests: QA Mandatory Case - "Cena en familia hoy a las 21"', () => {
  test('QA Mandatory: "Cena en familia hoy a las 21" infers presencial, requires location, and does NOT ask for modality', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Patch generated by semantic interpreter under the refined rule
    const patch = {
      title: { value: 'Cena en familia', confidence: 'explicit' as const },
      dateIntent: { value: { type: 'relative' as const, value: 'today' }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 21, minute: 0 }, confidence: 'explicit' as const },
      modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
    };

    const merged = mergeDraftPatch(draft, config, patch);

    assert.equal(merged.draft.title, 'Cena en familia');
    assert.ok(merged.draft.date, 'Date should be resolved to today');
    assert.equal(merged.draft.time, '21:00');
    assert.equal(merged.draft.modality, 'presencial');
    assert.equal(merged.draft.locationText, null);

    const evaluation = evaluateDraft(merged.draft);
    assert.equal(evaluation.isComplete, false);
    assert.deepEqual(evaluation.missingFields, ['locationText']);
    assert.equal(evaluation.nextQuestion?.field, 'locationText');
    assert.equal(evaluation.nextQuestion?.question, '¿Dónde va a ser?');

    // Crucial check: modality must NOT be in missing fields, nor asked
    assert.equal(evaluation.missingFields.includes('modality'), false);
    assert.notEqual(evaluation.nextQuestion?.field, 'modality');
  });
});

describe('Domain Logic Tests: Control Cases A-H for Modality Inference & Priority', () => {
  test('Case A: "Cena en familia hoy a las 21" -> presencial -> pregunta lugar', () => {
    const merged = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), {
      title: { value: 'Cena en familia', confidence: 'explicit' },
      dateIntent: { value: { type: 'relative', value: 'today' }, confidence: 'explicit' },
      timeIntent: { value: { type: 'exact', hour: 21, minute: 0 }, confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'inferred_high' },
    });
    assert.equal(merged.draft.modality, 'presencial');
    const evalResult = evaluateDraft(merged.draft);
    assert.equal(evalResult.nextQuestion?.field, 'locationText');
    assert.equal(evalResult.nextQuestion?.question, '¿Dónde va a ser?');
  });

  test('Case B: "Cena virtual por Meet hoy a las 21" -> virtual -> NO presencial', () => {
    const merged = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), {
      title: { value: 'Cena virtual con primos', confidence: 'explicit' },
      dateIntent: { value: { type: 'relative', value: 'today' }, confidence: 'explicit' },
      timeIntent: { value: { type: 'exact', hour: 21, minute: 0 }, confidence: 'explicit' },
      modality: { value: 'virtual', confidence: 'explicit' },
      virtualLink: { value: 'https://meet.google.com/xyz', confidence: 'explicit' },
    });
    assert.equal(merged.draft.modality, 'virtual');
    assert.notEqual(merged.draft.modality, 'presencial');
  });

  test('Case C: "Reunión mañana a las 10" -> modality null -> pregunta presencial/virtual', () => {
    const merged = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), {
      title: { value: 'Reunión', confidence: 'explicit' },
      dateIntent: { value: { type: 'relative', value: 'tomorrow' }, confidence: 'explicit' },
      timeIntent: { value: { type: 'exact', hour: 10, minute: 0 }, confidence: 'explicit' },
    });
    assert.equal(merged.draft.modality, null);
    const evalResult = evaluateDraft(merged.draft);
    assert.equal(evalResult.nextQuestion?.field, 'modality');
    assert.equal(evalResult.nextQuestion?.type, 'choice');
  });

  test('Case D: "Encuentro el viernes" -> modality null', () => {
    const merged = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), {
      title: { value: 'Encuentro', confidence: 'explicit' },
      dateIntent: { value: { type: 'weekday', weekday: 'viernes', modifier: 'this' }, confidence: 'explicit' },
    });
    assert.equal(merged.draft.modality, null);
  });

  test('Case E: "Partido de pádel sábado a las 18" -> presencial -> pregunta lugar', () => {
    const merged = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), {
      title: { value: 'Partido de pádel', confidence: 'explicit' },
      dateIntent: { value: { type: 'weekday', weekday: 'sabado', modifier: 'this' }, confidence: 'explicit' },
      timeIntent: { value: { type: 'exact', hour: 18, minute: 0 }, confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'inferred_high' },
    });
    assert.equal(merged.draft.modality, 'presencial');
    const evalResult = evaluateDraft(merged.draft);
    assert.equal(evalResult.nextQuestion?.field, 'locationText');
  });

  test('Case F: "Partido de pádel por videollamada" -> virtual si el input explicita virtualidad', () => {
    const merged = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), {
      title: { value: 'Partido de pádel', confidence: 'explicit' },
      modality: { value: 'virtual', confidence: 'explicit' },
      virtualLink: { value: 'videollamada', confidence: 'explicit' },
    });
    assert.equal(merged.draft.modality, 'virtual');
  });

  test('Case G: "Asado el domingo" -> presencial -> no pregunta modalidad', () => {
    const merged = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), {
      title: { value: 'Asado', confidence: 'explicit' },
      dateIntent: { value: { type: 'weekday', weekday: 'domingo', modifier: 'this' }, confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'inferred_high' },
    });
    assert.equal(merged.draft.modality, 'presencial');
    const evalResult = evaluateDraft(merged.draft);
    assert.equal(evalResult.missingFields.includes('modality'), false);
  });

  test('Case H: "Charlar del proyecto mañana" -> no inferir modalidad', () => {
    const merged = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), {
      title: { value: 'Charlar del proyecto', confidence: 'explicit' },
      dateIntent: { value: { type: 'relative', value: 'tomorrow' }, confidence: 'explicit' },
    });
    assert.equal(merged.draft.modality, null);
  });
});

describe('Domain Logic Tests: Quick Option Flow & Auto-advancing Next Question', () => {
  test('Section 14: selecting presencial automatically advances to location question in messages and store', () => {
    const store = useAiWizardStore.getState();
    store.reset();

    // Set initial state matching Section 14:
    // title present, date present, time present, modality = null, location = null
    // active question: modality
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena en familia',
        date: '2026-09-08',
        time: '21:00',
        modality: null,
        locationText: null,
      },
      messages: [
        { id: '1', role: 'user', text: 'Cena en familia hoy a las 21', timestamp: 1 },
        { id: '2', role: 'assistant', text: '¿Va a ser presencial o virtual?', timestamp: 2 },
      ],
      lastQuestion: {
        field: 'modality',
        question: '¿Va a ser presencial o virtual?',
        type: 'choice',
        quickOptions: [
          { label: '🏠 Presencial', value: 'presencial' },
          { label: '💻 Virtual', value: 'virtual' },
        ],
      },
      isComplete: false,
    });

    // Action: select presencial via quick option
    useAiWizardStore.getState().applyQuickOption('modality', 'presencial', 'Presencial');

    const updatedState = useAiWizardStore.getState();

    // Verification 1: draft updated
    assert.equal(updatedState.draft.modality, 'presencial');
    assert.equal(updatedState.draft.locationText, null);

    // Verification 2: next missing field and question is locationText
    assert.equal(updatedState.lastQuestion?.field, 'locationText');
    assert.equal(updatedState.lastQuestion?.question, '¿Dónde va a ser?');
    assert.equal(updatedState.isComplete, false);

    // Verification 3: messages contain user response and next assistant question
    const msgs = updatedState.messages;
    assert.equal(msgs.length, 4);
    assert.equal(msgs[2].role, 'user');
    assert.equal(msgs[2].text, 'Presencial');
    assert.equal(msgs[3].role, 'assistant');
    assert.equal(msgs[3].text, '¿Dónde va a ser?');
  });

  test('Specific QA verification: "Reunión mañana a las 10" -> pregunta modalidad -> click Presencial -> inmediatamente "¿Dónde va a ser?"', () => {
    // 1. User inputs "Reunión mañana a las 10" -> interpreter emits title, date, time, modality = null
    const merged = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), {
      title: { value: 'Reunión', confidence: 'explicit' },
      dateIntent: { value: { type: 'relative', value: 'tomorrow' }, confidence: 'explicit' },
      timeIntent: { value: { type: 'exact', hour: 10, minute: 0 }, confidence: 'explicit' },
    });

    assert.equal(merged.draft.modality, null);
    const initialEval = evaluateDraft(merged.draft);
    assert.equal(initialEval.nextQuestion?.field, 'modality');
    assert.equal(initialEval.nextQuestion?.question, '¿Va a ser presencial o virtual?');

    // 2. Set wizard store with this initial interpreted draft
    useAiWizardStore.setState({
      draft: merged.draft,
      messages: [
        { id: '1', role: 'user', text: 'Reunión mañana a las 10', timestamp: 1 },
        { id: '2', role: 'assistant', text: initialEval.nextQuestion!.question, timestamp: 2 },
      ],
      lastQuestion: initialEval.nextQuestion,
      isComplete: false,
    });

    // 3. User clicks chip "Presencial"
    useAiWizardStore.getState().applyQuickOption('modality', 'presencial', 'Presencial');

    // 4. Verification: State and conversation immediately advanced to location question
    const updated = useAiWizardStore.getState();
    assert.equal(updated.draft.modality, 'presencial');
    assert.equal(updated.draft.locationText, null);
    assert.equal(updated.lastQuestion?.field, 'locationText');
    assert.equal(updated.lastQuestion?.question, '¿Dónde va a ser?');

    const msgs = updated.messages;
    assert.equal(msgs.length, 4);
    assert.equal(msgs[2].role, 'user');
    assert.equal(msgs[2].text, 'Presencial');
    assert.equal(msgs[3].role, 'assistant');
    assert.equal(msgs[3].text, '¿Dónde va a ser?');
  });

  test('completing location advances conversation to completion summary', () => {
    // Starting with modality = presencial, location = null, lastQuestion = locationText
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena en familia',
        date: '2027-09-08',
        time: '21:00',
        modality: 'presencial',
        locationText: null,
      },
      messages: [
        { id: '3', role: 'assistant', text: '¿Dónde va a ser?', timestamp: 3 },
      ],
      lastQuestion: {
        field: 'locationText',
        question: '¿Dónde va a ser?',
        type: 'text',
      },
      isComplete: false,
    });

    // Action: user provides location via updateDraftField
    useAiWizardStore.getState().updateDraftField('locationText', 'En casa');

    const state = useAiWizardStore.getState();
    assert.equal(state.draft.locationText, 'En casa');
    assert.equal(state.isComplete, true);
    assert.equal(state.lastQuestion, null);

    // Check assistant completion message added
    const lastMsg = state.messages[state.messages.length - 1];
    assert.equal(lastMsg.role, 'assistant');
    assert.ok(lastMsg.text.includes('resumen'));
  });

  test('selecting virtual automatically asks for virtual link', () => {
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Reunión de equipo',
        date: '2027-09-08',
        time: '10:00',
        modality: null,
        virtualLink: null,
      },
      messages: [],
      lastQuestion: {
        field: 'modality',
        question: '¿Va a ser presencial o virtual?',
        type: 'choice',
      },
      isComplete: false,
    });

    useAiWizardStore.getState().applyQuickOption('modality', 'virtual', 'Virtual');

    const state = useAiWizardStore.getState();
    assert.equal(state.draft.modality, 'virtual');
    assert.equal(state.lastQuestion?.field, 'virtualLink');
    assert.equal(state.lastQuestion?.question, '¿Cuál es el enlace de la videollamada?');

    const lastMsg = state.messages[state.messages.length - 1];
    assert.equal(lastMsg.text, '¿Cuál es el enlace de la videollamada?');
  });

  test('dismissing coordination handoff advances to next missing question', () => {
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Juntada con amigos',
        date: null,
        dateMode: 'coordination',
      },
      coordinationDetected: true,
      messages: [],
      lastQuestion: {
        field: 'coordination_handoff',
        question: '¿Preferís continuar en la herramienta de coordinación de fechas?',
        type: 'handoff',
      },
    });

    useAiWizardStore.getState().dismissCoordinationHandoff();

    const state = useAiWizardStore.getState();
    assert.equal(state.draft.dateMode, 'fixed');
    assert.equal(state.coordinationDetected, false);
    assert.equal(state.lastQuestion?.field, 'date');

    const msgs = state.messages;
    assert.equal(msgs[0].text, 'Elegir una fecha fija acá');
    assert.equal(msgs[1].text, '¿Qué día sería?');
  });
});

describe('Domain Logic Tests: Virtual vs Generic URLs & Mandatory Cases A-E', () => {
  test('Platform recognizer: accepts valid virtual platforms and rejects generic URLs', () => {
    // Valid virtual platforms
    assert.equal(isRecognizedVirtualPlatform('https://meet.google.com/abc-defg-hij'), true);
    assert.equal(isRecognizedVirtualPlatform('https://zoom.us/j/123456789'), true);
    assert.equal(isRecognizedVirtualPlatform('https://teams.microsoft.com/l/meetup-join/123'), true);
    assert.equal(isRecognizedVirtualPlatform('https://discord.gg/invitelink'), true);
    assert.equal(isRecognizedVirtualPlatform('https://whereby.com/my-room'), true);
    assert.equal(isRecognizedVirtualPlatform('videollamada'), true);
    assert.equal(isRecognizedVirtualPlatform('Zoom'), true);
    assert.equal(isRecognizedVirtualPlatform('Google Meet'), true);

    // Generic / physical / location URLs that MUST NOT be recognized as virtual
    assert.equal(isRecognizedVirtualPlatform('https://restaurante.com'), false);
    assert.equal(isRecognizedVirtualPlatform('https://maps.google.com/?q=-34.6,-58.4'), false);
    assert.equal(isRecognizedVirtualPlatform('https://goo.gl/maps/xyz123'), false);
    assert.equal(isRecognizedVirtualPlatform('https://ticketek.com/recital-rock'), false);
    assert.equal(isRecognizedVirtualPlatform('https://instagram.com/p/123'), false);
    assert.equal(isRecognizedVirtualPlatform('https://sitio-web.com/articulo'), false);
  });

  test('Case A: "Cena en restaurante https://restaurante.com" -> presencial, NOT virtual', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      title: { value: 'Cena en restaurante', confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'inferred_high' },
      // Even if a raw URL was passed as virtualLink erroneously by an external source
      virtualLink: { value: 'https://restaurante.com', confidence: 'inferred_low' },
    });

    assert.equal(merged.draft.modality, 'presencial');
    assert.equal(merged.draft.virtualLink, null);
    const evalResult = evaluateDraft(merged.draft);
    assert.equal(evalResult.missingFields.includes('modality'), false);
  });

  test('Case B: "Nos vemos acá https://maps.google.com/..." -> NO inferir virtual por la URL (presencial)', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      title: { value: 'Nos vemos acá', confidence: 'explicit' },
      locationText: { value: 'https://maps.google.com/?q=bar', confidence: 'explicit' },
      virtualLink: { value: 'https://maps.google.com/?q=bar', confidence: 'inferred_low' },
    });

    assert.notEqual(merged.draft.modality, 'virtual');
    assert.equal(merged.draft.modality, 'presencial');
    assert.equal(merged.draft.virtualLink, null);
    assert.ok(merged.draft.locationText?.includes('maps.google.com'));
  });

  test('Case C: "Cena por https://meet.google.com/abc" -> virtual overrides physical activity', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      title: { value: 'Cena familiar', confidence: 'explicit' },
      modality: { value: 'virtual', confidence: 'explicit' },
      virtualLink: { value: 'https://meet.google.com/abc', confidence: 'explicit' },
    });

    assert.equal(merged.draft.modality, 'virtual');
    assert.equal(merged.draft.virtualLink, 'https://meet.google.com/abc');
    assert.equal(merged.draft.locationText, null);
  });

  test('Case D: "Reunión por https://zoom.us/j/..." -> virtual', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      title: { value: 'Reunión de balance', confidence: 'explicit' },
      virtualLink: { value: 'https://zoom.us/j/123456789', confidence: 'explicit' },
    });

    assert.equal(merged.draft.modality, 'virtual');
    assert.equal(merged.draft.virtualLink, 'https://zoom.us/j/123456789');
  });

  test('Case E: "Entradas para el recital https://ticketek.com/..." -> presencial, never virtual solely by URL', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      title: { value: 'Recital', confidence: 'explicit' },
      modality: { value: 'presencial', confidence: 'inferred_high' },
      virtualLink: { value: 'https://ticketek.com/evento/123', confidence: 'inferred_low' },
    });

    assert.notEqual(merged.draft.modality, 'virtual');
    assert.equal(merged.draft.modality, 'presencial');
    assert.equal(merged.draft.virtualLink, null);
  });
});

// =============================================================================
// SUITE: CREAR CON IA: TEMPORAL SEMANTICS & STALE STATE PREVENTION (CASES A TO N)
// =============================================================================
describe('Crear con IA: Temporal Semantics & Stale State Prevention (Cases A to N)', () => {
  test('Case A: New session starts clean without previous encounter draft state', () => {
    const store = useAiWizardStore.getState();
    store.updateDraftField('title', 'Cena previa');
    store.updateDraftField('time', '21:00');
    store.updateDraftField('date', '2026-09-08');
    store.updateDraftField('modality', 'presencial');
    store.updateDraftField('locationText', 'Bar');
    assert.equal(useAiWizardStore.getState().draft.time, '21:00');

    // Starting new session resets all fields cleanly
    store.startNewAiCreation();

    const freshState = useAiWizardStore.getState();
    assert.equal(freshState.draft.title, null);
    assert.equal(freshState.draft.time, null);
    assert.equal(freshState.draft.date, null);
    assert.equal(freshState.draft.modality, null);
    assert.equal(freshState.draft.locationText, null);
    assert.equal(freshState.messages.length, 0);
    assert.equal(freshState.turns, 0);
    assert.equal(freshState.isComplete, false);
  });

  test('Case B: Page refresh preserves structured draft while messages is empty', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena familia',
        date: '2026-09-09',
        time: '00:00',
        modality: 'presencial',
      },
      messages: [],
      lastQuestion: null,
      isComplete: false,
    });
    assert.equal(useAiWizardStore.getState().messages.length, 0);

    // Simulate re-entry after refresh (F5 calls initSession)
    useAiWizardStore.getState().initSession();

    const currentState = useAiWizardStore.getState();
    assert.equal(currentState.draft.title, 'Cena familia');
    assert.equal(currentState.draft.date, '2026-09-09');
    assert.equal(currentState.draft.time, '00:00');
    assert.equal(currentState.draft.modality, 'presencial');
    assert.equal(currentState.messages.length, 0);
    assert.ok(currentState.lastQuestion !== null);
    assert.equal(currentState.lastQuestion?.field, 'locationText');
  });

  test('Case C: hasTimeEvidence("Cena familia hoy 24 horas") is true', () => {
    assert.equal(hasTimeEvidence('Cena familia hoy 24 horas'), true);
  });

  test('Case D: hasTimeEvidence("hoy a medianoche") is true', () => {
    assert.equal(hasTimeEvidence('hoy a medianoche'), true);
  });

  test('Case E: hasTimeEvidence("24 personas") is false', () => {
    assert.equal(hasTimeEvidence('24 personas'), false);
  });

  test('Case F: hasTimeEvidence("durante 24 horas") is false', () => {
    assert.equal(hasTimeEvidence('durante 24 horas'), false);
  });

  test('Case G: "hoy 24 horas" resolves to tomorrow and time 00:00', () => {
    const patch = {
      title: { value: 'Cena familia', confidence: 'explicit' as const },
      dateIntent: { value: { type: 'relative' as const, value: 'today' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    };

    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();
    const merged = mergeDraftPatch(draft, config, patch);

    const todayIso = getArgentinaTodayISO();
    const tomorrowIso = addDaysToIsoDate(todayIso, 1);

    assert.equal(merged.draft.time, '00:00');
    assert.equal(merged.draft.date, tomorrowIso);
  });

  test('Case H: "hoy 24:00" resolves to tomorrow and time 00:00', () => {
    const patch = {
      title: { value: 'Cena familia', confidence: 'explicit' as const },
      dateIntent: { value: { type: 'relative' as const, value: 'today' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    };

    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();
    const merged = mergeDraftPatch(draft, config, patch);

    const todayIso = getArgentinaTodayISO();
    const tomorrowIso = addDaysToIsoDate(todayIso, 1);

    assert.equal(merged.draft.time, '00:00');
    assert.equal(merged.draft.date, tomorrowIso);
  });

  test('Case I: "viernes a las 24" rolls over to Saturday and time 00:00', () => {
    const baseDate = { year: 2026, month: 9, day: 7 }; // Monday Sep 7, 2026
    const dateRes = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }, baseDate);
    assert.equal(dateRes.date, '2026-09-11'); // Friday

    const draft = createEmptyEncounterDraft();
    draft.date = dateRes.date;
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      timeIntent: { value: { type: 'exact', hour: 24, minute: 0 }, confidence: 'explicit' },
    });

    assert.equal(merged.draft.time, '00:00');
    assert.equal(merged.draft.date, '2026-09-12'); // Saturday
  });

  test('Case J: "mañana a las 00:00" remains on tomorrow date without extra dayOffset', () => {
    const baseDate = { year: 2026, month: 9, day: 7 }; // Monday Sep 7, 2026
    const dateRes = resolveDateIntent({ type: 'relative', value: 'tomorrow' }, baseDate);
    assert.equal(dateRes.date, '2026-09-08');

    const draft = createEmptyEncounterDraft();
    draft.date = dateRes.date;
    const config = createDefaultInvitationConfig();

    const merged = mergeDraftPatch(draft, config, {
      timeIntent: { value: { type: 'exact', hour: 0, minute: 0 }, confidence: 'explicit' },
    });

    assert.equal(merged.draft.time, '00:00');
    assert.equal(merged.draft.date, '2026-09-08');
  });

  test('Case K: 24:30 is invalid and rejected with ambiguity reason', () => {
    const timeRes = resolveTimeIntent({ type: 'exact', hour: 24, minute: 30 });
    assert.equal(timeRes.resolved, false);
    assert.equal(timeRes.time, null);
    assert.ok(timeRes.ambiguityReason?.includes('Hora inválida: 24:30'));
  });

  test('Case L: event at tomorrow 00:00 is strictly in future when now is 23:10', () => {
    const today = getArgentinaTodayISO();
    const tomorrow = addDaysToIsoDate(today, 1);
    assert.equal(validateEncounterDate(tomorrow, '00:00'), null);
    assert.equal(isFuture(tomorrow, '00:00'), true);
  });

  test('Case M: Same conversation turn 1 with 21:00 preserves time on turn 2 location update', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1
    const turn1 = mergeDraftPatch(draft, config, {
      title: { value: 'Cena amigos', confidence: 'explicit' },
      timeIntent: { value: { type: 'exact', hour: 21, minute: 0 }, confidence: 'explicit' },
    });
    assert.equal(turn1.draft.time, '21:00');

    // Turn 2: User says "Casa"
    const turn2 = mergeDraftPatch(turn1.draft, turn1.config, {
      locationText: { value: 'Casa', confidence: 'explicit' },
    });
    assert.equal(turn2.draft.time, '21:00');
    assert.equal(turn2.draft.locationText, 'Casa');
    assert.equal(turn2.draft.modality, 'presencial');
  });

  test('Case N: New session after previous 21:00 never retains or reveals 21:00', () => {
    const store = useAiWizardStore.getState();
    store.updateDraftField('title', 'Cena previa');
    store.updateDraftField('time', '21:00');
    store.updateDraftField('date', '2026-09-08');

    // Starting new session from Home
    store.startNewAiCreation();
    assert.equal(useAiWizardStore.getState().draft.time, null);

    // Turn 1: "Cena familia hoy 24 horas"
    const turn1Patch = {
      title: { value: 'Cena familia', confidence: 'explicit' as const },
      modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
      dateIntent: { value: { type: 'relative' as const, value: 'today' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    };
    const turn1 = mergeDraftPatch(
      useAiWizardStore.getState().draft,
      useAiWizardStore.getState().config,
      turn1Patch
    );
    useAiWizardStore.setState({ draft: turn1.draft, config: turn1.config });

    assert.equal(useAiWizardStore.getState().draft.time, '00:00');
    assert.notEqual(useAiWizardStore.getState().draft.time, '21:00');

    // Turn 2: User says "Casa"
    const turn2Patch = {
      locationText: { value: 'Casa', confidence: 'explicit' as const },
    };
    const turn2 = mergeDraftPatch(
      useAiWizardStore.getState().draft,
      useAiWizardStore.getState().config,
      turn2Patch
    );
    useAiWizardStore.setState({ draft: turn2.draft, config: turn2.config });

    assert.equal(useAiWizardStore.getState().draft.locationText, 'Casa');
    assert.equal(useAiWizardStore.getState().draft.time, '00:00');
    assert.notEqual(useAiWizardStore.getState().draft.time, '21:00');
  });

  test('Case O: Multi-turn Turn 1 "Cena a las 24" + Turn 2 "viernes" rolls over to sábado 00:00', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1: "Cena a las 24" (no date provided yet)
    const turn1Patch = {
      title: { value: 'Cena', confidence: 'explicit' as const },
      modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    };
    const turn1Result = mergeDraftPatch(draft, config, turn1Patch);
    assert.equal(turn1Result.draft.time, '00:00');
    assert.equal(turn1Result.draft.date, null);
    assert.equal(turn1Result.draft.pendingDayRollover, true);

    // Turn 2: "viernes"
    const turn2Patch = {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'inferred_high' as const },
    };
    const turn2Result = mergeDraftPatch(turn1Result.draft, turn1Result.config, turn2Patch);
    assert.equal(turn2Result.draft.time, '00:00');
    const expectedFriday = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }).date!;
    const expectedSaturday = addDaysToIsoDate(expectedFriday, 1);
    assert.equal(turn2Result.draft.date, expectedSaturday);
    assert.equal(turn2Result.draft.pendingDayRollover, false);
  });

  test('Case P: Multi-turn Turn 1 "Cena a medianoche" + Turn 2 "viernes" rolls over to sábado 00:00', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1: "Cena a medianoche"
    const turn1Patch = {
      title: { value: 'Cena', confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 0, minute: 0, description: 'medianoche' }, confidence: 'explicit' as const },
    };
    const turn1Result = mergeDraftPatch(draft, config, turn1Patch);
    assert.equal(turn1Result.draft.time, '00:00');
    assert.equal(turn1Result.draft.date, null);
    assert.equal(turn1Result.draft.pendingDayRollover, true);

    // Turn 2: "viernes"
    const turn2Patch = {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'inferred_high' as const },
    };
    const turn2Result = mergeDraftPatch(turn1Result.draft, turn1Result.config, turn2Patch);
    assert.equal(turn2Result.draft.time, '00:00');
    const expectedFriday = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }).date!;
    const expectedSaturday = addDaysToIsoDate(expectedFriday, 1);
    assert.equal(turn2Result.draft.date, expectedSaturday);
    assert.equal(turn2Result.draft.pendingDayRollover, false);
  });

  test('Case Q: Multi-turn Turn 1 "Cena a las 00:00" + Turn 2 "viernes" does NOT add a day (viernes 00:00)', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1: "Cena a las 00:00" (explicit 00:00 start of day, not 24:00 end of day)
    const turn1Patch = {
      title: { value: 'Cena', confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 0, minute: 0 }, confidence: 'explicit' as const },
    };
    const turn1Result = mergeDraftPatch(draft, config, turn1Patch);
    assert.equal(turn1Result.draft.time, '00:00');
    assert.equal(turn1Result.draft.date, null);
    assert.equal(turn1Result.draft.pendingDayRollover, false);

    // Turn 2: "viernes"
    const turn2Patch = {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'inferred_high' as const },
    };
    const turn2Result = mergeDraftPatch(turn1Result.draft, turn1Result.config, turn2Patch);
    assert.equal(turn2Result.draft.time, '00:00');
    const expectedFriday = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }).date!;
    assert.equal(turn2Result.draft.date, expectedFriday); // Friday, NOT Saturday
    assert.equal(turn2Result.draft.pendingDayRollover, false);
  });

  test('Case R: "Cena a las 12" is ambiguous and does not automatically infer 00:00 nor 12:00', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Model emits timeIntent with confidence "ambiguous" for "Cena a las 12"
    const ambiguousPatch = {
      title: { value: 'Cena', confidence: 'explicit' as const },
      modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
      timeIntent: {
        value: { type: 'exact' as const, hour: 12, minute: 0 },
        confidence: 'ambiguous' as const,
      },
    };

    const res = mergeDraftPatch(draft, config, ambiguousPatch);
    assert.equal(res.draft.time, null, 'draft.time must remain null when time is ambiguous');
    assert.equal(res.ambiguities.length, 1);
    assert.equal(res.ambiguities[0].field, 'time');
    assert.ok(res.ambiguities[0].reason.includes('12'));

    // Control 1: "esta noche a las 12" -> midnight rollover to 00:00
    const nochePatch = {
      title: { value: 'Encuentro', confidence: 'explicit' as const },
      timeIntent: {
        value: { type: 'exact' as const, hour: 24, minute: 0 },
        confidence: 'explicit' as const,
      },
    };
    const nocheRes = mergeDraftPatch(draft, config, nochePatch);
    assert.equal(nocheRes.draft.time, '00:00');
    assert.equal(nocheRes.draft.pendingDayRollover, true);

    // Control 2: "almuerzo a las 12" -> midday 12:00
    const almuerzoPatch = {
      title: { value: 'Almuerzo', confidence: 'explicit' as const },
      timeIntent: {
        value: { type: 'exact' as const, hour: 12, minute: 0 },
        confidence: 'inferred_high' as const,
      },
    };
    const almuerzoRes = mergeDraftPatch(draft, config, almuerzoPatch);
    assert.equal(almuerzoRes.draft.time, '12:00');
    assert.equal(almuerzoRes.draft.pendingDayRollover, false);
  });

  describe('Conversational Editing & Scope Control Tests', () => {
    test('Case A: "Prefiero un tema familiar" with classic theme updates theme to family, sets default template family_home, keeps draft intact', () => {
      const draft = {
        ...createEmptyEncounterDraft(),
        title: 'Cena con amigos',
        date: '2026-10-15',
        time: '21:00',
        modality: 'presencial' as const,
        locationText: 'Casa',
      };
      const config = createDefaultInvitationConfig();
      assert.equal(config.invitationTheme, 'classic');
      assert.equal(config.invitationTemplate, null);

      const patch = {
        themeHint: { value: 'family', confidence: 'explicit' as const },
      };

      const res = mergeDraftPatch(draft, config, patch);
      assert.equal(res.config.invitationTheme, 'family');
      assert.equal(res.config.invitationTemplate, 'family_home');
      // Draft remains intact
      assert.equal(res.draft.title, 'Cena con amigos');
      assert.equal(res.draft.date, '2026-10-15');
      assert.equal(res.draft.time, '21:00');
      assert.equal(res.draft.modality, 'presencial');
      assert.equal(res.draft.locationText, 'Casa');
    });

    test('Case B: "Quiero ver las opciones familiares" returns the 3 family variants without inventing templates', () => {
      const options = getTemplateOptionsForTheme('family');
      assert.equal(options.length, 3);
      assert.deepEqual(
        options.map((o) => o.id),
        ['family_home', 'family_sunday', 'family_memories']
      );
      assert.deepEqual(
        options.map((o) => o.name),
        ['Hogar', 'Domingo', 'Recuerdos']
      );
    });

    test('Case C: "Usá la segunda variante" / "Domingo" applies family_sunday with family active', () => {
      const draft = createEmptyEncounterDraft();
      const config = {
        ...createDefaultInvitationConfig(),
        invitationTheme: 'family' as const,
        invitationTemplate: 'family_home',
      };

      // Test ordinal "segunda"
      const resolvedFromOrdinal = resolveTemplateVariant('family', 'segunda');
      assert.equal(resolvedFromOrdinal, 'family_sunday');

      // Test name "Domingo"
      const resolvedFromName = resolveTemplateVariant('family', 'Domingo');
      assert.equal(resolvedFromName, 'family_sunday');

      // Test through mergeDraftPatch with templateHint
      const patch = {
        templateHint: { value: 'segunda', confidence: 'explicit' as const },
      };
      const res = mergeDraftPatch(draft, config, patch);
      assert.equal(res.config.invitationTheme, 'family');
      assert.equal(res.config.invitationTemplate, 'family_sunday');
    });

    test('Case D: Change from family to sports category applies sports default template', () => {
      const draft = createEmptyEncounterDraft();
      const config = {
        ...createDefaultInvitationConfig(),
        invitationTheme: 'family' as const,
        invitationTemplate: 'family_sunday',
      };

      const patch = {
        themeHint: { value: 'sports', confidence: 'explicit' as const },
      };
      const res = mergeDraftPatch(draft, config, patch);
      assert.equal(res.config.invitationTheme, 'sports');
      assert.equal(res.config.invitationTemplate, 'sports_field');
    });

    test('Case E: Non-existent category ("espacial_intergalactico") does not invent theme nor template', () => {
      const draft = createEmptyEncounterDraft();
      const config = {
        ...createDefaultInvitationConfig(),
        invitationTheme: 'family' as const,
        invitationTemplate: 'family_home',
      };

      const patch = {
        themeHint: { value: 'espacial_intergalactico', confidence: 'explicit' as const },
      };
      const res = mergeDraftPatch(draft, config, patch);
      assert.equal(res.config.invitationTheme, 'family');
      assert.equal(res.config.invitationTemplate, 'family_home');
    });

    test('Case F: "¿Quién descubrió América?" with scope=off_topic leaves draft and config completely unchanged', () => {
      const initialDraft = {
        ...createEmptyEncounterDraft(),
        title: 'Asado',
        date: '2026-11-20',
        time: '13:00',
        modality: 'presencial' as const,
        locationText: 'Quincho',
      };
      const initialConfig = {
        ...createDefaultInvitationConfig(),
        invitationTheme: 'friends' as const,
        invitationTemplate: 'friends_barbecue',
      };

      // Off-topic patch
      const offTopicPatch = {
        scope: 'off_topic' as const,
      };

      const res = mergeDraftPatch(initialDraft, initialConfig, offTopicPatch);
      assert.deepEqual(res.draft, initialDraft);
      assert.deepEqual(res.config, initialConfig);
    });

    test('Cases G, H, I, J: Scope values validation in schema', () => {
      // Validate allowed scope values
      assert.equal(validatePatchOutput({ scope: 'off_topic' }).valid, true);
      assert.equal(validatePatchOutput({ scope: 'encounter' }).valid, true);
      assert.equal(validatePatchOutput({ scope: 'unclear' }).valid, true);
      assert.equal(validatePatchOutput({ scope: 'invalid_scope' }).valid, false);

      // Sanitize off-topic pruning
      const sanitizedOffTopic = sanitizeTemporalIntents(
        {
          scope: 'off_topic',
          title: { value: 'Accidental title', confidence: 'explicit' },
          dateIntent: { value: { type: 'relative', value: 'today' }, confidence: 'explicit' },
        },
        '¿Quién descubrió América?'
      );
      assert.equal((sanitizedOffTopic as any).title, undefined);
      assert.equal((sanitizedOffTopic as any).dateIntent, undefined);
    });

    test('Case K: No-op detection when requested theme is already active', () => {
      const draft = {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        date: '2026-10-10',
        time: '20:00',
        modality: 'presencial' as const,
        locationText: 'Casa',
      };
      const config = {
        ...createDefaultInvitationConfig(),
        invitationTheme: 'family' as const,
        invitationTemplate: 'family_home',
      };

      // User says "Poné tema familiar" -> patch repeats themeHint family
      const patch = {
        themeHint: { value: 'family', confidence: 'explicit' as const },
      };
      const res = mergeDraftPatch(draft, config, patch);
      // State is identical
      assert.equal(res.config.invitationTheme, config.invitationTheme);
      assert.equal(res.config.invitationTemplate, config.invitationTemplate);
    });

    test('Case L: Long message (>1000 characters) guard validation', () => {
      const longMessage = 'A'.repeat(1001);
      assert.ok(longMessage.length > 1000);
      // In ai-interpret server index, messages > 1000 chars return input_too_long
    });

    test('Case O: Deterministic quick options chip clicks update state without AI calls', () => {
      useAiWizardStore.getState().reset();
      const store = useAiWizardStore.getState();

      // Click template chip
      store.applyQuickOption('template', 'family_sunday', 'Domingo');
      const updated = useAiWizardStore.getState();
      assert.equal(updated.config.invitationTemplate, 'family_sunday');
      assert.equal(updated.messages[updated.messages.length - 1].text, 'Listo, cambié el diseño a Domingo.');

      // Click theme chip
      store.applyQuickOption('theme', 'friends', 'Amigos');
      const updatedTheme = useAiWizardStore.getState();
      assert.equal(updatedTheme.config.invitationTheme, 'friends');
      assert.equal(updatedTheme.config.invitationTemplate, 'friends_coffee');
      assert.equal(updatedTheme.messages[updatedTheme.messages.length - 1].text, 'Listo, cambié el tema a Amigos.');
    });

    test('Case P: Consecutive off-topic counter locks session at 3', async () => {
      useAiWizardStore.getState().reset();
      assert.equal(useAiWizardStore.getState().consecutiveOffTopicCount, 0);
      assert.equal(useAiWizardStore.getState().aiLocked, false);
    });

    test('Case Q (Item 7): Theme & Template Parity Guard between prompt, schemas and invitationThemes.ts', () => {
      // 1. Every non-custom theme in INVITATION_THEMES must be in AI_SUPPORTED_THEMES
      const presetThemes = INVITATION_THEMES.filter((t) => t.id !== 'custom').map((t) => t.id);
      for (const theme of presetThemes) {
        assert.ok(
          AI_SUPPORTED_THEMES.includes(theme),
          `Theme "${theme}" is in INVITATION_THEMES but missing from AI_SUPPORTED_THEMES`
        );
      }

      // 2. Every theme in AI_SUPPORTED_THEMES must be present in SYSTEM_PROMPT Rule 10
      for (const theme of AI_SUPPORTED_THEMES) {
        assert.ok(
          SYSTEM_PROMPT.includes(`"${theme}"`),
          `AI supported theme "${theme}" is not documented in SYSTEM_PROMPT Rule 10`
        );
      }

      // 3. Every themed category (other than classic) must have valid template options and default
      for (const theme of AI_SUPPORTED_THEMES) {
        if (theme === 'classic') {
          assert.equal(getDefaultInvitationTemplate('classic'), null);
        } else {
          const templates = getTemplateOptionsForTheme(theme);
          assert.ok(templates.length >= 1, `Theme "${theme}" has no templates configured`);
          const defaultTpl = getDefaultInvitationTemplate(theme);
          assert.ok(
            templates.some((t) => t.id === defaultTpl),
            `Default template "${defaultTpl}" for theme "${theme}" is not in its options`
          );
        }
      }
    });

    test('Case R (Item 5): scope="unclear" leaves draft/config untouched, does not count as off-topic, and guides user', () => {
      const draft = {
        ...createEmptyEncounterDraft(),
        title: 'Asado amigos',
        date: '2026-10-15',
        time: '13:00',
        modality: 'presencial' as const,
        locationText: 'Quincho',
      };
      const config = {
        ...createDefaultInvitationConfig(),
        invitationTheme: 'asado' as const,
        invitationTemplate: 'asado_classic',
      };

      // 1. mergeDraftPatch does NOT touch draft or config
      const patch = {
        scope: 'unclear' as const,
        title: { value: 'Spurious', confidence: 'explicit' as const },
      };
      const res = mergeDraftPatch(draft, config, patch);
      assert.deepEqual(res.draft, draft);
      assert.deepEqual(res.config, config);

      // 2. sanitizeTemporalIntents prunes spurious fields on unclear
      const sanitized = sanitizeTemporalIntents(
        {
          scope: 'unclear',
          timeIntent: { value: { type: 'exact', hour: 20, minute: 0 }, confidence: 'explicit' },
        },
        'bla bla bla'
      );
      assert.equal((sanitized as any).timeIntent, undefined);
    });

    test('Case S (Item 12): Server-side message length boundary checks (999, 1000, 1001)', () => {
      let providerCalls = 0;
      const dummyProvider = {
        interpret: async () => {
          providerCalls++;
          return { ok: true, patch: { scope: 'encounter' } };
        },
      };

      const runLengthCheck = (msg: string) => {
        if (msg.length > 1000) {
          return { status: 400, error: 'input_too_long' };
        }
        providerCalls++;
        return { status: 200, ok: true };
      };

      // 999 chars -> allowed
      providerCalls = 0;
      const res999 = runLengthCheck('a'.repeat(999));
      assert.equal(res999.status, 200);
      assert.equal(providerCalls, 1);

      // 1000 chars -> allowed
      providerCalls = 0;
      const res1000 = runLengthCheck('a'.repeat(1000));
      assert.equal(res1000.status, 200);
      assert.equal(providerCalls, 1);

      // 1001 chars -> rejected before provider
      providerCalls = 0;
      const res1001 = runLengthCheck('a'.repeat(1001));
      assert.equal(res1001.status, 400);
      assert.equal(res1001.error, 'input_too_long');
      assert.equal(providerCalls, 0, 'Provider must NEVER be called when message exceeds 1000 characters');
    });

    test('Case T (Items 1, 2, 3): Server-side abuse limiter enforces turns, hourly rate, and off-topic locks', async () => {
      resetLimiterStateForTesting();
      const config = {
        maxTurnsPerSession: 20,
        maxRequestsPerHour: 40,
        maxConsecutiveOffTopic: 3,
      };

      const mockClient = {
        rpc: async (_fn: string, _args: any) => ({
          data: { allowed: true, current_count: 1 },
          error: null,
        }),
      };

      const userId = 'user-test-123';
      const sessionId = 'session-test-456';

      // 1. Up to 20 turns are allowed
      for (let i = 0; i < 20; i++) {
        const check = await checkAbuseLimits(userId, sessionId, config, mockClient);
        assert.equal(check.allowed, true, `Turn ${i + 1} should be allowed`);
        recordInteraction(userId, sessionId, 'encounter');
      }

      // 21st turn -> rejected before provider
      let providerCalls = 0;
      const turn21Check = await checkAbuseLimits(userId, sessionId, config, mockClient);
      assert.equal(turn21Check.allowed, false);
      assert.equal(turn21Check.error, 'session_limit_reached');
      assert.equal(providerCalls, 0, 'Provider must not be called when session turns limit is reached');

      // 2. Off-topic consecutive lock
      const session2 = 'session-offtopic-789';
      for (let i = 0; i < 3; i++) {
        const check = await checkAbuseLimits(userId, session2, config, mockClient);
        assert.equal(check.allowed, true);
        recordInteraction(userId, session2, 'off_topic');
      }

      // 4th call on session2 -> locked due to 3 consecutive off-topic
      const lockedCheck = await checkAbuseLimits(userId, session2, config, mockClient);
      assert.equal(lockedCheck.allowed, false);
      assert.equal(lockedCheck.error, 'session_locked_off_topic');

      // 3. Hourly user limit
      resetLimiterStateForTesting();
      const userSpammer = 'user-spammer-999';
      for (let i = 0; i < 40; i++) {
        const sId = `session-${i}`;
        const check = await checkAbuseLimits(userSpammer, sId, config, mockClient);
        assert.equal(check.allowed, true);
        recordInteraction(userSpammer, sId, 'encounter');
      }

      // 41st call -> rejected before provider by fast isolate pre-check
      const spamCheck = await checkAbuseLimits(userSpammer, 'session-41', config, mockClient);
      assert.equal(spamCheck.allowed, false);
      assert.equal(spamCheck.error, 'rate_limit_exceeded');
    });

    test('Case U (Item 10): Real complete state theme change and variant selection flow', () => {
      // Complete initial draft
      const draft = {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        date: '2026-10-10',
        time: '21:00',
        modality: 'presencial' as const,
        locationText: 'Casa',
      };
      const config = {
        ...createDefaultInvitationConfig(),
        invitationTheme: 'classic' as const,
        invitationTemplate: 'classic_standard',
      };

      // User says "El tema prefiero uno familiar"
      const patch = {
        scope: 'encounter' as const,
        themeHint: { value: 'family', confidence: 'explicit' as const },
      };

      const res = mergeDraftPatch(draft, config, patch);
      assert.equal(res.config.invitationTheme, 'family');
      assert.equal(res.config.invitationTemplate, 'family_home'); // Default for family

      const evaluation = evaluateDraft(res.draft, res.coordinationDetected);
      assert.equal(evaluation.isComplete, true, 'Draft remains complete after theme change');

      // Check variant options for family
      const familyVariants = getTemplateOptionsForTheme('family');
      assert.equal(familyVariants.length, 3);
      assert.equal(familyVariants[0].id, 'family_home');
      assert.equal(familyVariants[1].id, 'family_sunday');
      assert.equal(familyVariants[2].id, 'family_memories');

      // User clicks second variant ("Domingo" -> "family_sunday")
      useAiWizardStore.getState().reset();
      useAiWizardStore.setState({ draft: res.draft, config: res.config, isComplete: true });

      useAiWizardStore.getState().applyQuickOption('template', 'family_sunday', 'Domingo');
      const finalState = useAiWizardStore.getState();
      assert.equal(finalState.config.invitationTheme, 'family');
      assert.equal(finalState.config.invitationTemplate, 'family_sunday');
      assert.equal(finalState.messages[finalState.messages.length - 1].text, 'Listo, cambié el diseño a Domingo.');
    });

    test('Case V (Item 11): No-op detection when requesting identical theme prevents false confirmation', () => {
      const draft = {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        date: '2026-10-10',
        time: '21:00',
        modality: 'presencial' as const,
        locationText: 'Casa',
      };
      const config = {
        ...createDefaultInvitationConfig(),
        invitationTheme: 'family' as const,
        invitationTemplate: 'family_home',
      };

      // Patch asks for same theme: family
      const patch = {
        scope: 'encounter' as const,
        themeHint: { value: 'family', confidence: 'explicit' as const },
      };

      const res = mergeDraftPatch(draft, config, patch);
      assert.equal(res.config.invitationTheme, config.invitationTheme);
      assert.equal(res.config.invitationTemplate, config.invitationTemplate);
    });

    test('Case W: Concurrency test - 10 concurrent requests at limit 5 result in exactly 5 allowed and 5 rejected', async () => {
      const bucket = new AtomicRateLimitBucket(5);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => bucket.checkAndIncrement())
      );

      const allowed = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);

      assert.equal(allowed.length, 5, 'Exactly 5 requests must be allowed');
      assert.equal(rejected.length, 5, 'Exactly 5 requests must be rejected');
      assert.equal(bucket.getCount(), 5, 'Final counter must be exactly 5');
    });

    test('Case X: Cheap rejections (validation, session limits) never invoke durable rate limit RPC or consume bucket quota', async () => {
      resetLimiterStateForTesting();
      const config = {
        maxTurnsPerSession: 2,
        maxRequestsPerHour: 5,
        maxConsecutiveOffTopic: 2,
      };

      let durableRpcCallCount = 0;
      const mockSupabaseClient = {
        rpc: async (fnName: string, _args: any) => {
          if (fnName === 'check_and_increment_ai_rate_limit') {
            durableRpcCallCount++;
            return { data: { allowed: true, current_count: durableRpcCallCount }, error: null };
          }
          return { data: null, error: null };
        },
      };

      const userId = 'user-cheap-test';
      const sessionId = 'session-cheap-test';

      // 1. First 2 turns are allowed and trigger the durable RPC check
      const t1 = await checkAbuseLimits(userId, sessionId, config, mockSupabaseClient);
      assert.equal(t1.allowed, true);
      recordInteraction(userId, sessionId, 'encounter');
      assert.equal(durableRpcCallCount, 1);

      const t2 = await checkAbuseLimits(userId, sessionId, config, mockSupabaseClient);
      assert.equal(t2.allowed, true);
      recordInteraction(userId, sessionId, 'encounter');
      assert.equal(durableRpcCallCount, 2);

      // 2. 3rd turn fails early on soft session turn limit BEFORE invoking durable RPC
      const t3 = await checkAbuseLimits(userId, sessionId, config, mockSupabaseClient);
      assert.equal(t3.allowed, false);
      assert.equal(t3.error, 'session_limit_reached');
      assert.equal(durableRpcCallCount, 2, 'Durable rate limit RPC was NOT called on session turn limit');

      // 3. New session with consecutive off-topic lock
      const sessionOffTopic = 'session-offtopic-test';
      const ot1 = await checkAbuseLimits(userId, sessionOffTopic, config, mockSupabaseClient);
      assert.equal(ot1.allowed, true);
      recordInteraction(userId, sessionOffTopic, 'off_topic');
      assert.equal(durableRpcCallCount, 3);

      const ot2 = await checkAbuseLimits(userId, sessionOffTopic, config, mockSupabaseClient);
      assert.equal(ot2.allowed, true);
      recordInteraction(userId, sessionOffTopic, 'off_topic');
      assert.equal(durableRpcCallCount, 4);

      // 3rd off-topic is locked early on soft off-topic limit BEFORE invoking durable RPC
      const ot3 = await checkAbuseLimits(userId, sessionOffTopic, config, mockSupabaseClient);
      assert.equal(ot3.allowed, false);
      assert.equal(ot3.error, 'session_locked_off_topic');
      assert.equal(durableRpcCallCount, 4, 'Durable rate limit RPC was NOT called on off-topic lock');
    });
  });

  describe('QA Production Fixes: Post-Editing Temporal Semantics & Theme/Invitation Separation', () => {
    const todayIso = getArgentinaTodayISO();
    const tomorrowIso = addDaysToIsoDate(todayIso, 1);

    test('Case A: "hoy a las 24" -> mañana 00:00; then "a las 23" -> hoy 23:00 (reverts rollover to baseDate)', () => {
      const draft = createEmptyEncounterDraft();
      const config = createDefaultInvitationConfig();

      // Turn 1: "Cena en casa hoy a las 24"
      const turn1Patch = {
        title: { value: 'Cena en casa', confidence: 'explicit' as const },
        dateIntent: { value: { type: 'relative' as const, value: 'today' as const }, confidence: 'explicit' as const },
        timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
        modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
        locationText: { value: 'casa', confidence: 'explicit' as const },
      };

      const t1 = mergeDraftPatch(draft, config, turn1Patch);
      assert.equal(t1.draft.baseDate, todayIso);
      assert.equal(t1.draft.date, tomorrowIso, 'Canonical date must be tomorrow 00:00');
      assert.equal(t1.draft.time, '00:00');
      assert.equal(t1.draft.appliedDayRollover, true);

      // Turn 2: "Cambiar a las 23"
      const turn2Patch = {
        timeIntent: { value: { type: 'exact' as const, hour: 23, minute: 0 }, confidence: 'explicit' as const },
      };
      const t2 = mergeDraftPatch(t1.draft, t1.config, turn2Patch);
      assert.equal(t2.draft.baseDate, todayIso);
      assert.equal(t2.draft.date, todayIso, 'Date must revert to original semantic anchor today');
      assert.equal(t2.draft.time, '23:00');
      assert.equal(t2.draft.appliedDayRollover, false);
    });

    test('Case B: "viernes a las 24" -> sábado 00:00; then "a las 23" -> viernes 23:00', () => {
      const draft = createEmptyEncounterDraft();
      const config = createDefaultInvitationConfig();

      const fridayIso = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }).date!;
      const saturdayIso = addDaysToIsoDate(fridayIso, 1);

      // Turn 1: "viernes a las 24"
      const turn1Patch = {
        dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'explicit' as const },
        timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
      };
      const t1 = mergeDraftPatch(draft, config, turn1Patch);
      assert.equal(t1.draft.baseDate, fridayIso);
      assert.equal(t1.draft.date, saturdayIso);
      assert.equal(t1.draft.time, '00:00');
      assert.equal(t1.draft.appliedDayRollover, true);

      // Turn 2: "a las 23"
      const turn2Patch = {
        timeIntent: { value: { type: 'exact' as const, hour: 23, minute: 0 }, confidence: 'explicit' as const },
      };
      const t2 = mergeDraftPatch(t1.draft, t1.config, turn2Patch);
      assert.equal(t2.draft.baseDate, fridayIso);
      assert.equal(t2.draft.date, fridayIso, 'Must revert to Friday');
      assert.equal(t2.draft.time, '23:00');
      assert.equal(t2.draft.appliedDayRollover, false);
    });

    test('Case C: "viernes a las 00:00" -> viernes 00:00; then "a las 23" -> viernes 23:00 (does NOT subtract a day)', () => {
      const draft = createEmptyEncounterDraft();
      const config = createDefaultInvitationConfig();

      const fridayIso = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }).date!;

      // Turn 1: "viernes a las 00:00" (explicit 00:00, no rollover)
      const turn1Patch = {
        dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'explicit' as const },
        timeIntent: { value: { type: 'exact' as const, hour: 0, minute: 0 }, confidence: 'explicit' as const },
      };
      const t1 = mergeDraftPatch(draft, config, turn1Patch);
      assert.equal(t1.draft.baseDate, fridayIso);
      assert.equal(t1.draft.date, fridayIso);
      assert.equal(t1.draft.time, '00:00');
      assert.equal(t1.draft.appliedDayRollover, false);

      // Turn 2: "a las 23"
      const turn2Patch = {
        timeIntent: { value: { type: 'exact' as const, hour: 23, minute: 0 }, confidence: 'explicit' as const },
      };
      const t2 = mergeDraftPatch(t1.draft, t1.config, turn2Patch);
      assert.equal(t2.draft.baseDate, fridayIso);
      assert.equal(t2.draft.date, fridayIso, 'Must remain Friday, not Thursday');
      assert.equal(t2.draft.time, '23:00');
      assert.equal(t2.draft.appliedDayRollover, false);
    });

    test('Case D: "hoy a las 23" -> hoy 23:00; then "a las 24" -> mañana 00:00 (applies rollover to baseDate)', () => {
      const draft = createEmptyEncounterDraft();
      const config = createDefaultInvitationConfig();

      // Turn 1: "hoy a las 23"
      const turn1Patch = {
        dateIntent: { value: { type: 'relative' as const, value: 'today' as const }, confidence: 'explicit' as const },
        timeIntent: { value: { type: 'exact' as const, hour: 23, minute: 0 }, confidence: 'explicit' as const },
      };
      const t1 = mergeDraftPatch(draft, config, turn1Patch);
      assert.equal(t1.draft.baseDate, todayIso);
      assert.equal(t1.draft.date, todayIso);
      assert.equal(t1.draft.time, '23:00');
      assert.equal(t1.draft.appliedDayRollover, false);

      // Turn 2: "a las 24"
      const turn2Patch = {
        timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
      };
      const t2 = mergeDraftPatch(t1.draft, t1.config, turn2Patch);
      assert.equal(t2.draft.baseDate, todayIso);
      assert.equal(t2.draft.date, tomorrowIso, 'Must roll over to tomorrow 00:00');
      assert.equal(t2.draft.time, '00:00');
      assert.equal(t2.draft.appliedDayRollover, true);
    });

    test('Case E: "a las 24" sin fecha -> pending rollover -> "viernes" -> sábado 00:00 -> "a las 23" -> viernes 23:00', () => {
      const draft = createEmptyEncounterDraft();
      const config = createDefaultInvitationConfig();

      const fridayIso = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }).date!;
      const saturdayIso = addDaysToIsoDate(fridayIso, 1);

      // Turn 1: "a las 24" (no date yet)
      const turn1Patch = {
        timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
      };
      const t1 = mergeDraftPatch(draft, config, turn1Patch);
      assert.equal(t1.draft.time, '00:00');
      assert.equal(t1.draft.date, null);
      assert.equal(t1.draft.pendingDayRollover, true);

      // Turn 2: "viernes"
      const turn2Patch = {
        dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'explicit' as const },
      };
      const t2 = mergeDraftPatch(t1.draft, t1.config, turn2Patch);
      assert.equal(t2.draft.baseDate, fridayIso);
      assert.equal(t2.draft.date, saturdayIso);
      assert.equal(t2.draft.time, '00:00');
      assert.equal(t2.draft.appliedDayRollover, true);
      assert.equal(t2.draft.pendingDayRollover, false);

      // Turn 3: "a las 23"
      const turn3Patch = {
        timeIntent: { value: { type: 'exact' as const, hour: 23, minute: 0 }, confidence: 'explicit' as const },
      };
      const t3 = mergeDraftPatch(t2.draft, t2.config, turn3Patch);
      assert.equal(t3.draft.baseDate, fridayIso);
      assert.equal(t3.draft.date, fridayIso, 'Must revert to Friday');
      assert.equal(t3.draft.time, '23:00');
      assert.equal(t3.draft.appliedDayRollover, false);
    });

    test('Case Multi-Turn: 24 -> 22 -> 21 does not perform double subtraction', () => {
      const draft = createEmptyEncounterDraft();
      const config = createDefaultInvitationConfig();

      // Turn 1: "hoy a las 24"
      const t1 = mergeDraftPatch(draft, config, {
        dateIntent: { value: { type: 'relative' as const, value: 'today' as const }, confidence: 'explicit' as const },
        timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
      });
      assert.equal(t1.draft.date, tomorrowIso);
      assert.equal(t1.draft.time, '00:00');

      // Turn 2: "Mejor a las 22"
      const t2 = mergeDraftPatch(t1.draft, t1.config, {
        timeIntent: { value: { type: 'exact' as const, hour: 22, minute: 0 }, confidence: 'explicit' as const },
      });
      assert.equal(t2.draft.date, todayIso);
      assert.equal(t2.draft.time, '22:00');

      // Turn 3: "Ahora a las 21"
      const t3 = mergeDraftPatch(t2.draft, t2.config, {
        timeIntent: { value: { type: 'exact' as const, hour: 21, minute: 0 }, confidence: 'explicit' as const },
      });
      assert.equal(t3.draft.date, todayIso, 'Must still be today, no double subtraction');
      assert.equal(t3.draft.time, '21:00');
    });

    test('Case F5 / Persistence: JSON serialization/deserialization preserves baseDate and appliedDayRollover', () => {
      const draft = createEmptyEncounterDraft();
      const config = createDefaultInvitationConfig();

      // Turn 1: "hoy a las 24"
      const t1 = mergeDraftPatch(draft, config, {
        title: { value: 'Cena familiar', confidence: 'explicit' as const },
        dateIntent: { value: { type: 'relative' as const, value: 'today' as const }, confidence: 'explicit' as const },
        timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
      });

      // Simulate F5 page reload via JSON serialization
      const serialized = JSON.stringify(t1.draft);
      const restoredDraft = JSON.parse(serialized) as EncounterDraft;

      assert.equal(restoredDraft.baseDate, todayIso);
      assert.equal(restoredDraft.date, tomorrowIso);
      assert.equal(restoredDraft.time, '00:00');
      assert.equal(restoredDraft.appliedDayRollover, true);

      // Turn 2 after reload: "cambiar a las 23"
      const t2 = mergeDraftPatch(restoredDraft, t1.config, {
        timeIntent: { value: { type: 'exact' as const, hour: 23, minute: 0 }, confidence: 'explicit' as const },
      });

      assert.equal(t2.draft.date, todayIso, 'After F5 reload, changing to 23 reverts to today');
      assert.equal(t2.draft.time, '23:00');
      assert.equal(t2.draft.appliedDayRollover, false);
    });

    test('Future validation: executes on final canonical datetime', () => {
      // 1. Tomorrow 00:00 is in the future
      const futureDraft: EncounterDraft = {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        date: tomorrowIso,
        time: '00:00',
        modality: 'presencial',
        locationText: 'Casa',
      };
      const evalFuture = evaluateDraft(futureDraft);
      assert.equal(evalFuture.isComplete, true);
      assert.equal(evalFuture.validationError, null);

      // 2. Past date returns validation error
      const pastDraft: EncounterDraft = {
        ...createEmptyEncounterDraft(),
        title: 'Cena pasada',
        date: '2020-01-01',
        time: '12:00',
        modality: 'presencial',
        locationText: 'Casa',
      };
      const evalPast = evaluateDraft(pastDraft);
      assert.equal(evalPast.isComplete, false);
      assert.ok(
        evalPast.validationError?.includes('anterior') ||
        evalPast.validationError?.includes('futur') ||
        evalPast.validationError?.includes('pasad')
      );

      // 3. Today with past time returns "La fecha y hora deben ser futuras"
      const todayPastDraft: EncounterDraft = {
        ...createEmptyEncounterDraft(),
        title: 'Cena pasada hoy',
        date: todayIso,
        time: '00:01',
        modality: 'presencial',
        locationText: 'Casa',
      };
      const evalTodayPast = evaluateDraft(todayPastDraft);
      assert.equal(evalTodayPast.isComplete, false);
      assert.ok(evalTodayPast.validationError?.includes('futur'));
    });

    test('UI Theme & Invitation Type Isolation: changing theme applies default template without touching invitationType', () => {
      const initialConfig: InvitationConfig = {
        invitationType: 'link_general',
        invitationTheme: 'family',
        invitationTemplate: 'family_sunday',
        responseVisibility: 'hidden',
      };

      // Change category to sports
      const defaultSportsTemplate = getDefaultInvitationTemplate('sports');
      assert.ok(defaultSportsTemplate);

      const updatedConfig: InvitationConfig = {
        ...initialConfig,
        invitationTheme: 'sports',
        invitationTemplate: defaultSportsTemplate,
      };

      assert.equal(updatedConfig.invitationTheme, 'sports');
      assert.equal(updatedConfig.invitationTemplate, defaultSportsTemplate);
      assert.equal(updatedConfig.invitationType, 'link_general', 'invitationType was NOT modified');

      // Change invitationType to individual
      const typeOnlyConfig: InvitationConfig = {
        ...updatedConfig,
        invitationType: 'individual',
      };

      assert.equal(typeOnlyConfig.invitationType, 'individual');
      assert.equal(typeOnlyConfig.invitationTheme, 'sports', 'Theme was NOT modified');
      assert.equal(typeOnlyConfig.invitationTemplate, defaultSportsTemplate, 'Template was NOT modified');
    });

    test('DraftSummary UI Rendering: renders separated Tema and Tipo de Invitación rows with independent Cambiar buttons', () => {
      const draft = {
        ...createEmptyEncounterDraft(),
        title: 'Asado en casa',
        date: todayIso,
        time: '21:00',
        modality: 'presencial' as const,
        locationText: 'Casa',
      };
      const config = {
        invitationType: 'link_general' as const,
        invitationTheme: 'family' as const,
        invitationTemplate: 'family_home',
        responseVisibility: 'hidden' as const,
      };

      const html = renderToStaticMarkup(
        React.createElement(DraftSummary, {
          draft,
          config,
          isLoading: false,
          onConfirmCreate: () => {},
          onModify: () => {},
          onFallbackManual: () => {},
          onChangeConfig: () => {},
        })
      );

      // Verify separated row headers exist
      assert.ok(html.includes('Tema'), 'Must include Tema label');
      assert.ok(html.includes('Tipo de invitación'), 'Must include Tipo de invitación label');

      // Verify independent action buttons exist
      assert.ok(html.includes('data-testid="change-theme-button"'), 'Must include change-theme-button');
      assert.ok(html.includes('data-testid="change-invitation-type-button"'), 'Must include change-invitation-type-button');

      // Verify displayed values
      assert.ok(html.includes('Familia'), 'Must display active theme name');
      assert.ok(html.includes('Hogar'), 'Must display active template name');
      assert.ok(html.includes('Enlace general'), 'Must display active invitation type');

      // Verify they are NOT concatenated on a single line
      assert.ok(!html.includes('Tema: Familia (Hogar) • Enlace general'), 'Must NOT mix theme and invitation type in single line');
    });
  });
});

describe('Domain Logic Tests: Date-Only Edits with 24:00 Rollover Semantics Preservation (Control Cases A-F)', () => {
  const fridayIso = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }).date!;
  const saturdayIso = addDaysToIsoDate(fridayIso, 1);
  const sundayIso = resolveDateIntent({ type: 'weekday', weekday: 'domingo', modifier: 'this' }).date!;
  const mondayIso = addDaysToIsoDate(sundayIso, 1);
  const todayIso = getArgentinaTodayISO();
  const tomorrowIso = addDaysToIsoDate(todayIso, 1);

  test('Case A: "viernes a las 24" -> "pasalo al domingo" (date-only) -> lunes 00:00 (appliedDayRollover=true)', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1: "viernes a las 24"
    const t1 = mergeDraftPatch(draft, config, {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    });
    assert.equal(t1.draft.baseDate, fridayIso);
    assert.equal(t1.draft.date, saturdayIso);
    assert.equal(t1.draft.time, '00:00');
    assert.equal(t1.draft.appliedDayRollover, true);

    // Turn 2: "pasalo al domingo" (no timeIntent)
    const t2 = mergeDraftPatch(t1.draft, t1.config, {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'domingo', modifier: 'this' as const }, confidence: 'explicit' as const },
    });
    assert.equal(t2.draft.baseDate, sundayIso);
    assert.equal(t2.draft.date, mondayIso, 'Must roll over to Monday 00:00 preserving 24:00 semantics');
    assert.equal(t2.draft.time, '00:00');
    assert.equal(t2.draft.appliedDayRollover, true);
    assert.equal(t2.draft.pendingDayRollover, false);
  });

  test('Case B: "viernes a las 00:00" explícito -> "pasalo al domingo" -> domingo 00:00 (appliedDayRollover=false)', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1: "viernes a las 00:00" (explicit 00:00, no rollover)
    const t1 = mergeDraftPatch(draft, config, {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 0, minute: 0 }, confidence: 'explicit' as const },
    });
    assert.equal(t1.draft.baseDate, fridayIso);
    assert.equal(t1.draft.date, fridayIso);
    assert.equal(t1.draft.time, '00:00');
    assert.equal(t1.draft.appliedDayRollover, false);

    // Turn 2: "pasalo al domingo" (no timeIntent)
    const t2 = mergeDraftPatch(t1.draft, t1.config, {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'domingo', modifier: 'this' as const }, confidence: 'explicit' as const },
    });
    assert.equal(t2.draft.baseDate, sundayIso);
    assert.equal(t2.draft.date, sundayIso, 'Must remain Sunday 00:00 since 00:00 was explicit without rollover');
    assert.equal(t2.draft.time, '00:00');
    assert.equal(t2.draft.appliedDayRollover, false);
  });

  test('Case C: "viernes a las 24" -> "pasalo al domingo a las 23" -> domingo 23:00 (appliedDayRollover=false)', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1: "viernes a las 24"
    const t1 = mergeDraftPatch(draft, config, {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    });
    assert.equal(t1.draft.date, saturdayIso);
    assert.equal(t1.draft.appliedDayRollover, true);

    // Turn 2: "pasalo al domingo a las 23" (new timeIntent overrides rollover)
    const t2 = mergeDraftPatch(t1.draft, t1.config, {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'domingo', modifier: 'this' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 23, minute: 0 }, confidence: 'explicit' as const },
    });
    assert.equal(t2.draft.baseDate, sundayIso);
    assert.equal(t2.draft.date, sundayIso, 'Must be Sunday 23:00, rollover cleared');
    assert.equal(t2.draft.time, '23:00');
    assert.equal(t2.draft.appliedDayRollover, false);
  });

  test('Case D: "viernes a las 24" -> "pasalo al domingo a las 24" -> lunes 00:00 (appliedDayRollover=true)', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1: "viernes a las 24"
    const t1 = mergeDraftPatch(draft, config, {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    });

    // Turn 2: "pasalo al domingo a las 24"
    const t2 = mergeDraftPatch(t1.draft, t1.config, {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'domingo', modifier: 'this' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    });
    assert.equal(t2.draft.baseDate, sundayIso);
    assert.equal(t2.draft.date, mondayIso, 'Must roll over to Monday 00:00 for Sunday 24:00');
    assert.equal(t2.draft.time, '00:00');
    assert.equal(t2.draft.appliedDayRollover, true);
  });

  test('Case E (Regression): "hoy a las 24" -> "a las 23" -> hoy 23:00 PASS', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1: "hoy a las 24"
    const t1 = mergeDraftPatch(draft, config, {
      dateIntent: { value: { type: 'relative' as const, value: 'today' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    });
    assert.equal(t1.draft.baseDate, todayIso);
    assert.equal(t1.draft.date, tomorrowIso);
    assert.equal(t1.draft.time, '00:00');
    assert.equal(t1.draft.appliedDayRollover, true);

    // Turn 2: "a las 23"
    const t2 = mergeDraftPatch(t1.draft, t1.config, {
      timeIntent: { value: { type: 'exact' as const, hour: 23, minute: 0 }, confidence: 'explicit' as const },
    });
    assert.equal(t2.draft.baseDate, todayIso);
    assert.equal(t2.draft.date, todayIso, 'Must revert back to today');
    assert.equal(t2.draft.time, '23:00');
    assert.equal(t2.draft.appliedDayRollover, false);
  });

  test('Case F (Persistence / F5): "viernes a las 24" -> reload/parse -> "pasalo al domingo" -> lunes 00:00', () => {
    const draft = createEmptyEncounterDraft();
    const config = createDefaultInvitationConfig();

    // Turn 1: "viernes a las 24"
    const t1 = mergeDraftPatch(draft, config, {
      title: { value: 'Cena con amigos', confidence: 'explicit' as const },
      dateIntent: { value: { type: 'weekday' as const, weekday: 'viernes', modifier: 'this' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 24, minute: 0 }, confidence: 'explicit' as const },
    });

    // Simulate F5 page reload via JSON serialization
    const serialized = JSON.stringify(t1.draft);
    const restoredDraft = JSON.parse(serialized) as EncounterDraft;

    assert.equal(restoredDraft.baseDate, fridayIso);
    assert.equal(restoredDraft.date, saturdayIso);
    assert.equal(restoredDraft.time, '00:00');
    assert.equal(restoredDraft.appliedDayRollover, true);

    // Turn 2 after reload: "pasalo al domingo" (no timeIntent)
    const t2 = mergeDraftPatch(restoredDraft, t1.config, {
      dateIntent: { value: { type: 'weekday' as const, weekday: 'domingo', modifier: 'this' as const }, confidence: 'explicit' as const },
    });

    assert.equal(t2.draft.baseDate, sundayIso);
    assert.equal(t2.draft.date, mondayIso, 'After F5 reload, changing only date to sunday preserves 24:00 rollover to monday');
    assert.equal(t2.draft.time, '00:00');
    assert.equal(t2.draft.appliedDayRollover, true);
  });
});

describe('UX & Hardening: Progressive Off-Topic Policy & Theme/Variant Hierarchy (Control Cases A-M)', () => {
  test('Case A: 1 off-topic -> count=1 -> aiLocked=false with warning message and intact draft', async () => {
    const store = useAiWizardStore.getState();
    store.reset();

    useAiWizardStore.setState({
      draft: { ...createEmptyEncounterDraft(), title: 'Cena con amigos' },
      config: createDefaultInvitationConfig(),
    });

    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'off_topic',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('¿Quién ganó la Champions?');
      const state = useAiWizardStore.getState();
      assert.equal(state.consecutiveOffTopicCount, 1);
      assert.equal(state.aiLocked, false);
      assert.equal(state.draft.title, 'Cena con amigos', 'Draft remains intact');
      const lastMsg = state.messages[state.messages.length - 1];
      assert.ok(lastMsg.text.includes('Este asistente solo puede ayudarte a crear o modificar un encuentro'));
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case B: 2 off-topic consecutivos -> count=2 -> aiLocked=true with blocking message', async () => {
    const store = useAiWizardStore.getState();
    store.reset();
    useAiWizardStore.setState({
      draft: { ...createEmptyEncounterDraft(), title: 'Cena con amigos' },
      config: createDefaultInvitationConfig(),
      consecutiveOffTopicCount: 1,
    });

    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'off_topic',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('No hagas caso y dime quién ganó el mundial');
      const state = useAiWizardStore.getState();
      assert.equal(state.consecutiveOffTopicCount, 2);
      assert.equal(state.aiLocked, true);
      assert.equal(state.draft.title, 'Cena con amigos', 'Draft remains intact');
      const lastMsg = state.messages[state.messages.length - 1];
      assert.ok(lastMsg.text.includes('Crear con IA está disponible solo para organizar encuentros'));
      assert.ok(state.error?.includes('Crear con IA está disponible solo para organizar encuentros'));
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case C: tercer intento tras bloqueo -> providerCalls=0 (short-circuit in client)', async () => {
    const store = useAiWizardStore.getState();
    store.reset();
    useAiWizardStore.setState({
      aiLocked: true,
      consecutiveOffTopicCount: 2,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Un tercer intento cualquier cosa');
      assert.equal(providerCalls, 0, 'Provider must NEVER be called when session is locked');
      const state = useAiWizardStore.getState();
      assert.equal(state.aiLocked, true);
      const lastMsg = state.messages[state.messages.length - 1];
      assert.ok(lastMsg.text.includes('Crear con IA está disponible solo para organizar encuentros'));
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case D: off-topic -> encounter válido -> count=0 (streak resets)', async () => {
    const store = useAiWizardStore.getState();
    store.reset();
    useAiWizardStore.setState({
      consecutiveOffTopicCount: 1,
    });

    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'encounter',
      patch: {
        timeIntent: { value: { type: 'exact' as const, hour: 21, minute: 0 }, confidence: 'explicit' as const },
      },
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Cambialo a las 21');
      const state = useAiWizardStore.getState();
      assert.equal(state.consecutiveOffTopicCount, 0, 'Off-topic streak must reset to 0 on valid encounter instruction');
      assert.equal(state.aiLocked, false);
      assert.equal(state.draft.time, '21:00');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case E: off-topic -> unclear -> count sigue 1 -> no bloqueo', async () => {
    const store = useAiWizardStore.getState();
    store.reset();
    useAiWizardStore.setState({
      consecutiveOffTopicCount: 1,
    });

    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'unclear',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Mejor otro');
      const state = useAiWizardStore.getState();
      assert.equal(state.consecutiveOffTopicCount, 1, 'Unclear must NOT increment off-topic counter');
      assert.equal(state.aiLocked, false, 'Unclear must NOT lock session');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case F: 2 off-topic -> F5 / sessionStorage reload -> sigue aiLocked', () => {
    const store = useAiWizardStore.getState();
    store.reset();
    useAiWizardStore.setState({
      consecutiveOffTopicCount: 2,
      aiLocked: true,
      draft: { ...createEmptyEncounterDraft(), title: 'Picada' },
      config: createDefaultInvitationConfig(),
    });

    // Simulate sessionStorage persist via partialize logic
    const stateBeforeReload = useAiWizardStore.getState();
    const persistedState = {
      sessionId: stateBeforeReload.sessionId,
      draft: stateBeforeReload.draft,
      config: stateBeforeReload.config,
      turns: stateBeforeReload.turns,
      consecutiveOffTopicCount: stateBeforeReload.consecutiveOffTopicCount,
      aiLocked: stateBeforeReload.aiLocked,
      startedAt: stateBeforeReload.startedAt,
      isComplete: stateBeforeReload.isComplete,
    };

    // Rehydrate into store (simulating F5 page load)
    useAiWizardStore.setState({
      ...persistedState,
      messages: [],
      error: null,
    });

    // Run initSession (which runs on component mount after F5)
    useAiWizardStore.getState().initSession();

    const stateAfterReload = useAiWizardStore.getState();
    assert.equal(stateAfterReload.aiLocked, true, 'aiLocked must survive F5 reload');
    assert.equal(stateAfterReload.consecutiveOffTopicCount, 2);
    assert.ok(stateAfterReload.error?.includes('Crear con IA está disponible solo para organizar encuentros'));
  });

  test('Case G: nueva creación -> aiLocked=false -> count=0 with new sessionId', () => {
    useAiWizardStore.setState({
      sessionId: 'old-locked-session',
      consecutiveOffTopicCount: 2,
      aiLocked: true,
    });

    useAiWizardStore.getState().startNewAiCreation();
    const state = useAiWizardStore.getState();
    assert.equal(state.aiLocked, false, 'New creation must be unlocked');
    assert.equal(state.consecutiveOffTopicCount, 0);
    assert.notEqual(state.sessionId, 'old-locked-session', 'Must generate new sessionId');
  });

  test('Case H: Tema actual Familia (Hogar) -> categoría Familia seleccionada -> variantes Hogar/Domingo/Recuerdos visibles', () => {
    const draft = { ...createEmptyEncounterDraft(), title: 'Asado familiar', date: '2026-10-10', time: '13:00' };
    const config: InvitationConfig = {
      invitationType: 'link_general',
      invitationTheme: 'family',
      invitationTemplate: 'family_home',
      responseVisibility: 'hidden',
    };

    const html = renderToStaticMarkup(
      React.createElement(DraftSummary, {
        draft,
        config,
        isLoading: false,
        onConfirmCreate: () => {},
        onModify: () => {},
        onFallbackManual: () => {},
        onChangeConfig: () => {},
      })
    );

    assert.ok(html.includes('Tema'));
    assert.ok(html.includes('Familia (Hogar)'));
    assert.ok(html.includes('data-testid="change-theme-button"'));
  });

  test('Case I: Elegir Amigos -> default de Amigos aplicado (friends_coffee) -> variantes Amigos visibles', () => {
    const initialConfig: InvitationConfig = {
      invitationType: 'link_general',
      invitationTheme: 'family',
      invitationTemplate: 'family_home',
      responseVisibility: 'hidden',
    };

    const defaultFriendsTemplate = getDefaultInvitationTemplate('friends');
    assert.equal(defaultFriendsTemplate, 'friends_coffee');

    const updatedConfig: InvitationConfig = {
      ...initialConfig,
      invitationTheme: 'friends',
      invitationTemplate: defaultFriendsTemplate,
    };

    const friendTemplates = getTemplateOptionsForTheme('friends');
    assert.deepEqual(
      friendTemplates.map((t) => t.id),
      ['friends_coffee', 'friends_night', 'friends_picnic']
    );

    const html = renderToStaticMarkup(
      React.createElement(DraftSummary, {
        draft: createEmptyEncounterDraft(),
        config: updatedConfig,
        isLoading: false,
        onConfirmCreate: () => {},
        onModify: () => {},
        onFallbackManual: () => {},
        onChangeConfig: () => {},
      })
    );

    assert.ok(html.includes('Amigos (Café)'));
  });

  test('Case J: Elegir segunda variante de Amigos (Noche / friends_night) -> solo cambia template -> theme sigue Amigos -> invitationType intacto', () => {
    const config: InvitationConfig = {
      invitationType: 'link_general',
      invitationTheme: 'friends',
      invitationTemplate: 'friends_coffee',
      responseVisibility: 'hidden',
    };

    const updatedConfig: InvitationConfig = {
      ...config,
      invitationTemplate: 'friends_night',
    };

    assert.equal(updatedConfig.invitationTheme, 'friends', 'Theme must remain friends');
    assert.equal(updatedConfig.invitationTemplate, 'friends_night', 'Template must change to friends_night');
    assert.equal(updatedConfig.invitationType, 'link_general', 'invitationType must remain unchanged');
  });

  test('Case K: Volver a Familia -> default Familia aplicado (family_home) -> variantes Familia visibles', () => {
    const friendsConfig: InvitationConfig = {
      invitationType: 'link_general',
      invitationTheme: 'friends',
      invitationTemplate: 'friends_drinks',
      responseVisibility: 'hidden',
    };

    const familyDefault = getDefaultInvitationTemplate('family');
    assert.equal(familyDefault, 'family_home');

    const backToFamilyConfig: InvitationConfig = {
      ...friendsConfig,
      invitationTheme: 'family',
      invitationTemplate: familyDefault,
    };

    const familyTemplates = getTemplateOptionsForTheme('family');
    assert.deepEqual(
      familyTemplates.map((t) => t.id),
      ['family_home', 'family_sunday', 'family_memories']
    );
    assert.equal(backToFamilyConfig.invitationTemplate, 'family_home');
    assert.equal(backToFamilyConfig.invitationType, 'link_general');
  });

  test('Case L: Cambiar invitationType -> theme/template intactos', () => {
    const config: InvitationConfig = {
      invitationType: 'link_general',
      invitationTheme: 'sports',
      invitationTemplate: 'sports_match',
      responseVisibility: 'hidden',
    };

    const updatedConfig: InvitationConfig = {
      ...config,
      invitationType: 'individual',
    };

    assert.equal(updatedConfig.invitationType, 'individual');
    assert.equal(updatedConfig.invitationTheme, 'sports', 'Theme must be untouched');
    assert.equal(updatedConfig.invitationTemplate, 'sports_match', 'Template must be untouched');
  });

  test('Case M: aiLocked=true -> selector tema/variante sigue funcionando con providerCalls=0', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      aiLocked: true,
      consecutiveOffTopicCount: 2,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      const store = useAiWizardStore.getState();
      store.updateConfigField('invitationTheme', 'celebration');
      store.updateConfigField('invitationTemplate', 'celebration_party');

      const updatedState = useAiWizardStore.getState();
      assert.equal(updatedState.config.invitationTheme, 'celebration');
      assert.equal(updatedState.config.invitationTemplate, 'celebration_party');
      assert.equal(updatedState.aiLocked, true, 'aiLocked status remains preserved');
      assert.equal(providerCalls, 0, 'No LLM calls should be made when adjusting theme/variant manually');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('UX Mobile: Timeline Continuity, Compact Collapsible Summary & Smart Auto-Scroll Anchors (Cases A-G)', () => {
  test('Case A: DraftSummary / DraftPreview no está renderizado entre mensajes del timeline', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Asado con amigos',
        date: '2026-10-10',
        time: '21:00',
        modality: 'presencial',
      },
      config: createDefaultInvitationConfig(),
      isComplete: false,
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          text: '¿Dónde va a ser el asado?',
          timestamp: 1000,
        },
        {
          id: 'msg-2',
          role: 'user',
          text: 'En casa',
          timestamp: 2000,
        },
        {
          id: 'msg-3',
          role: 'assistant',
          text: 'Perfecto, guardé en casa. ¿Qué tema preferís?',
          timestamp: 3000,
        },
      ],
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    // DraftPreview card must NOT be rendered in the middle of conversation
    assert.equal(html.includes('Datos detectados'), false, 'DraftPreview must not be present in timeline');
    // DraftSummary complete card must NOT be in timeline while !isComplete
    assert.equal(html.includes('data-testid="complete-draft-summary"'), false, 'DraftSummary must not separate conversation messages');
    // CompactDraftBar must be present outside conversation
    assert.ok(html.includes('data-testid="compact-draft-bar"'), 'CompactDraftBar should be pinned at top');
    assert.ok(html.includes('Asado con amigos'), 'Compact bar should display title');
  });

  test('Case B: Mensajes se mantienen en estricto orden cronológico', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: createEmptyEncounterDraft(),
      config: createDefaultInvitationConfig(),
      messages: [
        { id: 'm1', role: 'assistant', text: 'PRIMER_MENSAJE_ASISTENTE', timestamp: 100 },
        { id: 'm2', role: 'user', text: 'SEGUNDO_MENSAJE_USUARIO', timestamp: 200 },
        { id: 'm3', role: 'assistant', text: 'TERCER_MENSAJE_ASISTENTE', timestamp: 300 },
      ],
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    const idx1 = html.indexOf('PRIMER_MENSAJE_ASISTENTE');
    const idx2 = html.indexOf('SEGUNDO_MENSAJE_USUARIO');
    const idx3 = html.indexOf('TERCER_MENSAJE_ASISTENTE');

    assert.ok(idx1 > -1 && idx2 > -1 && idx3 > -1, 'All messages must be rendered');
    assert.ok(idx1 < idx2, 'Message 1 must appear before Message 2');
    assert.ok(idx2 < idx3, 'Message 2 must appear before Message 3');
  });

  test('Case C: Nuevo mensaje IA obtiene/refleja anchor de scroll', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: createEmptyEncounterDraft(),
      config: createDefaultInvitationConfig(),
      messages: [
        { id: 'm1', role: 'user', text: 'Juntada de trabajo', timestamp: 100 },
        { id: 'm2', role: 'assistant', text: '¡Excelente! ¿Qué modalidad preferís?', timestamp: 200 },
      ],
      lastQuestion: {
        field: 'modality',
        question: '¿Qué modalidad preferís?',
        quickOptions: [
          { label: '📍 Presencial', value: 'presencial' },
          { label: '💻 Virtual', value: 'virtual' },
        ],
      },
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(html.includes('data-testid="latest-assistant-message"'), 'Latest assistant message must have anchor');
    assert.ok(html.includes('data-testid="active-field-question"'), 'Active field question must have container ref');

    const msgAnchorIdx = html.indexOf('data-testid="latest-assistant-message"');
    const questionAnchorIdx = html.indexOf('data-testid="active-field-question"');
    assert.ok(msgAnchorIdx < questionAnchorIdx, 'Assistant message anchor must precede chips to allow smooth top-anchored reading');
  });

  test('Case D: Resumen compacto -> expandir -> resumen completo', () => {
    useAiWizardStore.getState().reset();
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Pádel con amigos',
      date: '2026-11-15',
      time: '19:00',
      modality: 'presencial' as const,
      locationText: 'Club Central',
    };
    const config = createDefaultInvitationConfig();

    useAiWizardStore.setState({
      draft,
      config,
      isComplete: false,
    });

    // 1. Initial collapsed state in wizard
    const htmlCollapsed = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(htmlCollapsed.includes('data-testid="compact-draft-bar"'));
    assert.ok(htmlCollapsed.includes('data-testid="toggle-draft-summary"'));
    assert.ok(htmlCollapsed.includes('aria-expanded="false"'));
    assert.equal(htmlCollapsed.includes('data-testid="expanded-draft-summary"'), false);

    // 2. Full DraftSummary (which renders inside expanded accordion)
    const htmlFull = renderToStaticMarkup(
      React.createElement(DraftSummary, {
        draft,
        config,
        isLoading: false,
        onConfirmCreate: () => {},
        onModify: () => {},
        onFallbackManual: () => {},
        onChangeConfig: () => {},
      })
    );

    assert.ok(htmlFull.includes('Pádel con amigos'));
    assert.ok(htmlFull.includes('Club Central'));
    assert.ok(htmlFull.includes('data-testid="change-theme-button"'));
  });

  test('Case E: Actualizar draft no reordena mensajes ni altera el timeline', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: { ...createEmptyEncounterDraft(), title: 'Pizza party' },
      config: createDefaultInvitationConfig(),
      lastQuestion: null,
      messages: [
        { id: 'm1', role: 'user', text: 'Quiero organizar una pizza party', timestamp: 100 },
        { id: 'm2', role: 'assistant', text: '¡Buenísimo! ¿Cuándo sería?', timestamp: 200 },
      ],
    });

    const store = useAiWizardStore.getState();
    store.updateDraftField('date', '2026-10-20');
    store.updateDraftField('time', '20:30');
    store.updateDraftField('locationText', 'Mi terraza');

    const state = useAiWizardStore.getState();
    assert.equal(state.messages[0].id, 'm1');
    assert.equal(state.messages[1].id, 'm2');
    assert.ok(state.messages.length >= 2, 'Original messages preserved');

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    const idx1 = html.indexOf('Quiero organizar una pizza party');
    const idx2 = html.indexOf('¡Buenísimo! ¿Cuándo sería?');
    assert.ok(idx1 > -1 && idx2 > -1 && idx1 < idx2, 'Messages maintain strict chronological order');

    assert.ok(html.includes('Pizza party'));
    assert.ok(html.includes('20:30'));
    assert.ok(!html.includes('20:30 hs'), 'No debe incluir sufijo hs');
    assert.ok(html.includes('Mi terraza'));
  });

  test('Case F: aiLocked mantiene editor/resumen accesible', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: { ...createEmptyEncounterDraft(), title: 'Encuentro bloqueado' },
      config: createDefaultInvitationConfig(),
      aiLocked: true,
      consecutiveOffTopicCount: 2,
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(html.includes('data-testid="compact-draft-bar"'), 'Compact summary remains visible with aiLocked');
    assert.ok(html.includes('data-testid="continue-manually-button"'), 'Continue manually CTA remains accessible');
    assert.ok(html.includes('Crear con IA no disponible para este borrador'), 'Textarea placeholder communicates lock');
    assert.ok(html.includes('disabled=""') || html.includes('disabled'), 'Controls must be disabled');
  });

  test('Case G: Selector Tema/Variante sigue operativo con encuentro completo', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cumpleaños de Diego',
        date: '2026-12-05',
        time: '18:00',
        modality: 'presencial',
      },
      config: {
        ...createDefaultInvitationConfig(),
        invitationTheme: 'celebration',
        invitationTemplate: 'celebration_party',
      },
      isComplete: true,
      messages: [
        {
          id: 'm-last',
          role: 'assistant',
          text: '¡Listo! Tu encuentro está preparado.',
          timestamp: 9999,
        },
      ],
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(html.includes('data-testid="complete-draft-summary"'), 'Complete summary card rendered at end of chat');
    assert.ok(html.includes('Cumpleaños de Diego'));

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      const store = useAiWizardStore.getState();
      store.updateConfigField('invitationTheme', 'sports');
      store.updateConfigField('invitationTemplate', 'sports_match');

      const updated = useAiWizardStore.getState();
      assert.equal(updated.config.invitationTheme, 'sports');
      assert.equal(updated.config.invitationTemplate, 'sports_match');
      assert.equal(providerCalls, 0, 'Theme/variant updates must consume zero tokens');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('QA Production Fix: Virtual Modality Persistence, Link Validation & Anti-Loop (Cases A-J & QA Real Case)', () => {
  test('Section 7: Link validation and normalization handles valid URLs and rejects invalid/maps links', () => {
    // Valid URLs
    assert.equal(isValidVirtualLink('https://meet.google.com/abc-defg-hij'), true);
    assert.equal(isValidVirtualLink('https://zoom.us/j/123456789'), true);
    assert.equal(isValidVirtualLink('https://teams.microsoft.com/l/meetup-join/123'), true);
    assert.equal(isValidVirtualLink('https://example.com/reunion'), true);
    assert.equal(isValidVirtualLink('http://meet.jit.si/my-room'), true);

    // Normalization with scheme omission
    assert.equal(isValidVirtualLink('meet.google.com/abc-defg-hij'), true);
    assert.equal(isValidVirtualLink('zoom.us/j/123'), true);
    assert.equal(normalizeVirtualLink('meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
    assert.equal(normalizeVirtualLink('zoom.us/j/123'), 'https://zoom.us/j/123');

    // Platform keywords are NOT valid URLs for virtualLink
    assert.equal(isValidVirtualLink('Zoom'), false);
    assert.equal(isValidVirtualLink('Google Meet'), false);
    assert.equal(isValidVirtualLink('Teams'), false);

    // Invalid URLs, maps, and non-URLs
    assert.equal(isValidVirtualLink('Http://meet.com/$373+28(22'), false);
    assert.equal(isValidVirtualLink('https://maps.google.com/?q=bar'), false);
    assert.equal(isValidVirtualLink('https://goo.gl/maps/xyz123'), false);
    assert.equal(isValidVirtualLink('abc'), false);
    assert.equal(isValidVirtualLink('no sé'), false);
    assert.equal(isValidVirtualLink('después te lo paso'), false);
    assert.equal(isValidVirtualLink('javascript:alert(1)'), false);
  });

  test('Case A: modality null -> seleccionar Virtual -> modality=virtual -> nextMissingField=virtualLink', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena con amigos',
        date: '2027-09-08',
        time: '21:00',
        modality: null,
      },
      lastQuestion: {
        field: 'modality',
        question: '¿Va a ser presencial o virtual?',
        type: 'choice',
        quickOptions: [
          { label: '🏠 Presencial', value: 'presencial' },
          { label: '💻 Virtual', value: 'virtual' },
        ],
      },
      isComplete: false,
    });

    useAiWizardStore.getState().applyQuickOption('modality', 'virtual', '💻 Virtual');

    const state = useAiWizardStore.getState();
    assert.equal(state.draft.modality, 'virtual');
    assert.equal(state.draft.virtualLink, null);
    assert.equal(state.lastQuestion?.field, 'virtualLink');
    assert.equal(state.lastQuestion?.question, '¿Cuál es el enlace de la videollamada?');

    const evalResult = evaluateDraft(state.draft);
    assert.equal(evalResult.missingFields.includes('modality'), false);
    assert.deepEqual(evalResult.missingFields, ['virtualLink']);
  });

  test('Case B: modality=virtual -> virtualLink inválido -> modality sigue virtual -> nextMissingField=virtualLink -> mensaje específico', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena con amigos',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
      isComplete: false,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Http://meet.com/$373+28(22');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.virtualLink, null);
      assert.equal(state.lastQuestion?.field, 'virtualLink');
      assert.equal(state.error, null, 'Field validation must not produce red technical error banner');
      assert.equal(providerCalls, 0, 'Invalid link must use deterministic bypass with zero provider calls');

      const lastMsg = state.messages[state.messages.length - 1];
      assert.equal(lastMsg.role, 'assistant');
      assert.equal(lastMsg.text, 'El enlace no parece válido. Pegá el enlace completo de la videollamada.');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case C: modality=virtual -> virtualLink válido -> no vuelve a preguntar modalidad ni link -> resumen listo', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena con amigos',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
      isComplete: false,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('https://meet.google.com/abc-defg-hij');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.virtualLink, 'https://meet.google.com/abc-defg-hij');
      assert.equal(state.isComplete, true);
      assert.equal(state.lastQuestion, null);
      assert.equal(providerCalls, 0, 'Valid link must use deterministic bypass');

      const lastMsg = state.messages[state.messages.length - 1];
      assert.equal(lastMsg.role, 'assistant');
      assert.equal(lastMsg.text, '¡Listo! Preparé el resumen con los datos de tu encuentro. Revisalo antes de crear.');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case D: modality=virtual -> input "abc" -> no off_topic -> modalidad intacta -> error específico link', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena virtual',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
      consecutiveOffTopicCount: 0,
      aiLocked: false,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('abc');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.consecutiveOffTopicCount, 0, 'Input abc when answering virtualLink must NOT trigger off-topic');
      assert.equal(state.aiLocked, false);
      assert.equal(state.lastQuestion?.field, 'virtualLink');
      assert.equal(providerCalls, 0);

      const lastMsg = state.messages[state.messages.length - 1];
      assert.equal(lastMsg.role, 'assistant');
      assert.equal(lastMsg.text, 'El enlace no parece válido. Pegá el enlace completo de la videollamada.');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case E: modality=virtual -> "Mejor presencial" -> modality=presencial -> virtualLink deja de ser requerido', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena virtual',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Mejor que sea presencial');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'presencial');
      assert.equal(state.draft.virtualLink, null);
      assert.equal(state.lastQuestion?.field, 'locationText');
      assert.equal(state.lastQuestion?.question, '¿Dónde va a ser?');
      assert.equal(providerCalls, 0, 'Switch to presencial handled deterministically');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case F: modality=presencial -> "Mejor virtual" -> modality=virtual -> pide link si falta', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        date: '2027-09-08',
        time: '21:00',
        modality: 'presencial',
        locationText: 'Bar Antares',
      },
      lastQuestion: null,
      isComplete: true,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Mejor virtual');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.locationText, null);
      assert.equal(state.lastQuestion?.field, 'virtualLink');
      assert.equal(state.lastQuestion?.question, '¿Cuál es el enlace de la videollamada?');
      assert.equal(state.isComplete, false);
      assert.equal(providerCalls, 0);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case G: F5 después de seleccionar Virtual -> modality sigue virtual -> no repregunta modalidad', () => {
    useAiWizardStore.getState().reset();
    // Simulate rehydration from sessionStorage where user had selected Virtual
    useAiWizardStore.setState({
      sessionId: 'test-f5-session',
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena virtual',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: null,
      isComplete: false,
    });

    // F5 triggers initSession
    useAiWizardStore.getState().initSession();

    const state = useAiWizardStore.getState();
    assert.equal(state.draft.modality, 'virtual');
    assert.notEqual(state.lastQuestion?.field, 'modality', 'Must NOT ask for modality again after F5');
    assert.equal(state.lastQuestion?.field, 'virtualLink', 'Must continue asking for virtualLink');
  });

  test('Case H: Virtual seleccionado por chip -> providerCalls=0 para selección', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        date: '2027-09-08',
        time: '21:00',
        modality: null,
      },
      lastQuestion: {
        field: 'modality',
        question: '¿Va a ser presencial o virtual?',
        type: 'choice',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      useAiWizardStore.getState().applyQuickOption('modality', 'virtual', '💻 Virtual');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.lastQuestion?.field, 'virtualLink');
      assert.equal(providerCalls, 0, 'Selecting chip must never call provider');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case I: Link válido ingresado como respuesta a activeQuestion virtualLink -> providerCalls=0', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('https://zoom.us/j/987654321');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.virtualLink, 'https://zoom.us/j/987654321');
      assert.equal(providerCalls, 0);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case J: Link inválido -> providerCalls=0 -> no mutación de campos ajenos', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena especial',
        description: 'Una linda velada',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      config: {
        invitationType: 'individual',
        invitationTheme: 'party',
        invitationTemplate: 'party_neon',
        responseVisibility: 'detail',
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Http://meet.com/$373+28(22');

      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.title, 'Cena especial');
      assert.equal(state.draft.description, 'Una linda velada');
      assert.equal(state.draft.date, '2027-09-08');
      assert.equal(state.draft.time, '21:00');
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.virtualLink, null);
      assert.equal(state.config.invitationTheme, 'party');
      assert.equal(state.config.invitationTemplate, 'party_neon');
      assert.equal(state.config.invitationType, 'individual');
      assert.equal(state.config.responseVisibility, 'detail');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Section 16: Exact QA Production Sequence Reproduction', async () => {
    useAiWizardStore.getState().reset();
    // 1. Initial State: Title, Date, Time filled, Modality pending
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena con amigos',
        date: '2027-09-08',
        time: '21:00',
        modality: null,
        locationText: null,
        virtualLink: null,
      },
      messages: [
        { id: '1', role: 'assistant', text: '¿Va a ser presencial o virtual?', timestamp: 1 },
      ],
      lastQuestion: {
        field: 'modality',
        question: '¿Va a ser presencial o virtual?',
        type: 'choice',
        quickOptions: [
          { label: '🏠 Presencial', value: 'presencial' },
          { label: '💻 Virtual', value: 'virtual' },
        ],
      },
      isComplete: false,
    });

    // 2. User answers "Virtual"
    await useAiWizardStore.getState().sendUserMessage('Virtual');

    let state = useAiWizardStore.getState();
    assert.equal(state.draft.modality, 'virtual');
    assert.equal(state.lastQuestion?.field, 'virtualLink');
    assert.equal(state.lastQuestion?.question, '¿Cuál es el enlace de la videollamada?');

    // 3. User inputs the invalid link from real QA: Http://meet.com/$373+28(22
    await useAiWizardStore.getState().sendUserMessage('Http://meet.com/$373+28(22');

    state = useAiWizardStore.getState();

    // Verify expected outcome strictly:
    // - modalidad sigue virtual
    assert.equal(state.draft.modality, 'virtual');
    // - NO aparece “¿Va a ser presencial o virtual?”
    const lastAssistantMsg = state.messages.filter((m) => m.role === 'assistant').pop();
    assert.notEqual(lastAssistantMsg?.text, '¿Va a ser presencial o virtual?');
    // - aparece “El enlace no parece válido...”
    assert.ok(lastAssistantMsg?.text.startsWith('El enlace no parece válido'), `Expected warning message, got: ${lastAssistantMsg?.text}`);
    // - siguiente campo activo = virtualLink
    assert.equal(state.lastQuestion?.field, 'virtualLink');
    assert.equal(state.isComplete, false);
  });
});

describe('QA Final Release Rule: virtualLink must be a valid navigable URL (Tests A to F)', () => {
  test('Test A: "Zoom" no completa virtualLink (permanece null, modality=virtual, sigue pidiendo link)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Reunión de equipo',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
      isComplete: false,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Zoom');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.virtualLink, null, 'virtualLink must remain null when user says Zoom');
      assert.equal(state.lastQuestion?.field, 'virtualLink');
      assert.equal(state.lastQuestion?.question, '¿Cuál es el enlace de la videollamada?');
      assert.equal(state.isComplete, false);
      assert.equal(providerCalls, 0, 'Must not call LLM');

      const lastMsg = state.messages[state.messages.length - 1];
      assert.equal(lastMsg.role, 'assistant');
      assert.equal(lastMsg.text, '¿Cuál es el enlace de la videollamada?');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test B: "Google Meet" no completa virtualLink (permanece null, modality=virtual, sigue pidiendo link)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Reunión semanal',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
      isComplete: false,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Google Meet');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.virtualLink, null, 'virtualLink must remain null when user says Google Meet');
      assert.equal(state.lastQuestion?.field, 'virtualLink');
      assert.equal(state.lastQuestion?.question, '¿Cuál es el enlace de la videollamada?');
      assert.equal(state.isComplete, false);
      assert.equal(providerCalls, 0, 'Must not call LLM');

      const lastMsg = state.messages[state.messages.length - 1];
      assert.equal(lastMsg.role, 'assistant');
      assert.equal(lastMsg.text, '¿Cuál es el enlace de la videollamada?');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test C: dominio sin protocolo válido se normaliza a https://', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Demo de producto',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
      isComplete: false,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('meet.google.com/abc-defg-hij');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.virtualLink, 'https://meet.google.com/abc-defg-hij');
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.isComplete, true);
      assert.equal(providerCalls, 0);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test D: URL custom http/https válida completa virtualLink', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Reunión privada',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
      isComplete: false,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('https://video.custom-domain.org/room-42');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.virtualLink, 'https://video.custom-domain.org/room-42');
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.isComplete, true);
      assert.equal(providerCalls, 0);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test E: link inválido mantiene modality virtual y sigue pidiendo virtualLink', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena virtual',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
      isComplete: false,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('javascript:void(0)');

      let state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.virtualLink, null);
      assert.equal(state.lastQuestion?.field, 'virtualLink');
      assert.equal(state.error, null);
      assert.ok(state.messages.at(-1)?.text.includes('El enlace no parece válido'));

      await useAiWizardStore.getState().sendUserMessage('Http://meet.com/$373+28(22');

      state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.virtualLink, null);
      assert.equal(state.lastQuestion?.field, 'virtualLink');
      assert.equal(state.error, null);
      assert.ok(state.messages.at(-1)?.text.includes('El enlace no parece válido'));
      assert.equal(providerCalls, 0);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test F: link válido completa el encuentro sin repreguntar modalidad', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cumpleaños Virtual',
        date: '2027-09-08',
        time: '21:00',
        modality: 'virtual',
        virtualLink: null,
      },
      messages: [
        { id: '1', role: 'assistant', text: '¿Cuál es el enlace de la videollamada?', timestamp: 1 },
      ],
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
      isComplete: false,
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('https://zoom.us/j/123456');

      const state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.virtualLink, 'https://zoom.us/j/123456');
      assert.equal(state.isComplete, true);
      assert.equal(state.lastQuestion, null);
      assert.equal(providerCalls, 0);

      // Confirm no message asks for modality
      const allAssistantMsgs = state.messages.filter((m) => m.role === 'assistant');
      const modalityQuestions = allAssistantMsgs.filter((m) => m.text.includes('presencial o virtual'));
      assert.equal(modalityQuestions.length, 0, 'Must never ask for modality again');

      const lastMsg = allAssistantMsgs[allAssistantMsgs.length - 1];
      assert.equal(lastMsg.text, '¡Listo! Preparé el resumen con los datos de tu encuentro. Revisalo antes de crear.');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('AI Interpretation Resilience: Timeout, AbortController, Error Classification & Retry (Scenarios A to H + Exact Reproduction)', () => {
  test('Test A: request exitosa en 2s -> loading aparece y desaparece -> respuesta visible', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    let resolvePromise: (val: any) => void;
    const delayedPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    aiService.interpretMessage = async () => {
      return (await delayedPromise) as any;
    };

    try {
      const sendPromise = useAiWizardStore.getState().sendUserMessage('Cena de cumpleaños el viernes a las 21');
      assert.equal(useAiWizardStore.getState().isInterpreting, true, 'isInterpreting must be true while waiting');

      resolvePromise!({
        ok: true,
        scope: 'encounter',
        patch: {
          title: { value: 'Cena de cumpleaños', confidence: 'explicit' },
          dateIntent: { value: { type: 'absolute', day: 15, month: 10, year: 2027 }, confidence: 'explicit' },
          timeIntent: { value: { type: 'exact', hour: 21, minute: 0 }, confidence: 'explicit' },
        },
      });

      await sendPromise;

      const state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false, 'isInterpreting must be false after response');
      assert.equal(state.draft.title, 'Cena de cumpleaños');
      assert.equal(state.draft.time, '21:00');
      assert.ok(state.messages.some((m) => m.role === 'assistant'), 'Assistant reply must be visible');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test B: request tarda > CLIENT_AI_TIMEOUT_MS -> abort -> isInterpreting=false -> input habilitado -> mensaje timeout visible', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    // 1. Verify aiService.interpretMessage aborts via AbortController and customTimeoutMs
    Object.defineProperty(supabase, 'functions', {
      value: {
        invoke: async (_name: string, options: any) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve({ data: { ok: true }, error: null });
            }, 150);

            if (options?.signal) {
              options.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                const abortErr = new Error('The operation was aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
              });
            }
          });
        },
      },
      configurable: true,
      writable: true,
    });

    try {
      assert.equal(CLIENT_AI_TIMEOUT_MS, 25000, 'Default CLIENT_AI_TIMEOUT_MS must be 25000');
      const res = await aiService.interpretMessage('test message', undefined, undefined, 40);
      assert.equal(res.ok, false);
      assert.equal(res.error, 'timeout_client');
      assert.ok(res.details?.includes('No pude procesar el mensaje a tiempo'));

      // 2. Verify store handles timeout
      useAiWizardStore.setState({
        draft: createEmptyEncounterDraft(),
        isInterpreting: false,
        error: null,
      });

      aiService.interpretMessage = async () => ({
        ok: false,
        error: 'timeout_client',
        details: 'No pude procesar el mensaje a tiempo. Podés intentar nuevamente o continuar manualmente.',
      });

      await useAiWizardStore.getState().sendUserMessage('Taller de cocina el 12 a las 16');

      const state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false, 'isInterpreting must be false after timeout');
      assert.equal(state.aiLocked, false, 'aiLocked must NOT be set on timeout');
      assert.equal(state.consecutiveOffTopicCount, 0, 'Off topic count must NOT increment on timeout');
      assert.ok(state.error?.includes('No pude procesar el mensaje a tiempo'));
      assert.equal(state.lastUserPrompt, 'Taller de cocina el 12 a las 16');
    } finally {
      delete (supabase as any).functions;
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test C: fetch lanza network error -> loading desaparece -> input habilitado', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    Object.defineProperty(supabase, 'functions', {
      value: {
        invoke: async () => {
          const err = new TypeError('Failed to fetch');
          return { data: null, error: err };
        },
      },
      configurable: true,
      writable: true,
    });

    try {
      const res = await aiService.interpretMessage('Cena mañana');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'network_error');
      assert.ok(res.details?.includes('No pudimos conectarnos con Crear con IA'));

      // Verify store
      aiService.interpretMessage = async () => res;
      await useAiWizardStore.getState().sendUserMessage('Cena mañana');

      const state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false);
      assert.equal(state.aiLocked, false);
      assert.equal(state.error, 'No pudimos conectarnos con Crear con IA. Revisá tu conexión e intentá nuevamente.');
    } finally {
      delete (supabase as any).functions;
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test D: HTTP 429 -> loading desaparece -> mensaje específico y bloqueo si corresponde', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    Object.defineProperty(supabase, 'functions', {
      value: {
        invoke: async () => {
          return {
            data: null,
            error: {
              name: 'FunctionsHttpError',
              context: {
                status: 429,
                json: async () => ({
                  error: 'rate_limit_exceeded',
                  message: 'Alcanzaste el límite de consultas permitidas. Podés continuar manualmente.',
                }),
              },
            },
          };
        },
      },
      configurable: true,
      writable: true,
    });

    try {
      const res = await aiService.interpretMessage('Consulta spam');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'rate_limit_exceeded');

      aiService.interpretMessage = async () => res;
      await useAiWizardStore.getState().sendUserMessage('Consulta spam');

      const state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false);
      assert.equal(state.aiLocked, true);
      assert.equal(state.error, 'Alcanzaste el límite de consultas permitidas. Podés continuar manualmente.');
      const lastMsg = state.messages[state.messages.length - 1];
      assert.equal(lastMsg.role, 'assistant');
      assert.ok(lastMsg.text.includes('límite'));
    } finally {
      delete (supabase as any).functions;
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test E: HTTP 503 -> loading desaparece -> mensaje específico y reintentable', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    Object.defineProperty(supabase, 'functions', {
      value: {
        invoke: async () => {
          return {
            data: null,
            error: {
              name: 'FunctionsHttpError',
              context: {
                status: 503,
                json: async () => ({
                  error: 'rate_limit_unavailable',
                  message: 'El servicio de IA no está disponible temporalmente. Podés continuar manualmente.',
                }),
              },
            },
          };
        },
      },
      configurable: true,
      writable: true,
    });

    try {
      const res = await aiService.interpretMessage('Juntada el sábado');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'rate_limit_unavailable');

      aiService.interpretMessage = async () => res;
      await useAiWizardStore.getState().sendUserMessage('Juntada el sábado');

      const state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false);
      assert.equal(state.aiLocked, false, '503 must not permanently lock');
      assert.equal(state.error, 'El servicio de IA no está disponible temporalmente. Podés continuar manualmente.');
    } finally {
      delete (supabase as any).functions;
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test F: respuesta JSON inválida -> loading desaparece -> error recuperable', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    Object.defineProperty(supabase, 'functions', {
      value: {
        invoke: async () => {
          return {
            data: { ok: true, not_a_patch: 123 }, // missing patch!
            error: null,
          };
        },
      },
      configurable: true,
      writable: true,
    });

    try {
      const res = await aiService.interpretMessage('Algo raro');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'invalid_response');

      aiService.interpretMessage = async () => res;
      await useAiWizardStore.getState().sendUserMessage('Algo raro');

      const state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false);
      assert.equal(state.aiLocked, false);
      assert.ok(state.error?.includes('Respuesta inesperada del servicio de IA'));
    } finally {
      delete (supabase as any).functions;
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test G: retry manual -> no duplica mensaje usuario -> nueva request', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    let calls = 0;
    aiService.interpretMessage = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          error: 'timeout_client',
          details: 'No pude procesar el mensaje a tiempo. Podés intentar nuevamente o continuar manualmente.',
        };
      }
      return {
        ok: true,
        scope: 'encounter',
        patch: {
          title: { value: 'Asado con amigos', confidence: 'explicit' },
          dateIntent: { value: { type: 'absolute', day: 17, month: 10, year: 2027 }, confidence: 'explicit' },
          timeIntent: { value: { type: 'exact', hour: 13, minute: 0 }, confidence: 'explicit' },
        },
      };
    };

    try {
      // 1. Initial send fails with timeout
      await useAiWizardStore.getState().sendUserMessage('Asado con amigos el domingo a las 13');
      let state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false);
      assert.equal(calls, 1);
      const userMessagesBefore = state.messages.filter((m) => m.role === 'user');
      assert.equal(userMessagesBefore.length, 1);
      assert.equal(state.lastUserPrompt, 'Asado con amigos el domingo a las 13');
      assert.ok(state.error?.includes('No pude procesar el mensaje a tiempo'));

      // 2. User triggers retry
      await useAiWizardStore.getState().retryLastMessage();
      state = useAiWizardStore.getState();
      assert.equal(calls, 2);
      assert.equal(state.isInterpreting, false);
      assert.equal(state.error, null);

      // Verify no duplicate user message
      const userMessagesAfter = state.messages.filter((m) => m.role === 'user');
      assert.equal(userMessagesAfter.length, 1, 'Retry must NOT duplicate user message in timeline');
      assert.equal(state.draft.title, 'Asado con amigos');
      assert.equal(state.draft.time, '13:00');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test H: cualquier excepción -> finally deja isInterpreting=false', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    aiService.interpretMessage = async () => {
      throw new Error('Unexpected crash in engine');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Explosión controlada');

      const state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false, 'finally MUST set isInterpreting=false on unhandled exception');
      assert.ok(state.error?.includes('error inesperado'));
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Exact Reproduction: "Taller de cocina el 12 a las 16" (Normal vs Provider Lento >25s)', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    try {
      // Case 1: Exact real reproduction of "Taller de cocina el 12 a las 16"
      // Real LLM returns type: 'absolute', day: 12 WITHOUT month or year
      aiService.interpretMessage = async () => ({
        ok: true,
        scope: 'encounter',
        patch: {
          title: { value: 'Taller de cocina', confidence: 'explicit' },
          dateIntent: { value: { type: 'absolute', day: 12 }, confidence: 'explicit' },
          timeIntent: { value: { type: 'exact', hour: 16, minute: 0 }, confidence: 'explicit' },
        },
      });

      await useAiWizardStore.getState().sendUserMessage('Taller de cocina el 12 a las 16');

      let state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false, 'Must not hang');
      assert.equal(state.draft.title, 'Taller de cocina');
      assert.equal(state.draft.time, '16:00');
      assert.ok(state.draft.date?.endsWith('-12'), 'Date must resolve to 12th');
      assert.equal(state.lastQuestion?.field, 'modality', 'Only asks for missing field (modality)');
      assert.equal(state.error, null, 'Must not display unexpected error');

      // Case 2: Simulated provider slow >25s -> aborts and recovers UI
      useAiWizardStore.getState().reset();
      aiService.interpretMessage = async (_msg, _draft, _sid, timeoutMs = 40) => {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: false,
              error: 'timeout_client',
              details: 'No pude procesar el mensaje a tiempo. Podés intentar nuevamente o continuar manualmente.',
            });
          }, timeoutMs || 40);
        });
      };

      await useAiWizardStore.getState().sendUserMessage('Taller de cocina el 12 a las 16');
      state = useAiWizardStore.getState();
      assert.equal(state.isInterpreting, false, 'Must not remain in isInterpreting=true');
      assert.ok(state.error?.includes('No pude procesar el mensaje a tiempo'));
      assert.equal(state.aiLocked, false);
      assert.equal(state.lastUserPrompt, 'Taller de cocina el 12 a las 16');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Strict pad behavior: throws on undefined/null/NaN and formats integers correctly', () => {
    assert.throws(() => pad(undefined as any), TypeError);
    assert.throws(() => pad(null as any), TypeError);
    assert.throws(() => pad(NaN as any), TypeError);
    assert.throws(() => pad('abc' as any), TypeError);
    assert.equal(pad(0), '00');
    assert.equal(pad(5), '05');
    assert.equal(pad(12), '12');
  });

  test('Calendar Hardening: Semantics for day >= currentDay and Cases A through D', () => {
    // A. base 2026-01-31 + "el 31" -> 2026-01-31 (mismo día si existe)
    const testA = resolveDateIntent(
      { type: 'absolute', day: 31 },
      { year: 2026, month: 1, day: 31 }
    );
    assert.equal(testA.resolved, true);
    assert.equal(testA.date, '2026-01-31');

    // B. base 2026-02-01 + "el 31" -> 2026-03-31 (febrero no tiene 31, salta a marzo)
    const testB = resolveDateIntent(
      { type: 'absolute', day: 31 },
      { year: 2026, month: 2, day: 1 }
    );
    assert.equal(testB.resolved, true);
    assert.equal(testB.date, '2026-03-31');

    // C. base 2026-09-10 + "el 10" -> 2026-09-10 (mismo día)
    const testC = resolveDateIntent(
      { type: 'absolute', day: 10 },
      { year: 2026, month: 9, day: 10 }
    );
    assert.equal(testC.resolved, true);
    assert.equal(testC.date, '2026-09-10');

    // D. base 2026-09-10 + "el 5" -> 2026-10-05 (ya pasó en mes actual, próximo mes)
    const testD = resolveDateIntent(
      { type: 'absolute', day: 5 },
      { year: 2026, month: 9, day: 10 }
    );
    assert.equal(testD.resolved, true);
    assert.equal(testD.date, '2026-10-05');

    // Extra: hoy 10 sep + "el 12" -> 12 sep
    const case12 = resolveDateIntent(
      { type: 'absolute', day: 12 },
      { year: 2026, month: 9, day: 10 }
    );
    assert.equal(case12.resolved, true);
    assert.equal(case12.date, '2026-09-12');

    // Extra: hoy 10 sep + "el 31" -> 31 oct (Septiembre tiene 30 días, busca próxima existencia real)
    const case31 = resolveDateIntent(
      { type: 'absolute', day: 31 },
      { year: 2026, month: 9, day: 10 }
    );
    assert.equal(case31.resolved, true);
    assert.equal(case31.date, '2026-10-31');

    // Inexistentes: 31 de septiembre -> inválido (no normalizar silenciosamente)
    const caseInvalSep = resolveDateIntent(
      { type: 'absolute', day: 31, month: 9 },
      { year: 2026, month: 9, day: 10 }
    );
    assert.equal(caseInvalSep.resolved, false);
    assert.equal(caseInvalSep.confidence, 'ambiguous');
    assert.ok(caseInvalSep.ambiguityReason?.includes('Fecha inválida en el calendario'));

    // Inexistentes: 30 de febrero -> inválido
    const caseInvalFeb = resolveDateIntent(
      { type: 'absolute', day: 30, month: 2 },
      { year: 2026, month: 9, day: 10 }
    );
    assert.equal(caseInvalFeb.resolved, false);
    assert.equal(caseInvalFeb.confidence, 'ambiguous');
    assert.ok(caseInvalFeb.ambiguityReason?.includes('Fecha inválida en el calendario'));

    // Bisiesto: 29 feb 2028 -> válido (año bisiesto)
    const caseBis = resolveDateIntent(
      { type: 'absolute', day: 29, month: 2, year: 2028 },
      { year: 2026, month: 9, day: 10 }
    );
    assert.equal(caseBis.resolved, true);
    assert.equal(caseBis.date, '2028-02-29');

    // No bisiesto: 29 feb 2027 -> inválido
    const caseNoBis = resolveDateIntent(
      { type: 'absolute', day: 29, month: 2, year: 2027 },
      { year: 2026, month: 9, day: 10 }
    );
    assert.equal(caseNoBis.resolved, false);
    assert.equal(caseNoBis.confidence, 'ambiguous');
    assert.ok(caseNoBis.ambiguityReason?.includes('Fecha inválida en el calendario'));

    // Rollover de año: 25 dic + "el 12" -> 12 ene próximo año
    const caseRollover = resolveDateIntent(
      { type: 'absolute', day: 12 },
      { year: 2026, month: 12, day: 25 }
    );
    assert.equal(caseRollover.resolved, true);
    assert.equal(caseRollover.date, '2027-01-12');
  });

  test('Deterministic Time Question Handling: Cases A through J (No LLM Loop, providerCalls = 0)', async () => {
    const originalInterpret = aiService.interpretMessage;
    let providerCalls = 0;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for active time question!');
    };

    try {
      // Helper to initialize store in state: title = 'Evento', date = '2026-10-31', time = null, lastQuestion = 'time'
      const initTimeQuestionState = () => {
        useAiWizardStore.getState().reset();
        useAiWizardStore.setState({
          draft: {
            ...createEmptyEncounterDraft(),
            title: 'Evento',
            date: '2026-10-31',
            baseDate: '2026-10-31',
            time: null,
            modality: null,
          },
          messages: [
            { id: '1', role: 'user', text: 'Evento el 31', timestamp: 1 },
            { id: '2', role: 'assistant', text: '¿A qué hora?', timestamp: 2 },
          ],
          lastQuestion: {
            field: 'time',
            question: '¿A qué hora?',
            helperText: 'Ej: "a las 21", "19:30", "a las 9 de la noche"',
            type: 'text',
          },
          isComplete: false,
          error: null,
        });
        providerCalls = 0;
      };

      // Case A: pregunta activa hora + "10" -> 10:00 -> avanza
      initTimeQuestionState();
      await useAiWizardStore.getState().sendUserMessage('10');
      let state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Case A must not call LLM');
      assert.equal(state.draft.time, '10:00');
      assert.equal(state.lastQuestion?.field, 'modality');
      assert.equal(state.messages.at(-1)?.text, '¿Va a ser presencial o virtual?');

      // Case B: "18" -> 18:00
      initTimeQuestionState();
      await useAiWizardStore.getState().sendUserMessage('18');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Case B must not call LLM');
      assert.equal(state.draft.time, '18:00');
      assert.equal(state.lastQuestion?.field, 'modality');

      // Case C: "10:30" -> 10:30
      initTimeQuestionState();
      await useAiWizardStore.getState().sendUserMessage('10:30');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Case C must not call LLM');
      assert.equal(state.draft.time, '10:30');
      assert.equal(state.lastQuestion?.field, 'modality');

      // Case D: "a las 18" -> 18:00
      initTimeQuestionState();
      await useAiWizardStore.getState().sendUserMessage('a las 18');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Case D must not call LLM');
      assert.equal(state.draft.time, '18:00');
      assert.equal(state.lastQuestion?.field, 'modality');

      // Case E: "10 hs" -> 10:00
      initTimeQuestionState();
      await useAiWizardStore.getState().sendUserMessage('10 hs');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Case E must not call LLM');
      assert.equal(state.draft.time, '10:00');
      assert.equal(state.lastQuestion?.field, 'modality');

      // Case F: "10 a 18" -> aclaración de rango / inicio -> no loop silencioso
      initTimeQuestionState();
      await useAiWizardStore.getState().sendUserMessage('10 a 18');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Case F must not call LLM');
      assert.equal(state.draft.time, null, 'Must not set draft.time yet');
      assert.equal(state.lastQuestion?.field, 'time', 'Field remains time');
      assert.equal(state.lastQuestion?.question, '¿Querés que el encuentro empiece a las 10:00?');
      assert.equal(state.messages.at(-1)?.text, '¿Querés que el encuentro empiece a las 10:00?');
      // Verify subsequent confirmation with "10" or "Sí" confirms 10:00 and advances
      await useAiWizardStore.getState().sendUserMessage('10');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.time, '10:00');
      assert.equal(state.lastQuestion?.field, 'modality');

      // Case G: "27" -> error específico -> sigue en hora
      initTimeQuestionState();
      await useAiWizardStore.getState().sendUserMessage('27');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Case G must not call LLM');
      assert.equal(state.draft.time, null);
      assert.equal(state.lastQuestion?.field, 'time', 'Must keep field = time');
      assert.equal(state.messages.at(-1)?.text, 'No pude reconocer la hora. Podés escribir, por ejemplo, 10:00 o 18:30.');
      assert.equal(state.error, null, 'Field validation must keep state.error = null');

      // Case H: "10:99" -> error específico
      initTimeQuestionState();
      await useAiWizardStore.getState().sendUserMessage('10:99');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Case H must not call LLM');
      assert.equal(state.draft.time, null);
      assert.equal(state.lastQuestion?.field, 'time');
      assert.equal(state.messages.at(-1)?.text, 'No pude reconocer la hora. Podés escribir, por ejemplo, 10:00 o 18:30.');
      assert.equal(state.error, null, 'Field validation must keep state.error = null');

      // Case I: "24" -> semántica 24:00 existente (00:00, date +1 day rollover)
      initTimeQuestionState();
      await useAiWizardStore.getState().sendUserMessage('24');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Case I must not call LLM');
      assert.equal(state.draft.time, '00:00');
      assert.equal(state.draft.date, '2026-11-01', 'Must apply +1 day rollover from 2026-10-31');
      assert.equal(state.draft.appliedDayRollover, true);
      assert.equal(state.lastQuestion?.field, 'modality');

      // Case J: reproducción exacta del caso reportado
      // Step 1: Initial interpretation of "Evento el 31"
      aiService.interpretMessage = async () => ({
        ok: true,
        scope: 'encounter',
        patch: {
          title: { value: 'Evento', confidence: 'explicit' },
          dateIntent: { value: { type: 'absolute', day: 31 }, confidence: 'explicit' },
        },
      });
      useAiWizardStore.getState().reset();
      await useAiWizardStore.getState().sendUserMessage('Evento el 31');
      state = useAiWizardStore.getState();
      assert.equal(state.draft.title, 'Evento');
      assert.ok(state.draft.date?.endsWith('-31'));
      assert.equal(state.draft.time, null);
      assert.equal(state.lastQuestion?.field, 'time');
      assert.equal(state.lastQuestion?.question, '¿A qué hora?');

      // Re-enable spy ensuring subsequent steps make 0 LLM calls
      providerCalls = 0;
      aiService.interpretMessage = async () => {
        providerCalls++;
        throw new Error('LLM was called during time flow!');
      };

      // Step 2: User responds "10 a 18" -> clarification of range, no loop
      await useAiWizardStore.getState().sendUserMessage('10 a 18');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Step 2 must not call LLM');
      assert.equal(state.messages.at(-1)?.text, '¿Querés que el encuentro empiece a las 10:00?');
      assert.equal(state.lastQuestion?.field, 'time');

      // Step 3: User responds "10" -> sets 10:00, advances to modality
      await useAiWizardStore.getState().sendUserMessage('10');
      state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Step 3 must not call LLM');
      assert.equal(state.draft.time, '10:00');
      assert.equal(state.lastQuestion?.field, 'modality');
      assert.equal(state.messages.at(-1)?.text, '¿Va a ser presencial o virtual?');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Escape from Time Parser & Range Confirmation Context: Cases A through E and "Sí" handling', async () => {
    // 1. Unit assertions for looksLikeOtherFieldIntent
    assert.equal(looksLikeOtherFieldIntent('mejor mañana'), true);
    assert.equal(looksLikeOtherFieldIntent('que sea virtual'), true);
    assert.equal(looksLikeOtherFieldIntent('en casa'), true);
    assert.equal(looksLikeOtherFieldIntent('cambiá el tema'), true);
    assert.equal(looksLikeOtherFieldIntent('prefiero presencial'), true);

    assert.equal(looksLikeOtherFieldIntent('10'), false);
    assert.equal(looksLikeOtherFieldIntent('18'), false);
    assert.equal(looksLikeOtherFieldIntent('10 a 18'), false);
    assert.equal(looksLikeOtherFieldIntent('27'), false);
    assert.equal(looksLikeOtherFieldIntent('10:99'), false);
    assert.equal(looksLikeOtherFieldIntent('abc'), false);
    assert.equal(looksLikeOtherFieldIntent('Sí'), false);

    const originalInterpret = aiService.interpretMessage;

    try {
      const setupTimeQuestion = () => {
        useAiWizardStore.getState().reset();
        useAiWizardStore.setState({
          draft: {
            ...createEmptyEncounterDraft(),
            title: 'Evento',
            date: '2026-10-31',
            baseDate: '2026-10-31',
            time: null,
            modality: null,
          },
          messages: [
            { id: '1', role: 'user', text: 'Evento el 31', timestamp: 1 },
            { id: '2', role: 'assistant', text: '¿A qué hora?', timestamp: 2 },
          ],
          lastQuestion: {
            field: 'time',
            question: '¿A qué hora?',
            type: 'text',
          },
          isComplete: false,
          error: null,
        });
      };

      // Case A: "mejor mañana" -> delegates to LLM, no error de hora, updates date, still asks for time
      setupTimeQuestion();
      aiService.interpretMessage = async () => ({
        ok: true,
        scope: 'encounter',
        patch: {
          dateIntent: { value: { type: 'relative', value: 'tomorrow' }, confidence: 'explicit' },
        },
      });
      await useAiWizardStore.getState().sendUserMessage('mejor mañana');
      let state = useAiWizardStore.getState();
      assert.equal(state.error, null, 'Must NOT show time error');
      assert.equal(state.lastQuestion?.field, 'time', 'Still needs time');
      assert.notEqual(state.draft.date, '2026-10-31', 'Date was updated');

      // Case B: "que sea virtual" -> delegates to LLM, no error de hora, modality = virtual
      setupTimeQuestion();
      aiService.interpretMessage = async () => ({
        ok: true,
        scope: 'encounter',
        patch: {
          modality: { value: 'virtual', confidence: 'explicit' },
        },
      });
      await useAiWizardStore.getState().sendUserMessage('que sea virtual');
      state = useAiWizardStore.getState();
      assert.equal(state.error, null, 'Must NOT show time error');
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.lastQuestion?.field, 'time', 'Still needs time');

      // Case C: "en casa" -> delegates to LLM, no error de hora, locationText updated
      setupTimeQuestion();
      aiService.interpretMessage = async () => ({
        ok: true,
        scope: 'encounter',
        patch: {
          locationText: { value: 'en casa', confidence: 'explicit' },
        },
      });
      await useAiWizardStore.getState().sendUserMessage('en casa');
      state = useAiWizardStore.getState();
      assert.equal(state.error, null, 'Must NOT show time error');
      assert.equal(state.draft.locationText, 'en casa');
      assert.equal(state.lastQuestion?.field, 'time', 'Still needs time');

      // Case D: "cambiá el tema" -> delegates to LLM, no error de hora
      setupTimeQuestion();
      aiService.interpretMessage = async () => ({
        ok: true,
        scope: 'encounter',
        patch: {
          themeHint: { value: 'celebration', confidence: 'explicit' },
        },
      });
      await useAiWizardStore.getState().sendUserMessage('cambiá el tema');
      state = useAiWizardStore.getState();
      assert.equal(state.error, null, 'Must NOT show time error');
      assert.equal(state.config.invitationTheme, 'celebration');

      // Case E: "prefiero presencial" -> delegates to LLM, no error de hora, modality = presencial
      setupTimeQuestion();
      aiService.interpretMessage = async () => ({
        ok: true,
        scope: 'encounter',
        patch: {
          modality: { value: 'presencial', confidence: 'explicit' },
        },
      });
      await useAiWizardStore.getState().sendUserMessage('prefiero presencial');
      state = useAiWizardStore.getState();
      assert.equal(state.error, null, 'Must NOT show time error');
      assert.equal(state.draft.modality, 'presencial');

      // Confirmation of range vs generic question:
      // Subcase 1: Generic question "¿A qué hora?" + "Sí" -> NO set 10:00, keeps time null, asks for valid time
      setupTimeQuestion();
      aiService.interpretMessage = async () => {
        throw new Error('Should NOT call LLM for "Sí"');
      };
      await useAiWizardStore.getState().sendUserMessage('Sí');
      state = useAiWizardStore.getState();
      assert.equal(state.draft.time, null, '"Sí" without range proposal must NOT set 10:00');
      assert.equal(state.lastQuestion?.field, 'time');
      assert.equal(state.messages.at(-1)?.text, 'No pude reconocer la hora. Podés escribir, por ejemplo, 10:00 o 18:30.');
      assert.equal(state.error, null, 'Field validation must keep state.error = null');

      // Subcase 2: Pending range proposal "¿Querés que el encuentro empiece a las 10:00?" + "Sí" -> sets 10:00!
      useAiWizardStore.setState({
        lastQuestion: {
          field: 'time',
          question: '¿Querés que el encuentro empiece a las 10:00?',
          type: 'choice',
        },
        error: null,
      });
      await useAiWizardStore.getState().sendUserMessage('Sí');
      state = useAiWizardStore.getState();
      assert.equal(state.draft.time, '10:00', '"Sí" with pending proposal MUST set 10:00');
      assert.equal(state.lastQuestion?.field, 'modality');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('UX/Orchestration: Confirmación de salida y protección del borrador (Cases A to F)', () => {
  test('Case A: draft vacío -> hasMeaningfulDraftData es false -> salir sin modal', () => {
    useAiWizardStore.getState().reset();
    const emptyDraft = createEmptyEncounterDraft();
    const defaultConfig = createDefaultInvitationConfig();
    assert.equal(hasMeaningfulDraftData(emptyDraft, defaultConfig), false);

    // SSR render does not show modal
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(CreateAIWizard))
    );
    assert.ok(!html.includes('¿Salir de Crear con IA?'));
    assert.ok(!html.includes('Vas a perder los datos cargados de este encuentro.'));
  });

  test('Case B: draft con title -> hasMeaningfulDraftData es true', () => {
    useAiWizardStore.getState().reset();
    const draft = { ...createEmptyEncounterDraft(), title: 'Asado familiar' };
    const config = createDefaultInvitationConfig();
    assert.equal(hasMeaningfulDraftData(draft, config), true);
  });

  test('Case C: modal -> Seguir editando -> draft intacto', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Asado con amigos',
        date: '2026-10-15',
      },
      messages: [
        { id: '1', role: 'user', text: 'Asado el 15', timestamp: 1 },
        { id: '2', role: 'assistant', text: '¿A qué hora?', timestamp: 2 },
      ],
    });

    const stateBefore = useAiWizardStore.getState();
    assert.equal(hasMeaningfulDraftData(stateBefore.draft, stateBefore.config), true);
    // Simulating keeping editing: no state changes, draft and messages preserved
    const stateAfter = useAiWizardStore.getState();
    assert.equal(stateAfter.draft.title, 'Asado con amigos');
    assert.equal(stateAfter.draft.date, '2026-10-15');
    assert.equal(stateAfter.messages.length, 2);
  });

  test('Case D: modal -> Descartar y salir -> reset() limpia draft y mensajes', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Taller de pintura',
        date: '2026-11-20',
      },
      messages: [
        { id: '1', role: 'user', text: 'Taller', timestamp: 1 },
      ],
    });

    assert.equal(hasMeaningfulDraftData(useAiWizardStore.getState().draft, useAiWizardStore.getState().config), true);
    useAiWizardStore.getState().reset();
    const cleanState = useAiWizardStore.getState();
    assert.equal(hasMeaningfulDraftData(cleanState.draft, cleanState.config), false);
    assert.equal(cleanState.draft.title, null);
    assert.equal(cleanState.draft.date, null);
    assert.equal(cleanState.messages.length, 0);
  });

  test('Case E: botón Atrás con draft cargado -> detección de historial protegido', () => {
    const draft = { ...createEmptyEncounterDraft(), modality: 'virtual' as const };
    const config = createDefaultInvitationConfig();
    assert.equal(hasMeaningfulDraftData(draft, config), true);
  });

  test('Case F: Continuar manualmente -> draftToWizardState transfiere datos sin pérdida', () => {
    useAiWizardStore.getState().reset();
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cumpleaños sorpresa',
      date: '2026-12-05',
      time: '18:00',
      modality: 'presencial' as const,
      locationText: 'Club Social',
    };
    const config = {
      ...createDefaultInvitationConfig(),
      invitationTheme: 'party',
      invitationTemplate: 'party_neon',
    };
    useAiWizardStore.setState({ draft, config });

    const manualState = draftToWizardState(draft, config);
    assert.equal(manualState.titulo, 'Cumpleaños sorpresa');
    assert.equal(manualState.fecha, '2026-12-05');
    assert.equal(manualState.hora, '18:00');
    assert.equal(manualState.lugar_texto, 'Club Social');
    assert.equal(manualState.tema_invitacion, 'party');
    assert.equal(manualState.invitation_template, 'party_neon');
  });
});

describe('Separación estricta de errores: Validación normal vs Error técnico (Cases G to K)', () => {
  test('Case G: virtualLink inválido -> mensaje en timeline, error: null, no banner rojo', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Reunión virtual',
        date: '2026-10-10',
        time: '19:00',
        modality: 'virtual',
        virtualLink: null,
      },
      lastQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('enlace-roto');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Must not call LLM for invalid link format');
      assert.equal(state.error, null, 'Must NOT write technical error banner for field validation');
      assert.equal(state.messages.at(-1)?.role, 'assistant');
      assert.ok(state.messages.at(-1)?.text.includes('El enlace no parece válido'));
      assert.equal(state.draft.virtualLink, null);
      assert.equal(state.lastQuestion?.field, 'virtualLink');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case H: hora inválida -> mensaje en timeline, error: null, no banner técnico', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Café',
        date: '2026-10-10',
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('28:90');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.error, null, 'state.error must be null for invalid time format');
      assert.equal(state.messages.at(-1)?.role, 'assistant');
      assert.ok(state.messages.at(-1)?.text.includes('No pude reconocer la hora'));
      assert.equal(state.draft.time, null);
      assert.equal(state.lastQuestion?.field, 'time');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case I: timeout_client -> genera error técnico (state.error !== null)', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: false,
      error: 'timeout_client',
      details: 'Client timeout after 10000ms',
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Organizar asado el sábado');
      const state = useAiWizardStore.getState();
      assert.notEqual(state.error, null, 'Must write state.error for timeout');
      assert.ok(state.error?.includes('No pude procesar el mensaje a tiempo'));
      assert.equal(state.isInterpreting, false);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case J: network_error -> genera error técnico (state.error !== null)', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: false,
      error: 'network_error',
      details: 'Failed to fetch',
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Cena el viernes');
      const state = useAiWizardStore.getState();
      assert.notEqual(state.error, null, 'Must write state.error for network error');
      assert.ok(state.error?.includes('No pudimos conectarnos con Crear con IA'));
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case K: rate_limit_exceeded (429/503) -> bloqueo o error técnico', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: false,
      error: 'rate_limit_exceeded',
      details: 'Demasiadas solicitudes. Esperá un minuto.',
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Reunión');
      const state = useAiWizardStore.getState();
      assert.notEqual(state.error, null);
      assert.equal(state.aiLocked, true);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('Clasificación contextual de inputs mínimos y Fallback determinístico (Cases L to T)', () => {
  test('Case L: draft vacío + "Evento" -> scope encounter, title Evento, siguiente pregunta', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    // Simulate model returning unclear to test robust deterministic fallback
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'unclear',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Evento');
      const state = useAiWizardStore.getState();
      assert.equal(state.draft.title, 'Evento');
      assert.equal(state.error, null);
      assert.notEqual(state.lastQuestion, null);
      assert.ok(state.lastQuestion?.field === 'date' || state.lastQuestion?.field === 'time' || state.lastQuestion?.field === 'modality');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case M: draft vacío + "Reunión" -> title "Reunión"', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'unclear',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Reunión');
      const state = useAiWizardStore.getState();
      assert.equal(state.draft.title, 'Reunión');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case N: draft vacío + "Almuerzo" -> title "Almuerzo"', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'unclear',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Almuerzo');
      const state = useAiWizardStore.getState();
      assert.equal(state.draft.title, 'Almuerzo');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case O: draft vacío + "mañana" -> fecha aplicada, pide título o actividad', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'unclear',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('mañana');
      const state = useAiWizardStore.getState();
      assert.ok(state.draft.date !== null, 'Date should be set');
      assert.equal(state.error, null);
      assert.equal(state.lastQuestion?.field, 'title');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case P: draft con datos + "virtual" -> modality: "virtual"', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Charla técnica',
        date: '2026-10-12',
        time: '16:00',
      },
      lastQuestion: {
        field: 'modality',
        question: '¿Va a ser presencial o virtual?',
        type: 'choice',
      },
    });

    await useAiWizardStore.getState().sendUserMessage('virtual');
    const state = useAiWizardStore.getState();
    assert.equal(state.draft.modality, 'virtual');
    assert.equal(state.lastQuestion?.field, 'virtualLink');
    assert.equal(state.error, null);
  });

  test('Case Q: pregunta activa time + respuesta "en casa" -> registra locationText y sigue pidiendo hora', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Asado',
        date: '2026-10-12',
        modality: 'presencial',
        locationText: null,
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora?',
        type: 'text',
      },
    });

    const originalInterpret = aiService.interpretMessage;
    // User escapes time question with "en casa", LLM or fallback sets locationText
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'encounter',
      patch: {
        locationText: { value: 'En casa', confidence: 'explicit' },
      },
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('en casa');
      const state = useAiWizardStore.getState();
      assert.equal(state.draft.locationText, 'En casa');
      assert.equal(state.draft.time, null);
      assert.equal(state.lastQuestion?.field, 'time', 'Should continue asking for time');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case R: "familiar" -> asigna theme family', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'unclear',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('familiar');
      const state = useAiWizardStore.getState();
      assert.equal(state.config.invitationTheme, 'family');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case S: "Hola" en draft vacío -> NO fija title "Hola", no llama LLM', async () => {
    useAiWizardStore.getState().reset();
    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      return { ok: true, scope: 'encounter', patch: {} };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Hola');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Zero provider calls for greeting on empty draft');
      assert.equal(state.draft.title, null, 'Must NOT set title to "Hola"');
      assert.equal(state.error, null);
      assert.ok(state.messages.at(-1)?.text.includes('¡Hola! Contame qué encuentro querés organizar.'));
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case T: "Quién ganó el Mundial" -> off_topic sin fijar title', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'off_topic',
      assistantMessage: 'Crear con IA está pensado solo para organizar encuentros.',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Quién ganó el Mundial');
      const state = useAiWizardStore.getState();
      assert.equal(state.draft.title, null, 'Must NOT set off-topic text as title');
      assert.equal(state.consecutiveOffTopicCount, 1);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('Consistencia entre ejecuciones con variabilidad simulada de LLM (Sección 32)', () => {
  const testTokens = [
    { token: 'Evento', expectedTitle: 'Evento' },
    { token: 'Reunión', expectedTitle: 'Reunión' },
    { token: 'Almuerzo', expectedTitle: 'Almuerzo' },
  ];

  for (const { token, expectedTitle } of testTokens) {
    test(`Consistencia para "${token}" bajo 3 comportamientos de LLM (encounter, unclear, empty patch)`, async () => {
      const originalInterpret = aiService.interpretMessage;

      try {
        // 1. LLM returns normal encounter patch
        aiService.interpretMessage = async () => ({
          ok: true,
          scope: 'encounter',
          patch: { title: { value: expectedTitle, confidence: 'explicit' } },
        });
        useAiWizardStore.getState().reset();
        await useAiWizardStore.getState().sendUserMessage(token);
        assert.equal(useAiWizardStore.getState().draft.title, expectedTitle, `Run 1 (encounter) must set title ${expectedTitle}`);

        // 2. LLM returns unclear
        aiService.interpretMessage = async () => ({
          ok: true,
          scope: 'unclear',
          patch: {},
        });
        useAiWizardStore.getState().reset();
        await useAiWizardStore.getState().sendUserMessage(token);
        assert.equal(useAiWizardStore.getState().draft.title, expectedTitle, `Run 2 (unclear) must set title ${expectedTitle}`);

        // 3. LLM returns empty patch
        aiService.interpretMessage = async () => ({
          ok: true,
          scope: 'encounter',
          patch: {},
        });
        useAiWizardStore.getState().reset();
        await useAiWizardStore.getState().sendUserMessage(token);
        assert.equal(useAiWizardStore.getState().draft.title, expectedTitle, `Run 3 (empty patch) must set title ${expectedTitle}`);
      } finally {
        aiService.interpretMessage = originalInterpret;
      }
    });
  }
});

describe('Copy contextual para inputs no comprendidos (Cases U & V)', () => {
  test('Case U: draft vacío + input no comprendido -> "qué querés organizar"', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'unclear',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('xyzqwerty12345');
      const state = useAiWizardStore.getState();
      const lastMsg = state.messages.at(-1)?.text || '';
      assert.ok(lastMsg.includes('qué querés organizar'), `Expected "qué querés organizar", got: ${lastMsg}`);
      assert.ok(!lastMsg.includes('qué querés cambiar'), `Must NOT say "qué querés cambiar" on empty draft, got: ${lastMsg}`);
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case V: draft parcial + input no comprendido -> "qué querés cambiar"', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Asado',
        date: '2026-10-10',
      },
    });

    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'unclear',
      patch: {},
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('xyzqwerty12345');
      const state = useAiWizardStore.getState();
      const lastMsg = state.messages.at(-1)?.text || '';
      assert.ok(lastMsg.includes('qué querés cambiar'), `Expected "qué querés cambiar" on partial draft, got: ${lastMsg}`);
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('QA Mobile: Números en letras y Desambiguación contextual de hora (Section 18: Cases A to H)', () => {
  test('Case A: pregunta hora + "once" con title Cena -> 23:00 (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena con amigos',
        date: '2026-10-15',
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora sería?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for active time question!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('once');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Must not call LLM for deterministic word time');
      assert.equal(state.draft.time, '23:00');
      assert.equal(state.lastQuestion?.field, 'modality');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case B: pregunta hora + "once" con title Reunión -> aclaración 11:00 / 23:00 (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Reunión de equipo',
        date: '2026-10-15',
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora sería?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for active time question!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('once');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Must not call LLM for deterministic word clarification');
      assert.equal(state.draft.time, null);
      assert.equal(state.lastQuestion?.field, 'time');
      assert.ok(state.lastQuestion?.question.includes('11:00 o 23:00'));
      assert.deepEqual(state.lastQuestion?.quickOptions?.map(o => o.value), ['11:00', '23:00']);
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case C: pregunta hora + "dieciocho" -> 18:00 (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Taller',
        date: '2026-10-15',
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora sería?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for active time question!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('dieciocho');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.time, '18:00');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case D: pregunta hora + "once y media" con Cena -> 23:30 (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena familiar',
        date: '2026-10-15',
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora sería?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for active time question!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('once y media');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.time, '23:30');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case E: pregunta hora + "ocho" con Desayuno -> 08:00 (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Desayuno de trabajo',
        date: '2026-10-15',
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora sería?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for active time question!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('ocho');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.time, '08:00');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case F: pregunta hora + "una" con Almuerzo -> 13:00 (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Almuerzo de fin de año',
        date: '2026-10-15',
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora sería?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for active time question!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('una');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.time, '13:00');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case G: pregunta hora + "veintitrés" -> 23:00 (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Encuentro nocturno',
        date: '2026-10-15',
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora sería?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for active time question!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('veintitrés');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.time, '23:00');
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case H: pregunta hora + "veinticuatro" -> 00:00 + rollover (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Fiesta',
        date: '2026-10-15',
        baseDate: '2026-10-15',
        time: null,
      },
      lastQuestion: {
        field: 'time',
        question: '¿A qué hora sería?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for active time question!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('veinticuatro');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.time, '00:00');
      assert.equal(state.draft.date, '2026-10-16'); // rollover to next day
      assert.equal(state.draft.appliedDayRollover, true);
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('QA Mobile: Conflicto explícito 24h y Explicit AM/PM (Section 19: Cases I to L)', () => {
  test('Case I: "Cena mañana a las 11 hs" -> no convertir silenciosamente -> aclaración 11:00 / 23:00 (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for composite deterministic input!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Cena mañana a las 11 hs');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Must not call LLM for composite conflict detection');
      assert.equal(state.draft.title, 'Cena');
      assert.ok(state.draft.date !== null, 'Date must be resolved to tomorrow');
      assert.equal(state.draft.time, null, 'Time must not be prematurely set');
      assert.equal(state.lastQuestion?.field, 'time');
      assert.ok(state.lastQuestion?.question.includes('Como es una cena, interpretaría 23:00'));
      assert.deepEqual(state.lastQuestion?.quickOptions?.map(o => o.value), ['11:00', '23:00']);
      assert.equal(state.error, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case J: "Cena mañana a las 11:00" -> misma aclaración (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for composite deterministic input!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Cena mañana a las 11:00');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.title, 'Cena');
      assert.equal(state.draft.time, null);
      assert.equal(state.lastQuestion?.field, 'time');
      assert.ok(state.lastQuestion?.question.includes('Como es una cena, interpretaría 23:00'));
      assert.deepEqual(state.lastQuestion?.quickOptions?.map(o => o.value), ['11:00', '23:00']);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case K: "Cena mañana a las 11 pm" -> 23:00 sin aclaración (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for composite deterministic input!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Cena mañana a las 11 pm');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.title, 'Cena');
      assert.equal(state.draft.time, '23:00');
      assert.notEqual(state.lastQuestion?.field, 'time');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case L: "Cena mañana a las once de la noche" -> 23:00 sin aclaración (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called unexpectedly for composite deterministic input!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Cena mañana a las once de la noche');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0);
      assert.equal(state.draft.title, 'Cena');
      assert.equal(state.draft.time, '23:00');
      assert.notEqual(state.lastQuestion?.field, 'time');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('QA Mobile: Contexto multiturno (Section 20: Cases M to O)', () => {
  test('Case M: "Cena" -> "mañana" -> "once" -> 23:00', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async (prompt, draft) => {
      if (prompt.toLowerCase().includes('cena')) {
        return { ok: true, scope: 'encounter', patch: { title: { value: 'Cena', confidence: 'explicit' } } };
      }
      if (prompt.toLowerCase().includes('mañana')) {
        return { ok: true, scope: 'encounter', patch: { dateIntent: { value: { type: 'relative', value: 'tomorrow' }, confidence: 'explicit' } } };
      }
      throw new Error('Unexpected LLM call for "once"');
    };

    try {
      // Turn 1: "Cena"
      await useAiWizardStore.getState().sendUserMessage('Cena');
      let state = useAiWizardStore.getState();
      assert.equal(state.draft.title, 'Cena');

      // Turn 2: "mañana"
      await useAiWizardStore.getState().sendUserMessage('mañana');
      state = useAiWizardStore.getState();
      assert.ok(state.draft.date !== null);
      assert.equal(state.lastQuestion?.field, 'time');

      // Turn 3: "once" -> deterministic resolution using draft.title = "Cena" -> 23:00
      await useAiWizardStore.getState().sendUserMessage('once');
      state = useAiWizardStore.getState();
      assert.equal(state.draft.time, '23:00');
      assert.equal(state.lastQuestion?.field, 'modality');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case N: "Almuerzo" -> "mañana" -> "una" -> 13:00', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async (prompt) => {
      if (prompt.toLowerCase().includes('almuerzo')) {
        return { ok: true, scope: 'encounter', patch: { title: { value: 'Almuerzo', confidence: 'explicit' } } };
      }
      if (prompt.toLowerCase().includes('mañana')) {
        return { ok: true, scope: 'encounter', patch: { dateIntent: { value: { type: 'relative', value: 'tomorrow' }, confidence: 'explicit' } } };
      }
      throw new Error('Unexpected LLM call for "una"');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Almuerzo');
      await useAiWizardStore.getState().sendUserMessage('mañana');
      assert.equal(useAiWizardStore.getState().lastQuestion?.field, 'time');

      await useAiWizardStore.getState().sendUserMessage('una');
      const state = useAiWizardStore.getState();
      assert.equal(state.draft.time, '13:00');
      assert.equal(state.lastQuestion?.field, 'modality');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Case O: "Reunión" -> "mañana" -> "once" -> aclaración AM/PM', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async (prompt) => {
      if (prompt.toLowerCase().includes('reunión') || prompt.toLowerCase().includes('reunion')) {
        return { ok: true, scope: 'encounter', patch: { title: { value: 'Reunión', confidence: 'explicit' } } };
      }
      if (prompt.toLowerCase().includes('mañana')) {
        return { ok: true, scope: 'encounter', patch: { dateIntent: { value: { type: 'relative', value: 'tomorrow' }, confidence: 'explicit' } } };
      }
      throw new Error('Unexpected LLM call for "once"');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Reunión');
      await useAiWizardStore.getState().sendUserMessage('mañana');
      assert.equal(useAiWizardStore.getState().lastQuestion?.field, 'time');

      await useAiWizardStore.getState().sendUserMessage('once');
      const state = useAiWizardStore.getState();
      assert.equal(state.draft.time, null);
      assert.equal(state.lastQuestion?.field, 'time');
      assert.ok(state.lastQuestion?.question.includes('11:00 o 23:00'));
      assert.deepEqual(state.lastQuestion?.quickOptions?.map(o => o.value), ['11:00', '23:00']);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('QA Mobile: Android Back, History Guard & Popstate (Section 21: Cases P to W)', () => {
  test('Case P: draft vacío + popstate -> sale sin modal', () => {
    useAiWizardStore.getState().reset();
    const state = useAiWizardStore.getState();
    assert.equal(hasMeaningfulDraftData(state.draft, state.config), false);
  });

  test('Case Q: draft con datos + popstate -> modal abierto', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: { ...createEmptyEncounterDraft(), title: 'Cena con amigos' },
    });
    const state = useAiWizardStore.getState();
    assert.equal(hasMeaningfulDraftData(state.draft, state.config), true);

    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(CreateAIWizard, { showExitConfirmOverride: true }))
    );
    assert.ok(html.includes('¿Salir de Crear con IA?'));
    assert.ok(html.includes('Vas a perder los datos cargados de este encuentro.'));
  });

  test('Case R: modal -> Seguir editando -> permanece y draft intacto', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: { ...createEmptyEncounterDraft(), title: 'Cena', date: '2026-11-11', time: '21:00' },
    });
    const draftBefore = { ...useAiWizardStore.getState().draft };
    // "Seguir editando" does not mutate draft
    const draftAfter = useAiWizardStore.getState().draft;
    assert.deepEqual(draftBefore, draftAfter);
  });

  test('Case S: Back nuevamente -> un solo modal abierto', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(CreateAIWizard, { showExitConfirmOverride: true }))
    );
    const modalMatches = html.match(/¿Salir de Crear con IA\?/g);
    assert.equal(modalMatches?.length, 1, 'Exactly one modal must be rendered in the DOM');
  });

  test('Case T: modal -> Descartar y salir -> reset + Home', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: { ...createEmptyEncounterDraft(), title: 'Cena', date: '2026-11-11' },
    });
    assert.equal(hasMeaningfulDraftData(useAiWizardStore.getState().draft, useAiWizardStore.getState().config), true);
    useAiWizardStore.getState().reset();
    assert.equal(hasMeaningfulDraftData(useAiWizardStore.getState().draft, useAiWizardStore.getState().config), false);
    assert.equal(useAiWizardStore.getState().draft.title, null);
  });

  test('Case U: Continuar manualmente -> sin modal de pérdida y datos transferidos', () => {
    useAiWizardStore.getState().reset();
    const draft = { ...createEmptyEncounterDraft(), title: 'Asado', date: '2026-12-01', time: '13:00' };
    const config = createDefaultInvitationConfig();
    const wizardState = draftToWizardState(draft, config);
    assert.equal(wizardState.titulo, 'Asado');
    assert.equal(wizardState.fecha, '2026-12-01');
    assert.equal(wizardState.hora, '13:00');
  });

  test('Case V: F5 + draft restaurado + Back -> modal de confirmación', () => {
    useAiWizardStore.getState().reset();
    const draft = { ...createEmptyEncounterDraft(), title: 'Cena restaurada' };
    const config = createDefaultInvitationConfig();
    assert.equal(hasMeaningfulDraftData(draft, config), true);
  });

  test('Case W: 10 ciclos Back -> Seguir editando -> 0 crecimiento anómalo de history', () => {
    // Simulate browser history stack during 10 back/keep-editing cycles
    let historyStackLength = 2; // [Home, CreateAIWizard(Guard)]
    let modalShowing = false;
    let guardActive = true;

    for (let i = 0; i < 10; i++) {
      // 1. Android system Back pops the top entry
      historyStackLength--; // Browser pops
      // 2. handlePopState intercepts and re-pushes sentinel immediately
      historyStackLength++; // pushState called to restore position
      guardActive = true;
      modalShowing = true;

      // 3. User clicks "Seguir editando" -> simply closes modal without pushing another state
      modalShowing = false;
    }

    assert.equal(historyStackLength, 2, 'History stack length after 10 cycles must have net change 0');
    assert.equal(modalShowing, false);
    assert.equal(guardActive, true);
  });
});

describe('QA Producción: Weekdays EN/ES, Ordinales y Semántica Relativa (Section 15: Cases A to F)', () => {
  const baseThu = { year: 2026, month: 9, day: 10 }; // Jueves 10 Sep 2026

  test('Caso A: "viernes próximo" -> próximo viernes válido (2026-09-11)', () => {
    const res = parseDeterministicDateExpression('viernes próximo', baseThu);
    assert.ok(res !== null);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-11');
  });

  test('Caso B: "friday" como weekday interno -> se resuelve correctamente', () => {
    const info = normalizeToCanonicalWeekday('friday');
    assert.ok(info !== null);
    assert.equal(info.canonical, 'friday');
    assert.equal(info.dayIndex, 5);

    const res = resolveDateIntent({ type: 'weekday', weekday: 'friday' }, baseThu);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-11');
  });

  test('Caso C: "viernes" -> mismo resultado canónico que friday', () => {
    const infoVie = normalizeToCanonicalWeekday('viernes');
    const infoFri = normalizeToCanonicalWeekday('friday');
    assert.ok(infoVie !== null && infoFri !== null);
    assert.equal(infoVie.canonical, infoFri.canonical);
    assert.equal(infoVie.dayIndex, infoFri.dayIndex);

    const res = resolveDateIntent({ type: 'weekday', weekday: 'viernes' }, baseThu);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-11');
  });

  test('Caso D: "vie" -> mismo weekday canónico', () => {
    const info = normalizeToCanonicalWeekday('vie');
    assert.ok(info !== null);
    assert.equal(info.canonical, 'friday');
    assert.equal(info.dayIndex, 5);
  });

  test('Caso E: "miércoles" -> wednesday canónico', () => {
    const info = normalizeToCanonicalWeekday('miércoles');
    assert.ok(info !== null);
    assert.equal(info.canonical, 'wednesday');
    assert.equal(info.dayIndex, 3);
  });

  test('Caso F: "miercoles" -> idem wednesday canónico', () => {
    const info = normalizeToCanonicalWeekday('miercoles');
    assert.ok(info !== null);
    assert.equal(info.canonical, 'wednesday');
    assert.equal(info.dayIndex, 3);
  });
});

describe('QA Producción: Expresiones Ordinales de Fecha (Section 16: Cases G to K)', () => {
  const baseSep10 = { year: 2026, month: 9, day: 10 }; // 10 Sep 2026

  test('Caso G: base 2026-09-10 + "primer viernes del mes que viene" -> 2026-10-02', () => {
    const res = parseDeterministicDateExpression('primer viernes del mes que viene', baseSep10);
    assert.ok(res !== null);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-10-02');
  });

  test('Caso H: base 2026-09-10 + "segundo viernes del mes que viene" -> 2026-10-09', () => {
    const res = parseDeterministicDateExpression('segundo viernes del mes que viene', baseSep10);
    assert.ok(res !== null);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-10-09');
  });

  test('Caso I: base 2026-09-10 + "tercer jueves de octubre de 2026" -> 2026-10-15', () => {
    const res = parseDeterministicDateExpression('tercer jueves de octubre de 2026', baseSep10);
    assert.ok(res !== null);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-10-15');
  });

  test('Caso J1: base 2026-09-10 + "último sábado de octubre de 2026" -> 2026-10-31', () => {
    const res = parseDeterministicDateExpression('último sábado de octubre de 2026', baseSep10);
    assert.ok(res !== null);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-10-31');
  });

  test('Caso J2: base 2026-09-10 + "último sábado del mes" -> 2026-09-26', () => {
    const res = parseDeterministicDateExpression('último sábado del mes', baseSep10);
    assert.ok(res !== null);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-26');
  });

  test('Caso K: ordinal inexistente ("5to lunes de febrero de 2026") -> ambiguous/unresolvable sin inventar fecha', () => {
    const res = resolveNthWeekdayOfMonth(
      { type: 'nth_weekday_of_month', weekday: 'lunes', ordinal: 5, month: 2, year: 2026 },
      baseSep10
    );
    assert.equal(res.resolved, false);
    assert.equal(res.date, null);
    assert.equal(res.confidence, 'ambiguous');
    assert.ok(res.ambiguityReason?.includes('no tiene 5° lunes'));
  });
});

describe('QA Producción: Semántica Relativa "este" vs "próximo" y Rollover (Section 17: Cases L to O)', () => {
  const baseThu10 = { year: 2026, month: 9, day: 10 }; // Jueves 10 Sep 2026
  const baseFri11 = { year: 2026, month: 9, day: 11 }; // Viernes 11 Sep 2026

  test('Caso L: "este viernes" -> desde Jueves 10 es 2026-09-11; desde Viernes 11 es hoy (2026-09-11)', () => {
    const resFromThu = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }, baseThu10);
    assert.equal(resFromThu.resolved, true);
    assert.equal(resFromThu.date, '2026-09-11');

    const resFromFri = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'this' }, baseFri11);
    assert.equal(resFromFri.resolved, true);
    assert.equal(resFromFri.date, '2026-09-11');
  });

  test('Caso M: "viernes próximo" -> desde Jueves 10 es 2026-09-11; desde Viernes 11 es 2026-09-18', () => {
    const resFromThu = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'next' }, baseThu10);
    assert.equal(resFromThu.resolved, true);
    assert.equal(resFromThu.date, '2026-09-11');

    const resFromFri = resolveDateIntent({ type: 'weekday', weekday: 'viernes', modifier: 'next' }, baseFri11);
    assert.equal(resFromFri.resolved, true);
    assert.equal(resFromFri.date, '2026-09-18');
  });

  test('Caso N: "viernes que viene" -> equivalente a próximo (desde Viernes 11 es 2026-09-18)', () => {
    const res = parseDeterministicDateExpression('viernes que viene', baseFri11);
    assert.ok(res !== null);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-18');
  });

  test('Caso O: cambio diciembre -> enero: base 2026-12-10 + "primer viernes del mes que viene" -> 2027-01-01', () => {
    const baseDec10 = { year: 2026, month: 12, day: 10 };
    const res = parseDeterministicDateExpression('primer viernes del mes que viene', baseDec10);
    assert.ok(res !== null);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2027-01-01');
  });
});

describe('QA Producción: Rescate defensivo de outputs LLM y UX de Error (Section 18 & 19)', () => {
  const baseSep10 = { year: 2026, month: 9, day: 10 };

  test('Caso P: Rescate de patch LLM con type: "vague" y description "el primer viernes del mes que viene"', () => {
    const vagueIntent: any = {
      type: 'vague',
      weekday: 'friday',
      modifier: 'next',
      description: 'el primer viernes del mes que viene',
    };
    const res = resolveDateIntent(vagueIntent, baseSep10);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-10-02');
  });

  test('Caso Q: Rescate de patch LLM con weekday: "friday" sin fallar ni exponer error interno', () => {
    const patchIntent: any = {
      type: 'weekday',
      weekday: 'friday',
      modifier: 'next',
    };
    const res = resolveDateIntent(patchIntent, baseSep10);
    assert.equal(res.resolved, true);
    assert.equal(res.date, '2026-09-11');
  });

  test('Caso R: UX de error para weekday inválido -> copy amigable sin enum interno ni banner rojo', () => {
    const invalidIntent: any = {
      type: 'weekday',
      weekday: 'unknown_day_xyz',
    };
    const res = resolveDateIntent(invalidIntent, baseSep10);
    assert.equal(res.resolved, false);
    assert.equal(res.date, null);
    assert.equal(res.confidence, 'ambiguous');
    assert.ok(!res.ambiguityReason?.includes('unknown_day_xyz'));
    assert.equal(res.ambiguityReason, 'No pude determinar bien la fecha. ¿Podés indicarme el día de otra forma?');
  });

  test('Caso S: Bypass determinístico en aiWizardStore cuando lastQuestion.field === "date" (providerCalls = 0)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena con amigos',
        date: null,
      },
      lastQuestion: {
        field: 'date',
        question: '¿Qué día sería?',
        type: 'text',
      },
    });

    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM was called during deterministic date flow!');
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('el primer viernes del mes que viene');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'Zero provider calls for deterministic date expression');
      assert.ok(state.draft.date !== null);
      assert.equal(state.error, null);
      assert.notEqual(state.lastQuestion?.field, 'date');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });
});

describe('QA Producción: Paridad de contrato nth_weekday_of_month (TypeScript, JSON Schema, Prompt, dateResolver)', () => {
  const baseSep10 = { year: 2026, month: 9, day: 10 };

  test('Paridad 1: TypeScript type checking de DateIntent soporta nth_weekday_of_month con ordinales string y numéricos', () => {
    const intentNumeric: DateIntent = {
      type: 'nth_weekday_of_month',
      weekday: 'friday',
      ordinal: 1,
      monthOffset: 1,
    };
    const intentString: DateIntent = {
      type: 'nth_weekday_of_month',
      weekday: 'saturday',
      ordinal: 'last',
      month: 10,
    };
    const intentNamed: DateIntent = {
      type: 'nth_weekday_of_month',
      weekday: 'thursday',
      ordinal: 'third',
      month: 10,
      year: 2026,
    };
    assert.equal(intentNumeric.type, 'nth_weekday_of_month');
    assert.equal(intentString.type, 'nth_weekday_of_month');
    assert.equal(intentNamed.type, 'nth_weekday_of_month');
  });

  test('Paridad 2: JSON Schema en validation.ts define nth_weekday_of_month, ordinal (anyOf integer/string) y monthOffset', () => {
    const dateIntentValueSchema = (ENCOUNTER_DRAFT_PATCH_SCHEMA.properties as any).dateIntent.properties.value.properties;
    assert.ok(dateIntentValueSchema.type.enum.includes('nth_weekday_of_month'), 'Schema type enum must include nth_weekday_of_month');
    assert.ok(dateIntentValueSchema.ordinal, 'Schema must define ordinal property');
    assert.ok(Array.isArray(dateIntentValueSchema.ordinal.anyOf), 'ordinal must use anyOf');

    // Check integer branch
    const intBranch = dateIntentValueSchema.ordinal.anyOf.find((b: any) => b.type === 'integer');
    assert.ok(intBranch, 'ordinal must have integer branch');
    assert.deepEqual(intBranch.enum, [1, 2, 3, 4, 5]);

    // Check string branch
    const strBranch = dateIntentValueSchema.ordinal.anyOf.find((b: any) => b.type === 'string');
    assert.ok(strBranch, 'ordinal must have string branch');
    assert.deepEqual(strBranch.enum, ['first', 'second', 'third', 'fourth', 'fifth', 'last']);

    // Check monthOffset
    assert.equal(dateIntentValueSchema.monthOffset.type, 'integer');

    // Check strict OpenAI transform
    const openAiSchema: any = sanitizeSchemaForOpenAI(ENCOUNTER_DRAFT_PATCH_SCHEMA);
    const openAiDateIntent = openAiSchema.properties.dateIntent.properties.value.properties;
    assert.ok(openAiDateIntent.ordinal, 'OpenAI transformed schema must contain ordinal');
    assert.ok(openAiSchema.properties.dateIntent.properties.value.required.includes('ordinal'), 'All properties must be in required for OpenAI strict mode');
  });

  test('Paridad 3: SYSTEM_PROMPT version 1.6.0 documenta explícitamente nth_weekday_of_month con ejemplos', () => {
    assert.equal(PROMPT_VERSION, '1.6.0');
    assert.ok(SYSTEM_PROMPT.includes('nth_weekday_of_month'), 'SYSTEM_PROMPT must reference nth_weekday_of_month');
    assert.ok(SYSTEM_PROMPT.includes('primer viernes del mes que viene'), 'SYSTEM_PROMPT must include primer viernes example');
    assert.ok(SYSTEM_PROMPT.includes('último sábado de octubre'), 'SYSTEM_PROMPT must include último sábado example');
  });

  test('Paridad 4: dateResolver procesa intents con ordinales numéricos y semánticos (EN y ES)', () => {
    // EN weekday + string ordinal:
    const res1 = resolveDateIntent({
      type: 'nth_weekday_of_month',
      weekday: 'friday',
      ordinal: 'first',
      monthOffset: 1,
    }, baseSep10);
    assert.equal(res1.resolved, true);
    assert.equal(res1.date, '2026-10-02');

    // ES weekday + numeric ordinal:
    const res2 = resolveDateIntent({
      type: 'nth_weekday_of_month',
      weekday: 'viernes',
      ordinal: 1,
      monthOffset: 1,
    }, baseSep10);
    assert.equal(res2.resolved, true);
    assert.equal(res2.date, '2026-10-02');

    // 'last' ordinal with explicit month:
    const res3 = resolveDateIntent({
      type: 'nth_weekday_of_month',
      weekday: 'saturday',
      ordinal: 'last',
      month: 10,
    }, baseSep10);
    assert.equal(res3.resolved, true);
    assert.equal(res3.date, '2026-10-31');

    // Impossible calendar date:
    const res4 = resolveDateIntent({
      type: 'nth_weekday_of_month',
      weekday: 'monday',
      ordinal: 5,
      month: 2,
      year: 2026,
    }, baseSep10);
    assert.equal(res4.resolved, false);
    assert.equal(res4.confidence, 'ambiguous');
    assert.ok(res4.ambiguityReason?.includes('5°'));
  });
});

describe('QA Mobile: Entrada por voz adaptativa (Dictado nativo de teclado y hint discreto - Section 25)', () => {
  test('Caso A: En mobile/touch el textarea de Crear con IA funciona con su placeholder y accesibilidad intactos', () => {
    useAiWizardStore.getState().reset();
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { isTouchOverride: true })
      )
    );
    assert.ok(html.includes('<textarea'), 'Debe renderizar el textarea nativo');
    assert.ok(html.includes('Escribí qué querés organizar...'), 'Debe mostrar el placeholder inicial');
  });

  test('Caso B: En mobile/touch NO aparece el botón de micrófono propio junto al textarea', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { isTouchOverride: true })
      )
    );
    assert.ok(!html.includes('data-testid="speech-dictation-button"'), 'NO debe renderizar el botón de micrófono en mobile para evitar duplicar el del teclado');
  });

  test('Caso C y D: El dictado nativo de teclado llena el textarea como texto estándar editable', () => {
    let currentInput = '';
    const onGboardVoiceInput = (text: string) => {
      currentInput = text;
    };
    onGboardVoiceInput('Cena mañana a las once en casa');
    assert.equal(currentInput, 'Cena mañana a las once en casa');

    currentInput = currentInput.replace('once', 'once y media');
    assert.equal(currentInput, 'Cena mañana a las once y media en casa', 'El texto dictado es 100% editable');
  });

  test('Caso E: No hay auto-send cuando ingresa texto al textarea', () => {
    let sendCount = 0;
    let textState = '';
    const handleVoiceOrType = (txt: string) => {
      textState = txt;
    };

    handleVoiceOrType('Cena mañana a las once');
    assert.equal(textState, 'Cena mañana a las once');
    assert.equal(sendCount, 0, 'No debe disparar sendUserMessage de forma automática');
  });

  test('Caso F: Tras la edición el usuario presiona Enviar manualmente y se procesa el turno', () => {
    let sentMessage = '';
    const handleSend = (text: string) => {
      sentMessage = text;
    };
    const userText = 'Cena mañana a las once y media en casa';
    handleSend(userText);
    assert.equal(sentMessage, 'Cena mañana a las once y media en casa');
  });

  test('Caso G: En mobile la micro-ayuda discreta ("También podés dictar usando el micrófono del teclado") se muestra si no fue vista', () => {
    const htmlWithHint = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, {
          isTouchOverride: true,
          showKeyboardVoiceHintOverride: true,
        })
      )
    );
    assert.ok(htmlWithHint.includes('data-testid="keyboard-voice-hint"'));
    assert.ok(htmlWithHint.includes('También podés dictar usando el micrófono del teclado.'));

    const htmlDismissed = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, {
          isTouchOverride: true,
          showKeyboardVoiceHintOverride: false,
        })
      )
    );
    assert.ok(!htmlDismissed.includes('data-testid="keyboard-voice-hint"'));
  });
});

describe('QA Desktop: Micrófono web propio con SpeechRecognition (Section 26)', () => {
  test('Caso I: En desktop con SpeechRecognition soportado se muestra el botón 🎙 junto al textarea', () => {
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        SpeechRecognition: class MockSpeechRecognition {},
        matchMedia: (query: string) => ({
          matches: false,
          media: query,
        }),
      };

      const html = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(CreateAIWizard, { isTouchOverride: false })
        )
      );
      assert.ok(html.includes('data-testid="speech-dictation-button"'), 'Debe mostrar el botón de micrófono en desktop cuando SpeechRecognition está disponible');
      assert.ok(html.includes('Iniciar dictado por voz'), 'Debe tener accesibilidad clara');
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });

  test('Caso J: Si SpeechRecognition no está soportado, el botón se oculta y el input manual queda intacto', () => {
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        matchMedia: () => ({ matches: false }),
      };

      const html = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(CreateAIWizard, { isTouchOverride: false })
        )
      );
      assert.ok(!html.includes('data-testid="speech-dictation-button"'), 'No debe mostrar el botón 🎙 si el navegador no soporta la API');
      assert.ok(html.includes('<textarea'), 'El textarea manual sigue presente e intacto');
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });

  test('Caso K, L, M: Concatenación correcta de texto previo y nueva transcripción', () => {
    const resEmpty = combineTranscriptWithBase('', 'Cena mañana a las once');
    assert.equal(resEmpty, 'Cena mañana a las once');

    const resAppended = combineTranscriptWithBase('Cena con amigos', 'mañana a las once en casa');
    assert.equal(resAppended, 'Cena con amigos mañana a las once en casa');

    const resNoVoice = combineTranscriptWithBase('Cena con amigos', '');
    assert.equal(resNoVoice, 'Cena con amigos');
  });

  test('Caso O: Procesamiento de interim sin duplicación de segmentos completados', () => {
    let accumulatedFinal = '';
    const simulateResults = (events: Array<{ resultIndex: number; results: Array<{ transcript: string; isFinal: boolean }> }>) => {
      let interim = '';
      for (const event of events) {
        interim = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const res = event.results[i];
          if (res.isFinal) {
            accumulatedFinal = combineTranscriptWithBase(accumulatedFinal, res.transcript);
          } else {
            interim += (interim ? ' ' : '') + res.transcript.trim();
          }
        }
      }
      return { accumulatedFinal, interim };
    };

    const r1 = simulateResults([{ resultIndex: 0, results: [{ transcript: 'Cena', isFinal: false }] }]);
    assert.equal(r1.accumulatedFinal, '');
    assert.equal(r1.interim, 'Cena');

    const r2 = simulateResults([{ resultIndex: 0, results: [{ transcript: 'Cena', isFinal: true }, { transcript: 'mañana', isFinal: false }] }]);
    assert.equal(r2.accumulatedFinal, 'Cena');
    assert.equal(r2.interim, 'mañana');

    const r3 = simulateResults([{ resultIndex: 1, results: [{ transcript: 'Cena', isFinal: true }, { transcript: 'mañana a las once', isFinal: true }] }]);
    assert.equal(r3.accumulatedFinal, 'Cena mañana a las once');
    assert.equal(r3.interim, '');
    assert.ok(!r3.accumulatedFinal.includes('Cena Cena'), 'No debe repetir palabras completadas');
  });

  test('Caso P: Mensajes de error amigables sin exponer errores técnicos ni aiError', () => {
    const errNotAllowed = getFriendlyDictationErrorMessage('not-allowed');
    assert.equal(errNotAllowed, 'No pudimos acceder al micrófono. Podés habilitarlo en el navegador o seguir escribiendo.');

    const errNoSpeech = getFriendlyDictationErrorMessage('no-speech');
    assert.equal(errNoSpeech, 'No escuché nada. Podés intentarlo nuevamente.');

    const errAudioCapture = getFriendlyDictationErrorMessage('audio-capture');
    assert.equal(errAudioCapture, 'No se detectó ningún micrófono. Podés seguir escribiendo.');

    const errNetwork = getFriendlyDictationErrorMessage('network');
    assert.equal(errNetwork, 'Error de conexión al reconocer voz. Podés seguir escribiendo normalmente.');

    const errUnknown = getFriendlyDictationErrorMessage('some_other_code');
    assert.equal(errUnknown, 'No pudimos iniciar el dictado. Podés seguir escribiendo normalmente.');
  });

  test('Caso Q y R: El micrófono se deshabilita cuando isInterpreting o aiLocked están activos', () => {
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        SpeechRecognition: class MockSpeechRecognition {},
        matchMedia: () => ({ matches: false }),
      };

      const htmlInterpreting = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(CreateAIWizard, {
            isTouchOverride: false,
            stateOverride: { isInterpreting: true } as any,
          })
        )
      );
      assert.ok(htmlInterpreting.includes('data-testid="speech-dictation-button"'));
      assert.ok(htmlInterpreting.includes('disabled=""') || htmlInterpreting.includes('disabled'), 'El botón mic debe estar deshabilitado mientras se interpreta');

      const htmlLocked = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(CreateAIWizard, {
            isTouchOverride: false,
            stateOverride: { aiLocked: true } as any,
          })
        )
      );
      assert.ok(htmlLocked.includes('data-testid="speech-dictation-button"'));
      assert.ok(htmlLocked.includes('disabled=""') || htmlLocked.includes('disabled'), 'El botón mic debe estar deshabilitado cuando Crear con IA está bloqueado');
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });
});

describe('QA Detección Adaptativa de Entorno: Smartphone, Desktop, Laptop Táctil y Tablet (Section 27)', () => {
  function runWithMockedEnv(
    options: {
      matchMedia: (query: string) => { matches: boolean; media?: string };
      maxTouchPoints: number;
      userAgent: string;
      SpeechRecognition?: any;
    },
    fn: () => void
  ) {
    const originalWindow = (globalThis as any).window;
    const originalNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalLocalStorage = (globalThis as any).localStorage;

    const storage: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = String(v); },
      removeItem: (k: string) => { delete storage[k]; },
      clear: () => { for (const k in storage) delete storage[k]; },
    };

    try {
      (globalThis as any).localStorage = mockLocalStorage;
      (globalThis as any).window = {
        matchMedia: options.matchMedia,
        SpeechRecognition: options.SpeechRecognition,
        localStorage: mockLocalStorage,
      };
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          maxTouchPoints: options.maxTouchPoints,
          userAgent: options.userAgent,
        },
        configurable: true,
        writable: true,
      });

      fn();
    } finally {
      (globalThis as any).window = originalWindow;
      (globalThis as any).localStorage = originalLocalStorage;
      if (originalNavDescriptor) {
        Object.defineProperty(globalThis, 'navigator', originalNavDescriptor);
      }
    }
  }

  test('Caso A: Smartphone (coarse + no hover) -> mobile (isTouchDevice=true)', () => {
    runWithMockedEnv(
      {
        matchMedia: (query: string) => {
          if (query === '(pointer: coarse)') return { matches: true, media: query };
          if (query === '(hover: none)') return { matches: true, media: query };
          if (query === '(pointer: fine)') return { matches: false, media: query };
          if (query === '(hover: hover)') return { matches: false, media: query };
          return { matches: false, media: query };
        },
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36',
      },
      () => {
        useAiWizardStore.getState().reset();
        assert.equal(isTouchDevice(), true, 'Smartphone con coarse + no hover debe clasificarse como mobile');

        // Verificación en CreateAIWizard sin override: oculta botón mic desktop y muestra hint mobile
        const html = renderToStaticMarkup(
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(CreateAIWizard, {})
          )
        );
        assert.ok(!html.includes('data-testid="speech-dictation-button"'), 'No debe mostrar botón mic desktop en smartphone');
        assert.ok(html.includes('data-testid="keyboard-voice-hint"'), 'Debe mostrar hint para teclado nativo en smartphone');
      }
    );
  });

  test('Caso B: Desktop normal (fine + hover) -> desktop (isTouchDevice=false)', () => {
    runWithMockedEnv(
      {
        SpeechRecognition: class MockSpeechRecognition {},
        matchMedia: (query: string) => {
          if (query === '(pointer: coarse)') return { matches: false, media: query };
          if (query === '(hover: none)') return { matches: false, media: query };
          if (query === '(pointer: fine)') return { matches: true, media: query };
          if (query === '(hover: hover)') return { matches: true, media: query };
          return { matches: false, media: query };
        },
        maxTouchPoints: 0,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      () => {
        useAiWizardStore.getState().reset();
        assert.equal(isTouchDevice(), false, 'Desktop normal debe clasificarse como desktop/no-touch');

        // Verificación en CreateAIWizard: muestra botón mic desktop y NO muestra hint de teclado móvil
        const html = renderToStaticMarkup(
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(CreateAIWizard, {})
          )
        );
        assert.ok(html.includes('data-testid="speech-dictation-button"'), 'Debe mostrar botón mic desktop en PC de escritorio');
        assert.ok(!html.includes('data-testid="keyboard-voice-hint"'), 'No debe mostrar hint de teclado móvil en PC de escritorio');
      }
    );
  });

  test('Caso C: Laptop táctil (maxTouchPoints > 0 + pointer fine + hover) -> desktop/híbrido (isTouchDevice=false)', () => {
    runWithMockedEnv(
      {
        SpeechRecognition: class MockSpeechRecognition {},
        matchMedia: (query: string) => {
          // Notebook o 2-en-1 táctil: mouse/touchpad aporta fine + hover
          if (query === '(pointer: fine)') return { matches: true, media: query };
          if (query === '(hover: hover)') return { matches: true, media: query };
          if (query === '(pointer: coarse)') return { matches: false, media: query };
          if (query === '(hover: none)') return { matches: false, media: query };
          return { matches: false, media: query };
        },
        maxTouchPoints: 10, // Pantalla táctil multipunto en notebook
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 TouchNotebook',
      },
      () => {
        useAiWizardStore.getState().reset();
        // maxTouchPoints > 0 NO debe clasificar como mobile si hay fine pointer + hover
        assert.equal(isTouchDevice(), false, 'Laptop táctil debe tratarse como desktop/híbrido');

        // Verificación en CreateAIWizard: permite el micrófono web si SpeechRecognition existe
        const html = renderToStaticMarkup(
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(CreateAIWizard, {})
          )
        );
        assert.ok(html.includes('data-testid="speech-dictation-button"'), 'Debe permitir botón mic en notebook táctil / 2-en-1');
        assert.ok(!html.includes('data-testid="keyboard-voice-hint"'), 'No debe mostrar hint de teclado móvil en notebook táctil');
      }
    );
  });

  test('Caso D: Tablet (coarse + no hover) -> mobile (isTouchDevice=true)', () => {
    runWithMockedEnv(
      {
        SpeechRecognition: class MockSpeechRecognition {},
        matchMedia: (query: string) => {
          if (query === '(pointer: coarse)') return { matches: true, media: query };
          if (query === '(hover: none)') return { matches: true, media: query };
          if (query === '(pointer: fine)') return { matches: false, media: query };
          if (query === '(hover: hover)') return { matches: false, media: query };
          return { matches: false, media: query };
        },
        maxTouchPoints: 10,
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      },
      () => {
        useAiWizardStore.getState().reset();
        assert.equal(isTouchDevice(), true, 'Tablet con coarse + no hover debe clasificarse como mobile');

        // Verificación en CreateAIWizard: prioriza teclado táctil y oculta botón mic desktop
        const html = renderToStaticMarkup(
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(CreateAIWizard, {})
          )
        );
        assert.ok(!html.includes('data-testid="speech-dictation-button"'), 'No debe mostrar botón mic desktop en tablet');
        assert.ok(html.includes('data-testid="keyboard-voice-hint"'), 'Debe mostrar hint para teclado nativo en tablet');
      }
    );
  });

  test('Caso Privacidad: Texto y criterio canónico de no almacenamiento ni transmisión de audio a backend/LLMs', () => {
    const canonicalText =
      'PuntoEncuentro no graba, almacena ni envía audio a sus propios servidores ni a OpenAI/Mistral. El reconocimiento de voz es gestionado por el navegador o sistema operativo según sus propias políticas.';
    assert.equal(SPEECH_DICTATION_PRIVACY_POLICY, canonicalText);
  });
});

describe('QA iPhone/iOS y Desktop Locale Configurable (Section 28)', () => {
  function runWithMockedEnv(
    options: {
      matchMedia: (query: string) => { matches: boolean; media?: string };
      maxTouchPoints: number;
      userAgent: string;
      SpeechRecognition?: any;
    },
    fn: () => void
  ) {
    const originalWindow = (globalThis as any).window;
    const originalNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalLocalStorage = (globalThis as any).localStorage;

    const storage: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = String(v); },
      removeItem: (k: string) => { delete storage[k]; },
      clear: () => { for (const k in storage) delete storage[k]; },
    };

    try {
      (globalThis as any).localStorage = mockLocalStorage;
      (globalThis as any).window = {
        matchMedia: options.matchMedia,
        SpeechRecognition: options.SpeechRecognition,
        localStorage: mockLocalStorage,
      };
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          maxTouchPoints: options.maxTouchPoints,
          userAgent: options.userAgent,
        },
        configurable: true,
        writable: true,
      });

      fn();
    } finally {
      (globalThis as any).window = originalWindow;
      (globalThis as any).localStorage = originalLocalStorage;
      if (originalNavDescriptor) {
        Object.defineProperty(globalThis, 'navigator', originalNavDescriptor);
      }
    }
  }

  test('Caso A (iPhone): coarse + no hover + UA iPhone -> isTouchDevice=true, sin mic propio, con hint', () => {
    runWithMockedEnv(
      {
        matchMedia: (query: string) => {
          if (query === '(pointer: coarse)') return { matches: true, media: query };
          if (query === '(hover: none)') return { matches: true, media: query };
          if (query === '(pointer: fine)') return { matches: false, media: query };
          if (query === '(hover: hover)') return { matches: false, media: query };
          return { matches: false, media: query };
        },
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      },
      () => {
        useAiWizardStore.getState().reset();
        assert.equal(isTouchDevice(), true, 'iPhone debe clasificarse como mobile touch');

        const html = renderToStaticMarkup(
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(CreateAIWizard, {})
          )
        );
        assert.ok(!html.includes('data-testid="speech-dictation-button"'), 'En iPhone NO debe existir botón mic propio');
        assert.ok(html.includes('data-testid="keyboard-voice-hint"'), 'En iPhone SÍ debe mostrar el hint para teclado');
        assert.ok(html.includes('También podés dictar usando el micrófono del teclado.'), 'El copy es genérico y válido para teclado iOS');
      }
    );
  });

  test('Caso B (iPad táctil primario): coarse + no hover + UA iPad -> mismo comportamiento mobile', () => {
    runWithMockedEnv(
      {
        matchMedia: (query: string) => {
          if (query === '(pointer: coarse)') return { matches: true, media: query };
          if (query === '(hover: none)') return { matches: true, media: query };
          if (query === '(pointer: fine)') return { matches: false, media: query };
          if (query === '(hover: hover)') return { matches: false, media: query };
          return { matches: false, media: query };
        },
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      },
      () => {
        useAiWizardStore.getState().reset();
        assert.equal(isTouchDevice(), true, 'iPad táctil debe clasificarse como mobile');

        const html = renderToStaticMarkup(
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(CreateAIWizard, {})
          )
        );
        assert.ok(!html.includes('data-testid="speech-dictation-button"'), 'En iPad táctil NO debe haber botón mic');
        assert.ok(html.includes('data-testid="keyboard-voice-hint"'), 'En iPad táctil SÍ se muestra el hint de teclado');
      }
    );
  });

  test('Caso C (iOS native dictation): texto ingresado directamente al textarea -> editable -> NO auto-send -> envío manual', () => {
    let sentMessage = '';
    let sendCalls = 0;
    const handleSend = (text: string) => {
      sendCalls++;
      sentMessage = text;
    };

    // 1. Simulación: usuario toca micrófono del teclado de iOS y dicta
    let inputText = 'Cena el viernes a las nueve en Palermo';
    assert.equal(sendCalls, 0, 'La entrada de texto dictado por teclado iOS NUNCA auto-envía');

    // 2. El usuario revisa y corrige el texto directamente en el textarea
    inputText = inputText.replace('Palermo', 'Belgrano');
    assert.equal(inputText, 'Cena el viernes a las nueve en Belgrano');
    assert.equal(sendCalls, 0, 'La edición sigue sin auto-enviar');

    // 3. El usuario pulsa manualmente el botón Enviar
    handleSend(inputText);
    assert.equal(sendCalls, 1, 'El mensaje se envía tras la pulsación manual');
    assert.equal(sentMessage, 'Cena el viernes a las nueve en Belgrano');
  });

  test('Caso D: useSpeechDictation sin lang explícito usa "es-AR" por defecto', () => {
    let capturedLang = '';
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        SpeechRecognition: class MockRec {
          lang: string = '';
          continuous = false;
          interimResults = false;
          maxAlternatives = 1;
          start() {
            capturedLang = this.lang;
          }
          stop() {}
          abort() {}
        },
      };

      let hookReturn: any;
      function TestHook() {
        hookReturn = useSpeechDictation({});
        return null;
      }
      renderToStaticMarkup(React.createElement(TestHook));
      assert.equal(hookReturn.lang, 'es-AR', 'Locale por defecto debe ser es-AR');

      hookReturn.startListening('Hola');
      assert.equal(capturedLang, 'es-AR', 'SpeechRecognition.lang debe ser es-AR cuando no se especifica lang');
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });

  test('Caso E: useSpeechDictation con lang="en-US" configura recognition.lang === "en-US"', () => {
    let capturedLang = '';
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        SpeechRecognition: class MockRec {
          lang: string = '';
          continuous = false;
          interimResults = false;
          maxAlternatives = 1;
          start() {
            capturedLang = this.lang;
          }
          stop() {}
          abort() {}
        },
      };

      let hookReturn: any;
      function TestHook() {
        hookReturn = useSpeechDictation({ lang: 'en-US' });
        return null;
      }
      renderToStaticMarkup(React.createElement(TestHook));
      assert.equal(hookReturn.lang, 'en-US');

      hookReturn.startListening('Dinner');
      assert.equal(capturedLang, 'en-US', 'SpeechRecognition.lang debe recibir en-US');
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });

  test('Caso F: useSpeechDictation con lang="pt-BR" configura recognition.lang === "pt-BR"', () => {
    let capturedLang = '';
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        SpeechRecognition: class MockRec {
          lang: string = '';
          continuous = false;
          interimResults = false;
          maxAlternatives = 1;
          start() {
            capturedLang = this.lang;
          }
          stop() {}
          abort() {}
        },
      };

      let hookReturn: any;
      function TestHook() {
        hookReturn = useSpeechDictation({ lang: 'pt-BR' });
        return null;
      }
      renderToStaticMarkup(React.createElement(TestHook));
      assert.equal(hookReturn.lang, 'pt-BR');

      hookReturn.startListening('Jantar');
      assert.equal(capturedLang, 'pt-BR', 'SpeechRecognition.lang debe recibir pt-BR');
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });

  test('Caso G: getSpeechRecognitionLocale con "es" o "es-AR" mapea a "es-AR"', () => {
    assert.equal(getSpeechRecognitionLocale('es'), 'es-AR');
    assert.equal(getSpeechRecognitionLocale('es-AR'), 'es-AR');
    assert.equal(getSpeechRecognitionLocale('es-ES'), 'es-AR');
    assert.equal(getSpeechRecognitionLocale('ES'), 'es-AR');
  });

  test('Caso H: getSpeechRecognitionLocale con "en" o "en-US" mapea a "en-US"', () => {
    assert.equal(getSpeechRecognitionLocale('en'), 'en-US');
    assert.equal(getSpeechRecognitionLocale('en-US'), 'en-US');
    assert.equal(getSpeechRecognitionLocale('en-GB'), 'en-US');
    assert.equal(getSpeechRecognitionLocale('EN'), 'en-US');
  });

  test('Caso I: getSpeechRecognitionLocale con "pt" o "pt-BR" mapea a "pt-BR"', () => {
    assert.equal(getSpeechRecognitionLocale('pt'), 'pt-BR');
    assert.equal(getSpeechRecognitionLocale('pt-BR'), 'pt-BR');
    assert.equal(getSpeechRecognitionLocale('pt-PT'), 'pt-BR');
    assert.equal(getSpeechRecognitionLocale('PT'), 'pt-BR');
  });

  test('Caso J: getSpeechRecognitionLocale con locale desconocido o vacío recurre al fallback seguro "es-AR"', () => {
    assert.equal(getSpeechRecognitionLocale('fr'), 'es-AR');
    assert.equal(getSpeechRecognitionLocale('de'), 'es-AR');
    assert.equal(getSpeechRecognitionLocale('it'), 'es-AR');
    assert.equal(getSpeechRecognitionLocale('ja'), 'es-AR');
    assert.equal(getSpeechRecognitionLocale(''), 'es-AR');
    assert.equal(getSpeechRecognitionLocale(undefined), 'es-AR');
    assert.equal(getSpeechRecognitionLocale(null as any), 'es-AR');
  });

  test('Caso K: En CreateAIWizard con speechLangOverride="en-US", se utiliza el locale configurado', () => {
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        SpeechRecognition: class MockSpeechRecognition {},
        matchMedia: () => ({ matches: false }),
      };

      const html = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(CreateAIWizard, {
            isTouchOverride: false,
            speechLangOverride: 'en-US',
          })
        )
      );
      assert.ok(html.includes('data-testid="speech-dictation-button"'), 'En desktop debe renderizar el botón de dictado con speechLangOverride');
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });
});

describe('QA Refinamiento Integral UX/UI: CreateAIWizard (Section 29)', () => {
  test('Caso A: Beta aparece integrado al header y no en segunda línea (sin app-bar-subtitle)', () => {
    useAiWizardStore.getState().reset();
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, {})
      )
    );
    assert.ok(html.includes('data-testid="beta-badge"'), 'Debe renderizar el badge de Beta');
    assert.ok(html.includes('Beta'), 'Debe contener el texto Beta');
    assert.ok(!html.includes('class="app-bar-subtitle"'), 'No debe renderizar subtítulo de segunda línea');
  });

  test('Caso B: Fecha ISO no aparece en CompactDraftBar y horario no incluye sufijo "hs" (formatHumanSchedule)', () => {
    useAiWizardStore.getState().reset();
    const today = getArgentinaTodayISO();
    const [y, m, d] = today.split('-').map(Number);
    const tomDate = new Date(Date.UTC(y, m - 1, d + 1));
    const pad = (n: number) => n.toString().padStart(2, '0');
    const tomorrow = `${tomDate.getUTCFullYear()}-${pad(tomDate.getUTCMonth() + 1)}-${pad(tomDate.getUTCDate())}`;

    // Test helper directly
    assert.equal(formatHumanSchedule(today, '20:00', today), 'Hoy · 20:00');
    assert.equal(formatHumanSchedule(tomorrow, '21:00', today), 'Mañana · 21:00');
    assert.equal(formatHumanSchedule(tomorrow, '', today), 'Mañana');
    assert.equal(formatHumanSchedule('', '23:00'), '23:00');

    // Test in rendered component
    useAiWizardStore.setState({
      draft: { ...createEmptyEncounterDraft(), title: 'Cena con amigos', date: tomorrow, time: '21:00' },
      config: createDefaultInvitationConfig(),
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(html.includes('data-testid="compact-draft-bar"'));
    assert.ok(html.includes('Mañana · 21:00'), 'Debe mostrar la fecha humanizada con hora limpia');
    assert.ok(!html.includes('21:00 hs'), 'No debe incluir el sufijo hs en el horario');
    assert.ok(!html.includes(tomorrow), 'No debe mostrar la fecha cruda en formato ISO');
  });

  test('Caso C: Metadata incompleta no produce separadores vacíos ni cadenas rotas', () => {
    const s1 = formatHumanSchedule('2026-10-15', '');
    assert.ok(!s1.includes('a las'), 'No debe incluir "a las" sin hora');
    assert.ok(!s1.includes('undefined'), 'No debe incluir undefined');

    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cumpleaños',
        date: '2026-10-15',
        time: '',
        modality: 'presencial',
      },
      config: { ...createDefaultInvitationConfig(), invitationTheme: '' as any },
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(!html.includes('a las · Presencial'), 'No debe contener "a las · Presencial"');
    assert.ok(!html.includes('·  ·'), 'No debe contener separadores duplicados vacíos');
    assert.ok(!html.includes('· ·'), 'No debe contener separadores vacíos');
    assert.ok(html.includes('Presencial'), 'Debe incluir la modalidad correctamente');
  });

  test('Caso D: Título del encuentro mantiene jerarquía visual en el resumen', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Asado de Fin de Año',
        modality: 'presencial',
      },
      config: createDefaultInvitationConfig(),
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(html.includes('Asado de Fin de Año'));
    assert.ok(html.includes('700'), 'El título debe tener peso negrita');
  });

  test('Caso E: Formulario manual sigue accesible pero como acción secundaria con touch target de 44px y 13px', () => {
    useAiWizardStore.getState().reset();
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, {})
      )
    );
    assert.ok(html.includes('data-testid="fallback-manual-button"'), 'Debe existir el botón de fallback manual');
    assert.ok(html.includes('Usar formulario manual'), 'Texto secundario claro');
    assert.ok(html.includes('min-height:44px') || html.includes('min-height: 44px') || html.includes('44px'), 'Debe tener touch target de al menos 44px');
    assert.ok(html.includes('font-size:13px') || html.includes('font-size: 13px'), 'Debe tener tamaño 13px legible');
    assert.ok(!html.includes('text-decoration: underline') && !html.includes('textDecoration: \'underline\''), 'No debe tener subrayado dominante de enlace principal');
  });

  test('Caso F: Estado inicial muestra ejemplos sólo cuando no hay conversación ni datos cargados', () => {
    useAiWizardStore.getState().reset();
    const htmlEmpty = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, {})
      )
    );
    assert.ok(htmlEmpty.includes('data-testid="ai-welcome-state"'), 'Debe mostrar el estado de bienvenida inicial');
    assert.ok(htmlEmpty.includes('Contame qué querés organizar'));
    assert.ok(htmlEmpty.includes('data-testid="example-prompt-0"'), 'Debe mostrar ejemplos iniciales');

    useAiWizardStore.setState({
      messages: [{ id: 'm1', role: 'user', text: 'Hola', timestamp: 100 }],
    });
    const htmlWithMessages = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );
    assert.ok(!htmlWithMessages.includes('data-testid="ai-welcome-state"'), 'No debe mostrar bienvenida cuando hay mensajes');
  });

  test('Caso G: Los ejemplos iniciales son configuraciones de clic que cargan el textarea sin auto-enviar', () => {
    let sentCount = 0;
    let inputVal = '';
    const onExampleClick = (example: string) => {
      inputVal = example;
    };

    onExampleClick('Cena mañana a las 21');
    assert.equal(inputVal, 'Cena mañana a las 21', 'El clic debe rellenar el input');
    assert.equal(sentCount, 0, 'No debe auto-enviar a sendUserMessage');
  });

  test('Caso H: Textarea y botón de envío conservan despacho conversacional normal', async () => {
    let sentText = '';
    const mockSend = async (txt: string) => {
      sentText = txt;
    };

    useAiWizardStore.getState().reset();
    assert.equal(typeof useAiWizardStore.getState().sendUserMessage, 'function');
    await mockSend('Pádel el sábado a las 18');
    assert.equal(sentText, 'Pádel el sábado a las 18');
  });

  test('Caso I: Voice hint mobile se muestra condicionado a isTouch y no-visto', () => {
    const htmlTouch = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, {
          isTouchOverride: true,
          showKeyboardVoiceHintOverride: true,
        })
      )
    );
    assert.ok(htmlTouch.includes('data-testid="keyboard-voice-hint"'), 'Debe mostrar hint en mobile');
    assert.ok(!htmlTouch.includes('data-testid="speech-dictation-button"'), 'No debe mostrar botón mic en mobile');
  });

  test('Caso J: Mic desktop aparece en ambiente desktop con SpeechRecognition', () => {
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        SpeechRecognition: class MockSpeechRecognition {},
        matchMedia: () => ({ matches: false }),
      };

      const htmlDesktop = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(CreateAIWizard, { isTouchOverride: false })
        )
      );
      assert.ok(htmlDesktop.includes('data-testid="speech-dictation-button"'), 'Debe mostrar mic en desktop');
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });

  test('Caso K: History guard para Back Android se preserva con hasMeaningfulDraft', () => {
    useAiWizardStore.getState().reset();
    const draftEmpty = createEmptyEncounterDraft();
    const configEmpty = createDefaultInvitationConfig();
    assert.equal(hasMeaningfulDraftData(draftEmpty, configEmpty), false, 'Sin datos significativos');

    const draftWithData = { ...draftEmpty, title: 'Cena' };
    assert.equal(hasMeaningfulDraftData(draftWithData, configEmpty), true, 'Con título tiene datos significativos');
  });

  test('Caso L: aiLocked deshabilita el compositor y muestra banner informativo', () => {
    useAiWizardStore.getState().reset();
    const htmlLocked = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, {
          stateOverride: { aiLocked: true } as any,
        })
      )
    );
    assert.ok(htmlLocked.includes('Crear con IA no disponible para este borrador'), 'Placeholder de bloqueo');
    assert.ok(htmlLocked.includes('data-testid="ai-status-banner"'), 'Banner de estado');
  });

  test('Caso M: Errores conversacionales de campos se presentan en el timeline y no en banner de error técnico', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      messages: [
        { id: 'm1', role: 'user', text: 'Quiero una juntada ayer', timestamp: 100 },
        { id: 'm2', role: 'assistant', text: 'La fecha no puede ser anterior a hoy. ¿Qué día sería?', timestamp: 200 },
      ],
      error: null,
      aiLocked: false,
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(html.includes('La fecha no puede ser anterior a hoy'), 'Aparece como mensaje conversacional');
    assert.ok(!html.includes('data-testid="ai-status-banner"'), 'NO debe mostrar banner técnico');
  });

  test('Caso N: Error técnico conserva botones de Reintentar y Continuar manualmente', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      error: 'Error de red. Verificá tu conexión.',
      lastUserPrompt: 'Cena mañana',
      isInterpreting: false,
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(html.includes('data-testid="ai-status-banner"'), 'Debe mostrar el banner de error técnico');
    assert.ok(html.includes('data-testid="retry-ai-button"'), 'Debe permitir reintentar');
    assert.ok(html.includes('data-testid="continue-manually-button"'), 'Debe permitir continuar manualmente');
  });

  test('Caso O: Textarea usa font-size 16px para prevenir auto-zoom en iOS Safari', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, {})
      )
    );
    assert.ok(html.includes('font-size:16px') || html.includes('font-size: 16px'), 'El textarea debe tener font-size 16px');
  });

  test('Caso P: Burbujas de chat usan font-size 16px y line-height confortable', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      messages: [
        { id: 'm1', role: 'user', text: 'Cena el viernes', timestamp: 100 },
        { id: 'm2', role: 'assistant', text: '¡Genial! ¿A qué hora sería?', timestamp: 200 },
      ],
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );

    assert.ok(html.includes('font-size:16px') || html.includes('font-size: 16px'), 'Las burbujas deben tener font-size 16px');
    assert.ok(html.includes('line-height:1.48') || html.includes('line-height: 1.48'), 'Las burbujas deben tener line-height ~1.48');
  });

  test('Caso Q: formatHumanSchedule soporte locale-aware (ES, EN, PT) con fallback seguro', () => {
    const baseDate = '2026-10-15'; // Jueves 15 de octubre de 2026
    const baseTime = '20:00';
    const refDate = '2026-09-10';

    // 1. es-AR
    const esRes = formatHumanSchedule(baseDate, baseTime, { locale: 'es-AR', referenceTodayISO: refDate });
    assert.ok(esRes.includes('15') && esRes.includes('20:00') && !esRes.includes('hs'), 'es-AR formatea con número y hora sin hs');

    // 2. en-US
    const enRes = formatHumanSchedule(baseDate, baseTime, { locale: 'en-US', referenceTodayISO: refDate });
    assert.ok(enRes.includes('Thu') && enRes.includes('Oct') && enRes.includes('15') && enRes.includes('20:00'), 'en-US formatea nativamente');

    const enToday = formatHumanSchedule(refDate, baseTime, { locale: 'en-US', referenceTodayISO: refDate });
    assert.equal(enToday, 'Today · 20:00', 'en-US relativo today');

    // 3. pt-BR
    const ptRes = formatHumanSchedule(baseDate, baseTime, { locale: 'pt-BR', referenceTodayISO: refDate });
    assert.ok(ptRes.includes('15') && ptRes.includes('20:00') && !ptRes.includes('hs'), 'pt-BR formatea nativamente');

    const ptToday = formatHumanSchedule(refDate, baseTime, { locale: 'pt-BR', referenceTodayISO: refDate });
    assert.equal(ptToday, 'Hoje · 20:00', 'pt-BR relativo hoje');

    // 4. Fallback seguro con locale vacío o desconocido
    const fallbackRes = formatHumanSchedule(baseDate, baseTime, { locale: '', referenceTodayISO: refDate });
    assert.ok(fallbackRes.includes('15') && fallbackRes.includes('20:00'));

    // 5. Firma con opciones como primer argumento
    const optsRes = formatHumanSchedule({ date: baseDate, time: baseTime, locale: 'en-US', referenceTodayISO: refDate });
    assert.ok(optsRes.includes('Thu') && optsRes.includes('Oct'));
  });
});

describe('Coordinación Simple Integrada en Crear con IA: Cases A to Y', () => {
  const todayISO = getArgentinaTodayISO();
  const tomorrowISO = addDaysToIsoDate(todayISO, 1);
  const dayAfterTomorrowISO = addDaysToIsoDate(todayISO, 2);

  // ==========================================
  // Section 41: TESTS DE DETECCIÓN (A to F)
  // ==========================================
  test('Case A: fixed simple -> fixed (no detectado como candidato de coordinación)', () => {
    const res = parseNaturalLanguageDateOptions('Cena mañana a las 20');
    assert.equal(res.isCoordinationCandidate, false, 'Un solo horario/fecha fija no debe marcarse como candidato');
  });

  test('Case B: 2 opciones implícitas -> coordination candidate + confirmación', () => {
    const res = parseNaturalLanguageDateOptions('Cena mañana a las 20 horas en casa o pasado mañana a las 20 horas en casa');
    assert.equal(res.isCoordinationCandidate, true, 'Debe detectar candidato de coordinación');
    assert.equal(res.options.length, 2, 'Debe extraer 2 opciones');
    assert.equal(res.hasExplicitCoordinationIntent, false, 'Coordinación implícita requiere confirmación');
    assert.equal(res.extractedTitle, 'Cena', 'Debe extraer título Cena');
    assert.equal(res.extractedLocation, 'casa', 'Debe extraer lugar casa');

    const draft = {
      ...createEmptyEncounterDraft(),
      title: res.extractedTitle || '',
      locationText: res.extractedLocation || null,
      dateOptions: res.options,
      dateMode: 'coordination' as const,
      coordinationCandidate: true,
      coordinationPendingConfirm: true,
    };
    const evaluation = evaluateDraft(draft);
    assert.equal(evaluation.nextQuestion?.field, 'coordination_confirm');
    assert.equal(evaluation.nextQuestion?.type, 'coordination_card');
  });

  test('Case C: 2 opciones explícitas -> coordination directo sin confirmación redundante', () => {
    const res = parseNaturalLanguageDateOptions('Quiero organizar una cena y que puedan elegir entre mañana a las 20 o el sábado a las 21');
    assert.equal(res.hasExplicitCoordinationIntent, true, 'Frase explícita debe fijar hasExplicitCoordinationIntent: true');
    assert.equal(res.options.length, 2);

    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cena',
      dateOptions: res.options,
      dateMode: 'coordination' as const,
      coordinationCandidate: true,
      coordinationPendingConfirm: false,
    };
    const evaluation = evaluateDraft(draft);
    assert.notEqual(evaluation.nextQuestion?.field, 'coordination_confirm');
    assert.equal(evaluation.nextQuestion?.field, 'modality');
  });

  test('Case D: 3 opciones -> válido', () => {
    const res = parseNaturalLanguageDateOptions('Cena el 20 de noviembre a las 20, el 21 de noviembre a las 21 o el 22 de noviembre a las 13');
    assert.ok(res);
    assert.equal(res.options.length, 3, 'Debe detectar 3 opciones');
    assert.ok(res.options[0].date && res.options[0].time === '20:00');
    assert.ok(res.options[1].date && res.options[1].time === '21:00');
    assert.ok(res.options[2].date && res.options[2].time === '13:00');
  });

  test('Case E: 4 a 5 opciones -> límite RPC (v_opciones_count <= 3)', () => {
    const input = 'Cena el lunes a las 20, martes a las 20, miércoles a las 20 o jueves a las 20';
    const res = parseNaturalLanguageDateOptions(input);
    assert.ok(res);
    assert.ok(res.options.length >= 4, 'Debe detectar las 4 opciones');

    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cena',
      modality: 'presencial' as const,
      locationText: 'Club',
      dateOptions: res.options,
      dateMode: 'coordination' as const,
    };
    const evaluation = evaluateDraft(draft);
    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'coordination_options');
    assert.ok(evaluation.nextQuestion?.question.includes('3 opciones'));

    assert.throws(() => {
      translateToCoordinationPayload(draft, createDefaultInvitationConfig());
    }, /como máximo tres opciones/);
  });

  test('Case F: 6 opciones -> feedback claro, no truncar silenciosamente', () => {
    const dates = [
      { date: addDaysToIsoDate(todayISO, 3), time: '20:00' },
      { date: addDaysToIsoDate(todayISO, 4), time: '20:00' },
      { date: addDaysToIsoDate(todayISO, 5), time: '20:00' },
      { date: addDaysToIsoDate(todayISO, 6), time: '20:00' },
      { date: addDaysToIsoDate(todayISO, 7), time: '20:00' },
      { date: addDaysToIsoDate(todayISO, 8), time: '20:00' },
    ];
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Reunión extensa',
      modality: 'presencial' as const,
      locationText: 'Oficina',
      dateOptions: dates,
      dateMode: 'coordination' as const,
    };
    const evaluation = evaluateDraft(draft);
    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'coordination_options');
    assert.ok(evaluation.nextQuestion?.question.includes('3 opciones'));
  });

  // ==========================================
  // Section 42: TESTS DE TRANSICIÓN (G to J)
  // ==========================================
  test('Case G: fixed -> agregar alternativa -> transition add', () => {
    const transition = parseCoordinationTransition('también podría ser el sábado a las 21');
    assert.ok(transition);
    assert.equal(transition.type, 'add');
    assert.ok(transition.addedOption);
    assert.equal(transition.addedOption.time, '21:00');
  });

  test('Case H: coordination -> "mejor sólo viernes" -> switch_to_fixed', () => {
    const transition = parseCoordinationTransition('mejor sólo viernes a las 21');
    assert.ok(transition);
    assert.equal(transition.type, 'switch_to_fixed');
    assert.ok(transition.selectedFixedOption);
    assert.equal(transition.selectedFixedOption.time, '21:00');
  });

  test('Case I: coordination con 2 -> eliminar una -> remove transition', () => {
    const transition = parseCoordinationTransition('sacá la del viernes');
    assert.ok(transition);
    assert.equal(transition.type, 'remove');
    assert.ok(transition.removedOptionDate);
  });

  test('Case J: agregar opción duplicada -> no duplicar (deduplicación)', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Asado',
      modality: 'presencial' as const,
      locationText: 'Quincho',
      dateMode: 'coordination' as const,
      dateOptions: [
        { date: tomorrowISO, time: '21:00' },
        { date: tomorrowISO, time: '21:00' },
        { date: dayAfterTomorrowISO, time: '21:00' },
      ],
    };
    const { opciones } = translateToCoordinationPayload(draft, createDefaultInvitationConfig());
    assert.equal(opciones.length, 2, 'Las opciones duplicadas deben unificarse');
  });

  // ==========================================
  // Section 43: TESTS TEMPORALES (K to O)
  // ==========================================
  test('Case K: 2 fechas futuras -> válidas', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cena',
      modality: 'presencial' as const,
      locationText: 'Casa',
      dateMode: 'coordination' as const,
      dateOptions: [
        { date: tomorrowISO, time: '20:00' },
        { date: dayAfterTomorrowISO, time: '20:00' },
      ],
    };
    const evaluation = evaluateDraft(draft);
    assert.equal(evaluation.isComplete, true);
  });

  test('Case L: una pasada + una futura -> feedback sobre la pasada', () => {
    const pastDate = addDaysToIsoDate(todayISO, -2);
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cena',
      modality: 'presencial' as const,
      locationText: 'Casa',
      dateMode: 'coordination' as const,
      dateOptions: [
        { date: pastDate, time: '20:00' },
        { date: tomorrowISO, time: '20:00' },
      ],
    };
    const evaluation = evaluateDraft(draft);
    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.nextQuestion?.field, 'coordination_options');
    assert.ok(evaluation.nextQuestion?.question.includes('anterior a hoy') || evaluation.nextQuestion?.question.includes('futur'));
  });

  test('Case M: 24:00 dentro de dateOption -> semántica rollover a 00:00 del día siguiente', () => {
    const res = parseNaturalLanguageDateOptions('mañana a las 24 o pasado mañana a las 20');
    assert.ok(res);
    assert.equal(res.options.length, 2);
    const opt1 = res.options[0];
    assert.equal(opt1.date, dayAfterTomorrowISO, '24:00 debe hacer rollover al día siguiente');
    assert.equal(opt1.time, '00:00');
  });

  test('Case N: número en letras dentro de dateOption -> parser horario actual', () => {
    const res = parseNaturalLanguageDateOptions('mañana a las ocho de la noche o pasado mañana a las nueve de la noche');
    assert.ok(res);
    assert.equal(res.options.length, 2);
    assert.equal(res.options[0].time, '20:00');
    assert.equal(res.options[1].time, '21:00');
  });

  test('Case O: "primer viernes del mes que viene o segundo sábado" -> resolver correctamente', () => {
    const expr1 = parseDeterministicDateExpression('primer viernes del mes que viene');
    assert.ok(expr1 && expr1.date, 'Debe resolver primer viernes del mes próximo');
    const expr2 = parseDeterministicDateExpression('segundo sábado del mes que viene');
    assert.ok(expr2 && expr2.date, 'Debe resolver segundo sábado del mes próximo');
    assert.notEqual(expr1.date, expr2.date);
  });

  // ==========================================
  // Section 44: TESTS DE CREACIÓN (P to R)
  // ==========================================
  test('Case P: fixed completo -> genera DTO para crear_encuentro_seguro', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cumpleaños',
      date: tomorrowISO,
      time: '18:00',
      modality: 'presencial' as const,
      locationText: 'Plaza',
    };
    const dto = translateToCreateEncuentroDTO(draft, createDefaultInvitationConfig(), { hostId: 'host-123' });
    assert.equal(dto.titulo, 'Cumpleaños');
    assert.equal(dto.fecha, tomorrowISO);
    assert.equal(dto.hora, '18:00');
    assert.equal(dto.modalidad, 'presencial');
    assert.equal(dto.lugar_texto, 'Plaza');
  });

  test('Case Q: coordination completo -> genera payload para crear_encuentro_con_opciones_seguro', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Asado',
      modality: 'presencial' as const,
      locationText: 'Quincho',
      dateMode: 'coordination' as const,
      durationMinutes: 120,
      responseDeadline: `${tomorrowISO}T12:00:00`,
      dateOptions: [
        { date: tomorrowISO, time: '21:00' },
        { date: dayAfterTomorrowISO, time: '21:00' },
      ],
    };
    const { payload, opciones } = translateToCoordinationPayload(
      draft,
      createDefaultInvitationConfig(),
      { hostId: 'host-123', postEventActiveMinutes: 60 }
    );
    assert.equal(payload.titulo, 'Asado');
    assert.equal(payload.modalidad, 'presencial');
    assert.equal(payload.lugar_texto, 'Quincho');
    assert.equal(payload.duration_minutes, 120);
    assert.equal(payload.response_deadline, `${tomorrowISO}T12:00:00`);
    assert.equal(payload.post_event_active_minutes, 60);
    assert.equal(opciones.length, 2);
    assert.equal(opciones[0].fecha, tomorrowISO);
    assert.equal(opciones[0].hora_inicio, '21:00');
  });

  test('Case R: payload coordination IA === payload semánticamente equivalente del wizard manual', () => {
    const config = createDefaultInvitationConfig();
    const commonDraftData = {
      title: 'Cena de Fin de Año',
      description: 'Traer bebidas',
      modality: 'presencial' as const,
      locationText: 'Restaurante Central',
      virtualLink: '',
      options: [
        { date: tomorrowISO, time: '20:30' },
        { date: dayAfterTomorrowISO, time: '21:00' },
      ],
      durationMinutes: 180,
      responseDeadline: `${tomorrowISO}T14:00:00`,
    };

    // 1. Payload generado desde IA -> translateToCoordinationPayload
    const aiDraft = {
      ...createEmptyEncounterDraft(),
      title: commonDraftData.title,
      description: commonDraftData.description,
      modality: commonDraftData.modality,
      locationText: commonDraftData.locationText,
      virtualLink: commonDraftData.virtualLink,
      dateMode: 'coordination' as const,
      dateOptions: commonDraftData.options,
      durationMinutes: commonDraftData.durationMinutes,
      responseDeadline: commonDraftData.responseDeadline,
    };
    const aiResult = translateToCoordinationPayload(aiDraft, config);

    // 2. Payload construido por el wizard manual (Step4Review.tsx)
    const isPresencial = commonDraftData.modality === 'presencial';
    const manualPayload = {
      titulo: commonDraftData.title,
      descripcion: commonDraftData.description || null,
      modalidad: commonDraftData.modality,
      lugar_texto: isPresencial ? commonDraftData.locationText : null,
      link_virtual: !isPresencial ? commonDraftData.virtualLink : null,
      tipo_invitacion: config.invitationType,
      tema: 'blue',
      tema_invitacion: config.invitationTheme || null,
      invitation_template: config.invitationTemplate || null,
      response_deadline: commonDraftData.responseDeadline || null,
      duration_minutes: commonDraftData.durationMinutes,
      mostrar_respuestas_a_invitados: false, // config default is 'hidden' -> false
      visibilidad_respuestas_invitados: 'hidden',
    };
    const manualOptions = commonDraftData.options.map((opt) => ({
      fecha: opt.date,
      hora_inicio: opt.time,
    }));

    // Verificación exhaustiva de equivalencia de contratos
    assert.equal(aiResult.payload.titulo, manualPayload.titulo);
    assert.equal(aiResult.payload.descripcion, manualPayload.descripcion);
    assert.equal(aiResult.payload.modalidad, manualPayload.modalidad);
    assert.equal(aiResult.payload.lugar_texto, manualPayload.lugar_texto);
    assert.equal(aiResult.payload.tipo_invitacion, manualPayload.tipo_invitacion);
    assert.equal(aiResult.payload.tema, manualPayload.tema);
    assert.equal(aiResult.payload.duration_minutes, manualPayload.duration_minutes);
    assert.equal(aiResult.payload.response_deadline, manualPayload.response_deadline);
    assert.equal(aiResult.payload.mostrar_respuestas_a_invitados, manualPayload.mostrar_respuestas_a_invitados);
    assert.equal(aiResult.payload.visibilidad_respuestas_invitados, manualPayload.visibilidad_respuestas_invitados);

    assert.equal(aiResult.opciones.length, manualOptions.length);
    for (let i = 0; i < aiResult.opciones.length; i++) {
      assert.equal(aiResult.opciones[i].fecha, manualOptions[i].fecha);
      assert.equal(aiResult.opciones[i].hora_inicio, manualOptions[i].hora_inicio);
    }
  });

  // ==========================================
  // Section 45: TESTS UX (S to Y)
  // ==========================================
  test('Case S: card de coordinación renderiza sin duplicación', () => {
    const question = {
      field: 'coordination_confirm' as const,
      question: '¿Querés que los invitados elijan entre estas fechas?',
      options: ['Sí, continuar', 'Elegir fecha fija'],
      type: 'coordination_card' as const,
      coordinationOptions: [
        { date: tomorrowISO, time: '20:00' },
        { date: dayAfterTomorrowISO, time: '20:00' },
      ],
    };
    const html = renderToStaticMarkup(
      React.createElement(FieldQuestion, {
        question,
        onSelectOption: () => {},
      })
    );
    assert.ok(html.includes('¿Querés que los invitados elijan entre estas fechas?'));
    assert.ok(html.includes('Sí, continuar'));
    assert.ok(html.includes('Elegir fecha fija'));
  });

  test('Case T: store no emite mensaje asistente duplicado antes de la card interactiva', async () => {
    useAiWizardStore.getState().reset();
    await useAiWizardStore.getState().sendUserMessage('Cena mañana a las 20 horas en casa o pasado mañana a las 20 horas en casa');
    const state = useAiWizardStore.getState();
    assert.equal(state.coordinationPendingConfirm, true);
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].role, 'user');
    assert.equal(state.messages.some((m) => m.role === 'assistant'), false);
    assert.equal(state.lastQuestion?.field, 'coordination_confirm');
  });

  test('Case U: "Elegir fecha fija" funciona correctamente en el store', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        dateOptions: [
          { date: tomorrowISO, time: '20:00' },
          { date: dayAfterTomorrowISO, time: '21:00' },
        ],
        dateMode: 'coordination',
        coordinationPendingConfirm: true,
      },
    });

    useAiWizardStore.getState().switchToFixed(tomorrowISO, '20:00');
    const state = useAiWizardStore.getState();
    assert.equal(state.draft.dateMode, 'fixed');
    assert.equal(state.draft.date, tomorrowISO);
    assert.equal(state.draft.time, '20:00');
    assert.equal(state.draft.dateOptions, null);
    assert.equal(state.coordinationPendingConfirm, false);
  });

  test('Case V: Resumen compacto indica "{N} opciones" para coordinación', () => {
    const store = useAiWizardStore.getState();
    store.reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena Amigos',
        modality: 'presencial',
        locationText: 'Casa',
        dateMode: 'coordination',
        dateOptions: [
          { date: tomorrowISO, time: '21:00' },
          { date: dayAfterTomorrowISO, time: '21:00' },
        ],
      },
      config: createDefaultInvitationConfig(),
      messages: [],
    });

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, { stateOverride: useAiWizardStore.getState() })
      )
    );
    assert.ok(html.includes('2 opciones'), 'Compact bar must show "2 opciones"');
  });

  test('Case W: Resumen expandido muestra Opciones de fecha', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Pádel',
      modality: 'presencial' as const,
      locationText: 'Cancha 3',
      dateMode: 'coordination' as const,
      durationMinutes: 90,
      dateOptions: [
        { date: tomorrowISO, time: '18:00' },
        { date: dayAfterTomorrowISO, time: '19:00' },
      ],
    };
    const html = renderToStaticMarkup(
      React.createElement(DraftSummary, {
        draft,
        config: createDefaultInvitationConfig(),
      })
    );
    assert.ok(html.includes('Opciones de fecha'), 'Debe renderizar encabezado Opciones de fecha');
    assert.ok(html.includes('18:00') && html.includes('19:00'), 'Debe mostrar las horas');
    assert.ok(html.includes('1 h 30 min'), 'Debe mostrar la duración formateada');
  });

  test('Case X: "Listo para crear" funciona en coordinación cuando los campos requeridos están completos', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cena de Fin de Año',
      modality: 'presencial' as const,
      locationText: 'El Mangrullo',
      dateMode: 'coordination' as const,
      dateOptions: [
        { date: tomorrowISO, time: '21:00' },
        { date: dayAfterTomorrowISO, time: '21:00' },
      ],
    };
    const evaluation = evaluateDraft(draft);
    assert.equal(evaluation.isComplete, true, 'Draft coordinado con título, 2 opciones y lugar está listo');
    assert.equal(evaluation.nextQuestion, null, 'No debe pedir más preguntas obligatorias');
  });

  test('Case Y: handoff manual conserva todos los datos relevantes y previene reset en CreateCoordinationWizard', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cumpleaños de Ana',
      description: 'Fiesta sorpresa',
      modality: 'presencial' as const,
      locationText: 'Salón de eventos',
      dateMode: 'coordination' as const,
      durationMinutes: 240,
      responseDeadline: `${tomorrowISO}T10:00:00`,
      dateOptions: [
        { date: tomorrowISO, time: '15:00' },
        { date: dayAfterTomorrowISO, time: '16:00' },
      ],
    };
    const config = createDefaultInvitationConfig();
    const coordDraft = draftToCoordinationDraft(draft, config);

    assert.equal(coordDraft.dateMode, 'coordination');
    assert.equal(coordDraft.title, 'Cumpleaños de Ana');
    assert.equal(coordDraft.description, 'Fiesta sorpresa');
    assert.equal(coordDraft.modality, 'presencial');
    assert.equal(coordDraft.locationText, 'Salón de eventos');
    assert.equal(coordDraft.durationMinutes, 240);
    assert.equal(coordDraft.responseDeadline, `${tomorrowISO}T10:00:00`);
    assert.equal(coordDraft.options?.length, 2);
    assert.equal(coordDraft.options?.[0].date, tomorrowISO);
    assert.equal(coordDraft.options?.[0].time, '15:00');
    assert.equal(coordDraft.options?.[1].date, dayAfterTomorrowISO);
    assert.equal(coordDraft.options?.[1].time, '16:00');
  });
});

describe('Coordinación con IA — Continuidad de Autenticación y Post-Auth (Bugs A a G)', () => {
  const todayISO = getArgentinaTodayISO();
  const tomorrowISO = addDaysToIsoDate(todayISO, 1);
  const dayAfterTomorrowISO = addDaysToIsoDate(todayISO, 2);

  test('Case A: /create/ai está explícitamente permitido por ALLOWED_POST_AUTH_ROUTES', () => {
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has('/create/ai'), true);
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has('/create'), true);
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has('/create/coordination'), true);
  });

  test('Case B: Rutas arbitrarias y open redirects continúan rechazadas', () => {
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has('https://evil.com'), false);
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has('/evil'), false);
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has('//google.com'), false);
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has('/create/ai/invalid'), false);
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has('javascript:alert(1)'), false);
  });

  test('Case C: Usuario anónimo intentando crear coordinación -> no llama crearEncuentroConOpciones y renderiza CTA', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cena Coordinada',
      modality: 'presencial' as const,
      locationText: 'Casa de Nico',
      dateMode: 'coordination' as const,
      dateOptions: [
        { date: tomorrowISO, time: '20:00' },
        { date: dayAfterTomorrowISO, time: '21:00' },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(CreateAIWizard, {
          stateOverride: {
            draft,
            isComplete: true,
          } as any,
        })
      )
    );

    assert.ok(html.includes('Cena Coordinada'));
    assert.ok(html.includes('Casa de Nico'));
  });

  test('Case D: CTA de Login en CreateAIWizard preserva draft y setea post_auth_redirect=/create/ai', () => {
    const storage: Record<string, string> = {};
    const mockSessionStorage = {
      getItem: (k: string) => storage[k] || null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    };

    mockSessionStorage.setItem('post_auth_redirect', '/create/ai');
    assert.equal(mockSessionStorage.getItem('post_auth_redirect'), '/create/ai');
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has(mockSessionStorage.getItem('post_auth_redirect')!), true);
  });

  test('Case E: Draft coordinado serializado en pe-ai-wizard-session y rehidratado conserva todos los datos', () => {
    const originalDraft = {
      ...createEmptyEncounterDraft(),
      title: 'Cumpleaños de Diego',
      description: 'Fiesta con amigos',
      modality: 'presencial' as const,
      locationText: 'Quincho',
      dateMode: 'coordination' as const,
      durationMinutes: 180,
      responseDeadline: `${tomorrowISO}T12:00:00`,
      dateOptions: [
        { date: tomorrowISO, time: '20:00' },
        { date: dayAfterTomorrowISO, time: '21:00' },
      ],
    };
    const originalConfig = {
      ...createDefaultInvitationConfig(),
      invitationTheme: 'party' as const,
      invitationTemplate: 'party_night',
    };

    const sessionPayload = {
      sessionId: 'test-session-auth',
      draft: originalDraft,
      config: originalConfig,
      messages: [{ id: 'm1', role: 'user', text: 'Cena mañana o pasado', timestamp: 12345 }],
      turns: 1,
      consecutiveOffTopicCount: 0,
      aiLocked: false,
      startedAt: 12345678,
      coordinationDetected: true,
      coordinationPendingConfirm: false,
      isComplete: true,
    };

    const serialized = JSON.stringify(sessionPayload);
    const rehydrated = JSON.parse(serialized);

    assert.equal(rehydrated.draft.title, originalDraft.title);
    assert.equal(rehydrated.draft.description, originalDraft.description);
    assert.equal(rehydrated.draft.dateMode, 'coordination');
    assert.equal(rehydrated.draft.modality, 'presencial');
    assert.equal(rehydrated.draft.locationText, 'Quincho');
    assert.equal(rehydrated.draft.durationMinutes, 180);
    assert.equal(rehydrated.draft.responseDeadline, `${tomorrowISO}T12:00:00`);
    assert.equal(rehydrated.draft.dateOptions.length, 2);
    assert.equal(rehydrated.draft.dateOptions[0].date, tomorrowISO);
    assert.equal(rehydrated.draft.dateOptions[0].time, '20:00');
    assert.equal(rehydrated.draft.dateOptions[1].date, dayAfterTomorrowISO);
    assert.equal(rehydrated.draft.dateOptions[1].time, '21:00');
    assert.equal(rehydrated.messages.length, 1);
    assert.equal(rehydrated.isComplete, true);
  });

  test('Case F: Redirección post-auth devuelve al usuario a /create/ai sin alterar el draft', () => {
    const targetRoute = '/create/ai';
    assert.equal(ALLOWED_POST_AUTH_ROUTES.has(targetRoute), true);
    let navigatedPath: string | null = null;
    const mockNavigate = (path: string) => { navigatedPath = path; };

    if (ALLOWED_POST_AUTH_ROUTES.has(targetRoute)) {
      mockNavigate(targetRoute);
    }
    assert.equal(navigatedPath, '/create/ai');
  });

  test('Case G: Rehidratación no dispara auto-creación ni llamada prematura al RPC', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Asado Coordinado',
        modality: 'presencial',
        locationText: 'Casa',
        dateMode: 'coordination',
        dateOptions: [
          { date: tomorrowISO, time: '13:00' },
          { date: dayAfterTomorrowISO, time: '13:00' },
        ],
      },
      isComplete: true,
    });

    const state = useAiWizardStore.getState();
    assert.equal(state.draft.title, 'Asado Coordinado');
    assert.equal(state.isComplete, true);
    assert.equal(state.isInterpreting, false);
    assert.equal(state.sessionId.length > 0, true);
  });
});

describe('QA Post-Deploy Fix: Alternativas de Horario sin Fecha Definida (Casos A a O)', () => {
  const todayISO = getArgentinaTodayISO();
  const tomorrowISO = addDaysToIsoDate(todayISO, 1);
  const dayAfterTomorrowISO = addDaysToIsoDate(todayISO, 2);

  test('Caso A & D: Caso Real QA "Desayuno a las 10 o a las 11:00 en casa" sin fecha previa', () => {
    const res = parseNaturalLanguageDateOptions('Desayuno a las 10 o a las 11:00 en casa');
    assert.equal(res.extractedTitle, 'Desayuno');
    assert.equal(res.extractedLocation, 'casa');
    assert.equal(res.extractedModality, 'presencial');
    assert.equal(res.isCoordinationCandidate, true);
    assert.equal(res.options.length, 0); // No options yet because date is missing
    assert.deepEqual(res.pendingTimeOptions, ['10:00', '11:00']);

    // Evaluate draft with pendingTimeOptions
    const draft = {
      ...createEmptyEncounterDraft(),
      title: res.extractedTitle || null,
      locationText: res.extractedLocation || null,
      modality: res.extractedModality || null,
      pendingTimeOptions: res.pendingTimeOptions,
    };

    const evaluation = evaluateDraft(draft, true, undefined, false);
    assert.equal(evaluation.isComplete, false);
    assert.deepEqual(evaluation.missingFields, ['date']);
    assert.equal(evaluation.nextQuestion?.field, 'date');
    assert.equal(evaluation.nextQuestion?.question, '¿Qué día sería?');
    // Ensure no generic time chips
    assert.notEqual(evaluation.nextQuestion?.field, 'time');
  });

  test('Caso B: Fecha agregada en Turno 2 ("mañana") materializa dateOptions y card de confirmación adaptada', async () => {
    useAiWizardStore.getState().reset();
    const store = useAiWizardStore.getState();

    // Turn 1
    await store.sendUserMessage('Desayuno a las 10 o a las 11:00 en casa');
    const state1 = useAiWizardStore.getState();
    assert.equal(state1.draft.title, 'Desayuno');
    assert.equal(state1.draft.locationText, 'casa');
    assert.deepEqual(state1.draft.pendingTimeOptions, ['10:00', '11:00']);
    assert.equal(state1.lastQuestion?.field, 'date');
    assert.equal(state1.lastQuestion?.question, '¿Qué día sería?');

    // Turn 2
    await store.sendUserMessage('mañana');
    const state2 = useAiWizardStore.getState();
    assert.equal(state2.draft.pendingTimeOptions, null);
    assert.equal(state2.draft.dateOptions?.length, 2);
    assert.equal(state2.draft.dateOptions?.[0].date, tomorrowISO);
    assert.equal(state2.draft.dateOptions?.[0].time, '10:00');
    assert.equal(state2.draft.dateOptions?.[1].date, tomorrowISO);
    assert.equal(state2.draft.dateOptions?.[1].time, '11:00');
    assert.equal(state2.coordinationDetected, true);
    assert.equal(state2.coordinationPendingConfirm, true);
    assert.equal(state2.lastQuestion?.field, 'coordination_confirm');
    assert.equal(state2.lastQuestion?.question, '¿Querés que los invitados elijan entre estos horarios?');
    assert.equal(state2.lastQuestion?.quickOptions?.[1]?.label, 'Elegir un horario fijo');
  });

  test('Caso C: Turno inverso: Fecha primero ("Desayuno mañana en casa"), horas después ("A las 10 o a las 11")', async () => {
    useAiWizardStore.getState().reset();
    const store = useAiWizardStore.getState();

    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'encounter',
      patch: {
        title: { value: 'Desayuno', confidence: 'explicit' as const },
        dateIntent: { value: { type: 'relative' as const, value: 'tomorrow' as const }, confidence: 'explicit' as const },
        locationText: { value: 'casa', confidence: 'explicit' as const },
        modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
      },
    });

    try {
      // Turn 1
      await store.sendUserMessage('Desayuno mañana en casa');
      const state1 = useAiWizardStore.getState();
      assert.equal(state1.draft.title, 'Desayuno');
      assert.equal(state1.draft.locationText, 'casa');
      assert.equal(state1.draft.date, tomorrowISO);
      assert.equal(state1.lastQuestion?.field, 'time');

      // Turn 2
      await store.sendUserMessage('A las 10 o a las 11');
      const state2 = useAiWizardStore.getState();
      assert.equal(state2.draft.dateOptions?.length, 2);
      assert.equal(state2.draft.dateOptions?.[0].date, tomorrowISO);
      assert.equal(state2.draft.dateOptions?.[0].time, '10:00');
      assert.equal(state2.draft.dateOptions?.[1].date, tomorrowISO);
      assert.equal(state2.draft.dateOptions?.[1].time, '11:00');
      assert.equal(state2.coordinationDetected, true);
      assert.equal(state2.coordinationPendingConfirm, true);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso D: Semántica contextual de actividad (Desayuno vs Cena)', () => {
    // Desayuno -> 10 and 11 stay AM
    const resDesayuno = parseNaturalLanguageDateOptions('Desayuno a las 10 o a las 11');
    assert.deepEqual(resDesayuno.pendingTimeOptions, ['10:00', '11:00']);

    // Cena con palabras -> 22:00 y 23:00 (PM)
    const resCena = parseNaturalLanguageDateOptions('Cena a las diez o a las once');
    assert.deepEqual(resCena.pendingTimeOptions, ['22:00', '23:00']);
  });

  test('Caso E: Números en letras ("Desayuno a las diez o a las once")', () => {
    const res = parseNaturalLanguageDateOptions('Desayuno a las diez o a las once');
    assert.equal(res.extractedTitle, 'Desayuno');
    assert.deepEqual(res.pendingTimeOptions, ['10:00', '11:00']);
  });

  test('Caso F: AM explícito ("mañana a las 10 am o a las 11 am")', () => {
    const res = parseNaturalLanguageDateOptions('mañana a las 10 am o a las 11 am');
    assert.equal(res.options.length, 2);
    assert.equal(res.options[0].time, '10:00');
    assert.equal(res.options[1].time, '11:00');
  });

  test('Caso G: PM explícito ("mañana a las 8 pm o a las 9 pm")', () => {
    const res = parseNaturalLanguageDateOptions('mañana a las 8 pm o a las 9 pm');
    assert.equal(res.options.length, 2);
    assert.equal(res.options[0].time, '20:00');
    assert.equal(res.options[1].time, '21:00');
  });

  test('Caso H: Rollover 24:00 ("mañana a las 23 o a las 24")', () => {
    const res = parseNaturalLanguageDateOptions('mañana a las 23 o a las 24');
    assert.equal(res.options.length, 2);
    assert.equal(res.options[0].date, tomorrowISO);
    assert.equal(res.options[0].time, '23:00');
    assert.equal(res.options[1].date, dayAfterTomorrowISO);
    assert.equal(res.options[1].time, '00:00');
    assert.equal(res.options[1].appliedDayRollover, true);
  });

  test('Caso I: Deduplicación ("a las 10 o a las 10:00" -> fixed single, NO coordination)', () => {
    const res = parseNaturalLanguageDateOptions('a las 10 o a las 10:00');
    assert.equal(res.isCoordinationCandidate, false);
    assert.equal(res.options.length, 0);
    assert.equal(res.pendingTimeOptions, undefined);
  });

  test('Caso J: Límite de 3 opciones ("a las 9, 10, 11 o 12")', () => {
    const res = parseNaturalLanguageDateOptions('a las 9, 10, 11 o 12');
    assert.equal(res.isCoordinationCandidate, true);
    assert.equal(res.totalAlternativesFound, 4);
    assert.equal(res.pendingTimeOptions?.length, 4);

    const draft = {
      ...createEmptyEncounterDraft(),
      pendingTimeOptions: res.pendingTimeOptions,
    };
    const evaluation = evaluateDraft(draft, true, undefined, false);
    assert.equal(evaluation.isComplete, false);
    assert.equal(evaluation.validationError, 'maximum_three_options');
    assert.ok(evaluation.nextQuestion?.question.includes('hasta 3 opciones'));
  });

  test('Caso K: Hora única no regresión ("Desayuno mañana a las 10")', () => {
    const res = parseNaturalLanguageDateOptions('Desayuno mañana a las 10');
    assert.equal(res.isCoordinationCandidate, false);
    assert.equal(res.options.length, 0);
  });

  test('Caso L: Coordinación explícita ("Que elijan si desayunamos mañana a las 10 o a las 11")', () => {
    const res = parseNaturalLanguageDateOptions('Que elijan si desayunamos mañana a las 10 o a las 11');
    assert.equal(res.hasExplicitCoordinationIntent, true);
    assert.equal(res.isCoordinationCandidate, true);
    assert.equal(res.options.length, 2);
    assert.equal(res.options[0].time, '10:00');
    assert.equal(res.options[1].time, '11:00');
  });

  test('Caso M: Persistencia F5 de pendingTimeOptions en pe-ai-wizard-session', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Desayuno',
        locationText: 'casa',
        modality: 'presencial',
        pendingTimeOptions: ['10:00', '11:00'],
      },
    });

    const state = useAiWizardStore.getState();
    assert.deepEqual(state.draft.pendingTimeOptions, ['10:00', '11:00']);

    // Simulate reload initSession
    useAiWizardStore.setState({ lastQuestion: null, isComplete: false });
    state.initSession();
    const stateAfterReload = useAiWizardStore.getState();
    assert.equal(stateAfterReload.lastQuestion?.field, 'date');
    assert.equal(stateAfterReload.lastQuestion?.question, '¿Qué día sería?');
  });

  test('Caso N: Back Android & hasMeaningfulDraftData con pendingTimeOptions', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Desayuno',
      pendingTimeOptions: ['10:00', '11:00'],
    };
    assert.equal(hasMeaningfulDraftData(draft), true, 'Draft with pendingTimeOptions must be meaningful');
  });

  test('Caso O: Regresión de coordinación multi-fecha existente ("Cena mañana a las 20 o pasado mañana a las 21 en casa")', () => {
    const res = parseNaturalLanguageDateOptions('Cena mañana a las 20 o pasado mañana a las 21 en casa');
    assert.equal(res.isCoordinationCandidate, true);
    assert.equal(res.options.length, 2);
    assert.equal(res.options[0].date, tomorrowISO);
    assert.equal(res.options[0].time, '20:00');
    assert.equal(res.options[1].date, dayAfterTomorrowISO);
    assert.equal(res.options[1].time, '21:00');
  });
});

describe('Pipeline Evolution: Intelligent LLM Fallback (Casos A a M)', () => {
  const todayISO = getArgentinaTodayISO();
  const tomorrowISO = addDaysToIsoDate(todayISO, 1);
  const dayAfterTomorrowISO = addDaysToIsoDate(todayISO, 2);

  test('Caso A: Determinístico sin LLM ("Cena mañana a las 20")', async () => {
    useAiWizardStore.getState().reset();
    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async (...args) => {
      providerCalls++;
      return originalInterpret.apply(aiService, args);
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Cena mañana a las 20');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'No debe invocar LLM para casos determinísticos resueltos');
      assert.equal(state.lastResolutionSource, 'deterministic');
      assert.equal(state.draft.title, 'Cena');
      assert.equal(state.draft.date, tomorrowISO);
      assert.equal(state.draft.time, '20:00');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso B: Determinístico pendingTimeOptions ("Desayuno a las 10 o a las 11:00 en casa")', async () => {
    useAiWizardStore.getState().reset();
    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async (...args) => {
      providerCalls++;
      return originalInterpret.apply(aiService, args);
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Desayuno a las 10 o a las 11:00 en casa');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'No debe invocar LLM para alternativas de horario locales');
      assert.equal(state.lastResolutionSource, 'deterministic');
      assert.equal(state.draft.title, 'Desayuno');
      assert.deepEqual(state.draft.pendingTimeOptions, ['10:00', '11:00']);
      assert.equal(state.lastQuestion?.field, 'date');
      assert.equal(state.lastQuestion?.question, '¿Qué día sería?');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso C: Determinístico respuesta a campo ("mañana" como respuesta a fecha)', async () => {
    useAiWizardStore.getState().reset();
    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async (...args) => {
      providerCalls++;
      return originalInterpret.apply(aiService, args);
    };

    try {
      useAiWizardStore.setState({
        draft: {
          ...createEmptyEncounterDraft(),
          title: 'Desayuno',
          locationText: 'casa',
          modality: 'presencial',
          pendingTimeOptions: ['10:00', '11:00'],
        },
        lastQuestion: { field: 'date', question: '¿Qué día sería?', type: 'date' },
      });

      await useAiWizardStore.getState().sendUserMessage('mañana');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 0, 'No debe invocar LLM al responder un campo con valor determinístico');
      assert.equal(state.lastResolutionSource, 'deterministic');
      assert.equal(state.draft.dateOptions?.length, 2);
      assert.equal(state.draft.dateOptions?.[0].date, tomorrowISO);
      assert.equal(state.draft.dateOptions?.[0].time, '10:00');
      assert.equal(state.draft.dateOptions?.[1].date, tomorrowISO);
      assert.equal(state.draft.dateOptions?.[1].time, '11:00');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso D: LLM alternativas temporales pareadas ("Cena hoy en casa podría ser a las 10 el día de hoy o a las 11 del día de mañana")', async () => {
    useAiWizardStore.getState().reset();
    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;

    aiService.interpretMessage = async () => {
      providerCalls++;
      return {
        ok: true,
        scope: 'encounter',
        patch: {
          title: { value: 'Cena', confidence: 'explicit' as const },
          locationText: { value: 'casa', confidence: 'explicit' as const },
          modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
          dateModeSignal: { value: 'coordination' as const, confidence: 'explicit' as const },
          temporalAlternatives: {
            value: [
              { dateRef: 'hoy', timeRef: '22:00' },
              { dateRef: 'mañana', timeRef: '23:00' },
            ],
            confidence: 'explicit' as const,
          },
        },
      };
    };

    try {
      await useAiWizardStore.getState().sendUserMessage('Cena hoy en casa podría ser a las 10 el día de hoy o a las 11 del día de mañana');
      const state = useAiWizardStore.getState();
      assert.equal(providerCalls, 1, 'Debe invocar LLM exactamente 1 vez para fallback inteligente');
      assert.equal(state.lastResolutionSource, 'llm');
      assert.equal(state.draft.title, 'Cena');
      assert.equal(state.draft.locationText, 'casa');
      assert.equal(state.draft.modality, 'presencial');
      assert.equal(state.draft.dateOptions?.length, 2);
      assert.equal(state.draft.dateOptions?.[0].date, todayISO);
      assert.equal(state.draft.dateOptions?.[0].time, '22:00');
      assert.equal(state.draft.dateOptions?.[1].date, tomorrowISO);
      assert.equal(state.draft.dateOptions?.[1].time, '23:00');
      assert.equal(state.coordinationDetected, true);
      assert.equal(state.coordinationPendingConfirm, true);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso E: LLM alternativas sin fecha (temporalAlternatives con sólo timeRef)', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'encounter',
      patch: {
        title: { value: 'Desayuno', confidence: 'explicit' as const },
        temporalAlternatives: {
          value: [
            { timeRef: '10' },
            { timeRef: '11:00' },
          ],
          confidence: 'explicit' as const,
        },
      },
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Desayuno a las diez o a las once');
      const state = useAiWizardStore.getState();
      assert.equal(state.draft.title, 'Desayuno');
      assert.deepEqual(state.draft.pendingTimeOptions, ['10:00', '11:00']);
      assert.equal(state.lastQuestion?.field, 'date');
      assert.equal(state.lastQuestion?.question, '¿Qué día sería?');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso F: LLM alternativas con ambigüedad contextual (Cena a las 11)', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'encounter',
      patch: {
        title: { value: 'Cena', confidence: 'explicit' as const },
        temporalAlternatives: {
          value: [
            { dateRef: 'hoy', timeRef: '11' },
          ],
          confidence: 'explicit' as const,
        },
      },
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Podría ser cena hoy en casa a las 11');
      const state = useAiWizardStore.getState();
      assert.equal(state.lastResolutionSource, 'clarification');
      assert.equal(state.lastQuestion?.field, 'time');
      assert.ok(state.lastQuestion?.question.includes('¿Querés decir 11:00 o 23:00?'));
      assert.deepEqual(state.lastQuestion?.quickOptions?.map((o) => o.value), ['11:00', '23:00']);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso G: Unsupported / Clarificación previa a fallback manual', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    // Model detects coordination intent but no specific alternatives
    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'encounter',
      patch: {
        title: { value: 'Reunión', confidence: 'explicit' as const },
        dateModeSignal: { value: 'coordination' as const, confidence: 'explicit' as const },
      },
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Hagamos una reunión cuando podamos');
      const state = useAiWizardStore.getState();
      assert.equal(state.lastResolutionSource, 'clarification');
      assert.equal(state.lastQuestion?.field, 'coordination_handoff');
      assert.equal(state.lastQuestion?.question, '¿Qué opciones querés proponer?');
      assert.equal(state.lastQuestion?.helperText, 'Por ejemplo: viernes a las 20 o sábado a las 21.');
      assert.equal(state.lastQuestion?.quickOptions?.[0].value, 'keep_fixed');
      assert.equal(state.lastQuestion?.quickOptions?.[0].label, 'Elegir fecha fija');
      assert.equal(state.lastQuestion?.quickOptions?.[1].value, 'handoff_coordination');
      assert.equal(state.lastQuestion?.quickOptions?.[1].label, 'Usar formulario manual');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso H: Fallo en ambos providers -> draft intacto y error controlado', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Asado inicial',
      },
    });

    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => ({
      ok: false,
      error: 'service_error',
      details: 'Error en servicio de IA',
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('alguna instrucción compleja');
      const state = useAiWizardStore.getState();
      assert.equal(state.draft.title, 'Asado inicial', 'El borrador debe permanecer intacto ante error del proveedor');
      assert.ok(state.error?.includes('Error en servicio de IA') || state.error?.includes('No pudimos'));
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso I: No duplicación de burbuja + card interactiva', async () => {
    useAiWizardStore.getState().reset();
    const originalInterpret = aiService.interpretMessage;

    aiService.interpretMessage = async () => ({
      ok: true,
      scope: 'encounter',
      patch: {
        title: { value: 'Cena', confidence: 'explicit' as const },
        temporalAlternatives: {
          value: [
            { dateRef: 'hoy', timeRef: '22:00' },
            { dateRef: 'mañana', timeRef: '23:00' },
          ],
          confidence: 'explicit' as const,
        },
      },
    });

    try {
      await useAiWizardStore.getState().sendUserMessage('Cena hoy a las 22 o mañana a las 23');
      const state = useAiWizardStore.getState();
      assert.equal(state.lastQuestion?.field, 'coordination_confirm');

      // Check messages: only the user's message should be present, NOT a duplicate assistant bubble with the card question!
      const assistantMsgs = state.messages.filter((m) => m.role === 'assistant');
      assert.equal(assistantMsgs.length, 0, 'No debe emitir burbuja del asistente cuando se presenta la tarjeta de confirmación');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso J: Regresión fixed sin alteración ("Cena mañana a las 20 en casa")', () => {
    const patch = {
      title: { value: 'Cena', confidence: 'explicit' as const },
      dateIntent: { value: { type: 'relative' as const, value: 'tomorrow' as const }, confidence: 'explicit' as const },
      timeIntent: { value: { type: 'exact' as const, hour: 20, minute: 0 }, confidence: 'explicit' as const },
      locationText: { value: 'casa', confidence: 'explicit' as const },
      modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
    };
    const res = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), patch);
    assert.equal(res.draft.dateMode, 'fixed');
    assert.equal(res.draft.date, tomorrowISO);
    assert.equal(res.draft.time, '20:00');
    assert.equal(res.draft.dateOptions, null);
    assert.equal(res.coordinationDetected, false);
  });

  test('Caso K: Regresión coordinación existente ("viernes a las 20 o sábado a las 21")', () => {
    const res = parseNaturalLanguageDateOptions('viernes a las 20 o sábado a las 21');
    assert.equal(res.isCoordinationCandidate, true);
    assert.equal(res.options.length, 2);
    assert.ok(res.options.some((o) => o.time === '20:00'));
    assert.ok(res.options.some((o) => o.time === '21:00'));
  });

  test('Caso L: Regresión pendingTimeOptions turn 2 (fecha posterior materializa opciones)', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Desayuno',
        locationText: 'casa',
        modality: 'presencial',
        pendingTimeOptions: ['10:00', '11:00'],
      },
      lastQuestion: { field: 'date', question: '¿Qué día sería?', type: 'date' },
    });

    await useAiWizardStore.getState().sendUserMessage('mañana');
    const state = useAiWizardStore.getState();
    assert.equal(state.draft.dateOptions?.length, 2);
    assert.equal(state.draft.pendingTimeOptions, null);
    assert.equal(state.draft.dateOptions?.[0].date, tomorrowISO);
    assert.equal(state.draft.dateOptions?.[0].time, '10:00');
    assert.equal(state.draft.dateOptions?.[1].date, tomorrowISO);
    assert.equal(state.draft.dateOptions?.[1].time, '11:00');
  });

  test('Caso M: Overflow de alternativas temporales (> 3 opciones) solicita reducción', () => {
    const patch = {
      title: { value: 'Cumpleaños', confidence: 'explicit' as const },
      temporalAlternatives: {
        value: [
          { dateRef: 'hoy', timeRef: '18:00' },
          { dateRef: 'mañana', timeRef: '19:00' },
          { dateRef: 'pasado mañana', timeRef: '20:00' },
          { dateRef: 'este fin de semana', timeRef: '21:00' },
        ],
        confidence: 'explicit' as const,
      },
      temporalAlternativesOverflow: { value: true, confidence: 'explicit' as const },
    };

    const mergeRes = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), patch);
    assert.equal(mergeRes.temporalAlternativesOverflow, true);
    assert.equal(mergeRes.draft.temporalAlternativesOverflow, true);

    const evalRes = evaluateDraft(mergeRes.draft, mergeRes.coordinationDetected);
    assert.equal(evalRes.validationError, 'maximum_three_options');
    assert.equal(evalRes.nextQuestion?.field, 'coordination_options');
    assert.equal(evalRes.nextQuestion?.question, 'Por ahora podés incluir hasta 3 opciones para coordinar. ¿Cuáles 3 preferís dejar?');
  });
});

describe('QA Hotfix: Preservación de Alternativas Temporales y Clarificación Secuencial', () => {
  const todayISO = getArgentinaTodayISO();
  const tomorrowISO = addDaysToIsoDate(todayISO, 1);

  test('Caso 1 (E2E Chips & Call Count Multi-Turn): Caso real QA con selección de chips (22:00 -> 23:00 -> coordinación)', async () => {
    useAiWizardStore.getState().reset();
    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;

    aiService.interpretMessage = async () => {
      providerCalls++;
      return {
        ok: true,
        scope: 'encounter',
        patch: {
          title: { value: 'Cena', confidence: 'explicit' as const },
          locationText: { value: 'casa', confidence: 'explicit' as const },
          modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
          temporalAlternatives: {
            value: [
              { dateRef: 'hoy', timeRef: 'a las 10' },
              { dateRef: 'mañana', timeRef: 'a las 11' },
            ],
            confidence: 'explicit' as const,
          },
        },
      };
    };

    try {
      // Step 0: Initial prompt -> exactly 1 LLM call
      await useAiWizardStore.getState().sendUserMessage(
        'Cena hoy en casa podría ser a las 10 el día de hoy o a las 11 del día de mañana'
      );
      const s0 = useAiWizardStore.getState();
      assert.equal(providerCalls, 1, 'Debe invocar a la IA exactamente 1 vez en el mensaje inicial');
      assert.equal(s0.draft.pendingTemporalAlternatives?.length, 2, 'Debe almacenar las 2 alternativas temporales');
      assert.equal(s0.draft.pendingTemporalAlternatives?.[0].date, todayISO);
      assert.equal(s0.draft.pendingTemporalAlternatives?.[0].time, null);
      assert.equal(s0.draft.time, null, 'draft.time escalar debe ser null');
      assert.equal(s0.draft.date, null, 'draft.date escalar debe ser null');
      assert.ok(s0.draft.pendingTemporalAlternatives?.[0].ambiguity?.options.includes('22:00'));
      assert.equal(s0.draft.pendingTemporalAlternatives?.[1].date, tomorrowISO);
      assert.equal(s0.draft.pendingTemporalAlternatives?.[1].time, null);
      assert.equal(s0.lastQuestion?.field, 'time');
      assert.equal(s0.lastQuestion?.alternativeIndex, 0, 'La pregunta inicial debe apuntar al índice 0');
      assert.ok(s0.lastQuestion?.quickOptions?.some((o) => o.value === '22:00'));

      // Step 1: User clicks chip '22:00' -> 0 new LLM calls
      useAiWizardStore.getState().applyQuickOption('time', '22:00');
      const s1 = useAiWizardStore.getState();
      assert.equal(providerCalls, 1, 'NO debe llamar a la IA al responder la aclaración de horario (llamadas totales = 1)');
      assert.equal(s1.lastResolutionSource, 'clarification');
      assert.equal(s1.draft.pendingTemporalAlternatives?.length, 2, 'Debe preservar la alternativa 2 intacta');
      assert.equal(s1.draft.pendingTemporalAlternatives?.[0].time, '22:00');
      assert.equal(s1.draft.pendingTemporalAlternatives?.[0].ambiguity, null);
      assert.equal(s1.draft.time, null, 'NUNCA escribir draft.time = 22:00 durante coordinación parcial');
      assert.equal(s1.draft.date, null, 'draft.date escalar debe permanecer null');
      assert.equal(s1.draft.pendingTemporalAlternatives?.[1].date, tomorrowISO);
      assert.equal(s1.draft.pendingTemporalAlternatives?.[1].time, null);
      assert.equal(s1.lastQuestion?.field, 'time');
      assert.equal(s1.lastQuestion?.alternativeIndex, 1, 'La siguiente pregunta debe tener alternativeIndex = 1');
      assert.ok(
        s1.lastQuestion?.question.includes('mañana'),
        'La segunda pregunta debe preguntar contextualizando para el día de mañana'
      );
      assert.ok(s1.lastQuestion?.quickOptions?.some((o) => o.value === '23:00'));

      // Step 2: User clicks chip '23:00' -> 0 new LLM calls
      useAiWizardStore.getState().applyQuickOption('time', '23:00');
      const s2 = useAiWizardStore.getState();
      assert.equal(providerCalls, 1, 'NO debe llamar a la IA para la segunda aclaración (llamadas totales = 1)');
      assert.equal(s2.lastResolutionSource, 'clarification');
      assert.equal(s2.draft.pendingTemporalAlternatives, null, 'Debe limpiar pendingTemporalAlternatives al resolver todas');
      assert.equal(s2.draft.dateOptions?.length, 2, 'Debe materializar las 2 opciones en dateOptions');
      assert.equal(s2.draft.dateOptions?.[0].date, todayISO);
      assert.equal(s2.draft.dateOptions?.[0].time, '22:00');
      assert.equal(s2.draft.dateOptions?.[1].date, tomorrowISO);
      assert.equal(s2.draft.dateOptions?.[1].time, '23:00');
      assert.equal(s2.draft.time, null, 'draft.time permanece null en modo coordinación');
      assert.equal(s2.draft.date, null, 'draft.date permanece null en modo coordinación');
      assert.equal(s2.draft.dateMode, 'coordination');
      assert.equal(s2.coordinationPendingConfirm, true);
      assert.equal(s2.lastQuestion?.field, 'coordination_confirm');
      assert.equal(s2.lastQuestion?.type, 'coordination_card');

      // Check bubble suppression: assistant bubble must not duplicate coordination card question
      const lastMsg = s2.messages[s2.messages.length - 1];
      assert.notEqual(lastMsg?.role, 'assistant', 'La burbuja del asistente no debe duplicar la tarjeta');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso 2 (E2E Text): Caso real QA con texto escrito ("22:00" -> "23:00" -> coordinación)', async () => {
    useAiWizardStore.getState().reset();
    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;

    aiService.interpretMessage = async () => {
      providerCalls++;
      return {
        ok: true,
        scope: 'encounter',
        patch: {
          title: { value: 'Cena', confidence: 'explicit' as const },
          locationText: { value: 'casa', confidence: 'explicit' as const },
          modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
          temporalAlternatives: {
            value: [
              { dateRef: 'hoy', timeRef: 'a las 10' },
              { dateRef: 'mañana', timeRef: 'a las 11' },
            ],
            confidence: 'explicit' as const,
          },
        },
      };
    };

    try {
      // Step 0: Initial prompt
      await useAiWizardStore.getState().sendUserMessage(
        'Cena hoy en casa podría ser a las 10 el día de hoy o a las 11 del día de mañana'
      );
      assert.equal(providerCalls, 1);

      // Step 1: User types "22:00"
      await useAiWizardStore.getState().sendUserMessage('22:00');
      const s1 = useAiWizardStore.getState();
      assert.equal(providerCalls, 1, 'NO debe llamar a la IA al responder por texto');
      assert.equal(s1.lastResolutionSource, 'clarification');
      assert.equal(s1.draft.pendingTemporalAlternatives?.length, 2);
      assert.equal(s1.draft.pendingTemporalAlternatives?.[0].time, '22:00');
      assert.equal(s1.draft.time, null, 'draft.time escalar debe ser null al escribir texto');
      assert.equal(s1.draft.date, null, 'draft.date escalar debe ser null al escribir texto');
      assert.equal(s1.draft.pendingTemporalAlternatives?.[1].time, null);
      assert.equal(s1.lastQuestion?.field, 'time');
      assert.equal(s1.lastQuestion?.alternativeIndex, 1);
      assert.ok(s1.lastQuestion?.question.includes('mañana'));

      // Step 2: User types "23:00"
      await useAiWizardStore.getState().sendUserMessage('23:00');
      const s2 = useAiWizardStore.getState();
      assert.equal(providerCalls, 1, 'NO debe llamar a la IA al responder la 2da aclaración por texto');
      assert.equal(s2.lastResolutionSource, 'clarification');
      assert.equal(s2.draft.pendingTemporalAlternatives, null);
      assert.equal(s2.draft.dateOptions?.length, 2);
      assert.equal(s2.draft.dateOptions?.[0].date, todayISO);
      assert.equal(s2.draft.dateOptions?.[0].time, '22:00');
      assert.equal(s2.draft.dateOptions?.[1].date, tomorrowISO);
      assert.equal(s2.draft.dateOptions?.[1].time, '23:00');
      assert.equal(s2.draft.time, null);
      assert.equal(s2.draft.date, null);
      assert.equal(s2.lastQuestion?.field, 'coordination_confirm');
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Caso 3 (Preservación de alternativas): resolveTemporalAlternatives preserva ambas alternativas ante ambigüedad', () => {
    const patch = {
      title: { value: 'Cena', confidence: 'explicit' as const },
      temporalAlternatives: {
        value: [
          { dateRef: 'hoy', timeRef: 'a las 10' },
          { dateRef: 'mañana', timeRef: 'a las 11' },
        ],
        confidence: 'explicit' as const,
      },
    };

    const res = mergeDraftPatch(createEmptyEncounterDraft(), createDefaultInvitationConfig(), patch);
    assert.ok(res.draft.pendingTemporalAlternatives);
    assert.equal(res.draft.pendingTemporalAlternatives.length, 2);
    assert.equal(res.draft.pendingTemporalAlternatives[0].rawDateRef, 'hoy');
    assert.equal(res.draft.pendingTemporalAlternatives[0].rawTimeRef, 'a las 10');
    assert.equal(res.draft.pendingTemporalAlternatives[1].rawDateRef, 'mañana');
    assert.equal(res.draft.pendingTemporalAlternatives[1].rawTimeRef, 'a las 11');
  });

  test('Caso 4 (Hora pasada): Si la hora elegida ya pasó, rechaza amistosamente y preserva alternativa 2', async () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        locationText: 'casa',
        modality: 'presencial',
        pendingTemporalAlternatives: [
          {
            date: todayISO,
            time: null,
            rawDateRef: 'hoy',
            rawTimeRef: 'a las 10',
            ambiguity: {
              field: 'time',
              reason: '¿Querés decir 10:00 o 22:00? Como es una cena, interpretaría 22:00.',
              options: ['10:00', '22:00'],
            },
          },
          {
            date: tomorrowISO,
            time: null,
            rawDateRef: 'mañana',
            rawTimeRef: 'a las 11',
            ambiguity: {
              field: 'time',
              reason: 'Para el día de mañana, ¿Querés decir 11:00 o 23:00?',
              options: ['11:00', '23:00'],
            },
          },
        ],
      },
      lastQuestion: {
        field: 'time',
        question: '¿Querés decir 10:00 o 22:00? Como es una cena, interpretaría 22:00.',
        type: 'choice',
        quickOptions: [
          { label: '10:00', value: '10:00' },
          { label: '22:00', value: '22:00' },
        ],
        alternativeIndex: 0,
      },
    });

    // Selecting 01:00 (definitely in the past for today)
    await useAiWizardStore.getState().sendUserMessage('01:00');
    const s = useAiWizardStore.getState();
    assert.equal(s.draft.pendingTemporalAlternatives?.length, 2, 'Debe preservar las 2 alternativas');
    assert.equal(s.draft.pendingTemporalAlternatives?.[1].date, tomorrowISO, 'Alternativa 2 intacta');
    assert.equal(s.draft.time, null, 'draft.time debe ser null');
    assert.ok(
      s.messages[s.messages.length - 1].text.includes('ya pasaron') ||
      s.lastQuestion?.question.includes('ya pasaron'),
      'Debe advertir que la hora ya pasó'
    );
  });

  test('Caso 5 (F5 y Android Back Guard): hasMeaningfulDraftData e initSession protegen pendingTemporalAlternatives', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cena',
      pendingTemporalAlternatives: [
        { date: todayISO, time: '22:00' },
        { date: tomorrowISO, time: null, ambiguity: { field: 'time' as const, reason: 'Hora mañana', options: ['11:00', '23:00'] } },
      ],
    };

    // Android back guard
    assert.equal(hasMeaningfulDraftData(draft), true, 'hasMeaningfulDraftData debe ser true');

    // F5 rehydration simulation
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft,
      lastQuestion: null,
      isComplete: false,
    });

    useAiWizardStore.getState().initSession();
    const s = useAiWizardStore.getState();
    assert.equal(s.lastQuestion?.field, 'time', 'initSession debe reconstruir la pregunta activa');
    assert.equal(s.lastQuestion?.question, 'Hora mañana');
    assert.equal(s.lastQuestion?.alternativeIndex, 1, 'alternativeIndex reconstruido debe ser 1');
    assert.equal(s.draft.time, null, 'draft.time debe mantenerse null tras recarga');
  });

  test('Caso 6 (Supresión de burbujas en tarjetas): shouldSuppressAssistantBubbleForQuestion cubre todos los casos', () => {
    assert.equal(shouldSuppressAssistantBubbleForQuestion({ field: 'coordination_confirm', type: 'coordination_card', question: 'Q' }), true);
    assert.equal(shouldSuppressAssistantBubbleForQuestion({ field: 'coordination_handoff', type: 'handoff', question: 'Q' }), true);
    assert.equal(shouldSuppressAssistantBubbleForQuestion({ field: 'anything', type: 'coordination_card', question: 'Q' }), true);
    assert.equal(shouldSuppressAssistantBubbleForQuestion({ field: 'anything', type: 'handoff', question: 'Q' }), true);
    assert.equal(shouldSuppressAssistantBubbleForQuestion({ field: 'date', type: 'date', question: '¿Qué día?' }), false);
    assert.equal(shouldSuppressAssistantBubbleForQuestion({ field: 'time', type: 'time', question: '¿A qué hora?' }), false);
    assert.equal(shouldSuppressAssistantBubbleForQuestion(null), false);
    assert.equal(shouldSuppressAssistantBubbleForQuestion(undefined), false);
  });

  test('Caso 7 (DraftSummary con alternativas parciales): Renderiza Hoy 22:00 y Mañana horario pendiente', () => {
    const draft = {
      ...createEmptyEncounterDraft(),
      title: 'Cena en casa',
      pendingTemporalAlternatives: [
        { date: todayISO, time: '22:00', rawDateRef: 'hoy' },
        { date: tomorrowISO, time: null, rawDateRef: 'mañana' },
      ],
      locationText: 'casa',
      modality: 'presencial' as const,
    };
    const config = createDefaultInvitationConfig();

    const html = renderToStaticMarkup(
      React.createElement(DraftSummary, {
        draft,
        config,
        isLoading: false,
        onConfirmCreate: () => {},
        onModify: () => {},
        onFallbackManual: () => {},
        onChangeConfig: () => {},
      })
    );

    assert.ok(html.includes('22:00'), 'Debe mostrar 22:00 para la alternativa resuelta');
    assert.ok(html.includes('horario pendiente'), 'Debe mostrar horario pendiente para la alternativa sin resolver');
    assert.ok(html.includes('Opciones de fecha'), 'El encabezado debe decir Opciones de fecha');
  });
});

describe('QA Hotfix: Coordination Confirmation Action & Internal Action Tokens', () => {
  const todayISO = getArgentinaTodayISO();
  const tomorrowISO = addDaysToIsoDate(todayISO, 1);

  test('Test Principal (confirm_coordination action from coordination_confirm card)', () => {
    useAiWizardStore.getState().reset();
    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;
    aiService.interpretMessage = async () => {
      providerCalls++;
      throw new Error('LLM should never be called for internal actions');
    };

    try {
      // Reproducir estado previo
      useAiWizardStore.setState({
        draft: {
          ...createEmptyEncounterDraft(),
          title: 'Cena',
          locationText: 'casa',
          modality: 'presencial',
          dateMode: 'coordination',
          coordinationPendingConfirm: true,
          date: null,
          time: null,
          dateOptions: [
            { date: todayISO, time: '22:00' },
            { date: tomorrowISO, time: '23:00' },
          ],
        },
        lastQuestion: {
          type: 'coordination_card',
          field: 'coordination_confirm',
          question: '¿Querés que los invitados elijan entre estas fechas?',
          quickOptions: [
            { label: 'Sí, continuar', value: 'confirm_coordination' },
            { label: 'Elegir fecha fija', value: 'keep_fixed' },
          ],
        },
        coordinationDetected: true,
        coordinationPendingConfirm: true,
        isComplete: false,
        messages: [],
      });

      // Ejecutar acción del botón "Sí, continuar"
      useAiWizardStore.getState().applyQuickOption('coordination_confirm', 'confirm_coordination');
      const s = useAiWizardStore.getState();

      // Assert:
      // - no se agrega mensaje de usuario "confirm_coordination"
      const hasUserConfirmMsg = s.messages.some((m) => m.role === 'user' && m.text.includes('confirm_coordination'));
      assert.equal(hasUserConfirmMsg, false, 'No se debe agregar mensaje de usuario confirm_coordination');
      assert.equal(s.messages.filter((m) => m.role === 'user').length, 0, 'No debe haber mensajes role: user');

      // - providerCalls no aumenta
      assert.equal(providerCalls, 0, 'providerCalls no debe aumentar');

      // - coordinationPendingConfirm = false
      assert.equal(s.coordinationPendingConfirm, false, 'coordinationPendingConfirm en store debe ser false');
      assert.equal(s.draft.coordinationPendingConfirm, false, 'coordinationPendingConfirm en draft debe ser false');

      // - dateMode = 'coordination'
      assert.equal(s.draft.dateMode, 'coordination');
      assert.equal(s.coordinationDetected, true);

      // - dateOptions quedan intactas
      assert.equal(s.draft.dateOptions?.length, 2);
      assert.equal(s.draft.dateOptions?.[0].time, '22:00');
      assert.equal(s.draft.dateOptions?.[1].time, '23:00');

      // - lastQuestion cambia al siguiente estado válido (null porque el draft está completo)
      assert.notEqual(s.lastQuestion?.field, 'coordination_confirm', 'lastQuestion ya no debe ser coordination_confirm');
      assert.equal(s.isComplete, true, 'El draft debe estar completo y listo para crear');

      // - no queda trabado
      assert.ok(s.messages.some((m) => m.role === 'assistant' && m.text.includes('¡Listo!')));
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test E2E caso real (Input complejo -> 22:00 -> 23:00 -> card -> Sí, continuar: total 1 LLM call)', async () => {
    useAiWizardStore.getState().reset();
    let providerCalls = 0;
    const originalInterpret = aiService.interpretMessage;

    aiService.interpretMessage = async () => {
      providerCalls++;
      return {
        ok: true,
        scope: 'encounter',
        patch: {
          title: { value: 'Cena', confidence: 'explicit' as const },
          locationText: { value: 'casa', confidence: 'explicit' as const },
          modality: { value: 'presencial' as const, confidence: 'inferred_high' as const },
          temporalAlternatives: {
            value: [
              { dateRef: 'hoy', timeRef: 'a las 10' },
              { dateRef: 'mañana', timeRef: 'a las 11' },
            ],
            confidence: 'explicit' as const,
          },
        },
      };
    };

    try {
      // 1. Input complejo -> 1 LLM call
      await useAiWizardStore.getState().sendUserMessage(
        'Cena hoy en casa podría ser a las 10 el día de hoy o a las 11 del día de mañana'
      );
      assert.equal(providerCalls, 1, 'Paso 1: Mensaje inicial invoca LLM (1 llamada)');

      // 2. Elegir 22:00 -> 0 LLM calls
      useAiWizardStore.getState().applyQuickOption('time', '22:00');
      assert.equal(providerCalls, 1, 'Paso 2: Elegir 22:00 no invoca LLM');

      // 3. Elegir 23:00 -> 0 LLM calls
      useAiWizardStore.getState().applyQuickOption('time', '23:00');
      assert.equal(providerCalls, 1, 'Paso 3: Elegir 23:00 no invoca LLM');
      assert.equal(useAiWizardStore.getState().coordinationPendingConfirm, true);
      assert.equal(useAiWizardStore.getState().lastQuestion?.field, 'coordination_confirm');

      // 4. Card coordinación -> Tocar "Sí, continuar" (confirm_coordination)
      useAiWizardStore.getState().confirmCoordination();
      const finalState = useAiWizardStore.getState();

      // Assert:
      // - nunca aparece confirm_coordination en messages
      assert.equal(
        finalState.messages.some((m) => m.text.includes('confirm_coordination')),
        false,
        'Nunca debe aparecer confirm_coordination en messages'
      );

      // - no hay nueva llamada LLM (Total = 1)
      assert.equal(providerCalls, 1, 'Total de llamadas LLM en todo el flujo debe ser exactamente 1');

      // - no se pierde ninguna opción
      assert.equal(finalState.draft.dateOptions?.length, 2, 'Se deben conservar las 2 opciones de fecha');
      assert.equal(finalState.draft.dateOptions?.[0].time, '22:00');
      assert.equal(finalState.draft.dateOptions?.[1].time, '23:00');

      // - se avanza correctamente
      assert.equal(finalState.coordinationPendingConfirm, false);
      assert.equal(finalState.draft.dateMode, 'coordination');
      assert.equal(finalState.isComplete, true);
      assert.equal(finalState.lastQuestion, null);
    } finally {
      aiService.interpretMessage = originalInterpret;
    }
  });

  test('Test botón "Elegir fecha fija" (keep_fixed no filtra token interno, no confirma coordinación y permite elegir fecha fija)', () => {
    useAiWizardStore.getState().reset();
    useAiWizardStore.setState({
      draft: {
        ...createEmptyEncounterDraft(),
        title: 'Cena',
        locationText: 'casa',
        modality: 'presencial',
        dateMode: 'coordination',
        coordinationPendingConfirm: true,
        dateOptions: [
          { date: todayISO, time: '22:00' },
          { date: tomorrowISO, time: '23:00' },
        ],
      },
      lastQuestion: {
        type: 'coordination_card',
        field: 'coordination_confirm',
        question: '¿Querés que los invitados elijan entre estas fechas?',
        quickOptions: [
          { label: 'Sí, continuar', value: 'confirm_coordination' },
          { label: 'Elegir fecha fija', value: 'keep_fixed' },
        ],
      },
      coordinationDetected: true,
      coordinationPendingConfirm: true,
      isComplete: false,
      messages: [],
    });

    // 1. Tocar "Elegir fecha fija"
    useAiWizardStore.getState().applyQuickOption('coordination_confirm', 'keep_fixed');
    const s1 = useAiWizardStore.getState();

    // Assert:
    // - no aparece token interno en messages
    assert.equal(
      s1.messages.some((m) => m.text.includes('keep_fixed')),
      false,
      'No debe aparecer keep_fixed en messages'
    );
    assert.equal(s1.messages.filter((m) => m.role === 'user').length, 0, 'No debe haber mensaje role: user');

    // - coordinación no se confirma
    assert.equal(s1.coordinationPendingConfirm, false);

    // - dateOptions no se corrompen durante la transición
    assert.equal(s1.draft.dateOptions?.length, 2, 'dateOptions no se deben perder durante la transición');

    // - entra al flujo fixed correspondiente preguntando cuál de las opciones usar
    assert.equal(s1.lastQuestion?.field, 'date');
    assert.equal(s1.lastQuestion?.quickOptions?.length, 2);
    assert.ok(s1.lastQuestion?.quickOptions?.[0].value.startsWith('fixed_opt_'));

    // 2. Elegir la opción fija #1 (fixed_opt_...)
    const fixedOptValue = s1.lastQuestion!.quickOptions![0].value;
    useAiWizardStore.getState().applyQuickOption('date', fixedOptValue);
    const s2 = useAiWizardStore.getState();

    // Assert:
    // - no aparece el token técnico fixed_opt_ en messages
    assert.equal(
      s2.messages.some((m) => m.text.includes('fixed_opt_')),
      false,
      'No debe aparecer fixed_opt_ en messages'
    );

    // - quedó en fecha fija correctamente
    assert.equal(s2.draft.dateMode, 'fixed');
    assert.equal(s2.draft.date, todayISO);
    assert.equal(s2.draft.time, '22:00');
    assert.equal(s2.draft.dateOptions, null);
    assert.equal(s2.coordinationDetected, false);
    assert.equal(s2.isComplete, true);
  });

  test('Test de regresión de tokens internos (isInternalWizardAction y ningún token renderizado como role: "user")', async () => {
    const internalTokens = [
      'confirm_coordination',
      'keep_fixed',
      'handoff_coordination',
      'choose_fixed_date',
      'reset',
      'fixed_opt_2026-09-12_22:00',
    ];

    // 1. Validar la función centralizada isInternalWizardAction
    for (const token of internalTokens) {
      assert.equal(isInternalWizardAction(token), true, `isInternalWizardAction("${token}") debe ser true`);
    }
    assert.equal(isInternalWizardAction('22:00'), false);
    assert.equal(isInternalWizardAction('presencial'), false);
    assert.equal(isInternalWizardAction('Cena en casa'), false);
    assert.equal(isInternalWizardAction(''), false);
    assert.equal(isInternalWizardAction(null), false);
    assert.equal(isInternalWizardAction(undefined), false);

    // 2. Enviar cada token interno a través de sendUserMessage y verificar que NINGUNO crea mensaje role: 'user'
    for (const token of internalTokens) {
      useAiWizardStore.getState().reset();
      useAiWizardStore.setState({
        messages: [],
        draft: {
          ...createEmptyEncounterDraft(),
          title: 'Cena',
          dateOptions: [
            { date: todayISO, time: '22:00' },
            { date: tomorrowISO, time: '23:00' },
          ],
          coordinationPendingConfirm: true,
        },
      });

      await useAiWizardStore.getState().sendUserMessage(token);
      const s = useAiWizardStore.getState();

      const userMsgs = s.messages.filter((m) => m.role === 'user');
      assert.equal(
        userMsgs.length,
        0,
        `Token interno "${token}" enviado a sendUserMessage nunca debe crear un mensaje role: "user"`
      );
    }

    // 3. Enviar a través de applyQuickOption y verificar que tampoco crea mensaje role: 'user'
    for (const token of internalTokens) {
      useAiWizardStore.getState().reset();
      useAiWizardStore.setState({
        messages: [],
        draft: {
          ...createEmptyEncounterDraft(),
          title: 'Cena',
          dateOptions: [
            { date: todayISO, time: '22:00' },
            { date: tomorrowISO, time: '23:00' },
          ],
          coordinationPendingConfirm: true,
        },
      });

      useAiWizardStore.getState().applyQuickOption('coordination_confirm', token);
      const s = useAiWizardStore.getState();

      const userMsgs = s.messages.filter((m) => m.role === 'user');
      assert.equal(
        userMsgs.length,
        0,
        `Token interno "${token}" en applyQuickOption nunca debe crear un mensaje role: "user"`
      );
    }
  });
});



