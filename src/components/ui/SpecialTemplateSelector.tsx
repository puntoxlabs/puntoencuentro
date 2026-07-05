import React from 'react';
import { specialTemplates } from '@/lib/specialTemplates';
import './SpecialTemplateSelector.css';
import { Check } from 'lucide-react';

interface SpecialTemplateSelectorProps {
  selectedTemplateId?: string | null;
  onSelect: (templateId: string) => void;
}

export const SpecialTemplateSelector: React.FC<SpecialTemplateSelectorProps> = ({
  selectedTemplateId,
  onSelect
}) => {
  return (
    <div className="special-template-selector">
      <h4 className="special-template-selector-title">Elegí un diseño especial</h4>
      <div className="special-template-grid">
        {specialTemplates.map((template) => {
          const isSelected = selectedTemplateId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              className={`special-template-option ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(template.id)}
            >
              <div 
                className="special-template-thumbnail"
                style={{ 
                  backgroundImage: `url(${template.thumbnail})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {isSelected && (
                  <div className="special-template-check">
                    <Check size={16} strokeWidth={3} />
                  </div>
                )}
              </div>
              <span className="special-template-name">{template.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
