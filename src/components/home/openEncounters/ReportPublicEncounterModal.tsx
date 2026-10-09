import React, { useState, useEffect } from 'react';
import { X, ShieldAlert, CheckCircle2, AlertCircle } from 'lucide-react';
import { openEncountersService } from '@/services/openEncountersService';
import type { PublicContentReportReason } from '@/types/trust';
import { useAuth } from '@/contexts/AuthContext';
import { LoginRequiredSheet } from '@/components/auth/LoginRequiredSheet';
import './ReportPublicEncounterModal.css';

export interface ReportPublicEncounterModalProps {
  isOpen: boolean;
  onClose: () => void;
  encuentroId: string;
  encounterTitle?: string;
  onReportSuccess?: () => void;
}

const MOTIVOS_REPORTE: Array<{ value: PublicContentReportReason; label: string; description: string }> = [
  {
    value: 'spam',
    label: 'Spam o publicidad no deseada',
    description: 'Promociones no solicitadas, cadenas repetidas o venta comercial.',
  },
  {
    value: 'inappropriate_content',
    label: 'Contenido inapropiado',
    description: 'Contenido sexual explícito, lenguaje agresivo o inapropiado para cartelera pública.',
  },
  {
    value: 'fraud_scam',
    label: 'Engaño o estafa',
    description: 'Ofertas fraudulentas, pedidos de dinero o información sospechosa.',
  },
  {
    value: 'harassment',
    label: 'Acoso o amenazas',
    description: 'Hostigamiento, insultos o intimidaciones a personas o grupos.',
  },
  {
    value: 'other',
    label: 'Otro motivo',
    description: 'Cualquier otra infracción que deba ser revisada por el equipo.',
  },
];

export const ReportPublicEncounterModal: React.FC<ReportPublicEncounterModalProps> = ({
  isOpen,
  onClose,
  encuentroId,
  encounterTitle = '',
  onReportSuccess,
}) => {
  const { isPermanentUser, signInWithGoogleForDiscovery } = useAuth();
  const [reason, setReason] = useState<PublicContentReportReason | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isLoginRequired, setIsLoginRequired] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setReason(null);
      setComment('');
      setSubmitting(false);
      setErrorMessage(null);
      setIsSuccess(false);
      setIsLoginRequired(false);
    }
  }, [isOpen, encuentroId]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        if (isLoginRequired) {
          setIsLoginRequired(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, submitting, isLoginRequired]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason || submitting) return;

    if (!isPermanentUser) {
      setIsLoginRequired(true);
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await openEncountersService.reportarEncuentroPublico(
        encuentroId,
        reason,
        comment.trim() || undefined
      );

      if (res.ok) {
        setIsSuccess(true);
        if (onReportSuccess) {
          onReportSuccess();
        }
      } else {
        if (res.error === 'already_reported') {
          setErrorMessage('Ya enviaste un reporte sobre esta publicación.');
        } else if (res.error === 'rate_limit_exceeded') {
          setErrorMessage('Hiciste varios reportes en poco tiempo. Esperá un momento e intentá nuevamente.');
        } else if (res.error === 'cannot_report_own_encounter') {
          setErrorMessage('No podés reportar tu propia publicación.');
        } else if (res.error === 'permanent_account_required') {
          setIsLoginRequired(true);
        } else {
          setErrorMessage(res.error || 'No se pudo enviar el reporte.');
        }
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Error de conexión al enviar reporte.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLoginWithGoogle = async () => {
    setLoginLoading(true);
    try {
      await signInWithGoogleForDiscovery();
    } catch {
      setLoginLoading(false);
    }
  };

  return (
    <>
      <div className="pe-report-public-backdrop" onClick={() => !submitting && onClose()}>
        <div
          className="pe-report-public-card"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="pe-report-public-title"
        >
          <button
            type="button"
            className="pe-report-public-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>

          {isSuccess ? (
            <div className="pe-report-public-success">
              <CheckCircle2 size={44} className="pe-report-public-success__icon" />
              <h3 className="pe-report-public-success__title">Reporte recibido</h3>
              <p className="pe-report-public-success__desc">
                Gracias por avisarnos. Nuestro equipo revisará la publicación para cuidar la cartelera pública.
              </p>
              <button
                type="button"
                className="pe-report-public-btn pe-report-public-btn--primary"
                onClick={onClose}
              >
                Cerrar
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="pe-report-public-form">
              <div className="pe-report-public-header">
                <div className="pe-report-public-header__icon-box">
                  <ShieldAlert size={20} />
                </div>
                <div>
                  <h3 id="pe-report-public-title" className="pe-report-public-title">
                    Reportar publicación
                  </h3>
                  {encounterTitle && (
                    <p className="pe-report-public-subtitle">
                      &ldquo;{encounterTitle}&rdquo;
                    </p>
                  )}
                </div>
              </div>

              {errorMessage && (
                <div className="pe-report-public-alert pe-report-public-alert--error" role="alert">
                  <AlertCircle size={16} />
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="pe-report-public-reasons">
                <label className="pe-report-public-field-label">¿Por qué motivo reportás esta publicación?</label>
                {MOTIVOS_REPORTE.map((item) => (
                  <label
                    key={item.value}
                    className={`pe-report-public-reason-item ${reason === item.value ? 'pe-report-public-reason-item--selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="report_reason"
                      value={item.value}
                      checked={reason === item.value}
                      onChange={() => {
                        setReason(item.value);
                        setErrorMessage(null);
                      }}
                      disabled={submitting}
                      className="pe-report-public-radio"
                    />
                    <div className="pe-report-public-reason-text">
                      <span className="pe-report-public-reason-title">{item.label}</span>
                      <span className="pe-report-public-reason-desc">{item.description}</span>
                    </div>
                  </label>
                ))}
              </div>

              <div className="pe-report-public-field">
                <label className="pe-report-public-field-label" htmlFor="report-comment-input">
                  Detalle adicional (opcional)
                </label>
                <textarea
                  id="report-comment-input"
                  className="pe-report-public-textarea"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Aportá cualquier información que ayude a revisar el contenido…"
                  maxLength={500}
                  rows={3}
                  disabled={submitting}
                />
                <span className="pe-report-public-counter">{comment.length}/500</span>
              </div>

              <div className="pe-report-public-actions">
                <button
                  type="button"
                  className="pe-report-public-btn pe-report-public-btn--secondary"
                  onClick={onClose}
                  disabled={submitting}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="pe-report-public-btn pe-report-public-btn--danger"
                  disabled={!reason || submitting}
                >
                  {submitting ? 'Enviando…' : 'Enviar reporte'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      <LoginRequiredSheet
        isOpen={isLoginRequired}
        onClose={() => setIsLoginRequired(false)}
        onContinueWithGoogle={handleLoginWithGoogle}
        loading={loginLoading}
        action="request_join"
      />
    </>
  );
};
