import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { internalInvitationsService } from '@/services/internalInvitationsService';
import { sendConfirmedInvitations } from '@/lib/repeatEncounter';
import { useContactsStore } from '@/store/contactsStore';
import { getPendingGuestsFor, useRepeatEncounterStore } from '@/store/repeatEncounterStore';
import './reuse.css';

interface PendingGuestsReviewProps {
  encuentroId: string;
  onSent?: () => void;
  onOpenContacts?: () => void;
}

/**
 * Confirmación expresa antes de enviar invitaciones recuperadas al encuentro recién creado.
 * Nunca envía nada al montar: el organizador puede quitar personas, sumar contactos desde
 * su agenda, omitir o confirmar.
 * Reutiliza `internalInvitationsService.enviarInvitacion` (`enviar_invitacion_interna_seguro`).
 */
export const PendingGuestsReview: React.FC<PendingGuestsReviewProps> = ({
  encuentroId,
  onSent,
  onOpenContacts,
}) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const storeState = useRepeatEncounterStore();
  const effectiveState = storeState.sessionToken ? storeState : useRepeatEncounterStore.getState();
  const removeGuest = useRepeatEncounterStore((s) => s.removeGuest);
  const clearGuests = useRepeatEncounterStore((s) => s.clearGuests);
  const contacts = useContactsStore((s) => s.contacts);

  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const contactByEmail = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contacts) {
      map.set(c.email.trim().toLowerCase(), c.nombre);
    }
    return map;
  }, [contacts]);

  const emails = getPendingGuestsFor(effectiveState, encuentroId, user?.id);

  if (emails.length === 0 && !feedback) return null;

  const handleConfirmSend = async () => {
    if (sending || emails.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const res = await sendConfirmedInvitations(
        encuentroId,
        emails,
        (id, email) => internalInvitationsService.enviarInvitacion(id, email),
        (doneEmail) => removeGuest(doneEmail)
      );
      if (res.stoppedEarly) {
        setError(t('encounter_reuse.errors.rate_limit_exceeded'));
      } else if (res.failed.length > 0) {
        setError(t('encounter_reuse.pending_guests_partial'));
      } else {
        clearGuests();
        setFeedback(
          t('encounter_reuse.pending_guests_sent', {
            count: res.sent.length + res.alreadyInvited.length,
          })
        );
      }
      onSent?.();
    } finally {
      setSending(false);
    }
  };

  if (feedback && emails.length === 0) {
    return <p className="pe-reuse-success" role="status">{feedback}</p>;
  }

  return (
    <div className="pe-pending-guests" role="region" aria-label={t('encounter_reuse.pending_guests_title')}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <h5 className="pe-pending-guests-title">
          {t('encounter_reuse.pending_guests_title', { count: emails.length })}
        </h5>
        {onOpenContacts && (
          <button
            type="button"
            className="pe-fav-link-btn"
            disabled={sending}
            onClick={onOpenContacts}
            data-testid="pending-guests-add-contacts-btn"
          >
            <UserPlus size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            {t('contacts.add_from_contacts_btn')}
          </button>
        )}
      </div>
      <p className="pe-reuse-note">{t('encounter_reuse.pending_guests_subtitle')}</p>

      <ul className="pe-pending-guests-list">
        {emails.map((email) => {
          const contactName = contactByEmail.get(email);
          return (
            <li key={email} className="pe-pending-guests-item">
              <span>{contactName ? `${contactName} (${email})` : email}</span>
              <button
                type="button"
                className="pe-pending-guests-remove"
                disabled={sending}
                onClick={() => removeGuest(email)}
                aria-label={`${t('encounter_reuse.remove_guest')} ${email}`}
              >
                <X size={14} />
              </button>
            </li>
          );
        })}
      </ul>

      {error && <p className="pe-reuse-error" role="alert">{error}</p>}

      <div className="pe-reuse-actions">
        <Button variant="outline" size="sm" onClick={clearGuests} disabled={sending}>
          {t('encounter_reuse.pending_guests_skip')}
        </Button>
        <Button variant="primary" size="sm" onClick={handleConfirmSend} disabled={sending}>
          {sending
            ? t('encounter_reuse.sending_guests')
            : t('encounter_reuse.pending_guests_confirm', { count: emails.length })}
        </Button>
      </div>
    </div>
  );
};
