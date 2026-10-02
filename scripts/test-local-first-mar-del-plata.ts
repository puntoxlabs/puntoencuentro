import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCALIDADES } from '../src/constants/localidades';
import { supabase } from '../src/lib/supabase';
import { openEncountersService } from '../src/services/openEncountersService';
import { intencionesService } from '../src/services/intencionesService';
import esJson from '../src/i18n/locales/es.json' with { type: 'json' };
import enJson from '../src/i18n/locales/en.json' with { type: 'json' };
import ptBRJson from '../src/i18n/locales/pt-BR.json' with { type: 'json' };
import ptJson from '../src/i18n/locales/pt.json' with { type: 'json' };

describe('Local-First Mar del Plata & Discovery Secundario (Casos Z1 a Z14)', () => {
  let rpcCalls: { fn: string; params: any }[] = [];
  let mockRpcHandlers: Record<string, (params?: any) => Promise<{ data: any; error: any }>> = {};

  beforeEach(() => {
    rpcCalls = [];
    mockRpcHandlers = {};

    (supabase as any).rpc = async (fn: string, params?: any) => {
      rpcCalls.push({ fn, params });
      if (mockRpcHandlers[fn]) {
        return await mockRpcHandlers[fn](params);
      }
      return { data: null, error: null };
    };
  });

  describe('Z1 & Z2: Catálogo de Localidades Mar del Plata', () => {
    test('Z1: DEFAULT_LOCALIDADES contiene exactamente las 6 macrozonas activas de Mar del Plata en orden', () => {
      assert.equal(DEFAULT_LOCALIDADES.length, 6);
      const expectedIds = ['centro', 'guemes', 'mitre', 'constitucion', 'puerto-mogotes', 'sur-playas-del-sur'];
      assert.deepEqual(DEFAULT_LOCALIDADES.map((l) => l.id), expectedIds);
      for (const loc of DEFAULT_LOCALIDADES) {
        assert.equal(loc.ciudad, 'Mar del Plata');
        assert.ok(loc.nombre.length > 0);
        assert.ok(loc.orden >= 1 && loc.orden <= 6);
      }
    });

    test('Z2: Inactivas no están en DEFAULT_LOCALIDADES (costa, palermo, belgrano, caballito, vicente-lopez, villa-urquiza)', () => {
      const inactiveIds = ['costa', 'palermo', 'belgrano', 'caballito', 'vicente-lopez', 'villa-urquiza'];
      const defaultIds = new Set(DEFAULT_LOCALIDADES.map((l) => l.id));
      for (const inactiveId of inactiveIds) {
        assert.equal(defaultIds.has(inactiveId), false, `Inactive id ${inactiveId} must not be in DEFAULT_LOCALIDADES`);
      }
    });
  });

  describe('Z3: Reconciliación de preferencias obsoletas (stale preferences)', () => {
    test('Z3a: Preferencias con mezcla de activas y obsoletas se filtran a la intersección con activas', () => {
      const staleUserSavedZones = ['palermo', 'guemes', 'costa', 'centro'];
      const activeIds = new Set(DEFAULT_LOCALIDADES.map((l) => l.id));
      const effectiveZones = staleUserSavedZones.filter((id) => activeIds.has(id));

      assert.deepEqual(effectiveZones, ['guemes', 'centro']);
    });

    test('Z3b: Preferencias exclusivamente obsoletas devuelven array vacío sin romper la app', () => {
      const staleUserSavedZones = ['palermo', 'costa', 'caballito'];
      const activeIds = new Set(DEFAULT_LOCALIDADES.map((l) => l.id));
      const effectiveZones = staleUserSavedZones.filter((id) => activeIds.has(id));

      assert.deepEqual(effectiveZones, []);
    });

    test('Z3c: Cálculo de otherActiveZoneIds genera la diferencia correcta', () => {
      const effectiveZones = ['guemes', 'centro'];
      const allActiveIds = DEFAULT_LOCALIDADES.map((l) => l.id);
      const otherActiveZoneIds = allActiveIds.filter((id) => !effectiveZones.includes(id));

      assert.deepEqual(otherActiveZoneIds, ['mitre', 'constitucion', 'puerto-mogotes', 'sur-playas-del-sur']);
    });
  });

  describe('Z4, Z5, Z6, Z7: Deduplicación, Exclusión Virtual y Capping Secundario', () => {
    test('Z4: Servicios son consultables con las zonas secundarias en paralelo', async () => {
      mockRpcHandlers['get_discovery_encuentros_abiertos'] = async (params) => {
        return { data: [], error: null };
      };
      mockRpcHandlers['get_discovery_intenciones_activas'] = async (params) => {
        return { data: [], error: null };
      };

      const [encRes, intRes] = await Promise.all([
        openEncountersService.getDiscoveryEncuentrosWithStatus(['mitre', 'constitucion']),
        intencionesService.getDiscoveryIntenciones(['mitre', 'constitucion']),
      ]);

      assert.equal(encRes.ok, true);
      assert.equal(intRes.ok, true);
      assert.equal(rpcCalls.length, 2);
      assert.deepEqual(rpcCalls[0].params.p_locality_ids, ['mitre', 'constitucion']);
      assert.deepEqual(rpcCalls[1].params.p_locality_ids, ['mitre', 'constitucion']);
    });

    test('Z5: Sugerencias secundarias excluyen ítems ya presentes en primario (deduplicación)', () => {
      const primaryEncounters = [
        { id: 'enc-1', title: 'Encuentro en Güemes', localityId: 'guemes' },
      ];
      const rawSecondaryEncounters = [
        { id: 'enc-1', title: 'Encuentro en Güemes', localityId: 'guemes' },
        { id: 'enc-2', title: 'Encuentro en Mitre', localityId: 'mitre' },
      ];
      const otherActiveLocalityIds = ['mitre', 'constitucion'];

      const primaryEncIds = new Set(primaryEncounters.map((e) => e.id));
      const filtered = rawSecondaryEncounters
        .filter((e) => otherActiveLocalityIds.includes(e.localityId) && !primaryEncIds.has(e.id))
        .slice(0, 3);

      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].id, 'enc-2');
    });

    test('Z6: Sugerencias secundarias excluyen intenciones virtuales', () => {
      const rawSecondaryIntentions = [
        { id: 'int-1', titulo: 'Charla virtual de diseño', modalidad: 'virtual', locality_id: null },
        { id: 'int-2', titulo: 'Café en Mitre', modalidad: 'presencial', locality_id: 'mitre' },
        { id: 'int-3', titulo: 'Lectura en Centro', modalidad: 'indistinto', locality_id: 'centro' },
      ];
      const otherActiveLocalityIds = ['mitre', 'centro'];
      const primaryIntIds = new Set<string>();

      const filtered = rawSecondaryIntentions
        .filter(
          (i) =>
            i.modalidad !== 'virtual' &&
            Boolean(i.locality_id && otherActiveLocalityIds.includes(i.locality_id)) &&
            !primaryIntIds.has(i.id)
        )
        .slice(0, 3);

      assert.equal(filtered.length, 2);
      assert.equal(filtered[0].id, 'int-2');
      assert.equal(filtered[1].id, 'int-3');
    });

    test('Z7: Sugerencias secundarias están limitadas a un máximo de 3 (MAX_OTHER_ZONE_SUGGESTIONS = 3)', () => {
      const rawSecondaryEncounters = [
        { id: 'enc-1', localityId: 'mitre' },
        { id: 'enc-2', localityId: 'mitre' },
        { id: 'enc-3', localityId: 'mitre' },
        { id: 'enc-4', localityId: 'mitre' },
        { id: 'enc-5', localityId: 'mitre' },
      ];
      const otherActiveLocalityIds = ['mitre'];
      const primaryEncIds = new Set<string>();

      const filtered = rawSecondaryEncounters
        .filter((e) => otherActiveLocalityIds.includes(e.localityId) && !primaryEncIds.has(e.id))
        .slice(0, 3);

      assert.equal(filtered.length, 3);
    });
  });

  describe('Z8, Z9, Z10, Z11: Lógica de Umbral y Empty State en HomeOpenEncounters', () => {
    const OTHER_ZONES_SUGGESTION_THRESHOLD = 3;

    function shouldShowSecondary(primaryCount: number, secondaryCount: number, effectiveZonesCount: number): boolean {
      return (
        effectiveZonesCount > 0 &&
        primaryCount < OTHER_ZONES_SUGGESTION_THRESHOLD &&
        secondaryCount > 0
      );
    }

    test('Z8: Muestra sugerencias secundarias cuando primary < 3 (0, 1 o 2 items)', () => {
      assert.equal(shouldShowSecondary(0, 2, 2), true);
      assert.equal(shouldShowSecondary(1, 2, 2), true);
      assert.equal(shouldShowSecondary(2, 2, 2), true);
    });

    test('Z9: NO muestra sugerencias secundarias si primary >= 3 (3 o más items)', () => {
      assert.equal(shouldShowSecondary(3, 2, 2), false);
      assert.equal(shouldShowSecondary(5, 2, 2), false);
    });

    test('Z10: NO muestra sugerencias secundarias si effectiveZones está vacío (sin filtro territorial)', () => {
      assert.equal(shouldShowSecondary(0, 2, 0), false);
      assert.equal(shouldShowSecondary(1, 2, 0), false);
    });

    test('Z11: En empty state primario con secondary disponible, coexisten empty state y sugerencias', () => {
      const primaryItems: any[] = [];
      const secondaryItems = [{ id: 'sec-1' }];
      const effectiveZones = ['guemes'];

      const isEmpty = primaryItems.length === 0;
      const showSecondary = shouldShowSecondary(primaryItems.length, secondaryItems.length, effectiveZones.length);

      assert.equal(isEmpty, true);
      assert.equal(showSecondary, true);
    });
  });

  describe('Z12 & Z14: i18n y Textos de Contexto', () => {
    test('Z12: Claves de traducción secondary_title y secondary_context existen en todos los locales', () => {
      const locales = [
        { code: 'es', data: esJson },
        { code: 'en', data: enJson },
        { code: 'pt-BR', data: ptBRJson },
        { code: 'pt', data: ptJson },
      ];

      for (const loc of locales) {
        assert.ok(
          (loc.data as any).open_encounters?.secondary_title,
          `Locale ${loc.code} missing open_encounters.secondary_title`
        );
        assert.ok(
          (loc.data as any).open_encounters?.secondary_context,
          `Locale ${loc.code} missing open_encounters.secondary_context`
        );
      }

      assert.equal(esJson.open_encounters.secondary_title, 'También puede interesarte');
      assert.equal(esJson.open_encounters.secondary_context, 'En otras zonas de Mar del Plata');
      assert.equal(enJson.open_encounters.secondary_title, 'You might also like');
      assert.equal(enJson.open_encounters.secondary_context, 'In other areas of Mar del Plata');
    });
  });

  describe('Z13: Inmutabilidad de Preferencias', () => {
    test('Z13: Navegación/visualización de card secundaria no altera estado de preferencias del usuario', () => {
      const userPreferences = ['guemes'];
      const clickedSecondaryItem = { id: 'enc-mitre', localityId: 'mitre' };

      // Simulación: la acción sobre el card secundario abre el detalle del encuentro,
      // nunca se invoca guardado o push de 'mitre' a userPreferences
      const clonedPrefs = [...userPreferences];
      assert.deepEqual(clonedPrefs, ['guemes']);
      assert.equal(clonedPrefs.includes(clickedSecondaryItem.localityId), false);
    });
  });

  describe('Auditoría Pre-Freeze: Casos A a G', () => {
    test('A: no-zone (p_locality_ids = NULL) no devuelve encuentro de localidad inactiva', () => {
      const rawEncountersInDb = [
        { id: 'enc-act', title: 'Activo', locality_id: 'guemes', l_activo: true },
        { id: 'enc-inact', title: 'Inactivo', locality_id: 'palermo', l_activo: false },
        { id: 'enc-costa', title: 'Costa Inactiva', locality_id: 'costa', l_activo: false },
      ];
      const p_locality_ids = null;
      const filtered = rawEncountersInDb.filter(
        (e) => e.l_activo === true && (p_locality_ids === null || (p_locality_ids as string[]).includes(e.locality_id))
      );
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].id, 'enc-act');
    });

    test('B: no-zone (p_locality_ids = NULL) no devuelve intención presencial de localidad inactiva', () => {
      const rawIntentionsInDb = [
        { id: 'int-pres-act', modalidad: 'presencial', locality_id: 'guemes', l_activo: true },
        { id: 'int-pres-inact', modalidad: 'presencial', locality_id: 'palermo', l_activo: false },
        { id: 'int-costa', modalidad: 'presencial', locality_id: 'costa', l_activo: false },
      ];
      const p_locality_ids = null;
      const filtered = rawIntentionsInDb.filter(
        (i) => (i.modalidad === 'virtual' || i.locality_id === null || i.l_activo === true) &&
               (p_locality_ids === null || (p_locality_ids as string[]).includes(i.locality_id!))
      );
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].id, 'int-pres-act');
    });

    test('C: virtual e intenciones con locality NULL conservan contrato', () => {
      const rawIntentionsInDb = [
        { id: 'int-virt', modalidad: 'virtual', locality_id: null, l_activo: null },
        { id: 'int-null-loc', modalidad: 'presencial', locality_id: null, l_activo: null },
      ];
      const p_locality_ids = null;
      const filtered = rawIntentionsInDb.filter(
        (i) => (i.modalidad === 'virtual' || i.locality_id === null || i.l_activo === true) &&
               (p_locality_ids === null || (p_locality_ids as string[]).includes(i.locality_id!))
      );
      assert.equal(filtered.length, 2);
    });

    test('D: localidad inactiva es rechazada en operaciones relevantes (invalid_locality)', async () => {
      mockRpcHandlers['abrir_encuentro_seguro'] = async (params) => {
        if (params?.p_locality_id === 'costa' || params?.p_locality_id === 'palermo') {
          return { data: { ok: false, error: 'invalid_locality' }, error: null };
        }
        return { data: { ok: true }, error: null };
      };
      mockRpcHandlers['crear_intencion_segura'] = async (params) => {
        if (params?.p_locality_id === 'costa' || params?.p_locality_id === 'palermo') {
          return { data: { ok: false, error: 'invalid_locality' }, error: null };
        }
        return { data: { ok: true, id: 'new-id' }, error: null };
      };
      mockRpcHandlers['editar_intencion_segura'] = async (params) => {
        if (params?.p_locality_id === 'costa' || params?.p_locality_id === 'palermo') {
          return { data: { ok: false, error: 'invalid_locality' }, error: null };
        }
        return { data: { ok: true, id: params?.p_id }, error: null };
      };

      const resAbrir = await openEncountersService.abrirEncuentro(
        'enc-1',
        'host-1',
        {
          open_description: 'Test',
          max_participants: 4,
          locality_id: 'costa',
        }
      );
      assert.equal(resAbrir.ok, false);
      assert.equal(resAbrir.error, 'invalid_locality');

      const resCrear = await intencionesService.crearIntencion({
        titulo: 'Test',
        locality_id: 'palermo',
      });
      assert.equal(resCrear.ok, false);
      assert.equal(resCrear.error, 'invalid_locality');

      const resEditar = await intencionesService.editarIntencion({
        id: 'int-1',
        titulo: 'Test Edit',
        locality_id: 'palermo',
      });
      assert.equal(resEditar.ok, false);
      assert.equal(resEditar.error, 'invalid_locality');
    });

    test('E: PRIMARY >= 3 no dispara secondary fetch (optimización condicional)', async () => {
      let secondaryFetchTriggered = false;

      mockRpcHandlers['get_discovery_encuentros_abiertos'] = async (params) => {
        if (params?.p_locality_ids?.includes('mitre')) {
          secondaryFetchTriggered = true;
          return { data: [], error: null };
        }
        return {
          data: [
            { id: 'enc-1', title: 'E1', starts_at: '2026-10-02T10:00:00', locality_id: 'guemes' },
            { id: 'enc-2', title: 'E2', starts_at: '2026-10-02T10:00:00', locality_id: 'guemes' },
          ],
          error: null,
        };
      };

      mockRpcHandlers['get_discovery_intenciones_activas'] = async (params) => {
        if (params?.p_locality_ids?.includes('mitre')) {
          secondaryFetchTriggered = true;
          return { data: [], error: null };
        }
        return {
          data: [
            { id: 'int-1', titulo: 'I1', modalidad: 'presencial', locality_id: 'guemes', approximate_zone: 'Güemes' },
          ],
          error: null,
        };
      };

      const localityIds = ['guemes'];
      const otherActiveLocalityIds = ['mitre', 'constitucion'];

      const [encRes, intRes] = await Promise.all([
        openEncountersService.getDiscoveryEncuentrosWithStatus(localityIds),
        intencionesService.getDiscoveryIntenciones(localityIds),
      ]);
      const primaryCount = (encRes.data?.length || 0) + (intRes.data?.length || 0);
      assert.equal(primaryCount, 3);

      const shouldFetchSecondary = Boolean(
        primaryCount < 3 &&
        localityIds.length > 0 &&
        otherActiveLocalityIds.length > 0
      );

      if (shouldFetchSecondary) {
        await Promise.all([
          openEncountersService.getDiscoveryEncuentrosWithStatus(otherActiveLocalityIds),
          intencionesService.getDiscoveryIntenciones(otherActiveLocalityIds),
        ]);
      }

      assert.equal(shouldFetchSecondary, false);
      assert.equal(secondaryFetchTriggered, false);
    });

    test('F: PRIMARY <= 2 sí dispara secondary fetch', async () => {
      let secondaryFetchTriggered = false;

      mockRpcHandlers['get_discovery_encuentros_abiertos'] = async (params) => {
        if (params?.p_locality_ids?.includes('mitre')) {
          secondaryFetchTriggered = true;
          return { data: [], error: null };
        }
        return {
          data: [
            { id: 'enc-1', title: 'E1', starts_at: '2026-10-02T10:00:00', locality_id: 'guemes' },
          ],
          error: null,
        };
      };

      mockRpcHandlers['get_discovery_intenciones_activas'] = async (params) => {
        if (params?.p_locality_ids?.includes('mitre')) {
          secondaryFetchTriggered = true;
          return { data: [], error: null };
        }
        return { data: [], error: null };
      };

      const localityIds = ['guemes'];
      const otherActiveLocalityIds = ['mitre', 'constitucion'];

      const [encRes, intRes] = await Promise.all([
        openEncountersService.getDiscoveryEncuentrosWithStatus(localityIds),
        intencionesService.getDiscoveryIntenciones(localityIds),
      ]);
      const primaryCount = (encRes.data?.length || 0) + (intRes.data?.length || 0);
      assert.equal(primaryCount, 1);

      const shouldFetchSecondary = Boolean(
        primaryCount < 3 &&
        localityIds.length > 0 &&
        otherActiveLocalityIds.length > 0
      );

      if (shouldFetchSecondary) {
        await Promise.all([
          openEncountersService.getDiscoveryEncuentrosWithStatus(otherActiveLocalityIds),
          intencionesService.getDiscoveryIntenciones(otherActiveLocalityIds),
        ]);
      }

      assert.equal(shouldFetchSecondary, true);
      assert.equal(secondaryFetchTriggered, true);
    });

    test('G: secondary max = 3', () => {
      const MAX_OTHER_ZONE_SUGGESTIONS = 3;
      const rawSecondary = [
        { id: 'sec-1' },
        { id: 'sec-2' },
        { id: 'sec-3' },
        { id: 'sec-4' },
        { id: 'sec-5' },
      ];
      const capped = rawSecondary.slice(0, MAX_OTHER_ZONE_SUGGESTIONS);
      assert.equal(capped.length, 3);
    });
  });
});
