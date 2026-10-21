import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import {
  hasRecoverableManualDraft,
  hasRecoverableCoordinationDraft,
  hasRecoverableAiDraft,
} from '../src/lib/draftRecovery';
import { useWizardStore } from '../src/store/wizardStore';
import { useCoordinationWizardStore } from '../src/store/coordinationWizardStore';
import { useAiWizardStore } from '../src/store/aiWizardStore';
import { draftToWizardState } from '../src/lib/encounterDraft';

import esTranslations from '../src/i18n/locales/es.json';
import enTranslations from '../src/i18n/locales/en.json';
import ptTranslations from '../src/i18n/locales/pt-BR.json';

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
