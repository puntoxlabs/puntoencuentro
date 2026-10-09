import React, { useState, useEffect, useRef } from 'react';
import { X, ShieldAlert, CheckCircle2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  initialReason?: PublicContentReportReason | null;
  initialComment?: string;
  onReportSuccess?: () => void;
}

export const ReportPublicEncounterModal: React.FC<ReportPublicEncounterModalProps> = ({
  isOpen,
  onClose,
  encuentroId,
  encounterTitle = '',
  initialReason = null,
  initialComment = '',
  onReportSuccess,
}) => {
  const { t } = useTranslation();
  const { isPermanentUser, signInWithGoogleForDiscovery } = useAuth();
  const [reason, setReason] = useState<PublicContentReportReason | null>(initialReason);
  const [comment, setComment] = useState(initialComment);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isLoginRequired, setIsLoginRequired] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const motivosReporte: Array<{ value: PublicContentReportReason; label: string; description: string }> = [
    {
      value: 'spam',
      label: t('open_encounters.report_reason_spam', { defaultValue: 'Spam' }),
      description: t('open_encounters.report_reason_spam_desc', {
        defaultValue: 'Promociones no solicitadas, cadenas repetidas o venta comercial.',
      }),
    },
    {
      value: 'inappropriate_content',
      label: t('open_encounters.report_reason_inappropriate', { defaultValue: 'Contenido inapropiado' }),
      description: t('open_encounters.report_reason_inappropriate_desc', {
        defaultValue: 'Contenido explícito o no apto para una cartelera pública.',
      }),
    },
    {
      value: 'fraud_scam',
      label: t('open_encounters.report_reason_fraud', { defaultValue: 'Engaño o estafa' }),
      description: t('open_encounters.report_reason_fraud_desc', {
        defaultValue: 'Ofertas fraudulentas, pedidos de dinero o información sospechosa.',
      }),
    },
    {
      value: 'harassment',
      label: t('open_encounters.report_reason_harassment', { defaultValue: 'Acoso' }),
      description: t('open_encounters.report_reason_harassment_desc', {
        defaultValue: 'Hostigamiento, insultos o intimidaciones.',
      }),
    },
    {
      value: 'other',
      label: t('open_encounters.report_reason_other', { defaultValue: 'Otro' }),
      description: t('open_encounters.report_reason_other_desc', {
        defaultValue: 'Cualquier otra situación que deba ser revisada por el equipo.',
      }),
    },
  ];

  const handleClose = () => {
    try {
      sessionStorage.removeItem('pending_open_report');
    } catch {
      /* storage disabled fallback */
    }
    onClose();
  };

  const getFocusableElements = (): HTMLElement[] => {
    if (!cardRef.current) return [];
    const selector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');
    return Array.from(cardRef.current.querySelectorAll<HTMLElement>(selector)).filter(
      (el) => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0 || el === closeBtnRef.current
    );
  };

  useEffect(() => {
    if (isOpen) {
      setReason(initialReason || null);
      setComment(initialComment || '');
      setSubmitting(false);
      setErrorMessage(null);
      setIsSuccess(false);
      setIsLoginRequired(false);

      // Foco accesible al montar
      const timer = setTimeout(() => {
        closeBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, encuentroId, initialReason, initialComment]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isLoginRequired) return;

      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        handleClose();
        return;
      }

      if (e.key === 'Tab') {
        const focusables = getFocusableElements();
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusables[0];
        const lastElement = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement || !cardRef.current?.contains(document.activeElement)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement || !cardRef.current?.contains(document.activeElement)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, submitting, isLoginRequired]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason || submitting) return;

    if (!isPermanentUser) {
      try {
        sessionStorage.setItem(
          'pending_open_report',
          JSON.stringify({
            encounterId: encuentroId,
            reason,
            comment,
          })
        );
      } catch {
        /* storage disabled fallback */
      }
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
        try {
          sessionStorage.removeItem('pending_open_report');
        } catch {
          /* storage disabled fallback */
        }
        setIsSuccess(true);
        if (onReportSuccess) {
          onReportSuccess();
        }
      } else {
        if (res.error === 'already_reported') {
          setErrorMessage(
            t('open_encounters.report_already_reported', {
              defaultValue: 'Ya reportaste este encuentro.',
            })
          );
        } else if (res.error === 'rate_limit_exceeded') {
          setErrorMessage(
            t('open_encounters.report_rate_limited', {
              defaultValue: 'Hiciste varios reportes en poco tiempo. Esperá un momento e intentá nuevamente.',
            })
          );
        } else if (res.error === 'cannot_report_own_encounter') {
          setErrorMessage(
            t('open_encounters.report_cannot_report_own', {
              defaultValue: 'No podés reportar tu propia publicación.',
            })
          );
        } else if (res.error === 'permanent_account_required') {
          setIsLoginRequired(true);
        } else {
          setErrorMessage(
            t('open_encounters.report_error_generic', {
              defaultValue: 'No se pudo enviar el reporte en este momento. Intentá nuevamente.',
            })
          );
        }
      }
    } catch (err: any) {
      setErrorMessage(
        t('open_encounters.report_error_generic', {
          defaultValue: 'No se pudo enviar el reporte en este momento. Intentá nuevamente.',
        })
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleLoginWithGoogle = async () => {
    setLoginLoading(true);
    try {
      const res = await signInWithGoogleForDiscovery();
      if (!res.ok) {
        setLoginLoading(false);
        try {
          sessionStorage.removeItem('pending_open_report');
        } catch {
          /* storage fallback */
        }
      }
    } catch {
      setLoginLoading(false);
      try {
        sessionStorage.removeItem('pending_open_report');
      } catch {
        /* storage fallback */
      }
    }
  };

  return (
    <>
      <div className="pe-report-public-backdrop" onClick={() => !submitting && handleClose()}>
        <div
          ref={cardRef}
          className="pe-report-public-card"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="pe-report-public-title"
          tabIndex={-1}
        >
          <button
            ref={closeBtnRef}
            type="button"
            className="pe-report-public-close"
            onClick={handleClose}
            disabled={submitting}
            aria-label={t('open_encounters.coverage_close', { defaultValue: 'Cerrar' })}
          >
            <X size={18} />
          </button>

          {isSuccess ? (
            <div className="pe-report-public-success">
              <CheckCircle2 size={44} className="pe-report-public-success__icon" aria-hidden="true" />
              <h3 className="pe-report-public-success__title">
                {t('open_encounters.report_success_title', { defaultValue: 'Gracias. Recibimos tu reporte.' })}
              </h3>
              <p className="pe-report-public-success__desc">
                {t('open_encounters.report_success_desc', {
                  defaultValue: 'Vamos a revisar este encuentro para cuidar la cartelera pública.',
                })}
              </p>
              <button
                type="button"
                className="pe-report-public-btn pe-report-public-btn--neutral"
                onClick={handleClose}
              >
                {t('open_encounters.coverage_close', { defaultValue: 'Cerrar' })}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="pe-report-public-form">
              <div className="pe-report-public-header">
                <div className="pe-report-public-header__icon-box" aria-hidden="true">
                  <ShieldAlert size={20} />
                </div>
                <div>
                  <h3 id="pe-report-public-title" className="pe-report-public-title">
                    {t('open_encounters.report_modal_title', { defaultValue: 'Reportar encuentro' })}
                  </h3>
                  {encounterTitle && (
                    <p className="pe-report-public-subtitle">
                      &ldquo;{encounterTitle}&rdquo;
                    </p>
                  )}
                </div>
              </div>

              <p className="pe-report-public-intro">
                {t('open_encounters.report_modal_intro', { defaultValue: 'Contanos qué problema encontraste.' })}
              </p>

              {errorMessage && (
                <div className="pe-report-public-alert pe-report-public-alert--error" role="alert">
                  <AlertCircle size={16} aria-hidden="true" />
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="pe-report-public-reasons" role="radiogroup" aria-labelledby="pe-report-public-title">
                {motivosReporte.map((item) => {
                  const inputId = `report-reason-${item.value}`;
                  const isSelected = reason === item.value;
                  return (
                    <label
                      key={item.value}
                      htmlFor={inputId}
                      className={`pe-report-public-reason-item ${isSelected ? 'pe-report-public-reason-item--selected' : ''}`}
                    >
                      <input
                        id={inputId}
                        type="radio"
                        name="report_reason"
                        value={item.value}
                        checked={isSelected}
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
                  );
                })}
              </div>

              <div className="pe-report-public-field">
                <label className="pe-report-public-field-label" htmlFor="report-comment-input">
                  {t('open_encounters.report_comment_label', { defaultValue: 'Comentario (opcional)' })}
                </label>
                <textarea
                  id="report-comment-input"
                  className="pe-report-public-textarea"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={t('open_encounters.report_comment_placeholder', {
                    defaultValue: 'Aportá cualquier detalle que ayude a revisar el contenido…',
                  })}
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
                  onClick={handleClose}
                  disabled={submitting}
                >
                  {t('open_encounters.report_cancel', { defaultValue: 'Cancelar' })}
                </button>
                <button
                  type="submit"
                  className="pe-report-public-btn pe-report-public-btn--primary"
                  disabled={!reason || submitting}
                >
                  {submitting
                    ? t('open_encounters.report_sending', { defaultValue: 'Enviando…' })
                    : t('open_encounters.report_submit', { defaultValue: 'Enviar reporte' })}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      <LoginRequiredSheet
        isOpen={isLoginRequired}
        onClose={() => {
          setIsLoginRequired(false);
          try {
            sessionStorage.removeItem('pending_open_report');
          } catch {
            /* storage fallback */
          }
        }}
        onContinueWithGoogle={handleLoginWithGoogle}
        loading={loginLoading}
        action="report_encounter"
      />
    </>
  );
};
