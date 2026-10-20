import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListPlus, Plus, Star, UserPlus, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { ReuseSheetShell } from '@/components/reuse/ReuseSheetShell';
import { internalInvitationsService } from '@/services/internalInvitationsService';
import {
  MAX_CONTACT_NAME_LENGTH,
  MAX_GUEST_LIST_NAME_LENGTH,
  MAX_RECIPIENTS_PER_GUEST_LIST,
  defaultAliasFromEmail,
  filterContactsByQuery,
  filterGuestListsByQuery,
  filterSuggestionsByQuery,
  guestListsService,
  isValidContactEmail,
  normalizeContactEmail,
  normalizeGuestEmailList,
  parseEmailInputBatch,
  userContactsService,
} from '@/services/userContactsService';
import { sendConfirmedInvitations } from '@/lib/repeatEncounter';
import { useContactsStore } from '@/store/contactsStore';
import { getPendingGuestsFor, useRepeatEncounterStore } from '@/store/repeatEncounterStore';
import type {
  ContactSuggestion,
  GuestList,
  GuestListSuggestion,
  UserContact,
} from '@/types/userContacts';
import { contactsErrorMessage } from './contactsErrors';
import './contacts.css';

interface ContactsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  encuentroId?: string;
  /** Pestaña inicial dentro del selector ('contacts' | 'lists'). */
  initialTab?: 'contacts' | 'lists';
  /** Correo preseleccionado para agendar como contacto (p. ej. desde una invitación ya enviada). */
  initialSaveEmail?: string | null;
  /** Correos preseleccionados para revisar y guardar como lista nueva. */
  initialDraftListEmails?: string[] | null;
  /** Nombre sugerido al abrir el formulario de nueva lista. */
  initialDraftListName?: string;
  onInvitationsSent?: () => void;
  /** Props opcionales para pruebas de renderizado estático (SSR). */
  initialContacts?: UserContact[];
  initialSuggestions?: ContactSuggestion[];
  initialLists?: GuestList[];
  initialListSuggestions?: GuestListSuggestion[];
  initialAlreadyInvited?: string[];
  initialSelectedEmails?: string[];
  initialStep?: 'list' | 'review';
  initialListFormOpen?: boolean;
}

