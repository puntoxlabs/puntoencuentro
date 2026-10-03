import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Corrección Mobile: AvisameSheet Scroll Lock y HomeOpenEncounters Header Resiliente', () => {
  const rootDir = process.cwd();

  test('1. AvisameSheet implementa bloqueo de scroll en document.body al abrirse y cleanup al cerrarse', () => {
    const filePath = path.join(rootDir, 'src/components/home/alerts/AvisameSheet.tsx');
    const content = fs.readFileSync(filePath, 'utf-8');

    assert.ok(
      content.includes("document.body.style.overflow = 'hidden'"),
      'AvisameSheet debe asignar overflow: hidden al body cuando isOpen es true'
    );
    assert.ok(
      content.includes("document.body.style.overscrollBehavior = 'none'"),
      'AvisameSheet debe contener overscrollBehavior: none en body mientras está abierto'
    );
    assert.ok(
      content.includes('document.body.style.overflow = originalOverflow'),
      'AvisameSheet debe restaurar el overflow original en la función cleanup'
    );
    assert.ok(
      content.includes('onTouchMove='),
      'El overlay de AvisameSheet debe interceptar touchMove para evitar scroll chaining en mobile'
    );
  });

  test('2. BottomSheet.css y AvisameSheet.css contienen reglas de overscroll-behavior y touch-action para mobile', () => {
    const bottomSheetCssPath = path.join(rootDir, 'src/components/ui/BottomSheet.css');
    const bottomSheetCss = fs.readFileSync(bottomSheetCssPath, 'utf-8');

    assert.ok(
      bottomSheetCss.includes('overscroll-behavior: contain'),
      'BottomSheet overlay debe tener overscroll-behavior: contain'
    );
    assert.ok(
      bottomSheetCss.includes('touch-action: none'),
      'BottomSheet overlay debe tener touch-action: none'
    );
    assert.ok(
      bottomSheetCss.includes('overscroll-behavior-y: contain'),
      'BottomSheet container debe tener overscroll-behavior-y: contain'
    );
    assert.ok(
      bottomSheetCss.includes('touch-action: pan-y'),
      'BottomSheet container debe tener touch-action: pan-y'
    );
    assert.ok(
      bottomSheetCss.includes('max-height: min(85vh, 85dvh)'),
      'BottomSheet container debe soportar unidades dvh dinámicas en navegadores móviles'
    );

    const avisameCssPath = path.join(rootDir, 'src/components/home/alerts/AvisameSheet.css');
    const avisameCss = fs.readFileSync(avisameCssPath, 'utf-8');

    assert.ok(
      avisameCss.includes('overscroll-behavior-y: contain'),
      'AvisameSheet container debe tener overscroll-behavior-y: contain'
    );
    assert.ok(
      avisameCss.includes('touch-action: pan-y'),
      'AvisameSheet container debe tener touch-action: pan-y'
    );
    assert.ok(
      avisameCss.includes('max-height: min(88vh, 88dvh)'),
      'AvisameSheet container debe soportar unidades dvh'
    );
    assert.ok(
      avisameCss.includes('.pe-avisame-header') && avisameCss.includes('flex-shrink: 0'),
      'Header de AvisameSheet no debe colapsar ante scroll (flex-shrink: 0)'
    );
    assert.ok(
      avisameCss.includes('.pe-avisame-tabs') && avisameCss.includes('flex-shrink: 0'),
      'Tabs de AvisameSheet no deben colapsar ante scroll (flex-shrink: 0)'
    );
    assert.ok(
      avisameCss.includes('.pe-push-device') && avisameCss.includes('flex-shrink: 0'),
      'DevicePushSettings no debe colapsar (flex-shrink: 0)'
    );
  });

  test('3. HomeOpenEncounters.css define layout mobile-first multilínea inmune a colisión por font scaling', () => {
    const encountersCssPath = path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.css');
    const encountersCss = fs.readFileSync(encountersCssPath, 'utf-8');

    // Header en mobile: columna completa con acciones en segunda línea
    assert.ok(
      encountersCss.includes('.pe-discovery-header') &&
      encountersCss.includes('flex-direction: column'),
      'pe-discovery-header debe ser flex-direction: column en mobile para separar título de botones'
    );

    // Título con badge en fila 1: wrap seguro sin white-space: nowrap que cause colisión
    assert.ok(
      encountersCss.includes('overflow-wrap: break-word'),
      'pe-discovery-title debe tener overflow-wrap: break-word para prevenir desbordes con zoom'
    );
    assert.ok(
      !encountersCss.includes('.pe-discovery-title {\n  margin: 0;\n  font-size: 1.08rem;\n  font-weight: 700;\n  color: var(--color-on-surface, #0f172a);\n  letter-spacing: -0.015em;\n  white-space: nowrap;'),
      'pe-discovery-title NO debe tener white-space: nowrap rígido que desborde sobre los botones'
    );

    // Acciones en fila 2
    assert.ok(
      encountersCss.includes('.pe-discovery-header-actions') &&
      encountersCss.includes('justify-content: space-between'),
      'pe-discovery-header-actions en mobile debe distribuir acciones con space-between'
    );

    // Botones con min-height táctil en mobile
    assert.ok(
      encountersCss.includes('.pe-discovery-avisame-btn') &&
      encountersCss.includes('min-height: 36px'),
      'Botón Avisame debe tener target táctil de al menos 36px'
    );
    assert.ok(
      encountersCss.includes('.pe-discovery-see-all-btn') &&
      encountersCss.includes('min-height: 36px'),
      'Botón Ver todos debe tener target táctil de al menos 36px'
    );

    // Preservación en pantallas >= 540px
    assert.ok(
      encountersCss.includes('@media (min-width: 540px)') &&
      encountersCss.includes('flex-direction: row'),
      'Header debe restaurar layout en una sola fila en tablet/desktop (>= 540px)'
    );
  });

  test('4. AvisameSheet renderiza DevicePushSettings condicionado exclusivamente al estado requerido', () => {
    const avisameSheetPath = path.join(rootDir, 'src/components/home/alerts/AvisameSheet.tsx');
    const avisameContent = fs.readFileSync(avisameSheetPath, 'utf-8');

    // Comprobamos la condición exacta de render:
    assert.ok(
      avisameContent.includes('isPermanentUser && !loadingAlerts && !alertsError && alerts.length > 0'),
      'DevicePushSettings debe renderizarse cuando el usuario es permanente y posee >= 1 aviso'
    );
    assert.ok(
      avisameContent.includes('<DevicePushSettings />'),
      'El componente DevicePushSettings debe ser invocado dentro de pe-avisame-list'
    );
  });
});
