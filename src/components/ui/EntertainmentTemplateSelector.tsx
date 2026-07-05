import React from 'react';
import { entertainmentTemplates } from '@/lib/entertainmentTemplates';
import './EntertainmentTemplateSelector.css';
import { Check } from 'lucide-react';

interface EntertainmentTemplateSelectorProps {
  selectedTemplateId?: string | null;
  onSelect: (templateId: string) => void;
}

export const EntertainmentTemplateSelector: React.FC<EntertainmentTemplateSelectorProps> = ({
  selectedTemplateId,
  onSelect
}) => {
  return (
    <div className="entertainment-template-selector">
      <h4 className="entertainment-template-selector-title">Elegí un diseño de entretenimiento</h4>
      <div className="entertainment-template-grid">
        {entertainmentTemplates.map((template) => {
          const isSelected = selectedTemplateId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              className={`entertainment-template-option ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(template.id)}
            >
              <div 
                className="entertainment-template-thumbnail"
                style={{ 
                  backgroundImage: `url(${template.thumbnail})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {isSelected && (
                  <div className="entertainment-template-check">
                    <Check size={16} strokeWidth={3} />
                  </div>
                )}
              </div>
              <span className="entertainment-template-name">{template.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
