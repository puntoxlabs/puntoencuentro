import React from 'react';
import { Check } from 'lucide-react';
import './SelectableOptionCard.css';

interface SelectableOptionCardProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  badge?: React.ReactNode;
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
}

export const SelectableOptionCard: React.FC<SelectableOptionCardProps> = ({
  icon,
  title,
  description,
  badge,
  selected,
  onClick,
  disabled = false,
  compact = false,
}) => {
  return (
    <button
      type="button"
      className={[
        'pe-selectable-card',
        selected ? 'pe-selectable-card--selected' : '',
        disabled ? 'pe-selectable-card--disabled' : '',
        compact ? 'pe-selectable-card--compact' : ''
      ].filter(Boolean).join(' ')}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      <div className="pe-selectable-card__content-wrapper">
        {icon && <div className="pe-selectable-card__icon">{icon}</div>}
        <div className="pe-selectable-card__text">
          <div className="pe-selectable-card__header">
            <span className="pe-selectable-card__title">{title}</span>
            {badge && <span className="pe-selectable-card__badge">{badge}</span>}
          </div>
          {description && !compact && (
            <span className="pe-selectable-card__description">{description}</span>
          )}
        </div>
      </div>
      <div className={['pe-selectable-card__check', selected ? 'pe-selectable-card__check--visible' : ''].filter(Boolean).join(' ')}>
        <Check size={20} strokeWidth={3} />
      </div>
    </button>
  );
};
