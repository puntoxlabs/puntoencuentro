import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  resolveDateIntent,
  resolveTimeIntent,
} from '../src/lib/dateResolver.ts';
import { mergeDraftPatch, isRecognizedVirtualPlatform } from '../src/lib/draftMerger.ts';
import { evaluateDraft } from '../src/lib/draftFieldEngine.ts';
import {
  createEmptyEncounterDraft,
  createDefaultInvitationConfig,
  translateToCreateEncuentroDTO,
  mapResponseVisibilityToLegacyFields,
  draftToWizardState,
  draftToCoordinationDraft,
} from '../src/lib/encounterDraft.ts';
import { useAiWizardStore } from '../src/store/aiWizardStore.ts';

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

