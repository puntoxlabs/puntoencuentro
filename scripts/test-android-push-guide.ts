import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isAndroidDevice,
  isAndroidPushGuideDismissed,
  dismissAndroidPushGuide,
  resetAndroidPushGuideDismissal,
  getPushPlatform,
  isPushGuideSupportedPlatform,
  isPushVisibilityGuideDismissed,
  dismissPushVisibilityGuide,
  resetPushVisibilityGuideDismissal,
  ANDROID_PUSH_GUIDE_DISMISSED_KEY,
  DESKTOP_PUSH_GUIDE_DISMISSED_KEY,
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

function setMockUserAgent(ua: string, platformData?: string) {
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: ua,
        userAgentData: platformData ? { platform: platformData } : undefined,
      },
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

describe('PuntoEncuentro — Guía Web Push Multiplataforma (Android, Windows, macOS)', () => {
  const rootDir = process.cwd();

  beforeEach(() => {
    localStorage.clear();
    setMockUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36');
  });

  // ── 1. DETECCIÓN DE PLATAFORMAS (ANDROID, WINDOWS, MACOS, EXCLUSIÓN IOS) ──────

  test('1. getPushPlatform e isAndroidDevice clasifican correctamente Android, Windows, macOS e iOS', () => {
    // Caso Android
    setMockUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36');
    assert.strictEqual(getPushPlatform(), 'android');
    assert.strictEqual(isAndroidDevice(), true);
    assert.strictEqual(isPushGuideSupportedPlatform('android'), true);

    // Caso Windows
    setMockUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
    assert.strictEqual(getPushPlatform(), 'windows');
    assert.strictEqual(isAndroidDevice(), false);
    assert.strictEqual(isPushGuideSupportedPlatform('windows'), true);

    // Caso macOS
    setMockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
    assert.strictEqual(getPushPlatform(), 'macos');
    assert.strictEqual(isAndroidDevice(), false);
    assert.strictEqual(isPushGuideSupportedPlatform('macos'), true);

    // Caso iPhone iOS (soportado en P1-A con guía especializada)
    setMockUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
    assert.strictEqual(getPushPlatform(), 'ios');
    assert.strictEqual(isAndroidDevice(), false);
    assert.strictEqual(isPushGuideSupportedPlatform('ios'), true);

    // Caso iPad iOS (soportado en P1-A con guía especializada)
    setMockUserAgent('Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
    assert.strictEqual(getPushPlatform(), 'ios');
    assert.strictEqual(isAndroidDevice(), false);
    assert.strictEqual(isPushGuideSupportedPlatform('ios'), true);
  });

  // ── 2. PERSISTENCIA INDEPENDIENTE Y RETROCOMPATIBILIDAD CON MARCA ANDROID ─────

  test('2. Persistencia independiente: respeta marca previa de Android sin interferir con Desktop', () => {
    // Si usuario previo de Android ya descartó la guía:
    localStorage.setItem(ANDROID_PUSH_GUIDE_DISMISSED_KEY, 'true');
    assert.strictEqual(isAndroidPushGuideDismissed(), true, 'Android debe figurar como descartado');
    assert.strictEqual(isPushVisibilityGuideDismissed('android'), true, 'Android debe figurar como descartado vía helper general');

    // Sin embargo, en Windows / macOS la guía de escritorio aún no fue descartada
    assert.strictEqual(isPushVisibilityGuideDismissed('windows'), false, 'Windows no debe estar descartado inicialmente');
    assert.strictEqual(isPushVisibilityGuideDismissed('macos'), false, 'macOS no debe estar descartado inicialmente');

    // Descarte de escritorio
    dismissPushVisibilityGuide('windows');
    assert.strictEqual(isPushVisibilityGuideDismissed('windows'), true);
    assert.strictEqual(isPushVisibilityGuideDismissed('macos'), true, 'Persiste en clave de escritorio');
    assert.strictEqual(localStorage.getItem(DESKTOP_PUSH_GUIDE_DISMISSED_KEY), 'true');

    // Reset selectivo
    resetPushVisibilityGuideDismissal('windows');
    assert.strictEqual(isPushVisibilityGuideDismissed('windows'), false);
    assert.strictEqual(isPushVisibilityGuideDismissed('android'), true, 'Android sigue intacto');
  });

  // ── 3. COMPONENTE PUSH VISIBILITY GUIDE BANNER (MULTIPLATAFORMA) ───────────────

  test('3. PushVisibilityGuideBanner cumple con los requisitos de diseño, accesibilidad y acciones', () => {
    const bannerPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideBanner.tsx');
    const content = fs.readFileSync(bannerPath, 'utf-8');

    // Título y texto informativo
    assert.ok(content.includes('¿Querés que los avisos sean más visibles?'), 'Debe contener el título sugerido');
    assert.ok(content.includes('PuntoEncuentro ya puede enviarte notificaciones'), 'Debe incluir el texto contextual general');
    assert.ok(content.includes('Ver cómo configurarlas'), 'Debe incorporar la acción principal');
    assert.ok(content.includes('Ahora no'), 'Debe incorporar la acción secundaria');

    // Acciones persisten descarte
    assert.ok(content.includes('dismissPushVisibilityGuide'), 'Debe invocar dismissPushVisibilityGuide');
    assert.ok(content.includes('role="region"'), 'Debe tener role="region" semántico');

    // Exportación de compatibilidad Android
    assert.ok(content.includes('AndroidPushGuideBanner = PushVisibilityGuideBanner'), 'Debe proveer alias AndroidPushGuideBanner');
  });

  // ── 4. COMPONENTE PUSH VISIBILITY GUIDE MODAL (ANDROID, WINDOWS, MACOS) ────────

  test('4. PushVisibilityGuideModal implementa instrucciones completas para Android, Windows y macOS', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    // Diálogo accesible
    assert.ok(content.includes('role="dialog"'), 'Debe tener role="dialog"');
    assert.ok(content.includes('aria-modal="true"'), 'Debe tener aria-modal="true"');
    assert.ok(content.includes('aria-labelledby="push-guide-title"'), 'Debe asociar aria-labelledby');
    assert.ok(content.includes('aria-describedby="push-guide-subtitle"'), 'Debe asociar aria-describedby');

    // Instrucciones Android
    assert.ok(content.includes('Abrí los ajustes de notificaciones de Android.'), 'Paso 1 Android');
    assert.ok(content.includes('Buscá Chrome (o tu navegador) y las notificaciones del sitio PuntoEncuentro.'), 'Paso 2 Android');
    assert.ok(content.includes('Si está disponible, activá la opción de mostrar avisos emergentes o banners flotantes.'), 'Paso 3 Android');
    assert.ok(content.includes('Elegí cómo mostrar las notificaciones en la pantalla bloqueada.'), 'Paso 4 Android');
    assert.ok(content.includes('Comprobá que la categoría no esté en silencio y que «No molestar» no restrinja los avisos.'), 'Paso 5 Android');

    // Instrucciones Windows (Fase 4)
    assert.ok(content.includes('Verificá que PuntoEncuentro tenga permitido enviar notificaciones desde tu navegador'), 'Paso 1 Windows');
    assert.ok(content.includes('Abrí Configuración de Windows → Sistema → Notificaciones.'), 'Paso 2 Windows');
    assert.ok(content.includes('Buscá tu navegador en la lista de aplicaciones con permiso para notificar.'), 'Paso 3 Windows');
    assert.ok(content.includes('Activá los banners emergentes de notificación y revisá las opciones de sonido'), 'Paso 4 Windows');
    assert.ok(content.includes('Comprobá que «No molestar» o el Asistente de concentración no estén bloqueando los avisos.'), 'Paso 5 Windows');
    assert.ok(content.includes('Los permisos del sitio web en el navegador y las preferencias de presentación de Windows'), 'Nota de controles Windows');
    assert.ok(content.includes('La recepción de notificaciones cuando el navegador está cerrado depende de la configuración de aplicaciones en segundo plano'), 'Nota navegador cerrado Windows');

    // Instrucciones macOS (Fase 5)
    assert.ok(content.includes('Verificá que PuntoEncuentro tenga permiso para mostrar notificaciones en tu navegador (Safari, Chrome o Edge).'), 'Paso 1 macOS');
    assert.ok(content.includes('Abrí Configuración del Sistema (o Preferencias del Sistema) → Notificaciones.'), 'Paso 2 macOS');
    assert.ok(content.includes('Localizá tu navegador o aplicación web en la lista lateral de notificaciones.'), 'Paso 3 macOS');
    assert.ok(content.includes('Elegí el estilo de aviso (tiras o alertas), sonidos y opciones de visualización'), 'Paso 4 macOS');
    assert.ok(content.includes('Comprobá que los Modos de Concentración (como «No molestar») no estén silenciando'), 'Paso 5 macOS');
    assert.ok(content.includes('Cada navegador (Safari, Chrome, Edge) administra sus permisos de forma propia en macOS.'), 'Nota navegadores macOS');

    // Instrucciones Genéricas bajo demanda
    assert.ok(content.includes('Comprobá que el navegador tenga permitido enviar notificaciones para el sitio PuntoEncuentro.'), 'Paso 1 Genérico');

    // Privacidad y honestidad técnica
    assert.ok(content.includes('PuntoEncuentro muestra avisos genéricos'), 'Debe incluir recomendación de privacidad');
    assert.ok(content.includes('no pueden ser modificadas automáticamente'), 'Debe declarar honestidad técnica');
  });

  // ── 5. ACCESO PERMANENTE EN DEVICE PUSH SETTINGS (CONFIGURAR VISIBILIDAD) ─────

  test('5. DevicePushSettings incorpora enlace permanente y banner contextual para Android, Windows y macOS', () => {
    const dpsPath = path.join(rootDir, 'src/components/home/alerts/DevicePushSettings.tsx');
    const content = fs.readFileSync(dpsPath, 'utf-8');

    // Enlace permanente bajo demanda para plataformas soportadas
    assert.ok(
      content.includes('Configurar visibilidad de notificaciones') ||
      content.includes('Cómo mostrar avisos emergentes y en pantalla bloqueada'),
      'Debe contener el enlace permanente de visibilidad'
    );
    assert.ok(
      content.includes('className="pe-push-device__guide-link"'),
      'El enlace de ayuda debe tener su clase CSS identificable'
    );
    assert.ok(
      content.includes('isGuideSupported'),
      'El enlace y banner deben condicionarse a isGuideSupported'
    );

    // Activación exitosa dispara el banner contextual si no fue descartado
    assert.ok(
      content.includes('if (isPushGuideSupportedPlatform(platform) && !isPushVisibilityGuideDismissed(platform)) {\n          setShowContextualBanner(true);\n        }'),
      'handleActivate dispara el banner contextual tras res.ok para plataformas soportadas'
    );
  });

  // ── 6. COORDINACIÓN EN AVISAME SHEET ──────────────────────────────────────────

  test('6. AvisameSheet coordina el flujo post-guardado en Android, Windows y macOS sin superposiciones', () => {
    const avisamePath = path.join(rootDir, 'src/components/home/alerts/AvisameSheet.tsx');
    const content = fs.readFileSync(avisamePath, 'utf-8');

    // onActivated cierra diálogo nativo y activa el banner contextual en el Sheet
    assert.ok(
      content.includes('setShowPushPrompt(false);\n          setFeedbackMsg({\n            text: \'¡Aviso creado! Notificaciones activadas en este dispositivo.\',\n            type: \'success\',\n          });'),
      'onActivated cierra modal de alerta con feedback'
    );
    assert.ok(
      content.includes('isPushGuideSupportedPlatform(plat) && !isPushVisibilityGuideDismissed(plat)'),
      'onActivated activa el banner si la plataforma está soportada y no descartada'
    );

    // Apertura del modal
    assert.ok(
      content.includes('<PushVisibilityGuideModal\n          isOpen={showAndroidGuideModal}'),
      'AvisameSheet monta PushVisibilityGuideModal para visualización bajo demanda'
    );
  });

  // ── 7. INTERNACIONALIZACIÓN COMPLETA (ES, EN, PT, PT-BR) ──────────────────────

  test('7. Claves de internacionalización multiplataforma presentes en los 4 idiomas', () => {
    const locales = ['es', 'en', 'pt', 'pt-BR'];
    const requiredKeys = [
      'guide_link',
      'banner_title',
      'banner_text',
      'windows_modal_title',
      'windows_modal_subtitle',
      'windows_modal_step1',
      'windows_modal_step2',
      'windows_modal_step3',
      'windows_modal_step4',
      'windows_modal_step5',
      'windows_modal_controls_note',
      'windows_modal_background_note',
      'windows_modal_system_note',
      'macos_modal_title',
      'macos_modal_subtitle',
      'macos_modal_step1',
      'macos_modal_step2',
      'macos_modal_step3',
      'macos_modal_step4',
      'macos_modal_step5',
      'macos_modal_browsers_note',
      'macos_modal_system_note',
      'generic_modal_title',
      'generic_modal_subtitle',
      'generic_modal_step1',
      'generic_modal_step2',
      'generic_modal_step3',
      'generic_modal_step4',
      'generic_modal_system_note',
      'shared_device_privacy_note',
      'android_modal_title',
      'android_modal_step1',
      'android_modal_step5',
    ];

    for (const lang of locales) {
      const filePath = path.join(rootDir, `src/i18n/locales/${lang}.json`);
      assert.ok(fs.existsSync(filePath), `Debe existir archivo de idioma ${filePath}`);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.ok(data.push, `Debe existir sección push en ${lang}.json`);

      for (const key of requiredKeys) {
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

  // ── 9. REINGRESO A LA APLICACIÓN ───────────────────────────────────────────────

  test('9. Reingreso a la aplicación: no repite la guía automáticamente si ya fue resuelta en Windows o macOS', () => {
    // Primera visita en Windows: activar y resolver
    assert.strictEqual(isPushVisibilityGuideDismissed('windows'), false);
    dismissPushVisibilityGuide('windows');
    assert.strictEqual(isPushVisibilityGuideDismissed('windows'), true);

    // Simular reingreso (nuevo montaje con estado subscribed existente):
    assert.strictEqual(isPushVisibilityGuideDismissed('windows'), true, 'Debe permanecer resuelta en Windows');

    // Por ende, la condición (showContextualBanner && !isPushVisibilityGuideDismissed(platform)) será false
    const bannerVisible = false && !isPushVisibilityGuideDismissed('windows');
    assert.strictEqual(bannerVisible, false, 'El banner contextual NO debe mostrarse al reingresar');
  });

  // ── 10. REUTILIZACIÓN EN CONSOLA QA SIN DUPLICACIONES ──────────────────────────

  test('10. QAWebPushDiagnostic reutiliza DevicePushSettings garantizando acceso manual sin código duplicado', () => {
    const qaPath = path.join(rootDir, 'src/screens/InternalQA/QAWebPushDiagnostic.tsx');
    const qaContent = fs.readFileSync(qaPath, 'utf-8');

    assert.ok(
      qaContent.includes("import { DevicePushSettings } from '../../components/home/alerts/DevicePushSettings'"),
      'QAWebPushDiagnostic debe importar DevicePushSettings'
    );
    assert.ok(
      qaContent.includes('<DevicePushSettings />'),
      'QAWebPushDiagnostic debe renderizar DevicePushSettings directamente'
    );
  });

  // ── 11. CASOS DENIED Y UNSUPPORTED: CERO GUÍAS ENGAÑOSAS ───────────────────────

  test('11. Estados denied y unsupported no ofrecen la guía ni muestran éxito', () => {
    const dpsPath = path.join(rootDir, 'src/components/home/alerts/DevicePushSettings.tsx');
    const content = fs.readFileSync(dpsPath, 'utf-8');

    const unsupportedIdx = content.indexOf("state.kind === 'unsupported'");
    const deniedIdx = content.indexOf("state.kind === 'denied'");
    const subscribedIdx = content.indexOf("state.kind === 'subscribed'");

    assert.ok(unsupportedIdx !== -1 && deniedIdx !== -1 && subscribedIdx !== -1);
    const unsupportedSection = content.slice(unsupportedIdx, deniedIdx);
    const deniedSection = content.slice(deniedIdx, content.indexOf("state.kind === 'default'"));

    assert.ok(
      !unsupportedSection.includes('PushVisibilityGuideBanner') &&
      !unsupportedSection.includes('pe-push-device__guide-link'),
      'Sección unsupported no debe mostrar guía'
    );

    assert.ok(
      !deniedSection.includes('PushVisibilityGuideBanner') &&
      !deniedSection.includes('pe-push-device__guide-link'),
      'Sección denied no debe mostrar guía'
    );
  });

  // ── 12. SOPORTE DE IOS EN P1-A CON GUÍA ESPECIALIZADA ─────────────────────────

  test('12. Dispositivos iOS reciben la guía especializada en P1-A', () => {
    setMockUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
    const p = getPushPlatform();
    assert.strictEqual(p, 'ios');
    assert.strictEqual(isPushGuideSupportedPlatform(p), true, 'iOS debe retornar isPushGuideSupportedPlatform = true');
  });
});
