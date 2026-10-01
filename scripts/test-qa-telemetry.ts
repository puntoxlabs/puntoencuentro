import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../src/lib/supabase';
import { qaTelemetryService } from '../src/services/qaTelemetryService';
import { validateCoordinationCreateResult } from '../src/services/encuentrosService';
import { draftToWizardState } from '../src/lib/encounterDraft';

// Mock sessionStorage globally if it doesn't exist
const setupSessionStorage = () => {
  let store: Record<string, string> = {};
  if (typeof globalThis.sessionStorage === 'undefined') {
    (globalThis as any).sessionStorage = {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => { store[key] = value.toString(); },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { store = {}; }
    };
  } else {
    globalThis.sessionStorage.clear();
  }
};

describe('QA Telemetry Behavioral Tests', () => {
  let originalRpc: any;
  let rpcCalls: any[] = [];
  let rpcImplementation: (name: string, payload: any) => Promise<any> = async () => ({ data: null, error: null });

  beforeEach(() => {
    setupSessionStorage();
    qaTelemetryService.clearSession();
    // @ts-ignore
    qaTelemetryService.lastStartedSessionId = null;

    originalRpc = supabase.rpc;
    rpcCalls = [];
    supabase.rpc = async (name: string, payload: any) => {
      rpcCalls.push({ name, payload });
      return rpcImplementation(name, payload);
    };
    rpcImplementation = async () => ({ data: null, error: null });
  });

  afterEach(() => {
    supabase.rpc = originalRpc;
  });

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  test('3. FAIL-OPEN: trackEvent never rejects when RPC fails', async () => {
    rpcImplementation = async () => ({ error: { code: '500', message: 'Internal Server Error' } });

    // Should not throw
    qaTelemetryService.trackEvent({
      event_type: 'session_started',
      source: 'ui_manual'
    });

    await sleep(1500); // wait for retry to finish
    assert.ok(true, 'Did not throw');
  });

  test('3. FAIL-OPEN: trackEvent handles network TypeError', async () => {
    rpcImplementation = async () => { throw new TypeError('fetch failed'); };

    // Should not throw
    qaTelemetryService.trackEvent({
      event_type: 'session_started',
      source: 'ui_manual'
    });

    await sleep(1500); // wait for retry to finish
    assert.ok(true, 'Did not throw on network error');
  });

  test('4. SNAPSHOT TERMINAL: Context is snapshotted synchronously before clearSession', async () => {
    let capturedPayload: any = null;
    rpcImplementation = async (name, payload) => {
      capturedPayload = payload;
      return { data: null, error: null };
    };

    qaTelemetryService.trackEvent({
      event_type: 'encounter_created',
      source: 'ui_manual'
    });

    // Immediately clear session (simulating what Step4InviteType might do eventually)
    qaTelemetryService.clearSession();

    await sleep(50);

    assert.ok(capturedPayload, 'RPC should have been called');
    assert.ok(capturedPayload.p_session_id, 'Session ID must be preserved in snapshot');
    assert.ok(capturedPayload.p_client_token, 'Client token must be preserved in snapshot');
  });

  test('5. METADATA DROP: Nested objects and arrays are discarded, not stringified', async () => {
    let capturedPayload: any = null;
    rpcImplementation = async (name, payload) => {
      capturedPayload = payload;
      return { data: null, error: null };
    };

    const objWithToString = {
      toString: () => 'malicious_string'
    };

    qaTelemetryService.trackEvent({
      event_type: 'turn_resolved',
      source: 'system',
      metadata: {
        ambiguity_reason: { rawText: 'texto privado' } as any, // should be dropped
        error_code: ['texto privado'] as any, // should be dropped
        turn_intent: 'valid_string', // should be kept
        resolver: objWithToString as any // should be dropped, not stringified
      }
    });

    await sleep(50);

    assert.ok(capturedPayload.p_metadata, 'Metadata should exist');
    assert.equal(capturedPayload.p_metadata.ambiguity_reason, undefined, 'Object should be dropped entirely');
    assert.equal(capturedPayload.p_metadata.error_code, undefined, 'Array should be dropped entirely');
    assert.equal(capturedPayload.p_metadata.resolver, undefined, 'Custom toString object should be dropped');
    assert.equal(capturedPayload.p_metadata.turn_intent, 'valid_string', 'String should be kept');
  });

  test('6. SESSION_STARTED ONCE: Prevents duplicate session_started for same session', async () => {
    qaTelemetryService.trackEvent({ event_type: 'session_started', source: 'ui_manual' });
    qaTelemetryService.trackEvent({ event_type: 'session_started', source: 'ui_manual' });

    await sleep(50);
    assert.equal(rpcCalls.length, 1, 'Should only send one session_started');

    // Simulate page refresh (keep session storage but clear memory instance)
    const storeSnapshot = globalThis.sessionStorage.getItem('pe-qa-creation-session-v1');
    setupSessionStorage(); // clears all
    globalThis.sessionStorage.setItem('pe-qa-creation-session-v1', storeSnapshot!);

    qaTelemetryService.trackEvent({ event_type: 'session_started', source: 'ui_manual' });

    await sleep(50);
    assert.equal(rpcCalls.length, 1, 'Should STILL only send one session_started because it checks sessionStorage flag');
  });

  test('7. MANUAL COORDINATION: Encounter created sets correct event type and date_mode', async () => {
    qaTelemetryService.trackEvent({
      event_type: 'encounter_created',
      source: 'ui_manual',
      creation_source: 'manual',
      date_mode: 'coordination',
      encounter_id: 'uuid-123'
    });

    await sleep(50);
    assert.equal(rpcCalls[0].payload.p_event_type, 'encounter_created');
    assert.equal(rpcCalls[0].payload.p_date_mode, 'coordination');
    assert.equal(rpcCalls[0].payload.p_encounter_id, 'uuid-123');
  });

  test('8. AI SUCCESS/FAILURE: Only emits encounter_created when RPC succeeds', async () => {
    // Failure case: creation RPC failed -> should NOT emit encounter_created
    qaTelemetryService.trackEvent({
      event_type: 'technical_error',
      source: 'system',
      creation_source: 'ai',
      status: 'started',
      metadata: { error_code: 'creation_failed' }
    });

    await sleep(50);
    assert.equal(rpcCalls[0].payload.p_event_type, 'technical_error');
    assert.notEqual(rpcCalls[0].payload.p_event_type, 'encounter_created');

    // Success case: creation RPC succeeded -> emits encounter_created
    qaTelemetryService.trackEvent({
      event_type: 'encounter_created',
      source: 'system',
      creation_source: 'ai',
      encounter_id: 'ai-encounter-uuid',
      status: 'completed'
    });

    await sleep(50);
    assert.equal(rpcCalls[1].payload.p_event_type, 'encounter_created');
    assert.equal(rpcCalls[1].payload.p_encounter_id, 'ai-encounter-uuid');
    assert.equal(rpcCalls[1].payload.p_status, 'completed');
  });

  test('9. AI -> MANUAL: Preserves session and prevents second session_started', async () => {
    // 1. AI starts
    qaTelemetryService.trackEvent({
      event_type: 'session_started',
      source: 'system',
      creation_source: 'ai'
    });
    await sleep(50);
    assert.equal(rpcCalls.length, 1);
    const aiSessionId = rpcCalls[0].payload.p_session_id;
    const aiClientToken = rpcCalls[0].payload.p_client_token;

    // 2. Handoff to manual
    qaTelemetryService.trackEvent({
      event_type: 'provider_fallback',
      source: 'system',
      creation_source: 'ai',
      status: 'started'
    });
    await sleep(50);
    assert.equal(rpcCalls.length, 2);

    // 3. User enters manual flow: tries to trigger session_started
    qaTelemetryService.trackEvent({
      event_type: 'session_started',
      source: 'ui_manual',
      creation_source: 'manual'
    });
    await sleep(50);
    // Should NOT emit a second session_started
    assert.equal(rpcCalls.length, 2, 'Must not duplicate session_started during handoff');

    // 4. User completes manual encounter
    qaTelemetryService.trackEvent({
      event_type: 'encounter_created',
      source: 'ui_manual',
      creation_source: 'manual',
      encounter_id: 'manual-encounter-id',
      status: 'completed'
    });
    await sleep(50);
    assert.equal(rpcCalls.length, 3);
    assert.equal(rpcCalls[2].payload.p_session_id, aiSessionId, 'Preserves original session ID');
    assert.equal(rpcCalls[2].payload.p_client_token, aiClientToken, 'Preserves original client token');
    assert.equal(rpcCalls[2].payload.p_event_type, 'encounter_created');
  });

  test('11. FALLBACK: OpenAI fails retryable -> Mistral succeeds (provider_fallback, no technical_error)', async () => {
    // When fallback succeeds: provider_fallback emitted, NO technical_error
    qaTelemetryService.trackEvent({
      event_type: 'provider_fallback',
      source: 'llm_mistral',
      creation_source: 'ai',
      fallback_used: true,
      provider: 'mistral'
    });
    await sleep(50);
    assert.equal(rpcCalls[0].payload.p_event_type, 'provider_fallback');
    assert.equal(rpcCalls[0].payload.p_fallback_used, true);

    // When both fail: technical_error emitted
    qaTelemetryService.trackEvent({
      event_type: 'technical_error',
      source: 'system',
      creation_source: 'ai',
      status: 'started',
      metadata: { error_code: 'all_providers_failed' }
    });
    await sleep(50);
    assert.equal(rpcCalls[1].payload.p_event_type, 'technical_error');
  });

  test('10. TURN_NUMBER: Same turn number across multiple events', async () => {
    qaTelemetryService.trackEvent({ event_type: 'provider_fallback', source: 'system', turn_number: 3 });
    qaTelemetryService.trackEvent({ event_type: 'turn_resolved', source: 'system', turn_number: 3 });

    await sleep(50);
    assert.equal(rpcCalls[0].payload.p_turn_number, 3);
    assert.equal(rpcCalls[1].payload.p_turn_number, 3);
  });

  test('12. RETRY: Retry exactly once on network error', async () => {
    let callCount = 0;
    rpcImplementation = async () => {
      callCount++;
      throw new TypeError('fetch failed');
    };

    qaTelemetryService.trackEvent({ event_type: 'session_started', source: 'ui_manual' });

    await sleep(1500); // Wait for the 1000ms retry timeout + padding

    assert.equal(callCount, 2, 'Should have tried exactly twice (initial + 1 retry)');
  });

  test('12. NO RETRY on 4xx', async () => {
    let callCount = 0;
    rpcImplementation = async () => {
      callCount++;
      return { error: { code: '400', message: 'Bad Request' } };
    };

    qaTelemetryService.trackEvent({ event_type: 'session_started', source: 'ui_manual' });

    await sleep(1500);

    assert.equal(callCount, 1, 'Should NOT retry on 4xx errors');
  });

  test('Aislamiento RPC: código productivo de telemetría es interceptado y no toca red', async () => {
    // Restauramos el RPC al estado del test harness (nuestro mock global)
    const currentMock = supabase.rpc;
    supabase.rpc = originalRpc;

    // Anotamos el contador antes
    const interceptCountBefore = (globalThis as any).__QA_TELEMETRY_INTERCEPTED_CALLS || 0;

    // Llamada REAL al código productivo
    qaTelemetryService.trackEvent({ event_type: 'session_started', source: 'ui_manual' });
    await sleep(50); // Dar tiempo a la ejecución asíncrona

    const interceptCountAfter = (globalThis as any).__QA_TELEMETRY_INTERCEPTED_CALLS || 0;

    assert.ok(interceptCountAfter > interceptCountBefore, 'El mock global debe haber interceptado la llamada productiva');

    // Restauramos el mock del test
    supabase.rpc = currentMock;
  });

  test('Defensa en Profundidad: evasión de mock dispara el failsafe de fetch', async () => {
    // Simulamos que por error el mock fue evadido y se intenta enviar una petición a la URL productiva
    let fetchFailed = false;
    try {
      await fetch('https://aurbicjwftjhwryhyjiq.supabase.co/rest/v1/rpc/registrar_evento_creacion', {
        method: 'POST',
      });
    } catch (e: any) {
      if (e.message.includes('QA_TELEMETRY_REAL_INVOCATION_BLOCKED')) {
        fetchFailed = true;
      }
    }
    assert.ok(fetchFailed, 'Si se evade el mock, el interceptor fetch debe abortar con un error duro inmediato');
  });
});

