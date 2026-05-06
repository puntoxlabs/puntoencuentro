import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, MessageSquareText } from 'lucide-react';
import { Button } from './Button';

interface OrganizerMessageSheetProps {
  isOpen: boolean;
  onClose: () => void;
  initialMessage: string;
  onSave: (message: string) => void;
}

export const OrganizerMessageSheet: React.FC<OrganizerMessageSheetProps> = ({
  isOpen,
  onClose,
  initialMessage,
  onSave
}) => {
  const { t } = useTranslation();
  const [message, setMessage] = useState(initialMessage);

  useEffect(() => {
    if (isOpen) {
      setMessage(initialMessage);
    }
  }, [isOpen, initialMessage]);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave(message.trim());
    onClose();
  };

  const charCount = message.length;
  const isOverLimit = charCount > 250;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0, 0, 0, 0.4)', zIndex: 999,
          backdropFilter: 'blur(2px)',
        }}
      />

      {/* Bottom Sheet */}
      <div
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0,
          margin: '0 auto', width: '100%', maxWidth: 520,
          background: '#fff', zIndex: 1000,
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          padding: '24px 20px 30px 20px',
          maxHeight: '85vh', overflowY: 'auto',
          boxShadow: '0 -4px 24px rgba(0,0,0,0.2)',
          display: 'flex', flexDirection: 'column',
          animation: 'slideUpOrganize 0.25s cubic-bezier(0.25, 0.8, 0.25, 1) forwards',
        }}
      >
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes slideUpOrganize {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
        `}} />

        <div style={{
          width: 40, height: 4, background: 'rgba(0,0,0,0.1)',
          borderRadius: 2, alignSelf: 'center', marginBottom: 20
        }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <MessageSquareText size={20} color="var(--color-primary)" />
            <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--color-on-surface)', margin: 0 }}>
              {t('invitation.custom_message_title', 'Mensaje del organizador')}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'var(--color-surface-variant)', border: 'none',
              borderRadius: '50%', width: 32, height: 32,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--color-on-surface)'
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ marginBottom: 20 }}>
          <textarea
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('invitation.message_placeholder', 'Escribí una nota breve para tus invitados...')}
            maxLength={250}
            style={{
              width: '100%',
              minHeight: 120,
              padding: '14px',
              borderRadius: 16,
              border: isOverLimit ? '2px solid #EF4444' : '1.5px solid rgba(0,0,0,0.1)',
              background: '#F9FAFB',
              fontSize: 15,
              fontFamily: 'inherit',
              resize: 'none',
              outline: 'none',
              transition: 'border-color 0.2s ease',
              boxSizing: 'border-box'
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            <p style={{ fontSize: 12, color: '#6B7280', margin: 0 }}>
              {t('invitation.message_help', 'Este mensaje se agregará a la invitación que compartas.')}
            </p>
            <p style={{ 
              fontSize: 12, 
              fontWeight: 600,
              color: isOverLimit ? '#EF4444' : '#6B7280', 
              margin: 0 
            }}>
              {t('invitation.message_counter', '{{count}}/250', { count: charCount })}
            </p>
          </div>
          <p style={{ 
            fontSize: 11, 
            color: 'var(--color-on-surface-variant)', 
            marginTop: 12, 
            marginBottom: 0,
            fontStyle: 'italic',
            opacity: 0.8
          }}>
            {t('invitation.temporary_message_hint', 'Este mensaje no se guarda; se usará solo al compartir ahora.')}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 'auto' }}>
          <Button
            onClick={onClose}
            variant="ghost"
            style={{
              flex: 1, height: 48, border: '1px solid rgba(0,0,0,0.1)', color: 'var(--color-on-surface-variant)'
            }}
          >
            {t('invitation.cancel_message', 'Cancelar')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={isOverLimit}
            variant="primary"
            style={{
              flex: 1, height: 48
            }}
          >
            {t('invitation.save_message', 'Guardar')}
          </Button>
        </div>
      </div>
    </>
  );
};
