import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isPushPromptDismissed,
  dismissPushPrompt,
  clearPushPromptDismissal,
  PUSH_PROMPT_DISMISSED_KEY,
} from '../src/components/home/alerts/antiNagging';

// Polyfill localStorage in Node test runner if missing
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.setItem !== 'function') {
  let store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = String(val); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

describe('Ajuste UX: Integración Web Push en flujo de Crear Aviso y Modal Post-Guardado', () => {
  const rootDir = process.cwd();

  beforeEach(() => {
    localStorage.clear();
  });

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
    assert.ok(
      !content.includes('onTouchMove='),
      'El overlay de AvisameSheet NO debe tener onTouchMove con preventDefault'
    );
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
      !bottomSheetCss.includes('touch-action: none'),
      'BottomSheet overlay NO debe tener touch-action: none'
    );

    const avisameCssPath = path.join(rootDir, 'src/components/home/alerts/AvisameSheet.css');
    const avisameCss = fs.readFileSync(avisameCssPath, 'utf-8');

    // El container exterior flex NO debe scrollear (overflow: hidden)
    assert.ok(
      avisameCss.includes('.pe-sheet-container.pe-avisame-sheet') &&
      avisameCss.includes('overflow: hidden'),
      'AvisameSheet container exterior debe tener overflow: hidden para no anidar scroll'
    );

    // Contenedores scrollables únicos
    assert.ok(
      avisameCss.includes('.pe-avisame-list') &&
      avisameCss.includes('overflow-y: auto') &&
      avisameCss.includes('overscroll-behavior-y: contain') &&
      avisameCss.includes('touch-action: pan-y'),
      'pe-avisame-list debe ser contenedor scrollable vertical'
    );

    assert.ok(
      avisameCss.includes('.pe-avisame-form') &&
      avisameCss.includes('overflow-y: auto') &&
      avisameCss.includes('overscroll-behavior-y: contain') &&
      avisameCss.includes('touch-action: pan-y'),
      'pe-avisame-form debe ser contenedor scrollable vertical'
    );
  });

  test('3. HomeOpenEncounters.css define layout mobile-first multilínea inmune a colisión por font scaling', () => {
    const encountersCssPath = path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.css');
    const encountersCss = fs.readFileSync(encountersCssPath, 'utf-8');

    assert.ok(
      encountersCss.includes('.pe-discovery-header') &&
      encountersCss.includes('flex-direction: column'),
      'pe-discovery-header debe ser flex-direction: column en mobile'
    );
    assert.ok(
      encountersCss.includes('overflow-wrap: break-word'),
      'pe-discovery-title debe tener overflow-wrap: break-word'
    );
    assert.ok(
      encountersCss.includes('.pe-discovery-header-actions') &&
      encountersCss.includes('justify-content: space-between'),
      'pe-discovery-header-actions en mobile debe distribuir acciones con space-between'
    );
  });

  test('4. DevicePushSettings fue retirado de "Mis avisos" y reubicado en "Crear aviso"', () => {
    const avisameSheetPath = path.join(rootDir, 'src/components/home/alerts/AvisameSheet.tsx');
    const content = fs.readFileSync(avisameSheetPath, 'utf-8');

    // Separar pestañas por las secciones condicionales de renderizado
    const createTabIdx = content.indexOf("{activeTab === 'create' && (");
    const listTabIdx = content.indexOf("{activeTab === 'list' && (");

    assert.ok(createTabIdx !== -1, "Debe existir la sección {activeTab === 'create' && (");
    assert.ok(listTabIdx !== -1, "Debe existir la sección {activeTab === 'list' && (");

    const createTabSection = content.slice(createTabIdx, listTabIdx);
    const listTabSection = content.slice(listTabIdx);

    assert.ok(
      !listTabSection.includes('<DevicePushSettings />'),
      'DevicePushSettings NO debe estar presente en la pestaña Mis avisos'
    );

    assert.ok(
      createTabSection.includes('<DevicePushSettings />'),
      'DevicePushSettings DEBE estar presente en la pestaña Crear aviso'
    );

    // Ubicado antes del botón submit
    const submitBtnIdx = createTabSection.indexOf('pe-avisame-submit-btn');
    const pushSettingsIdx = createTabSection.indexOf('<DevicePushSettings />');
    assert.ok(
      pushSettingsIdx !== -1 && pushSettingsIdx < submitBtnIdx,
      'DevicePushSettings debe ubicarse antes del botón Guardar aviso en el formulario'
    );
  });

  test('5. Política anti-molestia: dismissPushPrompt persiste en localStorage e isPushPromptDismissed silencia repeticiones', () => {
    // Inicialmente no está descartado
    assert.strictEqual(isPushPromptDismissed(), false);

    // Usuario pulsa "Ahora no"
    dismissPushPrompt(30);

    // Ahora está descartado
    assert.strictEqual(isPushPromptDismissed(), true);

    // Comprobar clave y que no guarda datos personales ni del aviso
    const rawVal = localStorage.getItem(PUSH_PROMPT_DISMISSED_KEY);
    assert.ok(rawVal, 'Debe persistir en la clave versionada');
    assert.strictEqual(isNaN(Number(rawVal)), false, 'Debe ser un timestamp numérico simple');
    assert.strictEqual(rawVal.includes('email'), false);
    assert.strictEqual(rawVal.includes('user'), false);
    assert.strictEqual(rawVal.includes('aviso'), false);

    // Limpieza explícita al activar
    clearPushPromptDismissal();
    assert.strictEqual(isPushPromptDismissed(), false);
  });

  test('6. Condiciones para ofrecer el popup post-guardado en AvisameSheet', () => {
    const avisameSheetPath = path.join(rootDir, 'src/components/home/alerts/AvisameSheet.tsx');
    const content = fs.readFileSync(avisameSheetPath, 'utf-8');

    // Verifica que el popup evalúa isPermanentUser, isPushPromptDismissed y deviceState
    assert.ok(
      content.includes('isPermanentUser && !isPushPromptDismissed()'),
      'Debe evaluar que el usuario sea permanente y no haya descartado el prompt'
    );
    assert.ok(
      content.includes("deviceState.kind === 'default' || deviceState.kind === 'granted_unsubscribed'"),
      'Solo debe abrirse si el dispositivo tiene estado default o granted_unsubscribed'
    );

    // Verifica que si ya está subscribed o denied, no se activa prompted
    assert.ok(
      content.includes('setShowPushPrompt(true)'),
      'Abre el modal contextual AvisamePushPromptModal al cumplirse las condiciones'
    );
  });

  test('7. AvisamePushPromptModal implementa gesto explícito estricto: cero auto-prompts al montar', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/AvisamePushPromptModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    // NINGÚN useEffect debe llamar a activate o requestPermission
    assert.ok(
      !content.includes('useEffect(() => {\n    webPushService.activate'),
      'El modal NO debe invocar activate en ningún efecto'
    );
    assert.ok(
      !content.includes('useEffect(() => {\n    Notification.requestPermission'),
      'El modal NO debe invocar requestPermission en ningún efecto'
    );

    // Invocación exclusiva al hacer click en el botón Activar
    assert.ok(
      content.includes('onClick={() => void handleActivate()}'),
      'La activación debe conectarse al onClick del botón principal'
    );
    assert.ok(
      content.includes('const res = await webPushService.activate()'),
      'handleActivate debe invocar el servicio de activación Web Push'
    );
  });

  test('8. AvisamePushPromptModal cumple requisitos de accesibilidad, dialog semántico y CTA inequívoco', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/AvisamePushPromptModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    assert.ok(content.includes('role="dialog"'), 'Debe tener role="dialog"');
    assert.ok(content.includes('aria-modal="true"'), 'Debe tener aria-modal="true"');
    assert.ok(content.includes('aria-labelledby="push-prompt-title"'), 'Debe asociar aria-labelledby');
    assert.ok(content.includes('aria-describedby="push-prompt-desc"'), 'Debe asociar aria-describedby');

    // Textos y CTAs requeridos
    assert.ok(
      content.includes('Activar notificaciones'),
      'CTA principal debe ser "Activar notificaciones"'
    );
    assert.ok(
      content.includes('Ahora no'),
      'CTA secundario debe ser "Ahora no"'
    );
    assert.ok(
      content.includes('¿Querés que te avisemos en este dispositivo?'),
      'Título debe ser la pregunta clara de consentimiento'
    );
  });

  test('9. Gesto "Ahora no" descarta el prompt y no afecta el guardado del aviso', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/AvisamePushPromptModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    assert.ok(
      content.includes('const handleDismiss = () => {\n    if (busy) return;\n    dismissPushPrompt();\n    onClose();\n  };'),
      'handleDismiss debe ejecutar dismissPushPrompt() y onClose()'
    );
  });

  test('10. Si el usuario rechaza el prompt nativo (permission_denied / permission_dismissed), el modal no insiste', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/AvisamePushPromptModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    assert.ok(
      content.includes("res.error === 'permission_denied' || res.error === 'permission_dismissed'"),
      'Debe capturar rechazo nativo'
    );
    assert.ok(
      content.includes('dismissPushPrompt();\n          onClose();'),
      'Al rechazar nativamente, registra descarte y cierra sin insistir'
    );
  });
});
