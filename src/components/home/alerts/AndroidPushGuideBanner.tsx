import React from 'react';
import { Sliders, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { dismissAndroidPushGuide } from './antiNagging';
import './AndroidPushGuideBanner.css';

export interface AndroidPushGuideBannerProps {
  onOpenGuide: () => void;
  onDismiss: () => void;
}

/**
 * Banner contextual ofrecido por única vez tras una activación exitosa en Android.
 * Ligero, no intrusivo y con descarte permanente.
 */
export const AndroidPushGuideBanner: React.FC<AndroidPushGuideBannerProps> = ({
  onOpenGuide,
  onDismiss,
}) => {
  const { t } = useTranslation();

  const handleOpen = () => {
    dismissAndroidPushGuide();
    onOpenGuide();
  };

  const handleDismiss = () => {
    dismissAndroidPushGuide();
    onDismiss();
  };

  return (
    <div
      className="pe-android-guide-banner"
      role="region"
      aria-label={t('push.android_banner_title', {
        defaultValue: '¿Querés que los avisos sean más visibles?',
      })}
    >
      <div className="pe-android-guide-banner__header">
        <div className="pe-android-guide-banner__icon" aria-hidden="true">
          <Sliders size={18} />
        </div>
        <div className="pe-android-guide-banner__body">
          <h4 className="pe-android-guide-banner__title">
            {t('push.android_banner_title', {
              defaultValue: '¿Querés que los avisos sean más visibles?',
            })}
          </h4>
          <p className="pe-android-guide-banner__text">
            {t('push.android_banner_text', {
              defaultValue:
                'Ya podés recibir notificaciones de PuntoEncuentro, incluso cuando no tengas la página abierta. Si querés que aparezcan como avisos emergentes o en la pantalla bloqueada, podés configurar estas opciones desde Android.',
            })}
          </p>
        </div>
        <button
          type="button"
          className="pe-android-guide-banner__close-icon"
          onClick={handleDismiss}
          aria-label={t('push.android_banner_dismiss', { defaultValue: 'Ahora no' })}
        >
          <X size={16} />
        </button>
      </div>

      <div className="pe-android-guide-banner__actions">
        <button
          type="button"
          className="pe-android-guide-banner__btn-primary"
          onClick={handleOpen}
        >
          <span>
            {t('push.android_banner_cta', { defaultValue: 'Ver cómo configurarlas' })}
          </span>
        </button>
        <button
          type="button"
          className="pe-android-guide-banner__btn-secondary"
          onClick={handleDismiss}
        >
          <span>
            {t('push.android_banner_dismiss', { defaultValue: 'Ahora no' })}
          </span>
        </button>
      </div>
    </div>
  );
};
