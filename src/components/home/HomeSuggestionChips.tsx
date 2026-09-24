import React from 'react';
import './HomeSuggestionChips.css';

interface SuggestionOption {
  label: string;
  prompt: string;
  icon?: string;
}

const DEFAULT_SUGGESTIONS: SuggestionOption[] = [
  { label: 'Cena este viernes', prompt: 'Quiero organizar una cena con amigos este viernes a las 21', icon: '🍽️' },
  { label: 'Asado el domingo', prompt: 'Asado con amigos el domingo al mediodía', icon: '🥩' },
  { label: 'Partido de pádel', prompt: 'Partido de pádel esta semana para coordinar día y horario', icon: '🎾' },
  { label: 'Cumpleaños sorpresa', prompt: 'Festejo de cumpleaños sorpresa el próximo fin de semana', icon: '🎉' },
];

interface HomeSuggestionChipsProps {
  onSelect: (prompt: string) => void;
  suggestions?: SuggestionOption[];
}

export const HomeSuggestionChips: React.FC<HomeSuggestionChipsProps> = ({
  onSelect,
  suggestions = DEFAULT_SUGGESTIONS,
}) => {
  return (
    <div className="home-suggestions-container" aria-label="Ideas para organizar">
      <div className="home-suggestions-label">Ideas rápidas</div>
      <div className="home-suggestions-list" role="list">
        {suggestions.map((item) => (
          <button
            key={item.label}
            type="button"
            className="home-suggestion-chip"
            onClick={() => onSelect(item.prompt)}
            role="listitem"
          >
            {item.icon && <span>{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
