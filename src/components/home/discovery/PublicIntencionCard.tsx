import React from 'react';
import { Sparkles, MapPin, Calendar, Users, Check, Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PublicIntencionSummary } from '@/types/intenciones';
import './PublicIntencionCard.css';

export interface PublicIntencionCardProps {
  intencion: PublicIntencionSummary;
  onInterestClick?: (intencionId: string, interesado: boolean) => void;
  isLoading?: boolean;
}

export const PublicIntencionCard: React.FC<PublicIntencionCardProps> = ({
  intencion,
  onInterestClick,
  isLoading = false,
}) => {
  const { t } = useTranslation();
  const isOwn = intencion.is_own;
  const isInterested = intencion.viewer_interested;
  const count = intencion.interested_count;

  const handleInterest = () => {
    if (isLoading || isOwn || !onInterestClick) return;
    onInterestClick(intencion.id, true);
  };

  const handleRemoveInterest = () => {
    if (isLoading || isOwn || !onInterestClick) return;
    onInterestClick(intencion.id, false);
  };

  return (
    <article
      className={`pe-public-intencion-card ${isOwn ? 'pe-public-intencion-card--own' : ''} ${isInterested ? 'pe-public-intencion-card--interested' : ''}`}
      aria-label={t('open_encounters.card_aria_label', { defaultValue: `Ganas de…: ${intencion.titulo}`, title: intencion.titulo })}
    >
      {/* Cabecera */}
      <div className="pe-public-intencion-card__header">
        <div className="pe-public-intencion-card__badges">
          <span className="pe-public-intencion-badge pe-public-intencion-badge--type">
            <Sparkles size={12} aria-hidden="true" />
            <span>{t('open_encounters.badge_intention', { defaultValue: 'Ganas de…' })}</span>
          </span>

          {intencion.modalidad === 'virtual' ? (
            <span className="pe-public-intencion-badge pe-public-intencion-badge--virtual">
              Virtual
            </span>
          ) : (
            <span className="pe-public-intencion-badge pe-public-intencion-badge--presencial">
              Presencial
            </span>
          )}

          {isOwn && (
            <span className="pe-public-intencion-badge pe-public-intencion-badge--own">
              Tu intención
            </span>
          )}
        </div>

        {count > 0 && (
          <div
            className="pe-public-intencion-count"
            title={`${count} persona${count !== 1 ? 's' : ''} interesada${count !== 1 ? 's' : ''}`}
          >
            <Users size={12} aria-hidden="true" />
            <span>{count}</span>
          </div>
        )}
      </div>

      {/* Contenido principal */}
      <div className="pe-public-intencion-card__body">
        <h3 className="pe-public-intencion-card__title">{intencion.titulo}</h3>

        {intencion.descripcion && (
          <p className="pe-public-intencion-card__desc">{intencion.descripcion}</p>
        )}

        <div className="pe-public-intencion-card__meta">
          {intencion.approximate_zone && (
            <span className="pe-public-intencion-meta-item">
              <MapPin size={13} aria-hidden="true" />
              <span>{intencion.approximate_zone}</span>
            </span>
          )}

          {intencion.temporalidad_texto && (
            <span className="pe-public-intencion-meta-item">
              <Calendar size={13} aria-hidden="true" />
              <span>{intencion.temporalidad_texto}</span>
            </span>
          )}
        </div>
      </div>

      {/* Pie y Acción de Interés */}
      <div className="pe-public-intencion-card__footer">
        {isOwn ? (
          <div className="pe-public-intencion-card__own-notice">
            <span>Tu intención publicada en Discovery</span>
          </div>
        ) : (
          <div className="pe-public-intencion-card__action-box">
            {isInterested ? (
              <div className="pe-public-intencion-card__interested-actions">
                <span className="pe-public-intencion-btn pe-public-intencion-btn--active">
                  <Check size={14} aria-hidden="true" />
                  <span>Te interesa</span>
                </span>
                <button
                  type="button"
                  className="pe-public-intencion-btn pe-public-intencion-btn--remove"
                  onClick={handleRemoveInterest}
                  disabled={isLoading}
                  aria-label={`Ya no me interesa: ${intencion.titulo}`}
                >
                  {isLoading ? 'Guardando…' : 'Ya no me interesa'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="pe-public-intencion-btn pe-public-intencion-btn--primary"
                onClick={handleInterest}
                disabled={isLoading}
                aria-label={`A mí también me interesa: ${intencion.titulo}`}
              >
                <Heart size={14} aria-hidden="true" />
                <span>{isLoading ? 'Guardando…' : 'A mí también me interesa'}</span>
              </button>
            )}

            <p className="pe-public-intencion-microcopy">
              Le muestra a quien propuso la idea que hay interés para que se anime a poner fecha y lugar. No te suma a ningún grupo ni te compromete.
            </p>
          </div>
        )}
      </div>
    </article>
  );
};
