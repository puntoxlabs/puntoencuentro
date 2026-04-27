import React from 'react';
import { themes } from '@/lib/themes';
import type { ThemeId } from '@/lib/themes';
import './ThemePicker.css';

interface ThemePickerProps {
  value: ThemeId;
  onChange: (theme: ThemeId) => void;
}

export const ThemePicker: React.FC<ThemePickerProps> = ({ value, onChange }) => {
  const themeIds = Object.keys(themes) as ThemeId[];

  return (
    <div className="theme-picker">
      <label className="theme-picker-label">Estilo de la invitación</label>
      <div className="theme-picker-chips">
        {themeIds.map((id) => {
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
        })}
      </div>
    </div>
  );
};
