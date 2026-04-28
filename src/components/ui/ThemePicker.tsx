import React from 'react';
import { themes } from '@/lib/themes';
import type { ThemeId } from '@/lib/themes';
import './ThemePicker.css';

interface ThemePickerProps {
  value: ThemeId;
  onChange: (theme: ThemeId) => void;
}

const CORE_THEMES: ThemeId[] = ['blue', 'green', 'orange', 'purple'];
const EXPRESSIVE_THEMES: ThemeId[] = ['pink', 'yellow'];

export const ThemePicker: React.FC<ThemePickerProps> = ({ value, onChange }) => {
  const renderChip = (id: ThemeId) => {
    const theme = themes[id];
    const isSelected = value === id;
    return (
      <button
        key={id}
        type="button"
        className={`theme-chip ${isSelected ? 'theme-chip--selected' : ''}`}
        style={{ '--chip-primary': theme.primary } as React.CSSProperties}
        onClick={() => onChange(id)}
        aria-label={theme.label}
        aria-pressed={isSelected}
      >
        <span
          className="theme-chip__circle"
          style={{ background: theme.primary }}
        />
        <span className="theme-chip__label">{theme.label}</span>
      </button>
    );
  };

  return (
    <div className="theme-picker">
      <label className="theme-picker-label">Estilo de la invitación</label>
      <div className="theme-picker-chips">
        {CORE_THEMES.map(renderChip)}
      </div>

      <label className="theme-picker-label theme-picker-label--secondary">Más estilos</label>
      <div className="theme-picker-chips theme-picker-chips--expressive">
        {EXPRESSIVE_THEMES.map(renderChip)}
      </div>
    </div>
  );
};
