import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useNotifications } from '@/contexts/NotificationsContext';
import './CriticalCancellationModal.css';

export const CriticalCancellationModal: React.FC = () => {
  const { notifications, marcarLeida } = useNotifications();

  // Buscar la primera notificación crítica no leída de cancelación
  const criticalNotif = notifications.find(
    (n) =>
      !n.isRead &&
      (n.notificationType === 'encounter_cancelled_for_participant' ||
        n.notificationType === 'open_encounter_request_cancelled_by_host' ||
        (n.payload && (n.payload as any).priority === 'critical' && n.title.includes('cancelado')))
  );

  if (!criticalNotif) return null;

  const handleDismiss = async () => {
    await marcarLeida(criticalNotif.id);
  };

  const payload = criticalNotif.payload as any;
  const reason = payload?.cancellation_reason;

  return (
    <div className="pe-critical-modal-overlay" role="presentation">
      <div
        className="pe-critical-modal"
        role="alertdialog"
        aria-labelledby="pe-critical-modal-title"
        aria-describedby="pe-critical-modal-desc"
      >
        <div className="pe-critical-modal__icon-wrap">
          <AlertTriangle size={28} className="pe-critical-modal__icon" aria-hidden="true" />
        </div>

        <h3 id="pe-critical-modal-title" className="pe-critical-modal__title">
          {criticalNotif.title || 'Encuentro cancelado'}
        </h3>

        <p id="pe-critical-modal-desc" className="pe-critical-modal__body">
          {criticalNotif.body}
        </p>

        {reason && (
          <div className="pe-critical-modal__reason-box">
            <span className="pe-critical-modal__reason-label">Motivo informado:</span>
            <span className="pe-critical-modal__reason-text">"{reason}"</span>
          </div>
        )}

        <button
          type="button"
          className="pe-critical-modal__cta"
          onClick={handleDismiss}
          autoFocus
        >
          Entendido
        </button>
      </div>
    </div>
  );
};
