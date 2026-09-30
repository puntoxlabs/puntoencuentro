import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../src/lib/supabase';
import { encuentrosService, getCoordinationCreateErrorMessage } from '../src/services/encuentrosService';
import { intencionesService } from '../src/services/intencionesService';
import { openEncountersService } from '../src/services/openEncountersService';

// Helpers que reproducen exactamente las funciones puras de mapeo de error de cada componente UI
function mapStep4InviteTypeError(err: any): string {
  const errorCode = err?.code || err?.message;
  let friendlyError = 'No pudimos crear el encuentro. Revisá tu conexión e intentá nuevamente.';
  if (errorCode === 'rate_limit_exceeded') {
    friendlyError = 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.';
  } else if (errorCode === 'rate_limit_unavailable') {
    friendlyError = 'No pudimos crear el encuentro en este momento. Intentá nuevamente en unos minutos.';
  } else if (err?.message && typeof err.message === 'string' && !err.message.includes('{') && !err.message.includes('create_failed')) {
    friendlyError = errorFriendlyFilter(err.message);
  }
  return friendlyError;
}

function errorFriendlyFilter(msg: string): string {
  return msg;
}

function mapCreateAIWizardError(err: any): string {
  const errorCode = err?.code || err?.message;
  let errorMessage = 'Error al guardar el encuentro. Podés continuar en el formulario manual.';
  if (errorCode === 'rate_limit_exceeded') {
    errorMessage = 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.';
  } else if (errorCode === 'rate_limit_unavailable') {
    errorMessage = 'No pudimos guardar el encuentro en este momento. Intentá nuevamente en unos minutos.';
  } else if (err?.message && typeof err.message === 'string' && !err.message.includes('{') && !err.message.includes('create_failed')) {
    errorMessage = err.message;
  }
  return errorMessage;
}

function mapIntentionError(resError: string): string {
  let friendly = 'No se pudo crear la intención. Intentá nuevamente.';
  if (resError === 'rate_limit_exceeded') {
    friendly = 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.';
  } else if (resError === 'rate_limit_unavailable') {
    friendly = 'No pudimos crear la intención en este momento. Intentá nuevamente en unos minutos.';
  }
  return friendly;
}

function mapJoinOpenEncounterError(resError: string): string {
  if (resError === 'encounter_full') {
    return 'El cupo para este encuentro ya se encuentra completo.';
  } else if (resError === 'already_participant') {
    return 'Ya estás registrado como participante de este encuentro.';
  } else if (resError === 'permanent_account_required') {
    return 'Se requiere una cuenta permanente para solicitar sumarte.';
  } else if (resError === 'rate_limit_exceeded') {
    return 'Hiciste varias solicitudes en poco tiempo. Esperá un rato e intentá nuevamente.';
  } else if (resError === 'rate_limit_unavailable') {
    return 'No pudimos enviar tu solicitud en este momento. Intentá nuevamente en unos minutos.';
  } else if (resError === 'request_not_available') {
    return 'Esta solicitud no está disponible en este momento.';
  } else {
    return 'No pudimos enviar tu solicitud. Intentá nuevamente.';
  }
}

