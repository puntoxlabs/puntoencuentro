import React from 'react';
import { romanticTemplates } from '@/lib/romanticTemplates';
import type { RomanticTemplateId } from '@/lib/romanticTemplates';
import '@/components/ui/KidsBirthdayTemplateSelector.css';

interface Props {
  selectedTemplateId: string | null;
  onSelect: (id: RomanticTemplateId) => void;
}

export const RomanticTemplateSelector: React.FC<Props> = ({ selectedTemplateId, onSelect }) => {
  return (
    <div className="template-selector-container">
      <h3 className="template-selector-title">Elegí un modelo visual</h3>
      <div className="template-selector-grid">
        {romanticTemplates.map((template) => (
          <button
            key={template.id}
            className={`template-option ${selectedTemplateId === template.id ? 'selected' : ''}`}
            onClick={() => onSelect(template.id)}
            type="button"
          >
            <div className="template-thumbnail-wrapper">
              {template.thumbnail ? (
                <img
                  src={template.thumbnail}
                  alt={template.name}
                  className="template-thumbnail"
                />
              ) : (
                <div
                  className="template-color-preview"
                  style={{ background: template.previewColor }}
                />
              )}
            </div>
            <span className="template-name">{template.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
