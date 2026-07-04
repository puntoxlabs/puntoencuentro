import React from 'react';
import { getFriendsTemplateConfig } from '@/lib/friendsTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './FriendsInvitationPreview.css';

interface FriendsPreviewData {
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
  previewData: FriendsPreviewData;
  className?: string;
}

export const FriendsInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getFriendsTemplateConfig(previewData.invitation_template);

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
    <div className={`friends-invitation-container theme-${template.id} ${className}`}>
      {/* Imagen de fondo real */}
      <img
        src={template.background}
        alt={template.name}
        className="friends-invitation-bg"
      />

      {/* Contenido superpuesto */}
      <div className="friends-invitation-content">
        <div className="friends-invitation-main-bubble">

          <div className="friends-invitation-header">
            <p className="friends-invitation-eyebrow">¡Estás invitado/a!</p>
            {previewData.titulo && (
              <h2 className="friends-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="friends-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="friends-invitation-details">
            {displayDateTime && (
              <div className="friends-detail-row">
                <span className="friends-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="friends-detail-row">
                <span className="friends-detail-text friends-invitation-location">
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
