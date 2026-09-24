import React from 'react';
import { ArrowRight, Sparkles, X } from 'lucide-react';
import './HomeDraftResumeCard.css';

interface HomeDraftResumeCardProps {
  title?: string | null;
  details?: string | null;
  onResume: () => void;
  onDiscard: () => void;
}

export const HomeDraftResumeCard: React.FC<HomeDraftResumeCardProps> = ({
  title,
  details,
  onResume,
  onDiscard,
}) => {
  const displayTitle = title?.trim() || 'Encuentro en borrador';
  const displayDetails = details?.trim() || 'Tenés un borrador sin finalizar';

  return (
    <div className="home-draft-resume-card" role="region" aria-label="Borrador en curso">
      <div className="home-draft-resume-content">
        <div className="home-draft-resume-icon">
          <Sparkles size={16} />
        </div>
        <div className="home-draft-resume-texts">
          <div className="home-draft-resume-title">{displayTitle}</div>
          <div className="home-draft-resume-subtitle">{displayDetails}</div>
        </div>
      </div>

      <div className="home-draft-resume-actions">
        <button
          type="button"
          className="home-draft-resume-btn"
          onClick={onResume}
          title="Continuar con este borrador"
        >
          <span>Continuar</span>
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          className="home-draft-discard-btn"
          onClick={onDiscard}
          title="Descartar borrador"
          aria-label="Descartar borrador"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
};
