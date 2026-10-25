import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Send, X, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { attendanceDisputeService } from '@/services/attendanceDisputeService';
import type { RealizationDisputeMotivo } from '@/types/attendanceDispute';
import './ReportEncounterRealizationModal.css';

export interface ReportEncounterRealizationModalProps {
  isOpen: boolean;
  encuentroId: string;
  encounterTitle: string;
  onClose: () => void;
  onSuccess: (disputeId: string) => void;
}

export const ReportEncounterRealizationModal: React.FC<ReportEncounterRealizationModalProps> = ({
  isOpen,
  encuentroId,
  encounterTitle,
  onClose,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [motivo, setMotivo] = useState<RealizationDisputeMotivo>('encounter_not_realized');
  const [detalle, setDetalle] = useState('');
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
    if (detalle.trim().length < 10) {
      setErrorMsg(t('attendance_disputes.detail_min_length', 'Por favor describe la situación con un poco más de detalle (mínimo 10 caracteres).'));
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const res = await attendanceDisputeService.iniciarControversiaRealizacion(
        encuentroId,
        motivo,
        detalle.trim()
      );

      if (res.ok && res.dispute_id) {
        onSuccess(res.dispute_id);
        onClose();
      } else {
        setErrorMsg(res.message || res.error || t('attendance_disputes.error_submitting_report'));
      }
    } catch (err: any) {
      setErrorMsg(err?.message || t('attendance_disputes.network_error'));
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div
      className="pe-realization-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="realization-modal-title"
    >
      <div className="pe-realization-modal">
        <div className="pe-realization-modal__header">
          <div className="pe-realization-modal__icon-wrap">
            <AlertTriangle size={24} aria-hidden="true" />
          </div>
          <div>
            <h3 id="realization-modal-title" className="pe-realization-modal__title">
              {t('attendance_disputes.realization_modal_title', 'Reportar controversia sobre el encuentro')}
            </h3>
            <p className="pe-realization-modal__subtitle">
              {encounterTitle}
            </p>
          </div>
          <button
            type="button"
            className="pe-realization-modal__close-btn"
            onClick={onClose}
            aria-label={t('common.close', 'Cerrar')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="pe-realization-modal__notice">
          <ShieldAlert size={18} className="pe-realization-modal__notice-icon" aria-hidden="true" />
          <p>
            {t(
              'attendance_disputes.realization_notice',
              'Este formulario permite revisar incidencias objetivas sobre la realización del encuentro o errores en el registro de asistencia. El reporte será revisado de forma confidencial e imparcial.'
            )}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="pe-realization-modal__form">
          <fieldset className="pe-realization-modal__fieldset">
            <legend className="pe-realization-modal__legend">
              {t('attendance_disputes.realization_motivo_label', 'Motivo del reporte')}
            </legend>

            <label className="pe-realization-modal__radio-label">
              <input
                type="radio"
                name="motivo"
                value="encounter_not_realized"
                checked={motivo === 'encounter_not_realized'}
                onChange={() => setMotivo('encounter_not_realized')}
              />
              <div>
                <strong>{t('attendance_disputes.motivo_not_realized', 'El encuentro no se llevó a cabo')}</strong>
                <p>{t('attendance_disputes.motivo_not_realized_desc', 'El evento fue cancelado de hecho, el lugar estaba inaccesible o no hubo actividad.')}</p>
              </div>
            </label>

            <label className="pe-realization-modal__radio-label">
              <input
                type="radio"
                name="motivo"
                value="host_no_show"
                checked={motivo === 'host_no_show'}
                onChange={() => setMotivo('host_no_show')}
              />
              <div>
                <strong>{t('attendance_disputes.motivo_host_no_show', 'El anfitrión no se presentó')}</strong>
                <p>{t('attendance_disputes.motivo_host_no_show_desc', 'Concurriste al punto de encuentro pero el anfitrión no estuvo en el lugar ni coordinó la llegada.')}</p>
              </div>
            </label>

            <label className="pe-realization-modal__radio-label">
              <input
                type="radio"
                name="motivo"
                value="closure_data_error"
                checked={motivo === 'closure_data_error'}
                onChange={() => setMotivo('closure_data_error')}
              />
              <div>
                <strong>{t('attendance_disputes.motivo_closure_error', 'Inconsistencia en los datos de cierre')}</strong>
                <p>{t('attendance_disputes.motivo_closure_error_desc', 'El registro de cierre posterior contiene inexactitudes sobre la realización o participantes.')}</p>
              </div>
            </label>
          </fieldset>

          <div className="pe-realization-modal__textarea-group">
            <label htmlFor="realization-detail-text" className="pe-realization-modal__textarea-label">
              {t('attendance_disputes.realization_detail_label', 'Descripción de lo ocurrido (requerido):')}
            </label>
            <textarea
              id="realization-detail-text"
              rows={4}
              maxLength={1000}
              className="pe-realization-modal__textarea"
              placeholder={t('attendance_disputes.realization_detail_placeholder', 'Por favor describe qué sucedió con claridad y respeto...')}
              value={detalle}
              onChange={(e) => setDetalle(e.target.value)}
              required
            />
            <span className="pe-realization-modal__char-count">
              {detalle.length} / 1000
            </span>
          </div>

          {errorMsg && (
            <div className="pe-realization-modal__error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="pe-realization-modal__actions">
            <button
              type="button"
              className="pe-realization-modal__btn-secondary"
              onClick={onClose}
              disabled={loading}
            >
              {t('common.cancel', 'Cerrar')}
            </button>
            <button
              ref={primaryBtnRef}
              type="submit"
              className="pe-realization-modal__btn-primary"
              disabled={loading || detalle.trim().length < 10}
            >
              {loading ? (
                t('common.sending', 'Enviando...')
              ) : (
                <>
                  <Send size={16} aria-hidden="true" />
                  <span>{t('attendance_disputes.submit_realization_dispute', 'Enviar para revisión')}</span>
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
