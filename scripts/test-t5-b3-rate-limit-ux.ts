import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../src/lib/supabase';
import { encuentrosService, getCoordinationCreateErrorMessage } from '../src/services/encuentrosService';
import { intencionesService } from '../src/services/intencionesService';
import { openEncountersService } from '../src/services/openEncountersService';

describe('T5-B3 — Rate Limiting Frontend UX & Error Handling Tests', () => {
  let rpcCalls: { fn: string; params: any }[] = [];
  let mockRpcResponse: { data: any; error: any } = { data: null, error: null };

  beforeEach(() => {
    rpcCalls = [];
    mockRpcResponse = { data: null, error: null };

    (supabase as any).rpc = async (fn: string, params?: any) => {
      rpcCalls.push({ fn, params });
      if (mockRpcResponse.error instanceof Error) {
        throw mockRpcResponse.error;
      }
      return mockRpcResponse;
    };
  });

  describe('1. Surface 1 — Creación simple: createEncuentro structured error handling', () => {
    test('createEncuentro throws Error with code rate_limit_exceeded when RPC rejects', async () => {
      mockRpcResponse = {
        data: { ok: false, error: 'rate_limit_exceeded' },
        error: null,
      };

      await assert.rejects(
        async () => {
          await encuentrosService.createEncuentro({
            titulo: 'Test Encuentro',
            fecha: '2026-10-15',
            hora: '19:00',
            modalidad: 'presencial',
          } as any);
        },
        (err: any) => {
          assert.equal(err.message, 'rate_limit_exceeded');
          assert.equal(err.code, 'rate_limit_exceeded');
          return true;
        }
      );
    });

    test('createEncuentro returns data on success', async () => {
      mockRpcResponse = {
        data: { ok: true, id: 'enc-123', public_token: 'tok-abc' },
        error: null,
      };

      const res = await encuentrosService.createEncuentro({
        titulo: 'Test Encuentro',
        fecha: '2026-10-15',
        hora: '19:00',
        modalidad: 'presencial',
      } as any);

      assert.equal(res.ok, true);
      assert.equal(res.id, 'enc-123');
    });
  });

  describe('2. Surface 2 — Creación coordinada: getCoordinationCreateErrorMessage mapping', () => {
    test('maps rate_limit_exceeded to friendly rioplatense text without technical jargon', () => {
      const msg = getCoordinationCreateErrorMessage('rate_limit_exceeded');
      assert.equal(msg, 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.');
      assert.doesNotMatch(msg, /rate_limit/);
      assert.doesNotMatch(msg, /bucket/);
      assert.doesNotMatch(msg, /error/i);
    });

    test('maps rate_limit_unavailable to friendly retry text', () => {
      const msg = getCoordinationCreateErrorMessage('rate_limit_unavailable');
      assert.equal(msg, 'No pudimos crear la coordinación en este momento. Intentá nuevamente en unos minutos.');
      assert.doesNotMatch(msg, /rate_limit/);
      assert.doesNotMatch(msg, /bucket/);
    });
  });

  describe('3. Surface 3 — Intenciones: crearIntencion propagates backend codes cleanly', () => {
    test('crearIntencion returns ok:false with rate_limit_exceeded without crashing', async () => {
      mockRpcResponse = {
        data: { ok: false, error: 'rate_limit_exceeded' },
        error: null,
      };

      const res = await intencionesService.crearIntencion({
        titulo: 'Tocar la guitarra',
        modalidad: 'presencial',
      });

      assert.equal(res.ok, false);
      assert.equal(res.error, 'rate_limit_exceeded');
    });
  });

  describe('4. Surface 4 — Encuentros abiertos: solicitarSumarse propagates error codes', () => {
    test('solicitarSumarse returns rate_limit_exceeded and request_not_available without throwing', async () => {
      mockRpcResponse = {
        data: { ok: false, error: 'rate_limit_exceeded' },
        error: null,
      };

      const resRateLimit = await openEncountersService.solicitarSumarse('enc-1', 'Juan');
      assert.equal(resRateLimit.ok, false);
      assert.equal(resRateLimit.error, 'rate_limit_exceeded');

      mockRpcResponse = {
        data: { ok: false, error: 'request_not_available' },
        error: null,
      };

      const resCooldown = await openEncountersService.solicitarSumarse('enc-1', 'Juan');
      assert.equal(resCooldown.ok, false);
      assert.equal(resCooldown.error, 'request_not_available');
    });
  });
});
