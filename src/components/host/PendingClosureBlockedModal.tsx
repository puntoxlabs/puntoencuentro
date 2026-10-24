import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './PendingClosureBlockedModal.css';

export interface PendingClosureBlockedModalProps {
  isOpen: boolean;
  pendingEncuentroId: string;
  pendingEncuentroTitle: string;
  onClose: () => void;
  onGoToClosure: (encuentroId: string) => void;
}

export const PendingClosureBlockedModal: React.FC<PendingClosureBlockedModalProps> = ({
  isOpen,
  pendingEncuentroId,
  pendingEncuentroTitle,
  onClose,
  onGoToClosure,
}) => {
  const { t } = useTranslation();
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    previousActiveElementRef.current = document.activeElement as HTMLElement | null;
    primaryBtnRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousActiveElementRef.current?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="pe-closure-blocked-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="closure-blocked-title"
    >
      <div className="pe-closure-blocked-modal">
        <div className="pe-closure-blocked-modal__header">
          <div className="pe-closure-blocked-modal__icon-wrap">
            <AlertTriangle size={24} aria-hidden="true" />
          </div>
          <h3 id="closure-blocked-title" className="pe-closure-blocked-modal__title">
            {t('post_event_closure.blocked_modal_title', {
              defaultValue: 'Cierre pendiente requerido',
            })}
          </h3>
        </div>

        <div className="pe-closure-blocked-modal__body">
          <p>
            {t('post_event_closure.blocked_modal_desc', {
              defaultValue:
                'Para mantener una comunidad confiable, es necesario completar el registro de asistencia del encuentro anterior antes de publicar uno nuevo en Discovery.',
            })}
          </p>

          <div className="pe-closure-blocked-modal__encounter-card">
            <div className="pe-closure-blocked-modal__encounter-name">
              {pendingEncuentroTitle || t('post_event_closure.unnamed_encounter', { defaultValue: 'Encuentro sin título' })}
            </div>
          </div>

          <div className="pe-closure-blocked-modal__note">
            {t('post_event_closure.blocked_modal_note', {
              defaultValue:
                'Tus borradores y la coordinación privada siguen funcionando normalmente.',
            })}
          </div>
        </div>

        <div className="pe-closure-blocked-modal__actions">
          <button
            ref={primaryBtnRef}
            type="button"
            className="pe-closure-blocked-modal__btn-primary"
            onClick={() => onGoToClosure(pendingEncuentroId)}
          >
            <span>{t('post_event_closure.btn_go_to_closure', { defaultValue: 'Ir a cerrar encuentro' })}</span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pe-closure-blocked-modal__btn-secondary"
            onClick={onClose}
          >
            {t('common.cancel', { defaultValue: 'Entendido, volver' })}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
