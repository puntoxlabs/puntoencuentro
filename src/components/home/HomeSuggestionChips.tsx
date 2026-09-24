import React from 'react';
import './HomeSuggestionChips.css';

export interface SuggestionOption {
  label: string;
  prompt: string;
  icon?: string;
}

export const DEFAULT_SUGGESTIONS: SuggestionOption[] = [
  { label: 'Cena este viernes', prompt: 'Quiero organizar una cena con amigos este viernes a las 21', icon: '🍽️' },
  { label: 'Asado el domingo', prompt: 'Asado con amigos el domingo al mediodía', icon: '🥩' },
  { label: 'Partido de pádel', prompt: 'Partido de pádel esta semana para coordinar día y horario', icon: '🎾' },
  { label: 'Cumpleaños sorpresa', prompt: 'Festejo de cumpleaños sorpresa el próximo fin de semana', icon: '🎉' },
];

export const V2_SUGGESTIONS: SuggestionOption[] = [
  { label: 'Jugar al pádel', prompt: 'Quiero jugar al pádel este sábado', icon: '🎾' },
  { label: 'Tomar un café', prompt: 'Quiero tomar un café con amigos esta semana', icon: '☕' },
  { label: 'Salir a caminar', prompt: 'Quiero salir a caminar con amigos el fin de semana', icon: '🥾' },
  { label: 'Festejar mi cumple', prompt: 'Quiero festejar mi cumpleaños el próximo fin de semana', icon: '🎂' },
  { label: 'Juntarnos a comer', prompt: 'Quiero juntarnos a comer unas pizzas con amigos', icon: '🍕' },
  { label: 'Tocar música', prompt: 'Quiero juntarnos a tocar música y zapar', icon: '🎸' },
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
    <div className="home-suggestions-container" aria-label="Ideas rápidas para organizar">
      <div className="home-suggestions-list" role="list">
        {suggestions.map((item) => (
          <button
            key={item.label}
            type="button"
            className="home-suggestion-chip"
            onClick={() => onSelect(item.prompt)}
            role="listitem"
            title={`Completar: "${item.prompt}"`}
          >
            {item.icon && <span className="home-suggestion-icon" aria-hidden="true">{item.icon}</span>}
            <span className="home-suggestion-label">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
