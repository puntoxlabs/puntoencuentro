import React from 'react';
import './CelebrationInvitationPreview.css';
import { getCelebrationTemplateConfig } from '@/lib/celebrationTemplates';
import { formatFechaHoraWhatsApp } from '@/lib/formatWhatsapp';

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
  const templateConfig = getCelebrationTemplateConfig(previewData.invitation_template);
  const isVirtual = previewData.modalidad === 'virtual';

  const { fechaStr, horaStr } = formatFechaHoraWhatsApp(previewData.fecha, previewData.hora);

  return (
    <div className={`celebration-invitation-container theme-${templateConfig.id} ${className}`}>
      {/* Background elements constructed via CSS */}
      <div className="celebration-invitation-bg-layer celebration-base"></div>
      <div className="celebration-invitation-bg-layer celebration-lights"></div>
      <div className="celebration-invitation-bg-layer celebration-particles"></div>

      {/* Main content bubble */}
      <div className="celebration-invitation-main-bubble">
        
        <div className="celebration-invitation-header">
          <p className="celebration-invitation-eyebrow">¡ESTÁS INVITADO/A!</p>
          <p className="celebration-invitation-subtitle">A una celebración</p>
          <h2 className="celebration-invitation-title">{previewData.titulo}</h2>
        </div>

        {previewData.descripcion && (
          <div className="celebration-invitation-message">
            <p>{previewData.descripcion}</p>
          </div>
        )}

        <div className="celebration-invitation-details">
          <div className="celebration-detail-row">
            <span className="celebration-detail-icon">📅</span>
            <span>
              {fechaStr} · {horaStr}
            </span>
          </div>
          
          {(previewData.lugar_texto || isVirtual) && (
            <div className="celebration-detail-row">
              <span className="celebration-detail-icon">{isVirtual ? '💻' : '📍'}</span>
              <span>{isVirtual ? 'Virtual' : previewData.lugar_texto}</span>
            </div>
          )}
        </div>

      </div>
    </div>
  );
};
