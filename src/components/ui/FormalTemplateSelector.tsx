import React from 'react';
import { formalTemplates } from '@/lib/formalTemplates';
import type { FormalTemplateId } from '@/lib/formalTemplates';
import './SharedTemplateSelector.css';
import { Check } from 'lucide-react';

import { VariantMiniPreviewOverlay } from './VariantMiniPreviewOverlay';

interface Props {
  selectedTemplateId: string | null;
  onSelect: (id: FormalTemplateId) => void;
  titulo?: string;
  descripcion?: string;
  fecha?: string;
  hora?: string;
  lugar_texto?: string;
  displayDateLabel?: string;
}

export const FormalTemplateSelector: React.FC<Props> = ({
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
        {formalTemplates.map((template) => {
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
                  ...((template as any).background || template.thumbnail
                    ? { backgroundImage: `url(${(template as any).background || template.thumbnail})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                    : { background: template.previewColor }
                  )
                }}
              >
                <VariantMiniPreviewOverlay
                  titulo={titulo}
                  descripcion={descripcion}
                  fecha={fecha}
                  hora={hora}
                  lugar_texto={lugar_texto}
                  displayDateLabel={displayDateLabel}
                  eyebrow="REUNIÓN"
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
