import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import {
  hasRecoverableManualDraft,
  hasRecoverableCoordinationDraft,
  hasRecoverableAiDraft,
  saveAiDraftSnapshot,
  getAiDraftSnapshot,
  clearAiDraftSnapshot,
  AI_DRAFT_SNAPSHOT_KEY,
} from '../src/lib/draftRecovery';
import { useWizardStore } from '../src/store/wizardStore';
import { useCoordinationWizardStore } from '../src/store/coordinationWizardStore';
import { useAiWizardStore } from '../src/store/aiWizardStore';
import { draftToWizardState, hasMeaningfulDraftData } from '../src/lib/encounterDraft';

import esTranslations from '../src/i18n/locales/es.json';
import enTranslations from '../src/i18n/locales/en.json';
import ptTranslations from '../src/i18n/locales/pt-BR.json';

// In-memory storage mock for Node testing of local/session storage
if (typeof (globalThis as any).localStorage === 'undefined') {
  const localMap = new Map<string, string>();
  const sessionMap = new Map<string, string>();
  const createStorageMock = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
    get length() { return map.size; },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  });

  (globalThis as any).localStorage = createStorageMock(localMap);
  (globalThis as any).sessionStorage = createStorageMock(sessionMap);
}

test('Mini-sprint A: Recuperación segura de borradores', async (t) => {
  await t.test('1.1 hasRecoverableManualDraft detecta borradores pendientes y descarta ya publicados', () => {
    // Vacío
    assert.strictEqual(hasRecoverableManualDraft(null), false);
    assert.strictEqual(hasRecoverableManualDraft({}), false);
    assert.strictEqual(
      hasRecoverableManualDraft({ titulo: '', descripcion: '', fecha: '', lugar_texto: '' }),
      false
    );

    // Con datos
    assert.strictEqual(
      hasRecoverableManualDraft({ titulo: 'Asado con amigos' }),
      true
    );
    assert.strictEqual(
      hasRecoverableManualDraft({ descripcion: 'Planificando juntada' }),
      true
    );
    assert.strictEqual(
      hasRecoverableManualDraft({ fecha: '2026-11-20' }),
      true
    );

    // Ya publicado (encuentro_id presente) -> NO debe recuperarse
    assert.strictEqual(
      hasRecoverableManualDraft({
        titulo: 'Asado con amigos',
        encuentro_id: 'enc-uuid-1234',
      }),
      false,
      'No debe recuperar un borrador que ya fue creado y publicado'
    );
  });

  await t.test('1.2 hasRecoverableCoordinationDraft detecta opciones y datos de coordinación', () => {
    assert.strictEqual(hasRecoverableCoordinationDraft(null), false);
    assert.strictEqual(
      hasRecoverableCoordinationDraft({ title: '', description: '', options: [] }),
      false
    );

    assert.strictEqual(
      hasRecoverableCoordinationDraft({ title: 'Cena de fin de año' }),
      true
    );
    assert.strictEqual(
      hasRecoverableCoordinationDraft({
        options: [{ localId: '1', date: '2026-11-20', time: '20:00' }],
      }),
      true
    );
  });

  await t.test('1.3 hasRecoverableAiDraft valida datos significativos del borrador de IA', () => {
    assert.strictEqual(hasRecoverableAiDraft(null), false);
    assert.strictEqual(hasRecoverableAiDraft({ title: null } as any), false);
    assert.strictEqual(hasRecoverableAiDraft({ title: 'Pádel viernes' } as any), true);
  });

  await t.test('1.4 Flujo de descartar borrador manual limpia el estado sin arrastrar datos', () => {
    const store = useWizardStore.getState();
    store.reset();

    // Simular usuario completando formulario
    store.setField('titulo', 'Cumpleaños de Nico');
    store.setField('descripcion', 'Traer bebidas');
    store.setField('fecha', '2026-12-05');
    store.setField('hora', '21:30');

    assert.strictEqual(hasRecoverableManualDraft(useWizardStore.getState()), true);

    // Descartar
    store.reset();

    const cleanState = useWizardStore.getState();
    assert.strictEqual(cleanState.titulo, '');
    assert.strictEqual(cleanState.descripcion, '');
    assert.strictEqual(cleanState.fecha, '');
    assert.strictEqual(cleanState.hora, '');
    assert.strictEqual(cleanState.encuentro_id, null);
    assert.strictEqual(hasRecoverableManualDraft(cleanState), false);
  });

  await t.test('1.5 Flujo de descartar borrador de coordinación limpia a initialDraft', () => {
    const store = useCoordinationWizardStore.getState();
    store.resetDraft();

    store.updateDraft({
      title: 'Torneo de tenis',
      options: [{ localId: 'opt-1', date: '2026-11-25', time: '18:00' }],
    });

    assert.strictEqual(hasRecoverableCoordinationDraft(useCoordinationWizardStore.getState().draft), true);

    store.resetDraft();

    const cleanDraft = useCoordinationWizardStore.getState().draft;
    assert.strictEqual(cleanDraft.title, '');
    assert.strictEqual(cleanDraft.options.length, 0);
    assert.strictEqual(hasRecoverableCoordinationDraft(cleanDraft), false);
  });

  await t.test('1.6 Handoff desde IA a manual preserva todos los campos sin pérdida', () => {
    const aiDraft = {
      title: 'After office en Palermo',
      date: '2026-11-14',
      time: '19:00',
      description: 'Cerveza artesanal',
      modality: 'presencial' as const,
      locationText: 'Honduras 5500',
      virtualLink: null,
      dateMode: 'fixed' as const,
      options: [],
      responseDeadline: null,
      durationMinutes: 120,
      creationSource: 'ai' as const,
      customTemplateId: null,
      invitationTemplate: null,
      invitationTheme: 'friends' as const,
      invitationType: 'individual' as const,
      responseVisibility: 'summary' as const,
    };

    const wizardPartial = draftToWizardState(aiDraft, {
      invitationType: 'individual',
      invitationTheme: 'friends',
      invitationTemplate: null,
    });

    assert.strictEqual(wizardPartial.titulo, 'After office en Palermo');
    assert.strictEqual(wizardPartial.fecha, '2026-11-14');
    assert.strictEqual(wizardPartial.hora, '19:00');
    assert.strictEqual(wizardPartial.lugar_texto, 'Honduras 5500');
    assert.strictEqual(wizardPartial.modalidad, 'presencial');
  });

  await t.test('1.7 Ausencia de tokens o secretos en storage de borradores', () => {
    const wizardState = useWizardStore.getState();
    assert.strictEqual((wizardState as any).access_token, undefined);
    assert.strictEqual((wizardState as any).secret_key, undefined);
    assert.strictEqual((wizardState as any).password, undefined);

    const coordDraft = useCoordinationWizardStore.getState().draft;
    assert.strictEqual((coordDraft as any).access_token, undefined);
    assert.strictEqual((coordDraft as any).secret_key, undefined);
  });

  await t.test('1.8 Snapshot de borrador de IA: persistencia en localStorage sin mensajes ni credenciales', () => {
    clearAiDraftSnapshot();
    assert.strictEqual(getAiDraftSnapshot(), null);

    const testDraft = {
      title: 'Cena de graduación',
      date: '2026-12-10',
      time: '21:00',
      description: 'Festejo con el equipo',
      modality: 'presencial' as const,
      locationText: 'Puerto Madero',
      virtualLink: null,
      dateMode: 'fixed' as const,
      options: [],
      responseDeadline: null,
      durationMinutes: 180,
      creationSource: 'ai' as const,
      customTemplateId: null,
      invitationTemplate: null,
      invitationTheme: 'celebration' as const,
      invitationType: 'link_general' as const,
      responseVisibility: 'summary' as const,
    };

    const testConfig = {
      invitationType: 'link_general' as const,
      invitationTheme: 'celebration' as const,
      invitationTemplate: null,
      responseVisibility: 'summary' as const,
    };

    saveAiDraftSnapshot(testDraft, testConfig);

    const snapshot = getAiDraftSnapshot();
    assert.ok(snapshot !== null);
    assert.strictEqual(snapshot.draft?.title, 'Cena de graduación');
    assert.strictEqual(snapshot.draft?.date, '2026-12-10');
    assert.strictEqual(snapshot.draft?.modality, 'presencial');
    assert.strictEqual(snapshot.config?.invitationTheme, 'celebration');

    // Comprobar raw en localStorage para certificar que NO hay sessionId, messages ni credenciales
    const raw = localStorage.getItem('pe_ai_draft_snapshot');
    assert.ok(raw !== null);
    assert.ok(!raw.includes('sessionId'));
    assert.ok(!raw.includes('messages'));
    assert.ok(!raw.includes('token'));
    assert.ok(!raw.includes('auth'));

    clearAiDraftSnapshot();
    assert.strictEqual(getAiDraftSnapshot(), null);
  });

  await t.test('1.9 Restauración de borrador de IA tras cierre de pestaña mediante restoreFromSnapshot', () => {
    const aiStore = useAiWizardStore.getState();
    aiStore.reset();

    const sampleDraft = {
      title: 'Picnic en el Rosedal',
      date: '2026-11-28',
      time: '15:00',
      description: 'Traer mate y lonas',
      modality: 'presencial' as const,
      locationText: 'El Rosedal de Palermo',
      virtualLink: null,
      dateMode: 'fixed' as const,
      options: [],
      responseDeadline: null,
      durationMinutes: 120,
      creationSource: 'ai' as const,
      customTemplateId: null,
      invitationTemplate: null,
      invitationTheme: 'classic' as const,
      invitationType: 'link_general' as const,
      responseVisibility: 'hidden' as const,
    };

    saveAiDraftSnapshot(sampleDraft, { modality: 'presencial', dateMode: 'fixed' });

    // Simular que el store de sesión está limpio/vacío (pestaña cerrada y reabierta)
    // El draft del store en memoria no tiene datos significativos, pero hay un borrador recuperable por snapshot:
    assert.strictEqual(hasMeaningfulDraftData(useAiWizardStore.getState().draft), false);
    assert.strictEqual(hasRecoverableAiDraft(useAiWizardStore.getState().draft), true);

    // Restaurar desde snapshot
    useAiWizardStore.getState().restoreFromSnapshot();

    const activeState = useAiWizardStore.getState();
    assert.ok(activeState.draft !== null);
    assert.strictEqual(activeState.draft?.title, 'Picnic en el Rosedal');
    assert.strictEqual(activeState.draft?.locationText, 'El Rosedal de Palermo');
    assert.strictEqual(activeState.sessionId !== null, true);
    assert.strictEqual(activeState.messages.length, 1);
    assert.strictEqual(activeState.messages[0].role, 'assistant');

    // Descartar
    aiStore.reset();
    clearAiDraftSnapshot();
    assert.strictEqual(hasRecoverableAiDraft(useAiWizardStore.getState().draft), false);
    assert.strictEqual(getAiDraftSnapshot(), null);
  });

  await t.test('1.10 Persistencia y recuperación del paso en CoordinationWizardStore', () => {
    const coordStore = useCoordinationWizardStore.getState();
    coordStore.resetDraft();

    assert.strictEqual(coordStore.step, 1);

    // Avanzar de paso
    coordStore.setStep(3);
    assert.strictEqual(useCoordinationWizardStore.getState().step, 3);

    // Soporta función transformadora
    coordStore.setStep((prev) => prev - 1);
    assert.strictEqual(useCoordinationWizardStore.getState().step, 2);

    // Límites controlados (1 a 4)
    coordStore.setStep(10);
    assert.strictEqual(useCoordinationWizardStore.getState().step, 4);

    coordStore.setStep(-5);
    assert.strictEqual(useCoordinationWizardStore.getState().step, 1);

    // ResetDraft limpia borrador y regresa al paso 1
    coordStore.setStep(3);
    coordStore.resetDraft();
    assert.strictEqual(useCoordinationWizardStore.getState().step, 1);
  });

  await t.test('1.11 Validación rigurosa de snapshot: rechaza expirados (>7d), corruptos, fechas futuras inválidas y estructuras incompatibles', () => {
    const validDraft = {
      title: 'Cena de Fin de Año',
      date: '2026-12-15',
      time: '21:00',
      description: null,
      modality: 'presencial' as const,
      locationText: 'Palermo',
      virtualLink: null,
      dateMode: 'fixed' as const,
      options: [],
      responseDeadline: null,
      durationMinutes: null,
      creationSource: 'ai' as const,
      customTemplateId: null,
      invitationTemplate: null,
      invitationTheme: 'classic' as const,
      invitationType: 'link_general' as const,
      responseVisibility: 'hidden' as const,
    };
    const validConfig = {
      invitationType: 'link_general' as const,
      invitationTheme: 'classic' as const,
      invitationTemplate: null,
      responseVisibility: 'hidden' as const,
    };

    // Caso A: JSON malformado o corrupto
    localStorage.setItem(AI_DRAFT_SNAPSHOT_KEY, '{corrupt_json');
    assert.strictEqual(getAiDraftSnapshot(), null);
    assert.strictEqual(localStorage.getItem(AI_DRAFT_SNAPSHOT_KEY), null, 'Debe autolimpiar snapshot corrupto');

    // Caso B: Estructura no objeto o array
    localStorage.setItem(AI_DRAFT_SNAPSHOT_KEY, JSON.stringify(['not', 'an', 'object']));
    assert.strictEqual(getAiDraftSnapshot(), null);
    assert.strictEqual(localStorage.getItem(AI_DRAFT_SNAPSHOT_KEY), null);

    // Caso C: savedAt ausente o no numérico
    localStorage.setItem(
      AI_DRAFT_SNAPSHOT_KEY,
      JSON.stringify({ draft: validDraft, config: validConfig, savedAt: 'not-a-number' })
    );
    assert.strictEqual(getAiDraftSnapshot(), null);
    assert.strictEqual(localStorage.getItem(AI_DRAFT_SNAPSHOT_KEY), null);

    // Caso D: Timestamp expirado (> 7 días)
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      AI_DRAFT_SNAPSHOT_KEY,
      JSON.stringify({ draft: validDraft, config: validConfig, savedAt: eightDaysAgo })
    );
    assert.strictEqual(getAiDraftSnapshot(), null);
    assert.strictEqual(localStorage.getItem(AI_DRAFT_SNAPSHOT_KEY), null, 'Debe autolimpiar snapshot expirado');

    // Caso E: Timestamp irrazonablemente antiguo (< año 2025)
    localStorage.setItem(
      AI_DRAFT_SNAPSHOT_KEY,
      JSON.stringify({ draft: validDraft, config: validConfig, savedAt: 1000 })
    );
    assert.strictEqual(getAiDraftSnapshot(), null);
    assert.strictEqual(localStorage.getItem(AI_DRAFT_SNAPSHOT_KEY), null);

    // Caso F: Timestamp futuro inválido (> 60 segundos hacia el futuro)
    const futureTimestamp = Date.now() + 10 * 60 * 1000; // 10 minutos en el futuro
    localStorage.setItem(
      AI_DRAFT_SNAPSHOT_KEY,
      JSON.stringify({ draft: validDraft, config: validConfig, savedAt: futureTimestamp })
    );
    assert.strictEqual(getAiDraftSnapshot(), null);
    assert.strictEqual(localStorage.getItem(AI_DRAFT_SNAPSHOT_KEY), null, 'Debe autolimpiar timestamp futuro inválido');

    // Caso G: draft o config ausentes o sin datos significativos
    localStorage.setItem(
      AI_DRAFT_SNAPSHOT_KEY,
      JSON.stringify({ draft: null, config: validConfig, savedAt: Date.now() })
    );
    assert.strictEqual(getAiDraftSnapshot(), null);
    assert.strictEqual(localStorage.getItem(AI_DRAFT_SNAPSHOT_KEY), null);
  });

  await t.test('1.12 Recuperación de borrador parcial de IA: isComplete = false y reconstrucción determinística de lastQuestion', () => {
    useAiWizardStore.getState().reset();
    clearAiDraftSnapshot();

    // Borrador incompleto: solo título ("After office"), falta fecha, hora, modalidad y lugar
    const partialDraft = {
      title: 'After office del equipo',
      date: null,
      time: null,
      description: null,
      modality: null,
      locationText: null,
      virtualLink: null,
      dateMode: 'fixed' as const,
      options: [],
      responseDeadline: null,
      durationMinutes: null,
      creationSource: 'ai' as const,
      customTemplateId: null,
      invitationTemplate: null,
      invitationTheme: 'classic' as const,
      invitationType: 'link_general' as const,
      responseVisibility: 'hidden' as const,
    };

    saveAiDraftSnapshot(partialDraft, {
      invitationType: 'link_general',
      invitationTheme: 'classic',
      invitationTemplate: null,
      responseVisibility: 'hidden',
    });

    // Simular restauración
    useAiWizardStore.getState().restoreFromSnapshot();

    const state = useAiWizardStore.getState();

    // REGLA CRÍTICA: Borrador parcial NUNCA debe marcarse isComplete = true ni mostrar "Listo para crear"
    assert.strictEqual(state.isComplete, false, 'Un borrador incompleto debe tener isComplete = false');
    assert.ok(state.lastQuestion !== null, 'Debe reconstruir determinísticamente lastQuestion');
    assert.strictEqual(state.lastQuestion.field, 'date', 'La siguiente pregunta obligatoria tras el título debe ser date');
    assert.ok(state.lastQuestion.question.length > 0);

    // Mensaje del asistente debe reflejar la pregunta y NO afirmar que todo está listo
    assert.strictEqual(state.messages.length, 1);
    assert.ok(
      state.messages[0].text.includes(state.lastQuestion.question),
      'El mensaje inicial de recuperación debe orientar al usuario con la pregunta pendiente'
    );
    assert.ok(
      !state.messages[0].text.includes('Todo está listo para crear'),
      'NO debe indicar listo para crear'
    );
  });

  await t.test('1.13 Recuperación de borrador completo de IA: isComplete = true y lastQuestion = null', () => {
    useAiWizardStore.getState().reset();
    clearAiDraftSnapshot();

    // Borrador completo y válido en el futuro
    const completeDraft = {
      title: 'Asado en el quincho',
      date: '2026-12-20',
      time: '13:00',
      description: 'Traer lo que quieran tomar',
      modality: 'presencial' as const,
      locationText: 'Av. Libertador 2500',
      virtualLink: null,
      dateMode: 'fixed' as const,
      options: [],
      responseDeadline: null,
      durationMinutes: 180,
      creationSource: 'ai' as const,
      customTemplateId: null,
      invitationTemplate: null,
      invitationTheme: 'friends' as const,
      invitationType: 'link_general' as const,
      responseVisibility: 'summary' as const,
    };

    saveAiDraftSnapshot(completeDraft, {
      invitationType: 'link_general',
      invitationTheme: 'friends',
      invitationTemplate: null,
      responseVisibility: 'summary',
    });

    useAiWizardStore.getState().restoreFromSnapshot();

    const state = useAiWizardStore.getState();
    assert.strictEqual(state.isComplete, true, 'Un borrador completo debe marcar isComplete = true');
    assert.strictEqual(state.lastQuestion, null, 'Un borrador completo no debe tener preguntas obligatorias pendientes');
    assert.ok(
      state.messages[0].text.includes('Todo está listo para crear el encuentro'),
      'El asistente debe informar que está listo para crear'
    );
  });

  await t.test('1.14 Recuperación de borrador en modo coordinación: respeta dateMode, opciones y evalúa completitud', () => {
    useAiWizardStore.getState().reset();
    clearAiDraftSnapshot();

    // Coordinación incompleta: 2 opciones pero falta modalidad y lugar
    const coordDraft = {
      title: 'Cena de egresados',
      date: null,
      time: null,
      description: null,
      modality: null,
      locationText: null,
      virtualLink: null,
      dateMode: 'coordination' as const,
      dateOptions: [
        { date: '2026-11-20', time: '20:00' },
        { date: '2026-11-21', time: '20:00' },
      ],
      options: [],
      responseDeadline: null,
      durationMinutes: null,
      creationSource: 'ai' as const,
      customTemplateId: null,
      invitationTemplate: null,
      invitationTheme: 'celebration' as const,
      invitationType: 'link_general' as const,
      responseVisibility: 'summary' as const,
    };

    saveAiDraftSnapshot(coordDraft, {
      invitationType: 'link_general',
      invitationTheme: 'celebration',
      invitationTemplate: null,
      responseVisibility: 'summary',
    });

    useAiWizardStore.getState().restoreFromSnapshot();

    const state = useAiWizardStore.getState();
    assert.strictEqual(state.coordinationDetected, true);
    assert.strictEqual(state.draft.dateMode, 'coordination');
    assert.strictEqual(state.isComplete, false, 'Coordinación sin modalidad/lugar debe ser incompleta');
    assert.strictEqual(state.lastQuestion?.field, 'modality', 'Debe preguntar modalidad');
  });

  await t.test('1.15 Limpieza segura de snapshot al resetear o iniciar nuevo borrador', () => {
    const draft = {
      title: 'Torneo de Pádel',
      date: '2026-12-01',
      time: '18:00',
      description: null,
      modality: 'presencial' as const,
      locationText: 'Club Pádel Central',
      virtualLink: null,
      dateMode: 'fixed' as const,
      options: [],
      responseDeadline: null,
      durationMinutes: null,
      creationSource: 'ai' as const,
      customTemplateId: null,
      invitationTemplate: null,
      invitationTheme: 'sports' as const,
      invitationType: 'link_general' as const,
      responseVisibility: 'hidden' as const,
    };

    saveAiDraftSnapshot(draft, {
      invitationType: 'link_general',
      invitationTheme: 'sports',
      invitationTemplate: null,
      responseVisibility: 'hidden',
    });

    assert.ok(getAiDraftSnapshot() !== null);

    // useAiWizardStore.getState().reset() (ejecutado al publicar o descartar)
    useAiWizardStore.getState().reset();
    assert.strictEqual(getAiDraftSnapshot(), null, 'reset() debe limpiar el snapshot');

    // Guardar de nuevo y probar startNewAiCreation
    saveAiDraftSnapshot(draft, {
      invitationType: 'link_general',
      invitationTheme: 'sports',
      invitationTemplate: null,
      responseVisibility: 'hidden',
    });
    assert.ok(getAiDraftSnapshot() !== null);

    useAiWizardStore.getState().startNewAiCreation();
    assert.strictEqual(getAiDraftSnapshot(), null, 'startNewAiCreation() debe limpiar el snapshot anterior');

    // Descarte explícito
    saveAiDraftSnapshot(draft, {
      invitationType: 'link_general',
      invitationTheme: 'sports',
      invitationTemplate: null,
      responseVisibility: 'hidden',
    });
    assert.ok(getAiDraftSnapshot() !== null);
    clearAiDraftSnapshot();
    assert.strictEqual(getAiDraftSnapshot(), null, 'clearAiDraftSnapshot() debe limpiar el snapshot');
  });
});

