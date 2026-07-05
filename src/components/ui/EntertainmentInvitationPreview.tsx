import React from 'react';
import { getEntertainmentTemplateConfig } from '@/lib/entertainmentTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './EntertainmentInvitationPreview.css';

interface EntertainmentPreviewData {
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
  previewData: EntertainmentPreviewData;
  className?: string;
}

export const EntertainmentInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getEntertainmentTemplateConfig(previewData.invitation_template);

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
    <div className={`entertainment-invitation-container theme-${template.id} ${className}`}>
      {/* Imagen de fondo real */}
      <img
        src={template.background}
        alt={template.name}
        className="entertainment-invitation-bg"
      />

      {/* Contenido superpuesto */}
      <div className="entertainment-invitation-content">
        <div className="entertainment-invitation-main-bubble">

          <div className="entertainment-invitation-header">
            <p className="entertainment-invitation-eyebrow">¡Estás invitado/a!</p>
            {previewData.titulo && (
              <h2 className="entertainment-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="entertainment-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="entertainment-invitation-details">
            {displayDateTime && (
              <div className="entertainment-detail-row">
                <span className="entertainment-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="entertainment-detail-row">
                <span className="entertainment-detail-text entertainment-invitation-location">
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
