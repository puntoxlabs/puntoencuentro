import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ReuseMode } from '@/types/encounterTemplates';
import './reuse.css';

interface ReuseModeChoiceProps {
  value: ReuseMode;
  onChange: (mode: ReuseMode) => void;
  /** Cantidad de invitados recuperables de forma autorizada. */
  guestCount: number;
  /** Solo cuentas permanentes pueden recuperar/invitar internamente. */
  guestsAllowed: boolean;
  disabled?: boolean;
  name?: string;
}

/** Selector de las dos modalidades: solo plantilla / plantilla con invitados. */
export const ReuseModeChoice: React.FC<ReuseModeChoiceProps> = ({
  value,
  onChange,
  guestCount,
  guestsAllowed,
  disabled = false,
  name = 'reuse-mode',
}) => {
  const { t } = useTranslation();
  const guestsDisabled = disabled || !guestsAllowed || guestCount <= 0;

  const guestsDesc = !guestsAllowed
    ? t('encounter_reuse.mode_with_guests_login')
    : guestCount <= 0
      ? t('encounter_reuse.mode_with_guests_none')
      : t('encounter_reuse.mode_with_guests_desc', { count: guestCount });

  return (
    <fieldset className="pe-reuse-modes" disabled={disabled}>
      <legend className="pe-reuse-label">{t('encounter_reuse.mode_label')}</legend>

      <label className={`pe-reuse-mode ${value === 'template_only' ? 'pe-reuse-mode--selected' : ''}`}>
        <input
          type="radio"
          name={name}
          value="template_only"
          checked={value === 'template_only'}
          onChange={() => onChange('template_only')}
        />
        <span>
          <span className="pe-reuse-mode-title">{t('encounter_reuse.mode_template_only')}</span>
          <span className="pe-reuse-mode-desc">{t('encounter_reuse.mode_template_only_desc')}</span>
        </span>
      </label>

      <label
        className={`pe-reuse-mode ${value === 'template_with_guests' && !guestsDisabled ? 'pe-reuse-mode--selected' : ''} ${guestsDisabled ? 'pe-reuse-mode--disabled' : ''}`}
      >
        <input
          type="radio"
          name={name}
          value="template_with_guests"
          checked={value === 'template_with_guests' && !guestsDisabled}
          disabled={guestsDisabled}
          onChange={() => onChange('template_with_guests')}
        />
        <span>
          <span className="pe-reuse-mode-title">{t('encounter_reuse.mode_with_guests')}</span>
          <span className="pe-reuse-mode-desc">{guestsDesc}</span>
        </span>
      </label>
    </fieldset>
  );
};
