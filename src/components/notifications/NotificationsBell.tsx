import React from 'react';
import { Bell } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useNotifications } from '../../contexts/NotificationsContext';

interface NotificationsBellProps {
  className?: string;
}

export const NotificationsBell: React.FC<NotificationsBellProps> = ({ className = '' }) => {
  const { isPermanentUser } = useAuth();
  const { unreadCount, setIsOpen } = useNotifications();

  // Mostrar únicamente a cuentas permanentes (no visitantes anónimos)
  if (!isPermanentUser) {
    return null;
  }

  const badgeText = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : null;
  const ariaLabel = unreadCount > 0 ? `Notificaciones (${unreadCount} no leídas)` : 'Notificaciones';

  return (
    <button
      type="button"
      onClick={() => setIsOpen(true)}
      className={`home-header-icon-btn home-header-bell-btn ${className}`}
      aria-label={ariaLabel}
      title="Notificaciones"
    >
      <div className="home-header-bell-wrapper">
        <Bell size={20} />
        {badgeText && (
          <span className="home-header-bell-badge" aria-hidden="true">
            {badgeText}
          </span>
        )}
      </div>
    </button>
  );
};
