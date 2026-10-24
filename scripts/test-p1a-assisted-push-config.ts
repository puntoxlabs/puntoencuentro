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
  isPushPromptDismissed,
  dismissPushPrompt,
  clearPushPromptDismissal,
  recordPushPromptShown,
  recordPushGuideViewed,
  isPushGuideViewed,
  recordPushGuideCompleted,
  recordWebPushActivated,
  hasEncounterCreatedBefore,
  recordEncounterCreated,
  hasParticipationConfirmedBefore,
  recordParticipationConfirmed,
  hasOpenParticipationNotified,
  recordOpenParticipationNotified,
  getScopedKey,
  isPushVisibilityGuideDismissed,
  dismissPushVisibilityGuide,
  resetPushVisibilityGuideDismissal,
  PUSH_PROMPT_DISMISSED_KEY,
  ANDROID_PUSH_GUIDE_DISMISSED_KEY,
  DESKTOP_PUSH_GUIDE_DISMISSED_KEY,
  IOS_PUSH_GUIDE_DISMISSED_KEY,
} from '../src/components/home/alerts/antiNagging';
import {
  pushModal,
  popModal,
  isTopModal,
  hasModalsAbove,
  resetModalStack,
} from '../src/lib/modalStack';
import { createWebPushService } from '../src/services/webPushService';

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

function setMockUserAgent(ua: string, platformData?: string, standalone = false) {
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: ua,
        platform: ua.includes('Macintosh') ? 'MacIntel' : (ua.includes('iPhone') ? 'iPhone' : 'Linux'),
        maxTouchPoints: ua.includes('iPad') || ua.includes('iPhone') ? 5 : 0,
        userAgentData: platformData ? { platform: platformData } : undefined,
        standalone,
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

  try {
    Object.defineProperty(globalThis, 'window', {
      value: {
        matchMedia: (query: string) => ({
          matches: query.includes('standalone') && standalone,
          media: query,
        }),
      },
      configurable: true,
      writable: true,
    });
  } catch {}
}

