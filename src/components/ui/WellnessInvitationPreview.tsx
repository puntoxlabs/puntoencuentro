import React from 'react';
import { getWellnessTemplateConfig } from '@/lib/wellnessTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './WellnessInvitationPreview.css';

interface WellnessPreviewData {
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
  previewData: WellnessPreviewData;
  className?: string;
}

export const WellnessInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getWellnessTemplateConfig(previewData.invitation_template);

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
    <div className={`wellness-invitation-container theme-${template.id} ${className}`}>
      {/* Imagen de fondo real */}
      <img
        src={template.background}
        alt={template.name}
        className="wellness-invitation-bg"
      />

      {/* Contenido superpuesto */}
      <div className="wellness-invitation-content">
        <div className="wellness-invitation-main-bubble">

          <div className="wellness-invitation-header">
            <p className="wellness-invitation-eyebrow">Una invitación para conectar</p>
            {previewData.titulo && (
              <h2 className="wellness-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="wellness-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="wellness-invitation-details">
            {displayDateTime && (
              <div className="wellness-detail-row">
                <span className="wellness-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="wellness-detail-row">
                <span className="wellness-detail-text wellness-invitation-location">
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
