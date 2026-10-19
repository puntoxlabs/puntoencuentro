import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { ReuseSheetShell } from '@/components/reuse/ReuseSheetShell';
import { internalInvitationsService } from '@/services/internalInvitationsService';
import {
  MAX_CONTACT_NAME_LENGTH,
  defaultAliasFromEmail,
  filterContactsByQuery,
  filterSuggestionsByQuery,
  normalizeContactEmail,
  userContactsService,
} from '@/services/userContactsService';
import { sendConfirmedInvitations } from '@/lib/repeatEncounter';
import { useContactsStore } from '@/store/contactsStore';
import { getPendingGuestsFor, useRepeatEncounterStore } from '@/store/repeatEncounterStore';
import type { ContactSuggestion, UserContact } from '@/types/userContacts';
import { contactsErrorMessage } from './contactsErrors';
import './contacts.css';

interface ContactsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  encuentroId?: string;
  /** Correo preseleccionado para agendar como contacto (p. ej. desde una invitación ya enviada). */
  initialSaveEmail?: string | null;
  onInvitationsSent?: () => void;
  /** Props opcionales para pruebas de renderizado estático (SSR). */
  initialContacts?: UserContact[];
  initialSuggestions?: ContactSuggestion[];
  initialAlreadyInvited?: string[];
  initialSelectedEmails?: string[];
  initialStep?: 'list' | 'review';
}

