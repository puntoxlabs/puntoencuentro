import React, { useState, useEffect } from 'react';
import { Moon, ShieldCheck, Check, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import {
  type QuietHoursPreference,
  sanitizeQuietHoursPreference,
} from '@/lib/quietHours';
import { userPreferencesService } from '@/services/userPreferencesService';
import './QuietHoursSettings.css';

export interface QuietHoursSettingsProps {
  onPreferenceChange?: (pref: QuietHoursPreference) => void;
}

export const QuietHoursSettings: React.FC<QuietHoursSettingsProps> = ({ onPreferenceChange }) => {
  const { t } = useTranslation();
  const { user, isPermanentUser } = useAuth();

  const [preference, setPreference] = useState<QuietHoursPreference>(() =>
    userPreferencesService.resolveInitialQuietHours(user?.user_metadata, user?.id)
  );
  const [saving, setSaving] = useState(false);
  const [showSavedFeedback, setShowSavedFeedback] = useState(false);

  useEffect(() => {
    if (user) {
      const resolved = userPreferencesService.resolveInitialQuietHours(user.user_metadata, user.id);
      setPreference(resolved);
    }
  }, [user]);

  const handleToggleEnabled = async () => {
    const nextPref: QuietHoursPreference = {
      ...preference,
      enabled: !preference.enabled,
    };
    setPreference(nextPref);
    await persist(nextPref);
  };

  const handleChangeTime = (field: 'startTime' | 'endTime', value: string) => {
    const nextPref: QuietHoursPreference = sanitizeQuietHoursPreference({
      ...preference,
      [field]: value,
    });
    setPreference(nextPref);
  };

  const handleBlurTime = async () => {
    await persist(preference);
  };

  const persist = async (prefToSave: QuietHoursPreference) => {
    setSaving(true);
    try {
      const res = await userPreferencesService.saveQuietHours(
        prefToSave,
        user?.id,
        Boolean(isPermanentUser)
      );
      if (res.ok) {
        setShowSavedFeedback(true);
        onPreferenceChange?.(res.data);
        setTimeout(() => setShowSavedFeedback(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pe-quiet-hours" aria-label={t('avisame.quiet_hours_title', 'Horarios silenciosos')}>
      <div className="pe-quiet-hours__header">
        <div className="pe-quiet-hours__title-group">
          <Moon size={16} className="pe-quiet-hours__icon" aria-hidden="true" />
          <div>
            <h4 className="pe-quiet-hours__title">
              {t('avisame.quiet_hours_title', 'Horarios silenciosos')}
            </h4>
            <p className="pe-quiet-hours__subtitle">
              {t(
                'avisame.quiet_hours_desc',
                'Pausá los avisos de nuevos encuentros y alertas mientras descansás.'
              )}
            </p>
          </div>
        </div>

        <label className="pe-quiet-hours__switch">
          <input
            type="checkbox"
            checked={preference.enabled}
            onChange={handleToggleEnabled}
            disabled={saving}
            aria-label={t('avisame.quiet_hours_enable', 'Activar horarios silenciosos')}
          />
          <span className="pe-quiet-hours__slider" />
        </label>
      </div>

      {preference.enabled && (
        <div className="pe-quiet-hours__body">
          <div className="pe-quiet-hours__times">
            <div className="pe-quiet-hours__time-field">
              <label htmlFor="quiet-hours-start" className="pe-quiet-hours__time-label">
                <Clock size={13} aria-hidden="true" />
                <span>{t('avisame.quiet_hours_from', 'Silenciar desde')}</span>
              </label>
              <input
                id="quiet-hours-start"
                type="time"
                value={preference.startTime}
                onChange={(e) => handleChangeTime('startTime', e.target.value)}
                onBlur={handleBlurTime}
                className="pe-quiet-hours__time-input"
              />
            </div>

            <div className="pe-quiet-hours__time-field">
              <label htmlFor="quiet-hours-end" className="pe-quiet-hours__time-label">
                <Clock size={13} aria-hidden="true" />
                <span>{t('avisame.quiet_hours_to', 'Hasta')}</span>
              </label>
              <input
                id="quiet-hours-end"
                type="time"
                value={preference.endTime}
                onChange={(e) => handleChangeTime('endTime', e.target.value)}
                onBlur={handleBlurTime}
                className="pe-quiet-hours__time-input"
              />
            </div>
          </div>

          <div className="pe-quiet-hours__notice">
            <ShieldCheck size={14} className="pe-quiet-hours__notice-icon" aria-hidden="true" />
            <p className="pe-quiet-hours__notice-text">
              {t(
                'avisame.quiet_hours_critical_notice',
                'Las cancelaciones y cambios urgentes nunca se bloquean.'
              )}
            </p>
          </div>

          {showSavedFeedback && (
            <p className="pe-quiet-hours__saved">
              <Check size={12} aria-hidden="true" />
              <span>{t('avisame.quiet_hours_saved', 'Preferencias guardadas.')}</span>
            </p>
          )}

          {!isPermanentUser && (
            <p className="pe-quiet-hours__anon-hint">
              {t(
                'avisame.quiet_hours_login_hint',
                'Iniciá sesión para sincronizar tus horarios silenciosos en todos tus dispositivos.'
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
