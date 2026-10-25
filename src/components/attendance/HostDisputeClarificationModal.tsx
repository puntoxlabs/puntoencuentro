import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, Send, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { attendanceDisputeService } from '@/services/attendanceDisputeService';
import './HostDisputeClarificationModal.css';

export interface HostDisputeClarificationModalProps {
  isOpen: boolean;
  disputeId: string;
  encounterTitle: string;
  tipoControversia: string;
  motivoOriginal?: string;
  onClose: () => void;
  onSuccess: () => void;
}

export const HostDisputeClarificationModal: React.FC<HostDisputeClarificationModalProps> = ({
  isOpen,
  disputeId,
  encounterTitle,
  tipoControversia,
  motivoOriginal,
  onClose,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [aclaracion, setAclaracion] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

  if (!isOpen || typeof document === 'undefined') return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aclaracion.trim()) {
      setErrorMsg(t('attendance_disputes.clarification_required', 'Por favor ingresá el texto de aclaración.'));
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const res = await attendanceDisputeService.aportarAclaracion(
        disputeId,
        aclaracion.trim()
      );

      if (res.ok) {
        onSuccess();
        onClose();
      } else {
        setErrorMsg(res.message || res.error || t('attendance_disputes.error_submitting_clarification'));
      }
    } catch (err: any) {
      setErrorMsg(err?.message || t('attendance_disputes.network_error'));
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div
      className="pe-host-clarification-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="host-clarification-title"
    >
      <div className="pe-host-clarification-modal">
        <div className="pe-host-clarification-modal__header">
          <div className="pe-host-clarification-modal__icon-wrap">
            <MessageSquare size={24} aria-hidden="true" />
          </div>
          <div>
            <h3 id="host-clarification-title" className="pe-host-clarification-modal__title">
              {t('attendance_disputes.host_clarification_title', 'Aportar aclaración como anfitrión')}
            </h3>
            <p className="pe-host-clarification-modal__subtitle">
              {encounterTitle}
            </p>
          </div>
          <button
            type="button"
            className="pe-host-clarification-modal__close-btn"
            onClick={onClose}
            aria-label={t('common.close', 'Cerrar')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="pe-host-clarification-modal__context">
          <p>
            <strong>{t('attendance_disputes.type_label', 'Tipo:')} </strong>
            {tipoControversia === 'encounter_realization'
              ? t('attendance_disputes.type_encounter_realization', 'Controversia sobre realización del encuentro')
              : t('attendance_disputes.type_participant_attendance', 'Controversia sobre registro de inasistencia')}
          </p>
          {motivoOriginal && (
            <p>
              <strong>{t('attendance_disputes.motive_label', 'Motivo reportado:')} </strong>
              {motivoOriginal}
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="pe-host-clarification-modal__form">
          <div className="pe-host-clarification-modal__textarea-group">
            <label htmlFor="host-clarification-text" className="pe-host-clarification-modal__textarea-label">
              {t('attendance_disputes.host_clarification_label', 'Tu aclaración para moderación (máx. 1000 caracteres):')}
            </label>
            <textarea
              id="host-clarification-text"
              rows={4}
              maxLength={1000}
              className="pe-host-clarification-modal__textarea"
              placeholder={t('attendance_disputes.host_clarification_placeholder', 'Ingresá información clara y verificable que ayude a moderación a entender la situación...')}
              value={aclaracion}
              onChange={(e) => setAclaracion(e.target.value)}
              required
            />
            <span className="pe-host-clarification-modal__char-count">
              {aclaracion.length} / 1000
            </span>
          </div>

          {errorMsg && (
            <div className="pe-host-clarification-modal__error" role="alert">
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="pe-host-clarification-modal__actions">
            <button
              type="button"
              className="pe-host-clarification-modal__btn-secondary"
              onClick={onClose}
              disabled={loading}
            >
              {t('common.cancel', 'Cerrar')}
            </button>
            <button
              ref={primaryBtnRef}
              type="submit"
              className="pe-host-clarification-modal__btn-primary"
              disabled={loading || !aclaracion.trim()}
            >
              {loading ? (
                t('common.sending', 'Enviando...')
              ) : (
                <>
                  <Send size={16} aria-hidden="true" />
                  <span>{t('attendance_disputes.submit_clarification', 'Enviar aclaración')}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
