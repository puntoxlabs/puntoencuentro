import React from 'react';
import { familyTemplates } from '@/lib/familyTemplates';
import './FamilyTemplateSelector.css';
import { Check } from 'lucide-react';

interface FamilyTemplateSelectorProps {
  selectedTemplateId?: string | null;
  onSelect: (templateId: string) => void;
}

export const FamilyTemplateSelector: React.FC<FamilyTemplateSelectorProps> = ({
  selectedTemplateId,
  onSelect
}) => {
  return (
    <div className="family-template-selector">
      <h4 className="family-template-selector-title">Elegí un diseño de familia</h4>
      <div className="family-template-grid">
        {familyTemplates.map((template) => {
          const isSelected = selectedTemplateId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              className={`family-template-option ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(template.id)}
            >
              <div 
                className="family-template-thumbnail"
                style={{ 
                  backgroundImage: `url(${template.thumbnail})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {isSelected && (
                  <div className="family-template-check">
                    <Check size={16} strokeWidth={3} />
                  </div>
                )}
              </div>
              <span className="family-template-name">{template.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
