import React, { useState, useEffect } from 'react';
import { X, Ban, ShieldCheck, AlertCircle } from 'lucide-react';
import { trustService } from '@/services/trustService';
import './ContextualBlockModal.css';

export interface ContextualBlockModalProps {
  isOpen: boolean;
  onClose: () => void;
  solicitudId: string;
  isBlocked: boolean; // false: confirmar bloqueo | true: confirmar desbloqueo
  targetName?: string;
  onSuccess: (newBlockedState: boolean) => void;
}

export const ContextualBlockModal: React.FC<ContextualBlockModalProps> = ({
  isOpen,
  onClose,
  solicitudId,
  isBlocked,
  targetName,
  onSuccess,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset al abrir
  useEffect(() => {
    if (isOpen) {
      setSubmitting(false);
      setErrorMessage(null);
    }
  }, [isOpen, solicitudId, isBlocked]);

  // Manejo de tecla Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, submitting, onClose]);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    setErrorMessage(null);

    try {
      if (!isBlocked) {
        // Ejecutar Bloqueo
        const result = await trustService.bloquearDesdeSolicitud(solicitudId);
        if (result.ok) {
          onSuccess(true);
          onClose();
        } else {
          setErrorMessage(mapErrorCode(result.error));
        }
      } else {
        // Ejecutar Desbloqueo
        const result = await trustService.desbloquearDesdeSolicitud(solicitudId);
        if (result.ok) {
          onSuccess(false);
          onClose();
        } else {
          setErrorMessage(mapErrorCode(result.error));
        }
      }
    } catch {
      setErrorMessage('No pudimos actualizar el bloqueo. Intentá nuevamente.');
    } finally {
      setSubmitting(false);
    }
  };

  const mapErrorCode = (error?: string): string => {
    if (error === 'authentication_required' || error === 'permanent_account_required') {
      return 'Necesitás iniciar sesión con una cuenta permanente.';
    }
    if (error === 'unauthorized' || error === 'request_not_available') {
      return 'No pudimos realizar esta acción.';
    }
    return 'No pudimos actualizar el bloqueo. Intentá nuevamente.';
  };

  const modalTitleId = 'contextual-block-modal-title';
  const modalDescId = 'contextual-block-modal-desc';

  return (
    <div
      className="pe-block-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={modalTitleId}
      aria-describedby={modalDescId}
    >
      <div className="pe-block-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="pe-block-modal__header">
          <div className="pe-block-modal__title-row">
            <div className={`pe-block-modal__icon-wrap ${isBlocked ? 'pe-block-modal__icon-wrap--unblock' : 'pe-block-modal__icon-wrap--block'}`}>
              {isBlocked ? <ShieldCheck size={20} /> : <Ban size={20} />}
            </div>
            <h2 id={modalTitleId} className="pe-block-modal__title">
              {isBlocked
                ? (targetName ? `¿Desbloquear a ${targetName}?` : '¿Desbloquear a esta persona?')
                : (targetName ? `¿Bloquear a ${targetName}?` : '¿Bloquear a esta persona?')}
            </h2>
          </div>
          <button
            type="button"
            className="pe-block-modal__close-btn"
            onClick={onClose}
            disabled={submitting}
            aria-label="Cerrar modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div id={modalDescId} className="pe-block-modal__body">
          {!isBlocked ? (
            <>
              <p className="pe-block-modal__paragraph">
                Dejarán de verse mutuamente en Encuentros Abiertos e Intenciones cuando usen sus cuentas, y no podrán iniciar nuevas solicitudes o intereses entre ustedes.
              </p>
              <p className="pe-block-modal__paragraph pe-block-modal__paragraph--secondary">
                Los encuentros, solicitudes e historial anteriores no se eliminan.
              </p>
              <div className="pe-block-modal__clarification-box">
                <span className="pe-block-modal__clarification-title">Bloquear no envía un reporte.</span>
                <span className="pe-block-modal__clarification-text">
                  Si ocurrió algo inapropiado o de seguridad, podés reportarlo por separado.
                </span>
              </div>
            </>
          ) : (
            <>
              <p className="pe-block-modal__paragraph">
                Volverás a permitir futuras interacciones según la disponibilidad y las reglas actuales de PuntoEncuentro.
              </p>
              <p className="pe-block-modal__paragraph pe-block-modal__paragraph--secondary">
                Las solicitudes e intereses anteriores no se restauran.
              </p>
            </>
          )}

          {errorMessage && (
            <div className="pe-block-modal__error-box" role="alert">
              <AlertCircle size={16} />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pe-block-modal__footer">
          <button
            type="button"
            className="pe-block-modal__btn-cancel"
            onClick={onClose}
            disabled={submitting}
          >
            Cancelar
          </button>
          <button
            type="button"
            className={`pe-block-modal__btn-confirm ${isBlocked ? 'pe-block-modal__btn-confirm--unblock' : 'pe-block-modal__btn-confirm--block'}`}
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? 'Procesando…' : isBlocked ? 'Desbloquear' : 'Bloquear'}
          </button>
        </div>
      </div>
    </div>
  );
};
