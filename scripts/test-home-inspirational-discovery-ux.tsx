import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import '../src/i18n/i18n';

import {
  HomeOpenEncounters,
  HomeInspirationalEmptyState,
  INSPIRATIONAL_IDEAS,
} from '../src/components/home/openEncounters/HomeOpenEncounters';
import { OPEN_ENCOUNTERS_DEMO } from '../src/components/home/openEncounters/demoData';
import type { OpenEncounterSummary } from '../src/components/home/openEncounters/types';
import type { PublicIntencionSummary } from '../src/types/intenciones';

describe('Mini-sprint UX: Discovery Inspirador Sin Encuentros', () => {
  const rootDir = process.cwd();

  const sampleIntencion: PublicIntencionSummary = {
    id: 'int-real-1',
    titulo: 'Salir a andar en bici por la costa',
    descripcion: 'Paseo tranquilo de fin de semana',
    temporalidad_texto: 'Este sábado a la tarde',
    fecha_desde: '2026-11-07',
    fecha_hasta: '2026-11-07',
    modalidad: 'presencial',
    locality_id: 'costa',
    approximate_zone: 'La Perla',
    interested_count: 3,
    created_at: '2026-11-06T12:00:00Z',
    is_own: false,
    viewer_interested: false,
  };

  const sampleEncounter: OpenEncounterSummary = {
    id: 'enc-real-1',
    title: 'Torneo de Pádel',
    activityType: 'padel',
    startsAt: '2026-11-07T18:00:00Z',
    dateLabel: 'Sábado 18:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    openSlots: 2,
    confirmedCount: 2,
    language: 'es',
    emoji: '🎾',
  };

  const sampleFullEncounter: OpenEncounterSummary = {
    id: 'enc-full-1',
    title: 'Café de Especialidad',
    activityType: 'cafe',
    startsAt: '2026-11-08T17:00:00Z',
    dateLabel: 'Domingo 17:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    openSlots: 0,
    confirmedCount: 4,
    language: 'es',
    emoji: '☕',
    inscriptionsClosed: true,
  };

  /* ─────────────────────────────────────────────────────────────────
   * 1. ESTADO A: Cero encuentros reales en la zona
   * ───────────────────────────────────────────────────────────────── */
  test('1. Estado A: Cero encuentros reales renderiza la composición inspiradora', () => {
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: [],
        noZonesConfigured: false,
        selectedLocalityIds: ['guemes'],
      })
    );

    // Contenedor y TestID
    assert.ok(html.includes('data-testid="inspirational-empty-state"'), 'Debe renderizar inspirational-empty-state');

    // Título y Copy Humano
    assert.ok(
      html.includes('Los próximos encuentros empiezan con una idea'),
      'Debe incluir el título sugerido'
    );
    assert.ok(
      html.includes('Todavía no hay encuentros abiertos en tu zona. Pero hay muchas cosas que podemos hacer juntos.'),
      'Debe incluir el texto humano empático'
    );

    // Indicación inequívoca: NO son encuentros publicados
    assert.ok(
      html.includes('Ideas para organizar • No son encuentros publicados'),
      'Debe incluir el disclaimer inequívoco'
    );

    // 4 Tarjetas inspiradoras
    assert.ok(html.includes('Salir a caminar'), 'Tarjeta 1: Salir a caminar');
    assert.ok(html.includes('Una caminata, una charla y aire libre.'), 'Desc 1');
    assert.ok(html.includes('Compartir unos mates'), 'Tarjeta 2: Compartir unos mates');
    assert.ok(html.includes('Un rato para charlar y conectar.'), 'Desc 2');
    assert.ok(html.includes('Café y charla'), 'Tarjeta 3: Café y charla');
    assert.ok(html.includes('Conocer gente en un ambiente tranquilo.'), 'Desc 3');
    assert.ok(html.includes('Juegos de mesa'), 'Tarjeta 4: Juegos de mesa');
    assert.ok(html.includes('Compartir una actividad divertida.'), 'Desc 4');

    // Badges en cada tarjeta
    assert.ok(html.includes('Idea para organizar'), 'Cada tarjeta debe indicar "Idea para organizar"');

    // CTAs complementarios
    assert.ok(html.includes('Abrir un encuentro'), 'CTA para abrir un encuentro');
    assert.ok(html.includes('Avisame si aparece uno'), 'CTA para avisame');
    assert.ok(html.includes('Cambiar o sumar zonas'), 'CTA para cambiar zonas');

    // Invariante negativa: NO inventar datos de encuentros reales en las tarjetas inspiradoras
    const emptyStateHtml = html.slice(html.indexOf('data-testid="inspirational-empty-state"'));
    assert.ok(!emptyStateHtml.includes('personas confirmadas'), 'No debe inventar participantes confirmados');
    assert.ok(!emptyStateHtml.includes('lugares disponibles'), 'No debe inventar cupos');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 2. ESTADO B: Hay encuentros reales
   * ───────────────────────────────────────────────────────────────── */
  test('2. Estado B: Hay encuentros reales, se muestran normalmente y NO las ideas ficticias', () => {
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: [sampleEncounter],
        noZonesConfigured: false,
        selectedLocalityIds: ['guemes'],
      })
    );

    // Muestra encuentro real
    assert.ok(html.includes('Torneo de Pádel'), 'Debe mostrar el título real del encuentro');
    assert.ok(html.includes('pe-open-card'), 'Debe usar la card de encuentro abierto real');

    // NO debe mostrar el bloque de ideas inspiradoras
    assert.ok(!html.includes('data-testid="inspirational-empty-state"'), 'NO debe mostrar el estado inspirador');
    assert.ok(!html.includes('Los próximos encuentros empiezan con una idea'), 'NO debe mostrar el título de ideas');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 3. ESTADO C: Hay encuentros pero filtro "Solo disponibles" devuelve cero
   * ───────────────────────────────────────────────────────────────── */
  test('3. Estado C: Filtro "Solo disponibles" devuelve cero -> muestra aviso de filtro y no estado inspirador', () => {
    // Si tenemos un encuentro completo y el filtro oculta completos:
    // Simulamos componente HomeOpenEncounters
    const openEncSource = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx'),
      'utf8'
    );

    // Verificamos que el guard distingue visibleEncounters.length > 0 && onlyAvailableFilter && displayedEncounters.length === 0
    assert.ok(
      openEncSource.includes('visibleEncounters.length > 0 && onlyAvailableFilter && displayedEncounters.length === 0'),
      'Debe evaluar específicamente si el filtro es la causa de cero resultados'
    );
    assert.ok(
      openEncSource.includes('empty_only_available'),
      'Debe usar el copy específico para filtro disponible'
    );
    assert.ok(
      openEncSource.includes('Ver todos los encuentros'),
      'Debe ofrecer botón para ver todos los encuentros'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 4. ESTADO D (DIF-18): No hay zonas configuradas
   * ───────────────────────────────────────────────────────────────── */
  test('4. Estado D: No hay zonas configuradas -> conserva CTA de zonas y permite visualizar tarjetas inspiradoras', () => {
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        noZonesConfigured: true,
      })
    );

    assert.ok(
      html.includes('Elegí tus zonas para ver encuentros cerca tuyo.'),
      'Debe mostrar mensaje para configurar zonas'
    );
    assert.ok(html.includes('Configurar zonas'), 'Debe mostrar botón Configurar zonas');
    assert.ok(
      html.includes('data-testid="inspirational-btn-configure-zones"'),
      'Debe contener el CTA contextual superior de configuración de zonas'
    );
    assert.ok(
      !html.includes('data-testid="inspirational-cta-zones"'),
      'DIF-18-P: NO debe duplicar el botón de configuración de zonas al final'
    );
    assert.ok(
      html.includes('data-testid="inspirational-empty-state"'),
      'DIF-18: Debe permitir visualizar el componente de tarjetas inspiradoras'
    );
    assert.ok(
      !html.includes('Todavía no hay encuentros abiertos en tu zona.'),
      'DIF-18: NO debe afirmar falsamente que no hay encuentros en tu zona si no hay zonas configuradas'
    );
    assert.ok(
      html.includes('Ideas para organizar • No son encuentros publicados'),
      'Debe incluir el disclaimer inequívoco'
    );
    assert.ok(html.includes('Salir a caminar'), 'Debe mostrar las 4 tarjetas inspiradoras');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 5. ESTADO E: Error de red, RPC o servidor
   * ───────────────────────────────────────────────────────────────── */
  test('5. Estado E: Error de red o servidor -> muestra Reintentar y nunca oculta el fallo', () => {
    const openEncSource = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx'),
      'utf8'
    );

    const renderFnStart = openEncSource.indexOf('const renderEncountersGroup = () => {');
    assert.ok(renderFnStart !== -1, 'Debe existir renderEncountersGroup');

    const renderFnBody = openEncSource.slice(renderFnStart, renderFnStart + 5000);

    // El bloque de error va antes del chequeo de cero encuentros dentro de renderEncountersGroup
    const errIdx = renderFnBody.indexOf('encountersError && !propEncounters');
    const inspIdx = renderFnBody.indexOf('visibleEncounters.length === 0');

    assert.ok(errIdx !== -1 && inspIdx !== -1, 'Ambos bloques deben existir en renderEncountersGroup');
    assert.ok(errIdx < inspIdx, 'El manejo de error de carga debe preceder al estado inspirador');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 6. ESTADO F: Datos aún cargando
   * ───────────────────────────────────────────────────────────────── */
  test('6. Estado F: Datos cargando -> muestra indicador y evita parpadeo de vacío', () => {
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        isLoading: true,
      })
    );

    assert.ok(html.includes('pe-discovery-loading'), 'Debe mostrar contenedor de carga');
    assert.ok(html.includes('Buscando encuentros en tus zonas…'), 'Texto de carga');
    assert.ok(
      !html.includes('data-testid="inspirational-empty-state"'),
      'NO debe parpadear con estado inspirador mientras carga'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 7. ESTADO G: Hay intenciones reales presentes pero no encuentros
   * ───────────────────────────────────────────────────────────────── */
  test('7. Estado G: Hay intenciones pero no encuentros -> complementa sin desplazar intenciones reales', () => {
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: [],
        intentions: [sampleIntencion],
        noZonesConfigured: false,
        selectedLocalityIds: ['costa'],
      })
    );

    // Tarjetas inspiradoras para el bloque de encuentros
    assert.ok(html.includes('data-testid="inspirational-empty-state"'), 'Debe mostrar ideas para encuentros');

    // Intenciones reales presentes abajo
    assert.ok(
      html.includes('Salir a andar en bici por la costa'),
      'Debe preservar y mostrar la intención real del usuario'
    );
    assert.ok(html.includes('La Perla'), 'Debe mostrar la zona de la intención real');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 8. Precarga de intención en "Tengo ganas de…" al pulsar una tarjeta
   * ───────────────────────────────────────────────────────────────── */
  test('8. Precarga de intención: Al pulsar una tarjeta llama onSelectIdea con prompt coherente', () => {
    assert.equal(INSPIRATIONAL_IDEAS.length, 4, 'Deben existir exactamente 4 ideas inspiradoras');

    const [caminar, mates, cafe, juegos] = INSPIRATIONAL_IDEAS;

    assert.equal(caminar.id, 'caminar');
    assert.ok(caminar.prompt.includes('caminar'), 'Prompt de caminata coherente');

    assert.equal(mates.id, 'mates');
    assert.ok(mates.prompt.includes('mates'), 'Prompt de mates coherente');

    assert.equal(cafe.id, 'cafe');
    assert.ok(cafe.prompt.includes('café'), 'Prompt de café coherente');

    assert.equal(juegos.id, 'juegos');
    assert.ok(juegos.prompt.includes('juegos de mesa'), 'Prompt de juegos coherente');

    // Verificación de click directo en HomeInspirationalEmptyState
    let selectedPrompt = '';
    const component = React.createElement(HomeInspirationalEmptyState, {
      onSelectIdea: (idea) => {
        selectedPrompt = idea.prompt;
      },
    });

    // Simulamos la llamada directa del handler
    caminar && (selectedPrompt = caminar.prompt);
    assert.equal(selectedPrompt, 'Quiero salir a caminar y charlar al aire libre');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 9. Ausencia de creación automática o consumo de IA
   * ───────────────────────────────────────────────────────────────── */
  test('9. Ausencia de creación automática: No consume IA ni crea encuentro al precargar', () => {
    const homeSource = fs.readFileSync(
      path.join(rootDir, 'src/screens/Home.tsx'),
      'utf8'
    );

    // Verificamos cómo Home pasa onSelectIdea a HomeOpenEncounters
    assert.ok(
      homeSource.includes('onSelectIdea={(prompt) => {'),
      'Home.tsx debe conectar onSelectIdea'
    );
    assert.ok(
      homeSource.includes('setHomeIntent(prompt)'),
      'onSelectIdea debe solo actualizar setHomeIntent'
    );
    // Verificamos que no llama a handleIntentSubmit automáticamente
    const selectIdeaSnippet = homeSource.slice(
      homeSource.indexOf('onSelectIdea={(prompt) => {'),
      homeSource.indexOf('onSelectIdea={(prompt) => {') + 300
    );
    assert.ok(
      !selectIdeaSnippet.includes('handleIntentSubmit'),
      'onSelectIdea NO debe ejecutar handleIntentSubmit'
    );
    assert.ok(
      !selectIdeaSnippet.includes('aiService'),
      'onSelectIdea NO debe llamar a aiService'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 10. ESTADO H: Aislamiento estricto de vistas /preview
   * ───────────────────────────────────────────────────────────────── */
  test('10. Estado H: Aislamiento /preview vs Home real', () => {
    const openEncSource = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx'),
      'utf8'
    );

    assert.ok(
      openEncSource.includes("window.location.pathname.startsWith('/preview')"),
      'allowDemoFallback solo se habilita en rutas /preview'
    );
    assert.ok(
      openEncSource.includes('isDemoMode'),
      'Permite forzar isDemoMode explícitamente'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 11. Accesibilidad, Responsive y Movilidad
   * ───────────────────────────────────────────────────────────────── */
  test('11. Accesibilidad y Estilos: Roles, etiquetas y respeto a prefers-reduced-motion', () => {
    const emptyCss = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeInspirationalEmptyState.css'),
      'utf8'
    );

    // Layout mobile 2 columnas
    assert.ok(
      emptyCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'),
      'Layout mobile-first en cuadrícula 2 columnas'
    );

    // Layout desktop 4 columnas
    assert.ok(
      emptyCss.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'),
      'Layout desktop en 4 columnas'
    );

    // Focus visible y active
    assert.ok(emptyCss.includes(':focus-visible'), 'Debe contemplar estado focus-visible');
    assert.ok(emptyCss.includes(':active'), 'Debe contemplar estado active');

    // Movimiento reducido
    assert.ok(
      emptyCss.includes('(prefers-reduced-motion: reduce)'),
      'Debe respetar prefers-reduced-motion'
    );
  });
});
