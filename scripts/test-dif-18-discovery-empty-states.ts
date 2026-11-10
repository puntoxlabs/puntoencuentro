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
import { openEncountersService } from '../src/services/openEncountersService';

describe('DIF-18: Coherencia de Discovery, Estados Vacíos y Encuentros Virtuales', () => {
  const rootDir = process.cwd();

  const mockPresencialEncounter: OpenEncounterSummary = {
    id: 'enc-guemes-1',
    title: 'Torneo de Pádel Güemes',
    startsAt: '2026-11-20T19:00:00Z',
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

  const mockVirtualEncounterSinLocalidad: OpenEncounterSummary = {
    id: 'enc-virtual-1',
    title: 'Club de Lectura Virtual',
    startsAt: '2026-11-21T18:00:00Z',
    dateLabel: 'Sábado 18:00',
    approximateZone: 'Online',
    localityId: null,
    modalidad: 'virtual',
    modality: 'virtual',
    openSlots: 10,
    confirmedCount: 5,
    language: 'es',
    emoji: '📚',
  };

  const mockFullEncounter: OpenEncounterSummary = {
    id: 'enc-full-1',
    title: 'Café Llena Güemes',
    startsAt: '2026-11-22T17:00:00Z',
    dateLabel: 'Domingo 17:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    modalidad: 'presencial',
    modality: 'presencial',
    openSlots: 0,
    confirmedCount: 6,
    language: 'es',
    inscriptionsClosed: true,
  };

  /* ─────────────────────────────────────────────────────────────────
   * 1. ESTADO 1: Sin zonas configuradas
   * ───────────────────────────────────────────────────────────────── */
  test('1. Sin zonas: Mantiene CTA de configuración y permite ver las 4 tarjetas inspiradoras', () => {
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        noZonesConfigured: true,
      })
    );

    // Debe mostrar el CTA de configuración de zonas
    assert.ok(
      html.includes('Elegí tus zonas para ver encuentros cerca tuyo.'),
      'Debe incluir el mensaje para configurar zonas'
    );
    assert.ok(html.includes('Configurar zonas'), 'Debe incluir el botón Configurar zonas');

    // Debe permitir ver el estado inspirador
    assert.ok(
      html.includes('data-testid="inspirational-empty-state"'),
      'Debe renderizar data-testid="inspirational-empty-state"'
    );

    // NO debe afirmar falsamente que no hay encuentros en tu zona
    assert.ok(
      !html.includes('Todavía no hay encuentros abiertos en tu zona.'),
      'NO debe afirmar falsamente que no hay encuentros en tu zona cuando no hay zonas elegidas'
    );
    assert.ok(
      html.includes('Elegí tus zonas para ver encuentros cerca tuyo o inspirate con estas ideas para organizar tu propio encuentro.'),
      'Debe incluir la bajada neutral adecuada para sin zonas'
    );

    // Debe incluir las 4 tarjetas y el disclaimer
    assert.ok(html.includes('Salir a caminar'), 'Debe incluir tarjeta 1');
    assert.ok(html.includes('Compartir unos mates'), 'Debe incluir tarjeta 2');
    assert.ok(html.includes('Café y charla'), 'Debe incluir tarjeta 3');
    assert.ok(html.includes('Juegos de mesa'), 'Debe incluir tarjeta 4');
    assert.ok(
      html.includes('Ideas para organizar • No son encuentros publicados'),
      'Debe incluir el disclaimer que evita confundir ideas con encuentros reales'
    );

    // En la cabecera, "Ver todos" NO debe mostrarse para evitar abrir de forma equívoca el selector de zonas
    assert.ok(
      !html.includes('pe-discovery-see-all-btn'),
      'No debe renderizar botón "Ver todos" en cabecera si no hay encuentros en el catálogo'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 2. ESTADO 2: Zonas configuradas sin encuentros
   * ───────────────────────────────────────────────────────────────── */
  test('2. Zonas configuradas sin encuentros: Muestra estado inspirador empático con su texto existente', () => {
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: [],
        noZonesConfigured: false,
        selectedLocalityIds: ['guemes'],
      })
    );

    assert.ok(
      html.includes('Todavía no hay encuentros abiertos en tu zona. Pero hay muchas cosas que podemos hacer juntos.'),
      'Debe mostrar el texto existente cuando la zona elegida no tiene encuentros'
    );
    assert.ok(
      html.includes('Cambiar o sumar zonas'),
      'Debe ofrecer botón para cambiar o sumar zonas'
    );
    assert.ok(html.includes('Abrir un encuentro'), 'Debe ofrecer CTA Abrir un encuentro');
    assert.ok(html.includes('Avisame si aparece uno'), 'Debe ofrecer CTA Avisame');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 3. ESTADO 3: Encuentros completos y filtro de disponibilidad
   * ───────────────────────────────────────────────────────────────── */
  test('3. Encuentros reales disponibles ocultan tarjetas inspiradoras', () => {
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: [mockPresencialEncounter],
        noZonesConfigured: false,
        selectedLocalityIds: ['guemes'],
      })
    );

    // Debe mostrar la card real
    assert.ok(html.includes('Torneo de Pádel Güemes'), 'Debe mostrar el encuentro real');
    assert.ok(html.includes('pe-discovery-track'), 'Debe renderizar el track del carrusel');

    // NUNCA debe mostrar el estado inspirador
    assert.ok(
      !html.includes('data-testid="inspirational-empty-state"'),
      'NO debe mostrar el estado inspirador cuando hay encuentros reales'
    );
    assert.ok(
      !html.includes('Los próximos encuentros empiezan con una idea'),
      'NO debe mostrar ideas para organizar cuando hay encuentros reales'
    );

    // Debe mostrar el botón "Ver todos" en la cabecera
    assert.ok(
      html.includes('pe-discovery-see-all-btn'),
      'Debe renderizar el botón "Ver todos" en la cabecera cuando hay encuentros reales'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 4. ENCUENTROS VIRTUALES: Preservación sin localidad
   * ───────────────────────────────────────────────────────────────── */
  test('4. Encuentros virtuales: Se descubren independientemente de localityId (tanto con zonas como sin ellas)', () => {
    // 4A: Con zonas configuradas que NO incluyen null ni localidad de mock
    const htmlConZonas = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: [mockVirtualEncounterSinLocalidad],
        noZonesConfigured: false,
        selectedLocalityIds: ['centro', 'constitucion'],
      })
    );

    assert.ok(
      htmlConZonas.includes('Club de Lectura Virtual'),
      'Encuentro virtual con localityId=null debe ser visible aún cuando la zona elegida no coincida'
    );
    assert.ok(htmlConZonas.includes('Online'), 'Debe mostrar zona Online');

    // 4B: Sin zonas configuradas pasadas por prop pero con prop encounters
    const htmlSinZonas = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: [mockVirtualEncounterSinLocalidad],
        noZonesConfigured: false,
        selectedLocalityIds: [],
      })
    );

    assert.ok(
      htmlSinZonas.includes('Club de Lectura Virtual'),
      'Encuentro virtual debe ser visible sin zonas'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 5. CONTRATO Y NORMALIZACIÓN: openEncountersService proyecta modalidad
   * ───────────────────────────────────────────────────────────────── */
  test('5. openEncountersService normaliza correctamente modalidad y modality en OpenEncounterSummary', async () => {
    const serviceContent = fs.readFileSync(
      path.join(rootDir, 'src/services/openEncountersService.ts'),
      'utf-8'
    );

    assert.ok(
      serviceContent.includes("modalidad: (item.modalidad || item.modality"),
      'openEncountersService.getDiscoveryEncuentrosWithStatus debe proyectar modalidad'
    );
    assert.ok(
      serviceContent.includes("modality: (item.modalidad || item.modality"),
      'openEncountersService.getDiscoveryEncuentrosWithStatus debe proyectar modality'
    );
    assert.ok(
      serviceContent.includes("localityId: item.locality_id ?? null"),
      'openEncountersService debe admitir localityId nulo para virtuales'
    );

    const typesContent = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/types.ts'),
      'utf-8'
    );
    assert.ok(
      typesContent.includes("modalidad?: 'presencial' | 'virtual'"),
      'OpenEncounterSummary debe definir modalidad'
    );
    assert.ok(
      typesContent.includes("modality?: 'presencial' | 'virtual'"),
      'OpenEncounterSummary debe definir modality'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 6. CONCURRENCIA: useUnifiedDiscovery previene race conditions
   * ───────────────────────────────────────────────────────────────── */
  test('6. useUnifiedDiscovery: Monotonic latestRequestIdRef descarta respuestas tardías de zonas previas', () => {
    const hookContent = fs.readFileSync(
      path.join(rootDir, 'src/hooks/useUnifiedDiscovery.ts'),
      'utf-8'
    );

    assert.ok(
      hookContent.includes('const latestRequestIdRef = useRef(0)'),
      'useUnifiedDiscovery debe instanciar latestRequestIdRef'
    );
    assert.ok(
      hookContent.includes('const currentRequestId = ++latestRequestIdRef.current'),
      'fetchData debe incrementar latestRequestIdRef en cada ejecución'
    );
    assert.ok(
      hookContent.includes('currentRequestId !== latestRequestIdRef.current'),
      'fetchData debe validar que currentRequestId sea el más reciente tras cada await'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 7. NAVEGACIÓN «VER TODOS»: Sheet completo e interacción con filtros
   * ───────────────────────────────────────────────────────────────── */
  test('7. Navegación «Ver todos»: Posee sheet dedicado y nunca abre de forma equívoca el modal de zonas', () => {
    const openEncContent = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx'),
      'utf-8'
    );

    // Verificación de estado del sheet
    assert.ok(
      openEncContent.includes('const [isSeeAllListOpen, setIsSeeAllListOpen] = useState(false)'),
      'HomeOpenEncounters debe declarar isSeeAllListOpen'
    );

    // Verificación de handleSeeAllClick
    assert.ok(
      openEncContent.includes('if (onlyAvailableFilter) {\n      setOnlyAvailableFilter(false);'),
      'handleSeeAllClick debe desactivar onlyAvailableFilter si estaba activo'
    );
    assert.ok(
      openEncContent.includes('setIsSeeAllListOpen(true)'),
      'handleSeeAllClick debe abrir el sheet de listado completo si no hay filtro restrictivo'
    );
    assert.ok(
      !openEncContent.includes('handleSeeAllClick = () => {\n    if (onSeeAll) {\n      onSeeAll();\n    } else {\n      handleOpenZoneModal();'),
      'handleSeeAllClick NUNCA debe derivar silenciosamente a handleOpenZoneModal()'
    );

    // Sheet renderizado
    assert.ok(
      openEncContent.includes('data-testid="discovery-see-all-sheet"'),
      'HomeOpenEncounters debe renderizar data-testid="discovery-see-all-sheet"'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 8. COHERENCIA DE COINCIDENCIAS EN HOME.TSX
   * ───────────────────────────────────────────────────────────────── */
  test('8. Home.tsx: Verificación de disponibilidad previa, descarte de vencidos y discriminación de zonas', () => {
    const homeContent = fs.readFileSync(
      path.join(rootDir, 'src/screens/Home.tsx'),
      'utf-8'
    );

    // Verificación previa vía getEncuentroAbiertoById
    assert.ok(
      homeContent.includes('await openEncountersService.getEncuentroAbiertoById(encounterId)'),
      'Home.tsx debe verificar la disponibilidad del encuentro vía getEncuentroAbiertoById antes de mostrarlo'
    );

    // Descarte de anfitrión
    assert.ok(
      homeContent.includes('verifiedEnc.hostId === user.id'),
      'Home.tsx debe descartar encuentros donde el usuario es el anfitrión'
    );

    // Descarte de vencidos
    assert.ok(
      homeContent.includes('new Date(verifiedEnc.startsAt).getTime() < Date.now()'),
      'Home.tsx debe descartar encuentros vencidos con fecha/hora en el pasado'
    );

    // Descarte de cerrados o sin cupo
    assert.ok(
      homeContent.includes('verifiedEnc.inscriptionsClosed || verifiedEnc.openSlots <= 0'),
      'Home.tsx debe descartar encuentros con cupo lleno o inscripciones cerradas'
    );

    // Discriminación de zonas
    assert.ok(
      homeContent.includes('inZoneEncounterIds'),
      'liveMatchFeedback debe almacenar inZoneEncounterIds'
    );
    assert.ok(
      homeContent.includes('otherZoneEncounterIds'),
      'liveMatchFeedback debe almacenar otherZoneEncounterIds'
    );
    assert.ok(
      homeContent.includes('noZonesConfigured'),
      'liveMatchFeedback debe registrar si el usuario no tiene zonas'
    );

    // Manejo de clic en "Ver opciones" según contexto
    assert.ok(
      homeContent.includes('if (noZonesConfigured)'),
      'handleViewLiveMatches debe manejar el caso de usuario sin zonas'
    );
    assert.ok(
      homeContent.includes('if (inZoneEncounterIds && inZoneEncounterIds.length > 0)'),
      'handleViewLiveMatches debe resaltar encuentros en zona activa'
    );
    assert.ok(
      homeContent.includes('if (otherZoneEncounterIds && otherZoneEncounterIds.length > 0 && firstMatch)'),
      'handleViewLiveMatches debe abrir la ficha de detalle si el encuentro está en otra zona'
    );
  });
});
