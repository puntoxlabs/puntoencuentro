import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Check, RefreshCw, Smartphone, Sliders } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { webPushService } from '@/services/webPushService';
import type { WebPushActivateError, WebPushDeviceState } from '@/types/webPush';
import {
  getPushPlatform,
  isPushGuideSupportedPlatform,
  isPushVisibilityGuideDismissed,
} from './antiNagging';
import { PushVisibilityGuideBanner } from './PushVisibilityGuideBanner';
import { PushVisibilityGuideModal } from './PushVisibilityGuideModal';
import './DevicePushSettings.css';

const ERROR_COPY: Record<WebPushActivateError, string> = {
  unsupported: 'Este navegador no permite notificaciones push.',
  push_not_configured: 'Las notificaciones push todavía no están disponibles.',
  permission_denied: 'El permiso está bloqueado en este navegador.',
  permission_dismissed: 'No activamos las notificaciones. Podés intentarlo cuando quieras.',
  service_worker_failed: 'No pudimos preparar las notificaciones. Probá de nuevo.',
  subscribe_failed: 'No pudimos activar las notificaciones. Probá de nuevo.',
  invalid_subscription: 'No pudimos activar las notificaciones. Probá de nuevo.',
  register_failed: 'No pudimos guardar la activación. Probá de nuevo.',
  authentication_required: 'Iniciá sesión para activar las notificaciones.',
  permanent_account_required: 'Iniciá sesión con tu cuenta para activar las notificaciones.',
};

export interface DevicePushSettingsProps {
  onStateChange?: (state: WebPushDeviceState) => void;
  userId?: string | null;
}

/**
 * Activación de Web Push para ESTE dispositivo (Fase 3A / 3B UX).
 * Regla: el permiso del navegador solo se solicita al tocar "Activar".
 * Montar este componente solo LEE el estado; jamás pide permiso.
 */
