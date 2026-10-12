import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import { HomeOpenEncounterCard } from '../src/components/home/openEncounters/HomeOpenEncounterCard';
import type { OpenEncounterSummary } from '../src/components/home/openEncounters/types';

describe('UX Matching Mis Ganas V1: "Ver opciones" y Resaltado en Discovery', () => {
  const rootDir = process.cwd();

  const mockEncounter1: OpenEncounterSummary = {
    id: 'enc-padel-1',
    title: 'Torneo de Pádel',
    dateLabel: 'Sábado 18:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    modality: 'presencial',
    openSlots: 2,
    confirmedCount: 2,
    emoji: '🎾',
  };

  const mockEncounter2: OpenEncounterSummary = {
    id: 'enc-cafe-2',
    title: 'Café de Especialidad',
    dateLabel: 'Domingo 16:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    modality: 'presencial',
    openSlots: 4,
    confirmedCount: 1,
    emoji: '☕',
  };

  const mockEncounter3: OpenEncounterSummary = {
    id: 'enc-padel-3',
    title: 'Pádel Mixto Nocturno',
    dateLabel: 'Viernes 20:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    modality: 'presencial',
    openSlots: 1,
    confirmedCount: 3,
    emoji: '🎾',
  };

  test('B. Las cards reciben identificador estable data-encounter-id en el elemento raíz', () => {
    const htmlNormal = renderToString(
      React.createElement(HomeOpenEncounterCard, {
        encounter: mockEncounter1,
        onClick: () => {},
      })
    );

    assert.ok(
      htmlNormal.includes('data-encounter-id="enc-padel-1"'),
      'La card debe contener el atributo data-encounter-id con su ID exacto'
    );
  });

  test('C & E. 1 Match: Card resaltada incluye clase pe-open-card--highlighted y badge "Coincide con tus ganas"', () => {
    const htmlHighlighted = renderToString(
      React.createElement(HomeOpenEncounterCard, {
        encounter: mockEncounter1,
        onClick: () => {},
        isHighlighted: true,
      })
    );

    assert.ok(
      htmlHighlighted.includes('pe-open-card--highlighted'),
      'La card resaltada debe incluir la clase pe-open-card--highlighted'
    );
    assert.ok(
      htmlHighlighted.includes('pe-open-card__match-badge'),
      'La card resaltada debe renderizar el elemento pe-open-card__match-badge'
    );
    assert.ok(
      htmlHighlighted.includes('Coincide con tus ganas'),
      'El badge debe mostrar el copy accesible "Coincide con tus ganas"'
    );
  });

  test('Card no resaltada NO incluye la clase pe-open-card--highlighted ni el badge', () => {
    const htmlNormal = renderToString(
      React.createElement(HomeOpenEncounterCard, {
        encounter: mockEncounter1,
        onClick: () => {},
        isHighlighted: false,
      })
    );

    assert.ok(
      !htmlNormal.includes('pe-open-card--highlighted'),
      'La card normal no debe tener la clase pe-open-card--highlighted'
    );
    assert.ok(
      !htmlNormal.includes('pe-open-card__match-badge'),
      'La card normal no debe tener el badge pe-open-card__match-badge'
    );
  });

  test('F. Varios matches: Mapeo selectivo resalta únicamente las cards coincidentes y preserva el catálogo', () => {
    const matchedIds = ['enc-padel-1', 'enc-padel-3'];
    const encounters = [mockEncounter1, mockEncounter2, mockEncounter3];

    const renderedCards = encounters.map((enc) =>
      renderToString(
        React.createElement(HomeOpenEncounterCard, {
          encounter: enc,
          onClick: () => {},
          isHighlighted: matchedIds.includes(enc.id),
        })
      )
    );

    // Card 1 (Padel 1) -> Highlighted
    assert.ok(renderedCards[0].includes('pe-open-card--highlighted'));
    assert.ok(renderedCards[0].includes('Coincide con tus ganas'));

    // Card 2 (Cafe 2) -> Normal
    assert.ok(!renderedCards[1].includes('pe-open-card--highlighted'));
    assert.ok(!renderedCards[1].includes('Coincide con tus ganas'));

    // Card 3 (Padel 3) -> Highlighted
    assert.ok(renderedCards[2].includes('pe-open-card--highlighted'));
    assert.ok(renderedCards[2].includes('Coincide con tus ganas'));
  });

  test('A. Propagación de matchedEncounterIds desde HomeIntencionesSection hacia HomeOpenEncounters', () => {
    const homeFilePath = path.join(rootDir, 'src/screens/Home.tsx');
    const homeContent = fs.readFileSync(homeFilePath, 'utf-8');

    assert.ok(
      homeContent.includes('const [matchedHighlightIds, setMatchedHighlightIds] = useState'),
      'Home.tsx debe declarar el estado matchedHighlightIds'
    );
    assert.ok(
      homeContent.includes('onViewMatches={handleViewMatches}'),
      'Home.tsx debe pasar onViewMatches a HomeIntencionesSection'
    );
    assert.ok(
      homeContent.includes('highlightEncounterIds={matchedHighlightIds}'),
      'Home.tsx debe pasar highlightEncounterIds a HomeOpenEncounters'
    );
  });

  test('B. HomeOpenEncounters posee id="home-discovery-section" y data-encounter-id en items', () => {
    const discoveryFilePath = path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx');
    const discoveryContent = fs.readFileSync(discoveryFilePath, 'utf-8');

    assert.ok(
      discoveryContent.includes('id="home-discovery-section"'),
      'La sección Discovery debe tener el identificador DOM id="home-discovery-section"'
    );
    assert.ok(
      discoveryContent.includes('data-encounter-id={encounter.id}'),
      'Cada pe-discovery-item en HomeOpenEncounters debe incluir data-encounter-id={encounter.id}'
    );
    assert.ok(
      discoveryContent.includes('isHighlighted={activeHighlightedIds.has(encounter.id)}'),
      'HomeOpenEncounters debe evaluar isHighlighted según activeHighlightedIds'
    );
  });

  test('C & D. Temporizador de 3500ms y degradación elegante si el match no está presente', () => {
    const discoveryFilePath = path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx');
    const discoveryContent = fs.readFileSync(discoveryFilePath, 'utf-8');

    assert.ok(
      discoveryContent.includes('window.setTimeout(() => {'),
      'HomeOpenEncounters debe registrar un timer para limpiar el resaltado'
    );
    assert.ok(
      discoveryContent.includes('3500'),
      'El intervalo del resaltado temporal debe ser de 3500ms'
    );
    assert.ok(
      discoveryContent.includes('onClearHighlight?.()'),
      'Al expirar el timer debe llamar a onClearHighlight'
    );
  });

  test('G. Accesibilidad y prefers-reduced-motion', () => {
    const cssFilePath = path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterCard.css');
    const cssContent = fs.readFileSync(cssFilePath, 'utf-8');

    assert.ok(
      cssContent.includes('@media (prefers-reduced-motion: reduce)'),
      'El CSS debe contemplar la media query prefers-reduced-motion: reduce'
    );
    assert.ok(
      cssContent.includes('.pe-open-card--highlighted'),
      'El CSS debe definir la clase .pe-open-card--highlighted'
    );
    assert.ok(
      cssContent.includes('.pe-open-card__match-badge'),
      'El CSS debe definir la clase .pe-open-card__match-badge'
    );
  });

  test('I. Consistencia i18n en todos los idiomas soportados (ES, EN, PT, PT-BR)', () => {
    const locales = ['es', 'en', 'pt', 'pt-BR'];
    for (const loc of locales) {
      const locPath = path.join(rootDir, `src/i18n/locales/${loc}.json`);
      const locContent = JSON.parse(fs.readFileSync(locPath, 'utf-8'));
      assert.ok(
        locContent.open_encounters && locContent.open_encounters.matched_intention_badge,
        `El locale ${loc}.json debe definir open_encounters.matched_intention_badge`
      );
    }

    const esJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/es.json'), 'utf-8'));
    const enJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/en.json'), 'utf-8'));
    const ptJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/pt.json'), 'utf-8'));

    assert.equal(esJson.open_encounters.matched_intention_badge, 'Coincide con tus ganas');
    assert.equal(enJson.open_encounters.matched_intention_badge, 'Matches what you feel like doing');
    assert.equal(ptJson.open_encounters.matched_intention_badge, 'Combina com o que você tem vontade de fazer');
  });

  test('H. Compatibilidad con Home V1 preservada', () => {
    const homeFilePath = path.join(rootDir, 'src/screens/Home.tsx');
    const homeContent = fs.readFileSync(homeFilePath, 'utf-8');

    assert.ok(
      homeContent.includes('!isV2Variant && ('),
      'Home.tsx debe conservar intacta la renderización condicional para la variante V1'
    );
  });
});
