import React from 'react';
import { getCelebrationTemplateConfig } from '@/lib/celebrationTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './CelebrationInvitationPreview.css';

interface CelebrationPreviewData {
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
  previewData: CelebrationPreviewData;
  className?: string;
}

export const CelebrationInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getCelebrationTemplateConfig(previewData.invitation_template);

  const isVirtual = previewData.modalidad === 'virtual';
  const locationText = isVirtual
    ? 'Virtual'
    : (previewData.lugar_texto || '');

  const displayDateTime = formatKidsBirthdayDateTime(previewData.fecha, previewData.hora);

  const cleanMessage = (previewData.descripcion || '').trim();
  const hasMessage = cleanMessage.length > 0;

  return (
    <div className={`celebration-invitation-container theme-${template.id} ${className}`}>
      {/* Imagen de fondo real — mismo patrón que kids_birthday */}
      <img
        src={template.background}
        alt={template.name}
        className="celebration-invitation-bg"
      />

      {/* Contenido superpuesto */}
      <div className="celebration-invitation-content">
        <div className="celebration-invitation-main-bubble">

          <div className="celebration-invitation-header">
            <p className="celebration-invitation-eyebrow">¡Estás invitado/a!</p>
            <p className="celebration-invitation-subtitle">A una celebración</p>
            {previewData.titulo && (
              <h2 className="celebration-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="celebration-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="celebration-invitation-details">
            {displayDateTime && (
              <div className="celebration-detail-row">
                <span className="celebration-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="celebration-detail-row">
                <span className="celebration-detail-text celebration-invitation-location">
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
