import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellOff, RefreshCw, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { webPushService } from '@/services/webPushService';
import type { WebPushActivateError, WebPushDeviceState } from '@/types/webPush';

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

/**
 * Activación de Web Push para ESTE dispositivo (Fase 3A).
 * Regla: el permiso del navegador solo se solicita al tocar "Activar".
 * Montar este componente solo LEE el estado; jamás pide permiso.
 */
export const DevicePushSettings: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<WebPushDeviceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const next = await webPushService.getDeviceState();
    if (mounted.current) setState(next);
  }, []);

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

  // Mientras carga o si la función no está configurada: no mostrar nada (estado controlado).
  if (!state || state.kind === 'not_configured') return null;

  return (
    <section className="pe-push-device" aria-label="Notificaciones en este dispositivo">
      {state.kind === 'unsupported' && (
        <div className="pe-push-device__row">
          <Smartphone size={16} aria-hidden="true" />
          <p className="pe-push-device__text">
            {state.iosInstallHint
              ? t('push.ios_install_hint', {
                  defaultValue:
                    'En iPhone y iPad, agregá PuntoEncuentro a tu pantalla de inicio y abrila desde ahí para activar las notificaciones.',
                })
              : t('push.unsupported', {
                  defaultValue: 'Este navegador no permite notificaciones push.',
                })}
          </p>
        </div>
      )}

      {state.kind === 'denied' && (
        <div className="pe-push-device__row">
          <BellOff size={16} aria-hidden="true" />
          <p className="pe-push-device__text">
            {t('push.denied', {
              defaultValue:
                'Bloqueaste las notificaciones en este dispositivo. Para activarlas, cambiá el permiso desde la configuración del navegador.',
            })}
          </p>
        </div>
      )}

      {(state.kind === 'default' || state.kind === 'granted_unsubscribed') && (
        <>
          <div className="pe-push-device__row">
            <Bell size={16} aria-hidden="true" />
            <div>
              <p className="pe-push-device__title">
                {t('push.title', { defaultValue: 'Recibir notificaciones en este dispositivo' })}
              </p>
              <p className="pe-push-device__text">
                {t('push.subtitle', {
                  defaultValue: 'Te avisamos aunque no tengas PuntoEncuentro abierto.',
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
            <span>{t('push.activate', { defaultValue: 'Activar' })}</span>
          </button>
        </>
      )}

      {state.kind === 'subscribed' && (
        <div className="pe-push-device__row pe-push-device__row--spread">
          <div className="pe-push-device__row">
            <Bell size={16} aria-hidden="true" />
            <p className="pe-push-device__title">
              {t('push.active', { defaultValue: 'Notificaciones en este dispositivo: activadas' })}
            </p>
          </div>
          <button
            type="button"
            className="pe-push-device__btn"
            onClick={() => void handleDeactivate()}
            disabled={busy}
          >
            <span>{t('push.deactivate', { defaultValue: 'Desactivar' })}</span>
          </button>
        </div>
      )}

      {errorMsg && (
        <p className="pe-push-device__error" role="alert">
          {errorMsg}
        </p>
      )}
    </section>
  );
};
