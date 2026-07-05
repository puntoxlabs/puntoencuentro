import React from 'react';
import { getSpecialTemplateConfig } from '@/lib/specialTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './SpecialInvitationPreview.css';

interface SpecialPreviewData {
  titulo: string;
  fecha: string;
  hora: string;
  lugar_texto?: string | null;
  modalidad?: string | null;
  descripcion?: string | null;
  tema_invitacion: string;
  invitation_template?: string | null;
}

interface Props {
  previewData: SpecialPreviewData;
  className?: string;
}

export const SpecialInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getSpecialTemplateConfig(previewData.invitation_template);

  if (!template) {
    return null;
  }

  const isVirtual = previewData.modalidad === 'virtual';
  const locationText = isVirtual
    ? 'Virtual'
    : (previewData.lugar_texto || '');

  const displayDateTime = formatKidsBirthdayDateTime(previewData.fecha, previewData.hora);

  const cleanMessage = (previewData.descripcion || '').trim();
  const hasMessage = cleanMessage.length > 0;

  return (
    <div className={`special-invitation-container theme-${template.id} ${className}`}>
      <img
        src={template.background}
        alt={template.name}
        className="special-invitation-bg"
      />

      <div className="special-invitation-content">
        <div className="special-invitation-main-bubble">

          <div className="special-invitation-header">
            <p className="special-invitation-eyebrow">Una invitación especial</p>
            {previewData.titulo && (
              <h2 className="special-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="special-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="special-invitation-details">
            {displayDateTime && (
              <div className="special-detail-row">
                <span className="special-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="special-detail-row">
                <span className="special-detail-text special-invitation-location">
                  {locationText}
                </span>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
};
