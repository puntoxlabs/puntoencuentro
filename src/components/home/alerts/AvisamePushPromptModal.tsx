import React, { useEffect, useRef, useState } from 'react';
import { Bell, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { webPushService } from '@/services/webPushService';
import { dismissPushPrompt, clearPushPromptDismissal } from './antiNagging';
import './AvisamePushPromptModal.css';

export interface AvisamePushPromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  onActivated: () => void;
}

/**
 * Modal contextual post-guardado de alerta (Fase 3B UX).
 *
 * REGLA CRÍTICA:
 * El permiso de notificaciones nunca se solicita al montar este modal (cero auto-prompts).
 * Se invoca única y exclusivamente desde el click explícito en "Activar notificaciones".
 */
export const AvisamePushPromptModal: React.FC<AvisamePushPromptModalProps> = ({
  isOpen,
  onClose,
  onActivated,
}) => {
  const { t } = useTranslation();
  const activateBtnRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Foco inicial accesible sin solicitar permisos
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        activateBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Tecla Escape para descartar
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleActivate = async () => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await webPushService.activate();
      if (res.ok) {
        clearPushPromptDismissal();
        onActivated();
      } else {
        if (res.error === 'permission_denied' || res.error === 'permission_dismissed') {
          // El usuario rechazó o cerró el prompt nativo: no insistir
          dismissPushPrompt();
          onClose();
        } else {
          setErrorMsg(
            t('avisame.push_prompt_error', {
              defaultValue: 'No pudimos activar las notificaciones. Podés intentarlo más tarde desde Crear aviso.',
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
    dismissPushPrompt();
    onClose();
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
          <Bell size={24} />
        </div>

        <h3 id="push-prompt-title" className="pe-push-prompt-title">
          {t('avisame.push_prompt_title', {
            defaultValue: '¿Querés que te avisemos en este dispositivo?',
          })}
        </h3>

        <p id="push-prompt-desc" className="pe-push-prompt-text">
          {t('avisame.push_prompt_desc', {
            defaultValue: 'Recibí una notificación cuando encontremos algo que coincida con tu aviso.',
          })}
        </p>

        {errorMsg && (
          <div className="pe-push-prompt-feedback pe-push-prompt-feedback--error" role="alert">
            {errorMsg}
          </div>
        )}

        <div className="pe-push-prompt-actions">
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
              {t('avisame.push_prompt_activate', {
                defaultValue: 'Activar notificaciones',
              })}
            </span>
          </button>

          <button
            type="button"
            className="pe-push-prompt__btn-secondary"
            onClick={handleDismiss}
            disabled={busy}
          >
            <span>{t('avisame.push_prompt_dismiss', { defaultValue: 'Ahora no' })}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
