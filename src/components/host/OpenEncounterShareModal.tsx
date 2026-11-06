import React, { useState, useEffect } from 'react';
import { X, Share2, Copy, Check, MessageCircle, Sparkles } from 'lucide-react';
import {
  buildOpenEncounterUrl,
  buildOpenEncounterShareText,
  buildWhatsAppShareUrl,
  type OpenEncounterShareData,
} from '@/lib/shareHelper';
import './OpenEncounterShareModal.css';

export interface OpenEncounterShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  encounter: OpenEncounterShareData;
}

export const OpenEncounterShareModal: React.FC<OpenEncounterShareModalProps> = ({
  isOpen,
  onClose,
  encounter,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedText, setCopiedText] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    setCopiedLink(false);
    setCopiedText(false);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const shareUrl = buildOpenEncounterUrl(encounter.id);
  const shareText = buildOpenEncounterShareText(encounter, shareUrl);
  const whatsAppUrl = buildWhatsAppShareUrl(shareText);
  const hasNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const handleNativeShare = async () => {
    if (!hasNativeShare) return;
    try {
      await navigator.share({
        title: encounter.title,
        text: shareText,
        url: shareUrl,
      });
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('[OpenEncounterShareModal] Error en navigator.share:', err);
      }
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch {
      /* fallback */
    }
  };

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2500);
    } catch {
      /* fallback */
    }
  };

  const detailsLine = [encounter.approximateZone, encounter.dateLabel]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <div className="pe-share-modal-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="pe-share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pe-share-modal-title"
      >
        <div className="pe-share-modal__header">
          <div className="pe-share-modal__title-row">
            <div className="pe-share-modal__icon-badge">
              <Share2 size={20} aria-hidden="true" />
            </div>
            <h2 id="pe-share-modal-title" className="pe-share-modal__title">
              Difundir encuentro
            </h2>
          </div>
          <button
            type="button"
            className="pe-share-modal__close-btn"
            onClick={onClose}
            aria-label="Cerrar ventana de difusión"
          >
            <X size={18} />
          </button>
        </div>

        <p className="pe-share-modal__desc">
          Compartí esta propuesta en tus grupos, contactos o redes. Las personas interesadas podrán ver los detalles públicos y solicitar sumarse.
        </p>

        {/* Vista previa de la tarjeta que verán */}
        <div className="pe-share-preview-card" aria-label="Vista previa del contenido a compartir">
          <span className="pe-share-preview-card__badge">
            <Sparkles size={11} aria-hidden="true" />
            Encuentro abierto
          </span>
          <h3 className="pe-share-preview-card__title">{encounter.title}</h3>
          {detailsLine && (
            <div className="pe-share-preview-card__meta">{detailsLine}</div>
          )}
          {encounter.description && (
            <p className="pe-share-preview-card__desc">{encounter.description}</p>
          )}
          <span className="pe-share-preview-card__link">{shareUrl}</span>
        </div>

        {/* Botones de acción */}
        <div className="pe-share-actions">
          {hasNativeShare && (
            <button
              type="button"
              className="pe-share-btn pe-share-btn--primary"
              onClick={handleNativeShare}
            >
              <Share2 size={16} aria-hidden="true" />
              <span>Compartir en aplicaciones</span>
            </button>
          )}

          <a
            href={whatsAppUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pe-share-btn pe-share-btn--whatsapp"
            style={{ textDecoration: 'none' }}
          >
            <MessageCircle size={16} aria-hidden="true" />
            <span>Compartir por WhatsApp</span>
          </a>

          <button
            type="button"
            className={`pe-share-btn pe-share-btn--outline ${copiedLink ? 'pe-share-btn--success' : ''}`}
            onClick={handleCopyLink}
          >
            {copiedLink ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            <span>{copiedLink ? '¡Enlace copiado!' : 'Copiar enlace directo'}</span>
          </button>

          <button
            type="button"
            className={`pe-share-btn pe-share-btn--outline ${copiedText ? 'pe-share-btn--success' : ''}`}
            onClick={handleCopyText}
          >
            {copiedText ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            <span>{copiedText ? '¡Mensaje copiado!' : 'Copiar mensaje completo'}</span>
          </button>
        </div>
      </div>
    </>
  );
};
