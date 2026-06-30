import React from 'react';
import { INVITATION_THEMES } from '@/lib/invitationThemes';
import type { InvitationTheme } from '@/lib/invitationThemes';
import './InvitationThemeSelector.css';

interface InvitationThemeSelectorProps {
  value: string;
  onChange: (theme: InvitationTheme) => void;
}

export const InvitationThemeSelector: React.FC<InvitationThemeSelectorProps> = ({ value, onChange }) => {
  return (
    <div className="invitation-theme-selector-container">
      <div className="invitation-theme-selector-header">
        <label className="input-label" style={{ marginBottom: 4 }}>Estilo de invitación</label>
        <span className="invitation-theme-selector-badge">Opcional</span>
      </div>
      
      <div className="invitation-theme-selector-scroll">
        <div className="invitation-theme-selector-grid">
          {INVITATION_THEMES.map((theme) => {
            const Icon = theme.icon;
            const isSelected = value === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                className={`invitation-theme-item ${isSelected ? 'invitation-theme-item--selected' : ''}`}
                onClick={() => onChange(theme.id as InvitationTheme)}
                aria-pressed={isSelected}
              >
                <div className="invitation-theme-item-icon-wrap">
                  <Icon size={20} className="invitation-theme-item-icon" />
                </div>
                <span className="invitation-theme-item-label">{theme.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