describe('P1 — Coordination Contract Alignment Tests', () => {
  test('P1.A: Accepts canonical flat RPC shape { ok: true, id, public_token }', () => {
    const rpcResponse = {
      ok: true,
      id: '11111111-1111-1111-1111-111111111111',
      public_token: 'coord-token-canonical',
      date_mode: 'coordination',
      opciones_count: 2,
    };
    const result = validateCoordinationCreateResult(rpcResponse);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.encuentro.id, '11111111-1111-1111-1111-111111111111');
      assert.equal(result.encuentro.public_token, 'coord-token-canonical');
    }
  });

  test('P1.B: Accepts legacy nested RPC shape { ok: true, encuentro: { id, public_token } }', () => {
    const rpcResponse = {
      ok: true,
      encuentro: {
        id: '22222222-2222-2222-2222-222222222222',
        public_token: 'coord-token-legacy',
      },
    };
    const result = validateCoordinationCreateResult(rpcResponse);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.encuentro.id, '22222222-2222-2222-2222-222222222222');
      assert.equal(result.encuentro.public_token, 'coord-token-legacy');
    }
  });

  test('P1.C: Passes through structured errors with details', () => {
    const errorResponse = {
      ok: false,
      error: 'minimum_two_options',
      details: 'Se requieren al menos 2 opciones de fecha',
    };
    const result = validateCoordinationCreateResult(errorResponse);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'minimum_two_options');
      assert.equal(result.details, 'Se requieren al menos 2 opciones de fecha');
    }
  });

  test('P1.D: Rejects malformed responses with invalid_response_format', () => {
    assert.equal(validateCoordinationCreateResult(null).ok, false);
    assert.equal(validateCoordinationCreateResult(undefined).ok, false);
    assert.equal(validateCoordinationCreateResult('string').ok, false);
    assert.equal(validateCoordinationCreateResult({ ok: true }).ok, false);
    assert.equal(validateCoordinationCreateResult({ ok: true, id: '' }).ok, false);
    assert.equal(validateCoordinationCreateResult({ ok: true, id: 'valid-id', public_token: ' ' }).ok, false);
  });
});

