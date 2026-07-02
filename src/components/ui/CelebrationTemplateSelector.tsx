import React from 'react';
import { celebrationTemplates } from '@/lib/celebrationTemplates';
import type { CelebrationTemplateId } from '@/lib/celebrationTemplates';
import './CelebrationTemplateSelector.css';

interface Props {
  selectedTemplateId: string | null;
  onSelect: (id: CelebrationTemplateId) => void;
}

export const CelebrationTemplateSelector: React.FC<Props> = ({ selectedTemplateId, onSelect }) => {
  return (
    <div className="template-selector-container">
      <h3 className="template-selector-title">Elegí un diseño de celebración</h3>
      <div className="template-selector-grid">
        {celebrationTemplates.map((template) => (
          <button
            key={template.id}
            className={`template-option ${selectedTemplateId === template.id ? 'selected' : ''}`}
            onClick={() => onSelect(template.id)}
            type="button"
          >
            <div className="template-thumbnail-wrapper">
              <div 
                className="template-color-preview"
                style={{ background: template.previewColor }}
              />
            </div>
            <span className="template-name">{template.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