export const DevicePushSettings: React.FC<DevicePushSettingsProps> = ({ onStateChange, userId }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<WebPushDeviceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingNotification, setTestingNotification] = useState(false);
  const [testFeedback, setTestFeedback] = useState<{ type: 'ok' | 'error'; message: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [showContextualBanner, setShowContextualBanner] = useState(false);
  const mounted = useRef(true);

  const platform = getPushPlatform();
  const isGuideSupported = isPushGuideSupportedPlatform(platform);

  const refresh = useCallback(async () => {
    const next = await webPushService.getDeviceState();
    if (mounted.current) {
      setState(next);
      onStateChange?.(next);
    }
  }, [onStateChange]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const handleActivate = async () => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await webPushService.activate();
      if (!res.ok) {
        setErrorMsg(ERROR_COPY[res.error]);
      } else {
        if (isPushGuideSupportedPlatform(platform) && !isPushVisibilityGuideDismissed(platform)) {
          setShowContextualBanner(true);
        }
      }
      await refresh();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const handleDeactivate = async () => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await webPushService.deactivate();
      if (!res.ok) {
        setErrorMsg('No pudimos desactivar las notificaciones. Probá de nuevo.');
      }
      await refresh();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const handleTestNotification = async () => {
    if (testingNotification) return;
    setTestingNotification(true);
    setTestFeedback(null);
    try {
      const res = await webPushService.testLocalNotification();
      if (res.ok) {
        setTestFeedback({
          type: 'ok',
          message: t('push.test_success', {
            defaultValue: '¡Notificación de prueba emitida! Comprobá si tu sistema mostró el aviso o emitió sonido.',
          }),
        });
      } else {
        setTestFeedback({
          type: 'error',
          message: t('push.test_error', {
            defaultValue: 'No se pudo emitir la notificación de prueba en este navegador.',
          }),
        });
      }
    } catch {
      setTestFeedback({
        type: 'error',
        message: t('push.test_error', {
          defaultValue: 'Error al emitir la notificación de prueba.',
        }),
      });
    } finally {
      if (mounted.current) setTestingNotification(false);
    }
  };

  // Mientras carga o si la función no está configurada: no mostrar nada (estado controlado).
  if (!state || state.kind === 'not_configured') return null;

  return (
    <section className="pe-push-device" aria-label="Notificaciones en este dispositivo">
      {state.kind === 'unsupported' && (
        <div className="pe-push-device__row">
          <Smartphone size={16} aria-hidden="true" />
          <div>
            <p className="pe-push-device__title">
              {t('push.unsupported_badge', { defaultValue: 'No disponibles' })}
            </p>
            <p className="pe-push-device__text">
              {state.iosInstallHint
                ? t('push.ios_install_hint', {
                    defaultValue:
                      'En iPhone y iPad, agregá PuntoEncuentro a tu pantalla de inicio y abrila desde ahí para activar las notificaciones.',
                  })
                : t('push.unsupported', {
                    defaultValue: 'Este navegador o entorno no permite notificaciones push.',
                  })}
            </p>
          </div>
        </div>
      )}

      {state.kind === 'denied' && (
        <div className="pe-push-device__row">
          <BellOff size={16} aria-hidden="true" />
          <div>
            <p className="pe-push-device__title">
              {t('push.denied_badge', { defaultValue: 'Bloqueadas' })}
            </p>
            <p className="pe-push-device__text">
              {t('push.denied', {
                defaultValue:
                  'Bloqueaste las notificaciones en este dispositivo. Para activarlas, cambiá el permiso desde la configuración del navegador o sistema.',
              })}
            </p>
          </div>
        </div>
      )}

      {state.kind === 'default' && (
        <>
          <div className="pe-push-device__row">
            <Bell size={16} aria-hidden="true" />
            <div>
              <p className="pe-push-device__title">
                {t('push.title', { defaultValue: 'Recibir notificaciones en este dispositivo' })}
              </p>
              <p className="pe-push-device__text">
                {t('push.subtitle', {
                  defaultValue: 'Disponibles para activar. Te avisamos aunque no tengas PuntoEncuentro abierto.',
                })}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="pe-push-device__btn pe-push-device__btn--primary"
            onClick={() => void handleActivate()}
            disabled={busy}
          >
            {busy ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            <span>{t('push.activate', { defaultValue: 'Activar notificaciones' })}</span>
          </button>
        </>
      )}

      {state.kind === 'granted_unsubscribed' && (
        <>
          <div className="pe-push-device__row">
            <Bell size={16} aria-hidden="true" />
            <div>
              <p className="pe-push-device__title">
                {t('push.reactivate_title', { defaultValue: 'Notificaciones desactivadas en este dispositivo' })}
              </p>
              <p className="pe-push-device__text">
                {t('push.reactivate_subtitle', {
                  defaultValue: 'El permiso del navegador está concedido. Podés volver a activarlas para recibir avisos.',
                })}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="pe-push-device__btn pe-push-device__btn--primary"
            onClick={() => void handleActivate()}
            disabled={busy}
          >
            {busy ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            <span>{t('push.reactivate', { defaultValue: 'Volver a activar' })}</span>
          </button>
        </>
      )}

      {state.kind === 'subscribed' && (
        <>
          <div className="pe-push-device__row pe-push-device__row--spread">
            <div className="pe-push-device__row">
              <Check size={16} aria-hidden="true" style={{ color: '#059669', flexShrink: 0 }} />
              <p className="pe-push-device__title" style={{ color: '#065f46' }}>
                {t('push.active', { defaultValue: 'Activadas en este dispositivo' })}
              </p>
            </div>
            <button
              type="button"
              className="pe-push-device__btn"
              onClick={() => void handleDeactivate()}
              disabled={busy}
            >
              <span>{t('push.deactivate', { defaultValue: 'Desactivar en este dispositivo' })}</span>
            </button>
          </div>

          {isGuideSupported && (
            <button
              type="button"
              className="pe-push-device__guide-link"
              onClick={() => setShowGuideModal(true)}
            >
              <Sliders size={13} aria-hidden="true" />
              <span>
                {platform === 'android'
                  ? t('push.android_guide_link', {
                      defaultValue: 'Cómo mostrar avisos emergentes y en pantalla bloqueada',
                    })
                  : platform === 'ios'
                  ? t('push.ios_guide_link', {
                      defaultValue: 'Cómo configurar avisos en iPhone y iPad',
                    })
                  : t('push.guide_link', {
                      defaultValue: 'Configurar visibilidad de notificaciones',
                    })}
              </span>
            </button>
          )}

          {/* Opción de prueba voluntaria de visualización y sonido */}
          <div className="pe-push-device__test-section">
            <button
              type="button"
              className="pe-push-device__test-btn"
              onClick={() => void handleTestNotification()}
              disabled={testingNotification || busy}
            >
              {testingNotification ? (
                <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <Bell size={13} aria-hidden="true" />
              )}
              <span>{t('push.test_button', { defaultValue: 'Probar visualización y sonido' })}</span>
            </button>

            {testFeedback && (
              <p
                className={`pe-push-device__test-feedback ${
                  testFeedback.type === 'ok'
                    ? 'pe-push-device__test-feedback--ok'
                    : 'pe-push-device__test-feedback--error'
                }`}
                role="status"
              >
                {testFeedback.message}
              </p>
            )}

            <p className="pe-push-device__test-disclaimer">
              {t('push.test_disclaimer', {
                defaultValue:
                  'Esta prueba es local para este navegador y pantalla. No verifica el recorrido de entrega desde el servidor ni garantiza recepción con el navegador o aplicación cerrados.',
              })}
            </p>
          </div>

          {isGuideSupported && showContextualBanner && !isPushVisibilityGuideDismissed(platform, userId) && (
            <PushVisibilityGuideBanner
              platform={platform}
              userId={userId}
              onOpenGuide={() => {
                setShowContextualBanner(false);
                setShowGuideModal(true);
              }}
              onDismiss={() => {
                setShowContextualBanner(false);
              }}
            />
          )}
        </>
      )}

      {errorMsg && (
        <p className="pe-push-device__error" role="alert">
          {errorMsg}
        </p>
      )}

      {isGuideSupported && (
        <PushVisibilityGuideModal
          isOpen={showGuideModal}
          onClose={() => setShowGuideModal(false)}
          platform={platform}
          userId={userId}
        />
      )}
    </section>
  );
};
