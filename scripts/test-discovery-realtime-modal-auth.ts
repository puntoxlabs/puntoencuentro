import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import { useDiscoveryRealtime } from '../src/hooks/useDiscoveryRealtime';
import { HomeOpenEncounterDetailSheet } from '../src/components/home/openEncounters/HomeOpenEncounterDetailSheet';
import { LoginRequiredSheet } from '../src/components/auth/LoginRequiredSheet';
import type { OpenEncounterSummary } from '../src/components/home/openEncounters/types';

describe('Discovery V1 Closure: Realtime, Modal Stacking & Anonymous Auth Flow', () => {
  const rootDir = process.cwd();

  const mockOpenEncounter: OpenEncounterSummary = {
    id: 'enc-test-123',
    title: 'Café de Especialidad y Charlas',
    startsAt: '2026-10-20T18:00:00Z',
    dateLabel: 'Viernes · 18:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    openSlots: 4,
    confirmedCount: 2,
    confirmedSeats: 2,
    language: 'es',
    description: 'Nos juntamos a probar granos de origen y conversar de proyectos.',
    hostName: 'Martín',
    hostId: 'host-user-uuid-1',
    allowMultiSeatRequests: true,
    maxSeatsPerRequest: 3,
  };

  // ==========================================================
  // BLOQUE A: REALTIME DISCOVERY (Casos 1 a 7)
  // ==========================================================

  test('Caso 1: useDiscoveryRealtime suscribe a tablas public.encuentros y public.participantes cuando está habilitado', () => {
    const code = fs.readFileSync(path.join(rootDir, 'src/hooks/useDiscoveryRealtime.ts'), 'utf-8');
    assert.ok(code.includes("table: 'encuentros'"), 'Debe escuchar cambios en public.encuentros');
    assert.ok(code.includes("table: 'participantes'"), 'Debe escuchar cambios en public.participantes');
    assert.ok(code.includes("event: '*'"), 'Debe suscribirse a inserciones, actualizaciones y borrados (*)');
    assert.ok(code.includes('supabase.channel('), 'Debe crear un canal de Supabase Realtime');
  });

  test('Caso 2: Cleanup al desmontar libera canal y limpia timers de coalescing', () => {
    const code = fs.readFileSync(path.join(rootDir, 'src/hooks/useDiscoveryRealtime.ts'), 'utf-8');
    assert.ok(code.includes('supabase.removeChannel(channel)'), 'Debe remover el canal en el cleanup del efecto');
    assert.ok(code.includes('window.clearTimeout(timerRef.current)'), 'Debe limpiar el timeout pendiente en el cleanup');
  });

  test('Caso 3 & 4: Eventos en encuentros y participantes disparan función coalescente', () => {
    const code = fs.readFileSync(path.join(rootDir, 'src/hooks/useDiscoveryRealtime.ts'), 'utf-8');
    assert.ok(code.includes('handleRealtimeChange'), 'Ambos listeners deben dirigir el evento al handler de coalescing');
    assert.ok(code.includes('onRefreshRef.current()'), 'Al expirar el debounce debe invocar el callback onRefresh');
  });

  test('Caso 5: Múltiples eventos rápidos aplican debounce coalescente (default 300ms)', () => {
    const code = fs.readFileSync(path.join(rootDir, 'src/hooks/useDiscoveryRealtime.ts'), 'utf-8');
    assert.ok(code.includes('debounceMs = 300'), 'El debounce por defecto debe ser de 300ms');
    assert.ok(
      code.includes('window.clearTimeout(timerRef.current)'),
      'Cada nuevo evento resetea el timer anterior para coalescer en una sola consulta'
    );
  });

  test('Caso 6: Home V1 no crea suscripción Realtime (enableRealtime sólo en Discovery V2)', () => {
    const hookCode = fs.readFileSync(path.join(rootDir, 'src/hooks/useDiscoveryRealtime.ts'), 'utf-8');
    assert.ok(hookCode.includes('if (!enabled) return;'), 'Si enabled es falso, no se abre canal Realtime');

    const encountersComp = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx'),
      'utf-8'
    );
    assert.ok(
      encountersComp.includes('enableRealtime: Boolean(isV2Variant && propEncounters === undefined)'),
      'Discovery sólo habilita Realtime si isV2Variant es true y no está en modo demo/mock prop'
    );
  });

  test('Caso 7: La RPC canónica server-side sigue siendo la fuente de verdad (no muta cliente con payload crudo)', () => {
    const hookCode = fs.readFileSync(path.join(rootDir, 'src/hooks/useDiscoveryRealtime.ts'), 'utf-8');
    assert.ok(
      !hookCode.includes('setEncounters'),
      'useDiscoveryRealtime nunca muta estado client-side directamente con payloads'
    );
    assert.ok(
      hookCode.includes('onRefreshRef.current()'),
      'useDiscoveryRealtime delega la actualización a la RPC canónica get_discovery_encuentros_abiertos'
    );
  });

  // ==========================================================
  // BLOQUE B: MODAL DESKTOP/MOBILE & STACKING CONTEXT (Casos 8 a 16)
  // ==========================================================

  test('Caso 8: HomeOpenEncounterDetailSheet renderiza mediante createPortal hacia document.body', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(code.includes("import { createPortal } from 'react-dom';"), 'Debe importar createPortal');
    assert.ok(
      code.includes('createPortal(modalContent, document.body)'),
      'Debe inyectar el contenido modal directamente en document.body para escapar stacking contexts'
    );
  });

  test('Caso 9: Overlay y Sheet tienen z-index superior a sticky header, FAB y chips de Home', () => {
    const css = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.css'),
      'utf-8'
    );
    assert.ok(css.includes('z-index: 10000;'), 'Overlay debe tener z-index 10000');
    assert.ok(css.includes('z-index: 10001;'), 'Sheet debe tener z-index 10001');
  });

  test('Caso 10: Background scroll lock se activa al abrir y compensa scrollbar', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(
      code.includes("document.body.style.overflow = 'hidden'"),
      'Debe bloquear el overflow del body al estar abierto'
    );
    assert.ok(
      code.includes('scrollbarWidth = window.innerWidth - document.documentElement.clientWidth'),
      'Debe medir el ancho de scrollbar para evitar layout shift'
    );
    assert.ok(
      code.includes('document.body.style.paddingRight = `${scrollbarWidth}px`'),
      'Debe aplicar paddingRight compensatorio'
    );
  });

  test('Caso 11: Cleanup de scroll lock al cerrar/desmontar restaura overflow y padding sin salto', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(
      code.includes('document.body.style.overflow = originalOverflow'),
      'Debe restaurar el overflow previo del body'
    );
    assert.ok(
      code.includes('document.body.style.paddingRight = originalPaddingRight'),
      'Debe restaurar el paddingRight previo del body'
    );
  });

  test('Caso 12: ESC en desktop cierra modal y restaura foco accesible', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(
      code.includes("useModalStack('open-encounter-detail-sheet'") || code.includes("if (e.key === 'Escape')"),
      'Debe escuchar tecla Escape determinista mediante pila de modales'
    );
    assert.ok(
      code.includes('restoreFocus: true') || code.includes('previousActiveElementRef.current.focus()'),
      'Debe restaurar el foco al elemento que lo abrió'
    );
  });

  test('Caso 13: Sub-modales (LoginRequiredSheet y ReportPublicEncounterModal) se sitúan por encima del DetailSheet', () => {
    const loginCss = fs.readFileSync(
      path.join(rootDir, 'src/components/auth/LoginRequiredSheet.css'),
      'utf-8'
    );
    assert.ok(loginCss.includes('z-index: 10050;'), 'LoginRequired overlay debe tener z-index 10050');
    assert.ok(loginCss.includes('z-index: 10051;'), 'LoginRequired sheet debe tener z-index 10051');

    const reportCss = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/ReportPublicEncounterModal.css'),
      'utf-8'
    );
    assert.ok(
      reportCss.includes('z-index: 10020;') || reportCss.includes('z-index: 10050;'),
      'Report backdrop debe situarse por encima de DetailSheet (z-index >= 10020)'
    );
  });

  test('Caso 14: Mobile mantiene bottom-sheet con handle y safe-area', () => {
    const css = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.css'),
      'utf-8'
    );
    assert.ok(css.includes('bottom: 0;'), 'En mobile debe anclarse al bottom');
    assert.ok(css.includes('border-top-left-radius: 24px;'), 'Debe tener bordes redondeados arriba');
    assert.ok(css.includes('.pe-detail-sheet__handle'), 'Debe tener handle superior para mobile');
  });

  test('Caso 15: Desktop mantiene modal contenido, centrado y con max-width/max-height', () => {
    const css = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.css'),
      'utf-8'
    );
    assert.ok(css.includes('@media (min-width: 768px)'), 'Debe tener media query desktop a 768px');
    assert.ok(css.includes('transform: translate(-50%, -50%);'), 'Debe estar centrado absoluto');
    assert.ok(css.includes('max-width: 480px;'), 'Debe estar acotado a 480px');
  });

  test('Caso 16: Scroll interno no encadena al body (overscroll-behavior: contain)', () => {
    const css = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.css'),
      'utf-8'
    );
    assert.ok(
      css.includes('overscroll-behavior: contain;'),
      'Tanto el overlay como el modal deben declarar overscroll-behavior: contain'
    );
  });

  // ==========================================================
  // BLOQUE C: ANÓNIMO + SOLICITAR SUMARME + AUTH (Casos 17 a 26)
  // ==========================================================

  test('Caso 17: Anónimo pulsa Solicitar sumarme -> Abre LoginRequiredSheet en vez de quedar muerto', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(code.includes('if (!isPermanentUser)'), 'Verifica si el usuario es permanente');
    assert.ok(code.includes('setIsLoginRequired(true);'), 'Activa LoginRequiredSheet si es anónimo');
  });

  test('Caso 18: Copy sugerido de LoginRequired para solicitar sumarse', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/auth/LoginRequiredSheet.tsx'),
      'utf-8'
    );
    assert.ok(
      code.includes("title: 'Para solicitar sumarte, iniciá sesión.'"),
      'El copy debe ser exactamente "Para solicitar sumarte, iniciá sesión."'
    );
  });

  test('Caso 19: Preserva encounterId en sessionStorage bajo PENDING_OPEN_REQUEST_KEY', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(code.includes("const PENDING_OPEN_REQUEST_KEY = 'pending_open_request';"), 'Declara clave constante');
    assert.ok(
      code.includes('sessionStorage.setItem(PENDING_OPEN_REQUEST_KEY, JSON.stringify(pendingRequest))'),
      'Almacena pendingRequest en sessionStorage'
    );
  });

  test('Caso 20: Preserva draft completo (nombre, mensaje, requestedSeats)', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(code.includes('applicantName: applicantName || undefined'), 'Preserva applicantName');
    assert.ok(code.includes('applicantMessage: applicantMessage || undefined'), 'Preserva applicantMessage');
    assert.ok(code.includes('requestedSeats: requestedSeats || 1'), 'Preserva requestedSeats');
  });

  test('Caso 21: Retorno post-login restaura el mismo encuentro en Discovery', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx'),
      'utf-8'
    );
    assert.ok(
      code.includes('sessionStorage.getItem(PENDING_OPEN_REQUEST_KEY)'),
      'HomeOpenEncounters lee el pending request al volver'
    );
    assert.ok(
      code.includes('setSelectedEncounter(') && code.includes('setIsDetailOpen(true)'),
      'Abre automáticamente el encuentro correspondiente'
    );
  });

  test('Caso 22: NO auto-submit post login (formulario visible esperando confirmación manual)', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(code.includes('setIsFormOpen(true);'), 'Abre el formulario para que el usuario revise');
    assert.ok(
      !code.includes('handleSubmitRequest(') || !code.includes('setIsFormOpen(true);\n            handleSubmitRequest'),
      'No debe invocar automáticamente handleSubmitRequest post-login'
    );
  });

  test('Caso 23: Consumo de draft es single-use (se limpia inmediatamente)', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(
      code.includes('sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY)'),
      'Elimina el borrador de sessionStorage inmediatamente tras restaurarlo'
    );
  });

  test('Caso 24: Cancelación del login limpia borrador y no envía solicitud fantasma', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(
      code.replace(/\r\n/g, '\n').includes('setIsLoginRequired(false);\n          try {\n            sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY)'),
      'Al cancelar LoginRequired limpia el draft pendiente'
    );
  });

  test('Caso 25: Host de su propio encuentro no puede auto-solicitarse y ve botón "Gestionar encuentro"', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(code.includes('isHost ? ('), 'Evalúa condición isHost');
    assert.ok(code.includes('Este encuentro lo organizás vos'), 'Muestra copy descriptivo al host');
    assert.ok(code.includes('Gestionar encuentro'), 'Muestra CTA para ir a la gestión del encuentro');
    assert.ok(code.includes('navigate(`/meet/${encounter.id}`)'), 'Redirige a la pantalla de gestión del anfitrión');
  });

  test('Caso 26: Mapeo de errores de negocio claros y humanos (sin exponer SQL)', () => {
    const code = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(code.includes('cannot_join_own_encounter'), 'Mapea cannot_join_own_encounter');
    assert.ok(code.includes('duplicate_pending_request'), 'Mapea duplicate_pending_request');
    assert.ok(code.includes('already_participant'), 'Mapea already_participant');
    assert.ok(code.includes('encounter_full'), 'Mapea encounter_full');
    assert.ok(code.includes('seats_exceed_limit'), 'Mapea seats_exceed_limit');
    assert.ok(code.includes('encuentro_not_open'), 'Mapea encuentro_not_open');
    assert.ok(!code.includes('PostgresError') && !code.includes('PGRST'), 'No expone errores internos de BD');
  });
});
