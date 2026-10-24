import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle, Shield, X } from 'lucide-react';
import type { AnonymousUpgradeState } from '@/contexts/AuthContext';
import { useModalStack } from '@/lib/modalStack';
import './AccountCollisionModal.css';

export interface AccountCollisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  upgradeState?: AnonymousUpgradeState | null;
  title?: string;
  description?: string;
  confirmLabel?: string;
}

export const AccountCollisionModal: React.FC<AccountCollisionModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  upgradeState,
  title = 'Ya tenés contenido creado en PuntoEncuentro',
  description = 'Podemos vincularlo a tu cuenta de Google para que no pierdas nada.',
  confirmLabel = 'Continuar y conservar mis encuentros',
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Gestión en pila modal accesible (Escape y restauración de foco)
  useModalStack('account-collision-modal', isOpen, {
    onEscape: () => {
      if (!isSubmitting) onClose();
    },
    restoreFocus: true,
  });

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setIsSubmitting(false);
    }
  };

  const items = [
    { label: 'Encuentros como anfitrión', active: upgradeState?.hasOwnedEncounters },
    { label: 'Zonas y localidades favoritas', active: upgradeState?.hasServerZones },
    { label: 'Solicitudes a encuentros abiertos', active: upgradeState?.hasOpenRequests },
    { label: 'Diseños de invitaciones personalizados', active: upgradeState?.hasCustomTemplates },
    { label: 'Sesiones de creación', active: upgradeState?.hasAiSessions || upgradeState?.hasCreationSessions },
    { label: 'Participaciones confirmadas', active: upgradeState?.hasParticipantLinks },
  ].filter((item) => item.active);

  const modalContent = (
    <>
      <div className="account-collision-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="account-collision-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collision-modal-title"
      >
        <div className="account-collision-modal__header">
          <div className="account-collision-modal__icon" aria-hidden="true">
            <Shield size={24} />
          </div>
          <button
            type="button"
            className="account-collision-modal__close"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Cerrar"
          >
            <X size={20} />
          </button>
        </div>

        <div className="account-collision-modal__body">
          <h2 id="collision-modal-title" className="account-collision-modal__title">
            {title}
          </h2>
          <p className="account-collision-modal__text">{description}</p>

          {items.length > 0 && (
            <div className="account-collision-modal__resources">
              <span className="account-collision-modal__resources-label">
                Recursos que se transferirán a tu cuenta permanente:
              </span>
              <ul className="account-collision-modal__list">
                {items.map((it, idx) => (
                  <li key={idx} className="account-collision-modal__item">
                    <CheckCircle size={16} className="account-collision-modal__check" />
                    <span>{it.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="account-collision-modal__notice">
            <AlertCircle size={16} className="account-collision-modal__alert-icon" />
            <span>
              Si cancelás la conexión con Google, tu sesión actual se mantiene exactamente como está.
            </span>
          </div>

          <div className="account-collision-modal__actions">
            <button
              type="button"
              className="account-collision-modal__btn-primary"
              onClick={handleConfirm}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Iniciando unificación...' : confirmLabel}
            </button>
            <button
              type="button"
              className="account-collision-modal__btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(modalContent, document.body);
  }

  return modalContent;
};
