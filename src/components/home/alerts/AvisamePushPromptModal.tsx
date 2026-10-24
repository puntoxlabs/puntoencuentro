import React, { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, RefreshCw, Smartphone, Sliders } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { webPushService } from '@/services/webPushService';
import type { WebPushDeviceState } from '@/types/webPush';
import {
  dismissPushPrompt,
  clearPushPromptDismissal,
  recordPushPromptShown,
  recordWebPushActivated,
} from './antiNagging';
import { useModalStack } from '@/lib/modalStack';
import './AvisamePushPromptModal.css';

export type PushPromptContext = 'avisame' | 'host' | 'participant' | 'open_participant';

export interface PushPromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  onActivated: () => void;
  onOpenGuide?: () => void;
  context?: PushPromptContext;
  userId?: string | null;
  deviceState?: WebPushDeviceState | null;
}

/**
 * Modal contextual accesible para invitación a configurar notificaciones:
 * - Creación de aviso en «Avisame»
 * - Primera confirmación de asistencia en un encuentro (privado o abierto)
 * - Primer encuentro creado como anfitrión
 *
 * REGLA CRÍTICA:
 * El permiso del navegador nunca se solicita al montar este modal (cero auto-prompts).
 * Se invoca única y exclusivamente desde el click explícito en "Activar notificaciones" o "Volver a activar".
 */
