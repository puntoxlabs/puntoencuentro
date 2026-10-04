import React from 'react';
import { Calendar, MapPin, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OpenEncounterSummary } from './types';
import { getSlotLabel } from './types';
import './HomeOpenEncounterCard.css';

export interface HomeOpenEncounterCardProps {
  encounter: OpenEncounterSummary;
  onClick: (encounter: OpenEncounterSummary) => void;
}

export const HomeOpenEncounterCard: React.FC<HomeOpenEncounterCardProps> = ({
  encounter,
  onClick,
}) => {
  const { t } = useTranslation();

  const slotLabel = getSlotLabel(encounter.openSlots, t);
  const badgeModifier =
    encounter.openSlots <= 0
      ? 'full'
      : encounter.openSlots === 1
      ? 'single'
      : encounter.openSlots === 2
      ? 'remaining'
      : 'count';

  const confirmedLabel =
    encounter.confirmedCount === 0
      ? t('open_encounters.confirmed_zero', { defaultValue: '0 personas confirmadas' })
      : encounter.confirmedCount === 1
      ? t('open_encounters.confirmed_single', { defaultValue: '1 persona confirmada' })
      : t('open_encounters.confirmed_people', {
          count: encounter.confirmedCount,
          defaultValue: `${encounter.confirmedCount} personas confirmadas`,
        });

  const accessibleLabel = `${encounter.title}. ${encounter.dateLabel}. ${encounter.approximateZone}. ${slotLabel}. ${confirmedLabel}.`;

  return (
    <button
      type="button"
      className="pe-open-card"
      onClick={() => onClick(encounter)}
      aria-label={accessibleLabel}
    >
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
          <ChevronRight size={14} />
        </span>
      </div>
    </button>
  );
};
