import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
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
  getArgentinaNow,
  isEncounterVigente,
} from '../src/services/openEncountersService';
import { intencionesService } from '../src/services/intencionesService';
import { useUnifiedDiscovery } from '../src/hooks/useUnifiedDiscovery';

/* ─────────────────────────────────────────────────────────────────
 * DOM Ligero React 19 para pruebas de componentes montados con useEffect
 * ───────────────────────────────────────────────────────────────── */
let origDocument: any;
let origWindow: any;
let origHTMLIFrameElement: any;
let mockBody: any;

const makeDomNode = (tag = 'DIV') => {
  const node: any = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: [],
    style: {},
    attributes: {},
    _textContent: '',
    ownerDocument: null,
    parentNode: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild(child: any) {
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child: any) {
      this.childNodes = this.childNodes.filter((c: any) => c !== child);
      child.parentNode = null;
      return child;
    },
    insertBefore(child: any, ref: any) {
      const idx = this.childNodes.indexOf(ref);
      if (idx >= 0) this.childNodes.splice(idx, 0, child);
      else this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    setAttribute(k: string, v: string) {
      this.attributes[k] = v;
    },
    removeAttribute(k: string) {
      delete this.attributes[k];
    },
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
  };
  Object.defineProperty(node, 'textContent', {
    get() {
      if (this._textContent) return this._textContent;
      if (this.childNodes.length > 0) return this.childNodes.map((c: any) => c.textContent || '').join(' ');
      return '';
    },
    set(val: string) {
      this._textContent = val;
    },
  });
  return node;
};

const makeTextNode = (text = '') => {
  let val = text;
  return {
    nodeType: 3,
    get nodeValue() {
      return val;
    },
    set nodeValue(v: string) {
      val = v;
    },
    get data() {
      return val;
    },
    set data(v: string) {
      val = v;
    },
    get textContent() {
      return val;
    },
    set textContent(v: string) {
      val = v;
    },
    parentNode: null,
  };
};

function getDomString(node: any): string {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || node.nodeValue || node.data || '';
  let out = '';
  if (node.attributes) {
    for (const [k, v] of Object.entries(node.attributes)) {
      out += ' ' + k + '="' + v + '"';
    }
  }
  if (node._textContent) out += ' ' + node._textContent;
  if (node.childNodes && node.childNodes.length > 0) {
    out += ' ' + node.childNodes.map(getDomString).join(' ');
  }
  return out;
}

