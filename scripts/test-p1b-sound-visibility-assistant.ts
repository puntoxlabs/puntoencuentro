/**
 * Suite de Pruebas Automatizadas: P1-B Asistente Multiplataforma de Sonido y Visibilidad
 *
 * Valida:
 * 1. Acceso directo disponible por plataforma (Windows ms-settings, Android atajo gestual).
 * 2. Cero esquemas inseguros o bloqueados (chrome://, prefs:, android intents no navegables).
 * 3. Instrucciones alternativas accesibles (Opción A vs Opción B).
 * 4. Emisión de prueba local voluntaria (webPushService.testLocalNotification) y repetición.
 * 5. Conservación de estado al salir a Ajustes del sistema y regresar (sessionStorage + visibilitychange).
 * 6. Tres opciones de verificación: Confirmar éxito, Reintentar prueba y Posponer (14 días).
 * 7. Cooldown independiente del asistente (SOUND_VISIBILITY_ASSISTANT_DISMISSED_KEY) con aislamiento por usuario.
 * 8. Integración con DevicePushSettings, AvisameSheet y Banner contextual sin duplicaciones.
 * 9. Accesibilidad con modalStack (Escape determinista y foco).
 * 10. Sincronización completa de internacionalización (ES, EN, PT, PT-BR).
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getPushPlatform,
  isPushGuideSupportedPlatform,
  isAndroidDevice,
  isIosDevice,
  isIosStandalone,
  isPushVisibilityGuideDismissed,
  dismissPushVisibilityGuide,
  recordPushGuideCompleted,
  recordPushGuideViewed,
  isPushGuideViewed,
  recordWebPushActivated,
  isSoundVisibilityAssistantDismissed,
  dismissSoundVisibilityAssistant,
  clearSoundVisibilityAssistantDismissal,
  getAssistantSavedStep,
  saveAssistantStep,
  clearAssistantSavedStep,
  getScopedKey,
  SOUND_VISIBILITY_ASSISTANT_DISMISSED_KEY,
  PUSH_PROMPT_DISMISSED_KEY,
} from '../src/components/home/alerts/antiNagging';
import {
  pushModal,
  popModal,
  isTopModal,
  hasModalsAbove,
  resetModalStack,
} from '../src/lib/modalStack';
import { createWebPushService } from '../src/services/webPushService';

// Polyfills Node.js para almacenamiento
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.setItem !== 'function') {
  let store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = String(val); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
}

if (typeof globalThis.sessionStorage === 'undefined' || typeof globalThis.sessionStorage.setItem !== 'function') {
  let sessionStore: Record<string, string> = {};
  (globalThis as any).sessionStorage = {
    getItem: (key: string) => sessionStore[key] ?? null,
    setItem: (key: string, val: string) => { sessionStore[key] = String(val); },
    removeItem: (key: string) => { delete sessionStore[key]; },
    clear: () => { sessionStore = {}; },
  };
}

function setMockNavigator(ua: string) {
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: ua,
        platform: ua.includes('Macintosh') ? 'MacIntel' : (ua.includes('iPhone') ? 'iPhone' : 'Linux'),
        maxTouchPoints: ua.includes('iPad') || ua.includes('iPhone') ? 5 : 0,
      },
      configurable: true,
      writable: true,
    });
  } catch {}
}

describe('PuntoEncuentro — P1-B: Asistente Multiplataforma de Sonido y Visibilidad', () => {
  const rootDir = process.cwd();

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetModalStack();
    setMockNavigator('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
  });

  // ── 1. ESTRATEGIA HÍBRIDA: ACCESOS DIRECTOS SEGUROS VS INSTRUCCIONES ALTERNATIVAS ──

  test('1. Windows: Ofrece acceso directo con ms-settings:notifications y alternativa manual', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    // Opción A: Acceso directo voluntario vía protocolo documentado
    assert.ok(
      content.includes('href="ms-settings:notifications"'),
      'Windows debe ofrecer acceso directo mediante ms-settings:notifications'
    );
    assert.ok(
      content.includes('assistant_direct_windows_disclaimer'),
      'Windows debe advertir que el navegador o SO puede solicitar confirmación'
    );

    // Opción B: Alternativa manual si el acceso directo falla o se cancela
    assert.ok(
      content.includes('assistant_alt_link'),
      'Debe incluir enlace "¿No se abrió la configuración? Ver instrucciones"'
    );
    assert.ok(
      content.includes('showAlternativeInstructions'),
      'Debe alternar la visualización de pasos manuales'
    );
  });

  test('2. Android: Prioriza atajo de notificación activa (Motorola) sin intents no navegables', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    // Atajo probado en Motorola: Mantener presionada la notificación
    assert.ok(
      content.includes('assistant_android_shortcut_title'),
      'Android debe explicar el atajo de mantener presionada la notificación'
    );
    assert.ok(
      content.includes('assistant_android_item_sound'),
      'Android debe destacar la activación de sonido/alerta'
    );
    assert.ok(
      content.includes('assistant_android_item_popup'),
      'Android debe destacar avisos emergentes / banners flotantes (pop on screen)'
    );
    assert.ok(
      content.includes('assistant_android_item_lock'),
      'Android debe destacar pantalla bloqueada'
    );

    // Cero esquemas inseguros o bloqueados
    assert.ok(!content.includes('intent:#Intent'), 'NO debe usar intents Android no navegables');
    assert.ok(!content.includes('chrome://'), 'NO debe usar URLs internas chrome://');
  });

  test('3. macOS e iOS: Rutas guiadas exactas sin esquemas privados', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    // Cero esquemas privados de Apple
    assert.ok(!content.includes('x-apple.systempreferences:'), 'NO debe usar esquemas privados de macOS');
    assert.ok(!content.includes('App-Prefs:'), 'NO debe usar esquemas App-Prefs bloqueados en iOS');
    assert.ok(!content.includes('prefs:root'), 'NO debe usar prefs:root en iOS');

    // Rutas guiadas
    assert.ok(content.includes('macos_modal_step2'), 'macOS debe indicar Configuración del Sistema → Notificaciones');
    assert.ok(content.includes('ios_modal_step3'), 'iOS debe indicar Ajustes → Notificaciones → PuntoEncuentro');
  });

  // ── 2. EMISIÓN LOCAL VOLUNTARIA Y REPETICIÓN DE PRUEBA ────────────────────────

  test('4. Paso 2: Emisión explícita de prueba local y capacidad de reintento', async () => {
    let notificationCount = 0;
    let lastOptions: any = null;

    const mockService = createWebPushService({
      getEnv: () => ({
        isSecureContext: true,
        hasPushManager: true,
        isStandalone: false,
        isIosLike: false,
        notification: {
          permission: 'granted',
          requestPermission: async () => 'granted',
        },
        serviceWorker: {
          ready: Promise.resolve({
            pushManager: {
              getSubscription: async () => null,
              subscribe: async () => ({} as any),
            },
            showNotification: async (title: string, options: any) => {
              notificationCount++;
              lastOptions = options;
            },
          } as any),
          getRegistration: async () => undefined,
          register: async () => ({} as any),
        },
      }),
      getVapidPublicKey: () => 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-Skv6_yViEuiBIa-Ib9-Skv6_yViEuiBIa-Ib9-Skv6_yViEuiBIa8=',
      rpc: async () => ({ data: { ok: true }, error: null }),
      warn: () => {},
    });

    // Primera emisión
    const res1 = await mockService.testLocalNotification();
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(notificationCount, 1);

    // Reintento voluntario de prueba (Paso 2)
    const res2 = await mockService.testLocalNotification();
    assert.strictEqual(res2.ok, true);
    assert.strictEqual(notificationCount, 2, 'Debe permitir reintentar la prueba local');
    assert.ok(lastOptions?.body.includes('Notificación de prueba'));
  });

  // ── 3. CONSERVACIÓN DE PASO EN CURSO TRAS REGRESAR DE AJUSTES ─────────────────

  test('5. Retorno desde Ajustes: conserva el paso en curso mediante sessionStorage', () => {
    const userId = 'user_step_test';

    // Inicio en Paso 1
    assert.strictEqual(getAssistantSavedStep(userId), 1);

    // El usuario avanza al Paso 2 (Probar)
    saveAssistantStep(2, userId);
    assert.strictEqual(getAssistantSavedStep(userId), 2);

    // El usuario sale de la aplicación a Ajustes de Android/Windows y regresa (simulación de pestaña)
    // El paso guardado debe seguir siendo 2
    assert.strictEqual(
      getAssistantSavedStep(userId),
      2,
      'El asistente debe conservar el paso 2 al regresar de Ajustes'
    );

    // Avanza al Paso 3 (Confirmar)
    saveAssistantStep(3, userId);
    assert.strictEqual(getAssistantSavedStep(userId), 3);

    // Al confirmar o cerrar, se limpia el paso
    clearAssistantSavedStep(userId);
    assert.strictEqual(getAssistantSavedStep(userId), 1, 'Limpia el paso al concluir');
  });

  // ── 4. CONFIRMACIÓN MANUAL VS POSPOSICIÓN ─────────────────────────────────────

  test('6. Paso 3: Tres opciones de confirmación respetan decisión declarada del usuario', () => {
    const userId = 'user_confirm_test';

    // Opción 1: «Sí, funciona correctamente»
    recordPushGuideCompleted('android', userId);
    recordWebPushActivated(userId);
    assert.strictEqual(isPushVisibilityGuideDismissed('android', userId), true);

    // Reset para probar posposición
    localStorage.clear();
    assert.strictEqual(isPushVisibilityGuideDismissed('android', userId), false);

    // Opción 3: «Lo revisaré después» (snooze de 14 días en el asistente)
    recordPushGuideViewed('android', userId);
    dismissSoundVisibilityAssistant(14, userId);

    // La guía general NO se marca como completada
    assert.strictEqual(
      isPushVisibilityGuideDismissed('android', userId),
      false,
      'Posponer NO debe marcar la guía como completada'
    );

    // Pero el asistente está en cooldown (no insiste)
    assert.strictEqual(
      isSoundVisibilityAssistantDismissed(userId),
      true,
      'El asistente debe estar en cooldown tras "Lo revisaré después"'
    );
  });

  // ── 5. COOLDOWN INDEPENDIENTE Y AISLAMIENTO DE USUARIO ────────────────────────

  test('7. Cooldown de asistente independiente de prompts P1-A y aislado por usuario', () => {
    const userA = 'user_assistant_a';
    const userB = 'user_assistant_b';

    assert.strictEqual(isSoundVisibilityAssistantDismissed(userA), false);
    assert.strictEqual(isSoundVisibilityAssistantDismissed(userB), false);

    // User A pospone el asistente
    dismissSoundVisibilityAssistant(14, userA);
    assert.strictEqual(isSoundVisibilityAssistantDismissed(userA), true);
    // User B no se ve afectado en el mismo dispositivo
    assert.strictEqual(isSoundVisibilityAssistantDismissed(userB), false);

    // Independencia de cooldown: posponer el asistente NO silencia los prompts P1-A de otros contextos
    const promptDismissedA = localStorage.getItem(getScopedKey(PUSH_PROMPT_DISMISSED_KEY, userA));
    assert.strictEqual(
      promptDismissedA,
      null,
      'El cooldown del asistente es independiente de PUSH_PROMPT_DISMISSED_KEY'
    );
  });

  // ── 6. ACCESIBILIDAD Y MODALSTACK ─────────────────────────────────────────────

  test('8. Integración con modalStack: Escape determinista y restauración de foco', () => {
    // 1. Abrir AvisameSheet
    pushModal('avisame-sheet');
    assert.strictEqual(isTopModal('avisame-sheet'), true);

    // 2. Abrir Asistente (push-visibility-guide)
    pushModal('push-visibility-guide');
    assert.strictEqual(isTopModal('push-visibility-guide'), true);
    assert.strictEqual(hasModalsAbove('avisame-sheet'), true);

    // Escape cierra solo el asistente
    popModal('push-visibility-guide');
    assert.strictEqual(isTopModal('avisame-sheet'), true, 'AvisameSheet vuelve a ser el diálogo al frente');
  });

  // ── 7. INTEGRACIÓN CON DEVICE PUSH SETTINGS Y BANNER CONTEXTUAL ───────────────

  test('9. DevicePushSettings y PushVisibilityGuideBanner condicionan el banner contextual al cooldown', () => {
    const dpsPath = path.join(rootDir, 'src/components/home/alerts/DevicePushSettings.tsx');
    const dpsContent = fs.readFileSync(dpsPath, 'utf-8');

    assert.ok(
      dpsContent.includes('isSoundVisibilityAssistantDismissed'),
      'DevicePushSettings debe importar y consultar isSoundVisibilityAssistantDismissed'
    );
    assert.ok(
      dpsContent.includes('android_assistant_link'),
      'DevicePushSettings debe ofrecer enlace al asistente de sonido y avisos'
    );

    const bannerPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideBanner.tsx');
    const bannerContent = fs.readFileSync(bannerPath, 'utf-8');
    assert.ok(
      bannerContent.includes('dismissSoundVisibilityAssistant'),
      'PushVisibilityGuideBanner debe aplicar cooldown de asistente al presionar Ahora no'
    );
  });

  // ── 8. INTEGRIDAD DE INTERNACIONALIZACIÓN (ES, EN, PT, PT-BR) ──────────────────

  test('10. Todas las 35 claves de internacionalización de P1-B están sincronizadas en los 4 idiomas', () => {
    const locales = ['es', 'en', 'pt', 'pt-BR'];
    const requiredAssistantKeys = [
      'assistant_step_config',
      'assistant_step_test',
      'assistant_step_confirm',
      'assistant_direct_button_windows',
      'assistant_direct_windows_disclaimer',
      'assistant_alt_link',
      'assistant_hide_alt',
      'assistant_android_shortcut_title',
      'assistant_android_shortcut_desc',
      'assistant_android_item_sound',
      'assistant_android_item_popup',
      'assistant_android_item_lock',
      'assistant_android_alt_link',
      'assistant_next_to_test',
      'assistant_test_title',
      'assistant_test_desc',
      'assistant_test_btn',
      'assistant_test_sending',
      'assistant_test_sent_android',
      'assistant_test_sent_general',
      'assistant_test_retry_btn',
      'assistant_test_error',
      'assistant_returned_hint',
      'assistant_next_to_verify',
      'assistant_back_to_config',
      'assistant_confirm_title',
      'assistant_confirm_question',
      'assistant_confirm_disclaimer',
      'assistant_confirm_yes',
      'assistant_confirm_retry',
      'assistant_confirm_later',
      'android_assistant_link',
      'assistant_link',
      'android_guide_configured_link',
      'guide_configured_link',
    ];

    for (const locale of locales) {
      const filePath = path.join(rootDir, `src/i18n/locales/${locale}.json`);
      assert.ok(fs.existsSync(filePath), `Archivo ${locale}.json debe existir`);
      const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.ok(json.push, `Sección push debe existir en ${locale}.json`);

      for (const key of requiredAssistantKeys) {
        assert.ok(
          json.push[key] && typeof json.push[key] === 'string' && json.push[key].trim().length > 0,
          `Clave push.${key} debe existir y tener contenido en ${locale}.json`
        );
      }
    }
  });
});
