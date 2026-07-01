import React from 'react';
import { kidsBirthdayTemplates } from '@/lib/kidsBirthdayTemplates';
import { Calendar, MapPin } from 'lucide-react';
import { formatKidsBirthdayDateTime } from '@/lib/formatDate';
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
  confirmationText,
  isReadOnly = false,
}) => {
  const template = kidsBirthdayTemplates.find((t) => t.id === templateId) || kidsBirthdayTemplates[0];

  const normalizedTitle = (childName || '').trim();
  const removeAccents = (str: string) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const hasCumpleWord = removeAccents(normalizedTitle.toLowerCase()).includes('cumple');

  const displayDateTime = formatKidsBirthdayDateTime(date, time);

  return (
    <div className={`kids-invitation-container theme-${template.id}`}>
      <img src={template.background} alt="Background" className="kids-invitation-bg" />
      
      <div className="kids-invitation-content">
        <div className="kids-invitation-header">
          <p className="kids-invitation-eyebrow">¡Estás invitado/a!</p>
          {!hasCumpleWord && <p className="kids-invitation-sub-eyebrow">Al cumpleaños de</p>}
          <div className="kids-invitation-name-wrapper">
            {normalizedTitle && <h1 className="kids-invitation-name">{normalizedTitle}</h1>}
            {age && <span className="kids-invitation-age">{age}</span>}
          </div>
        </div>

        <div className="kids-invitation-center-block">
          <div className="kids-invitation-details">
            {displayDateTime && (
              <div className="kids-detail-row">
                <div className="kids-detail-icon"><Calendar size={18} /></div>
                <span className="kids-detail-text">{displayDateTime}</span>
              </div>
            )}
            {location && (
              <div className="kids-detail-row">
                <div className="kids-detail-icon"><MapPin size={18} /></div>
                <span className="kids-detail-text">{location}</span>
              </div>
            )}
          </div>

          {hostMessage && (
            <div className="kids-invitation-message">
              <p className="kids-message-text">{hostMessage}</p>
            </div>
          )}

          {confirmationText && (
            <div className="kids-invitation-action">
              <button className="kids-action-button" disabled={isReadOnly}>
                {confirmationText}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

