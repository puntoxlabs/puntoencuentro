import React, { useState, useEffect } from 'react';
import { X, MapPin, CheckCircle, Compass, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { coverageService, type CoverageResponse } from '@/services/coverageService';
import './CoverageRequestModal.css';

export interface CoverageRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialLocationText?: string;
  onSelectExistingLocality?: (localityId: string) => void;
}

export const CoverageRequestModal: React.FC<CoverageRequestModalProps> = ({
  isOpen,
  onClose,
  initialLocationText = '',
  onSelectExistingLocality,
}) => {
  const { t } = useTranslation();
  const [locationText, setLocationText] = useState(initialLocationText);
  const [intentText, setIntentText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CoverageResponse | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLocationText(initialLocationText);
      setIntentText('');
      setErrorMsg(null);
      setResult(null);
    }
  }, [isOpen, initialLocationText]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const loc = locationText.trim();
    if (!loc) {
      setErrorMsg(t('open_encounters.coverage_location_required', { defaultValue: 'Por favor ingresá una zona o ciudad.' }));
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const resp = await coverageService.submitCoverageRequest(loc, intentText.trim() || null);
      if (resp.ok) {
        setResult(resp);
      } else {
        if (resp.error === 'rate_limit_exceeded') {
          setErrorMsg(t('open_encounters.coverage_rate_limited', {
            defaultValue: 'Alcanzaste el límite de pedidos por hoy. Por favor intentá más tarde.',
          }));
        } else {
          setErrorMsg(t('open_encounters.coverage_error_generic', {
            defaultValue: 'No se pudo enviar la solicitud. Por favor intentá nuevamente.',
          }));
        }
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error de conexión');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSelectExisting = (localityId: string) => {
    if (onSelectExistingLocality) {
      onSelectExistingLocality(localityId);
    }
    onClose();
  };

  return (
    <>
      <div className="pe-coverage-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="pe-coverage-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pe-coverage-title"
      >
        <div className="pe-coverage-modal__header">
          <div className="pe-coverage-modal__title-row">
            <Compass size={20} className="pe-coverage-modal__icon" aria-hidden="true" />
            <h2 id="pe-coverage-title" className="pe-coverage-modal__title">
              {t('open_encounters.coverage_modal_title', { defaultValue: 'Pedir cobertura' })}
            </h2>
          </div>
          <button
            type="button"
            className="pe-coverage-modal__close-btn"
            onClick={onClose}
            aria-label="Cerrar modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* 1. CASO DE ÉXITO O RESOLUCIÓN */}
        {result ? (
          <div className="pe-coverage-result">
            {result.result_type === 'existing_locality' ? (
              <div className="pe-coverage-result__existing">
                <div className="pe-coverage-result__icon-wrap pe-coverage-result__icon-wrap--existing">
                  <MapPin size={24} />
                </div>
                <h3 className="pe-coverage-result__heading">
                  {t('open_encounters.coverage_existing_locality_notice', {
                    name: result.existing_locality_name || 'una zona activa',
                    defaultValue: `Esa zona ya está incluida en ${result.existing_locality_name}.`,
                  })}
                </h3>
                <p className="pe-coverage-result__text">
                  {t('open_encounters.coverage_existing_locality_desc', {
                    defaultValue: 'PuntoEncuentro ya tiene cobertura en esta macrozona.',
                  })}
                </p>
                <div className="pe-coverage-result__actions">
                  {result.existing_locality_id && onSelectExistingLocality && (
                    <button
                      type="button"
                      className="pe-coverage-btn pe-coverage-btn--primary"
                      onClick={() => handleSelectExisting(result.existing_locality_id!)}
                    >
                      {t('open_encounters.coverage_existing_locality_action', { defaultValue: 'Seleccionar esta zona' })}
                    </button>
                  )}
                  <button
                    type="button"
                    className="pe-coverage-btn pe-coverage-btn--secondary"
                    onClick={onClose}
                  >
                    {t('open_encounters.coverage_close', { defaultValue: 'Cerrar' })}
                  </button>
                </div>
              </div>
            ) : (
              <div className="pe-coverage-result__success">
                <div className="pe-coverage-result__icon-wrap pe-coverage-result__icon-wrap--success">
                  <CheckCircle size={24} />
                </div>
                <h3 className="pe-coverage-result__heading">
                  {t('open_encounters.coverage_success_title', {
                    place: result.market_label || result.raw_location || locationText.trim(),
                    defaultValue: `Listo, registramos tu interés por ${result.market_label || result.raw_location || locationText.trim()}.`,
                  })}
                </h3>
                <p className="pe-coverage-result__text">
                  {t('open_encounters.coverage_success_desc', {
                    defaultValue: 'Esto nos ayuda a decidir dónde abrir PuntoEncuentro próximamente. Cuando sumemos nuevas zonas, podrás verlas acá.',
                  })}
                </p>
                <div className="pe-coverage-result__actions">
                  <button
                    type="button"
                    className="pe-coverage-btn pe-coverage-btn--primary"
                    onClick={onClose}
                  >
                    {t('open_encounters.coverage_success_btn', { defaultValue: 'Entendido' })}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* 2. FORMULARIO DE CAPTURA */
          <form className="pe-coverage-form" onSubmit={handleSubmit}>
            <p className="pe-coverage-modal__subtitle">
              {t('open_encounters.coverage_modal_subtitle', {
                defaultValue: 'Contanos dónde te gustaría que estemos presentes.',
              })}
            </p>

            {errorMsg && (
              <div className="pe-coverage-error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="pe-coverage-field">
              <label htmlFor="coverage-location" className="pe-coverage-label">
                {t('open_encounters.coverage_location_label', { defaultValue: 'Zona o ciudad' })}{' '}
                <span className="pe-coverage-required">*</span>
              </label>
              <input
                id="coverage-location"
                type="text"
                className="pe-coverage-input"
                placeholder={t('open_encounters.coverage_location_placeholder', {
                  defaultValue: 'Mendoza, Godoy Cruz, City Bell…',
                })}
                value={locationText}
                onChange={(e) => setLocationText(e.target.value)}
                maxLength={100}
                autoFocus
                required
                disabled={isSubmitting}
              />
            </div>

            <div className="pe-coverage-field">
              <label htmlFor="coverage-intent" className="pe-coverage-label">
                {t('open_encounters.coverage_intent_label', { defaultValue: '¿Qué te gustaría hacer? (opcional)' })}
              </label>
              <textarea
                id="coverage-intent"
                className="pe-coverage-textarea"
                placeholder={t('open_encounters.coverage_intent_placeholder', {
                  defaultValue: 'ej. Jugar al pádel, juntarnos a tomar un café…',
                })}
                value={intentText}
                onChange={(e) => setIntentText(e.target.value)}
                maxLength={500}
                disabled={isSubmitting}
              />
            </div>

            <div className="pe-coverage-modal__footer">
              <button
                type="button"
                className="pe-coverage-btn pe-coverage-btn--secondary"
                onClick={onClose}
                disabled={isSubmitting}
              >
                {t('open_encounters.coverage_cancel', { defaultValue: 'Cancelar' })}
              </button>
              <button
                type="submit"
                className="pe-coverage-btn pe-coverage-btn--primary"
                disabled={isSubmitting || !locationText.trim()}
              >
                {isSubmitting
                  ? t('open_encounters.coverage_sending', { defaultValue: 'Enviando…' })
                  : t('open_encounters.coverage_submit', { defaultValue: 'Pedir cobertura' })}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
};
