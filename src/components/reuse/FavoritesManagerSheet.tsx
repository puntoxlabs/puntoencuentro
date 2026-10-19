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
  hasDraftInProgress,
} from '@/lib/repeatEncounter';
import type { EncounterTemplateSummary, ReuseMode } from '@/types/encounterTemplates';
import { ReuseSheetShell } from './ReuseSheetShell';
import { ReuseModeChoice } from './ReuseModeChoice';
import { reuseErrorMessage } from './reuseErrors';
import './reuse.css';

interface FavoritesManagerSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Permite inyectar ítems iniciales (por ejemplo, en pruebas de renderizado). */
  initialTemplates?: EncounterTemplateSummary[];
}

/**
 * Administración de favoritos en «Mi espacio»: listar, usar (con elección de modalidad
 * "solo plantilla" / "con invitados"), renombrar y eliminar. Solo cuentas permanentes.
 */
export const FavoritesManagerSheet: React.FC<FavoritesManagerSheetProps> = ({
  isOpen,
  onClose,
  initialTemplates,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isPermanent = Boolean(user && !user.is_anonymous);

  const [templates, setTemplates] = useState<EncounterTemplateSummary[]>(initialTemplates ?? []);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<EncounterTemplateSummary | null>(null);
  const [mode, setMode] = useState<ReuseMode>('template_only');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isPermanent) return;
    setLoading(true);
    setError(null);
    const res = await encounterTemplatesService.listar();
    if (res.ok && res.data) {
      setTemplates(res.data.plantillas);
    } else {
      setError(reuseErrorMessage(t, res.error));
    }
    setLoading(false);
  }, [isPermanent, t]);

  useEffect(() => {
    if (!isOpen) return;
    setSelected(null);
    setEditingId(null);
    setConfirmDeleteId(null);
    setError(null);
    if (!initialTemplates) {
      void load();
    }
  }, [isOpen, initialTemplates, load]);

  if (!isOpen || !isPermanent) return null;

  const handleUse = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    const withGuests = mode === 'template_with_guests' && selected.invitados_count > 0;
    try {
      const res = await encounterTemplatesService.getPlantilla(selected.id, withGuests);
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

  const handleRename = async (id: string) => {
    const trimmed = editingName.trim();
    if (!trimmed) {
      setError(reuseErrorMessage(t, 'invalid_template_name'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await encounterTemplatesService.renombrar(id, trimmed);
      if (!res.ok) {
        setError(reuseErrorMessage(t, res.error));
        return;
      }
      setTemplates((prev) => prev.map((p) => (p.id === id ? { ...p, nombre: trimmed } : p)));
      setEditingId(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await encounterTemplatesService.eliminar(id);
      if (!res.ok) {
        setError(reuseErrorMessage(t, res.error));
        return;
      }
      setTemplates((prev) => prev.filter((p) => p.id !== id));
      setConfirmDeleteId(null);
    } finally {
      setBusy(false);
    }
  };

  if (selected) {
    const draftWarn = hasDraftInProgress();
    return (
      <ReuseSheetShell
        title={selected.nombre}
        subtitle={t('encounter_reuse.use_subtitle')}
        closeLabel={t('encounter_reuse.close')}
        onClose={onClose}
      >
        <ReuseModeChoice
          value={mode}
          onChange={setMode}
          guestCount={selected.invitados_count}
          guestsAllowed={true}
          disabled={busy}
        />
        <p className="pe-reuse-note">{t('encounter_reuse.repeat_note')}</p>
        {draftWarn && <p className="pe-reuse-warning">{t('encounter_reuse.draft_warning')}</p>}
        {error && <p className="pe-reuse-error" role="alert">{error}</p>}
        <div className="pe-reuse-actions">
          <Button variant="outline" onClick={() => setSelected(null)} disabled={busy}>
            {t('encounter_reuse.back_btn')}
          </Button>
          <Button variant="primary" onClick={handleUse} disabled={busy}>
            {busy ? t('encounter_reuse.loading') : t('encounter_reuse.continue_btn')}
          </Button>
        </div>
      </ReuseSheetShell>
    );
  }

  return (
    <ReuseSheetShell
      title={t('encounter_reuse.favorites_title')}
      subtitle={t('encounter_reuse.favorites_subtitle')}
      closeLabel={t('encounter_reuse.close')}
      onClose={onClose}
    >
      {error && <p className="pe-reuse-error" role="alert">{error}</p>}
      {loading ? (
        <p className="pe-reuse-note">{t('encounter_reuse.loading')}</p>
      ) : templates.length === 0 ? (
        <p className="pe-reuse-note">{t('encounter_reuse.favorites_empty')}</p>
      ) : (
        <ul className="pe-fav-list">
          {templates.map((tpl) => {
            const isEditing = editingId === tpl.id;
            const isDeleting = confirmDeleteId === tpl.id;
            const modeLabel =
              tpl.date_mode === 'coordination'
                ? t('encounter_reuse.badge_coordination')
                : t('encounter_reuse.badge_fixed');
            return (
              <li key={tpl.id} className="pe-fav-item">
                {isEditing ? (
                  <div className="pe-reuse-field">
                    <input
                      className="pe-reuse-input"
                      type="text"
                      value={editingName}
                      maxLength={MAX_FAVORITE_NAME_LENGTH}
                      onChange={(e) => setEditingName(e.target.value)}
                      disabled={busy}
                      aria-label={t('encounter_reuse.name_label')}
                    />
                    <div className="pe-reuse-actions">
                      <Button variant="outline" size="sm" onClick={() => setEditingId(null)} disabled={busy}>
                        {t('encounter_reuse.cancel_btn')}
                      </Button>
                      <Button variant="primary" size="sm" onClick={() => handleRename(tpl.id)} disabled={busy || !editingName.trim()}>
                        {t('encounter_reuse.save_btn')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="pe-fav-name">{tpl.nombre}</span>
                    <span className="pe-fav-meta">
                      {modeLabel}
                      {tpl.invitados_count > 0 &&
                        ` · ${t('encounter_reuse.guests_badge', { count: tpl.invitados_count })}`}
                    </span>
                    {isDeleting ? (
                      <div className="pe-reuse-actions">
                        <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)} disabled={busy}>
                          {t('encounter_reuse.cancel_btn')}
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => handleDelete(tpl.id)} disabled={busy}>
                          {t('encounter_reuse.confirm_delete_btn')}
                        </Button>
                      </div>
                    ) : (
                      <div className="pe-fav-item-actions">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => {
                            setMode('template_only');
                            setSelected(tpl);
                          }}
                        >
                          {t('encounter_reuse.use_btn')}
                        </Button>
                        <button
                          type="button"
                          className="pe-fav-link-btn"
                          onClick={() => {
                            setEditingId(tpl.id);
                            setEditingName(tpl.nombre);
                          }}
                        >
                          {t('encounter_reuse.rename_btn')}
                        </button>
                        <button
                          type="button"
                          className="pe-fav-link-btn pe-fav-link-btn--danger"
                          onClick={() => setConfirmDeleteId(tpl.id)}
                        >
                          {t('encounter_reuse.delete_btn')}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </ReuseSheetShell>
  );
};
