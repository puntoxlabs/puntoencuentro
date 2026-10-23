import React, { useEffect, useRef } from 'react';
import { Smartphone, X, CheckCircle, Info, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './AndroidPushGuideModal.css';

export interface AndroidPushGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Modal de ayuda e instrucciones bajo demanda para configuración de notificaciones en Android.
 * Accesible, semántico y totalmente traducible (ES, EN, PT, PT-BR).
 */
export const AndroidPushGuideModal: React.FC<AndroidPushGuideModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useTranslation();
  const primaryBtnRef = useRef<HTMLButtonElement>(null);

  // Foco accesible al abrir
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        primaryBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Tecla Escape para descartar
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="pe-android-guide-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      aria-hidden="false"
    >
      <div
        className="pe-android-guide-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="android-guide-title"
        aria-describedby="android-guide-subtitle"
      >
        <header className="pe-android-guide-modal__header">
          <div className="pe-android-guide-modal__title-group">
            <div className="pe-android-guide-modal__icon" aria-hidden="true">
              <Smartphone size={20} />
            </div>
            <div>
              <h3 id="android-guide-title" className="pe-android-guide-modal__title">
                {t('push.android_modal_title', {
                  defaultValue: 'Configurar avisos en Android',
                })}
              </h3>
              <p id="android-guide-subtitle" className="pe-android-guide-modal__subtitle">
                {t('push.android_modal_subtitle', {
                  defaultValue:
                    'PuntoEncuentro ya puede enviarte avisos. Para que aparezcan en pantalla bloqueada o como avisos flotantes, podés ajustar estas opciones en tu dispositivo:',
                })}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="pe-android-guide-modal__close-btn"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Cerrar' })}
          >
            <X size={18} />
          </button>
        </header>

        <div className="pe-android-guide-modal__content">
          <ol className="pe-android-guide-steps">
            <li className="pe-android-guide-step">
              <span className="pe-android-guide-step__num">1</span>
              <span className="pe-android-guide-step__text">
                {t('push.android_modal_step1', {
                  defaultValue: 'Abrí los ajustes de notificaciones de Android.',
                })}
              </span>
            </li>
            <li className="pe-android-guide-step">
              <span className="pe-android-guide-step__num">2</span>
              <span className="pe-android-guide-step__text">
                {t('push.android_modal_step2', {
                  defaultValue:
                    'Buscá Chrome (o tu navegador) y las notificaciones del sitio PuntoEncuentro.',
                })}
              </span>
            </li>
            <li className="pe-android-guide-step">
              <span className="pe-android-guide-step__num">3</span>
              <span className="pe-android-guide-step__text">
                {t('push.android_modal_step3', {
                  defaultValue:
                    'Si está disponible, activá la opción de mostrar avisos emergentes o banners flotantes.',
                })}
              </span>
            </li>
            <li className="pe-android-guide-step">
              <span className="pe-android-guide-step__num">4</span>
              <span className="pe-android-guide-step__text">
                {t('push.android_modal_step4', {
                  defaultValue: 'Elegí cómo mostrar las notificaciones en la pantalla bloqueada.',
                })}
              </span>
            </li>
            <li className="pe-android-guide-step">
              <span className="pe-android-guide-step__num">5</span>
              <span className="pe-android-guide-step__text">
                {t('push.android_modal_step5', {
                  defaultValue:
                    'Comprobá que la categoría no esté en silencio y que «No molestar» no restrinja los avisos.',
                })}
              </span>
            </li>
          </ol>

          <div className="pe-android-guide-callout pe-android-guide-callout--info">
            <Info size={16} aria-hidden="true" className="pe-android-guide-callout__icon" />
            <p className="pe-android-guide-callout__text">
              {t('push.android_modal_manufacturers_note', {
                defaultValue:
                  'Los nombres de los menús pueden variar según el fabricante y la versión de Android (Samsung, Xiaomi, Motorola, etc.).',
              })}
            </p>
          </div>

          <div className="pe-android-guide-callout pe-android-guide-callout--privacy">
            <ShieldCheck size={16} aria-hidden="true" className="pe-android-guide-callout__icon" />
            <p className="pe-android-guide-callout__text">
              {t('push.android_modal_privacy_note', {
                defaultValue:
                  'Por privacidad, PuntoEncuentro muestra avisos genéricos («PuntoEncuentro — Tenés una nueva notificación») sin revelar detalles de los encuentros. Te recomendamos configurar la visibilidad según tus preferencias de privacidad.',
              })}
            </p>
          </div>

          <p className="pe-android-guide-disclaimer">
            {t('push.android_modal_system_note', {
              defaultValue:
                'Estas opciones se configuran directamente en Android y no pueden modificarse desde la aplicación.',
            })}
          </p>
        </div>

        <footer className="pe-android-guide-modal__footer">
          <button
            ref={primaryBtnRef}
            type="button"
            className="pe-android-guide__btn-primary"
            onClick={onClose}
          >
            <CheckCircle size={15} aria-hidden="true" />
            <span>{t('push.android_modal_close', { defaultValue: 'Entendido' })}</span>
          </button>
        </footer>
      </div>
    </div>
  );
};