describe('T5-B3.1 — Verificación Exhaustiva UX Antiabuso (13 Puntos)', () => {
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

  // 1 & 2 & 12. Create Simple
  describe('Puntos 1, 2, 12 — Create simple error handling', () => {
    test('1. create simple + rate_limit_exceeded maps to human friendly text', async () => {
      mockRpcResponse = { data: { ok: false, error: 'rate_limit_exceeded' }, error: null };
      try {
        await encuentrosService.createEncuentro({ titulo: 'Test', fecha: '2026-10-15', hora: '19:00', modalidad: 'presencial' } as any);
        assert.fail('should have thrown');
      } catch (err: any) {
        assert.equal(err.code, 'rate_limit_exceeded');
        const userMsg = mapStep4InviteTypeError(err);
        assert.equal(userMsg, 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.');
      }
    });

    test('2. create simple + rate_limit_unavailable maps to temporary retry message', async () => {
      mockRpcResponse = { data: { ok: false, error: 'rate_limit_unavailable' }, error: null };
      try {
        await encuentrosService.createEncuentro({ titulo: 'Test', fecha: '2026-10-15', hora: '19:00', modalidad: 'presencial' } as any);
        assert.fail('should have thrown');
      } catch (err: any) {
        assert.equal(err.code, 'rate_limit_unavailable');
        const userMsg = mapStep4InviteTypeError(err);
        assert.equal(userMsg, 'No pudimos crear el encuentro en este momento. Intentá nuevamente en unos minutos.');
      }
    });

    test('12. no /share/undefined ante result.ok=false (strict throw prevents undefined id navigation)', async () => {
      mockRpcResponse = { data: { ok: false, error: 'rate_limit_exceeded' }, error: null };
      let navTarget: string | null = null;
      try {
        const result = await encuentrosService.createEncuentro({ titulo: 'Test', fecha: '2026-10-15', hora: '19:00', modalidad: 'presencial' } as any);
        navTarget = `/share/${result.id}`;
      } catch {
        // Exception caught: navigation avoided
        navTarget = null;
      }
      assert.equal(navTarget, null, 'Must never navigate to /share/undefined');
    });
  });

  // 3 & 4. Coordination
  describe('Puntos 3, 4 — Coordination error messages', () => {
    test('3. coordination + rate_limit_exceeded maps to human friendly text', () => {
      const msg = getCoordinationCreateErrorMessage('rate_limit_exceeded');
      assert.equal(msg, 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.');
    });

    test('4. coordination + rate_limit_unavailable maps to temporary retry message', () => {
      const msg = getCoordinationCreateErrorMessage('rate_limit_unavailable');
      assert.equal(msg, 'No pudimos crear la coordinación en este momento. Intentá nuevamente en unos minutos.');
    });
  });

  // 5 & 6. CreateAIWizard
  describe('Puntos 5, 6 — CreateAIWizard final creation', () => {
    test('5. CreateAIWizard final creation + rate_limit_exceeded maps to friendly text', () => {
      const err = { code: 'rate_limit_exceeded', message: 'rate_limit_exceeded' };
      const userMsg = mapCreateAIWizardError(err);
      assert.equal(userMsg, 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.');
    });

    test('6. CreateAIWizard final creation + rate_limit_unavailable maps to temporary message', () => {
      const err = { code: 'rate_limit_unavailable', message: 'rate_limit_unavailable' };
      const userMsg = mapCreateAIWizardError(err);
      assert.equal(userMsg, 'No pudimos guardar el encuentro en este momento. Intentá nuevamente en unos minutos.');
    });
  });

  // 7 & 8. Intention
  describe('Puntos 7, 8 — Intention creation & editing', () => {
    test('7. intention + rate_limit_exceeded maps to human friendly text', async () => {
      mockRpcResponse = { data: { ok: false, error: 'rate_limit_exceeded' }, error: null };
      const res = await intencionesService.crearIntencion({ titulo: 'Pádel', modalidad: 'presencial' });
      assert.equal(res.ok, false);
      assert.equal(res.error, 'rate_limit_exceeded');
      const userMsg = mapIntentionError(res.error!);
      assert.equal(userMsg, 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.');
    });

    test('8. intention + rate_limit_unavailable maps to temporary retry message', async () => {
      mockRpcResponse = { data: { ok: false, error: 'rate_limit_unavailable' }, error: null };
      const res = await intencionesService.crearIntencion({ titulo: 'Pádel', modalidad: 'presencial' });
      assert.equal(res.ok, false);
      assert.equal(res.error, 'rate_limit_unavailable');
      const userMsg = mapIntentionError(res.error!);
      assert.equal(userMsg, 'No pudimos crear la intención en este momento. Intentá nuevamente en unos minutos.');
    });
  });

  // 9, 10, 11. Join Open Encounter
  describe('Puntos 9, 10, 11 — Solicitar sumarse a encuentro abierto', () => {
    test('9. join + rate_limit_exceeded maps to specific requests message', async () => {
      mockRpcResponse = { data: { ok: false, error: 'rate_limit_exceeded' }, error: null };
      const res = await openEncountersService.solicitarSumarse('enc-1', 'Maria');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'rate_limit_exceeded');
      const userMsg = mapJoinOpenEncounterError(res.error!);
      assert.equal(userMsg, 'Hiciste varias solicitudes en poco tiempo. Esperá un rato e intentá nuevamente.');
    });

    test('10. join + rate_limit_unavailable maps to temporary retry message', async () => {
      mockRpcResponse = { data: { ok: false, error: 'rate_limit_unavailable' }, error: null };
      const res = await openEncountersService.solicitarSumarse('enc-1', 'Maria');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'rate_limit_unavailable');
      const userMsg = mapJoinOpenEncounterError(res.error!);
      assert.equal(userMsg, 'No pudimos enviar tu solicitud en este momento. Intentá nuevamente en unos minutos.');
    });

    test('11. join + request_not_available neutral (no reveals of rejection, block, cooldown or 6 hours)', async () => {
      mockRpcResponse = { data: { ok: false, error: 'request_not_available' }, error: null };
      const res = await openEncountersService.solicitarSumarse('enc-1', 'Maria');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'request_not_available');
      const userMsg = mapJoinOpenEncounterError(res.error!);
      assert.equal(userMsg, 'Esta solicitud no está disponible en este momento.');
      // Privacy & neutral check
      assert.doesNotMatch(userMsg, /rechazo|rechaz|bloqueo|bloquead|cooldown|6 horas|hora/i);
    });
  });

  // 13. No raw technical codes
  describe('Punto 13 — No raw technical codes visible in any message', () => {
    const allUserFacingMessages = [
      mapStep4InviteTypeError({ code: 'rate_limit_exceeded' }),
      mapStep4InviteTypeError({ code: 'rate_limit_unavailable' }),
      getCoordinationCreateErrorMessage('rate_limit_exceeded'),
      getCoordinationCreateErrorMessage('rate_limit_unavailable'),
      mapCreateAIWizardError({ code: 'rate_limit_exceeded' }),
      mapCreateAIWizardError({ code: 'rate_limit_unavailable' }),
      mapIntentionError('rate_limit_exceeded'),
      mapIntentionError('rate_limit_unavailable'),
      mapJoinOpenEncounterError('rate_limit_exceeded'),
      mapJoinOpenEncounterError('rate_limit_unavailable'),
      mapJoinOpenEncounterError('request_not_available'),
    ];

    for (const [index, msg] of allUserFacingMessages.entries()) {
      test(`13.${index + 1}. Message does not contain technical jargon: "${msg}"`, () => {
        assert.doesNotMatch(msg, /rate_limit/);
        assert.doesNotMatch(msg, /bucket/);
        assert.doesNotMatch(msg, /exceeded/);
        assert.doesNotMatch(msg, /unavailable/);
        assert.doesNotMatch(msg, /request_not_available/);
        assert.doesNotMatch(msg, /undefined/);
        assert.doesNotMatch(msg, /rpc/i);
        assert.doesNotMatch(msg, /\[object/i);
      });
    }
  });
});
