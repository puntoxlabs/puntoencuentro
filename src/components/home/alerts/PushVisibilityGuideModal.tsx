import React, { useEffect, useRef } from 'react';
import { Smartphone, Monitor, Laptop, Sliders, X, CheckCircle, Info, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getPushPlatform, type PushPlatform } from './antiNagging';
import './PushVisibilityGuideModal.css';

export interface PushVisibilityGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  platform?: PushPlatform;
}

/**
 * Modal unificado y accesible para configuración de visibilidad Web Push en:
 * - Android (avisos flotantes y pantalla bloqueada)
 * - Windows (banners de notificación, sonidos y No molestar)
 * - macOS (tiras/alertas, centro de notificaciones y Modos de concentración)
 * - Genérico (bajo demanda para otras plataformas compatibles)
 */
export const PushVisibilityGuideModal: React.FC<PushVisibilityGuideModalProps> = ({
  isOpen,
  onClose,
  platform,
}) => {
  const { t } = useTranslation();
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const currentPlatform = platform || getPushPlatform();

  // Foco accesible al abrir
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        primaryBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Tecla Escape para cerrar
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

  // Icono según plataforma
  const renderIcon = () => {
    switch (currentPlatform) {
      case 'android':
        return <Smartphone size={20} />;
      case 'windows':
        return <Monitor size={20} />;
      case 'macos':
        return <Laptop size={20} />;
      default:
        return <Sliders size={20} />;
    }
  };

  // Título según plataforma
  const getTitle = () => {
    switch (currentPlatform) {
      case 'windows':
        return t('push.windows_modal_title', {
          defaultValue: 'Configurar visibilidad de notificaciones en Windows',
        });
      case 'macos':
        return t('push.macos_modal_title', {
          defaultValue: 'Configurar visibilidad de notificaciones en macOS',
        });
      case 'android':
        return t('push.android_modal_title', {
          defaultValue: 'Configurar avisos en Android',
        });
      default:
        return t('push.generic_modal_title', {
          defaultValue: 'Configurar visibilidad de notificaciones',
        });
    }
  };

  // Subtítulo según plataforma
  const getSubtitle = () => {
    switch (currentPlatform) {
      case 'windows':
        return t('push.windows_modal_subtitle', {
          defaultValue:
            'PuntoEncuentro ya puede enviarte avisos. Para asegurarte de que aparezcan como banners y no se silencien, podés verificar estas opciones en Windows:',
        });
      case 'macos':
        return t('push.macos_modal_subtitle', {
          defaultValue:
            'PuntoEncuentro ya puede enviarte avisos. Para configurarlos como tiras o avisos flotantes en tu Mac, verificá estas opciones en macOS:',
        });
      case 'android':
        return t('push.android_modal_subtitle', {
          defaultValue:
            'PuntoEncuentro ya puede enviarte avisos. Para que aparezcan en pantalla bloqueada o como avisos flotantes, podés ajustar estas opciones en tu dispositivo:',
        });
      default:
        return t('push.generic_modal_subtitle', {
          defaultValue:
            'PuntoEncuentro ya puede enviarte avisos. Para asegurarte de recibirlos correctamente en este dispositivo, verificá los siguientes puntos:',
        });
    }
  };

  // Pasos de instrucciones según plataforma
  const renderSteps = () => {
    if (currentPlatform === 'windows') {
      return (
        <ol className="pe-visibility-guide-steps">
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">1</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.windows_modal_step1', {
                defaultValue:
                  'Verificá que PuntoEncuentro tenga permitido enviar notificaciones desde tu navegador (Chrome, Edge u otro).',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">2</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.windows_modal_step2', {
                defaultValue: 'Abrí Configuración de Windows → Sistema → Notificaciones.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">3</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.windows_modal_step3', {
                defaultValue:
                  'Buscá tu navegador en la lista de aplicaciones con permiso para notificar.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">4</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.windows_modal_step4', {
                defaultValue:
                  'Activá los banners emergentes de notificación y revisá las opciones de sonido según tu preferencia.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">5</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.windows_modal_step5', {
                defaultValue:
                  'Comprobá que «No molestar» o el Asistente de concentración no estén bloqueando los avisos.',
              })}
            </span>
          </li>
        </ol>
      );
    }

    if (currentPlatform === 'macos') {
      return (
        <ol className="pe-visibility-guide-steps">
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">1</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.macos_modal_step1', {
                defaultValue:
                  'Verificá que PuntoEncuentro tenga permiso para mostrar notificaciones en tu navegador (Safari, Chrome o Edge).',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">2</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.macos_modal_step2', {
                defaultValue:
                  'Abrí Configuración del Sistema (o Preferencias del Sistema) → Notificaciones.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">3</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.macos_modal_step3', {
                defaultValue:
                  'Localizá tu navegador o aplicación web en la lista lateral de notificaciones.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">4</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.macos_modal_step4', {
                defaultValue:
                  'Elegí el estilo de aviso (tiras o alertas), sonidos y opciones de visualización que prefieras.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">5</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.macos_modal_step5', {
                defaultValue:
                  'Comprobá que los Modos de Concentración (como «No molestar») no estén silenciando las notificaciones.',
              })}
            </span>
          </li>
        </ol>
      );
    }

    if (currentPlatform === 'android') {
      return (
        <ol className="pe-visibility-guide-steps">
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">1</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.android_modal_step1', {
                defaultValue: 'Abrí los ajustes de notificaciones de Android.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">2</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.android_modal_step2', {
                defaultValue:
                  'Buscá Chrome (o tu navegador) y las notificaciones del sitio PuntoEncuentro.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">3</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.android_modal_step3', {
                defaultValue:
                  'Si está disponible, activá la opción de mostrar avisos emergentes o banners flotantes.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">4</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.android_modal_step4', {
                defaultValue: 'Elegí cómo mostrar las notificaciones en la pantalla bloqueada.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">5</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.android_modal_step5', {
                defaultValue:
                  'Comprobá que la categoría no esté en silencio y que «No molestar» no restrinja los avisos.',
              })}
            </span>
          </li>
        </ol>
      );
    }

    // Genérico para otras plataformas
    return (
      <ol className="pe-visibility-guide-steps">
        <li className="pe-visibility-guide-step">
          <span className="pe-visibility-guide-step__num">1</span>
          <span className="pe-visibility-guide-step__text">
            {t('push.generic_modal_step1', {
              defaultValue:
                'Comprobá que el navegador tenga permitido enviar notificaciones para el sitio PuntoEncuentro.',
            })}
          </span>
        </li>
        <li className="pe-visibility-guide-step">
          <span className="pe-visibility-guide-step__num">2</span>
          <span className="pe-visibility-guide-step__text">
            {t('push.generic_modal_step2', {
              defaultValue:
                'Abrí los ajustes de notificaciones del sistema operativo de tu equipo.',
            })}
          </span>
        </li>
        <li className="pe-visibility-guide-step">
          <span className="pe-visibility-guide-step__num">3</span>
          <span className="pe-visibility-guide-step__text">
            {t('push.generic_modal_step3', {
              defaultValue:
                'Revisá que el navegador tenga habilitado el envío de alertas y sonidos.',
            })}
          </span>
        </li>
        <li className="pe-visibility-guide-step">
          <span className="pe-visibility-guide-step__num">4</span>
          <span className="pe-visibility-guide-step__text">
            {t('push.generic_modal_step4', {
              defaultValue:
                'Comprobá que no haya modos de silencio o concentración activos que restrinjan los avisos.',
            })}
          </span>
        </li>
      </ol>
    );
  };

  // Notas informativas adicionales
  const renderPlatformNotes = () => {
    if (currentPlatform === 'windows') {
      return (
        <div className="pe-visibility-guide-callout pe-visibility-guide-callout--info">
          <Info size={16} aria-hidden="true" className="pe-visibility-guide-callout__icon" />
          <p className="pe-visibility-guide-callout__text">
            {t('push.windows_modal_controls_note', {
              defaultValue:
                'Los permisos del sitio web en el navegador y las preferencias de presentación de Windows son controles distintos e independientes.',
            })}{' '}
            {t('push.windows_modal_background_note', {
              defaultValue:
                'La recepción de notificaciones cuando el navegador está cerrado depende de la configuración de aplicaciones en segundo plano de tu sistema y navegador.',
            })}
          </p>
        </div>
      );
    }

    if (currentPlatform === 'macos') {
      return (
        <div className="pe-visibility-guide-callout pe-visibility-guide-callout--info">
          <Info size={16} aria-hidden="true" className="pe-visibility-guide-callout__icon" />
          <p className="pe-visibility-guide-callout__text">
            {t('push.macos_modal_browsers_note', {
              defaultValue:
                'Cada navegador (Safari, Chrome, Edge) administra sus permisos de forma propia en macOS. La recepción con el navegador cerrado puede variar según la versión del sistema y el navegador.',
            })}
          </p>
        </div>
      );
    }

    if (currentPlatform === 'android') {
      return (
        <div className="pe-visibility-guide-callout pe-visibility-guide-callout--info">
          <Info size={16} aria-hidden="true" className="pe-visibility-guide-callout__icon" />
          <p className="pe-visibility-guide-callout__text">
            {t('push.android_modal_manufacturers_note', {
              defaultValue:
                'Los nombres de los menús pueden variar según el fabricante y la versión de Android (Samsung, Xiaomi, Motorola, etc.).',
            })}
          </p>
        </div>
      );
    }

    return null;
  };

  // Nota de privacidad
  const renderPrivacyNote = () => {
    return (
      <div className="pe-visibility-guide-callout pe-visibility-guide-callout--privacy">
        <ShieldCheck size={16} aria-hidden="true" className="pe-visibility-guide-callout__icon" />
        <p className="pe-visibility-guide-callout__text">
          {t('push.android_modal_privacy_note', {
            defaultValue:
              'Por privacidad, PuntoEncuentro muestra avisos genéricos («PuntoEncuentro — Tenés una nueva notificación») sin revelar detalles de los encuentros.',
          })}{' '}
          {t('push.shared_device_privacy_note', {
            defaultValue:
              'En dispositivos compartidos, te recomendamos configurar la visibilidad según tus preferencias de privacidad.',
          })}
        </p>
      </div>
    );
  };

  // Limitación técnica del sistema operativo
  const getDisclaimer = () => {
    switch (currentPlatform) {
      case 'windows':
        return t('push.windows_modal_system_note', {
          defaultValue:
            'Estas opciones se configuran directamente en Windows y en tu navegador, y no pueden ser modificadas automáticamente por la aplicación.',
        });
      case 'macos':
        return t('push.macos_modal_system_note', {
          defaultValue:
            'Estas opciones se configuran directamente en macOS y en tu navegador, y no pueden ser modificadas automáticamente por la aplicación.',
        });
      case 'android':
        return t('push.android_modal_system_note', {
          defaultValue:
            'Estas opciones se configuran directamente en Android y no pueden modificarse desde la aplicación.',
        });
      default:
        return t('push.generic_modal_system_note', {
          defaultValue:
            'Estas opciones se configuran en tu navegador y sistema operativo, y no pueden modificarse desde la aplicación.',
        });
    }
  };

  return (
    <div
      className="pe-visibility-guide-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      aria-hidden="false"
    >
      <div
        className="pe-visibility-guide-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-guide-title"
        aria-describedby="push-guide-subtitle"
      >
        <header className="pe-visibility-guide-modal__header">
          <div className="pe-visibility-guide-modal__title-group">
            <div className="pe-visibility-guide-modal__icon" aria-hidden="true">
              {renderIcon()}
            </div>
            <div>
              <h3 id="push-guide-title" className="pe-visibility-guide-modal__title">
                {getTitle()}
              </h3>
              <p id="push-guide-subtitle" className="pe-visibility-guide-modal__subtitle">
                {getSubtitle()}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="pe-visibility-guide-modal__close-btn"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Cerrar' })}
          >
            <X size={18} />
          </button>
        </header>

        <div className="pe-visibility-guide-modal__content">
          {renderSteps()}
          {renderPlatformNotes()}
          {renderPrivacyNote()}

          <p className="pe-visibility-guide-disclaimer">{getDisclaimer()}</p>
        </div>

        <footer className="pe-visibility-guide-modal__footer">
          <button
            ref={primaryBtnRef}
            type="button"
            className="pe-visibility-guide__btn-primary"
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

/**
 * Alias de compatibilidad hacia atrás para importadores existentes.
 */
export const AndroidPushGuideModal = PushVisibilityGuideModal;
export type AndroidPushGuideModalProps = PushVisibilityGuideModalProps;
