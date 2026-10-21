import React, { useState, useRef, useEffect } from 'react';
import { CalendarPlus, Download, ExternalLink, Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  canAddToCalendar,
  generateIcsContent,
  buildGoogleCalendarUrl,
  downloadIcsFile,
  type CalendarEncounterData,
  type CalendarReminderOption,
  DEFAULT_REMINDER_OPTION,
} from '@/lib/calendarExport';
import './AddToCalendarButton.css';

export interface AddToCalendarButtonProps {
  encuentro?: Partial<CalendarEncounterData> | null;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
  size?: 'sm' | 'md';
  className?: string;
  style?: React.CSSProperties;
}

export const AddToCalendarButton: React.FC<AddToCalendarButtonProps> = ({
  encuentro,
  variant = 'outline',
  size = 'md',
  className = '',
  style,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [reminder, setReminder] = useState<CalendarReminderOption>(DEFAULT_REMINDER_OPTION);
  const containerRef = useRef<HTMLDivElement>(null);

  // Cerrar al hacer click fuera
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  if (!canAddToCalendar(encuentro)) {
    return null;
  }

  const validEncounter = encuentro as CalendarEncounterData;

  const handleDownloadIcs = () => {
    try {
      const ics = generateIcsContent(validEncounter, reminder);
      const safeTitle = (validEncounter.titulo || 'encuentro')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .slice(0, 30);
      downloadIcsFile(`puntoencuentro_${safeTitle}.ics`, ics);
    } catch (err) {
      console.error('[AddToCalendarButton] Error al exportar calendario:', err);
    } finally {
      setIsOpen(false);
    }
  };

  const handleOpenGoogle = () => {
    const url = buildGoogleCalendarUrl(validEncounter);
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    setIsOpen(false);
  };

  const buttonClasses = [
    'pe-add-calendar-btn',
    `pe-add-calendar-btn--${variant}`,
    `pe-add-calendar-btn--${size}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="pe-add-calendar-container" ref={containerRef} style={style}>
      <button
        type="button"
        className={buttonClasses}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="true"
        title={t('calendar.add_to_calendar', 'Agregar al calendario')}
      >
        <CalendarPlus size={size === 'sm' ? 15 : 18} aria-hidden="true" />
        <span>{t('calendar.add_to_calendar', 'Agregar al calendario')}</span>
      </button>

      {isOpen && (
        <div className="pe-add-calendar-menu" role="menu">
          <div className="pe-add-calendar-reminder-section">
            <label htmlFor="pe-calendar-reminder-select" className="pe-add-calendar-reminder-label">
              <Bell size={12} aria-hidden="true" />
              <span>{t('calendar.reminder_label', 'Aviso previo (.ics)')}</span>
            </label>
            <select
              id="pe-calendar-reminder-select"
              className="pe-add-calendar-reminder-select"
              value={reminder}
              onChange={(e) => setReminder(e.target.value as CalendarReminderOption)}
              aria-label={t('calendar.reminder_label', 'Aviso previo (.ics)')}
            >
              <option value="30m">{t('calendar.reminder_30m', '30 minutos antes (predeterminado)')}</option>
              <option value="10m">{t('calendar.reminder_10m', '10 minutos antes')}</option>
              <option value="1h">{t('calendar.reminder_1h', '1 hora antes')}</option>
              <option value="1d">{t('calendar.reminder_1d', '1 día antes')}</option>
              <option value="none">{t('calendar.reminder_none', 'Sin recordatorio')}</option>
            </select>
          </div>

          <button
            type="button"
            className="pe-add-calendar-menu-item"
            role="menuitem"
            onClick={handleDownloadIcs}
          >
            <Download size={16} aria-hidden="true" />
            <div className="pe-add-calendar-menu-text">
              <span className="pe-add-calendar-menu-title">
                {t('calendar.download_ics', 'Descargar evento (.ics)')}
              </span>
              <span className="pe-add-calendar-menu-sub">
                Apple Calendar, Outlook, otros
              </span>
            </div>
          </button>

          <button
            type="button"
            className="pe-add-calendar-menu-item"
            role="menuitem"
            onClick={handleOpenGoogle}
          >
            <ExternalLink size={16} aria-hidden="true" />
            <div className="pe-add-calendar-menu-text">
              <span className="pe-add-calendar-menu-title">
                {t('calendar.google_calendar', 'Google Calendar')}
              </span>
              <span className="pe-add-calendar-menu-sub">
                {t('calendar.google_calendar_sub', 'Abrir en la web')}
              </span>
            </div>
          </button>
        </div>
      )}
    </div>
  );
};
