import React, { useEffect, useRef, useState } from 'react';
import {
  Smartphone,
  Monitor,
  Laptop,
  Sliders,
  X,
  CheckCircle,
  Info,
  ShieldCheck,
  Bell,
  RefreshCw,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getPushPlatform,
  recordPushGuideCompleted,
  recordPushGuideViewed,
  recordWebPushActivated,
  dismissSoundVisibilityAssistant,
  getAssistantSavedStep,
  saveAssistantStep,
  clearAssistantSavedStep,
  type PushPlatform,
} from './antiNagging';
import { webPushService } from '@/services/webPushService';
import { useModalStack } from '@/lib/modalStack';
import './PushVisibilityGuideModal.css';

export interface PushVisibilityGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  platform?: PushPlatform;
  userId?: string | null;
}

/**
 * Asistente Multiplataforma de Sonido y Visibilidad (P1-B).
 *
 * Estrategia híbrida:
 * - Paso 1: Configurar (Opción A de acceso directo cuando existe + Opción B de instrucciones alternativas).
 * - Paso 2: Probar (emisión local voluntaria mediante testLocalNotification con repetición y feedback).
 * - Paso 3: Confirmar (validación declarada por el usuario con opciones: funciona, probar otra vez o posponer).
 *
 * Robusto ante cambios de foco y salida a Ajustes del sistema (conserva el paso en curso).
 */
