import React, { useState, useEffect } from 'react';
import { X, ShieldAlert, CheckCircle2, AlertCircle } from 'lucide-react';
import { trustService } from '@/services/trustService';
import type { ContextoReporte, MotivoReportePre, MotivoReportePost } from '@/types/trust';
import './ReportRequestModal.css';

export interface ReportRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  solicitudId: string;
  applicantName?: string;
  contexto?: ContextoReporte;
  targetLabel?: string;
  targetName?: string;
  onReportSuccess?: () => void;
}

const MOTIVOS_PRE: Array<{ value: MotivoReportePre; label: string; description: string }> = [
  {
    value: 'commercial_spam',
    label: 'Promoción o spam comercial',
    description: 'Ventas no solicitadas, publicidad o enlaces comerciales.',
  },
  {
    value: 'inappropriate_behavior',
    label: 'Contenido o comportamiento inapropiado',
    description: 'Lenguaje ofensivo, acoso o contenido fuera de lugar.',
  },
  {
    value: 'safety_concern',
    label: 'Situación de seguridad',
    description: 'Indicios de fraude, suplantación o riesgo para el encuentro.',
  },
];

const MOTIVOS_POST: Array<{ value: MotivoReportePost; label: string; description: string }> = [
  {
    value: 'inappropriate_behavior',
    label: 'Comportamiento inapropiado',
    description: 'Faltas de respeto, agresiones, acoso o conducta inapropiada durante el encuentro.',
  },
  {
    value: 'commercial_spam',
    label: 'Promoción o actividad comercial no acordada',
    description: 'Ventas no acordadas, ofertas comerciales o actividades fuera de la propuesta.',
  },
  {
    value: 'safety_concern',
    label: 'Situación de seguridad',
    description: 'Situaciones de riesgo físico, amenazas o incidentes graves.',
  },
  {
    value: 'other',
    label: 'Otro motivo',
    description: 'Cualquier otra situación que requiera revisión del equipo.',
  },
];

