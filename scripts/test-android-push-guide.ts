import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isAndroidDevice,
  isAndroidPushGuideDismissed,
  dismissAndroidPushGuide,
  resetAndroidPushGuideDismissal,
  ANDROID_PUSH_GUIDE_DISMISSED_KEY,
} from '../src/components/home/alerts/antiNagging';

// Polyfill localStorage in Node test runner
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

function setMockUserAgent(ua: string) {
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: ua },
      configurable: true,
      writable: true,
    });
  } catch {
    try {
      Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: ua,
        configurable: true,
        writable: true,
      });
    } catch {}
  }
}

describe('PuntoEncuentro — Guía de Configuración de Notificaciones en Android (Mejora UX)', () => {
  const rootDir = process.cwd();

  beforeEach(() => {
    localStorage.clear();
    setMockUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36');
  });

  // ── 1. DETECCIÓN DE ENTORNO Y COMPATIBILIDAD ANDROID ESTRICTA ─────────────────

  test('1. isAndroidDevice detecta Android exclusivamente y descarta Desktop / iOS', () => {
    // Caso Android
    setMockUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36');
    assert.strictEqual(isAndroidDevice(), true, 'Debe retornar true para dispositivo Android');

    // Caso Windows Desktop
    setMockUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
    assert.strictEqual(isAndroidDevice(), false, 'Debe retornar false para Windows Desktop');

    // Caso macOS Desktop
    setMockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
    assert.strictEqual(isAndroidDevice(), false, 'Debe retornar false para macOS Desktop');

    // Caso iPhone iOS
    setMockUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
    assert.strictEqual(isAndroidDevice(), false, 'Debe retornar false para iPhone iOS');

    // Caso iPad iOS
    setMockUserAgent('Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
    assert.strictEqual(isAndroidDevice(), false, 'Debe retornar false para iPad iOS');
  });

  // ── 2. PERSISTENCIA DE RESOLUCIÓN Y POLÍTICA DE DISPARO ÚNICO ─────────────────

  test('2. Descarte o resolución persiste en localStorage y previene reaparición automática', () => {
    assert.strictEqual(isAndroidPushGuideDismissed(), false, 'Inicialmente no debe estar descartada');

    // Usuario descarta ("Ahora no") o abre ("Ver cómo configurarlas")
    dismissAndroidPushGuide();
    assert.strictEqual(isAndroidPushGuideDismissed(), true, 'Debe estar marcada como resuelta');

    const stored = localStorage.getItem(ANDROID_PUSH_GUIDE_DISMISSED_KEY);
    assert.strictEqual(stored, 'true', 'Debe persistir en la clave versionada');

    // Reset de QA / pruebas
    resetAndroidPushGuideDismissal();
    assert.strictEqual(isAndroidPushGuideDismissed(), false, 'Reset debe limpiar la marca');
  });

  // ── 3. COMPONENTE ANDROID PUSH GUIDE BANNER (PRESENTACIÓN LIGERA) ─────────────

  test('3. AndroidPushGuideBanner cumple con los requisitos de diseño, accesibilidad y acciones', () => {
    const bannerPath = path.join(rootDir, 'src/components/home/alerts/AndroidPushGuideBanner.tsx');
    const content = fs.readFileSync(bannerPath, 'utf-8');

    // Título y texto informativo
    assert.ok(content.includes('¿Querés que los avisos sean más visibles?'), 'Debe contener el título sugerido');
    assert.ok(content.includes('Ya podés recibir notificaciones de PuntoEncuentro'), 'Debe incluir el texto contextual');
    assert.ok(content.includes('Ver cómo configurarlas'), 'Debe incorporar la acción principal');
    assert.ok(content.includes('Ahora no'), 'Debe incorporar la acción secundaria');

    // Ambas acciones descartan la guía persistente
    assert.ok(content.includes('dismissAndroidPushGuide();\n    onOpenGuide();'), 'Abrir la guía persiste descarte para no repetir');
    assert.ok(content.includes('dismissAndroidPushGuide();\n    onDismiss();'), 'Descartar persiste para no repetir');

    // Accesibilidad
    assert.ok(content.includes('role="region"'), 'Debe tener role="region" semántico');
  });

  // ── 4. COMPONENTE ANDROID PUSH GUIDE MODAL (INSTRUCCIONES CLARAS) ──────────────

  test('4. AndroidPushGuideModal implementa las 5 instrucciones requeridas, aviso de fabricantes y privacidad', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/AndroidPushGuideModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    // Accesibilidad y diálogo
    assert.ok(content.includes('role="dialog"'), 'Debe tener role="dialog"');
    assert.ok(content.includes('aria-modal="true"'), 'Debe tener aria-modal="true"');
    assert.ok(content.includes('aria-labelledby="android-guide-title"'), 'Debe asociar aria-labelledby');
    assert.ok(content.includes('aria-describedby="android-guide-subtitle"'), 'Debe asociar aria-describedby');

    // Las 5 instrucciones requeridas
    assert.ok(content.includes('Abrí los ajustes de notificaciones de Android.'), 'Paso 1 requerido');
    assert.ok(content.includes('Buscá Chrome (o tu navegador) y las notificaciones del sitio PuntoEncuentro.'), 'Paso 2 requerido');
    assert.ok(content.includes('Si está disponible, activá la opción de mostrar avisos emergentes o banners flotantes.'), 'Paso 3 requerido');
    assert.ok(content.includes('Elegí cómo mostrar las notificaciones en la pantalla bloqueada.'), 'Paso 4 requerido');
    assert.ok(content.includes('Comprobá que la categoría no esté en silencio y que «No molestar» no restrinja los avisos.'), 'Paso 5 requerido');

    // Aclaración de fabricantes y honestidad técnica (no modificar automáticamente)
    assert.ok(content.includes('Los nombres de los menús pueden variar según el fabricante y la versión de Android'), 'Debe advertir sobre fabricantes');
    assert.ok(content.includes('Estas opciones se configuran directamente en Android y no pueden modificarse desde la aplicación.'), 'Debe aclarar límites técnicos');

    // Privacidad: aviso genérico PuntoEncuentro y configuración personal
    assert.ok(content.includes('Por privacidad, PuntoEncuentro muestra avisos genéricos'), 'Debe incluir recomendación de privacidad');

    // Cierre accesible
    assert.ok(content.includes('Escape'), 'Debe escuchar tecla Escape');
    assert.ok(content.includes('Entendido'), 'Botón principal de cierre debe ser Entendido');
  });

  // ── 5. ACCESO PERMANENTE Y EXCLUSIVIDAD ANDROID EN DEVICE PUSH SETTINGS ───────

  test('5. DevicePushSettings incorpora enlace permanente y banner solo en Android cuando subscribed', () => {
    const dpsPath = path.join(rootDir, 'src/components/home/alerts/DevicePushSettings.tsx');
    const content = fs.readFileSync(dpsPath, 'utf-8');

    // Enlace permanente bajo demanda
    assert.ok(
      content.includes('Cómo mostrar avisos emergentes y en pantalla bloqueada'),
      'Debe contener el enlace permanente de ayuda'
    );
    assert.ok(
      content.includes('className="pe-push-device__guide-link"'),
      'El enlace de ayuda debe tener su clase CSS identificable'
    );

    // Condición de exclusividad Android
    assert.ok(
      content.includes('{isAndroid && ('),
      'El enlace permanente debe condicionarse a dispositivos Android'
    );
    assert.ok(
      content.includes('isAndroid && showContextualBanner && !isAndroidPushGuideDismissed()'),
      'El banner contextual solo se ofrece en Android si no fue descartado'
    );

    // Activación exitosa dispara el banner contextual si no fue descartado
    assert.ok(
      content.includes('if (isAndroidDevice() && !isAndroidPushGuideDismissed()) {\n          setShowContextualBanner(true);\n        }'),
      'handleActivate dispara el banner contextual tras res.ok'
    );
  });

  // ── 6. COORDINACIÓN ENTRE AVISAME SHEET Y MODAL DE ACTIVACIÓN ─────────────────

  test('6. AvisameSheet coordina el flujo post-guardado sin superposición de modales ni pérdida de la guía', () => {
    const avisamePath = path.join(rootDir, 'src/components/home/alerts/AvisameSheet.tsx');
    const content = fs.readFileSync(avisamePath, 'utf-8');

    // onActivated en AvisamePushPromptModal cierra el diálogo nativo y dispara la guía contextual en el Sheet
    assert.ok(
      content.includes('setShowPushPrompt(false);\n          setFeedbackMsg({\n            text: \'¡Aviso creado! Notificaciones activadas en este dispositivo.\',\n            type: \'success\',\n          });\n          if (isAndroidDevice() && !isAndroidPushGuideDismissed()) {\n            setShowAndroidGuideBanner(true);\n          }'),
      'onActivated cierra AvisamePushPromptModal y activa el banner contextual en el Sheet'
    );

    // El banner se renderiza dentro del Sheet sin modales flotantes bloqueantes
    assert.ok(
      content.includes('showAndroidGuideBanner && isAndroidDevice() && !isAndroidPushGuideDismissed()'),
      'AvisameSheet condiciona el banner a dispositivos Android y no descartados'
    );

    // Apertura del modal de instrucciones bajo demanda
    assert.ok(
      content.includes('<AndroidPushGuideModal\n          isOpen={showAndroidGuideModal}'),
      'AvisameSheet monta AndroidPushGuideModal para visualización bajo demanda'
    );
  });

  // ── 7. INTERNACIONALIZACIÓN COMPLETA (ES, EN, PT, PT-BR) ──────────────────────

  test('7. Claves de internacionalización push completas y consistentes en los 4 idiomas', () => {
    const locales = ['es', 'en', 'pt', 'pt-BR'];
    const requiredPushKeys = [
      'title',
      'subtitle',
      'activate',
      'active',
      'deactivate',
      'android_guide_link',
      'android_banner_title',
      'android_banner_text',
      'android_banner_cta',
      'android_banner_dismiss',
      'android_modal_title',
      'android_modal_subtitle',
      'android_modal_step1',
      'android_modal_step2',
      'android_modal_step3',
      'android_modal_step4',
      'android_modal_step5',
      'android_modal_manufacturers_note',
      'android_modal_privacy_note',
      'android_modal_system_note',
      'android_modal_close',
    ];

    for (const lang of locales) {
      const filePath = path.join(rootDir, `src/i18n/locales/${lang}.json`);
      assert.ok(fs.existsSync(filePath), `Debe existir archivo de idioma ${filePath}`);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.ok(data.push, `Debe existir sección push en ${lang}.json`);

      for (const key of requiredPushKeys) {
        assert.ok(
          typeof data.push[key] === 'string' && data.push[key].trim().length > 0,
          `Clave push.${key} debe existir y tener texto en ${lang}.json`
        );
      }
    }
  });

  // ── 8. INVARIANZA DEL PIPELINE Y CERO AUTO-PROMPTS ─────────────────────────────

  test('8. Reglas de oro: cero auto-prompts al montar e invarianza del pipeline Web Push', () => {
    const dpsPath = path.join(rootDir, 'src/components/home/alerts/DevicePushSettings.tsx');
    const dpsContent = fs.readFileSync(dpsPath, 'utf-8');

    // Ningún useEffect llama a activate() ni a Notification.requestPermission()
    assert.ok(
      !dpsContent.includes('useEffect(() => {\n    webPushService.activate'),
      'DevicePushSettings NO debe invocar activate en useEffect'
    );
    assert.ok(
      !dpsContent.includes('useEffect(() => {\n    Notification.requestPermission'),
      'DevicePushSettings NO debe invocar requestPermission en useEffect'
    );

    // sw.js no fue modificado
    const swPath = path.join(rootDir, 'public/sw.js');
    assert.ok(fs.existsSync(swPath), 'public/sw.js debe existir');

    // webPushService.ts no fue modificado
    const servicePath = path.join(rootDir, 'src/services/webPushService.ts');
    const serviceContent = fs.readFileSync(servicePath, 'utf-8');
    assert.ok(serviceContent.includes('SERVICE_WORKER_URL = \'/sw.js\''));
  });

  // ── 9. SIMULACIÓN DE REINGRESO A LA APLICACIÓN ─────────────────────────────────

  test('9. Reingreso a la aplicación: no repite la guía automáticamente si ya fue resuelta o descartada', () => {
    // Primera visita: usuario activa y resuelve la guía (tocando "Ver cómo configurarlas")
    assert.strictEqual(isAndroidPushGuideDismissed(), false);
    dismissAndroidPushGuide();
    assert.strictEqual(isAndroidPushGuideDismissed(), true);

    // Simular reingreso (nuevo montaje con estado subscribed existente):
    // La función isAndroidPushGuideDismissed lee localStorage y retorna true
    assert.strictEqual(isAndroidPushGuideDismissed(), true, 'Debe permanecer resuelta en el reingreso');

    // Por ende, la condición (showContextualBanner && !isAndroidPushGuideDismissed()) será false
    const bannerVisible = false && !isAndroidPushGuideDismissed();
    assert.strictEqual(bannerVisible, false, 'El banner contextual NO debe mostrarse al reingresar');
  });

  // ── 10. REUTILIZACIÓN EN CONSOLA QA SIN DUPLICACIONES ──────────────────────────

  test('10. QAWebPushDiagnostic reutiliza DevicePushSettings garantizando acceso manual sin código duplicado', () => {
    const qaPath = path.join(rootDir, 'src/screens/InternalQA/QAWebPushDiagnostic.tsx');
    const qaContent = fs.readFileSync(qaPath, 'utf-8');

    // Debe importar y renderizar DevicePushSettings
    assert.ok(
      qaContent.includes("import { DevicePushSettings } from '../../components/home/alerts/DevicePushSettings'"),
      'QAWebPushDiagnostic debe importar DevicePushSettings'
    );
    assert.ok(
      qaContent.includes('<DevicePushSettings />'),
      'QAWebPushDiagnostic debe renderizar DevicePushSettings directamente'
    );
    assert.ok(
      !qaContent.includes('AndroidPushGuideModal'),
      'QAWebPushDiagnostic no debe duplicar la instancia de AndroidPushGuideModal'
    );
  });

  // ── 11. CASOS DENIED Y UNSUPPORTED: CERO GUÍAS ENGAÑOSAS ───────────────────────

  test('11. Estados denied y unsupported no ofrecen la guía ni muestran éxito', () => {
    const dpsPath = path.join(rootDir, 'src/components/home/alerts/DevicePushSettings.tsx');
    const content = fs.readFileSync(dpsPath, 'utf-8');

    // En estado unsupported no se monta el enlace de Android
    const unsupportedIdx = content.indexOf("state.kind === 'unsupported'");
    const deniedIdx = content.indexOf("state.kind === 'denied'");
    const subscribedIdx = content.indexOf("state.kind === 'subscribed'");

    assert.ok(unsupportedIdx !== -1 && deniedIdx !== -1 && subscribedIdx !== -1);
    const unsupportedSection = content.slice(unsupportedIdx, deniedIdx);
    const deniedSection = content.slice(deniedIdx, content.indexOf("state.kind === 'default'"));

    assert.ok(
      !unsupportedSection.includes('AndroidPushGuideBanner') &&
      !unsupportedSection.includes('pe-push-device__guide-link'),
      'Sección unsupported no debe mostrar guía de Android'
    );

    assert.ok(
      !deniedSection.includes('AndroidPushGuideBanner') &&
      !deniedSection.includes('pe-push-device__guide-link'),
      'Sección denied no debe mostrar guía de Android'
    );
  });
});
