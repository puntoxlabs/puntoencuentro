import React from 'react';
import { friendsTemplates } from '@/lib/friendsTemplates';
import './FriendsTemplateSelector.css';
import { Check } from 'lucide-react';

interface FriendsTemplateSelectorProps {
  selectedTemplateId?: string | null;
  onSelect: (templateId: string) => void;
}

export const FriendsTemplateSelector: React.FC<FriendsTemplateSelectorProps> = ({
  selectedTemplateId,
  onSelect
}) => {
  return (
    <div className="friends-template-selector">
      <h4 className="friends-template-selector-title">Elegí un diseño de amigos</h4>
      <div className="friends-template-grid">
        {friendsTemplates.map((template) => {
          const isSelected = selectedTemplateId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              className={`friends-template-option ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(template.id)}
            >
              <div 
                className="friends-template-thumbnail"
                style={{ 
                  backgroundImage: `url(${template.thumbnail})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {isSelected && (
                  <div className="friends-template-check">
                    <Check size={16} strokeWidth={3} />
                  </div>
                )}
              </div>
              <span className="friends-template-name">{template.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