test('Mini-sprint A: Conversión de Invitado a Organizador', async (t) => {
  await t.test('2.1 Textos y traducciones ES, EN, PT-BR para el CTA de conversión', () => {
    // ES
    assert.strictEqual(esTranslations.guest_convert.prompt, '¿Querés organizar algo parecido?');
    assert.strictEqual(esTranslations.guest_convert.action, 'Crear mi encuentro');
    assert.ok(esTranslations.guest_convert.subtitle.length > 0);

    // EN
    assert.strictEqual(enTranslations.guest_convert.prompt, 'Want to organize something similar?');
    assert.strictEqual(enTranslations.guest_convert.action, 'Create my encounter');
    assert.ok(enTranslations.guest_convert.subtitle.length > 0);

    // PT-BR
    assert.strictEqual(ptTranslations.guest_convert.prompt, 'Quer organizar algo parecido?');
    assert.strictEqual(ptTranslations.guest_convert.action, 'Criar meu encontro');
    assert.ok(ptTranslations.guest_convert.subtitle.length > 0);
  });

  await t.test('2.2 Aislamiento de datos: conversión no copia participantes ni tokens privados', () => {
    // Verificar que el componente GuestToHostCard navega a /create limpio
    const guestCardSource = fs.readFileSync(
      path.resolve('src/components/guest/GuestToHostCard.tsx'),
      'utf8'
    );

    // Verifica que se invoca ensureHostSession para permitir creación anónima sin forzar Google
    assert.ok(guestCardSource.includes('ensureHostSession'));
    // Verifica que navega a /create sin copiar payloads del encuentro previo
    assert.ok(guestCardSource.includes("navigate('/create'"));
    assert.ok(!guestCardSource.includes('participantes'));
    assert.ok(!guestCardSource.includes('token_invitacion'));
  });

  await t.test('2.3 Restricción de estado: no se muestra en encuentros cancelados', () => {
    const inviteGuestSource = fs.readFileSync(
      path.resolve('src/screens/InviteGuest.tsx'),
      'utf8'
    );
    const joinGeneralSource = fs.readFileSync(
      path.resolve('src/screens/JoinGeneral.tsx'),
      'utf8'
    );
    const inviteCoordSource = fs.readFileSync(
      path.resolve('src/screens/InviteCoordination/index.tsx'),
      'utf8'
    );

    // En las pantallas de invitados, el bloque verifica que el estado NO sea 'cancelado'
    assert.ok(inviteGuestSource.includes("encuentro?.estado?.toLowerCase() !== 'cancelado'"));
    assert.ok(joinGeneralSource.includes("encuentro?.estado?.toLowerCase() !== 'cancelado'"));
    assert.ok(inviteCoordSource.includes("estado?.toLowerCase() !== 'cancelado'"));
  });
});

