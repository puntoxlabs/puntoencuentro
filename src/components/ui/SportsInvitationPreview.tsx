import React from 'react';
import { getSportsTemplateConfig } from '@/lib/sportsTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './SportsInvitationPreview.css';

interface SportsPreviewData {
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
  previewData: SportsPreviewData;
  className?: string;
}

export const SportsInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getSportsTemplateConfig(previewData.invitation_template);

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
    <div className={`sports-invitation-container theme-${template.id} ${className}`}>
      {/* Imagen de fondo real */}
      <img
        src={template.background}
        alt={template.name}
        className="sports-invitation-bg"
      />

      {/* Contenido superpuesto */}
      <div className="sports-invitation-content">
        <div className="sports-invitation-main-bubble">

          <div className="sports-invitation-header">
            <p className="sports-invitation-eyebrow">¡Estás invitado/a!</p>
            {previewData.titulo && (
              <h2 className="sports-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="sports-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="sports-invitation-details">
            {displayDateTime && (
              <div className="sports-detail-row">
                <span className="sports-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="sports-detail-row">
                <span className="sports-detail-text sports-invitation-location">
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
