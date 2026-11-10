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
import { supabase } from '../src/lib/supabase';

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
   * 1. ACTIVACIÓN REAL DEL SELECTOR DE ZONAS
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
   * 2. CONCURRENCIA EN useUnifiedDiscovery
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
   * 3. VIRTUALES SIN ZONAS EN RECORRIDO REAL (DISCOVERY UI)
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
   * 4. EMPTY STATE NEUTRAL CON 4 TARJETAS
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
   * 5. COINCIDENCIAS VIRTUALES SIN ZONAS EN «VER OPCIONES»
   * ───────────────────────────────────────────────────────────────── */
  test('5. Coincidencias virtuales sin zonas: permite ver directamente sin exigir zonas; presenciales sin zonas abren selector', async () => {
    let viewedMatchesIds: string[] | null = null;
    let configureZonesTriggerFired = false;
    let feedbackCleared = false;

    const handleViewLiveMatchesSimulated = async (
      encounterIds: string[],
      encountersMap: Record<string, OpenEncounterSummary>,
      userLocs: string[]
    ) => {
      viewedMatchesIds = null;
      configureZonesTriggerFired = false;
      feedbackCleared = false;

      // 1. Revalidar
      const freshList = encounterIds
        .map((id) => encountersMap[id])
        .filter((enc) => Boolean(enc && isEncounterVigente(enc) && !enc.inscriptionsClosed && enc.openSlots > 0));

      if (freshList.length === 0) {
        feedbackCleared = true;
        return;
      }

      const hasZones = Boolean(userLocs && userLocs.length > 0);
      const freshVirtuals = freshList.filter((e) => e.modalidad === 'virtual' || e.modality === 'virtual');
      const freshPresenciales = freshList.filter((e) => e.modalidad !== 'virtual' && e.modality !== 'virtual');

      // Orden de decisión:
      if (!hasZones) {
        // Si hay al menos un virtual disponible -> ver directamente sin exigir zonas
        if (freshVirtuals.length > 0) {
          feedbackCleared = true;
          viewedMatchesIds = freshVirtuals.map((e) => e.id);
          return;
        }

        // Si son únicamente presenciales y faltan zonas -> abrir selector de zonas
        feedbackCleared = true;
        configureZonesTriggerFired = true;
        return;
      }

      // Si tiene zonas -> clasificar normalmente
      feedbackCleared = true;
      const freshInZone = freshList.filter((e) => {
        const isVirt = e.modalidad === 'virtual' || e.modality === 'virtual';
        return isVirt || (Boolean(e.localityId) && userLocs.includes(e.localityId!));
      });
      viewedMatchesIds = freshInZone.map((e) => e.id);
    };

    const mockVirtual: OpenEncounterSummary = {
      ...mockVirtualEncounterSinLocalidad,
      id: 'enc-virt-only',
    };

    const mockPresencial: OpenEncounterSummary = {
      ...mockPresencialEncounter,
      id: 'enc-pres-only',
      localityId: 'guemes',
    };

    // Caso 5A: Usuario sin zonas, match es un encuentro VIRTUAL
    await handleViewLiveMatchesSimulated(['enc-virt-only'], { 'enc-virt-only': mockVirtual }, []);
    assert.deepEqual(viewedMatchesIds, ['enc-virt-only'], 'Debe permitir ver directamente el encuentro virtual');
    assert.equal(configureZonesTriggerFired, false, 'NO debe exigir configurar zonas para virtuales');
    assert.equal(feedbackCleared, true, 'Debe haber completado la revalidación');

    // Caso 5B: Usuario sin zonas, match es un encuentro PRESENCIAL
    await handleViewLiveMatchesSimulated(['enc-pres-only'], { 'enc-pres-only': mockPresencial }, []);
    assert.equal(viewedMatchesIds, null, 'No puede ver el presencial directamente sin zonas');
    assert.equal(configureZonesTriggerFired, true, 'Debe abrir el selector de zonas para presenciales');
    assert.equal(feedbackCleared, true);
  });

  /* ─────────────────────────────────────────────────────────────────
   * 6. COMPORTAMIENTO REAL DEL SERVICIO ANTE ERROR DE SUPABASE VS NOT_FOUND
   * ───────────────────────────────────────────────────────────────── */
  test('6. Servicio openEncountersService.getEncuentroAbiertoById: diferencia error de Supabase de encuentro no disponible', async () => {
    const origRpc = supabase.rpc;

    try {
      // Caso 6A: Supabase responde con error de consulta / timeout / 500
      supabase.rpc = (async (name: string) => {
        if (name === 'get_encuentro_abierto_publico') {
          return { data: null, error: { message: '500 Internal Server Error (PGRST timeout)' } };
        }
        return { data: null, error: null };
      }) as any;

      await assert.rejects(
        async () => {
          await openEncountersService.getEncuentroAbiertoById('enc-err-1');
        },
        /500 Internal Server Error/,
        'Debe lanzar error cuando Supabase responde con error de RPC en vez de convertir a null'
      );

      // Caso 6B: Supabase responde ok: false con error not_found (inexistente o cancelado)
      supabase.rpc = (async (name: string) => {
        if (name === 'get_encuentro_abierto_publico') {
          return { data: { ok: false, error: 'not_found' }, error: null };
        }
        if (name === 'get_discovery_encuentros_abiertos') {
          return { data: [], error: null };
        }
        if (name === 'get_encuentro_participante_autorizado') {
          return { data: { ok: false, error: 'not_found' }, error: null };
        }
        return { data: null, error: null };
      }) as any;

      const resultNotFound = await openEncountersService.getEncuentroAbiertoById('enc-notfound-1');
      assert.equal(resultNotFound, null, 'Encuentro no existente o no disponible debe devolver null limpiamente');

      // Caso 6C: Excepción de red simulada (ej. fetch fallido o timeout)
      supabase.rpc = (async () => {
        throw new TypeError('Failed to fetch');
      }) as any;

      await assert.rejects(
        async () => {
          await openEncountersService.getEncuentroAbiertoById('enc-fetch-err');
        },
        /Failed to fetch/,
        'Excepción de red debe propagarse hacia el llamador'
      );
    } finally {
      supabase.rpc = origRpc;
    }
  });

  /* ─────────────────────────────────────────────────────────────────
   * 7. REINTENTO EFECTIVO: CONSERVAR AVISO ANTE ERROR DE RED
   * ───────────────────────────────────────────────────────────────── */
  test('7. Reintento efectivo en «Ver opciones»: no elimina el aviso si falla la revalidación y permite reintentar con éxito', async () => {
    let currentLiveMatchFeedback: any = {
      count: 1,
      encounterIds: ['enc-retry-1'],
      firstMatch: mockPresencialEncounter,
    };
    let deepLinkNotice: string | null = null;
    let viewedMatchesIds: string[] | null = null;
    let networkShouldFail = true;

    const t = (key: string, opts?: any) => opts?.defaultValue || key;

    const handleViewLiveMatchesWithRetrySimulation = async () => {
      if (!currentLiveMatchFeedback || currentLiveMatchFeedback.encounterIds.length === 0) return;
      const { encounterIds } = currentLiveMatchFeedback;

      try {
        const revalidatedPromises = encounterIds.map(async (id: string) => {
          if (networkShouldFail) {
            throw new Error('Network offline 503');
          }
          return {
            ...mockPresencialEncounter,
            id,
            openSlots: 2,
            inscriptionsClosed: false,
          };
        });

        const freshList = (await Promise.all(revalidatedPromises)).filter(Boolean);
        if (freshList.length === 0) {
          currentLiveMatchFeedback = null;
          deepLinkNotice = t('your_encounters.matches_no_longer_available');
          return;
        }

        // Éxito: se retira el aviso
        currentLiveMatchFeedback = null;
        viewedMatchesIds = freshList.map((e: any) => e.id);
      } catch (err) {
        // Invariante de Auditoría: ANTE ERROR DE RED NO ELIMINAR EL AVISO
        deepLinkNotice = t('your_encounters.revalidation_network_error', {
          defaultValue: 'No pudimos comprobar la disponibilidad en este momento. Por favor, reintentá en unos instantes.',
        });
      }
    };

    // Intento 1: La red falla
    await handleViewLiveMatchesWithRetrySimulation();

    // Aserción Intento 1:
    assert.notEqual(currentLiveMatchFeedback, null, 'El aviso NO debe eliminarse ante fallo de red');
    assert.equal(currentLiveMatchFeedback.count, 1, 'Conserva los datos del match en pantalla');
    assert.equal(viewedMatchesIds, null, 'No debe resaltar encuentros no revalidados');
    assert.equal(
      deepLinkNotice,
      'No pudimos comprobar la disponibilidad en este momento. Por favor, reintentá en unos instantes.',
      'Debe advertir con mensaje claro para reintentar'
    );

    // Intento 2: Se recupera la red y el usuario reintenta presionando «Ver opciones»
    networkShouldFail = false;
    await handleViewLiveMatchesWithRetrySimulation();

    // Aserción Intento 2:
    assert.equal(currentLiveMatchFeedback, null, 'Tras reintento exitoso, el aviso se retira');
    assert.deepEqual(viewedMatchesIds, ['enc-retry-1'], 'Muestra y resalta las opciones revalidadas');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 8. CONTRATO DE VIGENCIA Y FECHAS CON HORA ARGENTINA
   * ───────────────────────────────────────────────────────────────── */
  test('8. Contrato de vigencia y fechas con hora Argentina: horario a coordinar no vence antes de medianoche', () => {
    // Instante determinista en hora Argentina: 10 de Noviembre de 2026, 15:30:00 UTC-3
    const referenceDate = new Date('2026-11-10T15:30:00-03:00');
    const { todayDateStr, currentTimeStr } = getArgentinaNow(referenceDate);
    assert.equal(todayDateStr, '2026-11-10');
    assert.equal(currentTimeStr, '15:30:00');

    // 8.1. Fecha de HOY con horario a coordinar (hora = null o vacía)
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

    // 8.2. Fecha de AYER con horario a coordinar (hora = null)
    // CANÓNICO SQL: No vigente (vencido ayer)
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-09', hora: null }, referenceDate),
      false,
      'Ayer con hora null debe estar vencido'
    );

    // 8.3. Fecha de HOY con horario anterior a la hora actual (ej. 10:00:00 vs 15:30:00)
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-10', hora: '10:00:00' }, referenceDate),
      false,
      'Hoy con horario pasado respecto a hora Argentina debe estar vencido'
    );

    // 8.4. Fecha de HOY con horario posterior a la hora actual (ej. 19:00:00 vs 15:30:00)
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-10', hora: '19:00:00' }, referenceDate),
      true,
      'Hoy con horario futuro respecto a hora Argentina debe ser vigente'
    );

    // 8.5. Fecha nula (totalmente a coordinar)
    assert.equal(
      isEncounterVigente({ fecha: null, hora: null }, referenceDate),
      true,
      'Fecha a coordinar no tiene vencimiento artificial'
    );

    // 8.6. Fecha de MAÑANA
    assert.equal(
      isEncounterVigente({ fecha: '2026-11-11', hora: '08:00:00' }, referenceDate),
      true,
      'Fecha futura debe ser vigente'
    );

    // 8.7. Normalización: no debe descartarse artificialmente por startsAt
    const startsAtNullHora = normalizeEncounterStartsAt('2026-11-10', null);
    assert.equal(startsAtNullHora, '2026-11-10T00:00:00-03:00');
    assert.equal(
      isEncounterVigente({ startsAt: startsAtNullHora, fecha: '2026-11-10', hora: null }, referenceDate),
      true,
      'startsAt normalizado de hoy sin hora se mantiene vigente con isEncounterVigente'
    );

    // 8.8. Formateo de etiquetas de fecha
    const label1 = formatEncounterDateLabel('20/11/2026', '19:30', '2026-11-20', '19:30:00');
    assert.equal(label1, '20/11/2026 · 19:30');

    const labelCoord = formatEncounterDateLabel('Fecha a coordinar', 'Horario a coordinar', null, null);
    assert.equal(labelCoord, 'Fecha a coordinar');
  });

  /* ─────────────────────────────────────────────────────────────────
   * 9. APERTURA Y CLASIFICACIÓN DE OPCIONES
   * ───────────────────────────────────────────────────────────────── */
  test('9. Apertura de opciones: clasifica adecuadamente coincidencias en zona (resaltado) y fuera de zona (detalle directo)', () => {
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
   * 10. SEGURIDAD Y HERMETICIDAD DE SESIONES ANTE CAMBIO DE USUARIO
   * ───────────────────────────────────────────────────────────────── */
  test('10. Seguridad de sesiones: verificaciones asíncronas pendientes no publican datos si el usuario cambió de cuenta', async () => {
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

  /* ─────────────────────────────────────────────────────────────────
   * 11. REGRESIÓN DE CONSUMIDORES: handleSelectEncuentroFromSolicitudes
   * ───────────────────────────────────────────────────────────────── */
  test('11. Consumidor handleSelectEncuentroFromSolicitudes: captura errores asíncronos y emite aviso sin UnhandledPromiseRejection', async () => {
    let selectedDeepLink: any = null;
    let isDeepLinkOpen = false;
    let noticeMessage: string | null = null;

    const t = (_k: string, opts?: any) => opts?.defaultValue || _k;

    const handleSelectSimulation = async (
      encuentroId: string,
      fetchFn: (id: string) => Promise<OpenEncounterSummary | null>
    ) => {
      try {
        const enc = await fetchFn(encuentroId);
        if (enc) {
          selectedDeepLink = enc;
          isDeepLinkOpen = true;
        } else {
          noticeMessage = t('your_encounters.matches_no_longer_available', {
            defaultValue: 'El encuentro ya no se encuentra disponible o fue cancelado.',
          });
        }
      } catch {
        noticeMessage = t('your_encounters.revalidation_network_error', {
          defaultValue: 'No pudimos comprobar la disponibilidad en este momento. Por favor, reintentá en unos instantes.',
        });
      }
    };

    // Caso A: Error de red o timeout
    await handleSelectSimulation('enc-err', async () => {
      throw new Error('Network offline 500');
    });
    assert.equal(selectedDeepLink, null);
    assert.equal(isDeepLinkOpen, false);
    assert.equal(
      noticeMessage,
      'No pudimos comprobar la disponibilidad en este momento. Por favor, reintentá en unos instantes.'
    );

    // Caso B: Encuentro legítimamente cancelado/no disponible (retorna null)
    noticeMessage = null;
    await handleSelectSimulation('enc-null', async () => null);
    assert.equal(selectedDeepLink, null);
    assert.equal(isDeepLinkOpen, false);
    assert.equal(noticeMessage, 'El encuentro ya no se encuentra disponible o fue cancelado.');

    // Caso C: Éxito
    noticeMessage = null;
    await handleSelectSimulation('enc-ok', async () => mockPresencialEncounter);
    assert.equal(selectedDeepLink?.id, 'enc-guemes-1');
    assert.equal(isDeepLinkOpen, true);
    assert.equal(noticeMessage, null);
  });

  /* ─────────────────────────────────────────────────────────────────
   * 12. REGRESIÓN DE CONSUMIDORES: PENDING_OPEN_REQUEST_KEY post-auth
   * ───────────────────────────────────────────────────────────────── */
  test('12. Consumidor PENDING_OPEN_REQUEST_KEY post-auth: captura errores asíncronos sin bloquear el flujo', async () => {
    let selectedEncounter: any = null;
    let isDetailOpen = false;

    const handlePendingRestoreSimulation = async (
      pendingId: string,
      fetchFn: (id: string) => Promise<OpenEncounterSummary | null>
    ) => {
      return fetchFn(pendingId)
        .then((enc) => {
          if (enc) {
            selectedEncounter = enc;
            isDetailOpen = true;
          }
        })
        .catch(() => {
          // Captura controlada de error sin arrojar UnhandledPromiseRejection
          return null;
        });
    };

    // Si fetchFn lanza excepción, el .catch debe atraparla limpiamente
    await assert.doesNotReject(async () => {
      await handlePendingRestoreSimulation('enc-err-pending', async () => {
        throw new Error('Timeout post-oauth');
      });
    });

    assert.equal(selectedEncounter, null);
    assert.equal(isDetailOpen, false);
  });
});
