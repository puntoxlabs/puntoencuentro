import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus, Clock, CheckCircle2, XCircle, AlertCircle, Trash2, Send, BookUser, Users, ListPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { internalInvitationsService } from '@/services/internalInvitationsService';
import {
  guestListsService,
  normalizeContactEmail,
  normalizeGuestEmailList,
  userContactsService,
} from '@/services/userContactsService';
import { useContactsStore } from '@/store/contactsStore';
import type { HostInternalInvitationItem } from '@/types/internalInvitations';
import { PendingGuestsReview } from '@/components/reuse';
import { ContactsSheet } from '@/components/contacts';
import './HostInternalInvitationsSection.css';

interface HostInternalInvitationsSectionProps {
  encuentroId: string;
  isCancelado?: boolean;
  isReadOnly?: boolean;
}

export const HostInternalInvitationsSection: React.FC<HostInternalInvitationsSectionProps> = ({
  encuentroId,
  isCancelado = false,
  isReadOnly = false,
}) => {
  const { t } = useTranslation();
  const { user, signInWithGoogle } = useAuth();
  const isPermanent = Boolean(user && !user.is_anonymous);

  const [email, setEmail] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [invitaciones, setInvitaciones] = useState<HostInternalInvitationItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const [isContactsOpen, setIsContactsOpen] = useState(false);
  const [contactsInitialTab, setContactsInitialTab] = useState<'contacts' | 'lists'>('contacts');
  const [saveContactEmail, setSaveContactEmail] = useState<string | null>(null);
  const [draftListEmails, setDraftListEmails] = useState<string[] | null>(null);

  const contacts = useContactsStore((s) => s.contacts);
  const savedEmailsSet = useMemo(
    () => new Set(contacts.map((c) => normalizeContactEmail(c.email))),
    [contacts]
  );

  const savableEncounterEmails = useMemo(
    () =>
      normalizeGuestEmailList(
        invitaciones
          .filter((inv) => inv.estado === 'pendiente' || inv.estado === 'aceptada')
          .map((inv) => inv.destinatario_email)
      ),
    [invitaciones]
  );

  const loadInvitaciones = useCallback(async () => {
    if (!isPermanent || !encuentroId) return;
    try {
      setLoadingList(true);
      const res = await internalInvitationsService.getInvitacionesEncuentro(encuentroId);
      if (res.ok) {
        setInvitaciones(res.invitaciones);
      }
      if (user?.id) {
        useContactsStore.getState().ensureSession(user.id);
        const [cRes, lRes] = await Promise.all([
          userContactsService.listar(encuentroId),
          guestListsService.listar(encuentroId),
        ]);
        if (cRes.ok && cRes.data) {
          useContactsStore.getState().setData(user.id, cRes.data);
        }
        if (lRes.ok && lRes.data) {
          useContactsStore.getState().setListsData(user.id, lRes.data);
        }
      }
    } catch (err) {
      console.error('[HostInternalInvitationsSection] Error cargando invitaciones:', err);
    } finally {
      setLoadingList(false);
    }
  }, [encuentroId, isPermanent, user?.id]);

  useEffect(() => {
    loadInvitaciones();
  }, [loadInvitaciones]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail) return;

    try {
      setSending(true);
      setFeedback(null);
      const res = await internalInvitationsService.enviarInvitacion(
        encuentroId,
        cleanEmail,
        mensaje.trim() || undefined
      );

      if (res.ok) {
        setEmail('');
        setMensaje('');
        setFeedback({
          type: 'success',
          text: res.message || t('internal_invitations.send_success_neutral'),
        });
        loadInvitaciones();
      } else {
        setFeedback({
          type: 'error',
          text: res.message || res.error || 'Error al enviar invitación.',
        });
      }
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: err?.message || 'Error inesperado al enviar invitación.',
      });
    } finally {
      setSending(false);
    }
  };

  const handleCancel = async (invitationId: string) => {
    try {
      setCancellingId(invitationId);
      const res = await internalInvitationsService.cancelarInvitacion(invitationId);
      if (res.ok) {
        setFeedback({
          type: 'success',
          text: t('internal_invitations.cancel_success'),
        });
        loadInvitaciones();
      } else {
        setFeedback({
          type: 'error',
          text: res.error || 'No se pudo cancelar la invitación.',
        });
      }
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: err?.message || 'Error al cancelar la invitación.',
      });
    } finally {
      setCancellingId(null);
    }
  };

  if (isReadOnly || isCancelado) {
    return null;
  }

  return (
    <div className="dh-invite-card pe-internal-invites-card">
      <div className="pe-internal-invites-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <h4 className="pe-internal-invites-title">
            <UserPlus size={18} className="pe-internal-invites-icon" />
            {t('internal_invitations.section_title')}
          </h4>
          {isPermanent && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="pe-contacts-trigger-btn"
                onClick={() => {
                  setSaveContactEmail(null);
                  setDraftListEmails(null);
                  setContactsInitialTab('contacts');
                  setIsContactsOpen(true);
                }}
                data-testid="open-contacts-sheet-btn"
              >
                <BookUser size={15} />
                <span>{t('contacts.my_contacts_btn')}</span>
              </button>
              <button
                type="button"
                className="pe-contacts-trigger-btn"
                onClick={() => {
                  setSaveContactEmail(null);
                  setDraftListEmails(null);
                  setContactsInitialTab('lists');
                  setIsContactsOpen(true);
                }}
                data-testid="open-guest-lists-sheet-btn"
              >
                <Users size={15} />
                <span>{t('contacts.lists.add_from_list_btn')}</span>
              </button>
            </div>
          )}
        </div>
        <p className="pe-internal-invites-subtitle">
          {t('internal_invitations.section_subtitle')}
        </p>
      </div>

      {!isPermanent ? (
        <div className="pe-internal-invites-auth-nudge">
          <p className="pe-internal-invites-auth-text">
            {t('internal_invitations.login_prompt')}
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={async () => {
              const res = await signInWithGoogle();
              if (!res.ok && res.error !== 'anonymous_account_linking_pending') {
                alert('No se pudo iniciar sesión.');
              }
            }}
          >
            {t('account.continue_google')}
          </Button>
        </div>
      ) : (
        <>
          <PendingGuestsReview
            encuentroId={encuentroId}
            onSent={loadInvitaciones}
            onOpenContacts={() => {
              setSaveContactEmail(null);
              setDraftListEmails(null);
              setContactsInitialTab('contacts');
              setIsContactsOpen(true);
            }}
            onOpenLists={() => {
              setSaveContactEmail(null);
              setDraftListEmails(null);
              setContactsInitialTab('lists');
              setIsContactsOpen(true);
            }}
            onSaveAsList={(emails) => {
              setSaveContactEmail(null);
              setDraftListEmails(emails);
              setContactsInitialTab('lists');
              setIsContactsOpen(true);
            }}
          />
          <form onSubmit={handleSend} className="pe-internal-invites-form">
            <div className="pe-internal-invites-field">
              <label className="pe-internal-invites-label" htmlFor="internal-invite-email">
                {t('internal_invitations.email_label')}
              </label>
              <input
                id="internal-invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('internal_invitations.email_placeholder')}
                className="dh-add-guest-input pe-internal-invites-input"
                disabled={sending}
              />
            </div>

            <div className="pe-internal-invites-field">
              <label className="pe-internal-invites-label" htmlFor="internal-invite-msg">
                {t('internal_invitations.message_label')}
              </label>
              <input
                id="internal-invite-msg"
                type="text"
                value={mensaje}
                onChange={(e) => setMensaje(e.target.value)}
                placeholder={t('internal_invitations.message_placeholder')}
                className="dh-add-guest-input pe-internal-invites-input"
                disabled={sending}
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              disabled={sending || !email.trim()}
              className="pe-internal-invites-submit-btn"
            >
              <Send size={16} style={{ marginRight: 6 }} />
              {sending ? t('internal_invitations.sending_btn') : t('internal_invitations.send_btn')}
            </Button>
          </form>

          {feedback && (
            <div
              className={`pe-internal-invites-feedback pe-internal-invites-feedback--${feedback.type} dh-fade-in`}
              role="status"
            >
              {feedback.type === 'success' ? (
                <CheckCircle2 size={16} className="pe-feedback-icon" />
              ) : (
                <AlertCircle size={16} className="pe-feedback-icon" />
              )}
              <span>{feedback.text}</span>
            </div>
          )}

          {/* Lista de invitaciones enviadas */}
          <div className="pe-internal-invites-list-section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <h5 className="pe-internal-invites-list-title" style={{ margin: 0 }}>
                {t('internal_invitations.sent_list_title')}
                {invitaciones.length > 0 && ` (${invitaciones.length})`}
              </h5>
              {savableEncounterEmails.length >= 2 && (
                <button
                  type="button"
                  className="pe-fav-link-btn"
                  onClick={() => {
                    setSaveContactEmail(null);
                    setDraftListEmails(savableEncounterEmails);
                    setContactsInitialTab('lists');
                    setIsContactsOpen(true);
                  }}
                  data-testid="save-encounter-guests-as-list-btn"
                >
                  <ListPlus size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                  {t('contacts.lists.save_encounter_guests_btn')}
                </button>
              )}
            </div>

            {loadingList ? (
              <div className="pe-internal-invites-loading">Cargando...</div>
            ) : invitaciones.length === 0 ? (
              <p className="pe-internal-invites-empty">
                {t('internal_invitations.no_sent')}
              </p>
            ) : (
              <ul className="pe-internal-invites-list">
                {invitaciones.map((inv) => {
                  const isPending = inv.estado === 'pendiente';
                  const cleanInvEmail = normalizeContactEmail(inv.destinatario_email);
                  const isSavedContact = savedEmailsSet.has(cleanInvEmail);
                  return (
                    <li key={inv.id} className="pe-internal-invites-item">
                      <div className="pe-internal-invites-item-info">
                        <span className="pe-internal-invites-email">{inv.destinatario_email}</span>
                        {inv.mensaje && (
                          <span className="pe-internal-invites-item-msg">"{inv.mensaje}"</span>
                        )}
                      </div>

                      <div className="pe-internal-invites-item-actions">
                        <span
                          className={`pe-internal-invites-badge pe-internal-invites-badge--${inv.estado}`}
                        >
                          {inv.estado === 'pendiente' && <Clock size={12} />}
                          {inv.estado === 'aceptada' && <CheckCircle2 size={12} />}
                          {inv.estado === 'rechazada' && <XCircle size={12} />}
                          {t(`internal_invitations.status_${inv.estado}`)}
                        </span>

                        {!isSavedContact && inv.estado !== 'rechazada' && (
                          <button
                            type="button"
                            className="pe-fav-link-btn"
                            onClick={() => {
                              setSaveContactEmail(cleanInvEmail);
                              setIsContactsOpen(true);
                            }}
                            title={t('contacts.save_from_history_btn')}
                          >
                            {t('contacts.save_from_history_btn')}
                          </button>
                        )}

                        {isPending && (
                          <button
                            type="button"
                            className="pe-internal-invites-cancel-btn"
                            disabled={cancellingId === inv.id}
                            onClick={() => handleCancel(inv.id)}
                            title={t('internal_invitations.cancel_invitation_btn')}
                            aria-label={`${t('internal_invitations.cancel_invitation_btn')} a ${inv.destinatario_email}`}
                          >
                            <Trash2 size={14} />
                            <span>
                              {cancellingId === inv.id
                                ? t('internal_invitations.cancelling_btn')
                                : t('internal_invitations.cancel_invitation_btn')}
                            </span>
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <ContactsSheet
            isOpen={isContactsOpen}
            onClose={() => {
              setIsContactsOpen(false);
              setSaveContactEmail(null);
              setDraftListEmails(null);
            }}
            encuentroId={encuentroId}
            initialTab={contactsInitialTab}
            initialSaveEmail={saveContactEmail}
            initialDraftListEmails={draftListEmails}
            onInvitationsSent={loadInvitaciones}
          />
        </>
      )}
    </div>
  );
};