export const ContactsSheet: React.FC<ContactsSheetProps> = ({
  isOpen,
  onClose,
  encuentroId,
  initialTab = 'contacts',
  initialSaveEmail = null,
  initialDraftListEmails = null,
  initialDraftListName = '',
  onInvitationsSent,
  initialContacts,
  initialSuggestions,
  initialLists,
  initialListSuggestions,
  initialAlreadyInvited,
  initialSelectedEmails,
  initialStep = 'list',
  initialListFormOpen = false,
}) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isPermanent = Boolean(user && !user.is_anonymous);

  const store = useContactsStore();
  const liveStore = store.ownerUserId ? store : useContactsStore.getState();
  const effectiveContacts = initialContacts ?? liveStore.contacts;
  const effectiveSuggestions = initialSuggestions ?? liveStore.suggestions;
  const effectiveLists = initialLists ?? liveStore.lists;
  const effectiveListSuggestions = initialListSuggestions ?? liveStore.listSuggestions;
  const effectiveAlreadyInvited = initialAlreadyInvited ?? liveStore.alreadyInvitedEmails;
  const selectedEmails = initialSelectedEmails ?? liveStore.selectedEmails;

  const repeatStore = useRepeatEncounterStore();
  const effectiveRepeat = repeatStore.sessionToken ? repeatStore : useRepeatEncounterStore.getState();
  const pendingRepeatGuests = getPendingGuestsFor(effectiveRepeat, encuentroId, user?.id);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'contacts' | 'lists'>(
    initialDraftListEmails && initialDraftListEmails.length > 0 ? 'lists' : initialTab
  );
  const [query, setQuery] = useState('');
  const [listQuery, setListQuery] = useState('');
  const [step, setStep] = useState<'list' | 'review'>(initialStep);
  const [mensaje, setMensaje] = useState('');
  const [reviewEmailInput, setReviewEmailInput] = useState('');

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

  // Estado del formulario de creación / edición de lista de invitados
  const [listFormOpen, setListFormOpen] = useState(
    Boolean(initialListFormOpen || (initialDraftListEmails && initialDraftListEmails.length > 0))
  );
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [listFormName, setListFormName] = useState(initialDraftListName);
  const [listFormEmails, setListFormEmails] = useState<string[]>(
    initialDraftListEmails ? normalizeGuestEmailList(initialDraftListEmails) : []
  );
  const [listEmailInput, setListEmailInput] = useState('');
  const [renamingListId, setRenamingListId] = useState<string | null>(null);
  const [renameListValue, setRenameListValue] = useState('');
  const [confirmDeleteListId, setConfirmDeleteListId] = useState<string | null>(null);

  const prevIsOpenRef = React.useRef(isOpen);

  const load = useCallback(async () => {
    if (!isPermanent || !user?.id) return;
    setLoading(true);
    setError(null);
    const s = useContactsStore.getState();
    s.ensureSession(user.id);
    const [contactsRes, listsRes] = await Promise.all([
      userContactsService.listar(encuentroId),
      guestListsService.listar(encuentroId),
    ]);
    if (contactsRes.ok && contactsRes.data) {
      s.setData(user.id, contactsRes.data);
    } else if (!contactsRes.ok) {
      setError(contactsErrorMessage(t, contactsRes.error));
    }
    if (listsRes.ok && listsRes.data) {
      s.setListsData(user.id, listsRes.data);
    } else if (!listsRes.ok && contactsRes.ok) {
      setError(contactsErrorMessage(t, listsRes.error));
    }
    setLoading(false);
  }, [encuentroId, isPermanent, t, user?.id]);

  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = isOpen;

    if (!isOpen) return;
    if (wasOpen) return;

    setError(null);
    setFeedback(null);
    setConfirmDeleteId(null);
    setConfirmDeleteListId(null);
    setRenamingListId(null);
    setStep(initialStep);

    if (initialDraftListEmails && initialDraftListEmails.length > 0) {
      setActiveTab('lists');
      setEditingListId(null);
      setListFormName(initialDraftListName || '');
      setListFormEmails(normalizeGuestEmailList(initialDraftListEmails));
      setListEmailInput('');
      setListFormOpen(true);
    } else {
      setActiveTab(initialTab);
      if (!initialListFormOpen) {
        setListFormOpen(false);
        setEditingListId(null);
      }
    }

    if (initialSaveEmail) {
      setActiveTab('contacts');
      setEditingId(null);
      setFormEmail(normalizeContactEmail(initialSaveEmail));
      setFormName(defaultAliasFromEmail(initialSaveEmail));
      setFormFavorite(false);
      setFormOpen(true);
    } else {
      setFormOpen(false);
      setEditingId(null);
    }

    if (!initialContacts && !initialSuggestions && !initialLists && !initialListSuggestions) {
      void load();
    }
  }, [
    isOpen,
    initialTab,
    initialSaveEmail,
    initialDraftListEmails,
    initialDraftListName,
    initialContacts,
    initialSuggestions,
    initialLists,
    initialListSuggestions,
    initialStep,
    initialListFormOpen,
    load,
  ]);

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

  const filteredLists = useMemo(
    () => filterGuestListsByQuery(effectiveLists, listQuery),
    [effectiveLists, listQuery]
  );

  const listFormEmailsSet = useMemo(
    () => new Set(listFormEmails.map((e) => normalizeContactEmail(e))),
    [listFormEmails]
  );

  const availableContactsForListForm = useMemo(
    () =>
      effectiveContacts.filter(
        (c) => !listFormEmailsSet.has(normalizeContactEmail(c.email))
      ),
    [effectiveContacts, listFormEmailsSet]
  );

  const availableSuggestionsForListForm = useMemo(
    () =>
      effectiveSuggestions.filter(
        (s) => !listFormEmailsSet.has(normalizeContactEmail(s.email))
      ),
    [effectiveSuggestions, listFormEmailsSet]
  );

  if (!isOpen || !isPermanent) return null;

  // ── Acciones de Contactos ──────────────────────────────────────────────────

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

  // ── Acciones de Mis listas ─────────────────────────────────────────────────

  const openCreateListForm = (prefillEmails: string[] = [], prefillName = '') => {
    setError(null);
    setFeedback(null);
    setRenamingListId(null);
    setEditingListId(null);
    setListFormName(prefillName.slice(0, MAX_GUEST_LIST_NAME_LENGTH));
    setListFormEmails(
      normalizeGuestEmailList(prefillEmails).slice(0, MAX_RECIPIENTS_PER_GUEST_LIST)
    );
    setListEmailInput('');
    setActiveTab('lists');
    setStep('list');
    setListFormOpen(true);
  };

  const openEditListForm = (list: GuestList) => {
    setError(null);
    setFeedback(null);
    setRenamingListId(null);
    setEditingListId(list.id);
    setListFormName(list.nombre);
    setListFormEmails(normalizeGuestEmailList(list.destinatarios_emails));
    setListEmailInput('');
    setListFormOpen(true);
  };

  const handleAddEmailToListForm = () => {
    setError(null);
    if (!listEmailInput.trim()) return;
    const { valid, invalid } = parseEmailInputBatch(listEmailInput);
    if (invalid.length > 0 || valid.length === 0) {
      setError(contactsErrorMessage(t, 'invalid_email'));
      return;
    }
    const merged = normalizeGuestEmailList([...listFormEmails, ...valid]);
    if (merged.length > MAX_RECIPIENTS_PER_GUEST_LIST) {
      setError(contactsErrorMessage(t, 'list_recipient_limit_reached'));
      return;
    }
    setListFormEmails(merged);
    setListEmailInput('');
  };

  const handlePickEmailForListForm = (email: string) => {
    setError(null);
    const clean = normalizeContactEmail(email);
    if (!clean) return;
    if (listFormEmailsSet.has(clean)) return;
    if (listFormEmails.length >= MAX_RECIPIENTS_PER_GUEST_LIST) {
      setError(contactsErrorMessage(t, 'list_recipient_limit_reached'));
      return;
    }
    setListFormEmails((prev) => normalizeGuestEmailList([...prev, clean]));
  };

  const handleRemoveEmailFromListForm = (email: string) => {
    const clean = normalizeContactEmail(email);
    setListFormEmails((prev) => prev.filter((e) => e !== clean));
  };

  const handleSaveList = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const cleanName = listFormName.trim();
    if (!cleanName || cleanName.length > MAX_GUEST_LIST_NAME_LENGTH) {
      setError(contactsErrorMessage(t, 'invalid_list_name'));
      return;
    }

    // Si quedó un correo escrito en el input sin presionar "Agregar correo", lo incorporamos
    let finalEmails = [...listFormEmails];
    if (listEmailInput.trim()) {
      const { valid, invalid } = parseEmailInputBatch(listEmailInput);
      if (invalid.length > 0) {
        setError(contactsErrorMessage(t, 'invalid_email'));
        return;
      }
      finalEmails = normalizeGuestEmailList([...finalEmails, ...valid]);
    } else {
      finalEmails = normalizeGuestEmailList(finalEmails);
    }

    if (finalEmails.length === 0) {
      setError(contactsErrorMessage(t, 'list_empty_recipients'));
      return;
    }
    if (finalEmails.length > MAX_RECIPIENTS_PER_GUEST_LIST) {
      setError(contactsErrorMessage(t, 'list_recipient_limit_reached'));
      return;
    }

    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await guestListsService.guardar({
        nombre: cleanName,
        emails: finalEmails,
        listaId: editingListId ?? undefined,
      });
      if (!res.ok || !res.data) {
        setError(contactsErrorMessage(t, res.error));
        return;
      }
      store.upsertList(res.data.lista);
      setListFormOpen(false);
      setEditingListId(null);
      setListFormName('');
      setListFormEmails([]);
      setListEmailInput('');
      setFeedback(t('contacts.lists.saved_ok'));
    } finally {
      setBusy(false);
    }
  };

  const handleRenameList = async (listId: string) => {
    if (busy) return;
    const cleanName = renameListValue.trim();
    if (!cleanName || cleanName.length > MAX_GUEST_LIST_NAME_LENGTH) {
      setError(contactsErrorMessage(t, 'invalid_list_name'));
      return;
    }
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await guestListsService.renombrar(listId, cleanName);
      if (!res.ok || !res.data) {
        setError(contactsErrorMessage(t, res.error));
        return;
      }
      store.upsertList(res.data.lista);
      setRenamingListId(null);
      setRenameListValue('');
      setFeedback(t('contacts.lists.renamed_ok'));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteList = async (listId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await guestListsService.eliminar(listId);
      if (!res.ok) {
        setError(contactsErrorMessage(t, res.error));
        return;
      }
      store.removeList(listId);
      setConfirmDeleteListId(null);
      setFeedback(t('contacts.lists.deleted_ok'));
    } finally {
      setBusy(false);
    }
  };

  // ── Revisión y confirmación de envío ───────────────────────────────────────

  const handleAddEmailInReview = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const clean = normalizeContactEmail(reviewEmailInput);
    if (!clean) return;
    if (!isValidContactEmail(clean)) {
      setError(contactsErrorMessage(t, 'invalid_email'));
      return;
    }
    if (alreadyInvitedSet.has(clean)) {
      setReviewEmailInput('');
      return;
    }
    store.selectEmails([clean]);
    setReviewEmailInput('');
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

        {/* Agregar correo directamente durante la revisión previa */}
        <form
          onSubmit={handleAddEmailInReview}
          className="pe-reuse-field"
          data-testid="review-add-email-form"
        >
          <label className="pe-reuse-label" htmlFor="contacts-review-add-email">
            {t('contacts.review_add_email_label')}
          </label>
          <div className="pe-contacts-inline-row">
            <input
              id="contacts-review-add-email"
              type="email"
              className="pe-reuse-input"
              value={reviewEmailInput}
              onChange={(e) => setReviewEmailInput(e.target.value)}
              placeholder={t('contacts.review_add_email_placeholder')}
              disabled={busy}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={busy || !reviewEmailInput.trim()}
            >
              <Plus size={14} style={{ marginRight: 4 }} />
              {t('contacts.review_add_email_btn')}
            </Button>
          </div>
        </form>

        {/* Identificación explícita de personas ya invitadas en este encuentro */}
        {effectiveAlreadyInvited.length > 0 && (
          <div className="pe-contacts-section" data-testid="review-already-invited-section">
            <h5 className="pe-contacts-section-title">
              {t('contacts.review_already_invited_title', {
                count: effectiveAlreadyInvited.length,
              })}
            </h5>
            <p className="pe-reuse-note">{t('contacts.review_already_invited_note')}</p>
            <div className="pe-contacts-chips-wrap">
              {effectiveAlreadyInvited.map((invEmail) => {
                const saved = contactByEmail.get(normalizeContactEmail(invEmail));
                return (
                  <span
                    key={invEmail}
                    className="pe-contacts-badge pe-contacts-badge--invited"
                  >
                    {saved ? `${saved.nombre} (${saved.email})` : invEmail} ·{' '}
                    {t('contacts.already_invited_badge')}
                  </span>
                );
              })}
            </div>
          </div>
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

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {selectedEmails.length > 0 && (
            <button
              type="button"
              className="pe-fav-link-btn"
              disabled={busy}
              onClick={() => openCreateListForm(selectedEmails)}
              data-testid="review-save-as-list-btn"
            >
              {t('contacts.lists.save_selection_as_list_btn')}
            </button>
          )}

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
        </div>

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
      title={activeTab === 'lists' ? t('contacts.lists.title') : t('contacts.title')}
      subtitle={activeTab === 'lists' ? t('contacts.lists.subtitle') : t('contacts.subtitle')}
      closeLabel={t('contacts.close')}
      onClose={onClose}
    >
      {/* Selector compacto entre Contactos frecuentes y Mis listas */}
      <div className="pe-contacts-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'contacts'}
          className={`pe-contacts-tab ${activeTab === 'contacts' ? 'pe-contacts-tab--active' : ''}`}
          onClick={() => {
            setError(null);
            setFeedback(null);
            setActiveTab('contacts');
          }}
          data-testid="contacts-tab-contacts"
        >
          <UserPlus size={14} />
          <span>
            {t('contacts.tab_contacts')} ({effectiveContacts.length})
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'lists'}
          className={`pe-contacts-tab ${activeTab === 'lists' ? 'pe-contacts-tab--active' : ''}`}
          onClick={() => {
            setError(null);
            setFeedback(null);
            setActiveTab('lists');
          }}
          data-testid="contacts-tab-lists"
        >
          <Users size={14} />
          <span>
            {t('contacts.tab_lists')} ({effectiveLists.length})
          </span>
        </button>
      </div>

      {activeTab === 'contacts' ? (
        <>
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
        </>
      ) : (
        /* ── Pestaña: Mis listas ── */
        <div data-testid="guest-lists-tab-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="pe-contacts-toolbar">
            <input
              type="search"
              className="pe-contacts-search"
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder={t('contacts.lists.search_placeholder')}
              aria-label={t('contacts.lists.search_placeholder')}
            />
            {!listFormOpen && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openCreateListForm()}
                data-testid="lists-open-create-form-btn"
              >
                <ListPlus size={15} style={{ marginRight: 5 }} />
                {t('contacts.lists.new_list_btn')}
              </Button>
            )}
          </div>

          {listFormOpen && (
            <form onSubmit={handleSaveList} className="pe-contacts-form-card" data-testid="guest-lists-form">
              <h4 className="pe-contacts-form-title">
                {editingListId ? t('contacts.lists.edit_form_title') : t('contacts.lists.create_form_title')}
              </h4>

              <div className="pe-reuse-field">
                <label className="pe-reuse-label" htmlFor="guest-list-name-input">
                  {t('contacts.lists.name_label')}
                </label>
                <input
                  id="guest-list-name-input"
                  type="text"
                  className="pe-reuse-input"
                  value={listFormName}
                  maxLength={MAX_GUEST_LIST_NAME_LENGTH}
                  onChange={(e) => setListFormName(e.target.value)}
                  placeholder={t('contacts.lists.name_placeholder')}
                  disabled={busy}
                  required
                />
              </div>

              <div className="pe-reuse-field">
                <label className="pe-reuse-label">
                  {t('contacts.lists.recipients_label', { count: listFormEmails.length })}
                </label>
                {listFormEmails.length === 0 ? (
                  <p className="pe-reuse-note">{t('contacts.lists.recipients_empty')}</p>
                ) : (
                  <div className="pe-contacts-chips-wrap" data-testid="list-form-recipients-chips">
                    {listFormEmails.map((em) => {
                      const saved = contactByEmail.get(em);
                      return (
                        <span key={em} className="pe-contacts-chip">
                          <span>{saved ? `${saved.nombre} (${em})` : em}</span>
                          <button
                            type="button"
                            className="pe-contacts-chip-remove"
                            disabled={busy}
                            onClick={() => handleRemoveEmailFromListForm(em)}
                            aria-label={`${t('contacts.remove_from_selection')} ${em}`}
                          >
                            <X size={12} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* 1. Ingresar correo explícitamente */}
                <div className="pe-contacts-inline-row" style={{ marginTop: 6 }}>
                  <input
                    type="text"
                    className="pe-reuse-input"
                    value={listEmailInput}
                    onChange={(e) => setListEmailInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddEmailToListForm();
                      }
                    }}
                    placeholder={t('contacts.lists.add_email_placeholder')}
                    disabled={busy}
                    data-testid="list-form-email-input"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddEmailToListForm}
                    disabled={busy || !listEmailInput.trim()}
                    data-testid="list-form-add-email-btn"
                  >
                    {t('contacts.lists.add_email_btn')}
                  </Button>
                </div>
              </div>

              {/* 2. Agregar desde Contactos frecuentes */}
              {availableContactsForListForm.length > 0 && (
                <div className="pe-reuse-field" data-testid="list-form-contacts-picker">
                  <span className="pe-reuse-label">{t('contacts.lists.pick_from_contacts_label')}</span>
                  <div className="pe-contacts-chips-wrap">
                    {availableContactsForListForm.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="pe-contacts-picker-chip"
                        disabled={busy}
                        onClick={() => handlePickEmailForListForm(c.email)}
                      >
                        <Plus size={12} />
                        <span>{c.nombre} ({c.email})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 3. Agregar desde sugerencias existentes */}
              {availableSuggestionsForListForm.length > 0 && (
                <div className="pe-reuse-field" data-testid="list-form-suggestions-picker">
                  <span className="pe-reuse-label">{t('contacts.lists.pick_from_suggestions_label')}</span>
                  <div className="pe-contacts-chips-wrap">
                    {availableSuggestionsForListForm.map((s) => (
                      <button
                        key={s.email}
                        type="button"
                        className="pe-contacts-picker-chip"
                        disabled={busy}
                        onClick={() => handlePickEmailForListForm(s.email)}
                      >
                        <Plus size={12} />
                        <span>{s.email}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="pe-reuse-note">{t('contacts.lists.save_does_not_invite_note')}</p>

              <div className="pe-reuse-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setListFormOpen(false);
                    setEditingListId(null);
                  }}
                >
                  {t('contacts.cancel_btn')}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={busy || !listFormName.trim()}
                  data-testid="list-form-save-btn"
                >
                  {busy ? t('contacts.saving_btn') : t('contacts.lists.save_btn')}
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
              {/* 1. Mis listas guardadas */}
              <div className="pe-contacts-section" data-testid="saved-guest-lists-section">
                <h4 className="pe-contacts-section-title">
                  {t('contacts.lists.saved_lists_title', { count: filteredLists.length })}
                </h4>
                {filteredLists.length === 0 ? (
                  <p className="pe-reuse-note">
                    {listQuery.trim()
                      ? t('contacts.lists.no_search_results')
                      : t('contacts.lists.empty_lists')}
                  </p>
                ) : (
                  <ul className="pe-contacts-list">
                    {filteredLists.map((l) => {
                      const selectableEmails = l.destinatarios_emails.filter(
                        (em) => !alreadyInvitedSet.has(em)
                      );
                      const alreadyInvitedCount =
                        l.destinatarios_emails.length - selectableEmails.length;
                      const isAllSelected =
                        selectableEmails.length > 0 &&
                        selectableEmails.every((em) => selectedEmails.includes(em));
                      const isRenaming = renamingListId === l.id;
                      const isDeleting = confirmDeleteListId === l.id;

                      return (
                        <li
                          key={l.id}
                          className={`pe-contacts-item ${
                            isAllSelected ? 'pe-contacts-item--selected' : ''
                          }`}
                          data-testid={`guest-list-item-${l.id}`}
                        >
                          <div className="pe-contacts-item-main">
                            <div className="pe-contacts-item-left">
                              <div className="pe-contacts-item-info">
                                <div className="pe-contacts-name-row">
                                  <span className="pe-contacts-name">{l.nombre}</span>
                                  <span className="pe-contacts-badge">
                                    {t('contacts.lists.recipients_badge', {
                                      count: l.destinatarios_emails.length,
                                    })}
                                  </span>
                                  {encuentroId && alreadyInvitedCount > 0 && (
                                    <span className="pe-contacts-badge pe-contacts-badge--invited">
                                      {t('contacts.lists.already_invited_count_badge', {
                                        count: alreadyInvitedCount,
                                      })}
                                    </span>
                                  )}
                                </div>
                                <div className="pe-contacts-chips-wrap" style={{ marginTop: 4 }}>
                                  {l.destinatarios_emails.map((em) => {
                                    const saved = contactByEmail.get(em);
                                    const isInv = alreadyInvitedSet.has(em);
                                    return (
                                      <span
                                        key={em}
                                        className={`pe-contacts-badge ${
                                          isInv ? 'pe-contacts-badge--invited' : ''
                                        }`}
                                      >
                                        {saved ? `${saved.nombre} (${em})` : em}
                                        {isInv ? ` · ${t('contacts.already_invited_badge')}` : ''}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>

                            {encuentroId && (
                              selectableEmails.length === 0 ? (
                                <span className="pe-contacts-badge pe-contacts-badge--invited">
                                  {t('contacts.lists.all_invited_badge')}
                                </span>
                              ) : (
                                <Button
                                  type="button"
                                  variant={isAllSelected ? 'outline' : 'primary'}
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    isAllSelected
                                      ? store.unselectList(l)
                                      : store.selectList(l)
                                  }
                                  data-testid={`select-guest-list-${l.id}`}
                                >
                                  {isAllSelected
                                    ? t('contacts.lists.selected_list_btn')
                                    : t('contacts.lists.select_list_btn')}
                                </Button>
                              )
                            )}
                          </div>

                          {isRenaming && (
                            <div className="pe-contacts-inline-row" style={{ marginTop: 6 }}>
                              <input
                                type="text"
                                className="pe-reuse-input"
                                value={renameListValue}
                                maxLength={MAX_GUEST_LIST_NAME_LENGTH}
                                onChange={(e) => setRenameListValue(e.target.value)}
                                disabled={busy}
                                aria-label={t('contacts.lists.name_label')}
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  setRenamingListId(null);
                                  setRenameListValue('');
                                }}
                              >
                                {t('contacts.cancel_btn')}
                              </Button>
                              <Button
                                type="button"
                                variant="primary"
                                size="sm"
                                disabled={busy || !renameListValue.trim()}
                                onClick={() => handleRenameList(l.id)}
                              >
                                {t('contacts.lists.save_btn')}
                              </Button>
                            </div>
                          )}

                          {isDeleting ? (
                            <div className="pe-reuse-actions">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setConfirmDeleteListId(null)}
                                disabled={busy}
                              >
                                {t('contacts.cancel_btn')}
                              </Button>
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => handleDeleteList(l.id)}
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
                                onClick={() => {
                                  setRenamingListId(l.id);
                                  setRenameListValue(l.nombre);
                                }}
                                disabled={busy}
                              >
                                {t('contacts.lists.rename_btn')}
                              </button>
                              <button
                                type="button"
                                className="pe-fav-link-btn"
                                onClick={() => openEditListForm(l)}
                                disabled={busy}
                              >
                                {t('contacts.lists.edit_members_btn')}
                              </button>
                              <button
                                type="button"
                                className="pe-fav-link-btn pe-fav-link-btn--danger"
                                onClick={() => setConfirmDeleteListId(l.id)}
                                disabled={busy}
                              >
                                {t('contacts.lists.delete_btn')}
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* 2. Conjuntos sugeridos de encuentros anteriores */}
              {effectiveListSuggestions.length > 0 && (
                <div className="pe-contacts-section" data-testid="suggested-guest-lists-section">
                  <h4 className="pe-contacts-section-title">
                    {t('contacts.lists.suggestions_title')}
                  </h4>
                  <p className="pe-reuse-note">{t('contacts.lists.suggestions_note')}</p>
                  <ul className="pe-contacts-list">
                    {effectiveListSuggestions.map((sg) => {
                      const key = sg.emails.join('|');
                      return (
                        <li key={key} className="pe-contacts-item">
                          <div className="pe-contacts-item-main">
                            <div className="pe-contacts-item-left">
                              <div className="pe-contacts-item-info">
                                <div className="pe-contacts-name-row">
                                  <span className="pe-contacts-name">
                                    {sg.nombre_sugerido
                                      ? t('contacts.lists.suggestion_from_encounter', {
                                          title: sg.nombre_sugerido,
                                        })
                                      : t('contacts.lists.recipients_badge', {
                                          count: sg.emails.length,
                                        })}
                                  </span>
                                  <span className="pe-contacts-badge pe-contacts-badge--history">
                                    {sg.veces_usado > 1
                                      ? t('contacts.lists.suggestion_reused_badge', {
                                          count: sg.veces_usado,
                                        })
                                      : t('contacts.lists.suggestion_recent_badge')}
                                  </span>
                                  <span className="pe-contacts-badge">
                                    {t('contacts.lists.recipients_badge', {
                                      count: sg.emails.length,
                                    })}
                                  </span>
                                </div>
                                <span className="pe-contacts-email">
                                  {sg.emails.join(', ')}
                                </span>
                              </div>
                            </div>

                            <button
                              type="button"
                              className="pe-fav-link-btn"
                              disabled={busy}
                              onClick={() =>
                                openCreateListForm(sg.emails, sg.nombre_sugerido)
                              }
                              data-testid="save-suggested-list-btn"
                            >
                              {t('contacts.lists.save_as_list_btn')}
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
        </div>
      )}

      {/* Barra inferior de selección: guardar selección como lista y/o revisar envío */}
      {selectedEmails.length > 0 && (
        <div className="pe-contacts-footer">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="pe-fav-link-btn"
              disabled={busy}
              onClick={() => openCreateListForm(selectedEmails)}
              data-testid="contacts-save-selection-as-list-btn"
            >
              {t('contacts.lists.save_selection_as_list_btn')}
            </button>
          </div>
          {encuentroId && (
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
          )}
        </div>
      )}
    </ReuseSheetShell>
  );
};
