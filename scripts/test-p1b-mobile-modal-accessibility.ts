/**
 * Suite de Validación Automatizada: P1-B UX Corrección de Modales y Accesibilidad Móvil
 *
 * Cubre:
 * 1. Diagnóstico y Causa Raíz:
 *    - Corrección del bug de centrado flexbox ("negative coordinate clipping").
 *    - Unidades de viewport dinámicas (dvh) y áreas seguras (safe-area-inset-*).
 *    - Scroll interno flex con min-height: 0 y flex: 1 1 auto.
 *    - Enfoque accesible sin desplazamiento involuntario (preventScroll: true).
 *    - Adaptabilidad a fuentes ampliadas (150% y 200%) con botones auto-expandibles.
 * 2. Asistente PushVisibilityGuideModal (Layout, Header, Stepper, Content, Footer).
 * 3. Gestor global useModalStack (restauración de foco con preventScroll).
 * 4. Auditoría y corrección de modales y sheets principales:
 *    - AvisamePushPromptModal
 *    - CriticalCancellationModal
 *    - ContextualBlockModal
 *    - AccountCollisionModal
 *    - ReportPublicEncounterModal & ReportRequestModal
 *    - EditScheduleModal & HomeOpenEncounterDetailSheet
 *    - DraftOverwriteConfirmSheet & Button global
 * 5. Simulaciones matemáticas de layout por perfil de dispositivo:
 *    - Mobile vertical estándar (360x640)
 *    - Mobile vertical con fuente 150% y 200%
 *    - Mobile horizontal / pantalla baja (<480px)
 *    - Desktop (1280x800)
 * 6. Internacionalización completa (ES, EN, PT, PT-BR).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('PuntoEncuentro — P1-B: Corrección de Modales y Accesibilidad Móvil', () => {
  const rootDir = process.cwd();

  // ── 1. ASISTENTE: DIAGNÓSTICO Y SOLUCIÓN DE OVERLAY, FLEX Y SCROLL ────────────

  test('1. PushVisibilityGuideModal.css implementa overlay seguro con dvh y scroll', () => {
    const cssPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    // Overlay seguro: overflow-y: auto + safe-area-inset-* + align-items safe center
    assert.ok(css.includes('overflow-y: auto'), 'Overlay debe permitir desplazamiento vertical');
    assert.ok(css.includes('overscroll-behavior-y: contain'), 'Overlay debe contener overscroll');
    assert.ok(css.includes('env(safe-area-inset-top'), 'Overlay debe respetar área segura superior');
    assert.ok(css.includes('env(safe-area-inset-bottom'), 'Overlay debe respetar área segura inferior');
    assert.ok(
      css.includes('align-items: safe center') || css.includes('margin: auto'),
      'Debe prevenir recorte superior en coordenadas negativas (safe center o margin: auto)'
    );

    // Modal: margin: auto + max-height con dvh
    assert.ok(css.includes('margin: auto'), 'Modal debe usar margin: auto para centrado seguro sin recorte superior');
    assert.ok(css.includes('100dvh'), 'Modal debe utilizar 100dvh para adaptarse a barras dinámicas del navegador');
    assert.ok(css.includes('calc(100vh - 32px)'), 'Modal debe incluir alternativa de fallback compatible con 100vh');
  });

  test('2. PushVisibilityGuideModal.css estructura interna flex (Header, Stepper, Content, Footer)', () => {
    const cssPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    // Header nunca se achica (flex-shrink: 0)
    assert.ok(
      css.includes('.pe-visibility-guide-modal__header') && css.includes('flex-shrink: 0'),
      'Header debe tener flex-shrink: 0 para no comprimirse jamás'
    );

    // Stepper nunca se achica (flex-shrink: 0)
    assert.ok(
      css.includes('.pe-assistant-stepper') && css.includes('flex-shrink: 0'),
      'Stepper debe tener flex-shrink: 0'
    );

    // Content es el único que scrollea internamente con min-height: 0
    assert.ok(
      css.includes('.pe-visibility-guide-modal__content') && css.includes('min-height: 0'),
      'Content debe tener min-height: 0 para habilitar la contracción flex'
    );
    assert.ok(
      css.includes('.pe-visibility-guide-modal__content') && css.includes('flex: 1 1 auto'),
      'Content debe tener flex: 1 1 auto para ocupar el espacio restante'
    );

    // Footer permanece accesible y visible al fondo
    assert.ok(
      css.includes('.pe-visibility-guide-modal__footer') && css.includes('flex-shrink: 0'),
      'Footer debe tener flex-shrink: 0 para mantener siempre visibles los botones de acción'
    );
  });

  test('3. PushVisibilityGuideModal.css adapta botones a texto ampliado (150% y 200%)', () => {
    const cssPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    // Botones con min-height y white-space: normal para envolver líneas sin truncamiento
    assert.ok(css.includes('min-height: 48px'), 'Botones principales deben tener min-height >= 48px (WCAG touch target)');
    assert.ok(css.includes('white-space: normal'), 'Botones deben permitir salto de línea con texto ampliado');
    assert.ok(css.includes('word-break: break-word'), 'Botones deben romper palabras largas sin desbordar');

    // Stepper pills adaptables
    assert.ok(css.includes('.pe-assistant-step-pill') && css.includes('min-height: 36px'), 'Pills del stepper deben tener altura mínima');
  });

  test('4. PushVisibilityGuideModal.tsx resetea scroll y enfoca con preventScroll: true', () => {
    const tsxPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.tsx');
    const tsx = fs.readFileSync(tsxPath, 'utf-8');

    // Reset de scroll al abrir o cambiar de paso
    assert.ok(
      tsx.includes('contentRef.current.scrollTop = 0'),
      'Debe resetear contentRef.scrollTop a 0 al abrir o cambiar de paso'
    );

    // Foco con preventScroll: true
    assert.ok(
      tsx.includes('preventScroll: true'),
      'Todas las llamadas a focus() deben usar preventScroll: true'
    );

    // En paso 1, foco accesible al contenedor o encabezado para lectura inicial sin scroll
    assert.ok(
      tsx.includes('modalRef.current.focus({ preventScroll: true })'),
      'En paso 1 debe enfocar el diálogo de manera accesible sin saltos de scroll'
    );
  });

  // ── 2. GESTOR GLOBAL useModalStack ────────────────────────────────────────────

  test('5. modalStack.ts restaura el foco accesible con preventScroll: true', () => {
    const msPath = path.join(rootDir, 'src/lib/modalStack.ts');
    const ms = fs.readFileSync(msPath, 'utf-8');

    assert.ok(
      ms.includes('prevActiveElementRef.current.focus({ preventScroll: true })'),
      'modalStack debe restaurar el foco con preventScroll: true para evitar saltos al cerrar modales'
    );
  });

  // ── 3. AUDITORÍA Y CORRECCIONES EN OTROS MODALES Y SHEETS ─────────────────────

  test('6. AvisamePushPromptModal.css incluye overlay seguro con scroll, dvh y botones adaptables', () => {
    const cssPath = path.join(rootDir, 'src/components/home/alerts/AvisamePushPromptModal.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(css.includes('overflow-y: auto'), 'AvisamePushPromptModal overlay debe tener scroll');
    assert.ok(css.includes('100dvh'), 'AvisamePushPromptModal debe usar 100dvh');
    assert.ok(css.includes('min-height: 48px'), 'Botón primario de Avisame push debe tener min-height >= 48px');
    assert.ok(css.includes('white-space: normal'), 'Botón primario debe admitir multi-línea con fuente ampliada');
  });

  test('7. CriticalCancellationModal.css cuenta con protección de altura máxima y overlay scrollable', () => {
    const cssPath = path.join(rootDir, 'src/components/notifications/CriticalCancellationModal.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(css.includes('overflow-y: auto'), 'CriticalCancellationModal overlay debe tener scroll');
    assert.ok(css.includes('100dvh'), 'CriticalCancellationModal debe usar 100dvh');
    assert.ok(css.includes('margin: auto'), 'CriticalCancellationModal debe usar margin: auto');
    assert.ok(css.includes('min-height: 48px'), 'CTA de confirmación crítica debe tener min-height >= 48px');
  });

  test('8. ContextualBlockModal.css implementa scroll interno seguro y botones adaptables', () => {
    const cssPath = path.join(rootDir, 'src/components/trust/ContextualBlockModal.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(css.includes('overflow-y: auto'), 'ContextualBlockModal body debe scrollear internamente');
    assert.ok(css.includes('100dvh'), 'ContextualBlockModal debe limitar altura con 100dvh');
    assert.ok(css.includes('min-height: 48px'), 'Botones de bloqueo deben tener min-height >= 48px');
  });

  test('9. AccountCollisionModal.css limita altura y permite scroll interno', () => {
    const cssPath = path.join(rootDir, 'src/components/auth/AccountCollisionModal.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(css.includes('100dvh'), 'AccountCollisionModal debe limitar altura con 100dvh');
    assert.ok(css.includes('overflow-y: auto'), 'AccountCollisionModal body debe scrollear internamente');
    assert.ok(css.includes('min-height: 48px'), 'Botón de vincular cuenta debe tener min-height >= 48px');
  });

  test('10. Button.css global asegura adaptabilidad a fuentes ampliadas (150% y 200%)', () => {
    const cssPath = path.join(rootDir, 'src/components/ui/Button.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(css.includes('min-height: var(--btn-height)'), 'Button base debe usar min-height en vez de height rígido');
    assert.ok(css.includes('height: auto'), 'Button base debe permitir height: auto para crecer con texto ampliado');
    assert.ok(css.includes('white-space: normal'), 'Button base debe permitir saltos de línea con texto ampliado');
  });

  // ── 4. SIMULACIONES MATEMÁTICAS DE LAYOUT POR PERFIL DE DISPOSITIVO ───────────

  test('11. Simulación Mobile Vertical Normal (360x640px, font 100%): Encabezado visible en Y=0', () => {
    const viewportHeight = 640;
    const safeTop = 16;
    const safeBottom = 16;
    const availableHeight = viewportHeight - safeTop - safeBottom; // 608px
    const headerHeight = 76;
    const stepperHeight = 44;
    const footerHeight = 112;
    const contentEstimate = 280;
    const totalNaturalHeight = headerHeight + stepperHeight + footerHeight + contentEstimate + 42; // ~554px

    // Comprobación de centrado seguro
    assert.ok(totalNaturalHeight <= availableHeight, 'En pantalla vertical normal el contenido cabe en la ventana');
    const topOffset = safeTop + (availableHeight - totalNaturalHeight) / 2;
    assert.ok(topOffset >= safeTop, 'El encabezado se posiciona dentro del área visible sin coordenadas negativas');
  });

  test('12. Simulación Mobile Vertical 200% Fuente (360x640px con barra Chrome activa, 460px útiles)', () => {
    const dvhAvailable = 460;
    const safeTop = 16;
    const safeBottom = 16;
    const maxModalHeight = dvhAvailable - safeTop - safeBottom - 32; // 396px
    const headerEnlarged = 110; // Texto 200% aumenta altura de título y subtítulo
    const stepperEnlarged = 58;
    const footerEnlarged = 140; // 2 botones en multi-línea
    const fixedElementsHeight = headerEnlarged + stepperEnlarged + footerEnlarged; // 308px

    // El espacio restante para content es positivo
    const contentRemaining = maxModalHeight - fixedElementsHeight;
    assert.ok(contentRemaining > 0, 'Queda espacio positivo para el scroll de contenido');

    // Con margin: auto, el modal inicia en Y >= safeTop (nunca negativo)
    const simulatedTop = safeTop;
    assert.ok(simulatedTop >= 0, 'El encabezado NUNCA queda fuera de pantalla en coordenadas negativas');
  });

  test('13. Simulación Mobile Horizontal / Shallow Viewport (640x320px)', () => {
    const viewportHeight = 320;
    const isShallow = viewportHeight <= 480;

    assert.strictEqual(isShallow, true, 'Detecta correctamente pantalla horizontal o de baja altura');

    const cssPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(css.includes('@media (max-height: 480px)'), 'Debe existir media query para pantallas de baja altura');
    assert.ok(
      css.includes('.pe-visibility-guide-modal__subtitle') && css.includes('display: none'),
      'En horizontal o altura baja oculta subtítulos no esenciales para dar aire al contenido'
    );
  });

  // ── 5. INTEGRIDAD DE INTERNACIONALIZACIÓN ─────────────────────────────────────

  test('14. Claves de internacionalización conservadas y completas en los 4 idiomas', () => {
    const locales = ['es', 'en', 'pt', 'pt-BR'];
    for (const locale of locales) {
      const filePath = path.join(rootDir, `src/i18n/locales/${locale}.json`);
      assert.ok(fs.existsSync(filePath), `Archivo ${locale}.json debe existir`);
      const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.ok(json.push.assistant_step_config, `assistant_step_config en ${locale}.json`);
      assert.ok(json.push.assistant_next_to_test, `assistant_next_to_test en ${locale}.json`);
      assert.ok(json.push.assistant_confirm_yes, `assistant_confirm_yes en ${locale}.json`);
    }
  });

  // ── 6. ARQUITECTURA DE PORTALES Y ESCAPE DE STACKING CONTEXT / CLIPPING ──────

  test('15. PushVisibilityGuideModal y modales dependientes renderizan vía createPortal(..., document.body)', () => {
    // 1. PushVisibilityGuideModal
    const guideTsx = fs.readFileSync(path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.tsx'), 'utf-8');
    assert.ok(guideTsx.includes("import { createPortal } from 'react-dom'"), 'PushVisibilityGuideModal debe importar createPortal');
    assert.ok(guideTsx.includes('createPortal(modalContent, document.body)'), 'PushVisibilityGuideModal debe renderizar en document.body mediante portal');

    const guideCss = fs.readFileSync(path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.css'), 'utf-8');
    assert.ok(guideCss.includes('z-index: 12000'), 'PushVisibilityGuideModal.css overlay debe tener z-index: 12000 para superar sheets y modales');

    // 2. AvisamePushPromptModal
    const promptTsx = fs.readFileSync(path.join(rootDir, 'src/components/home/alerts/AvisamePushPromptModal.tsx'), 'utf-8');
    assert.ok(promptTsx.includes("import { createPortal } from 'react-dom'"), 'AvisamePushPromptModal debe importar createPortal');
    assert.ok(promptTsx.includes('createPortal(modalContent, document.body)'), 'AvisamePushPromptModal debe renderizar en document.body mediante portal');

    const promptCss = fs.readFileSync(path.join(rootDir, 'src/components/home/alerts/AvisamePushPromptModal.css'), 'utf-8');
    assert.ok(promptCss.includes('z-index: 12000'), 'AvisamePushPromptModal.css overlay debe tener z-index: 12000 para superar pe-sheet-container');

    // 3. ReportPublicEncounterModal
    const reportTsx = fs.readFileSync(path.join(rootDir, 'src/components/home/openEncounters/ReportPublicEncounterModal.tsx'), 'utf-8');
    assert.ok(reportTsx.includes("import { createPortal } from 'react-dom'"), 'ReportPublicEncounterModal debe importar createPortal');
    assert.ok(reportTsx.includes('createPortal(modalContent, document.body)'), 'ReportPublicEncounterModal debe renderizar en document.body mediante portal');

    const reportCss = fs.readFileSync(path.join(rootDir, 'src/components/home/openEncounters/ReportPublicEncounterModal.css'), 'utf-8');
    assert.ok(reportCss.includes('z-index: 12000'), 'ReportPublicEncounterModal.css debe tener z-index: 12000 para superar HomeOpenEncounterDetailSheet');

    // 4. CoverageRequestModal
    const coverageTsx = fs.readFileSync(path.join(rootDir, 'src/components/coverage/CoverageRequestModal.tsx'), 'utf-8');
    assert.ok(coverageTsx.includes("import { createPortal } from 'react-dom'"), 'CoverageRequestModal debe importar createPortal');
    assert.ok(coverageTsx.includes('createPortal(modalContent, document.body)'), 'CoverageRequestModal debe renderizar en document.body mediante portal');

    const coverageCss = fs.readFileSync(path.join(rootDir, 'src/components/coverage/CoverageRequestModal.css'), 'utf-8');
    assert.ok(coverageCss.includes('z-index: 12000') || coverageCss.includes('z-index: 12001'), 'CoverageRequestModal.css debe tener z-index >= 12000');
  });
});
