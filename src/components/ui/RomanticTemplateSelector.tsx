import React from 'react';
import { romanticTemplates } from '@/lib/romanticTemplates';
import './SharedTemplateSelector.css';
import { Check } from 'lucide-react';

import { VariantMiniPreviewOverlay } from './VariantMiniPreviewOverlay';

interface RomanticTemplateSelectorProps {
  selectedTemplateId?: string | null;
  onSelect: (templateId: string) => void;
  titulo?: string;
  descripcion?: string;
  fecha?: string;
  hora?: string;
  lugar_texto?: string;
  displayDateLabel?: string;
}

export const RomanticTemplateSelector: React.FC<RomanticTemplateSelectorProps> = ({
  selectedTemplateId,
  onSelect,
  titulo,
  descripcion,
  fecha,
  hora,
  lugar_texto,
  displayDateLabel
}) => {
  return (
    <div className="shared-template-selector">
      <h4 className="shared-template-selector-title">Elegí un modelo visual</h4>
      <div className="shared-template-grid">
        {romanticTemplates.map((template) => {
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
                  backgroundImage: `url(${(template as any).background || template.thumbnail})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  backgroundColor: (template as any).previewColor
                }}
              >
                <VariantMiniPreviewOverlay
                  titulo={titulo}
                  descripcion={descripcion}
                  fecha={fecha}
                  hora={hora}
                  lugar_texto={lugar_texto}
                  displayDateLabel={displayDateLabel}
                  eyebrow="ROMÁNTICO"
                />
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
