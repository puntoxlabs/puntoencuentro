import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { encounterTemplatesService } from '@/services/encounterTemplatesService';
import {
  MAX_FAVORITE_NAME_LENGTH,
  applyReusablePayload,
  canApplyPayload,
  defaultFavoriteName,
  hasDraftInProgress,
} from '@/lib/repeatEncounter';
import type { ReuseMode } from '@/types/encounterTemplates';
import { ReuseSheetShell } from './ReuseSheetShell';
import { ReuseModeChoice } from './ReuseModeChoice';
import { reuseErrorMessage } from './reuseErrors';
import './reuse.css';

export type ReuseIntent = 'repeat' | 'favorite';

interface ReuseEncounterSheetProps {
  isOpen: boolean;
  intent: ReuseIntent;
  encuentroId: string;
  /** Título actual del encuentro: sugerencia para el nombre del favorito. */
  defaultTitle?: string | null;
  onClose: () => void;
}

/**
 * Repetir un encuentro propio o guardarlo como favorito.
 * Ofrece "solo plantilla" o "plantilla con invitados". No crea ni invita nada por sí mismo:
 * repetir solo precarga el wizard correspondiente; guardar usa la RPC de plantillas.
 */
export const ReuseEncounterSheet: React.FC<ReuseEncounterSheetProps> = ({
  isOpen,
  intent,
  encuentroId,
  defaultTitle,
  onClose,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isPermanent = Boolean(user && !user.is_anonymous);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [guestCount, setGuestCount] = useState(0);
  const [mode, setMode] = useState<ReuseMode>('template_only');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draftWarning, setDraftWarning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await encounterTemplatesService.getRepeticion(encuentroId, false);
    if (res.ok && res.data) {
      setGuestCount(isPermanent ? res.data.payload.invitados_count : 0);
    } else {
      setError(reuseErrorMessage(t, res.error));
    }
    setLoading(false);
  }, [encuentroId, isPermanent, t]);

  useEffect(() => {
    if (!isOpen) return;
    setMode('template_only');
    setSaved(false);
    setName(defaultFavoriteName(defaultTitle));
    setDraftWarning(intent === 'repeat' && hasDraftInProgress());
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, intent, encuentroId]);

  if (!isOpen) return null;

  const withGuests = mode === 'template_with_guests' && isPermanent && guestCount > 0;

  const handleRepeat = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Los correos solo se solicitan si el organizador eligió expresamente la modalidad con invitados
      const res = await encounterTemplatesService.getRepeticion(encuentroId, withGuests);
      if (!res.ok || !res.data) {
        setError(reuseErrorMessage(t, res.error));
        return;
      }
      if (!canApplyPayload(res.data.payload)) {
        setError(reuseErrorMessage(t, 'coordination_unavailable'));
        return;
      }
      const { route, navState } = applyReusablePayload(res.data.payload, {
        ownerUserId: user?.id ?? null,
        includeGuests: withGuests,
      });
      onClose();
      navigate(route, { state: navState });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveFavorite = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(reuseErrorMessage(t, 'invalid_template_name'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await encounterTemplatesService.guardar(encuentroId, trimmed, withGuests);
      if (!res.ok) {
        setError(reuseErrorMessage(t, res.error));
        return;
      }
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  const isRepeat = intent === 'repeat';

  return (
    <ReuseSheetShell
      title={t(isRepeat ? 'encounter_reuse.repeat_title' : 'encounter_reuse.favorite_title')}
      subtitle={t(isRepeat ? 'encounter_reuse.repeat_subtitle' : 'encounter_reuse.favorite_subtitle')}
      closeLabel={t('encounter_reuse.close')}
      onClose={onClose}
    >
      {loading ? (
        <p className="pe-reuse-note">{t('encounter_reuse.loading')}</p>
      ) : saved ? (
        <>
          <p className="pe-reuse-success" role="status">{t('encounter_reuse.saved_ok')}</p>
          <div className="pe-reuse-actions">
            <Button variant="primary" onClick={onClose}>{t('encounter_reuse.close')}</Button>
          </div>
        </>
      ) : (
        <>
          {!isRepeat && (
            <div className="pe-reuse-field">
              <label className="pe-reuse-label" htmlFor="pe-reuse-fav-name">
                {t('encounter_reuse.name_label')}
              </label>
              <input
                id="pe-reuse-fav-name"
                className="pe-reuse-input"
                type="text"
                value={name}
                maxLength={MAX_FAVORITE_NAME_LENGTH}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('encounter_reuse.name_placeholder')}
                disabled={busy}
              />
            </div>
          )}

          <ReuseModeChoice
            value={mode}
            onChange={setMode}
            guestCount={guestCount}
            guestsAllowed={isPermanent}
            disabled={busy}
          />

          <p className="pe-reuse-note">
            {t(isRepeat ? 'encounter_reuse.repeat_note' : 'encounter_reuse.favorite_note')}
          </p>

          {draftWarning && <p className="pe-reuse-warning">{t('encounter_reuse.draft_warning')}</p>}
          {error && <p className="pe-reuse-error" role="alert">{error}</p>}

          <div className="pe-reuse-actions">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t('encounter_reuse.cancel_btn')}
            </Button>
            {isRepeat ? (
              <Button variant="primary" onClick={handleRepeat} disabled={busy}>
                {busy ? t('encounter_reuse.loading') : t('encounter_reuse.continue_btn')}
              </Button>
            ) : (
              <Button variant="primary" onClick={handleSaveFavorite} disabled={busy || !name.trim()}>
                {busy ? t('encounter_reuse.saving') : t('encounter_reuse.save_btn')}
              </Button>
            )}
          </div>
        </>
      )}
    </ReuseSheetShell>
  );
};
