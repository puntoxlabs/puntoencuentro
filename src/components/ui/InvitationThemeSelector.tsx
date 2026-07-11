import React, { useState, useEffect } from 'react';
import { INVITATION_THEMES } from '@/lib/invitationThemes';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { CustomDesignsSheet } from './CustomDesignsSheet';
import './InvitationThemeSelector.css';

interface InvitationThemeSelectorProps {
  value: string;
  template?: string | null;
  onChange: (theme: InvitationTheme, template?: string) => void;
}

export const InvitationThemeSelector: React.FC<InvitationThemeSelectorProps> = ({ value, template, onChange }) => {
  const [expanded, setExpanded] = useState(false);
  const [isCustomSheetOpen, setIsCustomSheetOpen] = useState(false);

  // Default auto-expand logic if selected theme is beyond the first 4
  useEffect(() => {
    if (!expanded) {
      const selectedIndex = INVITATION_THEMES.findIndex(t => t.id === value);
      if (selectedIndex >= 4) {
        setExpanded(true);
      }
    }
  }, [value, expanded]);

  const visibleThemes = expanded ? INVITATION_THEMES : INVITATION_THEMES.slice(0, 4);

  return (
    <div className="invitation-theme-selector-container">
      <div className="invitation-theme-selector-header">
        <label className="input-label" style={{ marginBottom: 4 }}>Estilo de invitación</label>
        <span className="invitation-theme-selector-badge">Opcional</span>
      </div>
      
      <div className="invitation-theme-selector-scroll">
        <div className="invitation-theme-selector-grid">
          {visibleThemes.map((theme) => {
            const Icon = theme.icon;
            const isSelected = value === theme.id && (theme.id !== 'custom' || (template != null && template.startsWith('custom_')));
            return (
              <button
                key={theme.id}
                type="button"
                className={`invitation-theme-item theme-tile-${theme.id} ${isSelected ? 'invitation-theme-item--selected' : ''}`}
                onClick={() => {
                  if (theme.id === 'custom') {
                    setIsCustomSheetOpen(true);
                  } else {
                    onChange(theme.id as InvitationTheme);
                  }
                }}
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

      <button
        type="button"
        className="invitation-theme-selector-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'Ver menos' : 'Ver más estilos'}
      </button>

      <button
        type="button"
        className="invitation-theme-selector-custom-btn"
        onClick={() => setIsCustomSheetOpen(true)}
      >
        Crear o gestionar diseño personalizado
      </button>

      <CustomDesignsSheet 
        isOpen={isCustomSheetOpen} 
        onClose={() => setIsCustomSheetOpen(false)} 
        onSelectDesign={(templateId) => {
          onChange('custom', `custom_${templateId}`);
          setIsCustomSheetOpen(false);
        }}
      />
    </div>
  );
};