describe('PuntoEncuentro — P1-A: Configuración asistida de notificaciones importantes', () => {
  const rootDir = process.cwd();

  beforeEach(() => {
    localStorage.clear();
    resetModalStack();
    setMockUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
  });

  // ── 1. PLATAFORMAS: DETECCIÓN Y CAPACIDADES (INCLUYENDO IPHONE / IPAD) ─────────

  test('1. Detección y capacidades: clasifica Android, Windows, macOS e iOS con soporte de guías', () => {
    // Android
    setMockUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36');
    assert.strictEqual(getPushPlatform(), 'android');
    assert.strictEqual(isAndroidDevice(), true);
    assert.strictEqual(isIosDevice(), false);
    assert.strictEqual(isPushGuideSupportedPlatform('android'), true);

    // Windows
    setMockUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
    assert.strictEqual(getPushPlatform(), 'windows');
    assert.strictEqual(isAndroidDevice(), false);
    assert.strictEqual(isIosDevice(), false);
    assert.strictEqual(isPushGuideSupportedPlatform('windows'), true);

    // macOS
    setMockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
    assert.strictEqual(getPushPlatform(), 'macos');
    assert.strictEqual(isAndroidDevice(), false);
    assert.strictEqual(isIosDevice(), false);
    assert.strictEqual(isPushGuideSupportedPlatform('macos'), true);

    // iPhone (iOS)
    setMockUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
    assert.strictEqual(getPushPlatform(), 'ios');
    assert.strictEqual(isIosDevice(), true);
    assert.strictEqual(isAndroidDevice(), false);
    assert.strictEqual(isPushGuideSupportedPlatform('ios'), true);

    // iPadOS (MacIntel con touch points)
    setMockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1');
    (navigator as any).maxTouchPoints = 5;
    assert.strictEqual(getPushPlatform(), 'ios');
    assert.strictEqual(isIosDevice(), true);
    assert.strictEqual(isPushGuideSupportedPlatform('ios'), true);
  });

  test('2. Detección de modo de ejecución iOS (Browser vs Standalone PWA)', () => {
    // En navegador Safari común
    setMockUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)', undefined, false);
    assert.strictEqual(isIosStandalone(), false);

    // Ejecutándose agregado a pantalla de inicio (standalone)
    setMockUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)', undefined, true);
    assert.strictEqual(isIosStandalone(), true);
  });

  // ── 2. POLÍTICA ANTI-INSISTENCIA (5 DIMENSIONES) Y AISLAMIENTO DE USUARIO ──────

  test('3. Distingue las 5 dimensiones de anti-insistencia y respeta identidad en dispositivos compartidos', () => {
    const userA = 'user_11111111-1111-1111-1111-111111111111';
    const userB = 'user_22222222-2222-2222-2222-222222222222';

    // 1) Dimensión: Invitación mostrada
    recordPushPromptShown('host', userA);
    const shownRaw = localStorage.getItem(getScopedKey('pe_push_prompt_shown_v1', userA));
    assert.ok(shownRaw !== null);
    assert.strictEqual(JSON.parse(shownRaw).context, 'host');

    // 2) Dimensión: «Ahora no» (descarte temporal con período de descanso)
    assert.strictEqual(isPushPromptDismissed(userA), false);
    dismissPushPrompt(14, userA);
    assert.strictEqual(isPushPromptDismissed(userA), true, 'User A debe estar silenciado tras "Ahora no"');
    // Aislamiento: User B en el mismo dispositivo NO debe estar silenciado por la acción de User A
    assert.strictEqual(isPushPromptDismissed(userB), false, 'User B no debe heredar el snooze de User A');

    // 3) Dimensión: Guía consultada (abrir la guía NO marca completado)
    recordPushGuideViewed('ios', userA);
    assert.strictEqual(isPushGuideViewed('ios', userA), true);
    assert.strictEqual(
      isPushVisibilityGuideDismissed('ios', userA),
      false,
      'CRÍTICO: Abrir o consultar la guía NO debe marcarla como completada/descartada'
    );

    // 4) Dimensión: Configuración declarada completada («Entendido»)
    recordPushGuideCompleted('ios', userA);
    assert.strictEqual(
      isPushVisibilityGuideDismissed('ios', userA),
      true,
      'Click en "Entendido" sí marca la configuración como atendida'
    );
    assert.strictEqual(
      isPushVisibilityGuideDismissed('ios', userB),
      false,
      'User B aún no ha completado la guía'
    );

    // 5) Dimensión: Web Push activado (limpia descanso de prompts)
    recordWebPushActivated(userA);
    assert.strictEqual(
      isPushPromptDismissed(userA),
      false,
      'La activación exitosa limpia cualquier marca de descanso previo'
    );
  });

  test('3b. Aislamiento estricto de preferencias: usuario permanente nunca hereda claves legacy globales de otras cuentas', () => {
    const userA = 'user_legacy_001';
    const userB = 'user_clean_002';

    // Simular que en el navegador existía un descarte global legacy
    localStorage.setItem(PUSH_PROMPT_DISMISSED_KEY, String(Date.now() + 14 * 24 * 60 * 60 * 1000));
    localStorage.setItem(ANDROID_PUSH_GUIDE_DISMISSED_KEY, 'true');
    localStorage.setItem(DESKTOP_PUSH_GUIDE_DISMISSED_KEY, 'true');
    localStorage.setItem(IOS_PUSH_GUIDE_DISMISSED_KEY, 'true');

    // Compatibilidad: un llamador sin sesión (unscoped) todavía lee las claves legacy globales
    assert.strictEqual(isPushPromptDismissed(), true, 'Llamador legacy sin sesión detecta descarte');
    assert.strictEqual(isPushVisibilityGuideDismissed('android'), true, 'Llamador legacy sin sesión detecta guía descartada');

    // AISLAMIENTO: Un usuario permanente (con userId) NUNCA hereda las claves globales legacy
    assert.strictEqual(isPushPromptDismissed(userB), false, 'User B NO debe heredar el descarte legacy global');
    assert.strictEqual(isPushVisibilityGuideDismissed('android', userB), false, 'User B NO debe heredar la guía descartada legacy');
    assert.strictEqual(isPushVisibilityGuideDismissed('windows', userB), false, 'User B NO debe heredar la guía desktop legacy');
    assert.strictEqual(isPushVisibilityGuideDismissed('ios', userB), false, 'User B NO debe heredar la guía iOS legacy');

    // Si User A descarta con scope, solo User A se ve afectado
    dismissPushPrompt(14, userA);
    assert.strictEqual(isPushPromptDismissed(userA), true);
    assert.strictEqual(isPushPromptDismissed(userB), false);

    // Guía: «Lo haré después» registra vista pero NO completado
    recordPushGuideViewed('android', userB);
    assert.strictEqual(isPushGuideViewed('android', userB), true);
    assert.strictEqual(isPushVisibilityGuideDismissed('android', userB), false, '«Lo haré después» no debe marcar completado');

    // Guía: «Ya lo configuré» registra completado
    recordPushGuideCompleted('android', userB);
    assert.strictEqual(isPushVisibilityGuideDismissed('android', userB), true, '«Ya lo configuré» marca completado');
    assert.strictEqual(isPushVisibilityGuideDismissed('android', userA), false, 'User A permanece independiente');
  });

  // ── 3. RASTREO DE PRIMERAS ACCIONES CONTEXTUALES ─────────────────────────────

  test('4. Rastreos de primeras acciones: Anfitrión, Participante y Encuentro Abierto', () => {
    const userId = 'user_host_123';
    const encId = 'enc_abc_456';

    // Anfitrión
    assert.strictEqual(hasEncounterCreatedBefore(userId), false);
    recordEncounterCreated(userId);
    assert.strictEqual(hasEncounterCreatedBefore(userId), true);

    // Participante privado
    assert.strictEqual(hasParticipationConfirmedBefore(userId), false);
    recordParticipationConfirmed(userId);
    assert.strictEqual(hasParticipationConfirmedBefore(userId), true);

    // Participante en encuentro abierto aprobado
    assert.strictEqual(hasOpenParticipationNotified(encId, userId), false);
    recordOpenParticipationNotified(encId, userId);
    assert.strictEqual(hasOpenParticipationNotified(encId, userId), true);
  });

  test('4b. Flujo de invitaciones contextuales: error temporal de red NO consume la oportunidad de configuración', async () => {
    const userId = 'user_host_network_test';

    // 1. Simular fallo de red al consultar el estado del dispositivo
    let promptShown = false;

    const simulateContextualCheck = async (getDeviceStateFn: () => Promise<any>) => {
      if (hasEncounterCreatedBefore(userId) || isPushPromptDismissed(userId)) return;

      try {
        const devState = await getDeviceStateFn();
        if (devState.kind === 'subscribed') {
          recordWebPushActivated(userId);
          recordEncounterCreated(userId);
          return;
        }
        if (devState.kind === 'not_configured') {
          return;
        }
        recordEncounterCreated(userId);
        promptShown = true;
      } catch {
        // Error de red temporal: NO consumir oportunidad
      }
    };

    // Ejecutar con fallo de red
    await simulateContextualCheck(async () => {
      throw new Error('Failed to fetch / Network error');
    });

    assert.strictEqual(promptShown, false);
    assert.strictEqual(hasEncounterCreatedBefore(userId), false, 'Oportunidad NO consumida tras error de red');

    // 2. Ejecutar con éxito cuando vuelve la conexión
    await simulateContextualCheck(async () => {
      return { kind: 'default', isSubscribed: false };
    });

    assert.strictEqual(promptShown, true, 'Invitación mostrada tras reintento exitoso');
    assert.strictEqual(hasEncounterCreatedBefore(userId), true, 'Ahora sí se registra la acción');
  });

  // ── 4. ACCESIBILIDAD: GESTIÓN DE PILA DE MODALES (ESCAPE DETERMINISTA Y FOCO) ─

  test('5. Pila de modales (Modal Stack) asegura que Escape cierre solo el diálogo superior y restaura foco ante rerenders', () => {
    const listeners: Record<string, ((e: any) => void)[]> = {};
    let activeElement: any = null;

    (globalThis as any).window = {
      addEventListener: (event: string, cb: (e: any) => void) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      },
      removeEventListener: (event: string, cb: (e: any) => void) => {
        if (!listeners[event]) return;
        listeners[event] = listeners[event].filter((fn) => fn !== cb);
      },
      dispatchEvent: (e: any) => {
        const cbs = listeners[e.type] || [];
        for (const cb of [...cbs]) {
          cb(e);
        }
        return true;
      },
    };

    const createElement = (name: string) => {
      const el = {
        name,
        focus: () => { activeElement = el; },
      };
      return el;
    };

    (globalThis as any).document = {
      get activeElement() {
        return activeElement;
      },
    };

    // Botón en la Home que abre AvisameSheet
    const homeBellBtn = createElement('homeBellBtn');
    homeBellBtn.focus();
    assert.strictEqual(document.activeElement, homeBellBtn);

    // Emulador de ciclo de vida del hook useModalStack
    function createHookInstance(modalId: string) {
      let isOpen = false;
      let prevActive: any = null;
      let currentOptions: any = null;
      let keydownListener: any = null;

      return {
        render: (nextIsOpen: boolean, options: any) => {
          currentOptions = options;
          if (nextIsOpen && !isOpen) {
            isOpen = true;
            prevActive = document.activeElement;
            pushModal(modalId);
            keydownListener = (e: any) => {
              if (e.key === 'Escape' && isTopModal(modalId)) {
                e.stopPropagation();
                currentOptions?.onEscape?.();
              }
            };
            window.addEventListener('keydown', keydownListener);
          } else if (!nextIsOpen && isOpen) {
            isOpen = false;
            if (keydownListener) {
              window.removeEventListener('keydown', keydownListener);
              keydownListener = null;
            }
            popModal(modalId);
            if (currentOptions?.restoreFocus !== false && prevActive) {
              prevActive.focus();
            }
          }
          // Ante rerender con isOpen = true, NO se desapila ni se restaura el foco
        },
      };
    }

    const avisameHook = createHookInstance('avisame-sheet');
    let avisameSheetCloseCount = 0;
    avisameHook.render(true, {
      onEscape: () => {
        avisameSheetCloseCount++;
        avisameHook.render(false, {});
      },
    });

    assert.strictEqual(isTopModal('avisame-sheet'), true);
    assert.strictEqual(hasModalsAbove('avisame-sheet'), false);

    // Dentro de AvisameSheet, el usuario hace foco en el botón para abrir la guía
    const guideTriggerBtn = createElement('guideTriggerBtn');
    guideTriggerBtn.focus();
    assert.strictEqual(document.activeElement, guideTriggerBtn);

    // Se abre el modal secundario PushVisibilityGuideModal
    let guideModalCloseCount = 0;
    const guideHook = createHookInstance('push-visibility-guide');
    guideHook.render(true, {
      onEscape: () => {
        guideModalCloseCount++;
        guideHook.render(false, {});
      },
    });

    assert.strictEqual(isTopModal('push-visibility-guide'), true);
    assert.strictEqual(hasModalsAbove('avisame-sheet'), true);
    assert.strictEqual(isTopModal('avisame-sheet'), false);

    // Provocar RERENDERS en el componente padre (AvisameSheet) con callbacks nuevos
    for (let i = 0; i < 5; i++) {
      avisameHook.render(true, {
        onEscape: () => {
          avisameSheetCloseCount++;
          avisameHook.render(false, {});
        },
      });
    }

    // La pila NO debe haberse alterado: push-visibility-guide sigue siendo el top
    assert.strictEqual(isTopModal('push-visibility-guide'), true, 'El modal secundario debe permanecer en el top tras rerenders');
    assert.strictEqual(isTopModal('avisame-sheet'), false);

    // El foco NO debe haber sido restaurado prematuramente
    assert.notStrictEqual(document.activeElement, homeBellBtn, 'No debe restaurar foco prematuramente a homeBellBtn');

    // Presionar tecla Escape
    window.dispatchEvent({ type: 'keydown', key: 'Escape', stopPropagation: () => {} });

    // Confirmar que SOLO se cerró el diálogo superior (push-visibility-guide)
    assert.strictEqual(guideModalCloseCount, 1, 'PushVisibilityGuideModal debió cerrarse');
    assert.strictEqual(avisameSheetCloseCount, 0, 'AvisameSheet NO debió cerrarse');
    assert.strictEqual(isTopModal('avisame-sheet'), true, 'AvisameSheet ahora es el top');

    // Confirmar que el foco volvió a guideTriggerBtn (el botón dentro de AvisameSheet que abrió la guía)
    assert.strictEqual(document.activeElement, guideTriggerBtn, 'Foco debe restaurarse a guideTriggerBtn');

    // Presionar tecla Escape nuevamente
    window.dispatchEvent({ type: 'keydown', key: 'Escape', stopPropagation: () => {} });

    // Confirmar que ahora sí se cerró AvisameSheet
    assert.strictEqual(avisameSheetCloseCount, 1, 'AvisameSheet debió cerrarse con el segundo Escape');
    assert.strictEqual(isTopModal('avisame-sheet'), false);

    // Confirmar que el foco volvió al homeBellBtn (el botón que abrió AvisameSheet)
    assert.strictEqual(document.activeElement, homeBellBtn, 'Foco debe restaurarse a homeBellBtn');
  });

  // ── 5. VERIFICACIÓN VOLUNTARIA DE NOTIFICACIÓN LOCAL EN WEBPUSHSERVICE ──────────

  test('6. webPushService.testLocalNotification realiza prueba local segura sin backend server-side', async () => {
    let showNotificationCalled = false;
    let notificationPayload: any = null;

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
              showNotificationCalled = true;
              notificationPayload = { title, options };
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

    const result = await mockService.testLocalNotification();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(showNotificationCalled, true);
    assert.strictEqual(notificationPayload?.title, 'PuntoEncuentro');
    assert.ok(notificationPayload?.options?.body.includes('Notificación de prueba'));
  });

  test('7. webPushService.testLocalNotification rechaza si el permiso no está otorgado', async () => {
    const mockService = createWebPushService({
      getEnv: () => ({
        isSecureContext: true,
        hasPushManager: true,
        isStandalone: false,
        isIosLike: false,
        notification: {
          permission: 'denied',
          requestPermission: async () => 'denied',
        },
        serviceWorker: {
          ready: Promise.resolve({} as any),
          getRegistration: async () => undefined,
          register: async () => ({} as any),
        },
      }),
      getVapidPublicKey: () => 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-Skv6_yViEuiBIa-Ib9-Skv6_yViEuiBIa-Ib9-Skv6_yViEuiBIa8=',
      rpc: async () => ({ data: { ok: true }, error: null }),
      warn: () => {},
    });

    const result = await mockService.testLocalNotification();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'permission_not_granted');
  });

  // ── 6. CUMPLIMIENTO DE COMPONENTES UI Y ACCESIBILIDAD ─────────────────────────

  test('8. PushPromptModal implementa adaptación según contexto y estado del dispositivo', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/AvisamePushPromptModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    // Contextos soportados
    assert.ok(content.includes("context = 'avisame'"), 'Debe tener contexto por defecto avisame');
    assert.ok(content.includes("context === 'host'"), 'Debe adaptar copy para anfitrión');
    assert.ok(content.includes("context === 'participant'"), 'Debe adaptar copy para participante');

    // Estados de dispositivo soportados
    assert.ok(content.includes("resolvedState?.kind === 'denied'"), 'Debe detectar estado denied');
    assert.ok(content.includes("resolvedState?.kind === 'granted_unsubscribed'"), 'Debe detectar reactivación');
    assert.ok(content.includes("resolvedState?.kind === 'unsupported'"), 'Debe detectar unsupported');

    // Gestión de modales y anti-insistencia
    assert.ok(content.includes("useModalStack('push-prompt-modal'"), 'Debe registrarse en useModalStack');
    assert.ok(content.includes('recordPushPromptShown(context, userId)'), 'Debe registrar invitación mostrada');
    assert.ok(content.includes('dismissPushPrompt(14, userId)'), 'Debe usar cooldown en Ahora no');
  });

  test('9. PushVisibilityGuideModal implementa instrucciones reales para iOS, Android, Windows y macOS', () => {
    const modalPath = path.join(rootDir, 'src/components/home/alerts/PushVisibilityGuideModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');

    // Casos de plataforma
    assert.ok(content.includes("currentPlatform === 'ios'"), 'Debe contener guía para iOS');
    assert.ok(content.includes("currentPlatform === 'android'"), 'Debe contener guía para Android');
    assert.ok(content.includes("currentPlatform === 'windows'"), 'Debe contener guía para Windows');
    assert.ok(content.includes("currentPlatform === 'macos'"), 'Debe contener guía para macOS');

    // Pasos de iOS: Pantalla de inicio, PWA, permisos y Modos de concentración
    assert.ok(content.includes('ios_modal_step1'), 'Paso 1: Agregar a pantalla de inicio');
    assert.ok(content.includes('ios_modal_step2'), 'Paso 2: Activar notificaciones desde PWA');
    assert.ok(content.includes('ios_modal_step5'), 'Paso 5: Modos de concentración / Resumen programado');
    assert.ok(content.includes('ios_modal_pwa_note'), 'Nota técnica de requerimiento PWA en iOS');

    // Registro de completado y acción de posponer («Ya lo configuré» vs «Lo haré después»)
    assert.ok(content.includes('recordPushGuideCompleted(currentPlatform, userId)'), 'Debe registrar completado al hacer Ya lo configuré');
    assert.ok(content.includes('recordPushGuideViewed(currentPlatform, userId)'), 'Debe registrar vista al hacer Lo haré después');
    assert.ok(content.includes('guide_action_configured'), 'Debe usar clave de traducción para Ya lo configuré');
    assert.ok(content.includes('guide_action_later'), 'Debe usar clave de traducción para Lo haré después');
    assert.ok(content.includes("useModalStack('push-visibility-guide'"), 'Debe registrarse en useModalStack');
  });

  test('10. DevicePushSettings incluye opción voluntaria «Probar visualización y sonido» con disclaimer', () => {
    const dpsPath = path.join(rootDir, 'src/components/home/alerts/DevicePushSettings.tsx');
    const content = fs.readFileSync(dpsPath, 'utf-8');

    assert.ok(
      content.includes('handleTestNotification'),
      'DevicePushSettings debe implementar handleTestNotification'
    );
    assert.ok(
      content.includes('test_button'),
      'DevicePushSettings debe invocar traducción para el botón de prueba'
    );
    assert.ok(
      content.includes('test_disclaimer'),
      'DevicePushSettings debe incluir disclaimer explícito sobre prueba local vs servidor'
    );
    assert.ok(
      content.includes('ios_guide_link'),
      'DevicePushSettings debe enlazar la guía de iOS en dispositivos Apple'
    );
  });

  test('11. Flujos principales integrados: Anfitrión (Manual/IA), Participante (Privado/Abierto) y Avisame', () => {
    // 1. Anfitrión en DetailHost y DetailHostCoordination
    const detailHostPath = path.join(rootDir, 'src/screens/DetailHost.tsx');
    const detailHostContent = fs.readFileSync(detailHostPath, 'utf-8');
    assert.ok(
      detailHostContent.includes('justCreated'),
      'DetailHost debe verificar justCreated del location state'
    );
    assert.ok(
      detailHostContent.includes('hasEncounterCreatedBefore'),
      'DetailHost debe verificar si ya creó encuentro antes'
    );
    assert.ok(
      detailHostContent.includes('recordEncounterCreated'),
      'DetailHost debe registrar creación efectiva'
    );

    // 2. Participante en InviteGuest
    const inviteGuestPath = path.join(rootDir, 'src/screens/InviteGuest.tsx');
    const inviteGuestContent = fs.readFileSync(inviteGuestPath, 'utf-8');
    assert.ok(
      inviteGuestContent.includes('hasParticipationConfirmedBefore'),
      'InviteGuest debe consultar si ya confirmó antes'
    );
    assert.ok(
      inviteGuestContent.includes('recordParticipationConfirmed'),
      'InviteGuest debe registrar primera confirmación'
    );

    // 3. Encuentros abiertos en HomeOpenEncounterDetailSheet
    const openSheetPath = path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx');
    const openSheetContent = fs.readFileSync(openSheetPath, 'utf-8');
    assert.ok(
      openSheetContent.includes('hasOpenParticipationNotified'),
      'HomeOpenEncounterDetailSheet debe verificar notificación de aprobación'
    );
    assert.ok(
      openSheetContent.includes('recordOpenParticipationNotified'),
      'HomeOpenEncounterDetailSheet debe registrar aprobación notificada'
    );
  });

  // ── 7. INTEGRIDAD DE INTERNACIONALIZACIÓN (ES, EN, PT, PT-BR) ──────────────────

  test('12. Todas las claves de internacionalización de P1-A están sincronizadas en los 4 idiomas', () => {
    const locales = ['es', 'en', 'pt', 'pt-BR'];
    const requiredPushKeys = [
      'ios_modal_title',
      'ios_modal_subtitle',
      'ios_modal_step1',
      'ios_modal_step2',
      'ios_modal_step3',
      'ios_modal_step4',
      'ios_modal_step5',
      'ios_modal_pwa_note',
      'ios_modal_focus_note',
      'ios_modal_system_note',
      'ios_guide_link',
      'prompt_host_title',
      'prompt_host_desc',
      'prompt_host_reactivate_desc',
      'prompt_participant_title',
      'prompt_participant_desc',
      'prompt_participant_reactivate_desc',
      'prompt_denied_title',
      'prompt_denied_desc',
      'prompt_denied_cta',
      'prompt_reactivate_title',
      'prompt_reactivate_desc',
      'test_button',
      'test_disclaimer',
      'test_success',
      'test_error',
      'guide_action_configured',
      'guide_action_later',
    ];

    for (const locale of locales) {
      const filePath = path.join(rootDir, `src/i18n/locales/${locale}.json`);
      assert.ok(fs.existsSync(filePath), `Archivo de idioma ${locale}.json debe existir`);
      const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.ok(json.push, `Sección "push" debe existir en ${locale}.json`);

      for (const key of requiredPushKeys) {
        assert.ok(
          json.push[key] && typeof json.push[key] === 'string' && json.push[key].trim().length > 0,
          `Clave push.${key} debe existir y no estar vacía en ${locale}.json`
        );
      }
    }
  });
});