export const PushPromptModal: React.FC<PushPromptModalProps> = ({
  isOpen,
  onClose,
  onActivated,
  onOpenGuide,
  context = 'avisame',
  userId,
  deviceState: propDeviceState,
}) => {
  const { t } = useTranslation();
  const activateBtnRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resolvedState, setResolvedState] = useState<WebPushDeviceState | null>(propDeviceState || null);

  // Gestión en la pila accesible de modales (Escape exclusivo y foco restaurado)
  useModalStack('push-prompt-modal', isOpen, {
    onEscape: () => handleDismiss(),
    restoreFocus: true,
  });

  // Consultar estado actual del dispositivo si no fue provisto
  useEffect(() => {
    if (isOpen && !propDeviceState) {
      void webPushService.getDeviceState().then(setResolvedState);
    } else if (isOpen && propDeviceState) {
      setResolvedState(propDeviceState);
    }
  }, [isOpen, propDeviceState]);

  // Registrar que la invitación fue presentada respetando anti-insistencia
  useEffect(() => {
    if (isOpen) {
      recordPushPromptShown(context, userId);
      const timer = setTimeout(() => {
        activateBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, context, userId]);

  if (!isOpen) return null;

  const handleActivate = async () => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await webPushService.activate();
      if (res.ok) {
        clearPushPromptDismissal(userId);
        recordWebPushActivated(userId);
        onActivated();
      } else {
        if (res.error === 'permission_denied' || res.error === 'permission_dismissed') {
          // El usuario rechazó o cerró el prompt nativo: no insistir
          dismissPushPrompt(14, userId);
          onClose();
        } else {
          setErrorMsg(
            t('avisame.push_prompt_error', {
              defaultValue: 'No pudimos activar las notificaciones. Podés intentarlo más tarde desde Ajustes.',
            })
          );
        }
      }
    } catch {
      setErrorMsg(
        t('avisame.push_prompt_error_conn', {
          defaultValue: 'Error de conexión al activar notificaciones.',
        })
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    if (busy) return;
    dismissPushPrompt(14, userId);
    onClose();
  };

  const handleOpenGuide = () => {
    onOpenGuide?.();
    onClose();
  };

  // ── Renderizado según el estado del dispositivo ────────────────────────────

  const isDenied = resolvedState?.kind === 'denied';
  const isReactivation = resolvedState?.kind === 'granted_unsubscribed';
  const isUnsupported = resolvedState?.kind === 'unsupported';
  const isIosHint = isUnsupported && resolvedState?.iosInstallHint;

  // Icono
  const renderIcon = () => {
    if (isDenied) return <BellOff size={24} />;
    if (isIosHint) return <Smartphone size={24} />;
    if (isUnsupported) return <Sliders size={24} />;
    return <Bell size={24} />;
  };

  // Título contextual
  const renderTitle = () => {
    if (isDenied) {
      return t('push.prompt_denied_title', {
        defaultValue: 'Notificaciones bloqueadas en este navegador',
      });
    }
    if (isIosHint) {
      return t('push.ios_modal_title', {
        defaultValue: 'Configurar avisos en iPhone y iPad',
      });
    }
    if (isUnsupported) {
      return t('push.unsupported_badge', {
        defaultValue: 'Notificaciones no disponibles',
      });
    }
    if (isReactivation) {
      return t('push.prompt_reactivate_title', {
        defaultValue: 'Reactivar avisos en este dispositivo',
      });
    }

    // Default (permiso no solicitado) según contexto
    if (context === 'host') {
      return t('push.prompt_host_title', {
        defaultValue: '¿Querés recibir avisos de tus participantes?',
      });
    }
    if (context === 'participant' || context === 'open_participant') {
      return t('push.prompt_participant_title', {
        defaultValue: '¿Querés recibir avisos importantes sobre este encuentro?',
      });
    }
    return t('avisame.push_prompt_title', {
      defaultValue: '¿Querés que te avisemos en este dispositivo?',
    });
  };

  // Descripción contextual
  const renderDescription = () => {
    if (isDenied) {
      return t('push.prompt_denied_desc', {
        defaultValue:
          'Tenés las notificaciones bloqueadas en tu navegador. Podés habilitarlas desde los ajustes del navegador para no perderte novedades.',
      });
    }
    if (isIosHint) {
      return t('push.ios_install_hint', {
        defaultValue:
          'En iPhone y iPad, agregá PuntoEncuentro a tu pantalla de inicio y abrila desde ahí para activar las notificaciones.',
      });
    }
    if (isUnsupported) {
      return t('push.unsupported', {
        defaultValue: 'Este navegador o entorno no permite notificaciones push.',
      });
    }
    if (isReactivation) {
      if (context === 'host') {
        return t('push.prompt_host_reactivate_desc', {
          defaultValue:
            'El permiso del navegador ya está concedido. Volvé a activarlas para enterarte cuando confirmen tus participantes.',
        });
      }
      if (context === 'participant' || context === 'open_participant') {
        return t('push.prompt_participant_reactivate_desc', {
          defaultValue:
            'El permiso del navegador ya está concedido. Volvé a activarlas para enterarte de cambios y avisos importantes.',
        });
      }
      return t('push.reactivate_subtitle', {
        defaultValue:
          'El permiso del navegador está concedido. Podés volver a activarlas para recibir avisos.',
      });
    }

    // Default
    if (context === 'host') {
      return t('push.prompt_host_desc', {
        defaultValue:
          'Te notificaremos cuando las personas invitadas confirmen o rechacen su asistencia, o envíen mensajes sobre tu encuentro.',
      });
    }
    if (context === 'participant' || context === 'open_participant') {
      return t('push.prompt_participant_desc', {
        defaultValue:
          'Te notificaremos si cambia la fecha, horario, ubicación o si el anfitrión envía un aviso importante.',
      });
    }
    return t('avisame.push_prompt_desc', {
      defaultValue: 'Recibí una notificación cuando encontremos algo que coincida con tu aviso.',
    });
  };

  return (
    <div
      className="pe-push-prompt-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleDismiss();
        }
      }}
      aria-hidden="false"
    >
      <div
        className="pe-push-prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-prompt-title"
        aria-describedby="push-prompt-desc"
      >
        <div className="pe-push-prompt-icon" aria-hidden="true">
          {renderIcon()}
        </div>

        <h3 id="push-prompt-title" className="pe-push-prompt-title">
          {renderTitle()}
        </h3>

        <p id="push-prompt-desc" className="pe-push-prompt-text">
          {renderDescription()}
        </p>

        {errorMsg && (
          <div className="pe-push-prompt-feedback pe-push-prompt-feedback--error" role="alert">
            {errorMsg}
          </div>
        )}

        <div className="pe-push-prompt-actions">
          {isDenied || isUnsupported ? (
            // Si está bloqueado o no soportado, no pedir permisos nativos
            onOpenGuide ? (
              <button
                ref={activateBtnRef}
                type="button"
                className="pe-push-prompt__btn-primary"
                onClick={handleOpenGuide}
              >
                <Sliders size={15} aria-hidden="true" />
                <span>
                  {t('push.prompt_denied_cta', {
                    defaultValue: 'Ver cómo configurarlas',
                  })}
                </span>
              </button>
            ) : null
          ) : (
            // Permiso no solicitado o para reactivar
            <button
              ref={activateBtnRef}
              type="button"
              className="pe-push-prompt__btn-primary"
              onClick={() => void handleActivate()}
              disabled={busy}
            >
              {busy ? (
                <RefreshCw size={15} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <Bell size={15} aria-hidden="true" />
              )}
              <span>
                {isReactivation
                  ? t('push.reactivate', { defaultValue: 'Volver a activar' })
                  : t('avisame.push_prompt_activate', { defaultValue: 'Activar notificaciones' })}
              </span>
            </button>
          )}

          <button
            type="button"
            className="pe-push-prompt__btn-secondary"
            onClick={handleDismiss}
            disabled={busy}
          >
            <span>
              {isDenied || isUnsupported
                ? t('common.close', { defaultValue: 'Cerrar' })
                : t('avisame.push_prompt_dismiss', { defaultValue: 'Ahora no' })}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Alias de compatibilidad hacia atrás para importadores existentes de Avisame.
 */
export const AvisamePushPromptModal = PushPromptModal;
export type AvisamePushPromptModalProps = PushPromptModalProps;
