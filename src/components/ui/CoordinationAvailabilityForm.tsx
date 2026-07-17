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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, width: '100%' }}>
      {showErrors && hasMissingResponses && (
        <div role="alert" aria-live="polite" style={{ backgroundColor: '#fef2f2', color: '#991b1b', padding: 16, borderRadius: 16, fontSize: 15, display: 'flex', alignItems: 'center', gap: 12, border: '1px solid #fecaca' }}>
          <AlertCircle size={24} color="#dc2626" />
          <span style={{ fontWeight: 600 }}>{t('coordination.missing_responses', 'Falta responder alguna opción')}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {sortedOpciones.map((op) => {
          const resp = respuestas[op.id];
          const hasError = showErrors && !resp;

          return (
            <div
              key={op.id}
              style={{
                background: '#ffffff',
                border: `1px solid ${hasError ? '#dc2626' : '#e2e8f0'}`,
                borderRadius: 20,
                padding: '20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
                boxShadow: '0 4px 12px rgba(15,23,42,0.03)',
                transition: 'all 0.2s ease-in-out',
                ...(hasError ? { backgroundColor: '#fef2f2' } : {})
              }}
            >
              <div id={`header-${op.id}`}>
                <div style={{ fontWeight: 700, fontSize: 16, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ background: '#f1f5f9', padding: 8, borderRadius: 10 }}>
                    <Calendar size={18} color="#475569" />
                  </div>
                  <span>{formatCoordinationOptionDate(op.fecha, op.hora_inicio, i18n.language)}</span>
                </div>
              </div>

              <div role="radiogroup" aria-labelledby={`header-${op.id}`} style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={resp?.respuesta === 'available'}
                  disabled={readOnly}
                  onClick={() => onChangeRespuesta(op.id, 'available')}
                  style={{
                    flex: 1,
                    padding: '12px 8px',
                    borderRadius: 12,
                    border: resp?.respuesta === 'available' ? '2px solid #22c55e' : '1px solid #e2e8f0',
                    background: resp?.respuesta === 'available' ? '#dcfce7' : '#f8fafc',
                    color: resp?.respuesta === 'available' ? '#166534' : '#64748b',
                    fontSize: 14,
                    fontWeight: resp?.respuesta === 'available' ? 700 : 600,
                    cursor: readOnly ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s',
                    opacity: readOnly ? 0.6 : 1,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: 6
                  }}
                >
                  {t('coordination.available', 'Puedo')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={resp?.respuesta === 'maybe'}
                  disabled={readOnly}
                  onClick={() => onChangeRespuesta(op.id, 'maybe')}
                  style={{
                    flex: 1,
                    padding: '12px 8px',
                    borderRadius: 12,
                    border: resp?.respuesta === 'maybe' ? '2px solid #eab308' : '1px solid #e2e8f0',
                    background: resp?.respuesta === 'maybe' ? '#fef9c3' : '#f8fafc',
                    color: resp?.respuesta === 'maybe' ? '#854d0e' : '#64748b',
                    fontSize: 14,
                    fontWeight: resp?.respuesta === 'maybe' ? 700 : 600,
                    cursor: readOnly ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s',
                    opacity: readOnly ? 0.6 : 1,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: 6
                  }}
                >
                  {t('coordination.maybe', 'Tal vez')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={resp?.respuesta === 'unavailable'}
                  disabled={readOnly}
                  onClick={() => onChangeRespuesta(op.id, 'unavailable')}
                  style={{
                    flex: 1,
                    padding: '12px 8px',
                    borderRadius: 12,
                    border: resp?.respuesta === 'unavailable' ? '2px solid #ef4444' : '1px solid #e2e8f0',
                    background: resp?.respuesta === 'unavailable' ? '#fee2e2' : '#f8fafc',
                    color: resp?.respuesta === 'unavailable' ? '#991b1b' : '#64748b',
                    fontSize: 14,
                    fontWeight: resp?.respuesta === 'unavailable' ? 700 : 600,
                    cursor: readOnly ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s',
                    opacity: readOnly ? 0.6 : 1,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: 6
                  }}
                >
                  {t('coordination.unavailable', 'No puedo')}
                </button>
              </div>

              <div style={{ paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 15,
                    color: resp?.es_preferida ? '#d97706' : '#64748b',
                    fontWeight: resp?.es_preferida ? 700 : 500,
                    cursor: (readOnly || !resp || resp.respuesta === 'unavailable') ? 'not-allowed' : 'pointer',
                    userSelect: 'none',
                    opacity: (readOnly || !resp || resp.respuesta === 'unavailable') ? 0.5 : 1,
                    padding: '8px 12px',
                    borderRadius: 12,
                    background: resp?.es_preferida ? '#fef3c7' : 'transparent',
                    transition: 'all 0.2s'
                  }}
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
                  <CheckCircle2 size={20} color={resp?.es_preferida ? '#d97706' : '#94a3b8'} />
                  <span>{t('coordination.preferred_option', 'Marcar como opción preferida')}</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
