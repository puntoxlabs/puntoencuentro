import React from 'react';
import { kidsBirthdayTemplates } from '@/lib/kidsBirthdayTemplates';
import { Calendar, MapPin, Clock } from 'lucide-react';
import './KidsBirthdayInvitationPreview.css';

interface Props {
  templateId: string | null;
  childName: string;
  age?: string;
  date: string;
  time: string;
  location: string;
  hostMessage: string;
  confirmationText?: string;
  isReadOnly?: boolean;
}

export const KidsBirthdayInvitationPreview: React.FC<Props> = ({
  templateId,
  childName,
  age,
  date,
  time,
  location,
  hostMessage,
  confirmationText = '[Confirmar asistencia]',
  isReadOnly = false,
}) => {
  const template = kidsBirthdayTemplates.find((t) => t.id === templateId) || kidsBirthdayTemplates[0];

  return (
    <div className={`kids-invitation-container theme-${template.id}`}>
      <img src={template.background} alt="Background" className="kids-invitation-bg" />
      
      <div className="kids-invitation-content">
        <div className="kids-invitation-header">
          <p className="kids-invitation-eyebrow">¡Estás invitado/a!</p>
          <p className="kids-invitation-sub-eyebrow">Al cumpleaños de</p>
          <div className="kids-invitation-name-wrapper">
            <h1 className="kids-invitation-name">{childName || '[Nombre]'}</h1>
            {age && <span className="kids-invitation-age">{age}</span>}
          </div>
        </div>

        <div className="kids-invitation-details">
          <div className="kids-detail-row">
            <div className="kids-detail-icon"><Calendar size={18} /></div>
            <span className="kids-detail-text">{date || '[Fecha]'}</span>
          </div>
          <div className="kids-detail-row">
            <div className="kids-detail-icon"><Clock size={18} /></div>
            <span className="kids-detail-text">{time || '[Hora]'}</span>
          </div>
          <div className="kids-detail-row">
            <div className="kids-detail-icon"><MapPin size={18} /></div>
            <span className="kids-detail-text">{location || '[Lugar]'}</span>
          </div>
        </div>

        {confirmationText && (
          <div className="kids-invitation-action">
            <button className="kids-action-button" disabled={isReadOnly}>
              {confirmationText}
            </button>
          </div>
        )}

        <div className="kids-invitation-message">
          <p className="kids-message-text">{hostMessage || '[Mensaje del host]'}</p>
        </div>
      </div>
    </div>
  );
};
