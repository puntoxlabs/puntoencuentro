import React from 'react';
import type { InboxNotificationItem } from '../../types/notifications';
import { formatRelativeTime } from '../../lib/formatRelativeTime';

interface NotificationItemProps {
  item: InboxNotificationItem;
  onSelect: (item: InboxNotificationItem) => void;
}

export const NotificationItem: React.FC<NotificationItemProps> = ({ item, onSelect }) => {
  const isUnread = !item.isRead;
  const timeFormatted = formatRelativeTime(item.createdAt);

  const handleClick = () => {
    onSelect(item);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(item);
    }
  };

  return (
    <li className="pe-notifications-list-item">
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={`pe-notification-card ${isUnread ? 'pe-notification-card--unread' : 'pe-notification-card--read'}`}
        aria-label={`${isUnread ? 'No leída: ' : ''}${item.title}. ${item.body}`}
      >
        {isUnread ? (
          <span className="pe-notification-unread-dot" aria-hidden="true" />
        ) : (
          <span className="pe-notification-read-spacer" aria-hidden="true" />
        )}

        <div className="pe-notification-content">
          <div className="pe-notification-title-row">
            <h4 className="pe-notification-title">{item.title}</h4>
            {timeFormatted && (
              <span className="pe-notification-time">{timeFormatted}</span>
            )}
          </div>
          {item.body && (
            <p className="pe-notification-body">{item.body}</p>
          )}
        </div>
      </div>
    </li>
  );
};
