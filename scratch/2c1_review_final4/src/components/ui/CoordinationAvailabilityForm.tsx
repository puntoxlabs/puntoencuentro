import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Calendar, AlertCircle } from 'lucide-react';
import type { CoordinationOption, CoordinationAvailabilityValue, CoordinationAvailabilityInput } from '@/services/encuentrosService';
import { formatCoordinationOptionDate } from '@/lib/formatCoordinationDate';
import './CoordinationAvailabilityForm.css';

export interface CoordinationAvailabilityFormProps {
  opciones: Omit<CoordinationOption, 'selected'>[];
  respuestas: Record<string, CoordinationAvailabilityInput>;
  onChangeRespuesta: (opcionId: string, value: CoordinationAvailabilityValue) => void;
  onTogglePreferida: (opcionId: string) => void;
  readOnly?: boolean;
  showErrors?: boolean;
}

export const CoordinationAvailabilityForm = ({
  opciones,
  respuestas,
  onChangeRespuesta,
  onTogglePreferida,
  readOnly = false,
  showErrors = false
}: CoordinationAvailabilityFormProps) => {
  const { t, i18n } = useTranslation();

  const sortedOpciones = useMemo(() => {
    return [...opciones].sort((a, b) => a.orden - b.orden);
  }, [opciones]);

  const hasMissingResponses = sortedOpciones.some(op => !respuestas[op.id]);

  return (
    <div className="coordination-form">
      {showErrors && hasMissingResponses && (
        <div className="coordination-form-error" role="alert" aria-live="polite">
          <AlertCircle size={18} />
          <span>{t('coordination.missing_responses', 'Falta responder alguna opción')}</span>
        </div>
      )}

      <div className="coordination-options-list">
        {sortedOpciones.map((op) => {
          const resp = respuestas[op.id];
          const hasError = showErrors && !resp;

          return (
            <div 
              key={op.id} 
              className={`coordination-option-card ${hasError ? 'has-error' : ''}`}
            >
              <div className="coordination-option-header" id={`header-${op.id}`}>
                <div className="coordination-option-date">
                  <Calendar size={18} />
                  <span>{formatCoordinationOptionDate(op.fecha, op.hora_inicio, i18n.language)}</span>
                </div>
              </div>

              <div className="coordination-responses" role="radiogroup" aria-labelledby={`header-${op.id}`}>
                <button
                  type="button"
                  role="radio"
                  className={`coordination-response-btn available`}
                  aria-checked={resp?.respuesta === 'available'}
                  disabled={readOnly}
                  onClick={() => onChangeRespuesta(op.id, 'available')}
                >
                  <span className="coordination-response-icon">{resp?.respuesta === 'available' ? '✓ ' : ''}</span>
                  {t('coordination.available', 'Puedo')}
                </button>
                <button
                  type="button"
                  role="radio"
                  className={`coordination-response-btn maybe`}
                  aria-checked={resp?.respuesta === 'maybe'}
                  disabled={readOnly}
                  onClick={() => onChangeRespuesta(op.id, 'maybe')}
                >
                  <span className="coordination-response-icon">{resp?.respuesta === 'maybe' ? '✓ ' : ''}</span>
                  {t('coordination.maybe', 'Tal vez')}
                </button>
                <button
                  type="button"
                  role="radio"
                  className={`coordination-response-btn unavailable`}
                  aria-checked={resp?.respuesta === 'unavailable'}
                  disabled={readOnly}
                  onClick={() => onChangeRespuesta(op.id, 'unavailable')}
                >
                  <span className="coordination-response-icon">{resp?.respuesta === 'unavailable' ? '✗ ' : ''}</span>
                  {t('coordination.unavailable', 'No puedo')}
                </button>
              </div>

              <label 
                className={`coordination-preferred-toggle ${readOnly || !resp || resp.respuesta === 'unavailable' ? 'disabled' : ''} ${resp?.es_preferida ? 'active' : ''}`}
                htmlFor={`pref-${op.id}`}
              >
                <input
                  type="checkbox"
                  id={`pref-${op.id}`}
                  checked={resp?.es_preferida || false}
                  disabled={
                    readOnly ||
                    !resp ||
                    resp.respuesta === 'unavailable'
                  }
                  onChange={() => onTogglePreferida(op.id)}
                  aria-label={t('coordination.preferred_option_aria', {
                    dateTime: formatCoordinationOptionDate(op.fecha, op.hora_inicio, i18n.language)
                  })}
                  className="coordination-sr-only"
                />
                <CheckCircle2 size={18} />
                <span>{t('coordination.preferred_option', 'Opción preferida')}</span>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
};