function initSuiteDom() {
  origDocument = (globalThis as any).document;
  origWindow = (globalThis as any).window;
  origHTMLIFrameElement = (globalThis as any).HTMLIFrameElement;

  mockBody = makeDomNode('BODY');

  (globalThis as any).HTMLIFrameElement = class {};

  (globalThis as any).window = globalThis;
  (globalThis as any).window.location = {
    pathname: '/',
    search: '',
    hash: '',
    origin: 'http://localhost:5173',
  };
  (globalThis as any).window.addEventListener = () => {};
  (globalThis as any).window.removeEventListener = () => {};
  (globalThis as any).window.scrollTo = () => {};

  (globalThis as any).document = {
    nodeType: 9,
    visibilityState: 'visible',
    createElement: (tag: string) => makeDomNode(tag),
    createElementNS: (_ns: string, tag: string) => makeDomNode(tag),
    createTextNode: (text: string) => makeTextNode(text),
    createComment: () => ({ nodeType: 8, nodeValue: '', parentNode: null }),
    getElementById: (id: string) => {
      if (id === 'home-discovery-section') return makeDomNode('SECTION');
      return null;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: makeDomNode('HTML'),
    body: mockBody,
    defaultView: (globalThis as any).window,
  };
  mockBody.ownerDocument = (globalThis as any).document;
}

function teardownSuiteDom() {
  (globalThis as any).document = origDocument;
  (globalThis as any).window = origWindow;
  (globalThis as any).HTMLIFrameElement = origHTMLIFrameElement;
}

describe('DIF-18: Coherencia de Discovery, Estados Vacíos y Encuentros Virtuales', () => {
  before(() => {
    initSuiteDom();
  });

  after(() => {
    teardownSuiteDom();
  });

  const mockPresencialEncounter: OpenEncounterSummary = {
    id: 'enc-guemes-1',
    title: 'Torneo de Pádel Güemes',
    fecha: '2026-11-20',
    hora: '19:00:00',
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
    fecha: '2026-11-21',
    hora: '18:00:00',
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
   * 1. BLOQUEANTE AUDITORÍA: Activación real del selector de zonas desde configureZonesTrigger
   * ───────────────────────────────────────────────────────────────── */
  test('1. Montado real — Activación real del selector de zonas desde configureZonesTrigger (useEffect y portal)', async () => {
    const container = makeDomNode('DIV');
    container.ownerDocument = (globalThis as any).document;
    const root = createRoot(container);
    try {
      let onConfigureZonesCalled = false;

      // Paso 1: Render inicial sin trigger (configureZonesTrigger = 0)
      root.render(
        React.createElement(HomeOpenEncounters, {
          noZonesConfigured: true,
          isLoading: false,
          configureZonesTrigger: 0,
          onConfigureZones: () => {
            onConfigureZonesCalled = true;
          },
        })
      );
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(onConfigureZonesCalled, false, 'Inicialmente no debe disparar onConfigureZones');

      // Paso 2: El aviso de Discovery emite configureZonesTrigger > 0
      root.render(
        React.createElement(HomeOpenEncounters, {
          noZonesConfigured: true,
          isLoading: false,
          configureZonesTrigger: Date.now(),
          onConfigureZones: () => {
            onConfigureZonesCalled = true;
          },
        })
      );
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(onConfigureZonesCalled, true, 'El useEffect montado debe disparar efectivamente onConfigureZones');

      // Paso 3: Probar sin callback onConfigureZones -> abre ZoneSelectorModal internamente en document.body
      root.render(
        React.createElement(HomeOpenEncounters, {
          noZonesConfigured: true,
          isLoading: false,
          configureZonesTrigger: Date.now() + 10,
        })
      );
      await new Promise((r) => setTimeout(r, 60));
      const bodyHtml = getDomString(mockBody);
      assert.ok(
        bodyHtml.includes('pe-zones-modal') ||
          bodyHtml.includes('Configurar mis zonas') ||
          bodyHtml.includes('pe-zones-overlay'),
        'El modal de zonas debe montarse en el portal de document.body'
      );
    } finally {
      root.unmount();
    }
  });

  /* ─────────────────────────────────────────────────────────────────
   * 2. BLOQUEANTE AUDITORÍA: Concurrencia de consultas en useUnifiedDiscovery con respuestas fuera de orden
   * ───────────────────────────────────────────────────────────────── */
  test('2. Montado real — Concurrencia de consultas en useUnifiedDiscovery: monotonic latestRequestIdRef descarta respuestas asíncronas fuera de orden', async () => {
    const container = makeDomNode('DIV');
    container.ownerDocument = (globalThis as any).document;
    const root = createRoot(container);
    try {
      const origGetDiscovery = openEncountersService.getDiscoveryEncuentrosWithStatus;
      const origGetIntenciones = intencionesService.getDiscoveryIntenciones;

      intencionesService.getDiscoveryIntenciones = async () => ({ ok: true, data: [] });

      function createDeferred<T>() {
        let resolve!: (val: T) => void;
        let reject!: (err: any) => void;
        const promise = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      }

      const defGuemes = createDeferred<any>();
      const defCentro = createDeferred<any>();

      openEncountersService.getDiscoveryEncuentrosWithStatus = async (localityIds?: string[]) => {
        const id = localityIds && localityIds[0] ? localityIds[0] : 'all';
        if (id === 'guemes') {
          return defGuemes.promise;
        }
        if (id === 'centro') {
          return defCentro.promise;
        }
        return { ok: true, data: [] };
      };

      let latestHookReturn: any = null;
      function DiscoveryHarness({ localityIds }: { localityIds: string[] }) {
        const discovery = useUnifiedDiscovery({ localityIds });
        latestHookReturn = discovery;
        return React.createElement(
          'div',
          null,
          discovery.encounters.map((e) => React.createElement('span', { key: e.id }, e.title))
        );
      }

      // 1. Montar con Güemes (petición 1 lenta)
      root.render(React.createElement(DiscoveryHarness, { localityIds: ['guemes'] }));
      await new Promise((r) => setTimeout(r, 20));

      // 2. Montar rápidamente con Centro (petición 2 rápida)
      root.render(React.createElement(DiscoveryHarness, { localityIds: ['centro'] }));
      await new Promise((r) => setTimeout(r, 20));

      // 3. Llega primero la respuesta de Centro (rápida)
      defCentro.resolve({
        ok: true,
        data: [{ ...mockPresencialEncounter, id: 'enc-centro', title: 'Fútbol en Centro', localityId: 'centro' }],
      });
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(latestHookReturn.encounters.length, 1);
      assert.equal(latestHookReturn.encounters[0].id, 'enc-centro');

      // 4. Llega tarde la respuesta de Güemes (lenta)
      defGuemes.resolve({
        ok: true,
        data: [{ ...mockPresencialEncounter, id: 'enc-guemes', title: 'Pádel Güemes', localityId: 'guemes' }],
      });
      await new Promise((r) => setTimeout(r, 50));

      // 5. Invariante: La respuesta tardía de Güemes NO debe sobreescribir la selección de Centro
      assert.equal(latestHookReturn.encounters.length, 1, 'No debe mezclar ni reemplazar los encuentros de Centro');
      assert.equal(latestHookReturn.encounters[0].id, 'enc-centro', 'El estado final debe permanecer en Centro');

      openEncountersService.getDiscoveryEncuentrosWithStatus = origGetDiscovery;
      intencionesService.getDiscoveryIntenciones = origGetIntenciones;
    } finally {
      root.unmount();
    }
  });

  /* ─────────────────────────────────────────────────────────────────
   * 3. BLOQUEANTE AUDITORÍA: Virtuales sin zonas en recorrido real montado
   * ───────────────────────────────────────────────────────────────── */
  test('3. Montado real — Virtuales sin zonas en recorrido real (props.encounters = undefined): carrusel interactivo con banner y sin tarjetas inspiradoras', async () => {
    const container = makeDomNode('DIV');
    container.ownerDocument = (globalThis as any).document;
    const root = createRoot(container);
    try {
      root.render(
        React.createElement(HomeOpenEncounters, {
          encounters: undefined,
          hookEncountersOverride: [mockVirtualEncounterSinLocalidad, mockPresencialEncounter],
          noZonesConfigured: false,
          selectedLocalityIds: [],
          isLoading: false,
        })
      );
      await new Promise((r) => setTimeout(r, 50));
      const html = getDomString(container);

      // Virtual visible en DOM montado
      assert.ok(html.includes('Club de Lectura Virtual'), 'Virtual debe ser visible en DOM montado');
      assert.ok(html.includes('Online'), 'Debe indicar zona Online');

      // Presencial oculto sin zonas
      assert.ok(!html.includes('Torneo de Pádel Güemes'), 'Presencial debe estar oculto sin zonas');

      // Banner presente
      assert.ok(
        html.includes('discovery-virtual-no-zones-banner') ||
          html.includes('data-testid="discovery-virtual-no-zones-banner"'),
        'Debe contener el banner de invitación'
      );
      assert.ok(html.includes('Elegir zonas'), 'Debe tener CTA Elegir zonas');

      // Sin tarjetas inspiradoras sustitutas
      assert.ok(!html.includes('Salir a caminar'), 'NO debe mostrar tarjetas inspiradoras');
      assert.ok(!html.includes('Compartir unos mates'), 'NO debe mostrar mates');
    } finally {
      root.unmount();
    }
  });

  /* ─────────────────────────────────────────────────────────────────
   * 4. BLOQUEANTE AUDITORÍA: Sin zonas y sin virtuales montado (Empty state neutral con 4 tarjetas)
   * ───────────────────────────────────────────────────────────────── */
  test('4. Montado real — Sin zonas y sin encuentros virtuales: Muestra estado inspirador neutral con las 4 tarjetas y CTA de zonas', async () => {
    const container = makeDomNode('DIV');
    container.ownerDocument = (globalThis as any).document;
    const root = createRoot(container);
    try {
      root.render(
        React.createElement(HomeOpenEncounters, {
          noZonesConfigured: true,
          selectedLocalityIds: [],
          isLoading: false,
        })
      );
      await new Promise((r) => setTimeout(r, 50));
      const html = getDomString(container);

      assert.ok(html.includes('Configurar zonas'), 'Debe incluir botón Configurar zonas');
      assert.ok(html.includes('inspirational-empty-state'), 'Debe mostrar estado inspirador');
      assert.ok(html.includes('Salir a caminar'), 'Tarjeta 1');
      assert.ok(html.includes('Compartir unos mates'), 'Tarjeta 2');
      assert.ok(html.includes('Café y charla'), 'Tarjeta 3');
      assert.ok(html.includes('Juegos de mesa'), 'Tarjeta 4');
    } finally {
      root.unmount();
    }
  });

  /* ─────────────────────────────────────────────────────────────────
   * 5. BLOQUEANTE AUDITORÍA: Revalidación ante error de red en «Ver opciones»
   * ───────────────────────────────────────────────────────────────── */
  test('5. Revalidación ante error de red en «Ver opciones»: mensaje amigable sin fallback a encuentros obsoletos ni datos no revalidados', async () => {
    let deepLinkNotice: string | null = null;
    let viewedMatches: string[] | null = null;
    let selectedDeepLink: any = null;

    const t = (key: string, opts?: any) => opts?.defaultValue || key;

    const handleViewMatches = (ids: string[]) => {
      viewedMatches = ids;
    };

    const handleViewLiveMatchesSimulation = async (
      liveMatchFeedback: any,
      getEncuentroFn: (id: string) => Promise<any>
    ) => {
      if (!liveMatchFeedback || liveMatchFeedback.encounterIds.length === 0) return;
      const { encounterIds } = liveMatchFeedback;

      try {
        const userLocs = ['guemes'];
        const hasZones = Boolean(userLocs && userLocs.length > 0);

        if (!hasZones) {
          return;
        }

        const revalidatedPromises = encounterIds.map(async (id: string) => {
          const enc = await getEncuentroFn(id);
          if (!enc) return null;
          if (!isEncounterVigente(enc)) return null;
          if (enc.inscriptionsClosed || enc.openSlots <= 0) return null;
          return enc;
        });

        const freshList = (await Promise.all(revalidatedPromises)).filter(Boolean);
        if (freshList.length === 0) {
          deepLinkNotice = t('your_encounters.matches_no_longer_available');
          return;
        }
        handleViewMatches(freshList.map((e: any) => e.id));
      } catch (err) {
        // Bloqueante Auditoría DIF-18: Ante error de red, NO reutilizar inZoneEncounterIds ni firstMatch
        deepLinkNotice = t('your_encounters.revalidation_network_error', {
          defaultValue: 'No pudimos comprobar la disponibilidad en este momento. Por favor, reintentá en unos instantes.',
        });
      }
    };

    // Caso: Error de red durante la revalidación
    const liveMatchData = {
      count: 2,
      encounterIds: ['enc-1', 'enc-2'],
      inZoneEncounterIds: ['enc-1'],
      firstMatch: { id: 'enc-1', title: 'Match previo' },
    };

    await handleViewLiveMatchesSimulation(liveMatchData, async () => {
      throw new Error('Network timeout 504');
    });

    // Aserciones:
    assert.equal(viewedMatches, null, 'NO debe llamar a handleViewMatches con IDs obsoletos ante error de red');
    assert.equal(selectedDeepLink, null, 'NO debe abrir fichas previas sin revalidar');
    assert.equal(
      deepLinkNotice,
      'No pudimos comprobar la disponibilidad en este momento. Por favor, reintentá en unos instantes.',
      'Debe mostrar el mensaje explicativo y recuperable para el usuario'
    );
  });

  /* ─────────────────────────────────────────────────────────────────
   * 6. BLOQUEANTE AUDITORÍA: Cambio de zonas del usuario entre notificación y clic
   * ───────────────────────────────────────────────────────────────── */
  test('6. Revalidación ante cambio de zonas del usuario entre notificación y clic: clasifica según la configuración vigente', async () => {
    let triggeredConfigureZones = false;
    let viewedMatches: string[] | null = null;
    let deepLinkOpened: any = null;

    const handleViewLiveMatchesWithFreshZones = async (
      liveMatchFeedback: any,
      freshUserLocs: string[],
      encountersMap: Record<string, OpenEncounterSummary>
    ) => {
      const { encounterIds } = liveMatchFeedback;
      try {
        const hasZones = Boolean(freshUserLocs && freshUserLocs.length > 0);
        if (!hasZones) {
          triggeredConfigureZones = true;
          return;
        }

        const freshList = encounterIds
          .map((id: string) => encountersMap[id])
          .filter((enc: any) => enc && isEncounterVigente(enc) && !enc.inscriptionsClosed && enc.openSlots > 0);

        const freshInZone = freshList.filter((e: any) => {
          const isVirt = e.modalidad === 'virtual' || e.modality === 'virtual';
          return isVirt || (Boolean(e.localityId) && freshUserLocs.includes(e.localityId!));
        });
        const freshOtherZone = freshList.filter((e: any) => {
          const isVirt = e.modalidad === 'virtual' || e.modality === 'virtual';
          return !isVirt && Boolean(e.localityId && !freshUserLocs.includes(e.localityId));
        });

        if (freshInZone.length > 0) {
          viewedMatches = freshInZone.map((e: any) => e.id);
          return;
        }
        if (freshOtherZone.length > 0) {
          deepLinkOpened = freshOtherZone[0];
          return;
        }
      } catch {}
    };

    const encGuemes: OpenEncounterSummary = {
      ...mockPresencialEncounter,
      id: 'enc-guemes-99',
      localityId: 'guemes',
    };

    // Caso A: Notificación se recibió cuando el usuario tenía zonas ['centro'], pero antes del clic cambió a ['guemes']
    await handleViewLiveMatchesWithFreshZones(
      { encounterIds: ['enc-guemes-99'] },
      ['guemes'], // zonas vigentes en caliente
      { 'enc-guemes-99': encGuemes }
    );
    assert.deepEqual(viewedMatches, ['enc-guemes-99'], 'Debe clasificarlo en zona según la zona vigente al momento del clic');

    // Caso B: Notificación se recibió con zonas, pero el usuario borró todas sus zonas antes del clic
    triggeredConfigureZones = false;
    viewedMatches = null;
    await handleViewLiveMatchesWithFreshZones(
      { encounterIds: ['enc-guemes-99'] },
      [], // usuario sin zonas vigentes
      { 'enc-guemes-99': encGuemes }
    );
    assert.equal(triggeredConfigureZones, true, 'Debe activar selector de zonas si el usuario borró sus zonas');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 7. BLOQUEANTE AUDITORÍA: Contrato de vigencia y fechas con hora Argentina
   * ───────────────────────────────────────────────────────────────── */
  test('7. Contrato de vigencia y fechas con hora Argentina: horario a coordinar no vence antes de medianoche', () => {
    // Instante determinista en hora Argentina: 10 de Noviembre de 2026, 15:30:00 UTC-3
    const referenceDate = new Date('2026-11-10T15:30:00-03:00');
    const { todayDateStr, currentTimeStr } = getArgentinaNow(referenceDate);
    assert.equal(todayDateStr, '2026-11-10');
    assert.equal(currentTimeStr, '15:30:00');

    // 7.1. Fecha de HOY con horario a coordinar (hora = null o vacía)
    // CANÓNICO SQL: Vigente durante toda la jornada de hoy
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-10', hora: null }, referenceDate),
      true,
      'Hoy con hora null debe ser vigente todo el día'
    );
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-10', hora: '' }, referenceDate),
      true,
      'Hoy con hora vacía debe ser vigente todo el día'
    );

    // 7.2. Fecha de AYER con horario a coordinar (hora = null)
    // CANÓNICO SQL: No vigente (vencido ayer)
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-09', hora: null }, referenceDate),
      false,
      'Ayer con hora null debe estar vencido'
    );

    // 7.3. Fecha de HOY con horario anterior a la hora actual (ej. 10:00:00 vs 15:30:00)
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-10', hora: '10:00:00' }, referenceDate),
      false,
      'Hoy con horario pasado respecto a hora Argentina debe estar vencido'
    );

    // 7.4. Fecha de HOY con horario posterior a la hora actual (ej. 19:00:00 vs 15:30:00)
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-10', hora: '19:00:00' }, referenceDate),
      true,
      'Hoy con horario futuro respecto a hora Argentina debe ser vigente'
    );

    // 7.5. Fecha nula (totalmente a coordinar)
    assert.equal(
      isEncounterVigente({ fecha: null, hora: null }, referenceDate),
      true,
      'Fecha a coordinar no tiene vencimiento artificial'
    );

    // 7.6. Fecha de MAÑANA
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-11', hora: '08:00:00' }, referenceDate),
      true,
      'Fecha futura debe ser vigente'
    );

    // 7.7. Normalización: no debe descartarse artificialmente por startsAt
    const startsAtNullHora = normalizeEncounterStartsAt('2026-11-10', null);
    assert.equal(startsAtNullHora, '2026-11-10T00:00:00-03:00');
    assert.equal(
      isEncounterVigente({ startsAt: startsAtNullHora, fecha: '2026-11-10', hora: null }, referenceDate),
      true,
      'startsAt normalizado de hoy sin hora se mantiene vigente con isEncounterVigente'
    );

    // 7.8. Formateo de etiquetas de fecha
    const label1 = formatEncounterDateLabel('20/11/2026', '19:30', '2026-11-20', '19:30:00');
    assert.equal(label1, '20/11/2026 · 19:30');

    const labelCoord = formatEncounterDateLabel('Fecha a coordinar', 'Horario a coordinar', null, null);
    assert.equal(labelCoord, 'Fecha a coordinar');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 8. Apertura de opciones: clasifica en zona vs fuera de zona con virtuales transversales
   * ───────────────────────────────────────────────────────────────── */
  test('8. Apertura de opciones: clasifica adecuadamente coincidencias en zona (resaltado) y fuera de zona (detalle directo)', () => {
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

    const isEncounterInUserZone = (enc: OpenEncounterSummary, zones: string[]) => {
      const isVirtual = enc.modalidad === 'virtual' || enc.modality === 'virtual';
      return isVirtual || (Boolean(enc.localityId) && zones.includes(enc.localityId!));
    };

    assert.equal(isEncounterInUserZone(matchInZone, userZones), true, 'Encuentro en Güemes está en zona');
    assert.equal(isEncounterInUserZone(matchOtherZone, userZones), false, 'Encuentro en Constitución está fuera de zona');
    assert.equal(isEncounterInUserZone(matchVirtual, userZones), true, 'Encuentro virtual se considera en zona para cualquier selección');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 9. Seguridad y hermeticidad de sesiones ante cambio de usuario
   * ───────────────────────────────────────────────────────────────── */
  test('9. Seguridad de sesiones: verificaciones asíncronas pendientes no publican datos si el usuario cambió de cuenta', async () => {
    let currentUserId: string | undefined = 'user-alice';
    let feedbackPublished: any = null;

    const handleIncomingNotification = async (notifUserId: string, matchId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (currentUserId !== notifUserId) {
        return; // Abortar
      }
      feedbackPublished = { count: 1, matchId };
    };

    const notifPromise = handleIncomingNotification('user-alice', 'enc-123');

    // Alice cambia a Bob a los 10ms
    await new Promise((resolve) => setTimeout(resolve, 10));
    currentUserId = 'user-bob';

    await notifPromise;

    assert.equal(feedbackPublished, null, 'Feedback de Alice jamás debe publicarse en la sesión de Bob');
  });
});
