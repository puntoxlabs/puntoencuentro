import React from 'react';
import { getLearningTemplateConfig } from '@/lib/learningTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './LearningInvitationPreview.css';

interface LearningPreviewData {
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
  previewData: LearningPreviewData;
  className?: string;
}

export const LearningInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getLearningTemplateConfig(previewData.invitation_template);

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
    <div className={`learning-invitation-container theme-${template.id} ${className}`}>
      {/* Imagen de fondo real */}
      <img
        src={template.background}
        alt={template.name}
        className="learning-invitation-bg"
      />

      {/* Contenido superpuesto */}
      <div className="learning-invitation-content">
        <div className="learning-invitation-main-bubble">

          <div className="learning-invitation-header">
            <p className="learning-invitation-eyebrow">Una invitación para aprender</p>
            {previewData.titulo && (
              <h2 className="learning-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="learning-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="learning-invitation-details">
            {displayDateTime && (
              <div className="learning-detail-row">
                <span className="learning-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="learning-detail-row">
                <span className="learning-detail-text learning-invitation-location">
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