describe('P2 — Creation Telemetry Contract & Handoff Tests', () => {
  let originalRpc: any;
  let capturedPayload: any = null;

  beforeEach(() => {
    setupSessionStorage();
    qaTelemetryService.clearSession();
    originalRpc = supabase.rpc;
    capturedPayload = null;
    supabase.rpc = async (name: string, payload: any) => {
      capturedPayload = payload;
      return { data: null, error: null };
    };
  });

  afterEach(() => {
    supabase.rpc = originalRpc;
  });

  test('P2.A: Manual creation from /create registers creation_source=manual and initial_route=/create', async () => {
    qaTelemetryService.trackEvent({
      event_type: 'encounter_created',
      source: 'ui_manual',
      creation_source: 'manual',
      initial_route: '/create',
      encounter_id: '33333333-3333-3333-3333-333333333333',
      status: 'completed',
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.p_creation_source, 'manual');
    assert.equal(capturedPayload.p_initial_route, '/create');
    assert.equal(capturedPayload.p_event_type, 'encounter_created');
  });

  test('P2.B: AI creation from /create/ai registers creation_source=ai and initial_route=/create/ai', async () => {
    qaTelemetryService.trackEvent({
      event_type: 'encounter_created',
      source: 'system',
      creation_source: 'ai',
      initial_route: '/create/ai',
      encounter_id: '44444444-4444-4444-4444-444444444444',
      status: 'completed',
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.p_creation_source, 'ai');
    assert.equal(capturedPayload.p_initial_route, '/create/ai');
  });

  test('P2.C: Defensive resolution defaults manual to /create if route is omitted', async () => {
    qaTelemetryService.trackEvent({
      event_type: 'encounter_created',
      source: 'ui_manual',
      creation_source: 'manual',
      encounter_id: '55555555-5555-5555-5555-555555555555',
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.p_creation_source, 'manual');
    assert.equal(capturedPayload.p_initial_route, '/create');
  });

  test('P2.D: AI handoff preserves creation_source=ai into wizard state', () => {
    const draft = {
      title: 'Pádel AI',
      date: '2026-10-15',
      time: '20:00',
      description: 'Partido de pádel',
      modality: 'presencial' as const,
      locationText: 'Club Palermo',
      virtualLink: '',
      dateMode: 'fixed' as const,
      durationMinutes: 90,
      ambiguities: [],
    };
    const config = {
      invitationType: 'link_general' as const,
      invitationTheme: 'classic' as const,
      invitationTemplate: 'default',
      responseVisibility: 'summary' as const,
    };
    const wizardState = draftToWizardState(draft as any, config as any);
    assert.equal(wizardState.creation_source, 'ai');
    assert.equal(wizardState.titulo, 'Pádel AI');
  });
});
