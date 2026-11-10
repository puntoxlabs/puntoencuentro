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
import type { OpenEncounterSummary } from '../src/components/home/openEncounters/types';

describe('DIF-18-P: Pulido Visual y UX de Discovery (Mobile-First)', () => {
  const rootDir = process.cwd();

  const mockPresencialEncounter1: OpenEncounterSummary = {
    id: 'enc-guemes-1',
    title: 'Torneo de Pádel Güemes',
    startsAt: '2026-11-20T19:00:00-03:00',
    dateLabel: 'Viernes 19:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    modalidad: 'presencial',
    modality: 'presencial',
    openSlots: 2,
    confirmedCount: 2,
    language: 'es',
    emoji: '🎾',
  };

  const mockPresencialEncounter2: OpenEncounterSummary = {
    id: 'enc-guemes-2',
    title: 'Café de Especialidad',
    startsAt: '2026-11-21T17:00:00-03:00',
    dateLabel: 'Sábado 17:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    modalidad: 'presencial',
    modality: 'presencial',
    openSlots: 0,
    confirmedCount: 6,
    language: 'es',
    emoji: '☕',
    inscriptionsClosed: true,
  };

  const mockVirtualEncounter: OpenEncounterSummary = {
    id: 'enc-virtual-1',
    title: 'Club de Lectura Virtual',
    startsAt: '2026-11-22T18:00:00-03:00',
    dateLabel: 'Domingo 18:00',
    approximateZone: 'Online',
    localityId: null,
    modalidad: 'virtual',
    modality: 'virtual',
    openSlots: 5,
    confirmedCount: 3,
    language: 'es',
    emoji: '📚',
  };

  /* ─────────────────────────────────────────────────────────────────
   * 1. RENOMBRAR «VER TODOS» A «VER EN LISTA» Y ENCABEZADOS DE LISTA
   * ───────────────────────────────────────────────────────────────── */
  test('1. Renombrar «Ver todos» a «Ver en lista» en UI y encabezado contextual', () => {
    // A. Renderizado del botón principal en Discovery
    const htmlWithEncounters = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: [mockPresencialEncounter1, mockVirtualEncounter],
        selectedLocalityIds: ['guemes'],
        noZonesConfigured: false,
      })
    );

    // Debe mostrar "Ver en lista"
    assert.ok(htmlWithEncounters.includes('Ver en lista'), 'Debe mostrar el botón «Ver en lista»');
    assert.ok(
      htmlWithEncounters.includes('data-testid="discovery-see-in-list-btn"'),
      'Debe incluir data-testid="discovery-see-in-list-btn"'
    );
    assert.ok(
      htmlWithEncounters.includes('aria-label="Ver encuentros en lista"'),
      'Debe tener aria-label accesible actualizado para ver encuentros en lista'
    );
    // No debe contener el ambiguo "Ver todos" en la barra de Discovery
    const headerSlice = htmlWithEncounters.slice(
      htmlWithEncounters.indexOf('pe-discovery-header-actions'),
      htmlWithEncounters.indexOf('pe-discovery-header-actions') + 500
    );
    assert.ok(!headerSlice.includes('>Ver todos<'), 'NO debe contener el texto ambiguo «Ver todos»');

    // B. Verificación de lógica de handleSeeAllClick en código fuente: NO altera filtros
    const openEncSource = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx'),
      'utf-8'
    );
    assert.ok(
      !openEncSource.includes('if (onlyAvailableFilter) {\n      setOnlyAvailableFilter(false);\n      return;\n    }'),
      'handleSeeAllClick NO debe desactivar ni alterar onlyAvailableFilter silenciosamente'
    );
    assert.ok(
      openEncSource.includes('setIsSeeAllListOpen(true)'),
      'handleSeeAllClick abre directamente el listado vertical'
    );

    // C. Verificación de traducciones en ES, EN, PT, PT-BR
    const es = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/es.json'), 'utf-8'));
    const en = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/en.json'), 'utf-8'));
    const pt = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/pt.json'), 'utf-8'));
    const ptBR = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/pt-BR.json'), 'utf-8'));

    assert.equal(es.open_encounters.see_in_list, 'Ver en lista');
    assert.equal(en.open_encounters.see_in_list, 'View as list');
    assert.equal(pt.open_encounters.see_in_list, 'Ver em lista');
    assert.equal(ptBR.open_encounters.see_in_list, 'Ver em lista');

    assert.equal(es.open_encounters.list_title_zones, 'Encuentros en tus zonas');
    assert.equal(en.open_encounters.list_title_zones, 'Encounters in your areas');
    assert.equal(pt.open_encounters.list_title_zones, 'Encontros nas tuas zonas');
    assert.equal(ptBR.open_encounters.list_title_zones, 'Encontros nas suas regiões');

    assert.equal(es.open_encounters.list_title_online, 'Encuentros online');
    assert.equal(en.open_encounters.list_title_online, 'Online encounters');
    assert.equal(pt.open_encounters.list_title_online, 'Encontros online');
    assert.equal(ptBR.open_encounters.list_title_online, 'Encontros online');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 2. CORREGIR DESBORDAMIENTO DE ETIQUETAS EN TARJETAS INSPIRADORAS
   * ───────────────────────────────────────────────────────────────── */
  test('2. Tarjetas inspiradoras: diseño anti-desbordamiento y jerarquía visual en mobile y desktop', () => {
    const emptyCss = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeInspirationalEmptyState.css'),
      'utf-8'
    );

    // Verificación de cabecera interna vertical en tarjeta para alojar el badge sin desbordar
    assert.ok(
      emptyCss.includes('.pe-inspirational-card-top'),
      'Debe definir .pe-inspirational-card-top'
    );
    assert.ok(
      emptyCss.includes('flex-direction: column'),
      'pe-inspirational-card-top debe usar flex-direction: column para alinear emoji y badge verticalmente'
    );

    // Verificación de badge sin nowrap forzado y con envoltorio seguro
    assert.ok(
      emptyCss.includes('.pe-inspirational-card-badge'),
      'Debe definir .pe-inspirational-card-badge'
    );
    assert.ok(
      !emptyCss.includes('.pe-inspirational-card-badge {\n  font-size: 0.62rem;\n  font-weight: 700;\n  text-transform: uppercase;\n  letter-spacing: 0.02em;\n  color: #047857;\n  background-color: #ECFDF5;\n  border: 1px solid rgba(16, 185, 129, 0.25);\n  padding: 2px 6px;\n  border-radius: 9999px;\n  white-space: nowrap;\n}'),
      'Badge inspirador NO debe tener white-space: nowrap que provoque overflow horizontal en tarjetas vecinas'
    );
    assert.ok(
      emptyCss.includes('overflow-wrap: break-word') || emptyCss.includes('word-break: normal'),
      'Badge inspirador debe contemplar adaptación de ancho de texto'
    );

    // Contenedor de tarjeta con contención de desbordamiento
    assert.ok(
      emptyCss.includes('overflow: hidden'),
      'Tarjeta inspiradora debe tener overflow: hidden como salvaguarda'
    );
    assert.ok(
      emptyCss.includes('box-sizing: border-box'),
      'Tarjeta inspiradora debe usar box-sizing: border-box'
    );

    // Preservación de 2 columnas en mobile y 4 columnas en desktop
    assert.ok(
      emptyCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'),
      'Debe preservar 2 columnas en móvil'
    );
    assert.ok(
      emptyCss.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'),
      'Debe preservar 4 columnas en desktop'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 3. ELIMINAR DUPLICACIÓN DE «CONFIGURAR ZONAS»
   * ───────────────────────────────────────────────────────────────── */
  test('3. Eliminar duplicación de «Configurar zonas» en estado inspirador sin zonas', () => {
    // Caso 1: Sin zonas configuradas (noZonesConfigured: true)
    const htmlNoZones = renderToString(
      React.createElement(HomeInspirationalEmptyState, {
        noZonesConfigured: true,
        onSelectIdea: () => {},
      })
    );

    // Debe contener el CTA contextual superior
    assert.ok(
      htmlNoZones.includes('data-testid="inspirational-btn-configure-zones"'),
      'Debe contener el CTA superior en data-testid="inspirational-btn-configure-zones"'
    );
    assert.ok(
      htmlNoZones.includes('Configurar zonas'),
      'Debe mostrar el texto «Configurar zonas» en el recuadro superior'
    );

    // NO debe contener el botón inferior duplicado
    assert.ok(
      !htmlNoZones.includes('data-testid="inspirational-cta-zones"'),
      'NO debe renderizar el botón data-testid="inspirational-cta-zones" al final cuando noZonesConfigured=true'
    );

    // Conteo exacto: «Configurar zonas» debe aparecer exactamente UNA sola vez en el estado inspirador
    const countOccurrences = (htmlNoZones.match(/Configurar zonas/g) || []).length;
    assert.equal(
      countOccurrences,
      1,
      '«Configurar zonas» debe aparecer exactamente 1 vez (sin duplicación al final)'
    );

    // Conserva las 4 tarjetas inspiradoras, Abrir un encuentro y Avisame si aparece uno
    assert.ok(htmlNoZones.includes('Salir a caminar'), 'Conserva tarjeta Salir a caminar');
    assert.ok(htmlNoZones.includes('Compartir unos mates'), 'Conserva tarjeta Compartir unos mates');
    assert.ok(htmlNoZones.includes('Café y charla'), 'Conserva tarjeta Café y charla');
    assert.ok(htmlNoZones.includes('Juegos de mesa'), 'Conserva tarjeta Juegos de mesa');
    assert.ok(htmlNoZones.includes('Abrir un encuentro'), 'Conserva CTA Abrir un encuentro');
    assert.ok(htmlNoZones.includes('Avisame si aparece uno'), 'Conserva CTA Avisame si aparece uno');

    // Caso 2: Con zonas configuradas (noZonesConfigured: false)
    const htmlWithZones = renderToString(
      React.createElement(HomeInspirationalEmptyState, {
        noZonesConfigured: false,
        onSelectIdea: () => {},
      })
    );

    // Debe mostrar el botón inferior con "Cambiar o sumar zonas"
    assert.ok(
      htmlWithZones.includes('data-testid="inspirational-cta-zones"'),
      'Con zonas configuradas, debe renderizar data-testid="inspirational-cta-zones"'
    );
    assert.ok(
      htmlWithZones.includes('Cambiar o sumar zonas'),
      'Con zonas configuradas, debe mostrar «Cambiar o sumar zonas»'
    );
    // NO debe mostrar el recuadro superior de "Elegí tus zonas para ver encuentros cerca tuyo"
    assert.ok(
      !htmlWithZones.includes('data-testid="inspirational-zone-prompt"'),
      'Con zonas configuradas, no debe mostrar el prompt superior de no zonas'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 4. DISTRIBUCIÓN RESPONSIVE DE CONTROLES DE DISCOVERY
   * ───────────────────────────────────────────────────────────────── */
  test('4. Distribución responsive de controles de Discovery en CSS mobile y desktop', () => {
    const discoveryCss = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.css'),
      'utf-8'
    );

    // Verificación de flex-wrap en controles de Discovery para prevenir recortes en móvil
    assert.ok(
      discoveryCss.includes('.pe-discovery-header-actions'),
      'Debe declarar .pe-discovery-header-actions'
    );
    assert.ok(
      discoveryCss.includes('flex-wrap: wrap'),
      '.pe-discovery-header-actions debe permitir flex-wrap para pantallas angostas'
    );

    // Regla responsive para móvil (< 540px)
    assert.ok(
      discoveryCss.includes('@media (max-width: 539px)'),
      'Debe incluir regla @media (max-width: 539px) para teléfonos móviles'
    );
    assert.ok(
      discoveryCss.includes('margin-left: auto'),
      'pe-discovery-see-all-btn debe posicionarse con margen limpio'
    );

    // En pantallas grandes (>= 540px) preserva nowrap
    assert.ok(
      discoveryCss.includes('flex-wrap: nowrap'),
      'En desktop/pantalla ancha debe mantener flex-wrap: nowrap'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 5. BOTÓN FLOTANTE «+ CREAR» (FAB) Y ÁREA SEGURA
   * ───────────────────────────────────────────────────────────────── */
  test('5. FAB «+ Crear»: Ocultamiento seguro en los 4 modales/sheets de Discovery y área segura', () => {
    const discoveryCss = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.css'),
      'utf-8'
    );
    const homeCss = fs.readFileSync(
      path.join(rootDir, 'src/screens/Home.css'),
      'utf-8'
    );

    // Ocultamiento con :has cuando cualquiera de los 4 modales/sheets está abierto:
    // 1. Detalle de encuentro (.pe-detail-overlay / .pe-detail-sheet)
    // 2. Selector de zonas (.pe-zones-overlay / .pe-zones-modal)
    // 3. Avisame bottom sheet (.pe-sheet-overlay / .pe-avisame-sheet)
    // 4. Ver en lista bottom sheet (.pe-discovery-see-all-backdrop / .pe-discovery-see-all-sheet)
    const expectedSelectors = [
      'body:has(.pe-detail-overlay) .home-fab-container',
      'body:has(.pe-detail-sheet) .home-fab-container',
      'body:has(.pe-zones-overlay) .home-fab-container',
      'body:has(.pe-zones-modal) .home-fab-container',
      'body:has(.pe-sheet-overlay) .home-fab-container',
      'body:has(.pe-avisame-sheet) .home-fab-container',
      'body:has(.pe-discovery-see-all-backdrop) .home-fab-container',
      'body:has(.pe-discovery-see-all-sheet) .home-fab-container',
    ];

    for (const sel of expectedSelectors) {
      assert.ok(
        discoveryCss.includes(sel),
        `HomeOpenEncounters.css debe contener el selector: ${sel}`
      );
      assert.ok(
        homeCss.includes(sel),
        `Home.css debe contener el selector: ${sel}`
      );
    }

    // Área segura y z-index en Home.css
    assert.ok(
      homeCss.includes('bottom: calc(18px + env(safe-area-inset-bottom, 0px))') ||
        homeCss.includes('bottom: calc(20px + env(safe-area-inset-bottom, 0px))'),
      'El FAB debe respetar env(safe-area-inset-bottom, 0px)'
    );

    // Padding inferior del sheet vertical de encuentros para garantizar que la última card no quede tapada
    assert.ok(
      discoveryCss.includes('.pe-discovery-see-all-content'),
      'Debe definir .pe-discovery-see-all-content'
    );
    assert.ok(
      discoveryCss.includes('calc(28px + env(safe-area-inset-bottom, 0px))'),
      '.pe-discovery-see-all-content debe incluir reserva de espacio inferior para la última tarjeta'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 6. PROTECCIÓN CONTRA LISTA VACÍA POR FILTRO DE DISPONIBILIDAD
   * ───────────────────────────────────────────────────────────────── */
  test('6. Filtro disponibilidad sin resultados: no abre sheet vacío, muestra aviso explicativo y acción contextual', () => {
    // Render con un encuentro sin cupos disponibles y el filtro "Solo con lugares disponibles" activo
    const htmlEmptyByFilter = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: [mockPresencialEncounter2], // openSlots: 0, inscriptionsClosed: true
        selectedLocalityIds: ['guemes'],
        noZonesConfigured: false,
        initialOnlyAvailableFilter: true,
      })
    );

    // 1. No debe mostrar el botón «Ver en lista» en la cabecera cuando displayedEncounters está vacío
    assert.ok(
      !htmlEmptyByFilter.includes('data-testid="discovery-see-in-list-btn"'),
      'NO debe renderizar «Ver en lista» en la cabecera cuando no hay resultados disponibles'
    );

    // 2. Debe mostrar el mensaje explicativo contextual
    assert.ok(
      htmlEmptyByFilter.includes('No hay encuentros con lugares disponibles ahora.'),
      'Debe mostrar el mensaje explicativo de no disponibilidad'
    );
    assert.ok(
      htmlEmptyByFilter.includes('Podés desactivar el filtro para ver todos los encuentros o abrir tu propio plan.'),
      'Debe sugerir desactivar el filtro o abrir un plan propio'
    );

    // 3. Debe ofrecer la acción contextual para desactivar el filtro
    assert.ok(
      htmlEmptyByFilter.includes('Ver todos los encuentros'),
      'Debe proveer el botón de acción para desactivar el filtro y ver todos los encuentros'
    );

    // 4. NO debe renderizar el sheet ni backdrop de listado vacío en el DOM
    assert.ok(
      !htmlEmptyByFilter.includes('pe-discovery-see-all-backdrop'),
      'NO debe renderizar el portal del sheet vertical vacío'
    );

    // 5. Verificación de salvaguarda en código fuente
    const openEncSource = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx'),
      'utf-8'
    );
    assert.ok(
      openEncSource.includes('if (onlyAvailableFilter && displayedEncounters.length === 0)'),
      'handleSeeAllClick debe comprobar y desactivar el filtro antes de intentar abrir un sheet vacío'
    );
    assert.ok(
      openEncSource.includes('isSeeAllListOpen && displayedEncounters.length > 0 && typeof document !== \'undefined\''),
      'El portal del sheet debe protegerse con displayedEncounters.length > 0'
    );
  });
});