export const PushVisibilityGuideModal: React.FC<PushVisibilityGuideModalProps> = ({
  isOpen,
  onClose,
  platform,
  userId,
}) => {
  const { t } = useTranslation();
  const currentPlatform = platform || getPushPlatform();

  // Paso actual (1: Configurar, 2: Probar, 3: Confirmar), restaurado desde sessionStorage si existe
  const [step, setStep] = useState<1 | 2 | 3>(() => getAssistantSavedStep(userId));
  const [showAlternativeInstructions, setShowAlternativeInstructions] = useState(false);
  const [testingNotification, setTestingNotification] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'sent' | 'error'>('idle');
  const [returnedFromBackground, setReturnedFromBackground] = useState(false);

  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Retorno desde ajustes: si el usuario sale a configurar y vuelve, registrar evento sin reiniciar paso
  useEffect(() => {
    if (!isOpen) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        setReturnedFromBackground(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isOpen]);

  const handleDismiss = () => {
    recordPushGuideViewed(currentPlatform, userId);
    dismissSoundVisibilityAssistant(14, userId);
    clearAssistantSavedStep(userId);
    onClose();
  };

  // Gestión accesible en pila de modales (Escape único y restauración de foco)
  useModalStack('push-visibility-guide', isOpen, {
    onEscape: handleDismiss,
    restoreFocus: true,
  });

  // Foco accesible al cambiar de paso o al abrir (con preventScroll para evitar saltos involuntarios de viewport)
  useEffect(() => {
    if (isOpen) {
      // 1. Resetear el scroll del contenido interno y del overlay contenedor al inicio
      if (contentRef.current) {
        contentRef.current.scrollTop = 0;
      }
      if (modalRef.current?.parentElement) {
        modalRef.current.parentElement.scrollTop = 0;
      }

      // 2. Foco accesible sin desplazamiento automático del viewport
      const timer = setTimeout(() => {
        if (step === 1) {
          // En paso 1, enfocar el contenedor del diálogo para lectura inicial accesible
          if (modalRef.current) {
            modalRef.current.focus({ preventScroll: true });
          } else {
            primaryBtnRef.current?.focus({ preventScroll: true });
          }
        } else {
          // En paso 2 y 3, enfocar la acción principal correspondiente sin desplazamiento
          primaryBtnRef.current?.focus({ preventScroll: true });
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, step]);

  const handleGoToStep = (nextStep: 1 | 2 | 3) => {
    setStep(nextStep);
    saveAssistantStep(nextStep, userId);
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
    if (modalRef.current?.parentElement) {
      modalRef.current.parentElement.scrollTop = 0;
    }
  };

  const handleSendTest = async () => {
    if (testingNotification) return;
    setTestingNotification(true);
    try {
      const res = await webPushService.testLocalNotification();
      if (res.ok) {
        setTestResult('sent');
      } else {
        setTestResult('error');
      }
    } catch {
      setTestResult('error');
    } finally {
      setTestingNotification(false);
    }
  };

  const handleConfirmSuccess = () => {
    recordPushGuideCompleted(currentPlatform, userId);
    recordWebPushActivated(userId);
    clearAssistantSavedStep(userId);
    onClose();
  };

  if (!isOpen) return null;

  // Icono según plataforma
  const renderIcon = () => {
    switch (currentPlatform) {
      case 'android':
      case 'ios':
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
      case 'ios':
        return t('push.ios_modal_title', {
          defaultValue: 'Configurar avisos en iPhone y iPad',
        });
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
      case 'ios':
        return t('push.ios_modal_subtitle', {
          defaultValue:
            'Para recibir avisos en iOS, se requiere agregar PuntoEncuentro a la pantalla de inicio y configurar las notificaciones en el sistema:',
        });
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

  // Instrucciones paso a paso según plataforma (Opción B / manual)
  const renderSteps = () => {
    if (currentPlatform === 'ios') {
      return (
        <ol className="pe-visibility-guide-steps">
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">1</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.ios_modal_step1', {
                defaultValue:
                  'En Safari, tocá el botón Compartir (flecha hacia arriba) y elegí «Agregar a la pantalla de inicio».',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">2</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.ios_modal_step2', {
                defaultValue:
                  'Abrí PuntoEncuentro desde el icono de tu pantalla de inicio y tocá «Activar notificaciones».',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">3</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.ios_modal_step3', {
                defaultValue: 'En tu iPhone o iPad, abrí Ajustes → Notificaciones → PuntoEncuentro.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">4</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.ios_modal_step4', {
                defaultValue:
                  'Verificá que estén activadas las opciones de Pantalla bloqueada, Centro de notificaciones, Tiras y Sonidos.',
              })}
            </span>
          </li>
          <li className="pe-visibility-guide-step">
            <span className="pe-visibility-guide-step__num">5</span>
            <span className="pe-visibility-guide-step__text">
              {t('push.ios_modal_step5', {
                defaultValue:
                  'Comprobá que los Modos de Concentración («No molestar») o el Resumen programado no silencien los avisos.',
              })}
            </span>
          </li>
        </ol>
      );
    }

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
    if (currentPlatform === 'ios') {
      return (
        <div className="pe-visibility-guide-callout pe-visibility-guide-callout--info">
          <Info size={16} aria-hidden="true" className="pe-visibility-guide-callout__icon" />
          <p className="pe-visibility-guide-callout__text">
            {t('push.ios_modal_pwa_note', {
              defaultValue:
                'Web Push en iOS requiere iOS 16.4 o superior y funciona exclusivamente abriendo la aplicación desde la pantalla de inicio (PWA).',
            })}{' '}
            {t('push.ios_modal_focus_note', {
              defaultValue:
                'Cada Modo de Concentración (No molestar, Trabajo, Descanso) o Resumen programado en iOS puede silenciar o diferir la llegada de avisos.',
            })}
          </p>
        </div>
      );
    }

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
      case 'ios':
        return t('push.ios_modal_system_note', {
          defaultValue:
            'Estas opciones se configuran directamente en iOS y Safari, y no pueden modificarse desde la aplicación.',
        });
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
          handleDismiss();
        }
      }}
      aria-hidden="false"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
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
            onClick={handleDismiss}
            aria-label={t('common.close', { defaultValue: 'Cerrar' })}
          >
            <X size={18} />
          </button>
        </header>

        {/* Barra accesible de progreso de 3 pasos */}
        <nav className="pe-assistant-stepper" aria-label="Progreso del asistente">
          <button
            type="button"
            className={`pe-assistant-step-pill ${step === 1 ? 'pe-assistant-step-pill--active' : ''}`}
            onClick={() => handleGoToStep(1)}
          >
            {t('push.assistant_step_config', { defaultValue: '1. Configurar' })}
          </button>
          <button
            type="button"
            className={`pe-assistant-step-pill ${step === 2 ? 'pe-assistant-step-pill--active' : ''}`}
            onClick={() => handleGoToStep(2)}
          >
            {t('push.assistant_step_test', { defaultValue: '2. Probar' })}
          </button>
          <button
            type="button"
            className={`pe-assistant-step-pill ${step === 3 ? 'pe-assistant-step-pill--active' : ''}`}
            onClick={() => handleGoToStep(3)}
          >
            {t('push.assistant_step_confirm', { defaultValue: '3. Confirmar' })}
          </button>
        </nav>

        <div ref={contentRef} className="pe-visibility-guide-modal__content">
          {/* ── PASO 1: CONFIGURAR (ACCESO DIRECTO / ATAJO + ALTERNATIVA) ───────── */}
          {step === 1 && (
            <div className="pe-assistant-step-content">
              {/* Acceso directo en Windows (Opción A) */}
              {currentPlatform === 'windows' && (
                <div className="pe-assistant__direct-box">
                  <a
                    href="ms-settings:notifications"
                    className="pe-assistant__direct-btn"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Sliders size={16} aria-hidden="true" />
                    <span>
                      {t('push.assistant_direct_button_windows', {
                        defaultValue: 'Abrir Configuración de Windows',
                      })}
                    </span>
                  </a>
                  <p className="pe-assistant__hint">
                    {t('push.assistant_direct_windows_disclaimer', {
                      defaultValue:
                        'Windows o tu navegador pueden pedirte confirmación para abrir la aplicación de Configuración.',
                    })}
                  </p>
                  <button
                    type="button"
                    className="pe-assistant__alt-toggle-btn"
                    onClick={() => setShowAlternativeInstructions((prev) => !prev)}
                  >
                    {showAlternativeInstructions
                      ? t('push.assistant_hide_alt', { defaultValue: 'Ocultar instrucciones manuales' })
                      : t('push.assistant_alt_link', {
                          defaultValue: '¿No se abrió la configuración? Ver instrucciones',
                        })}
                  </button>
                </div>
              )}

              {/* Atajo comprobado en Android (Motorola / Chrome) */}
              {currentPlatform === 'android' && (
                <div className="pe-assistant__shortcut-card">
                  <div className="pe-assistant__shortcut-header">
                    <Smartphone size={18} aria-hidden="true" className="pe-assistant__shortcut-icon" />
                    <h4 className="pe-assistant__shortcut-title">
                      {t('push.assistant_android_shortcut_title', {
                        defaultValue: 'Atajo en Android: mantener presionada la notificación',
                      })}
                    </h4>
                  </div>
                  <p className="pe-assistant__shortcut-text">
                    {t('push.assistant_android_shortcut_desc', {
                      defaultValue:
                        'En Android, la forma más rápida de abrir los ajustes del canal del sitio es mantener presionada la notificación de prueba que enviaremos en el siguiente paso.',
                    })}
                  </p>
                  <ul className="pe-assistant__checklist">
                    <li>
                      🔔{' '}
                      {t('push.assistant_android_item_sound', {
                        defaultValue: 'Alerta o Sonido: activar para que emita tono o vibración.',
                      })}
                    </li>
                    <li>
                      🪟{' '}
                      {t('push.assistant_android_item_popup', {
                        defaultValue:
                          'Avisos emergentes / Banners flotantes: activar para que aparezca sobre otras apps.',
                      })}
                    </li>
                    <li>
                      🔒{' '}
                      {t('push.assistant_android_item_lock', {
                        defaultValue: 'Pantalla bloqueada: elegir «Mostrar todo el contenido».',
                      })}
                    </li>
                  </ul>
                  <button
                    type="button"
                    className="pe-assistant__alt-toggle-btn"
                    onClick={() => setShowAlternativeInstructions((prev) => !prev)}
                  >
                    {showAlternativeInstructions
                      ? t('push.assistant_hide_alt', { defaultValue: 'Ocultar instrucciones manuales' })
                      : t('push.assistant_android_alt_link', {
                          defaultValue: '¿Preferís ver las instrucciones paso a paso?',
                        })}
                  </button>
                </div>
              )}

              {/* Mostrar instrucciones paso a paso en macOS, iOS o si el usuario pide alternativa */}
              {(currentPlatform === 'macos' ||
                currentPlatform === 'ios' ||
                currentPlatform === 'other' ||
                showAlternativeInstructions) && (
                <div className="pe-assistant__manual-steps">
                  {renderSteps()}
                </div>
              )}

              {renderPlatformNotes()}
              {renderPrivacyNote()}

              <p className="pe-visibility-guide-disclaimer">{getDisclaimer()}</p>
            </div>
          )}

          {/* ── PASO 2: PROBAR (EMISIÓN VOLUNTARIA LOCAL) ──────────────────────── */}
          {step === 2 && (
            <div className="pe-assistant-step-content">
              <div className="pe-assistant__test-card">
                <h4 className="pe-assistant__test-title">
                  {t('push.assistant_test_title', { defaultValue: 'Emitir notificación de prueba' })}
                </h4>
                <p className="pe-assistant__test-desc">
                  {t('push.assistant_test_desc', {
                    defaultValue:
                      'Tocá el botón para enviar una notificación local y comprobar el sonido y la vibración en este dispositivo.',
                  })}
                </p>

                <button
                  ref={primaryBtnRef}
                  type="button"
                  className="pe-assistant__test-trigger-btn"
                  onClick={() => void handleSendTest()}
                  disabled={testingNotification}
                >
                  {testingNotification ? (
                    <RefreshCw size={15} style={{ animation: 'spin 1s linear infinite' }} />
                  ) : (
                    <Bell size={15} aria-hidden="true" />
                  )}
                  <span>
                    {testingNotification
                      ? t('push.assistant_test_sending', { defaultValue: 'Enviando notificación...' })
                      : t('push.assistant_test_btn', { defaultValue: 'Enviar notificación de prueba' })}
                  </span>
                </button>

                {testResult === 'sent' && (
                  <div className="pe-assistant__feedback pe-assistant__feedback--ok" role="status">
                    <CheckCircle size={16} aria-hidden="true" className="pe-assistant__feedback-icon" />
                    <div>
                      <p className="pe-assistant__feedback-msg">
                        {currentPlatform === 'android'
                          ? t('push.assistant_test_sent_android', {
                              defaultValue:
                                '¡Notificación enviada! Deslizá la barra superior o mirá el aviso. Mantené presionada la notificación de PuntoEncuentro para tocar el engranaje ⚙️ de ajustes del canal.',
                            })
                          : t('push.assistant_test_sent_general', {
                              defaultValue:
                                '¡Notificación emitida! Comprobá si sonó y apareció el banner en tu pantalla.',
                            })}
                      </p>
                      <button
                        type="button"
                        className="pe-assistant__retest-btn"
                        onClick={() => void handleSendTest()}
                        disabled={testingNotification}
                      >
                        {t('push.assistant_test_retry_btn', { defaultValue: 'Enviar otra prueba' })}
                      </button>
                    </div>
                  </div>
                )}

                {testResult === 'error' && (
                  <div className="pe-assistant__feedback pe-assistant__feedback--error" role="alert">
                    <Info size={16} aria-hidden="true" className="pe-assistant__feedback-icon" />
                    <p className="pe-assistant__feedback-msg">
                      {t('push.assistant_test_error', {
                        defaultValue:
                          'No se pudo emitir la notificación. Comprobá que los permisos no estén bloqueados.',
                      })}
                    </p>
                  </div>
                )}

                {returnedFromBackground && (
                  <div className="pe-assistant__return-hint">
                    <Info size={14} aria-hidden="true" />
                    <span>
                      {t('push.assistant_returned_hint', {
                        defaultValue:
                          'De regreso de Ajustes: podés enviar otra prueba para comprobar si el sonido y los banners quedaron activos.',
                      })}
                    </span>
                  </div>
                )}
              </div>

              {renderPrivacyNote()}
            </div>
          )}

          {/* ── PASO 3: CONFIRMAR (VERIFICACIÓN DEL USUARIO) ───────────────────── */}
          {step === 3 && (
            <div className="pe-assistant-step-content">
              <div className="pe-assistant__confirm-card">
                <h4 className="pe-assistant__confirm-title">
                  {t('push.assistant_confirm_title', { defaultValue: 'Verificar sonido y visualización' })}
                </h4>
                <p className="pe-assistant__confirm-question">
                  {t('push.assistant_confirm_question', {
                    defaultValue: '¿Escuchaste el sonido y viste correctamente la notificación?',
                  })}
                </p>
                <p className="pe-assistant__confirm-disclaimer">
                  {t('push.assistant_confirm_disclaimer', {
                    defaultValue:
                      'PuntoEncuentro no puede inspeccionar automáticamente el volumen ni los ajustes del sistema operativo.',
                  })}
                </p>
              </div>

              {renderPrivacyNote()}
            </div>
          )}
        </div>

        {/* Footer adaptativo según el paso en curso */}
        <footer className="pe-visibility-guide-modal__footer">
          {step === 1 && (
            <>
              <button
                ref={primaryBtnRef}
                type="button"
                className="pe-visibility-guide__btn-primary"
                onClick={() => handleGoToStep(2)}
              >
                <span>{t('push.assistant_next_to_test', { defaultValue: 'Continuar a la prueba' })}</span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="pe-visibility-guide__btn-secondary"
                onClick={handleDismiss}
              >
                <span>{t('push.guide_action_later', { defaultValue: 'Lo haré después' })}</span>
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <button
                type="button"
                className="pe-visibility-guide__btn-primary"
                onClick={() => handleGoToStep(3)}
              >
                <span>{t('push.assistant_next_to_verify', { defaultValue: 'Continuar a la verificación' })}</span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="pe-visibility-guide__btn-secondary"
                onClick={() => handleGoToStep(1)}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                <span>{t('push.assistant_back_to_config', { defaultValue: 'Volver a instrucciones' })}</span>
              </button>
            </>
          )}

          {step === 3 && (
            <div className="pe-assistant__confirm-actions">
              <button
                ref={primaryBtnRef}
                type="button"
                className="pe-visibility-guide__btn-primary"
                onClick={handleConfirmSuccess}
              >
                <CheckCircle size={15} aria-hidden="true" />
                <span>
                  {t('push.assistant_confirm_yes', {
                    defaultValue: t('push.guide_action_configured', {
                      defaultValue: 'Sí, funciona correctamente',
                    }),
                  })}
                </span>
              </button>
              <button
                type="button"
                className="pe-visibility-guide__btn-secondary"
                onClick={() => handleGoToStep(2)}
              >
                <RefreshCw size={14} aria-hidden="true" />
                <span>{t('push.assistant_confirm_retry', { defaultValue: 'Probar otra vez' })}</span>
              </button>
              <button
                type="button"
                className="pe-visibility-guide__btn-neutral"
                onClick={handleDismiss}
              >
                <span>{t('push.assistant_confirm_later', { defaultValue: 'Lo revisaré después' })}</span>
              </button>
            </div>
          )}
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

export const NotificationAssistantModal = PushVisibilityGuideModal;
export type NotificationAssistantModalProps = PushVisibilityGuideModalProps;
