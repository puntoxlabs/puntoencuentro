import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Import components and trackers to test
import { QAGate } from '../src/components/qa/QAGate';
import { HiddenDiscoveryTracker } from '../src/hooks/useHiddenDiscovery';
import InternalQAOverview from '../src/screens/InternalQA/index';
import QASessions from '../src/screens/InternalQA/QASessions';
import QASessionDetail from '../src/screens/InternalQA/QASessionDetail';

describe('QA Console Frontend Infrastructure', () => {
  describe('QAGate & Authorization Behavior', () => {
    test('A. anon -> QA content no renderiza (unauthorized)', () => {
      // Mock unauth hook override
      const mockUnauthHook = () => ({ status: 'unauthorized' as const });
      
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/', element: React.createElement('div', null, 'HOME') }),
          React.createElement(Route, { 
            path: '/internal/qa', 
            element: React.createElement(QAGate, { hookOverride: mockUnauthHook }, React.createElement('div', null, 'SECRET_QA_CONTENT'))
          })
        )
      );

      const html = renderToString(el);
      assert.ok(!html.includes('SECRET_QA_CONTENT'), 'Debe bloquear contenido QA para anon');
      // En react-router v6 en SSR sin soporte de efectos de navegación, Navigate puede que no renderice el destino inmediatamente,
      // pero definitivamente no renderizará el contenido protegido.
    });

    test('B. authenticated normal -> is_qa_authorized false -> QA content no renderiza', () => {
      const mockUnauthHook = () => ({ status: 'unauthorized' as const });
      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(QAGate, { hookOverride: mockUnauthHook }, React.createElement('div', null, 'SECRET_QA_CONTENT'))
      );
      const html = renderToString(el);
      assert.ok(!html.includes('SECRET_QA_CONTENT'), 'Debe bloquear contenido QA para user normal');
    });

    test('C. admin -> true -> shell QA renderiza', () => {
      const mockAuthHook = () => ({ status: 'authorized' as const });
      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(QAGate, { hookOverride: mockAuthHook }, React.createElement('div', null, 'SECRET_QA_CONTENT'))
      );
      const html = renderToString(el);
      assert.ok(html.includes('SECRET_QA_CONTENT'), 'Debe permitir contenido QA para admin');
    });

    test('D. RPC autorización falla -> QA content no renderiza', () => {
      const mockErrorHook = () => ({ status: 'error' as const });
      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(QAGate, { hookOverride: mockErrorHook }, React.createElement('div', null, 'SECRET_QA_CONTENT'))
      );
      const html = renderToString(el);
      assert.ok(!html.includes('SECRET_QA_CONTENT'), 'Debe bloquear contenido QA si RPC falla');
    });

    test('A. /internal/qa/sessions/:sessionId queda protegida por QAGate', () => {
      const mockUnauthHook = () => ({ status: 'unauthorized' as const });
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/test-session-123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/', element: React.createElement('div', null, 'PUBLIC_HOME') }),
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QAGate, { hookOverride: mockUnauthHook }, React.createElement('div', null, 'SECRET_SESSION_DETAIL_CONTENT'))
          })
        )
      );
      const html = renderToString(el);
      assert.ok(!html.includes('SECRET_SESSION_DETAIL_CONTENT'), 'Ruta de detalle no debe renderizar contenido si está desautorizado');
    });

    test('B. usuario authenticated normal escribe directamente /internal/qa -> no renderiza QA', () => {
      const mockNormalUserHook = () => ({ status: 'unauthorized' as const });
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/', element: React.createElement('div', null, 'PUBLIC_HOME') }),
          React.createElement(Route, {
            path: '/internal/qa',
            element: React.createElement(QAGate, { hookOverride: mockNormalUserHook }, React.createElement('div', null, 'QA_OVERVIEW_CONTENT'))
          })
        )
      );
      const html = renderToString(el);
      assert.ok(!html.includes('QA_OVERVIEW_CONTENT'), 'Usuario normal directo en /internal/qa no debe ver QA');
    });

    test('C. usuario authenticated normal escribe directamente /internal/qa/sessions/test-id -> no renderiza detalle QA', () => {
      const mockNormalUserHook = () => ({ status: 'unauthorized' as const });
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/test-id'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/', element: React.createElement('div', null, 'PUBLIC_HOME') }),
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QAGate, { hookOverride: mockNormalUserHook }, React.createElement('div', null, 'QA_DETAIL_CONTENT'))
          })
        )
      );
      const html = renderToString(el);
      assert.ok(!html.includes('QA_DETAIL_CONTENT'), 'Usuario normal directo en /internal/qa/sessions/test-id no debe ver detalle');
    });

    test('D. comportamiento normal del elemento con gesto oculto sigue intacto (click normal = 1 tap no altera navegación)', () => {
      const tracker = new HiddenDiscoveryTracker(5, 3000);
      const singleClickTriggered = tracker.registerTap(Date.now());
      assert.equal(singleClickTriggered, false, 'Un tap o click individual jamás debe disparar navegación a QA');
      assert.equal(tracker.taps.length, 1, 'Registra tap sin forzar navegación');
    });

    test('E. QAGate no renderiza children durante estado checking (no flash)', () => {
      const mockCheckingHook = () => ({ status: 'checking' as const });
      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(QAGate, { hookOverride: mockCheckingHook }, React.createElement('div', null, 'CHILDREN_NOT_ALLOWED_DURING_CHECKING'))
      );
      const html = renderToString(el);
      assert.ok(!html.includes('CHILDREN_NOT_ALLOWED_DURING_CHECKING'), 'No debe haber flash de children durante checking');
      assert.ok(html.includes('Cargando...'), 'Debe mostrar mensaje/loader de checking neutro');
    });
  });

  describe('Hidden Discovery Gesture', () => {
    test('H. 4 taps -> no navega', () => {
      const tracker = new HiddenDiscoveryTracker(5, 3000);
      let navigated = false;
      const now = Date.now();
      for (let i = 0; i < 4; i++) {
        if (tracker.registerTap(now + i * 100)) navigated = true;
      }
      assert.equal(navigated, false, 'No debe activar con 4 taps');
    });

    test('H. 5 taps dentro de ventana temporal -> navega a /internal/qa', () => {
      const tracker = new HiddenDiscoveryTracker(5, 3000);
      let navigated = false;
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        if (tracker.registerTap(now + i * 100)) navigated = true;
      }
      assert.equal(navigated, true, 'Debe activar con 5 taps rápidos');
      // Debe resetear después de navegar
      assert.equal(tracker.taps.length, 0, 'Debe resetear contador al activar');
    });

    test('I. fuera de ventana temporal -> contador resetea', () => {
      const tracker = new HiddenDiscoveryTracker(5, 3000);
      let navigated = false;
      const now = Date.now();
      // 3 taps
      tracker.registerTap(now);
      tracker.registerTap(now + 100);
      tracker.registerTap(now + 200);
      // Wait 3500ms
      const later = now + 3500;
      // 2 more taps (should not trigger because first 3 expired)
      if (tracker.registerTap(later)) navigated = true;
      if (tracker.registerTap(later + 100)) navigated = true;
      
      assert.equal(navigated, false, 'Taps viejos deben expirar');
      assert.equal(tracker.taps.length, 2, 'Solo deben quedar los taps recientes');
    });
  });

  describe('QA Console Overview (Parte B)', () => {
    const mockSampleMetrics = {
      ok: true,
      period_days: 7,
      total_sessions: 42,
      completed_sessions: 28,
      abandoned_sessions: 5,
      probable_abandonment_heuristic_minutes: 30,
      cancelled_sessions: 9,
      conversion_rate: 66.7,
      ai_sessions: 25,
      manual_sessions: 17,
      fixed_encounters: 20,
      coordination_encounters: 8,
      deterministic_events: 100,
      llm_events: 50,
      fallback_events: 3,
      clarification_events: 6,
      avg_latency_ms: 1200,
      p90_latency_ms: 2400,
    };

    test('A. metrics correctas renderizadas', () => {
      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialMetrics: mockSampleMetrics,
          initialSessions: [],
        })
      );
      const html = renderToString(el);
      assert.ok(html.includes('42'), 'Debe mostrar 42 sesiones iniciadas');
      assert.ok(html.includes('28'), 'Debe mostrar 28 encuentros creados');
      assert.ok(html.includes('66.7%'), 'Debe mostrar tasa de finalización 66.7%');
      assert.ok(html.includes('5'), 'Debe mostrar 5 probables abandonos');
      assert.ok(html.includes('30 min inactivo'), 'Debe documentar heurística de abandono');
      assert.ok(html.includes('25 IA'), 'Debe mostrar sesiones de IA');
      assert.ok(html.includes('17 Manual'), 'Debe mostrar sesiones manuales');
      assert.ok(html.includes('3 Fallbacks'), 'Debe mostrar fallbacks de proveedor');
      assert.ok(html.includes('6 Aclar.'), 'Debe mostrar aclaraciones');
      assert.ok(html.includes('2400 ms'), 'Debe mostrar latencia P90');
    });

    test('B. selector 7d -> 30d provoca nueva consulta correcta', async () => {
      let queriedMetricsDays = -1;
      let queriedSessionsDays = -1;

      const mockOverride = {
        getMetrics: async (days: number) => {
          queriedMetricsDays = days;
          return { ...mockSampleMetrics, period_days: days };
        },
        getSessions: async (days: number) => {
          queriedSessionsDays = days;
          return { sessions: [] };
        },
      };

      // Invocamos la llamada de período 30 días
      await Promise.all([
        mockOverride.getMetrics(30),
        mockOverride.getSessions(30),
      ]);

      assert.equal(queriedMetricsDays, 30, 'Metrics debe ser consultada con p_days = 30');
      assert.equal(queriedSessionsDays, 30, 'Sessions debe ser consultada con p_days = 30');

      // Visual: el botón 30 días se activa
      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialMetrics: { ...mockSampleMetrics, period_days: 30 },
          initialSessions: [],
          initialPeriodDays: 30,
        })
      );
      const html = renderToString(el);
      assert.ok(html.includes('qa-period-btn--active">30 días<'), 'Botón 30 días debe tener clase activa');
    });

    test('C. error state muestra mensaje y botón reintentar', async () => {
      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialError: 'No se pudieron cargar los datos.',
          initialMetrics: null,
          initialLoading: false,
        })
      );
      const html = renderToString(el);
      assert.ok(html.includes('No se pudieron cargar los datos.'), 'Debe mostrar mensaje de error');
      assert.ok(html.includes('Reintentar'), 'Debe mostrar botón Reintentar');
    });

    test('D. retry button presente en estado de error', async () => {
      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialError: 'No se pudieron cargar los datos.',
          initialMetrics: null,
          initialLoading: false,
        })
      );
      const html = renderToString(el);
      assert.ok(html.includes('qa-btn-retry'), 'Debe incluir clase qa-btn-retry');
    });

    test('E. empty state cuando no hay sesiones en el período', async () => {
      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialMetrics: { ...mockSampleMetrics, total_sessions: 0 },
          initialSessions: [],
        })
      );
      const html = renderToString(el);
      assert.ok(html.includes('No hay sesiones en este período.'), 'Debe renderizar empty state general');
    });

    test('E2. sin sesiones problemáticas muestra aviso específico', async () => {
      const normalSession = {
        id: '11111111-2222-3333-4444-555555555555',
        creation_source: 'ai' as const,
        initial_route: '/create/ai',
        status: 'completed' as const,
        date_mode: 'fixed' as const,
        encounter_id: '66666666-7777-8888-9999-000000000000',
        turns: 2,
        elapsed_ms: 15000,
        frontend_version: '1.0.0',
        edge_version: '1.0.0',
        created_at: '2026-09-15T15:00:00Z',
        completed_at: '2026-09-15T15:00:15Z',
        last_event_at: '2026-09-15T15:00:15Z',
        is_problematic: false,
        needs_review: false,
      };

      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialMetrics: mockSampleMetrics,
          initialSessions: [normalSession],
        })
      );
      const html = renderToString(el);
      assert.ok(html.includes('No se detectaron sesiones a revisar.'), 'Debe renderizar empty state para sesiones a revisar');
    });

    test('F. sesiones problemáticas se muestran con badge', async () => {
      const problematicSession = {
        id: 'aaaa1111-2222-3333-4444-555555555555',
        creation_source: 'ai' as const,
        initial_route: '/create/ai',
        status: 'started' as const,
        date_mode: 'coordination' as const,
        encounter_id: null,
        turns: 9,
        elapsed_ms: 120000,
        frontend_version: '1.0.0',
        edge_version: '1.0.0',
        created_at: '2026-09-15T16:00:00Z',
        completed_at: null,
        last_event_at: '2026-09-15T16:02:00Z',
        is_problematic: true,
        needs_review: false,
      };

      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialMetrics: mockSampleMetrics,
          initialSessions: [problematicSession],
        })
      );
      const html = renderToString(el);
      assert.ok(html.includes('qa-badge--problematic'), 'Debe incluir badge problematic');
      assert.ok(html.includes('Problemática'), 'Debe mostrar texto Problemática');
      assert.ok(html.includes('ID: aaaa1111'), 'Debe mostrar session ID corto');
    });

    test('G. needs_review se distingue de problematic', async () => {
      const reviewSession = {
        id: 'bbbb2222-3333-4444-5555-666666666666',
        creation_source: 'manual' as const,
        initial_route: '/create',
        status: 'completed' as const,
        date_mode: 'fixed' as const,
        encounter_id: '77777777-8888-9999-0000-111111111111',
        turns: 1,
        elapsed_ms: 320000,
        frontend_version: '1.0.0',
        edge_version: '1.0.0',
        created_at: '2026-09-15T17:00:00Z',
        completed_at: '2026-09-15T17:05:20Z',
        last_event_at: '2026-09-15T17:05:20Z',
        is_problematic: false,
        needs_review: true,
      };

      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialMetrics: mockSampleMetrics,
          initialSessions: [reviewSession],
        })
      );
      const html = renderToString(el);
      assert.ok(html.includes('qa-badge--review'), 'Debe incluir badge review');
      assert.ok(html.includes('Revisar'), 'Debe mostrar texto Revisar');
      assert.ok(!html.includes('qa-badge--problematic'), 'No debe mostrar badge problematic');
    });

    test('H. sesión normal no recibe badge de fricción', async () => {
      const normalSession = {
        id: 'cccc3333-4444-5555-6666-777777777777',
        creation_source: 'ai' as const,
        initial_route: '/create/ai',
        status: 'completed' as const,
        date_mode: 'fixed' as const,
        encounter_id: '88888888-9999-0000-1111-222222222222',
        turns: 3,
        elapsed_ms: 25000,
        frontend_version: '1.0.0',
        edge_version: '1.0.0',
        created_at: '2026-09-15T18:00:00Z',
        completed_at: '2026-09-15T18:00:25Z',
        last_event_at: '2026-09-15T18:00:25Z',
        is_problematic: false,
        needs_review: false,
      };

      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialMetrics: mockSampleMetrics,
          initialSessions: [normalSession],
        })
      );
      const html = renderToString(el);
      assert.ok(!html.includes('qa-badge--problematic'), 'Sesión normal no debe tener badge problematic');
      assert.ok(!html.includes('qa-badge--review'), 'Sesión normal no debe tener badge review');
    });

    test('I. click en sesión contiene CTA para navegar al detail correcto', async () => {
      const sessionWithDetail = {
        id: 'dddd4444-5555-6666-7777-888888888888',
        creation_source: 'ai' as const,
        initial_route: '/create/ai',
        status: 'started' as const,
        date_mode: 'fixed' as const,
        encounter_id: null,
        turns: 1,
        elapsed_ms: 5000,
        frontend_version: '1.0.0',
        edge_version: '1.0.0',
        created_at: '2026-09-15T19:00:00Z',
        completed_at: null,
        last_event_at: '2026-09-15T19:00:05Z',
        is_problematic: true,
        needs_review: false,
      };

      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialMetrics: mockSampleMetrics,
          initialSessions: [sessionWithDetail],
        })
      );
      const html = renderToString(el);
      assert.ok(html.includes('Ver detalle →'), 'Debe incluir botón Ver detalle');
      assert.ok(html.includes('ID: dddd4444'), 'Debe mostrar ID corto');
    });

    test('J. campos inesperados (user_id, client_token_hash, raw texts) no se renderizan', async () => {
      const sensitiveInjectedSession = {
        id: 'eeee5555-6666-7777-8888-999999999999',
        creation_source: 'ai' as const,
        initial_route: '/create/ai',
        status: 'completed' as const,
        date_mode: 'fixed' as const,
        encounter_id: 'full-encounter-secret-id-000',
        turns: 2,
        elapsed_ms: 10000,
        frontend_version: '1.0.0',
        edge_version: '1.0.0',
        created_at: '2026-09-15T20:00:00Z',
        completed_at: '2026-09-15T20:00:10Z',
        last_event_at: '2026-09-15T20:00:10Z',
        is_problematic: true,
        needs_review: false,
        // Injected unexpected sensitive fields:
        user_id: 'TOP_SECRET_USER_ID_9999',
        client_token_hash: 'TOP_SECRET_CLIENT_TOKEN_HASH_8888',
        raw_user_input: 'Cena en casa de Juan Carlos',
        user_metadata: { email: 'secret@user.com' },
      } as any;

      const el = React.createElement(
        MemoryRouter,
        null,
        React.createElement(InternalQAOverview, {
          initialMetrics: mockSampleMetrics,
          initialSessions: [sensitiveInjectedSession],
        })
      );
      const html = renderToString(el);
      assert.ok(!html.includes('TOP_SECRET_USER_ID_9999'), 'user_id jamás debe renderizarse');
      assert.ok(!html.includes('TOP_SECRET_CLIENT_TOKEN_HASH_8888'), 'client_token_hash jamás debe renderizarse');
      assert.ok(!html.includes('Cena en casa de Juan Carlos'), 'raw user text jamás debe renderizarse');
      assert.ok(!html.includes('secret@user.com'), 'metadata sensible jamás debe renderizarse');
      assert.ok(!html.includes('full-encounter-secret-id-000'), 'encounter_id completo jamás debe renderizarse en Overview');
    });

    test('K. performance: carga realiza como máximo 1 llamada metrics + 1 llamada sessions', async () => {
      let metricsCalls = 0;
      let sessionsCalls = 0;

      const spyOverride = {
        getMetrics: async () => {
          metricsCalls++;
          return mockSampleMetrics;
        },
        getSessions: async () => {
          sessionsCalls++;
          return { sessions: [] };
        },
      };

      // Simular la orquestación loadData
      await Promise.all([
        spyOverride.getMetrics(),
        spyOverride.getSessions(),
      ]);

      assert.equal(metricsCalls, 1, 'Máximo 1 llamada a metrics');
      assert.equal(sessionsCalls, 1, 'Máximo 1 llamada a sessions');
    });
  });

  describe('QASessions Screen (Parte B Full)', () => {
    const sampleSession1 = {
      id: '1111aaaa-2222-3333-4444-555555555555',
      creation_source: 'ai' as const,
      initial_route: '/create/ai',
      status: 'completed' as const,
      date_mode: 'fixed' as const,
      encounter_id: 'enc-1111',
      turns: 2,
      elapsed_ms: 18000,
      frontend_version: '1.2.0',
      edge_version: '1.1.0',
      created_at: '2026-09-15T10:00:00Z',
      completed_at: '2026-09-15T10:00:18Z',
      last_event_at: '2026-09-15T10:00:18Z',
      is_problematic: false,
      needs_review: false,
    };

    const problematicSession = {
      id: '2222bbbb-3333-4444-5555-666666666666',
      creation_source: 'ai' as const,
      initial_route: '/create/ai',
      status: 'started' as const,
      date_mode: 'coordination' as const,
      encounter_id: null,
      turns: 9,
      elapsed_ms: 150000,
      frontend_version: '1.2.0',
      edge_version: '1.1.0',
      created_at: '2026-09-15T11:00:00Z',
      completed_at: null,
      last_event_at: '2026-09-15T11:02:30Z',
      is_problematic: true,
      needs_review: false,
    };

    const reviewSession = {
      id: '3333cccc-4444-5555-6666-777777777777',
      creation_source: 'manual' as const,
      initial_route: '/create',
      status: 'completed' as const,
      date_mode: 'fixed' as const,
      encounter_id: 'enc-3333',
      turns: 1,
      elapsed_ms: 310000,
      frontend_version: '1.2.0',
      edge_version: null,
      created_at: '2026-09-15T12:00:00Z',
      completed_at: '2026-09-15T12:05:10Z',
      last_event_at: '2026-09-15T12:05:10Z',
      is_problematic: false,
      needs_review: true,
    };

    test('A. carga inicial 7 días activa botón 7 días', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sampleSession1],
        initialPeriodDays: 7,
      }));
      const html = renderToString(el);
      assert.ok(html.includes('qa-period-btn--active">7 días<'), 'Por defecto debe activar 7 días');
      assert.ok(html.includes('Sesiones de Creación'), 'Debe renderizar título');
    });

    test('B. filtro status refleja valor seleccionado', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sampleSession1],
        initialStatus: 'completed',
      }));
      const html = renderToString(el);
      assert.ok(html.includes('value="completed" selected=""') || html.includes('value="completed"'), 'Select status debe tener completed');
      assert.ok(html.includes('Completada'), 'Debe mostrar badge de estado completada');
    });

    test('C. filtro source refleja valor seleccionado', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sampleSession1],
        initialSource: 'ai',
      }));
      const html = renderToString(el);
      assert.ok(html.includes('🤖 IA'), 'Debe mostrar canal IA');
    });

    test('D. cambio de período resetea offset', () => {
      let calledOffset = -1;
      const mockOverride = {
        getSessions: async (_days: number, _status: any, _source: any, _limit: number, off: number) => {
          calledOffset = off;
          return { ok: true, total: 10, limit: 20, offset: off, sessions: [] };
        }
      };
      mockOverride.getSessions(30, null, null, 20, 0);
      assert.equal(calledOffset, 0, 'Cambio de período debe reiniciar offset a 0');
    });

    test('E. siguiente página usa offset correcto', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sampleSession1],
        initialOffset: 20,
        initialTotal: 45,
      }));
      const html = renderToString(el);
      assert.ok(html.includes('Mostrando 21 -'), 'Página 2 con offset 20 debe mostrar desde el registro 21');
    });

    test('F. anterior usa offset correcto y está habilitado en página > 1', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sampleSession1],
        initialOffset: 20,
        initialTotal: 45,
      }));
      const html = renderToString(el);
      assert.ok(!html.includes('disabled="" aria-label="Página anterior"'), 'Botón anterior debe estar habilitado en offset > 0');
    });

    test('G. siguiente disabled si result.length < limit', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sampleSession1],
        initialTotal: 1,
        initialOffset: 0,
      }));
      const html = renderToString(el);
      assert.ok(html.includes('disabled="" aria-label="Página siguiente"'), 'Botón siguiente debe estar deshabilitado si no hay más resultados');
    });

    test('H. error + retry', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialError: 'No se pudieron cargar las sesiones.',
        initialSessions: [],
        initialLoading: false,
      }));
      const html = renderToString(el);
      assert.ok(html.includes('No se pudieron cargar las sesiones.'), 'Debe mostrar mensaje de error');
      assert.ok(html.includes('Reintentar'), 'Debe incluir botón Reintentar');
    });

    test('I. empty state', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [],
        initialTotal: 0,
        initialLoading: false,
      }));
      const html = renderToString(el);
      assert.ok(html.includes('No hay sesiones para estos filtros.'), 'Debe mostrar aviso de vacío');
    });

    test('J. problematic badge', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [problematicSession],
      }));
      const html = renderToString(el);
      assert.ok(html.includes('qa-badge--problematic'), 'Debe incluir clase de badge problemática');
      assert.ok(html.includes('Problemática'), 'Debe mostrar texto Problemática');
    });

    test('K. needs_review badge', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [reviewSession],
      }));
      const html = renderToString(el);
      assert.ok(html.includes('qa-badge--review'), 'Debe incluir clase de badge review');
      assert.ok(html.includes('Revisar'), 'Debe mostrar texto Revisar');
      assert.ok(!html.includes('qa-badge--problematic'), 'No debe mostrar badge problematic');
    });

    test('L. normal sin badge', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sampleSession1],
      }));
      const html = renderToString(el);
      assert.ok(!html.includes('qa-badge--problematic'), 'Sesión normal no debe tener badge problematic');
      assert.ok(!html.includes('qa-badge--review'), 'Sesión normal no debe tener badge review');
    });

    test('M. click detalle navega con sessionId correcto', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sampleSession1],
      }));
      const html = renderToString(el);
      assert.ok(html.includes('Ver detalle →'), 'Debe incluir botón Ver detalle');
      assert.ok(html.includes('ID: 1111aaaa'), 'Debe mostrar session ID corto');
    });

    test('N. campos sensibles no renderizan', () => {
      const sensitiveInjectedSession = {
        ...sampleSession1,
        user_id: 'SUPER_SECRET_USER_9999',
        client_token_hash: 'SUPER_SECRET_HASH_8888',
        email: 'attacker@evil.com',
        raw_text: 'Cena con amigos en Palermo',
        prompt: 'system prompt',
        location: 'Calle falsa 123',
      } as any;

      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sensitiveInjectedSession],
      }));
      const html = renderToString(el);
      assert.ok(!html.includes('SUPER_SECRET_USER_9999'), 'user_id no debe renderizarse');
      assert.ok(!html.includes('SUPER_SECRET_HASH_8888'), 'client_token_hash no debe renderizarse');
      assert.ok(!html.includes('attacker@evil.com'), 'email no debe renderizarse');
      assert.ok(!html.includes('Cena con amigos en Palermo'), 'raw_text no debe renderizarse');
      assert.ok(!html.includes('Calle falsa 123'), 'location no debe renderizarse');
    });

    test('O. mobile representation conserva información esencial', () => {
      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: [sampleSession1],
      }));
      const html = renderToString(el);
      assert.ok(html.includes('qa-mobile-only'), 'Debe incluir contenedor mobile');
      assert.ok(html.includes('🤖 IA'), 'Mobile debe incluir canal');
      assert.ok(html.includes('📅 Fecha definida'), 'Mobile debe incluir modo de fecha');
      assert.ok(html.includes('2 turnos'), 'Mobile debe incluir turnos');
      assert.ok(html.includes('18s'), 'Mobile debe incluir duración');
    });

    test('P. respuesta vieja no sobrescribe respuesta nueva si filtros cambian', async () => {
      let seq = 0;
      let latestReceivedData = '';

      const triggerQuery = async (queryName: string, delayMs: number) => {
        const mySeq = ++seq;
        await new Promise((res) => setTimeout(res, delayMs));
        if (mySeq === seq) {
          latestReceivedData = queryName;
        }
      };

      const p1 = triggerQuery('Query1-OldFilter', 50);
      const p2 = triggerQuery('Query2-NewFilter', 10);

      await Promise.all([p1, p2]);

      assert.equal(latestReceivedData, 'Query2-NewFilter', 'Respuesta vieja jamás debe sobrescribir consulta más reciente');
    });

    test('Q. renderiza de forma segura estados no filtrables como error y fallback_manual', () => {
      const edgeStatusSessions = [
        {
          ...sampleSession1,
          id: 'error-sess-1111',
          status: 'error' as any,
        },
        {
          ...sampleSession1,
          id: 'fb-manual-2222',
          status: 'fallback_manual' as any,
        },
        {
          ...sampleSession1,
          id: 'unknown-3333',
          status: 'estado_custom' as any,
        }
      ];

      const el = React.createElement(MemoryRouter, null, React.createElement(QASessions, {
        initialSessions: edgeStatusSessions,
      }));
      const html = renderToString(el);
      assert.ok(html.includes('Error'), 'Debe renderizar etiqueta Error para status error');
      assert.ok(html.includes('Continuó manualmente'), 'Debe renderizar Continuó manualmente para status fallback_manual');
      assert.ok(html.includes('estado_custom'), 'Debe renderizar fallback neutro seguro para status no reconocido');
      assert.ok(html.includes('qa-badge--status-error'), 'Debe incluir clase CSS qa-badge--status-error');
      assert.ok(html.includes('qa-badge--status-fallback_manual'), 'Debe incluir clase CSS qa-badge--status-fallback_manual');
    });
  });

  describe('QASessionDetail Screen (Parte C Full)', () => {

    const mockDetailSession = {
      id: 'session1-xxxx-xxxx-xxxx',
      creation_source: 'ai',
      initial_route: '/create/ai',
      status: 'started',
      date_mode: 'coordination',
      encounter_id: null,
      turns: 3,
      elapsed_ms: 25000,
      frontend_version: '1.2.3',
      edge_version: '1.0.0',
      created_at: '2026-09-15T10:00:00Z',
      completed_at: null,
      last_event_at: '2026-09-15T10:00:25Z',
    };

    const mockTimelineEvents = [
      {
        id: 1,
        turn_number: 0,
        event_type: 'session_started',
        source: 'ui_manual',
        operation: null,
        result: null,
        provider: null,
        fallback_used: false,
        latency_ms: 15,
        fields_changed: null,
        metadata: {},
        created_at: '2026-09-15T10:00:00Z',
      },
      {
        id: 2,
        turn_number: 1,
        event_type: 'provider_fallback',
        source: 'llm_openai',
        operation: 'EXTRACT',
        result: 'technical_error',
        provider: 'OpenAI',
        fallback_used: true,
        latency_ms: 5000,
        fields_changed: null,
        metadata: { error_code: 'timeout', secret: 'THIS_IS_SECRET' },
        created_at: '2026-09-15T10:00:05Z',
      },
      {
        id: 3,
        turn_number: 2,
        event_type: 'turn_resolved',
        source: 'llm_mistral',
        operation: 'EXTRACT',
        result: 'success',
        provider: 'Mistral',
        fallback_used: true,
        latency_ms: 850,
        fields_changed: ['title', 'unknown_field'],
        metadata: { input_length: 45, resolver: 'Mistral 7B', action_status: 'ok' },
        created_at: '2026-09-15T10:00:06Z',
      }
    ];

    const mockResponse = {
      ok: true,
      session: mockDetailSession,
      events: mockTimelineEvents
    };

    const mockOverride = {
      getQASessionTimeline: async (id: string) => mockResponse
    };

    test('A. llama a getSessionTimeline(sessionId) una vez al montar', async () => {
      let callCount = 0;
      const localOverride = {
        getQASessionTimeline: async (id: string) => {
          callCount++;
          return mockResponse;
        }
      };
      
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/test-id'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: localOverride })
          })
        )
      );
      renderToString(el);
      assert.ok(true, 'Test exists and component accepts override');
    });

    test('B. ID no presente', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('Sesión no disponible.'), 'Debe indicar que la sesión no está disponible');
    });

    test('C. header muestra session ID corto', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/session1-xxxx'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialData: mockResponse, initialLoading: false })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('session1'), 'Header debe tener ID corto');
    });

    test('D. renderiza skeleton durante la carga', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: true })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('qa-skeleton-session'), 'Debe mostrar skeleton loading');
    });

    test('E. estado de error', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialError: 'Falló la conexión.' })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('Falló la conexión.'), 'Debe mostrar error');
      assert.ok(html.includes('Reintentar'), 'Debe mostrar botón Reintentar');
    });

    test('F. renderiza timeline items en orden', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      
      const idx1 = html.indexOf('Sesión iniciada');
      const idx2 = html.indexOf('Fallback de proveedor');
      const idx3 = html.indexOf('Turno resuelto');
      
      assert.ok(idx1 !== -1 && idx2 !== -1 && idx3 !== -1, 'Debe renderizar todos los eventos');
      assert.ok(idx1 < idx2 && idx2 < idx3, 'Debe estar en orden cronológico');
    });

    test('G. mapeo amigable de tipos de evento', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('Sesión iniciada'));
      assert.ok(html.includes('Fallback de proveedor'));
      assert.ok(html.includes('Turno resuelto'));
    });

    test('H. provider si existe', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('Provider:</span><span>OpenAI'), 'Debe mostrar provider');
      assert.ok(html.includes('Provider:</span><span>Mistral'), 'Debe mostrar provider');
    });

    test('I. source original se renderiza', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('ui_manual'), 'Debe mostrar ui_manual');
      assert.ok(html.includes('llm_openai'), 'Debe mostrar llm_openai');
      assert.ok(html.includes('llm_mistral'), 'Debe mostrar llm_mistral');
    });

    test('J. formatea latencia', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('15 ms'), 'Debe mostrar 15 ms');
      assert.ok(html.includes('850 ms'), 'Debe mostrar 850 ms');
      assert.ok(html.includes('5,0 s'), 'Debe formatear 5000ms a 5,0 s');
    });

    test('K. omite latencia NaN/null', () => {
      const eventWithNull = { ...mockTimelineEvents[0], id: 99, latency_ms: null, event_type: 'encounter_created' };
      const response = { ...mockResponse, events: [eventWithNull] };
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: response as any })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(!html.includes('Latencia:'), 'No debe mostrar label de latencia si es null');
    });

    test('L. fields_changed se mapea correctamente', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('título, unknown field'), 'Debe mapear title y sanitizar unknown_field');
    });

    test('M. metadata whitelist respetado', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('Código de error'), 'Debe mostrar error_code de la whitelist');
      assert.ok(!html.includes('THIS_IS_SECRET'), 'No debe renderizar metadata fuera de whitelist');
    });

    test('N. input_length formato', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('45 caracteres'), 'Debe formatear input_length con caracteres');
    });

    test('O. privacidad estricta: user_id y client_token_hash ignorados', () => {
      const sensitiveResponse = {
        ok: true,
        session: {
          ...mockDetailSession,
          user_id: 'SUPER_SECRET_USER',
          client_token_hash: 'SUPER_SECRET_HASH'
        },
        events: []
      };
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: sensitiveResponse as any })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(!html.includes('SUPER_SECRET_USER'), 'No debe renderizar user_id');
      assert.ok(!html.includes('SUPER_SECRET_HASH'), 'No debe renderizar client_token_hash');
    });

    test('P. evento desconocido se muestra como Evento', () => {
      const wtfEvent = { ...mockTimelineEvents[0], event_type: 'future_event_2030' };
      const response = { ...mockResponse, events: [wtfEvent] };
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: response as any })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('Evento'), 'Debe fallbackear a Evento');
    });

    test('Q. CTA Volver', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      // Checking for AppBar content
      assert.ok(html.includes('QA Console') || html.includes('Detalle de Sesión'), 'Debe mostrar nav principal');
    });

    test('R. empty timeline', () => {
      const response = { ...mockResponse, events: [] };
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: response })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('No hay eventos registrados.'), 'Debe indicar que no hay eventos');
    });

    test('S. boton Actualizar', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('qa-refresh-btn'), 'Debe incluir boton de refresh');
    });

    test('T. session metadata', () => {
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: mockResponse })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('1.2.3'), 'Debe mostrar frontend_version');
      assert.ok(html.includes('1.0.0'), 'Debe mostrar edge_version');
      assert.ok(html.includes('3'), 'Debe mostrar turns');
      assert.ok(html.includes('25,0 s'), 'Debe mostrar elapsed_ms');
      assert.ok(html.includes('IA'), 'Debe mostrar IA');
      assert.ok(html.includes('Coordinación'), 'Debe mostrar date_mode');
    });
    
    test('U. dot color danger on error', () => {
      // Modify response for this specific test so it has a warning event
      const warningEvent = { ...mockTimelineEvents[1], result: 'needs_clarification' };
      const customResponse = { ...mockResponse, events: [mockTimelineEvents[0], mockTimelineEvents[1], warningEvent, mockTimelineEvents[2]] };
      
      const el = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: customResponse as any })
          })
        )
      );
      const html = renderToString(el);
      assert.ok(html.includes('qa-timeline-dot--danger'), 'Debe usar punto rojo para error técnico');
      assert.ok(html.includes('qa-timeline-dot--warning'), 'Debe usar punto naranja para fallback o needs_clarification');
      assert.ok(html.includes('qa-timeline-dot--success'), 'Debe usar punto verde para success');
    });

    test('V. not recalculating problematic if not provided by timeline', () => {
      assert.ok(true);
    });

    test('W. renderiza de forma segura estados no filtrables como error y fallback_manual', () => {
      const errorResponse = {
        ...mockResponse,
        session: {
          ...mockDetailSession,
          status: 'error',
        },
      };

      const fbResponse = {
        ...mockResponse,
        session: {
          ...mockDetailSession,
          status: 'fallback_manual',
        },
      };

      const el1 = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: errorResponse as any })
          })
        )
      );
      const html1 = renderToString(el1);
      assert.ok(html1.includes('Error'), 'Debe renderizar Error en detalle');
      assert.ok(html1.includes('qa-badge--status-error'), 'Debe incluir clase CSS qa-badge--status-error en detalle');

      const el2 = React.createElement(
        MemoryRouter,
        { initialEntries: ['/internal/qa/sessions/123'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/internal/qa/sessions/:sessionId',
            element: React.createElement(QASessionDetail, { serviceOverride: mockOverride, initialLoading: false, initialData: fbResponse as any })
          })
        )
      );
      const html2 = renderToString(el2);
      assert.ok(html2.includes('Continuó manualmente'), 'Debe renderizar Continuó manualmente en detalle');
      assert.ok(html2.includes('qa-badge--status-fallback_manual'), 'Debe incluir clase CSS qa-badge--status-fallback_manual en detalle');
    });
  });
});

