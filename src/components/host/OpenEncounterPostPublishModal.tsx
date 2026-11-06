import React, { useState } from 'react';
import { Sparkles, Share2, Copy, Check, X } from 'lucide-react';
import { buildOpenEncounterUrl, type OpenEncounterShareData } from '@/lib/shareHelper';
import './OpenEncounterShareModal.css';

export interface OpenEncounterPostPublishModalProps {
  isOpen: boolean;
  onClose: () => void;
  onShare: () => void;
  encounter: OpenEncounterShareData;
}

export const OpenEncounterPostPublishModal: React.FC<OpenEncounterPostPublishModalProps> = ({
  isOpen,
  onClose,
  onShare,
  encounter,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);

  if (!isOpen) return null;

  const shareUrl = buildOpenEncounterUrl(encounter.id);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch {
      /* fallback */
    }
  };

  return (
    <>
      <div className="pe-share-modal-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="pe-share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pe-post-publish-title"
        style={{ maxWidth: '440px' }}
      >
        <div className="pe-share-modal__header">
          <div className="pe-share-modal__title-row">
            <div className="pe-share-modal__icon-badge" style={{ background: '#ecfdf5', color: '#059669' }}>
              <Sparkles size={20} aria-hidden="true" />
            </div>
            <h2 id="pe-post-publish-title" className="pe-share-modal__title">
              ¡Tu encuentro ya está abierto!
            </h2>
          </div>
          <button
            type="button"
            className="pe-share-modal__close-btn"
            onClick={onClose}
            aria-label="Cerrar aviso"
          >
            <X size={18} />
          </button>
        </div>

        <p className="pe-share-modal__desc">
          Ahora otras personas pueden encontrarlo en <strong>Me sumo</strong>. ¿Querés llegar a más gente? Compartí esta propuesta con tus contactos, otros grupos o en tus redes.
        </p>

        <div className="pe-share-actions">
          <button
            type="button"
            className="pe-share-btn pe-share-btn--primary"
            onClick={() => {
              onClose();
              onShare();
            }}
          >
            <Share2 size={16} aria-hidden="true" />
            <span>Compartir encuentro</span>
          </button>

          <button
            type="button"
            className={`pe-share-btn pe-share-btn--outline ${copiedLink ? 'pe-share-btn--success' : ''}`}
            onClick={handleCopyLink}
          >
            {copiedLink ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            <span>{copiedLink ? '¡Enlace copiado!' : 'Copiar enlace'}</span>
          </button>

          <button
            type="button"
            className="pe-share-btn pe-share-btn--outline"
            style={{ border: 'none', color: '#64748b' }}
            onClick={onClose}
          >
            Ahora no
          </button>
        </div>
      </div>
    </>
  );
};
