import React from 'react';
import { sportsTemplates } from '@/lib/sportsTemplates';
import './SportsTemplateSelector.css';
import { Check } from 'lucide-react';

interface SportsTemplateSelectorProps {
  selectedTemplateId?: string | null;
  onSelect: (templateId: string) => void;
}

export const SportsTemplateSelector: React.FC<SportsTemplateSelectorProps> = ({
  selectedTemplateId,
  onSelect
}) => {
  return (
    <div className="sports-template-selector">
      <h4 className="sports-template-selector-title">Elegí un diseño de deportes</h4>
      <div className="sports-template-grid">
        {sportsTemplates.map((template) => {
          const isSelected = selectedTemplateId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              className={`sports-template-option ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(template.id)}
            >
              <div 
                className="sports-template-thumbnail"
                style={{ 
                  backgroundImage: `url(${template.thumbnail})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {isSelected && (
                  <div className="sports-template-check">
                    <Check size={16} strokeWidth={3} />
                  </div>
                )}
              </div>
              <span className="sports-template-name">{template.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
