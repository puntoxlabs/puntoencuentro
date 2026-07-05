import React from 'react';
import { getFamilyTemplateConfig } from '@/lib/familyTemplates';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
import './FamilyInvitationPreview.css';

interface FamilyPreviewData {
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
  previewData: FamilyPreviewData;
  className?: string;
}

export const FamilyInvitationPreview: React.FC<Props> = ({ previewData, className = '' }) => {
  const template = getFamilyTemplateConfig(previewData.invitation_template);

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
    <div className={`family-invitation-container theme-${template.id} ${className}`}>
      <img
        src={template.background}
        alt={template.name}
        className="family-invitation-bg"
      />

      <div className="family-invitation-content">
        <div className="family-invitation-main-bubble">

          <div className="family-invitation-header">
            <p className="family-invitation-eyebrow">Una invitación familiar</p>
            {previewData.titulo && (
              <h2 className="family-invitation-title">{previewData.titulo}</h2>
            )}
          </div>

          {hasMessage && (
            <div className="family-invitation-message">
              {cleanMessage}
            </div>
          )}

          <div className="family-invitation-details">
            {displayDateTime && (
              <div className="family-detail-row">
                <span className="family-detail-text">{displayDateTime}</span>
              </div>
            )}
            {locationText && (
              <div className="family-detail-row">
                <span className="family-detail-text family-invitation-location">
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
