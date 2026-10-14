import React from 'react';
import { Calendar, MapPin, ChevronRight, Sparkles, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OpenEncounterSummary } from './types';
import { getSlotLabel } from './types';
import './HomeOpenEncounterCard.css';

export interface HomeOpenEncounterCardProps {
  encounter: OpenEncounterSummary;
  onClick: (encounter: OpenEncounterSummary) => void;
  isHighlighted?: boolean;
}

export const HomeOpenEncounterCard: React.FC<HomeOpenEncounterCardProps> = ({
  encounter,
  onClick,
  isHighlighted = false,
}) => {
  const { t } = useTranslation();

  const isHost = Boolean(encounter.isHost);
  const effectiveHighlighted = !isHost && isHighlighted;

  const slotLabel = getSlotLabel(encounter.openSlots, t);
  const badgeModifier =
    encounter.openSlots <= 0
      ? 'full'
      : encounter.openSlots === 1
      ? 'single'
      : encounter.openSlots === 2
      ? 'remaining'
      : 'count';

  const confirmedPersons = encounter.confirmedSeats ?? encounter.confirmedCount ?? 0;
  const confirmedLabel =
    confirmedPersons === 0
      ? t('open_encounters.confirmed_zero', { defaultValue: '0 personas confirmadas' })
      : confirmedPersons === 1
      ? t('open_encounters.confirmed_single', { defaultValue: '1 persona confirmada' })
      : t('open_encounters.confirmed_people', {
          count: confirmedPersons,
          defaultValue: `${confirmedPersons} personas confirmadas`,
        });

  const hostPrefix = isHost
    ? `${t('open_encounters.host_own_badge', { defaultValue: 'Tu encuentro' })}. `
    : '';

  const matchLabel = effectiveHighlighted
    ? `${t('open_encounters.matched_intention_badge', { defaultValue: 'Coincide con tus ganas' })}. `
    : '';

  const accessibleLabel = `${hostPrefix}${matchLabel}${encounter.title}. ${encounter.dateLabel}. ${encounter.approximateZone}. ${slotLabel}. ${confirmedLabel}.`;

  return (
    <button
      type="button"
      className={`pe-open-card${isHost ? ' pe-open-card--host' : ''}${effectiveHighlighted ? ' pe-open-card--highlighted' : ''}`}
      onClick={() => onClick(encounter)}
      aria-label={accessibleLabel}
      data-encounter-id={encounter.id}
    >
      {isHost ? (
        <div className="pe-open-card__host-badge" role="status">
          <Users className="pe-open-card__host-badge-icon" size={11} aria-hidden="true" />
          <span>{t('open_encounters.host_own_badge', { defaultValue: 'Tu encuentro' })}</span>
        </div>
      ) : effectiveHighlighted ? (
        <div className="pe-open-card__match-badge" role="status">
          <Sparkles className="pe-open-card__match-badge-icon" size={11} aria-hidden="true" />
          <span>{t('open_encounters.matched_intention_badge', { defaultValue: 'Coincide con tus ganas' })}</span>
        </div>
      ) : null}
      <div className="pe-open-card__header">
        <div className="pe-open-card__title-box">
          {encounter.emoji && (
            <span className="pe-open-card__emoji" aria-hidden="true">
              {encounter.emoji}
            </span>
          )}
          <h3 className="pe-open-card__title">{encounter.title}</h3>
        </div>
        <span className={`pe-open-card__badge pe-open-card__badge--${badgeModifier}`}>
          {slotLabel}
        </span>
      </div>

      <div className="pe-open-card__body">
        <div className="pe-open-card__meta-item">
          <Calendar className="pe-open-card__meta-icon" aria-hidden="true" />
          <span>{encounter.dateLabel}</span>
        </div>
        <div className="pe-open-card__meta-item">
          <MapPin className="pe-open-card__meta-icon" aria-hidden="true" />
          <span className="pe-open-card__zone">{encounter.approximateZone}</span>
        </div>
      </div>

      <div className="pe-open-card__footer">
        <span className="pe-open-card__confirmed">{confirmedLabel}</span>
        <span className="pe-open-card__action-hint" aria-hidden="true">
          {isHost ? (
            <span className="pe-open-card__host-action">
              {t('open_encounters.manage_action', { defaultValue: 'Gestionar' })}
            </span>
          ) : null}
          <ChevronRight size={14} />
        </span>
      </div>
    </button>
  );
};
