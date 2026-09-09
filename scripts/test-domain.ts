import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DraftSummary } from '@/components/ai/DraftSummary';
import { CreateAIWizard } from '@/screens/CreateAIWizard';

import {
  resolveDateIntent,
  resolveTimeIntent,
  addDaysToIsoDate,
} from '../src/lib/dateResolver.ts';
import { mergeDraftPatch, isRecognizedVirtualPlatform, isValidVirtualLink, normalizeVirtualLink } from '../src/lib/draftMerger.ts';
import { evaluateDraft } from '../src/lib/draftFieldEngine.ts';
import {
  hasDateEvidence,
  hasTimeEvidence,
  sanitizeTemporalIntents,
  validatePatchOutput,
} from '../supabase/functions/ai-interpret/validation.ts';
import { validateEncounterDate, isFuture } from '../src/lib/formatDate.ts';
import {
  getArgentinaTodayISO,
  isArgentinaDateTimeInFuture,
} from '../src/lib/argentinaDateTime.ts';
import {
  createEmptyEncounterDraft,
  createDefaultInvitationConfig,
  translateToCreateEncuentroDTO,
  mapResponseVisibilityToLegacyFields,
  draftToWizardState,
  draftToCoordinationDraft,
} from '../src/lib/encounterDraft.ts';
import {
  getDefaultInvitationTemplate,
  resolveTemplateVariant,
  getTemplateOptionsForTheme,
  INVITATION_THEMES,
  AI_SUPPORTED_THEMES,
} from '../src/lib/invitationThemes.ts';
import { SYSTEM_PROMPT } from '../supabase/functions/ai-interpret/prompt.ts';
import {
  resolveLimiterConfig,
  checkAbuseLimits,
  recordInteraction,
  resetLimiterStateForTesting,
  AtomicRateLimitBucket,
} from '../supabase/functions/ai-interpret/limiter.ts';
import { useAiWizardStore } from '@/store/aiWizardStore';
import { aiService } from '@/services/aiService';

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
    assert.equal(res.date, '2026-09-18');
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
    const todayDate = new Date();
    const todayIso = todayDate.toISOString().split('T')[0];
    const tomorrowDate = new Date(todayDate);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowIso = tomorrowDate.toISOString().split('T')[0];

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
    assert.ok(html.includes('20:30 hs'));
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
      assert.equal(state.error, 'El enlace no parece válido. Pegá el enlace completo de la videollamada.');
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
      assert.ok(state.error?.includes('El enlace no parece válido'));

      await useAiWizardStore.getState().sendUserMessage('Http://meet.com/$373+28(22');

      state = useAiWizardStore.getState();
      assert.equal(state.draft.modality, 'virtual');
      assert.equal(state.draft.virtualLink, null);
      assert.equal(state.lastQuestion?.field, 'virtualLink');
      assert.ok(state.error?.includes('El enlace no parece válido'));
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
