import React from 'react';
import { getFormalTemplateConfig } from '@/lib/formalTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './FormalInvitationPreview.css';

interface FormalPreviewData {
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
  previewData: FormalPreviewData;
  className?: string;
}

export const FormalInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getFormalTemplateConfig(previewData.invitation_template);

  // Si no hay template (ej. fallback a formal base), no renderizamos este componente premium
  // Esto se maneja en el componente padre (Modal/Screen), pero por seguridad:
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
    <div className={`formal-invitation-container theme-${template.id} ${className}`}>
      {/* Imagen de fondo real */}
      <img
        src={template.background}
        alt={template.name}
        className="formal-invitation-bg"
      />

      {/* Contenido superpuesto */}
      <div className="formal-invitation-content">
        <div className="formal-invitation-main-bubble">

          <div className="formal-invitation-header">
            <p className="formal-invitation-eyebrow">Una invitación especial</p>
            {previewData.titulo && (
              <h2 className="formal-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="formal-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="formal-invitation-details">
            {displayDateTime && (
              <div className="formal-detail-row">
                <span className="formal-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="formal-detail-row">
                <span className="formal-detail-text formal-invitation-location">
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
