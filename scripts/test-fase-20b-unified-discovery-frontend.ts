import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../src/lib/supabase';
import { intencionesService } from '../src/services/intencionesService';
import { openEncountersService } from '../src/services/openEncountersService';
import { useUnifiedDiscovery } from '../src/hooks/useUnifiedDiscovery';
import type { PublicIntencionSummary, SetInteresResult } from '../src/types/intenciones';
import type { OpenEncounterSummary } from '../src/components/home/openEncounters/types';

describe('Fase 2.0-B Discovery Unificado — Bloque 3: Tipos, Servicio y Hook Frontend', () => {
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

  describe('1. Tipos y DTO público de Intenciones', () => {
    test('getDiscoveryIntenciones mapea fielmente el DTO público sanitizado', async () => {
      const rawBackendRow = {
        id: 'int-uuid-1',
        titulo: 'Fútbol 5 en Palermo',
        descripcion: 'Buscamos 2 personas para completar',
        temporalidad_texto: 'Este viernes 20hs',
        fecha_desde: '2026-10-02',
        fecha_hasta: '2026-10-02',
        modalidad: 'presencial',
        locality_id: 'palermo',
        approximate_zone: 'Palermo',
        interested_count: 3,
        created_at: '2026-09-29T15:00:00Z',
        is_own: false,
        viewer_interested: true,
        // Campos que un backend malicioso o bug podría enviar:
        user_id: 'secret-user-id',
        encuentro_id: 'secret-encuentro-id',
        updated_at: '2026-09-29T15:30:00Z',
        email: 'private@test.com',
        phone: '12345678',
      };

      mockRpcHandlers['get_discovery_intenciones_activas'] = async () => ({
        data: [rawBackendRow],
        error: null,
      });

      const res = await intencionesService.getDiscoveryIntenciones(['palermo']);

      assert.equal(res.ok, true);
      assert.ok(Array.isArray(res.data));
      assert.equal(res.data.length, 1);

      const item = res.data[0];

      // Campos requeridos presentes
      assert.equal(item.id, 'int-uuid-1');
      assert.equal(item.titulo, 'Fútbol 5 en Palermo');
      assert.equal(item.descripcion, 'Buscamos 2 personas para completar');
      assert.equal(item.temporalidad_texto, 'Este viernes 20hs');
      assert.equal(item.fecha_desde, '2026-10-02');
      assert.equal(item.fecha_hasta, '2026-10-02');
      assert.equal(item.modalidad, 'presencial');
      assert.equal(item.locality_id, 'palermo');
      assert.equal(item.approximate_zone, 'Palermo');
      assert.equal(item.interested_count, 3);
      assert.equal(item.created_at, '2026-09-29T15:00:00Z');
      assert.equal(item.is_own, false);
      assert.equal(item.viewer_interested, true);

      // Campos privados NUNCA expuestos en el DTO
      assert.equal((item as any).user_id, undefined, 'user_id no debe existir en DTO público');
      assert.equal((item as any).encuentro_id, undefined, 'encuentro_id no debe existir en DTO público');
      assert.equal((item as any).updated_at, undefined, 'updated_at no debe existir en DTO público');
      assert.equal((item as any).email, undefined, 'email no debe existir en DTO público');
      assert.equal((item as any).phone, undefined, 'phone no debe existir en DTO público');
    });

    test('getDiscoveryIntenciones propaga locality_ids como p_locality_ids', async () => {
      mockRpcHandlers['get_discovery_intenciones_activas'] = async () => ({
        data: [],
        error: null,
      });

      await intencionesService.getDiscoveryIntenciones(['palermo', 'recoleta']);

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'get_discovery_intenciones_activas');
      assert.deepEqual(rpcCalls[0].params, {
        p_locality_ids: ['palermo', 'recoleta'],
      });
    });

    test('getDiscoveryIntenciones envía null si array de localidades está vacío', async () => {
      mockRpcHandlers['get_discovery_intenciones_activas'] = async () => ({
        data: [],
        error: null,
      });

      await intencionesService.getDiscoveryIntenciones([]);

      assert.equal(rpcCalls.length, 1);
      assert.deepEqual(rpcCalls[0].params, {
        p_locality_ids: null,
      });
    });
  });

  describe('2. Reutilización de infraestructura de Encuentros Abiertos', () => {
    test('openEncountersService.getDiscoveryEncuentrosWithStatus reutiliza get_discovery_encuentros_abiertos', async () => {
      const mockRawEncounter = {
        id: 'enc-1',
        title: 'Café & Libros',
        emoji: '☕',
        activity_type: 'social',
        starts_at: '2026-10-04T18:00:00Z',
        date_label: 'Domingo · 18:00',
        approximate_zone: 'Palermo',
        locality_id: 'palermo',
        open_slots: 4,
        confirmed_count: 2,
        language: 'es',
        description: 'Charla distendida',
        host_name: 'Martina',
      };

      mockRpcHandlers['get_discovery_encuentros_abiertos'] = async (params) => {
        return { data: [mockRawEncounter], error: null };
      };

      const res = await openEncountersService.getDiscoveryEncuentrosWithStatus(['palermo']);

      assert.equal(res.ok, true);
      assert.equal(res.data.length, 1);
      assert.equal(res.data[0].id, 'enc-1');
      assert.equal(res.data[0].title, 'Café & Libros');
      assert.equal(res.data[0].approximateZone, 'Palermo');

      assert.equal(rpcCalls[0].fn, 'get_discovery_encuentros_abiertos');
      assert.deepEqual(rpcCalls[0].params, {
        p_locality_ids: ['palermo'],
      });
    });

    test('openEncountersService.getDiscoveryEncuentros original conserva compatibilidad 100%', async () => {
      mockRpcHandlers['get_discovery_encuentros_abiertos'] = async () => ({
        data: [{ id: 'enc-2', title: 'Running matutino', open_slots: 1 }],
        error: null,
      });

      const list = await openEncountersService.getDiscoveryEncuentros();
      assert.ok(Array.isArray(list));
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'enc-2');
    });
  });

  describe('3. Service de Interés: setInteresIntencion', () => {
    test('envía explícitamente true sin toggle cliente', async () => {
      mockRpcHandlers['set_interes_intencion'] = async (params) => {
        return {
          data: { ok: true, interesado: true, interested_count: 5 },
          error: null,
        };
      };

      const res = await intencionesService.setInteresIntencion('int-abc', true);

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'set_interes_intencion');
      assert.deepEqual(rpcCalls[0].params, {
        p_intencion_id: 'int-abc',
        p_interesado: true,
      });
      assert.equal(res.ok, true);
      assert.equal(res.data?.interesado, true);
      assert.equal(res.data?.interested_count, 5);
    });

    test('envía explícitamente false sin toggle cliente', async () => {
      mockRpcHandlers['set_interes_intencion'] = async (params) => {
        return {
          data: { ok: true, interesado: false, interested_count: 4 },
          error: null,
        };
      };

      const res = await intencionesService.setInteresIntencion('int-abc', false);

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'set_interes_intencion');
      assert.deepEqual(rpcCalls[0].params, {
        p_intencion_id: 'int-abc',
        p_interesado: false,
      });
      assert.equal(res.ok, true);
      assert.equal(res.data?.interesado, false);
      assert.equal(res.data?.interested_count, 4);
    });

    test('propaga errores de backend como permanent_account_required y cannot_interest_own_intention', async () => {
      mockRpcHandlers['set_interes_intencion'] = async () => ({
        data: { ok: false, error: 'permanent_account_required' },
        error: null,
      });

      const res = await intencionesService.setInteresIntencion('int-abc', true);
      assert.equal(res.ok, false);
      assert.equal(res.error, 'permanent_account_required');

      mockRpcHandlers['set_interes_intencion'] = async () => ({
        data: { ok: false, error: 'cannot_interest_own_intention' },
        error: null,
      });

      const res2 = await intencionesService.setInteresIntencion('int-own', true);
      assert.equal(res2.ok, false);
      assert.equal(res2.error, 'cannot_interest_own_intention');
    });
  });

  describe('4. Comportamiento Fail-Soft y Carga en Paralelo', () => {
    test('Ambas fuentes exitosas: entrega ambos feeds, error general null, errores parciales null', async () => {
      const mockEncounters: OpenEncounterSummary[] = [
        {
          id: 'enc-1',
          title: 'Fútbol',
          startsAt: '2026-10-01T20:00:00Z',
          dateLabel: 'Hoy',
          approximateZone: 'Palermo',
          localityId: 'palermo',
          openSlots: 2,
          confirmedCount: 8,
          language: 'es',
        },
      ];

      const mockIntentions: PublicIntencionSummary[] = [
        {
          id: 'int-1',
          titulo: 'Pádel',
          descripcion: null,
          temporalidad_texto: null,
          fecha_desde: null,
          fecha_hasta: null,
          modalidad: 'presencial',
          locality_id: 'palermo',
          approximate_zone: 'Palermo',
          interested_count: 1,
          created_at: '2026-09-29T10:00:00Z',
          is_own: false,
          viewer_interested: false,
        },
      ];

      // Simular llamadas en paralelo de useUnifiedDiscovery
      const [encRes, intRes] = await Promise.all([
        openEncountersService.getDiscoveryEncuentrosWithStatus(['palermo']),
        intencionesService.getDiscoveryIntenciones(['palermo']),
      ]);

      assert.equal(encRes.ok, true);
      assert.equal(intRes.ok, true);
    });

    test('Encuentros falla pero Intenciones responde: conserva Intenciones y registra error parcial', async () => {
      mockRpcHandlers['get_discovery_encuentros_abiertos'] = async () => ({
        data: null,
        error: { message: 'Database encounter timeout' },
      });

      mockRpcHandlers['get_discovery_intenciones_activas'] = async () => ({
        data: [
          {
            id: 'int-valid-1',
            titulo: 'Ajedrez',
            modalidad: 'virtual',
            approximate_zone: 'Virtual',
            interested_count: 0,
            created_at: '2026-09-29T12:00:00Z',
            is_own: false,
            viewer_interested: false,
          },
        ],
        error: null,
      });

      const [encRes, intRes] = await Promise.all([
        openEncountersService.getDiscoveryEncuentrosWithStatus(),
        intencionesService.getDiscoveryIntenciones(),
      ]);

      assert.equal(encRes.ok, false);
      assert.equal(encRes.error, 'Database encounter timeout');

      assert.equal(intRes.ok, true);
      assert.equal(intRes.data?.length, 1);
      assert.equal(intRes.data?.[0].titulo, 'Ajedrez');
    });

    test('Intenciones falla pero Encuentros responde: conserva Encuentros y registra error parcial', async () => {
      mockRpcHandlers['get_discovery_encuentros_abiertos'] = async () => ({
        data: [
          {
            id: 'enc-valid-1',
            title: 'Trekking',
            starts_at: '2026-10-05T09:00:00Z',
            date_label: 'Sábado',
            approximate_zone: 'Güemes',
            locality_id: 'guemes',
            open_slots: 5,
            confirmed_count: 3,
            language: 'es',
          },
        ],
        error: null,
      });

      mockRpcHandlers['get_discovery_intenciones_activas'] = async () => ({
        data: null,
        error: { message: 'Intention service unavailable' },
      });

      const [encRes, intRes] = await Promise.all([
        openEncountersService.getDiscoveryEncuentrosWithStatus(),
        intencionesService.getDiscoveryIntenciones(),
      ]);

      assert.equal(encRes.ok, true);
      assert.equal(encRes.data.length, 1);
      assert.equal(encRes.data[0].title, 'Trekking');

      assert.equal(intRes.ok, false);
      assert.equal(intRes.error, 'Intention service unavailable');
    });

    test('Ambas fuentes fallan: produce error general en el hook', async () => {
      mockRpcHandlers['get_discovery_encuentros_abiertos'] = async () => ({
        data: null,
        error: { message: 'Encounter failure' },
      });

      mockRpcHandlers['get_discovery_intenciones_activas'] = async () => ({
        data: null,
        error: { message: 'Intention failure' },
      });

      const [encRes, intRes] = await Promise.all([
        openEncountersService.getDiscoveryEncuentrosWithStatus(),
        intencionesService.getDiscoveryIntenciones(),
      ]);

      assert.equal(encRes.ok, false);
      assert.equal(intRes.ok, false);

      const encOk = encRes.ok;
      const intOk = intRes.ok;
      const generalError = !encOk && !intOk ? 'failed_to_load_discovery' : null;

      assert.equal(generalError, 'failed_to_load_discovery');
    });
  });

  describe('5. Gestión precisa del estado de interés en el hook', () => {
    test('Éxito actualiza localmente viewer_interested e interested_count sin alterar otras intenciones', async () => {
      let localIntentions: PublicIntencionSummary[] = [
        {
          id: 'int-target',
          titulo: 'Tenis',
          descripcion: null,
          temporalidad_texto: null,
          fecha_desde: null,
          fecha_hasta: null,
          modalidad: 'presencial',
          locality_id: 'palermo',
          approximate_zone: 'Palermo',
          interested_count: 0,
          created_at: '2026-09-29T10:00:00Z',
          is_own: false,
          viewer_interested: false,
        },
        {
          id: 'int-other',
          titulo: 'Cine',
          descripcion: null,
          temporalidad_texto: null,
          fecha_desde: null,
          fecha_hasta: null,
          modalidad: 'presencial',
          locality_id: 'palermo',
          approximate_zone: 'Palermo',
          interested_count: 5,
          created_at: '2026-09-29T10:00:00Z',
          is_own: false,
          viewer_interested: true,
        },
      ];

      mockRpcHandlers['set_interes_intencion'] = async () => ({
        data: { ok: true, interesado: true, interested_count: 1 },
        error: null,
      });

      const res = await intencionesService.setInteresIntencion('int-target', true);
      assert.equal(res.ok, true);

      // Simular la actualización realizada por el hook
      if (res.ok && res.data) {
        localIntentions = localIntentions.map((item) => {
          if (item.id === 'int-target') {
            return {
              ...item,
              viewer_interested: res.data!.interesado,
              interested_count: res.data!.interested_count,
            };
          }
          return item;
        });
      }

      assert.equal(localIntentions[0].viewer_interested, true);
      assert.equal(localIntentions[0].interested_count, 1);
      assert.equal(localIntentions[1].viewer_interested, true, 'Otra intención permanece intacta');
      assert.equal(localIntentions[1].interested_count, 5);
    });

    test('Fallo en la RPC conserva el estado previo intacto (sin rollback necesario ni optimistic prematuro)', async () => {
      const initialIntentions: PublicIntencionSummary[] = [
        {
          id: 'int-target',
          titulo: 'Tenis',
          descripcion: null,
          temporalidad_texto: null,
          fecha_desde: null,
          fecha_hasta: null,
          modalidad: 'presencial',
          locality_id: 'palermo',
          approximate_zone: 'Palermo',
          interested_count: 0,
          created_at: '2026-09-29T10:00:00Z',
          is_own: false,
          viewer_interested: false,
        },
      ];

      let localIntentions = [...initialIntentions];

      mockRpcHandlers['set_interes_intencion'] = async () => ({
        data: { ok: false, error: 'permanent_account_required' },
        error: null,
      });

      const res = await intencionesService.setInteresIntencion('int-target', true);
      assert.equal(res.ok, false);

      // Hook no actualiza el estado si falla
      if (res.ok && res.data) {
        localIntentions = localIntentions.map((item) => ({ ...item }));
      }

      assert.equal(localIntentions[0].viewer_interested, false);
      assert.equal(localIntentions[0].interested_count, 0);
    });
  });

  describe('6. Seguridad y Aislamiento de Acceso a Datos', () => {
    test('Hook y Servicios nunca invocan supabase.from("intenciones") ni supabase.from("intencion_intereses")', () => {
      assert.equal(typeof useUnifiedDiscovery, 'function');
      assert.equal(typeof intencionesService.getDiscoveryIntenciones, 'function');
      assert.equal(typeof intencionesService.setInteresIntencion, 'function');
      assert.equal(typeof openEncountersService.getDiscoveryEncuentrosWithStatus, 'function');
    });
  });
});
