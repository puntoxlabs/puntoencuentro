import React from 'react';
import { kidsBirthdayTemplates } from '@/lib/kidsBirthdayTemplates';
import type { InvitationTemplateId } from '@/lib/kidsBirthdayTemplates';
import './KidsBirthdayTemplateSelector.css';

interface Props {
  selectedTemplateId: string | null;
  onSelect: (id: InvitationTemplateId) => void;
}

export const KidsBirthdayTemplateSelector: React.FC<Props> = ({ selectedTemplateId, onSelect }) => {
  return (
    <div className="template-selector-container">
      <h3 className="template-selector-title">Elegí un modelo visual</h3>
      <div className="template-selector-grid">
        {kidsBirthdayTemplates.map((template) => (
          <button
            key={template.id}
            className={`template-option ${selectedTemplateId === template.id ? 'selected' : ''}`}
            onClick={() => onSelect(template.id)}
            type="button"
          >
            <div className="template-thumbnail-wrapper">
              <img 
                src={template.thumbnail} 
                alt={template.name} 
                className="template-thumbnail" 
              />
            </div>
            <span className="template-name">{template.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
