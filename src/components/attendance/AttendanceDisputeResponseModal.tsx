import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Send, X, Clock, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { attendanceDisputeService } from '@/services/attendanceDisputeService';
import type { AttendanceDisputeResponseDecision } from '@/types/attendanceDispute';
import './AttendanceDisputeResponseModal.css';

export interface AttendanceDisputeResponseModalProps {
  isOpen: boolean;
  disputeId: string;
  encounterTitle: string;
  replyDeadline?: string;
  onClose: () => void;
  onSuccess: (newStatus: string) => void;
}

export const AttendanceDisputeResponseModal: React.FC<AttendanceDisputeResponseModalProps> = ({
  isOpen,
  disputeId,
  encounterTitle,
  replyDeadline,
  onClose,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<AttendanceDisputeResponseDecision>('force_majeure');
  const [descargoTexto, setDescargoTexto] = useState('');
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
    setLoading(true);
    setErrorMsg(null);

    try {
      const res = await attendanceDisputeService.responderControversia(
        disputeId,
        decision,
        descargoTexto.trim() || undefined
      );

      if (res.ok) {
        onSuccess(res.status || 'in_human_review');
        onClose();
      } else {
        setErrorMsg(res.message || res.error || t('attendance_disputes.error_submitting'));
      }
    } catch (err: any) {
      setErrorMsg(err?.message || t('attendance_disputes.network_error'));
    } finally {
      setLoading(false);
    }
  };

  const formattedDeadline = replyDeadline
    ? new Date(replyDeadline).toLocaleDateString(undefined, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
    : null;

  return createPortal(
    <div
      className="pe-dispute-response-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dispute-response-title"
    >
      <div className="pe-dispute-response-modal">
        <div className="pe-dispute-response-modal__header">
          <div className="pe-dispute-response-modal__icon-wrap">
            <AlertCircle size={24} aria-hidden="true" />
          </div>
          <div>
            <h3 id="dispute-response-title" className="pe-dispute-response-modal__title">
              {t('attendance_disputes.response_modal_title', 'Declaración de inasistencia')}
            </h3>
            <p className="pe-dispute-response-modal__subtitle">
              {encounterTitle}
            </p>
          </div>
          <button
            type="button"
            className="pe-dispute-response-modal__close-btn"
            onClick={onClose}
            aria-label={t('common.close', 'Cerrar')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="pe-dispute-response-modal__notice">
          <Shield size={18} className="pe-dispute-response-modal__notice-icon" aria-hidden="true" />
          <p>
            {t(
              'attendance_disputes.notice_explanation',
              'El organizador registró que no asististe. Este registro se encuentra pendiente de verificación: no constituye una falta comprobada ni genera antecedentes negativos en tu cuenta.'
            )}
          </p>
        </div>

        {formattedDeadline && (
          <div className="pe-dispute-response-modal__deadline">
            <Clock size={16} aria-hidden="true" />
            <span>
              {t('attendance_disputes.deadline_hint', {
                date: formattedDeadline,
                defaultValue: `Plazo de respuesta orientativo: hasta el ${formattedDeadline}. Si no respondés, el registro permanece neutral como no verificado.`,
              })}
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="pe-dispute-response-modal__form">
          <fieldset className="pe-dispute-response-modal__fieldset">
            <legend className="pe-dispute-response-modal__legend">
              {t('attendance_disputes.select_option_label', '¿Qué ocurrió?')}
            </legend>

            <label className="pe-dispute-response-modal__radio-label">
              <input
                type="radio"
                name="decision"
                value="accept_absence"
                checked={decision === 'accept_absence'}
                onChange={() => setDecision('accept_absence')}
              />
              <div>
                <strong>{t('attendance_disputes.opt_accept_absence', 'No pude asistir y no llegué a avisar')}</strong>
                <p>{t('attendance_disputes.opt_accept_absence_desc', 'Confirmo la inasistencia. Se registra de forma transparente sin abrir controversia.')}</p>
              </div>
            </label>

            <label className="pe-dispute-response-modal__radio-label">
              <input
                type="radio"
                name="decision"
                value="notified_prior"
                checked={decision === 'notified_prior'}
                onChange={() => setDecision('notified_prior')}
              />
              <div>
                <strong>{t('attendance_disputes.opt_notified_prior', 'Avisé previamente que no podía ir')}</strong>
                <p>{t('attendance_disputes.opt_notified_prior_desc', 'Me comuniqué con el organizador o di aviso antes del inicio.')}</p>
              </div>
            </label>

            <label className="pe-dispute-response-modal__radio-label">
              <input
                type="radio"
                name="decision"
                value="force_majeure"
                checked={decision === 'force_majeure'}
                onChange={() => setDecision('force_majeure')}
              />
              <div>
                <strong>{t('attendance_disputes.opt_force_majeure', 'Ocurrió un imprevisto o fuerza mayor')}</strong>
                <p>{t('attendance_disputes.opt_force_majeure_desc', 'Una situación urgente o de salud me impidió asistir o avisar a tiempo.')}</p>
              </div>
            </label>

            <label className="pe-dispute-response-modal__radio-label">
              <input
                type="radio"
                name="decision"
                value="attended_present"
                checked={decision === 'attended_present'}
                onChange={() => setDecision('attended_present')}
              />
              <div>
                <strong>{t('attendance_disputes.opt_attended_present', 'Sí asistí al encuentro (error de registro)')}</strong>
                <p>{t('attendance_disputes.opt_attended_present_desc', 'Estuve presente en el lugar y horario coordinados.')}</p>
              </div>
            </label>

            <label className="pe-dispute-response-modal__radio-label">
              <input
                type="radio"
                name="decision"
                value="request_human_review"
                checked={decision === 'request_human_review'}
                onChange={() => setDecision('request_human_review')}
              />
              <div>
                <strong>{t('attendance_disputes.opt_request_human_review', 'Solicito revisión por un moderador')}</strong>
                <p>{t('attendance_disputes.opt_request_human_review_desc', 'Deseo que el equipo revise la situación de forma imparcial.')}</p>
              </div>
            </label>
          </fieldset>

          <div className="pe-dispute-response-modal__textarea-group">
            <label htmlFor="dispute-descargo-text" className="pe-dispute-response-modal__textarea-label">
              {t('attendance_disputes.descargo_label', 'Aclaración o mensaje adicional (opcional):')}
            </label>
            <textarea
              id="dispute-descargo-text"
              rows={3}
              maxLength={1000}
              className="pe-dispute-response-modal__textarea"
              placeholder={t('attendance_disputes.descargo_placeholder', 'Escribí aquí si deseás sumar detalles respetuosos sobre lo ocurrido...')}
              value={descargoTexto}
              onChange={(e) => setDescargoTexto(e.target.value)}
            />
            <span className="pe-dispute-response-modal__char-count">
              {descargoTexto.length} / 1000
            </span>
          </div>

          {errorMsg && (
            <div className="pe-dispute-response-modal__error" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="pe-dispute-response-modal__actions">
            <button
              type="button"
              className="pe-dispute-response-modal__btn-secondary"
              onClick={onClose}
              disabled={loading}
            >
              {t('common.cancel', 'Cerrar')}
            </button>
            <button
              ref={primaryBtnRef}
              type="submit"
              className="pe-dispute-response-modal__btn-primary"
              disabled={loading}
            >
              {loading ? (
                t('common.sending', 'Enviando...')
              ) : (
                <>
                  <Send size={16} aria-hidden="true" />
                  <span>{t('attendance_disputes.submit_response', 'Enviar respuesta')}</span>
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
