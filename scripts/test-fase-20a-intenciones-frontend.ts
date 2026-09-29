import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../src/lib/supabase';
import { intencionesService } from '../src/services/intencionesService';
import { useIntenciones } from '../src/hooks/useIntenciones';
import type {
  CrearIntencionPayload,
  EditarIntencionPayload,
  Intencion,
} from '../src/types/intenciones';

describe('Fase 2.0-A — Intenciones: Frontend Types & Service', () => {
  let rpcCalls: { fn: string; params: any }[] = [];
  let mockRpcResponse: { data: any; error: any } = { data: null, error: null };

  beforeEach(() => {
    rpcCalls = [];
    mockRpcResponse = { data: null, error: null };

    // Intercept supabase.rpc
    (supabase as any).rpc = async (fn: string, params?: any) => {
      rpcCalls.push({ fn, params });
      if (mockRpcResponse.error instanceof Error && !(mockRpcResponse.error as any).message) {
        throw mockRpcResponse.error;
      }
      return mockRpcResponse;
    };
  });

  describe('1. Mapeo correcto de respuestas RPC hacia tipos frontend', () => {
    test('getMisIntenciones mapea exitosamente el array de intenciones', async () => {
      const mockIntencion: Intencion = {
        id: 'int-1',
        user_id: 'usr-1',
        titulo: 'Correr en Parque Centenario',
        descripcion: '5k a ritmo suave',
        temporalidad_texto: 'Este sábado por la mañana',
        fecha_desde: '2026-10-03',
        fecha_hasta: '2026-10-03',
        modalidad: 'presencial',
        locality_id: 'loc-1',
        localidad_nombre: 'Caballito',
        localidad_ciudad: 'CABA',
        localidad_zona: 'Centro',
        estado: 'activa',
        encuentro_id: null,
        created_at: '2026-09-29T12:00:00Z',
        updated_at: '2026-09-29T12:00:00Z',
      };

      mockRpcResponse = {
        data: { ok: true, intenciones: [mockIntencion] },
        error: null,
      };

      const result = await intencionesService.getMisIntenciones();

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'get_mis_intenciones_seguro');
      assert.equal(result.ok, true);
      assert.ok(result.data);
      assert.equal(result.data.length, 1);
      assert.equal(result.data[0].id, 'int-1');
      assert.equal(result.data[0].titulo, 'Correr en Parque Centenario');
      assert.equal(result.data[0].modalidad, 'presencial');
      assert.equal(result.data[0].estado, 'activa');
      assert.equal(result.data[0].localidad_nombre, 'Caballito');
    });

    test('getMisIntenciones devuelve array vacío si la lista viene vacía', async () => {
      mockRpcResponse = {
        data: { ok: true, intenciones: [] },
        error: null,
      };

      const result = await intencionesService.getMisIntenciones();
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, []);
    });
  });

  describe('2. Aislamiento de identidad: crearIntencion NO envía user_id', () => {
    test('crearIntencion sólo envía los parámetros autorizados sin user_id', async () => {
      mockRpcResponse = {
        data: { ok: true, id: 'new-int-uuid' },
        error: null,
      };

      const payload: CrearIntencionPayload = {
        titulo: 'Tocar la guitarra',
        descripcion: 'Acústica folk',
        temporalidad_texto: 'Fines de semana',
        fecha_desde: null,
        fecha_hasta: null,
        modalidad: 'presencial',
        locality_id: 'loc-2',
      };

      const result = await intencionesService.crearIntencion(payload);

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'crear_intencion_segura');
      const params = rpcCalls[0].params;

      // Verificar que NO existe user_id ni p_user_id en los parámetros enviados
      assert.equal('user_id' in params, false, 'No debe existir user_id en params');
      assert.equal('p_user_id' in params, false, 'No debe existir p_user_id en params');

      // Verificar parámetros esperados
      assert.equal(params.p_titulo, 'Tocar la guitarra');
      assert.equal(params.p_descripcion, 'Acústica folk');
      assert.equal(params.p_temporalidad_texto, 'Fines de semana');
      assert.equal(params.p_fecha_desde, null);
      assert.equal(params.p_fecha_hasta, null);
      assert.equal(params.p_modalidad, 'presencial');
      assert.equal(params.p_locality_id, 'loc-2');

      assert.equal(result.ok, true);
      assert.equal(result.data, 'new-int-uuid');
    });

    test('editarIntencion sólo envía campos permitidos de contenido sin user_id', async () => {
      mockRpcResponse = {
        data: { ok: true, id: 'edit-int-uuid' },
        error: null,
      };

      const payload: EditarIntencionPayload = {
        id: 'edit-int-uuid',
        titulo: 'Título modificado',
        descripcion: 'Nueva descripción',
        modalidad: 'virtual',
      };

      const result = await intencionesService.editarIntencion(payload);

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'editar_intencion_segura');
      const params = rpcCalls[0].params;

      assert.equal('user_id' in params, false, 'No debe existir user_id en params');
      assert.equal('p_user_id' in params, false, 'No debe existir p_user_id en params');
      assert.equal(params.p_id, 'edit-int-uuid');
      assert.equal(params.p_titulo, 'Título modificado');
      assert.equal(params.p_descripcion, 'Nueva descripción');
      assert.equal(params.p_modalidad, 'virtual');
      assert.equal(result.ok, true);
    });
  });

  describe('3. Ciclo de vida y Soft Delete (cerrarIntencion)', () => {
    test('cerrarIntencion invoca cambiar_estado_intencion_segura con p_nuevo_estado="cerrada"', async () => {
      mockRpcResponse = {
        data: { ok: true, id: 'target-int-id', estado: 'cerrada' },
        error: null,
      };

      const result = await intencionesService.cerrarIntencion('target-int-id');

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'cambiar_estado_intencion_segura');
      assert.deepEqual(rpcCalls[0].params, {
        p_id: 'target-int-id',
        p_nuevo_estado: 'cerrada',
      });
      assert.equal(result.ok, true);
      assert.equal(result.data, 'cerrada');
    });

    test('pausarIntencion invoca cambiar_estado_intencion_segura con p_nuevo_estado="pausada"', async () => {
      mockRpcResponse = {
        data: { ok: true, id: 'target-int-id', estado: 'pausada' },
        error: null,
      };

      const result = await intencionesService.pausarIntencion('target-int-id');

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'cambiar_estado_intencion_segura');
      assert.deepEqual(rpcCalls[0].params, {
        p_id: 'target-int-id',
        p_nuevo_estado: 'pausada',
      });
      assert.equal(result.ok, true);
      assert.equal(result.data, 'pausada');
    });

    test('reactivarIntencion invoca cambiar_estado_intencion_segura con p_nuevo_estado="activa"', async () => {
      mockRpcResponse = {
        data: { ok: true, id: 'target-int-id', estado: 'activa' },
        error: null,
      };

      const result = await intencionesService.reactivarIntencion('target-int-id');

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'cambiar_estado_intencion_segura');
      assert.deepEqual(rpcCalls[0].params, {
        p_id: 'target-int-id',
        p_nuevo_estado: 'activa',
      });
      assert.equal(result.ok, true);
      assert.equal(result.data, 'activa');
    });
  });

  describe('4. Manejo homogéneo de errores sin excepciones no controladas', () => {
    test('captura error de red/supabase en getMisIntenciones', async () => {
      mockRpcResponse = {
        data: null,
        error: { message: 'Failed to fetch from network' },
      };

      const result = await intencionesService.getMisIntenciones();
      assert.equal(result.ok, false);
      assert.equal(result.error, 'Failed to fetch from network');
      assert.equal(result.data, undefined);
    });

    test('captura error de validación retornado por la función SQL', async () => {
      mockRpcResponse = {
        data: { ok: false, error: 'title_required' },
        error: null,
      };

      const result = await intencionesService.crearIntencion({ titulo: '' });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'title_required');
      assert.equal(result.data, undefined);
    });

    test('captura error si supabase.rpc lanza una excepción inesperada', async () => {
      (supabase as any).rpc = async () => {
        throw new Error('Unexpected RPC client crash');
      };

      const result = await intencionesService.cerrarIntencion('int-test');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'Unexpected RPC client crash');
    });
  });

  describe('5. Interfaz y exportación del hook useIntenciones', () => {
    test('useIntenciones exporta la función constructora del hook', () => {
      assert.equal(typeof useIntenciones, 'function', 'useIntenciones debe ser una función/hook');
    });
  });
});
