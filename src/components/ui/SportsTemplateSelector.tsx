import React from 'react';
import { sportsTemplates } from '@/lib/sportsTemplates';
import './SharedTemplateSelector.css';
import { Check } from 'lucide-react';

import { VariantMiniPreviewOverlay } from './VariantMiniPreviewOverlay';

interface SportsTemplateSelectorProps {
  selectedTemplateId?: string | null;
  onSelect: (templateId: string) => void;
  titulo?: string;
  descripcion?: string;
  fecha?: string;
  hora?: string;
  lugar_texto?: string;
}

export const SportsTemplateSelector: React.FC<SportsTemplateSelectorProps> = ({
  selectedTemplateId,
  onSelect,
  titulo,
  descripcion,
  fecha,
  hora,
  lugar_texto
}) => {
  return (
    <div className="shared-template-selector">
      <h4 className="shared-template-selector-title">Elegí un diseño de deportes</h4>
      <div className="shared-template-grid">
        {sportsTemplates.map((template) => {
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
                  eyebrow="DEPORTE"
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
