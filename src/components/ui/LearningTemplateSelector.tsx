import React from 'react';
import { learningTemplates } from '@/lib/learningTemplates';
import './LearningTemplateSelector.css';
import { Check } from 'lucide-react';

interface LearningTemplateSelectorProps {
  selectedTemplateId?: string | null;
  onSelect: (templateId: string) => void;
}

export const LearningTemplateSelector: React.FC<LearningTemplateSelectorProps> = ({
  selectedTemplateId,
  onSelect
}) => {
  return (
    <div className="learning-template-selector">
      <h4 className="learning-template-selector-title">Elegí un diseño de formación</h4>
      <div className="learning-template-grid">
        {learningTemplates.map((template) => {
          const isSelected = selectedTemplateId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              className={`learning-template-option ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(template.id)}
            >
              <div 
                className="learning-template-thumbnail"
                style={{ 
                  backgroundImage: `url(${template.thumbnail})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {isSelected && (
                  <div className="learning-template-check">
                    <Check size={16} strokeWidth={3} />
                  </div>
                )}
              </div>
              <span className="learning-template-name">{template.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
