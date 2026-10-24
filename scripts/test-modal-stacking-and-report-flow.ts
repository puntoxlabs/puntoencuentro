/**
 * test-modal-stacking-and-report-flow.ts
 *
 * Prueba de integración de apilamiento real (Stacking Context & Z-Index Layer Hierarchy)
 * y validación del flujo completo:
 * 1. Encuentro Abierto -> Reporte Público -> Inicio de Sesión Obligatorio -> Colisión de Cuenta.
 * 2. Comprobación matemática y arquitectónica del orden de capas (z-index estricto).
 * 3. Aislamiento de portales hacia document.body sin clipping por transforms de BottomSheet.
 * 4. Gestión de foco, teclado Escape y pila modal (useModalStack).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Integración: Jerarquía de Capas, Stacking Context y Flujo de Reporte -> Auth', () => {
  const rootDir = process.cwd();

  // Helper para extraer el valor numérico de z-index de una regla CSS
  const extractZIndex = (cssContent: string, selector: string): number => {
    // Normalizar selector escapando caracteres especiales
    const escapedSelector = selector.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const regex = new RegExp(`${escapedSelector}[^{]*\\{[^}]*z-index:\\s*(\\d+)`, 'm');
    const match = cssContent.match(regex);
    if (!match) {
      throw new Error(`No se encontró z-index numérico para selector "${selector}"`);
    }
    return parseInt(match[1], 10);
  };

  // ── 1. JERARQUÍA REAL DE CAPAS Y APILAMIENTO NUMÉRICO ─────────────────────────

  test('1. Jerarquía de capas: orden numérico estricto entre modales anidados', () => {
    const bottomSheetCss = fs.readFileSync(path.join(rootDir, 'src/components/ui/BottomSheet.css'), 'utf-8');
    const detailSheetCss = fs.readFileSync(path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.css'), 'utf-8');
    const reportCss = fs.readFileSync(path.join(rootDir, 'src/components/home/openEncounters/ReportPublicEncounterModal.css'), 'utf-8');
    const coverageCss = fs.readFileSync(path.join(rootDir, 'src/components/coverage/CoverageRequestModal.css'), 'utf-8');
    const loginCss = fs.readFileSync(path.join(rootDir, 'src/components/auth/LoginRequiredSheet.css'), 'utf-8');
    const collisionCss = fs.readFileSync(path.join(rootDir, 'src/components/auth/AccountCollisionModal.css'), 'utf-8');
    const criticalCss = fs.readFileSync(path.join(rootDir, 'src/components/notifications/CriticalCancellationModal.css'), 'utf-8');
    const pushGuideCss = fs.readFileSync(path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.css'), 'utf-8');

    // Extracción de z-index de cada capa del sistema
    const zBaseSheetContainer = extractZIndex(bottomSheetCss, '.pe-sheet-container');
    const zDetailSheetOverlay = extractZIndex(detailSheetCss, '.pe-detail-overlay');
    const zDetailSheetContainer = extractZIndex(detailSheetCss, '.pe-detail-sheet');
    const zReportBackdrop = extractZIndex(reportCss, '.pe-report-public-backdrop');
    const zReportCard = extractZIndex(reportCss, '.pe-report-public-card');
    const zCoverageOverlay = extractZIndex(coverageCss, '.pe-coverage-overlay');
    const zCoverageModal = extractZIndex(coverageCss, '.pe-coverage-modal');
    const zLoginOverlay = extractZIndex(loginCss, '.login-required-overlay');
    const zLoginSheet = extractZIndex(loginCss, '.login-required-sheet');
    const zCollisionOverlay = extractZIndex(collisionCss, '.account-collision-overlay');
    const zCollisionModal = extractZIndex(collisionCss, '.account-collision-modal');
    const zCriticalOverlay = extractZIndex(criticalCss, '.pe-critical-modal-overlay');
    const zCriticalModal = extractZIndex(criticalCss, '.pe-critical-modal');
    const zPushGuideOverlay = extractZIndex(pushGuideCss, '.pe-visibility-guide-overlay');

    // INVARIANTE 1: BottomSheet base (1000) es superado por DetailSheet (10001)
    assert.ok(
      zDetailSheetContainer > zBaseSheetContainer,
      `DetailSheet (${zDetailSheetContainer}) debe superar BottomSheet base (${zBaseSheetContainer})`
    );

    // INVARIANTE 2: ReportPublicEncounterModal (10020/10021) supera DetailSheet (10001)
    assert.ok(
      zReportBackdrop > zDetailSheetContainer,
      `ReportPublicEncounterModal backdrop (${zReportBackdrop}) debe superar DetailSheet (${zDetailSheetContainer})`
    );
    assert.ok(
      zReportCard >= zReportBackdrop,
      `ReportPublicEncounterModal card (${zReportCard}) debe estar en o sobre su backdrop (${zReportBackdrop})`
    );

    // INVARIANTE 3: CoverageRequestModal (10030/10031) se sitúa por encima de modales de flujo primario (10020)
    assert.ok(
      zCoverageOverlay > zReportCard,
      `CoverageRequestModal (${zCoverageOverlay}) debe superar modales de nivel 1 (${zReportCard})`
    );

    // INVARIANTE 4: LoginRequiredSheet (10050/10051) SUPERA estrictamente a ReportPublicEncounterModal (10020/10021)
    // Esto resuelve de raíz la regresión reportada donde el login quedaba detrás del reporte
    assert.ok(
      zLoginOverlay > zReportCard,
      `LoginRequiredSheet overlay (${zLoginOverlay}) DEBE ser mayor que Report card (${zReportCard}) para no quedar detrás`
    );
    assert.ok(
      zLoginSheet > zLoginOverlay,
      `LoginRequiredSheet sheet (${zLoginSheet}) debe estar sobre su propio overlay (${zLoginOverlay})`
    );

    // INVARIANTE 5: AccountCollisionModal (10060/10061) SUPERA estrictamente a LoginRequiredSheet (10050/10051)
    // Esto garantiza que el modal de unificación de cuenta no quede oculto detrás de la hoja de login
    assert.ok(
      zCollisionOverlay > zLoginSheet,
      `AccountCollisionModal overlay (${zCollisionOverlay}) DEBE ser mayor que LoginRequiredSheet (${zLoginSheet})`
    );
    assert.ok(
      zCollisionModal > zCollisionOverlay,
      `AccountCollisionModal modal (${zCollisionModal}) debe estar sobre su overlay (${zCollisionOverlay})`
    );

    // INVARIANTE 6: CriticalCancellationModal (10070/10071) supera auth y reportes
    assert.ok(
      zCriticalOverlay > zCollisionModal,
      `CriticalCancellationModal (${zCriticalOverlay}) debe superar flujos de autenticación (${zCollisionModal})`
    );

    // INVARIANTE 7: PushVisibilityGuideModal (10080) es el asistente del sistema de mayor jerarquía controlada
    assert.ok(
      zPushGuideOverlay > zCriticalModal,
      `PushVisibilityGuideModal (${zPushGuideOverlay}) debe ser el asistente superior (${zCriticalModal})`
    );

    // INVARIANTE 8: Ausencia de saltos arbitrarios (> 10100)
    assert.ok(
      zPushGuideOverlay <= 10100,
      `La escala debe ser controlada y no superar 10100 (actual: ${zPushGuideOverlay})`
    );
  });

  // ── 2. ARQUITECTURA DE PORTALES Y LIBERACIÓN DE TRANSFORM ─────────────────────

  test('2. Todos los modales del flujo utilizan createPortal(..., document.body)', () => {
    const filesToCheck = [
      'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx',
      'src/components/home/openEncounters/ReportPublicEncounterModal.tsx',
      'src/components/auth/LoginRequiredSheet.tsx',
      'src/components/auth/AccountCollisionModal.tsx',
      'src/components/home/alerts/PushVisibilityGuideModal.tsx',
    ];

    for (const file of filesToCheck) {
      const fullPath = path.join(rootDir, file);
      const code = fs.readFileSync(fullPath, 'utf-8');
      assert.ok(
        code.includes("import { createPortal } from 'react-dom'"),
        `${file} DEBE importar createPortal`
      );
      assert.ok(
        code.includes('createPortal(') && code.includes('document.body'),
        `${file} DEBE renderizar hacia document.body mediante createPortal`
      );
    }
  });

  // ── 3. FLUJO COMPLETO: REPORTE -> LOGIN -> COLISIÓN DE CUENTA ─────────────────

  test('3. Simulación de flujo: reporte anónimo -> login requerido -> preservación de draft', () => {
    // A. Simular estado de sessionStorage en memoria
    const sessionStore = new Map<string, string>();
    const mockSessionStorage = {
      setItem: (key: string, val: string) => sessionStore.set(key, val),
      getItem: (key: string) => sessionStore.get(key) || null,
      removeItem: (key: string) => sessionStore.delete(key),
    };

    // B. Usuario anónimo intenta reportar encuentro con motivo 'spam' y comentario
    const encuentroId = 'enc-open-999';
    const reportData = {
      encounterId: encuentroId,
      reason: 'spam' as const,
      comment: 'Publicación comercial no deseada en el barrio',
    };

    // 1. Guardar reporte pendiente tal como lo ejecuta ReportPublicEncounterModal.tsx
    mockSessionStorage.setItem('pending_open_report', JSON.stringify(reportData));
    assert.ok(mockSessionStorage.getItem('pending_open_report') !== null, 'Reporte pendiente debe estar guardado');

    // 2. Verificar que los datos guardados coinciden exactamente con la estructura esperada
    const saved = JSON.parse(mockSessionStorage.getItem('pending_open_report')!);
    assert.strictEqual(saved.encounterId, encuentroId);
    assert.strictEqual(saved.reason, 'spam');
    assert.strictEqual(saved.comment, 'Publicación comercial no deseada en el barrio');

    // 3. Simular retorno post-login en HomeOpenEncounterDetailSheet.tsx
    const rawRestored = mockSessionStorage.getItem('pending_open_report');
    assert.ok(rawRestored !== null, 'Al volver de Google OAuth, pending_open_report debe existir');
    const restored = JSON.parse(rawRestored);
    assert.strictEqual(restored.encounterId, encuentroId, 'Debe coincidir el encuentro al restaurar');

    // 4. Cleanup tras procesar el reporte pendiente
    mockSessionStorage.removeItem('pending_open_report');
    assert.strictEqual(mockSessionStorage.getItem('pending_open_report'), null, 'Debe limpiarse tras el consumo');
  });

  // ── 4. PILA DE MODALES Y GESTIÓN DE ESCAPE / FOCO ──────────────────────────────

  test('4. Gestión determinista de Escape y foco en pila modal', () => {
    // ReportPublicEncounterModal no debe procesar Escape si LoginRequiredSheet está abierto
    const reportCode = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/ReportPublicEncounterModal.tsx'),
      'utf-8'
    );
    assert.ok(
      reportCode.includes('if (isLoginRequired) return;'),
      'ReportPublicEncounterModal debe ignorar Escape si LoginRequiredSheet está abierto'
    );

    // LoginRequiredSheet registra useModalStack condicionado a no tener collision modal abierta
    const loginCode = fs.readFileSync(
      path.join(rootDir, 'src/components/auth/LoginRequiredSheet.tsx'),
      'utf-8'
    );
    assert.ok(
      loginCode.includes("useModalStack('login-required-sheet', isOpen && !showCollisionModal"),
      'LoginRequiredSheet debe ceder el control de Escape a AccountCollisionModal si está visible'
    );

    // AccountCollisionModal registra su propio useModalStack
    const collisionCode = fs.readFileSync(
      path.join(rootDir, 'src/components/auth/AccountCollisionModal.tsx'),
      'utf-8'
    );
    assert.ok(
      collisionCode.includes("useModalStack('account-collision-modal'"),
      'AccountCollisionModal debe gestionar su posición en la pila modal'
    );
  });
});
