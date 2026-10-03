import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Corrección Mobile: AvisameSheet Scroll Lock y HomeOpenEncounters Header Resiliente', () => {
  const rootDir = process.cwd();

  test('1. AvisameSheet implementa bloqueo de scroll en document.body al abrirse y cleanup al cerrarse sin preventDefault en overlay', () => {
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
    // El overlay es un backdrop limpio, NO debe tener preventDefault en touchmove que cancele gestos
    assert.ok(
      !content.includes('onTouchMove='),
      'El overlay de AvisameSheet NO debe tener onTouchMove con preventDefault que interfiera con gestos'
    );
    // El overlay y el container son hermanos (siblings) directos en el React Fragment
    assert.ok(
      content.includes('<div className="pe-sheet-overlay"') &&
      content.includes('<div\n        className="pe-sheet-container pe-avisame-sheet"'),
      'pe-sheet-overlay y pe-sheet-container deben ser hermanos en el fragmento'
    );
  });

  test('2. AvisameSheet.css y BottomSheet.css implementan un único contenedor scrollable sin anidamientos', () => {
    const bottomSheetCssPath = path.join(rootDir, 'src/components/ui/BottomSheet.css');
    const bottomSheetCss = fs.readFileSync(bottomSheetCssPath, 'utf-8');

    assert.ok(
      bottomSheetCss.includes('overscroll-behavior: contain'),
      'BottomSheet overlay debe tener overscroll-behavior: contain'
    );
    assert.ok(
      !bottomSheetCss.includes('.pe-sheet-overlay {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  background: rgba(0, 0, 0, 0.4);\n  z-index: 999;\n  backdrop-filter: blur(2px);\n  overscroll-behavior: contain;\n  touch-action: none;'),
      'BottomSheet overlay NO debe tener touch-action: none'
    );

    const avisameCssPath = path.join(rootDir, 'src/components/home/alerts/AvisameSheet.css');
    const avisameCss = fs.readFileSync(avisameCssPath, 'utf-8');

    // El container exterior flex NO debe scrollear (overflow: hidden) para evitar scrolls anidados y fijar cabeceras
    assert.ok(
      avisameCss.includes('.pe-sheet-container.pe-avisame-sheet') &&
      avisameCss.includes('overflow: hidden'),
      'AvisameSheet container exterior debe tener overflow: hidden para no anidar scroll y fijar cabecera'
    );
    assert.ok(
      avisameCss.includes('max-height: min(88vh, 88dvh)'),
      'AvisameSheet container debe soportar unidades dvh dinámicas'
    );

    // Cabecera y tabs fijas
    assert.ok(
      avisameCss.includes('.pe-avisame-header') && avisameCss.includes('flex-shrink: 0'),
      'Header de AvisameSheet debe tener flex-shrink: 0 para mantenerse fijo'
    );
    assert.ok(
      avisameCss.includes('.pe-avisame-tabs') && avisameCss.includes('flex-shrink: 0'),
      'Tabs de AvisameSheet deben tener flex-shrink: 0 para mantenerse fijos'
    );

    // Contenedor scrollable único para la lista (Mis avisos)
    assert.ok(
      avisameCss.includes('.pe-avisame-list') &&
      avisameCss.includes('flex: 1 1 auto') &&
      avisameCss.includes('min-height: 0') &&
      avisameCss.includes('overflow-y: auto') &&
      avisameCss.includes('overscroll-behavior-y: contain') &&
      avisameCss.includes('touch-action: pan-y'),
      'pe-avisame-list debe ser el contenedor scrollable vertical único con min-height: 0 y overscroll contain'
    );

    // Contenedor scrollable único para el formulario (Crear aviso)
    assert.ok(
      avisameCss.includes('.pe-avisame-form') &&
      avisameCss.includes('flex: 1 1 auto') &&
      avisameCss.includes('min-height: 0') &&
      avisameCss.includes('overflow-y: auto') &&
      avisameCss.includes('overscroll-behavior-y: contain') &&
      avisameCss.includes('touch-action: pan-y'),
      'pe-avisame-form debe ser el contenedor scrollable vertical con min-height: 0 y overscroll contain'
    );

    assert.ok(
      avisameCss.includes('.pe-push-device') && avisameCss.includes('flex-shrink: 0'),
      'DevicePushSettings no debe colapsar al fondo de la lista (flex-shrink: 0)'
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
