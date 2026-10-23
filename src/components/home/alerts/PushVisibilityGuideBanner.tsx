import React from 'react';
import { Sliders, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getPushPlatform,
  dismissPushVisibilityGuide,
  type PushPlatform,
} from './antiNagging';
import './PushVisibilityGuideBanner.css';

export interface PushVisibilityGuideBannerProps {
  onOpenGuide: () => void;
  onDismiss: () => void;
  platform?: PushPlatform;
}

/**
 * Banner contextual ofrecido por única vez tras una activación exitosa de Web Push.
 * Adaptado para Android, Windows y macOS.
 */
export const PushVisibilityGuideBanner: React.FC<PushVisibilityGuideBannerProps> = ({
  onOpenGuide,
  onDismiss,
  platform,
}) => {
  const { t } = useTranslation();
  const currentPlatform = platform || getPushPlatform();

  const handleOpen = () => {
    dismissPushVisibilityGuide(currentPlatform);
    onOpenGuide();
  };

  const handleDismiss = () => {
    dismissPushVisibilityGuide(currentPlatform);
    onDismiss();
  };

  return (
    <div
      className="pe-visibility-guide-banner"
      role="region"
      aria-label={t('push.banner_title', {
        defaultValue: '¿Querés que los avisos sean más visibles?',
      })}
    >
      <div className="pe-visibility-guide-banner__header">
        <div className="pe-visibility-guide-banner__icon" aria-hidden="true">
          <Sliders size={18} />
        </div>
        <div className="pe-visibility-guide-banner__body">
          <h4 className="pe-visibility-guide-banner__title">
            {t('push.banner_title', {
              defaultValue: '¿Querés que los avisos sean más visibles?',
            })}
          </h4>
          <p className="pe-visibility-guide-banner__text">
            {t('push.banner_text', {
              defaultValue:
                'PuntoEncuentro ya puede enviarte notificaciones. Podés configurar cómo aparecen en tu dispositivo, incluidos los avisos emergentes y otras opciones disponibles.',
            })}
          </p>
        </div>
        <button
          type="button"
          className="pe-visibility-guide-banner__close-icon"
          onClick={handleDismiss}
          aria-label={t('push.android_banner_dismiss', { defaultValue: 'Ahora no' })}
        >
          <X size={16} />
        </button>
      </div>

      <div className="pe-visibility-guide-banner__actions">
        <button
          type="button"
          className="pe-visibility-guide-banner__btn-primary"
          onClick={handleOpen}
        >
          <span>
            {t('push.android_banner_cta', { defaultValue: 'Ver cómo configurarlas' })}
          </span>
        </button>
        <button
          type="button"
          className="pe-visibility-guide-banner__btn-secondary"
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

/**
 * Alias de compatibilidad hacia atrás para importadores existentes.
 */
export const AndroidPushGuideBanner = PushVisibilityGuideBanner;
export type AndroidPushGuideBannerProps = PushVisibilityGuideBannerProps;
