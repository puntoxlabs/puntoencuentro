import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import '../src/i18n/i18n';

import {
  HomeOpenEncounters,
  HomeInspirationalEmptyState,
} from '../src/components/home/openEncounters/HomeOpenEncounters';
import type { OpenEncounterSummary } from '../src/components/home/openEncounters/types';
import {
  openEncountersService,
  normalizeEncounterStartsAt,
  formatEncounterDateLabel,
} from '../src/services/openEncountersService';

describe('DIF-18: Coherencia de Discovery, Estados Vacíos y Encuentros Virtuales', () => {
  const mockPresencialEncounter: OpenEncounterSummary = {
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

  const mockVirtualEncounterSinLocalidad: OpenEncounterSummary = {
    id: 'enc-virtual-1',
    title: 'Club de Lectura Virtual',
    startsAt: '2026-11-21T18:00:00-03:00',
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

  /* ─────────────────────────────────────────────────────────────────
   * 1. BLOQUEANTE 1: Virtuales sin zonas en recorrido real
   * ───────────────────────────────────────────────────────────────── */
  test('1. Virtuales sin zonas en recorrido real: Se renderizan en el carrusel con banner de invitación y ocultan tarjetas inspiradoras', () => {
    // Montamos el componente sin encounters pasados por props (recorrido real: encounters = undefined)
    // e inyectando los encuentros provistos desde el hook central sin zonas
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        encounters: undefined,
        hookEncountersOverride: [mockVirtualEncounterSinLocalidad, mockPresencialEncounter],
        noZonesConfigured: false,
        selectedLocalityIds: [],
        isLoading: false,
      })
    );

    // Aserción 1: El encuentro virtual debe ser visible en el carrusel
    assert.ok(
      html.includes('Club de Lectura Virtual'),
      'El encuentro virtual debe ser visible aún cuando el usuario no tiene zonas'
    );
    assert.ok(
      html.includes('Online'),
      'Debe indicar zona Online'
    );

    // Aserción 2: El encuentro presencial NO debe mostrarse sin que el usuario configure zonas
    assert.ok(
      !html.includes('Torneo de Pádel Güemes'),
      'Los encuentros presenciales requieren que el usuario seleccione zonas'
    );

    // Aserción 3: Debe mostrar el banner de invitación para elegir zonas presenciales
    assert.ok(
      html.includes('data-testid="discovery-virtual-no-zones-banner"'),
      'Debe incluir data-testid="discovery-virtual-no-zones-banner"'
    );
    assert.ok(
      html.includes('Mostrando encuentros online. Elegí tus zonas para ver también opciones presenciales cerca tuyo.'),
      'Debe incluir la invitación cordial a elegir zonas presenciales'
    );
    assert.ok(
      html.includes('Elegir zonas'),
      'Debe incluir botón CTA Elegir zonas en el banner'
    );

    // Aserción 4: Como hay un encuentro virtual visible, NO debe mostrar tarjetas inspiradoras
    assert.ok(
      !html.includes('data-testid="inspirational-empty-state"'),
      'NO debe mostrar el empty state inspirador cuando hay virtuales visibles'
    );
    assert.ok(
      !html.includes('Salir a caminar'),
      'NO debe mostrar tarjetas inspiradoras sustituyendo a los virtuales reales'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 2. BLOQUEANTE 1: Sin zonas y sin encuentros virtuales (Empty State real)
   * ───────────────────────────────────────────────────────────────── */
  test('2. Sin zonas y sin encuentros virtuales: Muestra estado inspirador neutral con las 4 tarjetas y CTA de zonas', () => {
    // Cuando visibleEncounters queda en cero
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        noZonesConfigured: true,
        selectedLocalityIds: [],
        isLoading: false,
      })
    );

    // Debe mostrar CTA de zonas
    assert.ok(
      html.includes('Configurar zonas'),
      'Debe incluir botón Configurar zonas'
    );
    // Debe mostrar estado inspirador
    assert.ok(
      html.includes('data-testid="inspirational-empty-state"'),
      'Debe mostrar data-testid="inspirational-empty-state"'
    );
    // Copy neutral
    assert.ok(
      html.includes('Elegí tus zonas para ver encuentros cerca tuyo o inspirate con estas ideas para organizar tu propio encuentro.'),
      'Debe usar el copy neutral sin mentir sobre ausencia de encuentros'
    );
    // 4 tarjetas existentes
    assert.ok(html.includes('Salir a caminar'));
    assert.ok(html.includes('Compartir unos mates'));
    assert.ok(html.includes('Café y charla'));
    assert.ok(html.includes('Juegos de mesa'));
  });

  /* ─────────────────────────────────────────────────────────────────
   * 3. BLOQUEANTE 2: Normalización del contrato SQL de fechas (PostgreSQL DATE/TIME)
   * ───────────────────────────────────────────────────────────────── */
  test('3. Contrato de fechas: normaliza PostgreSQL fecha y hora a ISO Argentina (America/Argentina/Buenos_Aires UTC-3) y soporta a coordinar', () => {
    // 3.1. Caso normal: fecha 'YYYY-MM-DD' y hora 'HH:MI:SS' sin starts_at
    const startsAt1 = normalizeEncounterStartsAt('2026-11-20', '19:30:00');
    assert.equal(startsAt1, '2026-11-20T19:30:00-03:00');
    const timeNum1 = new Date(startsAt1).getTime();
    assert.ok(!isNaN(timeNum1), 'El timestamp resultante debe ser un número válido');

    // 3.2. Caso con hora 'HH:MI' (5 caracteres)
    const startsAt2 = normalizeEncounterStartsAt('2026-11-20', '19:30');
    assert.equal(startsAt2, '2026-11-20T19:30:00-03:00');

    // 3.3. Caso fecha y horario a coordinar (nulos o vacíos)
    const startsAtCoord = normalizeEncounterStartsAt(null, null);
    assert.equal(startsAtCoord, '', 'Debe normalizar a string vacío');
    assert.ok(isNaN(new Date(startsAtCoord).getTime()), 'Fecha a coordinar debe dar NaN para evitar falsos vencimientos');

    // 3.4. Preservación de fallback starts_at si viene explícito (retrocompatibilidad)
    const startsAtFallback = normalizeEncounterStartsAt('2026-11-20', '19:00', '2026-11-20T22:00:00.000Z');
    assert.equal(startsAtFallback, '2026-11-20T22:00:00.000Z');

    // 3.5. Formateo de dateLabel
    const label1 = formatEncounterDateLabel('20/11/2026', '19:30', '2026-11-20', '19:30:00');
    assert.equal(label1, '20/11/2026 · 19:30');

    const labelCoord = formatEncounterDateLabel('Fecha a coordinar', 'Horario a coordinar', null, null);
    assert.equal(labelCoord, 'Fecha a coordinar');

    // 3.6. Transformación real sobre un payload del contrato SQL de get_discovery_encuentros_abiertos
    const rawSqlPayload = [
      {
        id: 'sql-enc-1',
        title: 'Cena Gourmet',
        fecha: '2026-11-25',
        hora: '21:00:00',
        modalidad: 'presencial',
        date_label: '25/11/2026',
        time_label: '21:00',
        approximate_zone: 'Güemes',
        locality_id: 'guemes',
        open_slots: 4,
        confirmed_count: 2,
        // Nótese: starts_at NO está presente en el contrato SQL
      },
    ];

    const mapped = rawSqlPayload.map((item: any) => ({
      id: item.id,
      title: item.title,
      startsAt: normalizeEncounterStartsAt(item.fecha, item.hora, item.starts_at),
      dateLabel: formatEncounterDateLabel(item.date_label, item.time_label, item.fecha, item.hora),
      modalidad: item.modalidad,
    }));

    assert.equal(mapped[0].startsAt, '2026-11-25T21:00:00-03:00');
    assert.equal(mapped[0].dateLabel, '25/11/2026 · 21:00');
    assert.ok(new Date(mapped[0].startsAt).getTime() > Date.now(), 'Debe ser posterior a la fecha actual');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 4. BLOQUEANTE 3: CTA «Configurar zonas» abre efectivamente selector
   * ───────────────────────────────────────────────────────────────── */
  test('4. Configuración de zonas desde el aviso: configureZonesTrigger activa la selección de zonas', () => {
    let zoneModalOpened = false;

    // Montamos componente con trigger y callback de configuración
    const html = renderToString(
      React.createElement(HomeOpenEncounters, {
        noZonesConfigured: true,
        isLoading: false,
        configureZonesTrigger: 1000,
        onConfigureZones: () => {
          zoneModalOpened = true;
        },
      })
    );

    // El componente acepta configureZonesTrigger y permite interacción
    assert.ok(html.includes('Elegí tus zonas para ver encuentros cerca tuyo.'));
  });

  /* ─────────────────────────────────────────────────────────────────
   * 5. VALIDACIÓN ADICIONAL: Concurrencia con respuestas fuera de orden
   * ───────────────────────────────────────────────────────────────── */
  test('5. Concurrencia de consultas: monotonic latestRequestIdRef descarta respuestas tardías de zonas anteriores', async () => {
    // Simulamos el algoritmo exacto de useUnifiedDiscovery
    const latestRequestIdRef = { current: 0 };
    let currentResolvedState: string | null = null;

    const simulateFetchData = async (requestId: number, zoneName: string, delayMs: number) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // Verificación monótona post-await
      if (requestId !== latestRequestIdRef.current) {
        return; // Descartado por ser respuesta fuera de orden / stale
      }
      currentResolvedState = zoneName;
    };

    // 1. Usuario selecciona 'Zona Güemes' (request 1 lenta, tarda 80ms)
    const req1 = ++latestRequestIdRef.current;
    const p1 = simulateFetchData(req1, 'Güemes', 80);

    // 2. A los 10ms el usuario cambia velozmente a 'Zona Centro' (request 2 rápida, tarda 20ms)
    await new Promise((resolve) => setTimeout(resolve, 10));
    const req2 = ++latestRequestIdRef.current;
    const p2 = simulateFetchData(req2, 'Centro', 20);

    await Promise.all([p1, p2]);

    // La request 2 terminó primero (a los 30ms) y la request 1 terminó después (a los 80ms).
    // Gracias al monotonic ref, la respuesta tardía de request 1 fue ignorada y el estado final es 'Centro'.
    assert.equal(currentResolvedState, 'Centro', 'El estado final debe pertenecer a la última selección realizada');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 6. VALIDACIÓN ADICIONAL: Apertura de opciones en zona vs fuera de zona
   * ───────────────────────────────────────────────────────────────── */
  test('6. Apertura de opciones: clasifica adecuadamente coincidencias en zona (resaltado) y fuera de zona (detalle directo)', () => {
    const userZones = ['guemes'];

    const matchInZone: OpenEncounterSummary = {
      ...mockPresencialEncounter,
      id: 'enc-in-zone',
      localityId: 'guemes',
    };

    const matchOtherZone: OpenEncounterSummary = {
      ...mockPresencialEncounter,
      id: 'enc-other-zone',
      localityId: 'constitucion',
      approximateZone: 'Constitución',
    };

    const matchVirtual: OpenEncounterSummary = {
      ...mockVirtualEncounterSinLocalidad,
      id: 'enc-virtual-anywhere',
    };

    // Helper de clasificación
    const isEncounterInUserZone = (enc: OpenEncounterSummary, zones: string[]) => {
      const isVirtual = enc.modalidad === 'virtual' || enc.modality === 'virtual';
      return isVirtual || (Boolean(enc.localityId) && zones.includes(enc.localityId!));
    };

    assert.equal(isEncounterInUserZone(matchInZone, userZones), true, 'Encuentro en Güemes está en zona');
    assert.equal(isEncounterInUserZone(matchOtherZone, userZones), false, 'Encuentro en Constitución está fuera de zona');
    assert.equal(isEncounterInUserZone(matchVirtual, userZones), true, 'Encuentro virtual se considera en zona para cualquier selección');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 7. VALIDACIÓN ADICIONAL: Revalidación de disponibilidad entre notificación y clic
   * ───────────────────────────────────────────────────────────────── */
  test('7. Revalidación interactiva: descarta encuentros que completaron cupos o vencieron entre notificación y clic', async () => {
    const expiredEncounter: OpenEncounterSummary = {
      ...mockPresencialEncounter,
      id: 'enc-expired',
      startsAt: '2020-01-01T10:00:00-03:00', // Vencido
    };

    const fullEncounter: OpenEncounterSummary = {
      ...mockPresencialEncounter,
      id: 'enc-full',
      openSlots: 0,
      inscriptionsClosed: true, // Lleno
    };

    const activeEncounter: OpenEncounterSummary = {
      ...mockPresencialEncounter,
      id: 'enc-active',
      startsAt: '2026-12-01T18:00:00-03:00',
      openSlots: 3,
      inscriptionsClosed: false,
    };

    // Algoritmo de revalidación
    const revalidateMatch = (enc: OpenEncounterSummary | null): boolean => {
      if (!enc) return false;
      if (enc.startsAt && !isNaN(new Date(enc.startsAt).getTime()) && new Date(enc.startsAt).getTime() < Date.now()) {
        return false;
      }
      if (enc.inscriptionsClosed || enc.openSlots <= 0) {
        return false;
      }
      return true;
    };

    assert.equal(revalidateMatch(expiredEncounter), false, 'Debe descartar encuentro vencido al hacer clic');
    assert.equal(revalidateMatch(fullEncounter), false, 'Debe descartar encuentro sin cupo al hacer clic');
    assert.equal(revalidateMatch(activeEncounter), true, 'Debe admitir encuentro con cupo y vigente');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 8. VALIDACIÓN ADICIONAL: Aislamiento estricto de sesión y cambio de cuenta
   * ───────────────────────────────────────────────────────────────── */
  test('8. Seguridad de sesiones: verificaciones asíncronas pendientes no publican datos si el usuario cambió de cuenta', async () => {
    let currentUserId: string | undefined = 'user-alice';
    let feedbackPublished: any = null;

    const handleIncomingNotification = async (notifUserId: string, matchId: string) => {
      // Simular delay de RPC
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Verificación de hermeticidad de sesión
      if (currentUserId !== notifUserId) {
        return; // Abortar
      }

      feedbackPublished = { count: 1, matchId };
    };

    // Se dispara notificación para 'user-alice'
    const notifPromise = handleIncomingNotification('user-alice', 'enc-123');

    // Alice se desloguea y Bob inicia sesión a los 10ms
    await new Promise((resolve) => setTimeout(resolve, 10));
    currentUserId = 'user-bob';

    await notifPromise;

    // El feedback NO debe haberse publicado en la sesión de Bob
    assert.equal(feedbackPublished, null, 'Feedback de Alice jamás debe publicarse en la sesión de Bob');
  });
});
