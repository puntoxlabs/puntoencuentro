import React from 'react';
import { wellnessTemplates } from '@/lib/wellnessTemplates';
import './WellnessTemplateSelector.css';
import { Check } from 'lucide-react';

interface WellnessTemplateSelectorProps {
  selectedTemplateId?: string | null;
  onSelect: (templateId: string) => void;
}

export const WellnessTemplateSelector: React.FC<WellnessTemplateSelectorProps> = ({
  selectedTemplateId,
  onSelect
}) => {
  return (
    <div className="wellness-template-selector">
      <h4 className="wellness-template-selector-title">Elegí un diseño de bienestar</h4>
      <div className="wellness-template-grid">
        {wellnessTemplates.map((template) => {
          const isSelected = selectedTemplateId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              className={`wellness-template-option ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(template.id)}
            >
              <div 
                className="wellness-template-thumbnail"
                style={{ 
                  backgroundImage: `url(${template.thumbnail})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {isSelected && (
                  <div className="wellness-template-check">
                    <Check size={16} strokeWidth={3} />
                  </div>
                )}
              </div>
              <span className="wellness-template-name">{template.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
