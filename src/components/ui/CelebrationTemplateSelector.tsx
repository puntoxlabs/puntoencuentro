import React from 'react';
import { celebrationTemplates } from '@/lib/celebrationTemplates';
import type { CelebrationTemplateId } from '@/lib/celebrationTemplates';
import './SharedTemplateSelector.css';
import { Check } from 'lucide-react';

interface Props {
  selectedTemplateId: string | null;
  onSelect: (id: CelebrationTemplateId) => void;
}

export const CelebrationTemplateSelector: React.FC<Props> = ({ selectedTemplateId, onSelect }) => {
  return (
    <div className="shared-template-selector">
      <h4 className="shared-template-selector-title">Elegí un modelo visual</h4>
      <div className="shared-template-grid">
        {celebrationTemplates.map((template) => {
          const isSelected = selectedTemplateId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              className={`shared-template-option ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(template.id)}
            >
              <div 
                className="shared-template-thumbnail"
                style={{ 
                  ...(template.thumbnail 
                    ? { backgroundImage: `url(${template.thumbnail})`, backgroundSize: 'cover', backgroundPosition: 'center' } 
                    : { background: template.previewColor }
                  )
                }}
              >
                {isSelected && (
                  <div className="shared-template-check">
                    <Check size={16} strokeWidth={3} />
                  </div>
                )}
              </div>
              <span className="shared-template-name">{template.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
