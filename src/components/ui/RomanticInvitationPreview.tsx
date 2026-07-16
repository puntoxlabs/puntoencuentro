import React from 'react';
import { getRomanticTemplateConfig } from '@/lib/romanticTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './RomanticInvitationPreview.css';

interface RomanticPreviewData {
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
  previewData: RomanticPreviewData;
  className?: string;
}

export const RomanticInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getRomanticTemplateConfig(previewData.invitation_template);

  if (!template) {
    return null;
  }

  const isVirtual = previewData.modalidad === 'virtual';
  const locationText = isVirtual ? 'Virtual' : (previewData.lugar_texto || '');
  const displayDateTime = formatKidsBirthdayDateTime(previewData.fecha, previewData.hora);
  const cleanMessage = (previewData.descripcion || '').trim();
  const hasMessage = cleanMessage.length > 0;

  return (
    <div className={`romantic-invitation-container theme-${template.id} ${className}`}>
      <img
        src={template.background}
        alt={template.id}
        className="romantic-invitation-bg"
      />

      <div className="romantic-invitation-content">
        <div className="romantic-invitation-main-bubble">
          <div className="romantic-invitation-header">
            <span className="romantic-invitation-top">¡ESTÁS INVITADO/A!</span>
            <p className="romantic-invitation-eyebrow">A un encuentro especial</p>
            {previewData.titulo && (
              <h2 className="romantic-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="romantic-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="romantic-invitation-details">
            {displayDateTime && (
              <div className="romantic-detail-row">
                <span className="romantic-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="romantic-detail-row">
                <span className="romantic-detail-text romantic-invitation-location">
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