export const ContactsSheet: React.FC<ContactsSheetProps> = ({
  isOpen,
  onClose,
  encuentroId,
  initialSaveEmail = null,
  onInvitationsSent,
  initialContacts,
  initialSuggestions,
  initialAlreadyInvited,
  initialSelectedEmails,
  initialStep = 'list',
}) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isPermanent = Boolean(user && !user.is_anonymous);

  const store = useContactsStore();
  const liveStore = store.ownerUserId ? store : useContactsStore.getState();
  const effectiveContacts = initialContacts ?? liveStore.contacts;
  const effectiveSuggestions = initialSuggestions ?? liveStore.suggestions;
  const effectiveAlreadyInvited = initialAlreadyInvited ?? liveStore.alreadyInvitedEmails;
  const selectedEmails = initialSelectedEmails ?? liveStore.selectedEmails;

  const repeatStore = useRepeatEncounterStore();
  const effectiveRepeat = repeatStore.sessionToken ? repeatStore : useRepeatEncounterStore.getState();
  const pendingRepeatGuests = getPendingGuestsFor(effectiveRepeat, encuentroId, user?.id);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [step, setStep] = useState<'list' | 'review'>(initialStep);
  const [mensaje, setMensaje] = useState('');

  // Estado del formulario de alta / edición de contacto
  const [formOpen, setFormOpen] = useState(Boolean(initialSaveEmail));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState(
    initialSaveEmail ? defaultAliasFromEmail(initialSaveEmail) : ''
  );
  const [formEmail, setFormEmail] = useState(
    initialSaveEmail ? normalizeContactEmail(initialSaveEmail) : ''
  );
  const [formFavorite, setFormFavorite] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isPermanent || !user?.id) return;
    setLoading(true);
    setError(null);
    store.ensureSession(user.id);
    const res = await userContactsService.listar(encuentroId);
    if (res.ok && res.data) {
      store.setData(user.id, res.data);
    } else {
      setError(contactsErrorMessage(t, res.error));
    }
    setLoading(false);
  }, [encuentroId, isPermanent, store, t, user?.id]);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setFeedback(null);
    setConfirmDeleteId(null);
    setStep(initialStep);
    if (initialSaveEmail) {
      setEditingId(null);
      setFormEmail(normalizeContactEmail(initialSaveEmail));
      setFormName(defaultAliasFromEmail(initialSaveEmail));
      setFormFavorite(false);
      setFormOpen(true);
    } else {
      setFormOpen(false);
      setEditingId(null);
    }
    if (!initialContacts && !initialSuggestions) {
      void load();
    }
  }, [isOpen, initialSaveEmail, initialContacts, initialSuggestions, initialStep, load]);

  const savedEmailsSet = useMemo(
    () => new Set(effectiveContacts.map((c) => normalizeContactEmail(c.email))),
    [effectiveContacts]
  );

  const alreadyInvitedSet = useMemo(
    () => new Set(effectiveAlreadyInvited.map((e) => normalizeContactEmail(e))),
    [effectiveAlreadyInvited]
  );

  const contactByEmail = useMemo(() => {
    const map = new Map<string, UserContact>();
    for (const c of effectiveContacts) {
      map.set(normalizeContactEmail(c.email), c);
    }
    return map;
  }, [effectiveContacts]);

  const filteredContacts = useMemo(
    () => filterContactsByQuery(effectiveContacts, query),
    [effectiveContacts, query]
  );

  const filteredSuggestions = useMemo(
    () => filterSuggestionsByQuery(effectiveSuggestions, savedEmailsSet, query),
    [effectiveSuggestions, savedEmailsSet, query]
  );

  if (!isOpen || !isPermanent) return null;

  const openAddForm = (prefillEmail?: string) => {
    setError(null);
    setFeedback(null);
    setEditingId(null);
    const clean = prefillEmail ? normalizeContactEmail(prefillEmail) : '';
    setFormEmail(clean);
    setFormName(clean ? defaultAliasFromEmail(clean) : '');
    setFormFavorite(false);
    setFormOpen(true);
  };

  const openEditForm = (c: UserContact) => {
    setError(null);
    setFeedback(null);
    setEditingId(c.id);
    setFormName(c.nombre);
    setFormEmail(c.email);
    setFormFavorite(c.es_favorito);
    setFormOpen(true);
  };

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const cleanName = formName.trim();
    const cleanEmail = normalizeContactEmail(formEmail);
    if (!cleanName) {
      setError(contactsErrorMessage(t, 'invalid_contact_name'));
      return;
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError(contactsErrorMessage(t, 'invalid_email'));
      return;
    }

    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await userContactsService.guardar({
        nombre: cleanName,
        email: cleanEmail,
        esFavorito: formFavorite,
        contactoId: editingId ?? undefined,
      });
      if (!res.ok || !res.data) {
        setError(contactsErrorMessage(t, res.error));
        return;
      }
      store.upsertContact(res.data.contacto);
      setFormOpen(false);
      setEditingId(null);
      setFormName('');
      setFormEmail('');
      setFormFavorite(false);
      setFeedback(t('contacts.saved_ok'));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleFavorite = async (contact: UserContact) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await userContactsService.alternarFavorito(contact.id, !contact.es_favorito);
      if (!res.ok || !res.data) {
        setError(contactsErrorMessage(t, res.error));
        return;
      }
      store.updateFavorite(res.data.id, res.data.es_favorito);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteContact = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await userContactsService.eliminar(id);
      if (!res.ok) {
        setError(contactsErrorMessage(t, res.error));
        return;
      }
      store.removeContact(id);
      setConfirmDeleteId(null);
    } finally {
      setBusy(false);
    }
  };

  const handleAddToRepeatReview = () => {
    if (!encuentroId || !user?.id || selectedEmails.length === 0) return;
    useRepeatEncounterStore
      .getState()
      .addGuestsForEncuentro(encuentroId, user.id, selectedEmails);
    store.clearSelection();
    onClose();
  };

  const handleConfirmSend = async () => {
    if (!encuentroId || busy || selectedEmails.length === 0) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    const cleanMsg = mensaje.trim() || undefined;
    try {
      const res = await sendConfirmedInvitations(
        encuentroId,
        selectedEmails,
        (id, email) => internalInvitationsService.enviarInvitacion(id, email, cleanMsg),
        (doneEmail) => {
          store.unselectEmail(doneEmail);
          useRepeatEncounterStore.getState().removeGuest(doneEmail);
        }
      );
      if (res.stoppedEarly) {
        setError(contactsErrorMessage(t, 'rate_limit_exceeded'));
      } else if (res.failed.length > 0) {
        setError(t('contacts.send_partial_error'));
      } else {
        store.clearSelection();
        setMensaje('');
        setStep('list');
        setFeedback(
          t('contacts.send_success', {
            count: res.sent.length + res.alreadyInvited.length,
          })
        );
      }
      await load();
      onInvitationsSent?.();
    } finally {
      setBusy(false);
    }
  };

  // Paso de revisión previa al envío (nunca envía sin confirmación expresa)
  if (step === 'review' && encuentroId) {
    return (
      <ReuseSheetShell
        title={t('contacts.review_title', { count: selectedEmails.length })}
        subtitle={t('contacts.review_subtitle')}
        closeLabel={t('contacts.close')}
        onClose={onClose}
      >
        {selectedEmails.length === 0 ? (
          <p className="pe-reuse-note">{t('contacts.review_empty')}</p>
        ) : (
          <ul className="pe-pending-guests-list" data-testid="contacts-review-list">
            {selectedEmails.map((email) => {
              const saved = contactByEmail.get(email);
              return (
                <li key={email} className="pe-pending-guests-item">
                  <span>
                    {saved ? `${saved.nombre} (${saved.email})` : email}
                  </span>
                  <button
                    type="button"
                    className="pe-pending-guests-remove"
                    disabled={busy}
                    onClick={() => store.unselectEmail(email)}
                    aria-label={`${t('contacts.remove_from_selection')} ${email}`}
                  >
                    <X size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="pe-reuse-field">
          <label className="pe-reuse-label" htmlFor="contacts-invite-message">
            {t('internal_invitations.message_label')}
          </label>
          <input
            id="contacts-invite-message"
            type="text"
            className="pe-reuse-input"
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value)}
            placeholder={t('internal_invitations.message_placeholder')}
            disabled={busy}
          />
        </div>

        <p className="pe-reuse-note">{t('contacts.review_explicit_note')}</p>

        {error && <p className="pe-reuse-error" role="alert">{error}</p>}

        {pendingRepeatGuests.length > 0 && selectedEmails.length > 0 && (
          <button
            type="button"
            className="pe-fav-link-btn"
            disabled={busy}
            onClick={handleAddToRepeatReview}
            data-testid="contacts-merge-with-repeat-btn"
          >
            {t('contacts.merge_with_recovered_btn', { count: selectedEmails.length })}
          </button>
        )}

        <div className="pe-reuse-actions">
          <Button variant="outline" onClick={() => setStep('list')} disabled={busy}>
            {t('contacts.back_to_list_btn')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirmSend}
            disabled={busy || selectedEmails.length === 0}
            data-testid="contacts-confirm-send-btn"
          >
            {busy
              ? t('contacts.sending_btn')
              : t('contacts.confirm_send_btn', { count: selectedEmails.length })}
          </Button>
        </div>
      </ReuseSheetShell>
    );
  }

  return (
    <ReuseSheetShell
      title={t('contacts.title')}
      subtitle={t('contacts.subtitle')}
      closeLabel={t('contacts.close')}
      onClose={onClose}
    >
      <div className="pe-contacts-toolbar">
        <input
          type="search"
          className="pe-contacts-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('contacts.search_placeholder')}
          aria-label={t('contacts.search_placeholder')}
        />
        {!formOpen && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => openAddForm()}
            data-testid="contacts-open-add-form-btn"
          >
            <UserPlus size={15} style={{ marginRight: 5 }} />
            {t('contacts.add_contact_btn')}
          </Button>
        )}
      </div>

      {formOpen && (
        <form onSubmit={handleSaveContact} className="pe-contacts-form-card" data-testid="contacts-form">
          <h4 className="pe-contacts-form-title">
            {editingId ? t('contacts.edit_form_title') : t('contacts.add_form_title')}
          </h4>
          <div className="pe-reuse-field">
            <label className="pe-reuse-label" htmlFor="contact-name-input">
              {t('contacts.name_label')}
            </label>
            <input
              id="contact-name-input"
              type="text"
              className="pe-reuse-input"
              value={formName}
              maxLength={MAX_CONTACT_NAME_LENGTH}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t('contacts.name_placeholder')}
              disabled={busy}
              required
            />
          </div>
          <div className="pe-reuse-field">
            <label className="pe-reuse-label" htmlFor="contact-email-input">
              {t('contacts.email_label')}
            </label>
            <input
              id="contact-email-input"
              type="email"
              className="pe-reuse-input"
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
              placeholder={t('contacts.email_placeholder')}
              disabled={busy}
              required
            />
          </div>
          <label className="pe-contacts-checkbox-row">
            <input
              type="checkbox"
              checked={formFavorite}
              onChange={(e) => setFormFavorite(e.target.checked)}
              disabled={busy}
            />
            <span>{t('contacts.favorite_checkbox')}</span>
          </label>
          <p className="pe-reuse-note">{t('contacts.save_does_not_invite_note')}</p>
          <div className="pe-reuse-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setFormOpen(false);
                setEditingId(null);
              }}
            >
              {t('contacts.cancel_btn')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || !formName.trim() || !formEmail.trim()}
            >
              {busy ? t('contacts.saving_btn') : t('contacts.save_btn')}
            </Button>
          </div>
        </form>
      )}

      {error && <p className="pe-reuse-error" role="alert">{error}</p>}
      {feedback && <p className="pe-reuse-success" role="status">{feedback}</p>}

      {loading ? (
        <p className="pe-reuse-note">{t('contacts.loading')}</p>
      ) : (
        <>
          {/* 1. Contactos guardados */}
          <div className="pe-contacts-section" data-testid="saved-contacts-section">
            <h4 className="pe-contacts-section-title">
              {t('contacts.saved_section_title', { count: filteredContacts.length })}
            </h4>
            {filteredContacts.length === 0 ? (
              <p className="pe-reuse-note">
                {query.trim() ? t('contacts.no_search_results') : t('contacts.empty_saved')}
              </p>
            ) : (
              <ul className="pe-contacts-list">
                {filteredContacts.map((c) => {
                  const isAlreadyInvited = alreadyInvitedSet.has(c.email);
                  const isSelected = selectedEmails.includes(c.email);
                  const isDeleting = confirmDeleteId === c.id;
                  return (
                    <li
                      key={c.id}
                      className={`pe-contacts-item ${isSelected ? 'pe-contacts-item--selected' : ''}`}
                    >
                      <div className="pe-contacts-item-main">
                        <div className="pe-contacts-item-left">
                          {encuentroId && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={isAlreadyInvited || busy}
                              onChange={() => store.toggleSelectEmail(c.email)}
                              aria-label={`${t('contacts.select_contact_aria')} ${c.nombre}`}
                            />
                          )}
                          <button
                            type="button"
                            className={`pe-contacts-star-btn ${
                              c.es_favorito ? 'pe-contacts-star-btn--active' : ''
                            }`}
                            onClick={() => handleToggleFavorite(c)}
                            disabled={busy}
                            title={
                              c.es_favorito
                                ? t('contacts.unmark_favorite')
                                : t('contacts.mark_favorite')
                            }
                            aria-label={
                              c.es_favorito
                                ? `${t('contacts.unmark_favorite')} ${c.nombre}`
                                : `${t('contacts.mark_favorite')} ${c.nombre}`
                            }
                          >
                            <Star size={16} fill={c.es_favorito ? 'currentColor' : 'none'} />
                          </button>
                          <div className="pe-contacts-item-info">
                            <div className="pe-contacts-name-row">
                              <span className="pe-contacts-name">{c.nombre}</span>
                              {c.es_favorito && (
                                <span className="pe-contacts-badge pe-contacts-badge--fav">
                                  {t('contacts.favorite_badge')}
                                </span>
                              )}
                              {isAlreadyInvited && (
                                <span className="pe-contacts-badge pe-contacts-badge--invited">
                                  {t('contacts.already_invited_badge')}
                                </span>
                              )}
                            </div>
                            <span className="pe-contacts-email">{c.email}</span>
                          </div>
                        </div>
                      </div>

                      {isDeleting ? (
                        <div className="pe-reuse-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirmDeleteId(null)}
                            disabled={busy}
                          >
                            {t('contacts.cancel_btn')}
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleDeleteContact(c.id)}
                            disabled={busy}
                          >
                            {t('contacts.confirm_delete_btn')}
                          </Button>
                        </div>
                      ) : (
                        <div className="pe-fav-item-actions">
                          <button
                            type="button"
                            className="pe-fav-link-btn"
                            onClick={() => openEditForm(c)}
                            disabled={busy}
                          >
                            {t('contacts.edit_btn')}
                          </button>
                          <button
                            type="button"
                            className="pe-fav-link-btn pe-fav-link-btn--danger"
                            onClick={() => setConfirmDeleteId(c.id)}
                            disabled={busy}
                          >
                            {t('contacts.delete_btn')}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 2. Sugerencias recientes y frecuentes del historial de invitaciones internas */}
          {filteredSuggestions.length > 0 && (
            <div className="pe-contacts-section" data-testid="suggestions-contacts-section">
              <h4 className="pe-contacts-section-title">
                {t('contacts.suggestions_section_title')}
              </h4>
              <p className="pe-reuse-note">{t('contacts.suggestions_section_note')}</p>
              <ul className="pe-contacts-list">
                {filteredSuggestions.map((sg) => {
                  const isAlreadyInvited = alreadyInvitedSet.has(sg.email);
                  const isSelected = selectedEmails.includes(sg.email);
                  return (
                    <li
                      key={sg.email}
                      className={`pe-contacts-item ${isSelected ? 'pe-contacts-item--selected' : ''}`}
                    >
                      <div className="pe-contacts-item-main">
                        <div className="pe-contacts-item-left">
                          {encuentroId && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={isAlreadyInvited || busy}
                              onChange={() => store.toggleSelectEmail(sg.email)}
                              aria-label={`${t('contacts.select_contact_aria')} ${sg.email}`}
                            />
                          )}
                          <div className="pe-contacts-item-info">
                            <div className="pe-contacts-name-row">
                              <span className="pe-contacts-name">{sg.email}</span>
                              <span className="pe-contacts-badge pe-contacts-badge--history">
                                {sg.veces_invitado > 1
                                  ? t('contacts.suggestion_frequent_badge', {
                                      count: sg.veces_invitado,
                                    })
                                  : t('contacts.suggestion_recent_badge')}
                              </span>
                              {isAlreadyInvited && (
                                <span className="pe-contacts-badge pe-contacts-badge--invited">
                                  {t('contacts.already_invited_badge')}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="pe-fav-link-btn"
                          onClick={() => openAddForm(sg.email)}
                          disabled={busy}
                        >
                          {t('contacts.save_from_history_btn')}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}

      {/* Barra inferior de selección y acceso a revisión previa al envío */}
      {encuentroId && selectedEmails.length > 0 && (
        <div className="pe-contacts-footer">
          <div className="pe-reuse-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => store.clearSelection()}
              disabled={busy}
            >
              {t('contacts.clear_selection_btn')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setStep('review')}
              disabled={busy}
              data-testid="contacts-go-to-review-btn"
            >
              {t('contacts.review_selection_btn', { count: selectedEmails.length })}
            </Button>
          </div>
        </div>
      )}
    </ReuseSheetShell>
  );
};
