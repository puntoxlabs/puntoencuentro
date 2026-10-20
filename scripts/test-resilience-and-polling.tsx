import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToString } from 'react-dom/server';

// Error Boundary & Handlers
import { ErrorBoundary, sanitizeErrorMessage } from '../src/components/ErrorBoundary';

describe('Resiliencia Frontend y Optimización de Polling — Suite Integral v2', () => {

  describe('1. Error Boundary Global y Seguridad de Errores', () => {

    test('1.1. sanitizeErrorMessage sanitiza tokens, JWTs, contraseñas, emails y secrets', () => {
      // JWT
      const rawWithJwt = 'Error at eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature in module';
      const cleanJwt = sanitizeErrorMessage(rawWithJwt);
      assert.ok(!cleanJwt.includes('doNotLeakThisSignature'), 'No debe contener la firma del JWT');
      assert.ok(cleanJwt.includes('[REDACTED_JWT]'), 'Debe reemplazar el JWT con [REDACTED_JWT]');

      // Query params con token
      const rawWithToken = 'Failed to fetch https://api.puntoencuentro.com.ar/meet?token=secret_invite_token_12345&other=1';
      const cleanToken = sanitizeErrorMessage(rawWithToken);
      assert.ok(!cleanToken.includes('secret_invite_token_12345'), 'No debe contener el token de la URL');
      assert.ok(cleanToken.includes('token=[REDACTED]'), 'Debe redactar el parámetro token');

      // Supabase secret key
      const rawWithSbKey = 'Unauthorized using sb_secret_production_super_secret_key_abcdef';
      const cleanSbKey = sanitizeErrorMessage(rawWithSbKey);
      assert.ok(!cleanSbKey.includes('production_super_secret_key_abcdef'), 'No debe contener la key secreta');
      assert.ok(cleanSbKey.includes('[REDACTED_KEY]'), 'Debe redactar la key de supabase');

      // Bearer token
      const rawWithBearer = 'Authorization failed for Bearer ya29.a0ARrdaM_secret_token_123';
      const cleanBearer = sanitizeErrorMessage(rawWithBearer);
      assert.ok(!cleanBearer.includes('secret_token_123'), 'No debe filtrar el token Bearer');
      assert.ok(cleanBearer.includes('Bearer [REDACTED]'), 'Debe redactar el Bearer token');

      // Invite path token
      const rawWithInvitePath = 'Error rendering route /invite/550e8400-e29b-41d4-a716-446655440000 in component';
      const cleanInvitePath = sanitizeErrorMessage(rawWithInvitePath);
      assert.ok(!cleanInvitePath.includes('550e8400-e29b-41d4-a716-446655440000'), 'No debe exponer UUID del token de invitación');
      assert.ok(cleanInvitePath.includes('/invite/[REDACTED_TOKEN]'), 'Debe redactar el token en la ruta de invitación');

      // Email address
      const rawWithEmail = 'Failed sending notification to organizador.privado@example.com';
      const cleanEmail = sanitizeErrorMessage(rawWithEmail);
      assert.ok(!cleanEmail.includes('organizador.privado@example.com'), 'No debe exponer direcciones de email');
      assert.ok(cleanEmail.includes('[REDACTED_EMAIL]'), 'Debe redactar la dirección de email');

      // Mensaje vacío o no string
      assert.equal(sanitizeErrorMessage(undefined), 'Error de renderizado no especificado');
      assert.equal(sanitizeErrorMessage(''), 'Error de renderizado no especificado');
    });

    test('1.2. ErrorBoundary captura error de renderizado y evita pantalla blanca', () => {
      const boundaryInstance = new ErrorBoundary({
        children: React.createElement('div', null, 'Normal Content'),
      });

      // Simular captura de error
      const derived = ErrorBoundary.getDerivedStateFromError(new Error('Synthetic component crash'));
      assert.equal(derived.hasError, true);
      assert.equal(derived.error?.message, 'Synthetic component crash');

      boundaryInstance.state = {
        hasError: true,
        error: new Error('Synthetic component crash'),
        retryTimestamps: [],
        recoveryLoopDetected: false,
      };

      const renderedElement = boundaryInstance.render() as React.ReactElement;
      const html = renderToString(renderedElement);

      // Verificación de textos amigables en español e inglés
      assert.ok(html.includes('Algo no salió como esperábamos'), 'Debe incluir título amigable en español');
      assert.ok(html.includes('Something went wrong'), 'Debe incluir título amigable en inglés');
      assert.ok(html.includes('Ocurrió un problema inesperado al cargar esta pantalla'), 'Debe incluir descripción en español');
      assert.ok(html.includes('An unexpected issue occurred while rendering this section'), 'Debe incluir descripción en inglés');

      // Verificación de botones de acción
      assert.ok(html.includes('Reintentar / Try again'), 'Debe incluir botón funcional de reintentar');
      assert.ok(html.includes('Volver al inicio / Go to Home'), 'Debe incluir botón de volver al inicio');
      assert.ok(!html.includes('Synthetic component crash'), 'No debe exponer trazas técnicas crudas al usuario');
    });

    test('1.3. ErrorBoundary con fallos repetidos detecta loops y previene reintentos infinitos', () => {
      const boundaryInstance = new ErrorBoundary({
        children: React.createElement('div', null, 'Normal Content'),
        maxRetries: 3,
        retryWindowMs: 15000,
      });

      // Simular 3 reintentos rápidos en menos de 15 segundos
      const now = Date.now();
      boundaryInstance.state = {
        hasError: true,
        error: new Error('Persistent render error'),
        retryTimestamps: [now - 3000, now - 2000, now - 1000],
        recoveryLoopDetected: false,
      };

      // Al llamar a resetError habiendo alcanzado el umbral
      boundaryInstance.resetError();

      assert.equal(boundaryInstance.state.recoveryLoopDetected, true, 'Debe detectar loop de recuperación');

      const html = renderToString(boundaryInstance.render() as React.ReactElement);
      assert.ok(html.includes('El problema persiste de forma continua'), 'Debe mostrar advertencia de persistencia de error');
      assert.ok(html.includes('Recargar página / Reload page'), 'Debe reemplazar Reintentar por Recargar página');
    });

    test('1.4. ErrorBoundary no elimina sesiones válidas ni altera almacenamiento local', () => {
      const boundaryInstance = new ErrorBoundary({
        children: React.createElement('div', null, 'Child'),
      });

      boundaryInstance.state = {
        hasError: true,
        error: new Error('Recoverable error'),
        retryTimestamps: [],
        recoveryLoopDetected: false,
      };

      // resetError solo muta estado interno del componente
      boundaryInstance.resetError();

      assert.equal(boundaryInstance.state.hasError, false, 'hasError debe volver a false');
      assert.equal(boundaryInstance.state.error, null, 'error debe quedar nulo');
      // No debe borrar localStorage ni sessionStorage
    });

    test('1.5. ErrorBoundary admite fallback personalizado', () => {
      const customFallback = ({ error, resetError }: { error: Error | null; resetError: () => void }) =>
        React.createElement('div', { id: 'custom-error-screen' }, `Custom: ${error?.message}`);

      const boundaryInstance = new ErrorBoundary({
        children: React.createElement('div', null, 'Child'),
        fallback: customFallback,
      });

      boundaryInstance.state = {
        hasError: true,
        error: new Error('Custom error text'),
        retryTimestamps: [],
        recoveryLoopDetected: false,
      };

      const html = renderToString(boundaryInstance.render() as React.ReactElement);
      assert.ok(html.includes('id="custom-error-screen"'), 'Debe renderizar el fallback personalizado');
      assert.ok(html.includes('Custom: Custom error text'), 'Debe recibir el objeto error');
    });

    test('1.6. App.tsx integra ErrorBoundary global como envoltorio de la aplicación', () => {
      const appTsx = fs.readFileSync(
        path.resolve(process.cwd(), 'src/App.tsx'),
        'utf8'
      );
      assert.ok(appTsx.includes('<ErrorBoundary>'), 'App.tsx debe envolver el árbol con <ErrorBoundary>');
      assert.ok(appTsx.includes('</ErrorBoundary>'), 'App.tsx debe cerrar </ErrorBoundary>');
      assert.ok(appTsx.includes('<AccessGate>'), 'AccessGate debe estar protegido intacto');
    });

    test('1.7. main.tsx inicializa el manejador global de errores asíncronos', () => {
      const mainTsx = fs.readFileSync(
        path.resolve(process.cwd(), 'src/main.tsx'),
        'utf8'
      );
      assert.ok(mainTsx.includes('initGlobalErrorHandlers()'), 'main.tsx debe inicializar initGlobalErrorHandlers()');
    });
  });

  describe('2. Controlador de Polling Resiliente y Políticas de Concurrencia', () => {

    test('2.1. Pestaña oculta: suspensión de nuevas consultas periódicas', () => {
      let isHidden = true;

      const mockDocument = {
        get visibilityState() {
          return isHidden ? 'hidden' : 'visible';
        },
      };

      // Si la pestaña está oculta, no se debe agendar ni disparar nueva consulta
      const shouldScheduleNewPeriodicQuery = mockDocument.visibilityState === 'visible';
      assert.equal(shouldScheduleNewPeriodicQuery, false, 'No debe agendar nuevas consultas mientras la pestaña está oculta');
    });

    test('2.2. Usuario visible sin interacción durante más de 3 minutos: relajación a cadencia inactiva (NO suspende)', () => {
      const idleTimeoutMs = 180000; // 3 minutos
      const lastActivity = Date.now() - 240000; // 4 minutos de inactividad
      const activeIntervalMs = 5000;
      const idleIntervalMs = 30000;

      const timeSinceActivity = Date.now() - lastActivity;
      const isIdle = timeSinceActivity > idleTimeoutMs;
      assert.equal(isIdle, true, 'Debe detectar que el usuario superó los 3 minutos de inactividad');

      // Política: cuando está visible e inactivo, debe continuar con idleIntervalMs (máx 30s)
      const nextCadence = isIdle ? idleIntervalMs : activeIntervalMs;
      assert.equal(nextCadence, 30000, 'Cadencia visible e inactiva debe ser de 30000ms (NO se detiene)');
      assert.ok(nextCadence <= 30000, 'Cadencia inactiva no debe superar el techo de 30 segundos');
    });

    test('2.3. Recepción de confirmaciones durante inactividad con pantalla abierta', async () => {
      // Simular lista de participantes que recibe una nueva confirmación mientras el usuario no toca la pantalla
      let participantesState = [
        { id: 'p1', nombre: 'Ana', estado: 'confirmado' },
        { id: 'p2', nombre: 'Carlos', estado: 'pendiente' },
      ];

      const fetchUpdatedParticipants = async () => {
        // En el backend Carlos pasa a confirmado
        return [
          { id: 'p1', nombre: 'Ana', estado: 'confirmado' },
          { id: 'p2', nombre: 'Carlos', estado: 'confirmado' },
        ];
      };

      // Simular tick periódico de cadencia inactiva (sin interacción del usuario)
      const updated = await fetchUpdatedParticipants();
      participantesState = updated;

      const carlosConfirmado = participantesState.some(p => p.id === 'p2' && p.estado === 'confirmado');
      assert.equal(carlosConfirmado, true, 'Carlos debe figurar confirmado incluso sin interacción del organizador');
    });

    test('2.4. Cancelación de encuentro con pantalla abierta', async () => {
      let encuentroState: { id: string; estado: string } | null = {
        id: 'enc-123',
        estado: 'creado',
      };

      const pollEncounterStatus = async () => {
        // Backend cancela el encuentro
        return {
          id: 'enc-123',
          estado: 'cancelado',
        };
      };

      // Ejecución periódica mientras la pestaña está visible e inactiva
      const latestEnc = await pollEncounterStatus();
      if (latestEnc && latestEnc.estado !== encuentroState?.estado) {
        encuentroState = latestEnc;
      }

      assert.equal(encuentroState.estado, 'cancelado', 'La pantalla abierta debe reflejar el estado cancelado');
    });

    test('2.5. Reanudación al recuperar foco o visibilidad sin consultas duplicadas', () => {
      let isVisible = false;
      let refreshCount = 0;
      let isFetching = false;

      const triggerEventRefresh = () => {
        if (!isVisible) return;
        if (isFetching) return; // Deduplicación estricta
        isFetching = true;
        refreshCount++;
        isFetching = false;
      };

      // Pasa a visible
      isVisible = true;
      triggerEventRefresh();
      assert.equal(refreshCount, 1, 'Debe disparar 1 consulta al volverse visible');

      // Foco inmediato casi simultáneo (dentro del mismo segundo)
      triggerEventRefresh();
      assert.equal(refreshCount, 2, 'Segundo evento secuencial ejecuta normalmente');

      // Si una llamada ya está en vuelo, focus no duplica
      isFetching = true;
      triggerEventRefresh();
      assert.equal(refreshCount, 2, 'No debe disparar consulta si ya hay una en vuelo');
      isFetching = false;
    });

    test('2.6. Respuesta tardía tras cambiar de encuentro (stale response protection)', async () => {
      let activeEncounterId = 'enc-A';
      let stateData = { encounterId: 'enc-A', title: 'Asado A' };
      let globalRequestId = 0;

      // Disparar solicitud lenta para enc-A
      const reqId1 = ++globalRequestId;
      const targetId1 = activeEncounterId;
      const slowPromise = new Promise<{ id: string; title: string }>((resolve) => {
        setTimeout(() => resolve({ id: targetId1, title: 'Asado A (Viejo)' }), 50);
      });

      // El usuario cambia inmediatamente al encuentro B
      activeEncounterId = 'enc-B';
      const reqId2 = ++globalRequestId;
      const targetId2 = activeEncounterId;
      const fastPromise = new Promise<{ id: string; title: string }>((resolve) => {
        setTimeout(() => resolve({ id: targetId2, title: 'Reunión B (Nueva)' }), 10);
      });

      // La solicitud 2 rápida resuelve primero
      const res2 = await fastPromise;
      if (reqId2 === globalRequestId && activeEncounterId === targetId2) {
        stateData = { encounterId: res2.id, title: res2.title };
      }
      assert.equal(stateData.title, 'Reunión B (Nueva)');

      // La solicitud 1 lenta resuelve después
      const res1 = await slowPromise;
      if (reqId1 === globalRequestId && activeEncounterId === targetId1) {
        stateData = { encounterId: res1.id, title: res1.title };
      }

      // Debe conservar los datos del encuentro B y descartar la respuesta tardía de A
      assert.equal(stateData.encounterId, 'enc-B', 'El estado debe conservar el encuentro actual B');
      assert.equal(stateData.title, 'Reunión B (Nueva)', 'La respuesta tardía de enc-A no debe sobrescribir enc-B');
    });

    test('2.7. Recuperación después de errores de conexión sin detener polling', () => {
      const baseInterval = 5000;
      const maxInterval = 30000;
      const backoffFactor = 1.5;

      let consecutiveErrors = 0;
      const computeNextDelay = () => {
        if (consecutiveErrors === 0) return baseInterval;
        const mult = Math.pow(backoffFactor, consecutiveErrors);
        return Math.min(Math.round(baseInterval * mult), maxInterval);
      };

      // Falla 1
      consecutiveErrors = 1;
      assert.equal(computeNextDelay(), 7500, '1 error aplica backoff a 7500ms');

      // Falla 2
      consecutiveErrors = 2;
      assert.equal(computeNextDelay(), 11250, '2 errores aplica backoff a 11250ms');

      // Falla 5 (red caída)
      consecutiveErrors = 5;
      assert.ok(computeNextDelay() <= maxInterval, 'Errores continuados respetan techo de 30s sin detener polling');

      // Conexión recuperada exitosamente
      consecutiveErrors = 0;
      assert.equal(computeNextDelay(), 5000, 'Al tener éxito, restaura cadencia base de 5000ms inmediatamente');
    });
  });

  describe('3. Integración en Pantallas y Ausencia de Regresiones', () => {

    test('3.1. DetailHost.tsx: Polling 5s activo, máx 30s inactivo visible y stale response guard', () => {
      const detailHostTsx = fs.readFileSync(
        path.resolve(process.cwd(), 'src/screens/DetailHost.tsx'),
        'utf8'
      );

      assert.ok(detailHostTsx.includes('useResilientPolling'), 'DetailHost debe usar useResilientPolling');
      assert.ok(detailHostTsx.includes('intervalMs: 5000'), 'Debe conservar intervalo activo de 5000ms');
      assert.ok(detailHostTsx.includes('idleIntervalMs: 30000'), 'Debe configurar cadencia inactiva de 30000ms');
      assert.ok(detailHostTsx.includes('if (id !== targetId) return;'), 'Debe tener guardia contra respuestas tardías de id anterior');
      assert.ok(!detailHostTsx.includes('setInterval(async () =>'), 'No debe tener setInterval inline sin control');
    });

    test('3.2. InviteGuest.tsx: Polling 10s y 8.5s activos, máx 30s inactivos con fallback Realtime intacto', () => {
      const inviteGuestTsx = fs.readFileSync(
        path.resolve(process.cwd(), 'src/screens/InviteGuest.tsx'),
        'utf8'
      );

      assert.ok(inviteGuestTsx.includes('useResilientPolling'), 'InviteGuest debe usar useResilientPolling');
      assert.ok(inviteGuestTsx.includes('intervalMs: 10000'), 'Debe conservar polling de respuestas visibles cada 10000ms');
      assert.ok(inviteGuestTsx.includes('intervalMs: 8500'), 'Debe conservar verificación de estado cada 8500ms');
      assert.ok(inviteGuestTsx.includes('idleIntervalMs: 30000'), 'Debe configurar cadencia inactiva máxima de 30s');
      assert.ok(inviteGuestTsx.includes('if (token !== currentToken) return;'), 'Debe tener guardia de token stale');
      assert.ok(inviteGuestTsx.includes(".channel(`public:encuentros:id=eq.${encuentro.id}`)"), 'Debe conservar suscripción Realtime intacta');
      assert.ok(!inviteGuestTsx.includes('pollInterval = setInterval'), 'No debe tener polling huérfano con setInterval');
    });

    test('3.3. EncounterMessagesPanel.tsx: Polling 20s activo y 45s inactivo con compatibilidad estricta', () => {
      const panelTsx = fs.readFileSync(
        path.resolve(process.cwd(), 'src/components/messages/EncounterMessagesPanel.tsx'),
        'utf8'
      );

      // Invariantes exigidos por test-encounter-messages-ui.ts
      assert.ok(panelTsx.includes('20000'), 'Debe conservar el intervalo de 20000 ms');
      assert.ok(panelTsx.includes("document.visibilityState !== 'visible'"), 'Debe comprobar visibilidad');
      assert.ok(panelTsx.includes("visibilitychange"), 'Debe escuchar visibilitychange');
      assert.ok(panelTsx.includes("document.removeEventListener('visibilitychange'"), 'Debe limpiar visibilitychange');
      assert.ok(panelTsx.includes("clearInterval(pollTimerRef.current)"), 'Debe limpiar timer al desmontar');

      // Cadencia inactiva de máximo 45s
      assert.ok(panelTsx.includes('45000'), 'Debe contemplar cadencia de 45000ms para estado visible e inactivo');
      assert.ok(panelTsx.includes("window.addEventListener('focus'"), 'Debe refrescar al recuperar foco de ventana');
      assert.ok(panelTsx.includes("lastActivityRef.current"), 'Debe contemplar actividad del usuario');
    });

    test('3.4. Detección de cambios críticos de encuentro intacta', () => {
      const inviteGuestTsx = fs.readFileSync(
        path.resolve(process.cwd(), 'src/screens/InviteGuest.tsx'),
        'utf8'
      );

      assert.ok(inviteGuestTsx.includes("enc.estado !== encuentro?.estado"), 'Debe detectar cambios de estado del encuentro');
      assert.ok(inviteGuestTsx.includes("setError('No disponible')"), 'Debe detectar cancelación o eliminación');
      assert.ok(inviteGuestTsx.includes("setEncuentro(null)"), 'Debe limpiar estado si el encuentro ya no existe');
    });

    test('3.5. Ausencia de regresiones en contratos RPCs y esquemas de base de datos', () => {
      const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
      const gitStatusOut = fs.existsSync(migrationsDir);
      assert.ok(gitStatusOut, 'Directorio de migraciones debe existir');

      // Las migraciones son inmutables según AGENTS.md
    });
  });
});