export const ReportRequestModal: React.FC<ReportRequestModalProps> = ({
  isOpen,
  onClose,
  solicitudId,
  applicantName = '',
  contexto = 'pre_solicitud',
  targetLabel,
  targetName,
  onReportSuccess,
}) => {
  const [motivo, setMotivo] = useState<MotivoReportePre | MotivoReportePost | null>(null);
  const [detalle, setDetalle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  const isPost = contexto === 'post_encuentro';
  const motivosList = isPost ? MOTIVOS_POST : MOTIVOS_PRE;
  const effectiveTargetName = targetName || applicantName;
  const effectiveTargetLabel = targetLabel || (isPost ? 'Participante' : 'Solicitante');
  const isDetailRequired = motivo === 'other';
  const isDetailValid = !isDetailRequired || detalle.trim().length > 0;
  const canSubmit = !submitting && Boolean(motivo) && isDetailValid;

  // Reset al abrir o cambiar de solicitud o contexto
  useEffect(() => {
    if (isOpen) {
      setMotivo(null);
      setDetalle('');
      setSubmitting(false);
      setErrorMessage(null);
      setIsSuccess(false);
    }
  }, [isOpen, solicitudId, contexto]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!motivo || submitting) return;

    if (motivo === 'other' && !detalle.trim()) {
      setErrorMessage('Por favor describí qué ocurrió para que podamos evaluar el reporte.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await trustService.crearReporteSeguro({
        solicitudId,
        contexto,
        motivo,
        detalle: detalle.trim() ? detalle.trim() : null,
      });

      if (res.ok) {
        setIsSuccess(true);
        if (onReportSuccess) {
          onReportSuccess();
        }
      } else {
        switch (res.error) {
          case 'report_already_exists':
            setErrorMessage(
              isPost
                ? 'Ya enviaste un reporte sobre este encuentro.'
                : 'Ya enviaste un reporte sobre esta solicitud.'
            );
            break;
          case 'report_window_closed':
            setErrorMessage(
              isPost
                ? 'El período para reportar este encuentro ha finalizado.'
                : 'Esta solicitud ya no puede reportarse desde esta instancia.'
            );
            break;
          case 'report_relationship_invalid':
            setErrorMessage(
              isPost
                ? 'No fue posible asociar el encuentro para el reporte.'
                : 'No fue posible asociar la solicitud para el reporte.'
            );
            break;
          case 'permanent_account_required':
          case 'authentication_required':
            setErrorMessage('Iniciá sesión con tu cuenta para enviar un reporte.');
            break;
          default:
            setErrorMessage('No pudimos enviar el reporte. Intentá nuevamente.');
            break;
        }
      }
    } catch {
      setErrorMessage('No pudimos enviar el reporte. Intentá nuevamente.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="pe-report-modal__overlay"
      onClick={() => {
        if (!submitting) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pe-report-modal-title"
    >
      <div
        className="pe-report-modal__card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pe-report-modal__header">
          <div className="pe-report-modal__title-row">
            <ShieldAlert size={20} className="pe-report-modal__icon" />
            <h3 id="pe-report-modal-title" className="pe-report-modal__title">
              {isPost ? 'Reportar este encuentro' : 'Reportar solicitud'}
            </h3>
          </div>
          <button
            type="button"
            className="pe-report-modal__close-btn"
            onClick={onClose}
            disabled={submitting}
            aria-label="Cerrar modal"
          >
            <X size={18} />
          </button>
        </div>

        {isSuccess ? (
          <div className="pe-report-modal__success-body">
            <CheckCircle2 size={36} className="pe-report-modal__success-icon" />
            <p className="pe-report-modal__success-text">
              Reporte enviado. Gracias por avisarnos.
            </p>
            <p className="pe-report-modal__success-subtext">
              Tu reporte quedó registrado para nuestra revisión interna.
            </p>
            <button
              type="button"
              className="pe-report-modal__btn-primary"
              onClick={onClose}
            >
              Entendido
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="pe-report-modal__form">
            <p className="pe-report-modal__copy">
              {isPost
                ? 'Usá esta opción para informarnos sobre cualquier incidente o comportamiento indebido ocurrido durante o después del encuentro.'
                : 'Usá esta opción para informarnos sobre contenido inapropiado, promoción comercial o una situación de seguridad.'}
            </p>

            {effectiveTargetName ? (
              <div className="pe-report-modal__target">
                <span className="pe-report-modal__target-label">{`${effectiveTargetLabel}:`}</span>
                <span className="pe-report-modal__target-name">{effectiveTargetName}</span>
              </div>
            ) : targetLabel ? (
              <div className="pe-report-modal__target">
                <span className="pe-report-modal__target-label">{targetLabel}</span>
              </div>
            ) : null}

            <fieldset className="pe-report-modal__fieldset">
              <legend className="pe-report-modal__legend">Motivo del reporte:</legend>
              <div className="pe-report-modal__motivos-list">
                {motivosList.map((item) => {
                  const isSelected = motivo === item.value;
                  return (
                    <label
                      key={item.value}
                      className={`pe-report-modal__motivo-option ${isSelected ? 'pe-report-modal__motivo-option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="motivo_reporte"
                        value={item.value}
                        checked={isSelected}
                        onChange={() => setMotivo(item.value)}
                        disabled={submitting}
                        className="pe-report-modal__radio"
                      />
                      <div className="pe-report-modal__motivo-info">
                        <span className="pe-report-modal__motivo-label">{item.label}</span>
                        <span className="pe-report-modal__motivo-desc">{item.description}</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="pe-report-modal__field">
              <label htmlFor="pe-report-detalle" className="pe-report-modal__field-label">
                {isDetailRequired
                  ? 'Contanos qué ocurrió (obligatorio)'
                  : 'Contanos brevemente qué ocurrió (opcional)'}
              </label>
              <textarea
                id="pe-report-detalle"
                className="pe-report-modal__textarea"
                value={detalle}
                onChange={(e) => setDetalle(e.target.value.slice(0, 1000))}
                disabled={submitting}
                placeholder="Detalles adicionales para el equipo de revisión..."
                rows={3}
                maxLength={1000}
                required={isDetailRequired}
              />
              <div className="pe-report-modal__counter">
                {`${detalle.length} / 1000`}
              </div>
            </div>

            {errorMessage && (
              <div className="pe-report-modal__error-box" role="alert">
                <AlertCircle size={16} />
                <span>{errorMessage}</span>
              </div>
            )}

            <div className="pe-report-modal__actions">
              <button
                type="button"
                className="pe-report-modal__btn-cancel"
                onClick={onClose}
                disabled={submitting}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="pe-report-modal__btn-primary"
                disabled={!canSubmit}
              >
                {submitting ? 'Enviando…' : 'Enviar reporte'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
