import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, ArrowRight } from 'lucide-react';
import './HomeIntentionsBand.css';

export interface HomeIntentionsBandProps {
  onExpressIntent: () => void;
}

export const HomeIntentionsBand: React.FC<HomeIntentionsBandProps> = ({ onExpressIntent }) => {
  const { t } = useTranslation();

  const title = t('intentions_band.title', { defaultValue: 'Tengo ganas de…' });
  const desc = t('intentions_band.desc', {
    defaultValue: 'Decí qué te gustaría hacer, aunque todavía no sea un encuentro.',
  });

  return (
    <button
      type="button"
      className="home-intentions-band"
      onClick={onExpressIntent}
      aria-label={`${title}: ${desc}`}
    >
      <div className="home-intentions-band__content">
        <div className="home-intentions-band__icon-wrapper" aria-hidden="true">
          <Sparkles size={18} className="home-intentions-band__icon" />
        </div>
        <div className="home-intentions-band__text-group">
          <span className="home-intentions-band__title">{title}</span>
          <span className="home-intentions-band__desc">{desc}</span>
        </div>
      </div>
      <div className="home-intentions-band__action" aria-hidden="true">
        <ArrowRight size={16} className="home-intentions-band__arrow" />
      </div>
    </button>
  );
};
