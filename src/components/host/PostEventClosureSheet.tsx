import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle2, AlertCircle, Clock, Check, HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { postEventClosureService } from '@/services/postEventClosureService';
import type {
  DetalleCierrePostEvento,
  PostEventRealizationStatus,
  AttendanceStatus,
  ParticipantAttendanceItem,
} from '@/types/postEventClosure';
import './PostEventClosureSheet.css';

export interface PostEventClosureSheetProps {
  isOpen: boolean;
  encuentroId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

const COMMON_REASONS = [
  'bad_weather',
  'personal_emergency',
  'mutual_agreement',
  'lack_of_quorum',
  'other',
] as const;

export const PostEventClosureSheet: React.FC<PostEventClosureSheetProps> = ({
  isOpen,
  encuentroId,
  onClose,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<DetalleCierrePostEvento | null>(null);

  // Form states
  const [realizationStatus, setRealizationStatus] = useState<PostEventRealizationStatus>('realized');
  const [selectedReasonKey, setSelectedReasonKey] = useState<string>('mutual_agreement');
  const [customReason, setCustomReason] = useState<string>('');
  const [attendanceMap, setAttendanceMap] = useState<Record<string, AttendanceStatus>>({});
  const [isSuccess, setIsSuccess] = useState<boolean>(false);

  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !encuentroId) return;

    previousActiveElementRef.current = document.activeElement as HTMLElement | null;
    let isMounted = true;
    setLoading(true);
    setError(null);
    setIsSuccess(false);

    postEventClosureService
      .getDetalleCierre(encuentroId)
      .then((res) => {
        if (!isMounted) return;
        if (res.ok) {
          setDetalle(res);
          // Inicializar asistencias si vienen participantes
          const initialMap: Record<string, AttendanceStatus> = {};
          if (Array.isArray(res.participantes)) {
            res.participantes.forEach((p) => {
              // Si ya tenía attendance_status distinto a unmarked, usarlo; sino unverified por defecto
              initialMap[p.id] = p.attendance_status && p.attendance_status !== 'unmarked' ? p.attendance_status : 'unverified';
            });
          }
          setAttendanceMap(initialMap);

          if (res.post_event_realization_status) {
            setRealizationStatus(res.post_event_realization_status);
          }
          if (res.post_event_unrealized_reason) {
            setCustomReason(res.post_event_unrealized_reason);
          }
        } else {
          setError(res.error || 'error_loading_details');
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        setError(err?.message || 'error_loading_details');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      isMounted = false;
      window.removeEventListener('keydown', handleKeyDown);
      previousActiveElementRef.current?.focus();
    };
  }, [isOpen, encuentroId, onClose]);

  if (!isOpen) return null;

  const handleAttendanceChange = (participanteId: string, status: AttendanceStatus) => {
    setAttendanceMap((prev) => ({
      ...prev,
      [participanteId]: status,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encuentroId) return;

    setSubmitting(true);
    setError(null);

    let finalReason: string | null = null;
    if (realizationStatus === 'not_realized') {
      const reasonLabel = t(`post_event_closure.reasons.${selectedReasonKey}`, {
        defaultValue: selectedReasonKey,
      });
      finalReason = customReason.trim() ? `${reasonLabel}: ${customReason.trim()}` : reasonLabel;
    }

    const asistencias: ParticipantAttendanceItem[] =
      realizationStatus === 'realized' && detalle?.participantes
        ? detalle.participantes.map((p) => ({
            participante_id: p.id,
            status: attendanceMap[p.id] || 'unverified',
          }))
        : [];

    try {
      const res = await postEventClosureService.cerrarEncuentro({
        encuentroId,
        realizationStatus,
        unrealizedReason: finalReason,
        asistencias,
      });

      if (res.ok) {
        setIsSuccess(true);
        if (onSuccess) {
          onSuccess();
        }
      } else {
        setError(res.message || res.error || 'error_closing_encounter');
      }
    } catch (err: any) {
      setError(err?.message || 'network_error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="pe-closure-sheet-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="closure-sheet-title"
    >
      <div className="pe-closure-sheet" ref={sheetRef}>
        <div className="pe-closure-sheet__header">
          <div>
            <h3 id="closure-sheet-title" className="pe-closure-sheet__title">
              {t('post_event_closure.sheet_title', { defaultValue: 'Cierre del encuentro' })}
            </h3>
            {detalle?.titulo && (
              <p className="pe-closure-sheet__subtitle">
                {detalle.open_public_title || detalle.titulo}
              </p>
            )}
          </div>
          <button
            type="button"
            className="pe-closure-sheet__close-btn"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Cerrar' })}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="pe-closure-sheet__content">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem 1rem', color: '#64748b' }}>
              <Clock size={28} className="pe-closure-sheet__spinner" style={{ animation: 'spin 1s linear infinite' }} />
              <p style={{ marginTop: '0.75rem', fontSize: '0.875rem' }}>
                {t('common.loading', { defaultValue: 'Cargando información…' })}
              </p>
            </div>
          ) : isSuccess ? (
            <div className="pe-closure-sheet__success-card">
              <div className="pe-closure-sheet__success-icon">
                <CheckCircle2 size={32} aria-hidden="true" />
              </div>
              <h4 className="pe-closure-sheet__success-title">
                {t('post_event_closure.success_title', { defaultValue: '¡Cierre registrado con éxito!' })}
              </h4>
              <p className="pe-closure-sheet__success-desc">
                {t('post_event_closure.success_desc', {
                  defaultValue:
                    'Gracias por completar el registro de asistencia. Tu compromiso como organizador responsable ayuda a mantener una comunidad transparente y confiable.',
                })}
              </p>
              <button
                type="button"
                className="pe-closure-sheet__submit-btn"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={onClose}
              >
                {t('common.done', { defaultValue: 'Listo' })}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} id="closure-form">
              {error && (
                <div
                  style={{
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    color: '#991b1b',
                    padding: '0.75rem 1rem',
                    borderRadius: '8px',
                    fontSize: '0.8125rem',
                    marginBottom: '1rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                  }}
                >
                  <AlertCircle size={16} />
                  <span>{error}</span>
                </div>
              )}

              {/* Paso 1: Realización */}
              <div className="pe-closure-sheet__section">
                <div className="pe-closure-sheet__section-title">
                  {t('post_event_closure.section_realization', {
                    defaultValue: '1. ¿Se realizó el encuentro?',
                  })}
                </div>
                <div className="pe-closure-sheet__pill-group">
                  <button
                    type="button"
                    className={`pe-closure-sheet__pill-btn ${
                      realizationStatus === 'realized' ? 'pe-closure-sheet__pill-btn--active' : ''
                    }`}
                    onClick={() => setRealizationStatus('realized')}
                  >
                    <div className="pe-closure-sheet__radio">
                      {realizationStatus === 'realized' && <div className="pe-closure-sheet__radio-dot" />}
                    </div>
                    <span>{t('post_event_closure.realized_option', { defaultValue: 'Sí, se realizó' })}</span>
                  </button>

                  <button
                    type="button"
                    className={`pe-closure-sheet__pill-btn ${
                      realizationStatus === 'not_realized' ? 'pe-closure-sheet__pill-btn--active' : ''
                    }`}
                    onClick={() => setRealizationStatus('not_realized')}
                  >
                    <div className="pe-closure-sheet__radio">
                      {realizationStatus === 'not_realized' && <div className="pe-closure-sheet__radio-dot" />}
                    </div>
                    <span>{t('post_event_closure.not_realized_option', { defaultValue: 'No se realizó' })}</span>
                  </button>

                  <button
                    type="button"
                    className={`pe-closure-sheet__pill-btn ${
                      realizationStatus === 'unconfirmed' ? 'pe-closure-sheet__pill-btn--active' : ''
                    }`}
                    onClick={() => setRealizationStatus('unconfirmed')}
                  >
                    <div className="pe-closure-sheet__radio">
                      {realizationStatus === 'unconfirmed' && <div className="pe-closure-sheet__radio-dot" />}
                    </div>
                    <span>
                      {t('post_event_closure.unconfirmed_option', {
                        defaultValue: 'No puedo confirmarlo todavía',
                      })}
                    </span>
                  </button>
                </div>

                {realizationStatus === 'not_realized' && (
                  <div className="pe-closure-sheet__reasons-group">
                    <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '0.5rem' }}>
                      {t('post_event_closure.reason_label', { defaultValue: 'Motivo principal' })}
                    </label>
                    <div className="pe-closure-sheet__reason-chips">
                      {COMMON_REASONS.map((rk) => (
                        <button
                          key={rk}
                          type="button"
                          className={`pe-closure-sheet__chip ${
                            selectedReasonKey === rk ? 'pe-closure-sheet__chip--active' : ''
                          }`}
                          onClick={() => setSelectedReasonKey(rk)}
                        >
                          {t(`post_event_closure.reasons.${rk}`, { defaultValue: rk })}
                        </button>
                      ))}
                    </div>
                    <textarea
                      className="pe-closure-sheet__textarea"
                      placeholder={t('post_event_closure.custom_reason_placeholder', {
                        defaultValue: 'Comentario opcional explicativo para el registro...',
                      })}
                      value={customReason}
                      onChange={(e) => setCustomReason(e.target.value)}
                      maxLength={400}
                    />
                  </div>
                )}
              </div>

              {/* Paso 2: Asistencia efectiva (solo si se realizó y hay participantes) */}
              {realizationStatus === 'realized' && (
                <div className="pe-closure-sheet__section">
                  <div className="pe-closure-sheet__section-title">
                    {t('post_event_closure.section_attendance', {
                      defaultValue: '2. Registro de asistencia efectiva',
                    })}
                  </div>

                  {!detalle?.participantes || detalle.participantes.length === 0 ? (
                    <div className="pe-closure-sheet__info-note">
                      {t('post_event_closure.no_participants_note', {
                        defaultValue:
                          'Este encuentro no contó con participantes registrados. Podés confirmar el cierre para completar el registro de la actividad.',
                      })}
                    </div>
                  ) : (
                    <>
                      <div className="pe-closure-sheet__participants-list">
                        {detalle.participantes.map((part) => {
                          const currentAtt = attendanceMap[part.id] || 'unverified';
                          return (
                            <div key={part.id} className="pe-closure-sheet__participant-card">
                              <div className="pe-closure-sheet__participant-header">
                                <span className="pe-closure-sheet__participant-name">
                                  {part.nombre_invitado || t('post_event_closure.anonymous_guest', { defaultValue: 'Invitado' })}
                                </span>
                                {part.is_multi_seat && (
                                  <span className="pe-closure-sheet__seat-badge">
                                    {t('post_event_closure.multi_seats', {
                                      count: part.seat_count,
                                      defaultValue: `${part.seat_count} lugares`,
                                    })}
                                  </span>
                                )}
                              </div>
                              <div className="pe-closure-sheet__attendance-selector">
                                <button
                                  type="button"
                                  className={`pe-closure-sheet__att-btn pe-closure-sheet__att-btn--attended ${
                                    currentAtt === 'attended' ? 'pe-closure-sheet__att-btn--active' : ''
                                  }`}
                                  onClick={() => handleAttendanceChange(part.id, 'attended')}
                                >
                                  <Check size={12} />
                                  <span>{t('post_event_closure.att_attended', { defaultValue: 'Asistió' })}</span>
                                </button>
                                <button
                                  type="button"
                                  className={`pe-closure-sheet__att-btn pe-closure-sheet__att-btn--advance ${
                                    currentAtt === 'advance_notice_absent' ? 'pe-closure-sheet__att-btn--active' : ''
                                  }`}
                                  onClick={() => handleAttendanceChange(part.id, 'advance_notice_absent')}
                                >
                                  <span>{t('post_event_closure.att_advance', { defaultValue: 'Avisó' })}</span>
                                </button>
                                <button
                                  type="button"
                                  className={`pe-closure-sheet__att-btn pe-closure-sheet__att-btn--absent ${
                                    currentAtt === 'reported_absent' ? 'pe-closure-sheet__att-btn--active' : ''
                                  }`}
                                  onClick={() => handleAttendanceChange(part.id, 'reported_absent')}
                                >
                                  <span>{t('post_event_closure.att_absent', { defaultValue: 'No asistió' })}</span>
                                </button>
                                <button
                                  type="button"
                                  className={`pe-closure-sheet__att-btn pe-closure-sheet__att-btn--unverified ${
                                    currentAtt === 'unverified' ? 'pe-closure-sheet__att-btn--active' : ''
                                  }`}
                                  onClick={() => handleAttendanceChange(part.id, 'unverified')}
                                >
                                  <HelpCircle size={12} />
                                  <span>{t('post_event_closure.att_unverified', { defaultValue: 'Sin verificar' })}</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="pe-closure-sheet__info-note">
                        {t('post_event_closure.attendance_disclaimer', {
                          defaultValue:
                            'Las inasistencias reportadas se conservan inicialmente como datos pendientes de verificación y no afectan negativamente el historial hasta su eventual confirmación.',
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </form>
          )}
        </div>

        {!isSuccess && !loading && (
          <div className="pe-closure-sheet__footer">
            <button
              type="button"
              className="pe-closure-blocked-modal__btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              {t('common.cancel', { defaultValue: 'Cancelar' })}
            </button>
            <button
              type="submit"
              form="closure-form"
              className="pe-closure-sheet__submit-btn"
              disabled={submitting}
            >
              {submitting ? (
                <span>{t('common.saving', { defaultValue: 'Guardando…' })}</span>
              ) : (
                <span>{t('post_event_closure.confirm_closure_action', { defaultValue: 'Confirmar cierre' })}</span>
              )}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
