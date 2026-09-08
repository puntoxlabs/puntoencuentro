import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  resolveDateIntent,
  resolveTimeIntent,
} from '../src/lib/dateResolver.ts';
import { mergeDraftPatch } from '../src/lib/draftMerger.ts';
import { evaluateDraft } from '../src/lib/draftFieldEngine.ts';
import {
  createEmptyEncounterDraft,
  createDefaultInvitationConfig,
  translateToCreateEncuentroDTO,
  mapResponseVisibilityToLegacyFields,
  draftToWizardState,
  draftToCoordinationDraft,
} from '../src/lib/encounterDraft.ts';

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
