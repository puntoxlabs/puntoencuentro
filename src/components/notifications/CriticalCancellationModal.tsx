import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNotifications } from '../../contexts/NotificationsContext';
import './CriticalCancellationModal.css';

export const CriticalCancellationModal: React.FC = () => {
  const { t } = useTranslation();
  const { notifications, marcarLeida } = useNotifications();
  const [isDismissing, setIsDismissing] = React.useState(false);
  const [dismissError, setDismissError] = React.useState<string | null>(null);

  // Buscar la primera notificación crítica no leída (cancelaciones, reprogramaciones o logística para confirmados)
  const criticalNotif = notifications.find(
    (n) =>
      !n.isRead &&
      (n.notificationType === 'encounter_cancelled_for_participant' ||
        n.notificationType === 'open_encounter_request_cancelled_by_host' ||
        (n.notificationType === 'encounter_schedule_changed' && !(n.payload as any)?.is_applicant) ||
        (n.notificationType === 'encounter_logistics_changed' && !(n.payload as any)?.is_applicant) ||
        (n.payload && (n.payload as any).priority === 'critical' && !(n.payload as any)?.is_applicant))
  );

  // Limpiar errores previos si cambia la notificación seleccionada
  React.useEffect(() => {
    setDismissError(null);
    setIsDismissing(false);
  }, [criticalNotif?.id]);

  if (!criticalNotif) return null;

  const handleDismiss = async () => {
    if (isDismissing) return;
    setIsDismissing(true);
    setDismissError(null);
    try {
      const ok = await marcarLeida(criticalNotif.id);
      if (!ok) {
        setDismissError(t('critical_modal.error_dismiss', 'No se pudo confirmar la lectura. Por favor, reintentá.'));
      }
    } catch {
      setDismissError(t('critical_modal.error_network', 'Error de conexión al confirmar la lectura.'));
    } finally {
      setIsDismissing(false);
    }
  };

  const payload = (criticalNotif.payload || {}) as Record<string, any>;
  const notifType = criticalNotif.notificationType;
  const changeType = payload.change_type;

  // 1. Cancelación de encuentro
  const isCancellation =
    notifType === 'encounter_cancelled_for_participant' ||
    notifType === 'open_encounter_request_cancelled_by_host' ||
    changeType === 'cancellation';

  // 2. Reprogramación de fecha u horario
  const isScheduleChange =
    !isCancellation &&
    (notifType === 'encounter_schedule_changed' || changeType === 'schedule');

  // 3. Modificación de logística (ubicación o acceso)
  const isLogisticsChange =
    !isCancellation &&
    !isScheduleChange &&
    (notifType === 'encounter_logistics_changed' || changeType === 'logistics');

  // 4. Otro aviso crítico reconocido
  const isOtherCritical = !isCancellation && !isScheduleChange && !isLogisticsChange;

  // Detección estricta de título (nunca mostrar 'Encuentro cancelado' si no es cancelación real)
  let modalTitle = t('critical_modal.cancellation_title', 'Encuentro cancelado');
  if (isScheduleChange) {
    modalTitle = t('critical_modal.schedule_title', 'Cambio de fecha u horario');
  } else if (isLogisticsChange) {
    modalTitle = t('critical_modal.logistics_title', 'Cambio de ubicación o acceso');
  } else if (isOtherCritical) {
    modalTitle = t('critical_modal.generic_critical_title', 'Aviso importante');
  }

  // Motivo informado: exclusivamente cuando corresponde a una cancelación
  const reason = isCancellation ? payload.cancellation_reason : null;

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
          {modalTitle}
        </h3>

        {payload?.title && (
          <div className="pe-critical-modal__encounter-name">
            {payload.title}
          </div>
        )}

        {(payload?.original_date_label || payload?.date_label) && (
          <div className="pe-critical-modal__datetime-label">
            {payload?.date_label || payload?.original_date_label}
          </div>
        )}

        <p id="pe-critical-modal-desc" className="pe-critical-modal__body">
          {criticalNotif.body}
        </p>

        {reason && (
          <div className="pe-critical-modal__reason-box">
            <span className="pe-critical-modal__reason-label">{t('critical_modal.reason_label', 'Motivo informado:')}</span>
            <span className="pe-critical-modal__reason-text">"{reason}"</span>
          </div>
        )}

        {dismissError && (
          <div
            className="pe-critical-modal__error-msg"
            role="alert"
            style={{ color: '#ef4444', fontSize: '0.875rem', marginBottom: '0.75rem', textAlign: 'center' }}
          >
            {dismissError}
          </div>
        )}

        <button
          type="button"
          className="pe-critical-modal__cta"
          onClick={handleDismiss}
          disabled={isDismissing}
          autoFocus
        >
          {isDismissing ? t('critical_modal.confirming', 'Confirmando...') : t('critical_modal.dismiss', 'Entendido')}
        </button>
      </div>
    </div>
  );
};
