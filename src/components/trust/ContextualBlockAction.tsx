import React, { useState, useEffect, useCallback } from 'react';
import { Ban, ShieldCheck } from 'lucide-react';
import { trustService } from '@/services/trustService';
import { ContextualBlockModal } from './ContextualBlockModal';
import './ContextualBlockAction.css';

export interface ContextualBlockActionProps {
  solicitudId: string;
  applicantName?: string;
  variant?: 'button' | 'compact' | 'link';
  className?: string;
  initialBlocked?: boolean;
  onBlockStateChange?: (blockedByMe: boolean) => void;
}

export const ContextualBlockAction: React.FC<ContextualBlockActionProps> = ({
  solicitudId,
  applicantName,
  variant = 'compact',
  className = '',
  initialBlocked,
  onBlockStateChange,
}) => {
  const [blockedByMe, setBlockedByMe] = useState<boolean | null>(
    initialBlocked !== undefined ? initialBlocked : null
  );
  const [loading, setLoading] = useState(initialBlocked === undefined);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    if (!solicitudId) {
      setBlockedByMe(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const res = await trustService.getEstadoBloqueoDesdeSolicitud(solicitudId);
      if (res.ok) {
        setBlockedByMe(res.blockedByMe);
      } else {
        // Fail-soft: no asumir false ni true ante error
        setBlockedByMe(null);
      }
    } catch {
      setBlockedByMe(null);
    } finally {
      setLoading(false);
    }
  }, [solicitudId]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // Si loading o falló la consulta, ocultar temporalmente para evitar estados falsos
  if (loading || blockedByMe === null) {
    return null;
  }

  const handleSuccess = (newBlockedState: boolean) => {
    setBlockedByMe(newBlockedState);
    onBlockStateChange?.(newBlockedState);
    setFeedbackMessage(newBlockedState ? 'Persona bloqueada.' : 'Bloqueo eliminado.');
    setTimeout(() => {
      setFeedbackMessage(null);
    }, 3000);
  };

  const actionLabel = blockedByMe ? 'Desbloquear' : 'Bloquear';
  const ariaLabel = applicantName
    ? `${actionLabel} a ${applicantName}`
    : `${actionLabel} a esta persona`;

  return (
    <div className={`pe-contextual-block-action ${className}`}>
      <button
        type="button"
        className={`pe-contextual-block-action__btn pe-contextual-block-action__btn--${variant} ${
          blockedByMe
            ? 'pe-contextual-block-action__btn--unblock'
            : 'pe-contextual-block-action__btn--block'
        }`}
        onClick={() => setIsModalOpen(true)}
        aria-label={ariaLabel}
        title={actionLabel}
      >
        {blockedByMe ? <ShieldCheck size={14} /> : <Ban size={14} />}
        <span>{actionLabel}</span>
      </button>

      {feedbackMessage && (
        <span className="pe-contextual-block-action__feedback" role="status">
          {feedbackMessage}
        </span>
      )}

      {isModalOpen && (
        <ContextualBlockModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          solicitudId={solicitudId}
          isBlocked={blockedByMe}
          targetName={applicantName}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
};