test('Mini-sprint A: Vista previa enriquecida de enlaces y privacidad', async (t) => {
  const indexHtml = fs.readFileSync(path.resolve('index.html'), 'utf8');

  await t.test('3.1 Metadatos Open Graph y Twitter Card presentes en HTML estático (accesibles sin JS para crawlers)', () => {
    // Open Graph
    assert.ok(indexHtml.includes('<meta property="og:type" content="website" />'));
    assert.ok(indexHtml.includes('<meta property="og:site_name" content="PuntoEncuentro" />'));
    assert.ok(indexHtml.includes('<meta property="og:title" content="PuntoEncuentro — Organizá encuentros y compartí momentos" />'));
    assert.ok(indexHtml.includes('<meta property="og:description"'));
    assert.ok(indexHtml.includes('<meta property="og:image" content="https://puntoencuentro.com.ar/images/og-share.png" />'));
    assert.ok(indexHtml.includes('<meta property="og:image:width" content="1200" />'));
    assert.ok(indexHtml.includes('<meta property="og:image:height" content="630" />'));

    // Twitter Card
    assert.ok(indexHtml.includes('<meta name="twitter:card" content="summary_large_image" />'));
    assert.ok(indexHtml.includes('<meta name="twitter:title"'));
    assert.ok(indexHtml.includes('<meta name="twitter:image" content="https://puntoencuentro.com.ar/images/og-share.png" />'));
  });

  await t.test('3.2 Privacidad estricta: CERO filtración de tokens, títulos privados o datos de participantes en metadatos', () => {
    // Los metadatos no deben contener tokens ni variables de usuario
    assert.ok(!indexHtml.includes('token='));
    assert.ok(!indexHtml.includes('guest='));
    assert.ok(!indexHtml.includes('participant'));
    assert.ok(!indexHtml.includes('hostId'));
    // Los metadatos son genéricos de la marca PuntoEncuentro
    assert.ok(indexHtml.includes('PuntoEncuentro'));
  });

  await t.test('3.3 Imagen og-share.png generada con dimensiones y formato estándar', async () => {
    const ogImagePath = path.resolve('public/images/og-share.png');
    assert.ok(fs.existsSync(ogImagePath), 'public/images/og-share.png debe existir');

    const metadata = await sharp(ogImagePath).metadata();
    assert.strictEqual(metadata.format, 'png');
    assert.strictEqual(metadata.width, 1200);
    assert.strictEqual(metadata.height, 630);
  });
});

test('Mini-sprint A: i18n y consistencia de traducciones', async (t) => {
  await t.test('4.1 Claves de draft_recovery presentes en ES, EN y PT-BR', () => {
    const requiredKeys = ['title', 'desc', 'continue_btn', 'discard_btn', 'untitled'];

    for (const key of requiredKeys) {
      assert.ok(
        (esTranslations.draft_recovery as any)[key],
        `es.json debe tener draft_recovery.${key}`
      );
      assert.ok(
        (enTranslations.draft_recovery as any)[key],
        `en.json debe tener draft_recovery.${key}`
      );
      assert.ok(
        (ptTranslations.draft_recovery as any)[key],
        `pt-BR.json debe tener draft_recovery.${key}`
      );
    }
  });
});
