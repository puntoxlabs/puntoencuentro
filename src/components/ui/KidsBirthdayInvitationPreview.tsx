import React from 'react';
import { kidsBirthdayTemplates } from '@/lib/kidsBirthdayTemplates';
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
  
  const cleanHostMessage = hostMessage?.trim() || '';
  const hasHostMessage = cleanHostMessage.length > 0;

  if (import.meta.env.DEV) {
    console.debug('KidsBirthdayInvitationPreview props:', {
      childName: normalizedTitle,
      date,
      time,
      location,
      hostMessage,
      cleanHostMessage,
      hasHostMessage
    });
  }

  return (
    <div className={`kids-invitation-container theme-${template.id}`}>
      {import.meta.env.DEV && (
        <div className="kids-debug-render-marker">
          KIDS_PREVIEW_REAL_RENDER
        </div>
      )}
      {import.meta.env.DEV && (
        <div className="kids-debug-message">
          hostMessage: {hasHostMessage ? cleanHostMessage : 'VACIO'}
        </div>
      )}
      
      <img src={template.background} alt="Background" className="kids-invitation-bg" />
      
      <div className="kids-invitation-content">
        <div className="kids-invitation-main-bubble">
          <div className="kids-invitation-header">
            <p className="kids-invitation-eyebrow">¡Estás invitado/a!</p>
            {!hasCumpleWord && <p className="kids-invitation-subtitle">Al cumpleaños de</p>}
            <div className="kids-invitation-name-wrapper">
              {normalizedTitle && <h1 className="kids-invitation-title">{normalizedTitle}</h1>}
              {age && <span className="kids-invitation-age">{age}</span>}
            </div>
          </div>

          {hasHostMessage && (
            <div className="kids-invitation-host-message">
              {cleanHostMessage}
            </div>
          )}

          <div className="kids-invitation-details">
            {displayDateTime && (
              <div className="kids-detail-row">
                <span className="kids-detail-text">{displayDateTime}</span>
              </div>
            )}
            {location && (
              <div className="kids-detail-row">
                <span className="kids-detail-text kids-invitation-location">{location}</span>
              </div>
            )}
          </div>
        </div>

        {confirmationText && (
          <div className="kids-invitation-action">
            <button className="kids-action-button" disabled={isReadOnly}>
              {confirmationText}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

