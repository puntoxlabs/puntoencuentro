import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Bell, AlertCircle } from 'lucide-react';
import { useNotifications } from '../../contexts/NotificationsContext';
import { NotificationItem } from './NotificationItem';
import { validateDeepLink } from '../../lib/deepLink';
import type { InboxNotificationItem } from '../../types/notifications';
import '../ui/BottomSheet.css';
import './NotificationsSheet.css';

interface NotificationsSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NotificationsSheet: React.FC<NotificationsSheetProps> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const {
    notifications,
    loading,
    loadingMore,
    hasMore,
    error,
    unreadCount,
    marcarLeida,
    marcarTodasLeidas,
    cargarMas,
    fetchNotifications,
  } = useNotifications();

  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Escuchar tecla Escape para accesibilidad
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const timer = setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 50);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelectNotification = async (item: InboxNotificationItem) => {
    // 1. Marcar como leída de forma optimista + server-side
    if (!item.isRead) {
      void marcarLeida(item.id);
    }

    // 2. Validar deep link de manera segura
    const safeRoute = validateDeepLink(item.deepLink);
    if (safeRoute) {
      onClose();
      navigate(safeRoute);
    } else if (item.deepLink) {
      console.warn('[Notifications] Deep link rechazado por seguridad:', item.deepLink);
    }
  };

  return (
    <>
      {/* Backdrop con cierre al hacer click fuera */}
      <div
        className="pe-sheet-overlay"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Contenedor del BottomSheet */}
      <div
        className="pe-sheet-container"
        role="dialog"
        aria-modal="true"
        aria-label="Bandeja de notificaciones"
      >
        <div className="pe-sheet-handle" aria-hidden="true" />

        {/* Encabezado */}
        <header className="pe-notifications-header">
          <div className="pe-notifications-header-left">
            <h3 className="pe-notifications-title">Notificaciones</h3>
          </div>

          <div className="pe-notifications-header-actions">
            {unreadCount > 0 && (
              <button
                type="button"
                className="pe-notifications-mark-all-btn"
                onClick={() => void marcarTodasLeidas()}
                aria-label="Marcar todas las notificaciones como leídas"
              >
                Marcar todas como leídas
              </button>
            )}

            <button
              ref={closeBtnRef}
              type="button"
              className="pe-notifications-close-btn"
              onClick={onClose}
              aria-label="Cerrar notificaciones"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        {/* Contenido / Estados */}
        <div className="pe-notifications-body">
          {loading ? (
            <div className="pe-notifications-loading" role="status">
              <div className="pe-notifications-spinner" aria-hidden="true" />
              <p className="pe-notifications-empty-desc">Cargando notificaciones...</p>
            </div>
          ) : error ? (
            <div className="pe-notifications-error" role="alert">
              <div className="pe-notifications-error-icon" aria-hidden="true">
                <AlertCircle size={28} />
              </div>
              <h4 className="pe-notifications-error-title">No pudimos cargar tus notificaciones</h4>
              <p className="pe-notifications-error-desc">{error}</p>
              <button
                type="button"
                className="pe-notifications-retry-btn"
                onClick={() => void fetchNotifications(true)}
              >
                Reintentar
              </button>
            </div>
          ) : notifications.length === 0 ? (
            <div className="pe-notifications-empty">
              <div className="pe-notifications-empty-icon" aria-hidden="true">
                <Bell size={28} />
              </div>
              <h4 className="pe-notifications-empty-title">Todavía no tenés notificaciones.</h4>
              <p className="pe-notifications-empty-desc">
                Cuando haya novedades sobre tus encuentros o invitaciones, van a aparecer acá.
              </p>
            </div>
          ) : (
            <>
              <ul className="pe-notifications-list">
                {notifications.map((item) => (
                  <NotificationItem
                    key={item.id}
                    item={item}
                    onSelect={handleSelectNotification}
                  />
                ))}
              </ul>

              {hasMore && (
                <div className="pe-notifications-load-more-wrapper">
                  <button
                    type="button"
                    className="pe-notifications-load-more-btn"
                    onClick={() => void cargarMas()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Cargando más...' : 'Cargar más'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
};
