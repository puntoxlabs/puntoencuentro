import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { getHostAlias, setHostAlias } from '@/lib/hostAliasStorage';
import './BottomSheet.css';
import './AccountSheet.css';

interface AccountSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Returns up to 2 uppercase initials from the user's display name or email */
function getInitials(user: {
  user_metadata?: { full_name?: string; name?: string };
  email?: string;
} | null): string {
  if (!user) return '?';
  const name =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.email ||
    '';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || '?';
}

export const AccountSheet: React.FC<AccountSheetProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { user, loading, signInWithGoogle, signOut } = useAuth();
  
  const [hostAlias, setHostAliasState] = useState('');
  const [aliasFeedback, setAliasFeedback] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setHostAliasState(getHostAlias());
      setAliasFeedback(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;
  const displayName = (
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    ''
  ) as string;
  const initials = getInitials(user);

  const handleSignIn = async () => {
    await signInWithGoogle();
    // Page will reload after OAuth redirect — no need to close sheet manually
  };

  const handleSignOut = async () => {
    await signOut();
    onClose();
  };

  const handleSaveAlias = () => {
    setHostAlias(hostAlias);
    setAliasFeedback(true);
    setTimeout(() => setAliasFeedback(false), 3000);
  };

  return (
    <>
      {/* Backdrop */}
      <div className="pe-sheet-overlay" onClick={onClose} />

      {/* Bottom Sheet */}
      <div className="pe-sheet-container" role="dialog" aria-modal="true" aria-label={user ? t('account.your_account') : t('account.save_title')}>
        {/* Drag handle */}
        <div className="pe-sheet-handle" />

        {/* Header */}
        <div className="pe-sheet-header">
          <h2 className="pe-sheet-title">
            {user ? t('account.your_account') : t('account.save_title')}
          </h2>
          <button
            className="pe-sheet-close-btn"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {user ? (
          <div className="account-sheet__profile-card">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Avatar"
                className="account-sheet__avatar-img"
              />
            ) : (
              <div className="account-sheet__avatar-initials">
                {initials}
              </div>
            )}
            <div className="account-sheet__profile-info">
              {displayName && (
                <p className="account-sheet__profile-name">{displayName}</p>
              )}
              <p className="account-sheet__profile-email">{user.email}</p>
            </div>
          </div>
        ) : (
          <div className="account-sheet__benefit-box">
            <p className="account-sheet__benefit-title">
              {t('account.save_desc')}
            </p>
            <p className="account-sheet__benefit-desc">
              Iniciando sesión, tus encuentros quedan vinculados a tu cuenta de Google — sin importar desde dónde los accedas.
            </p>
          </div>
        )}

        {/* ── Alias del anfitrión ───────────────────── */}
        <div style={{
          marginTop: 8, marginBottom: 24, padding: '16px', borderRadius: 14,
          background: '#fff', border: '1px solid rgba(0,0,0,0.06)',
          boxShadow: '0 1px 4px rgba(0,0,0,0.02)'
        }}>
          <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Alias del anfitrión
          </p>
          <p style={{ margin: '0 0 4px', fontSize: 13, color: '#4B5563', lineHeight: 1.4 }}>
            Se usará en tus invitaciones para indicar quién invita.
          </p>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6B7280' }}>
            Se guarda en este dispositivo.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={hostAlias}
              onChange={e => setHostAliasState(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveAlias(); }}
              placeholder="Ej: Leandro"
              style={{
                flex: 1, minWidth: 0, border: '1px solid rgba(0,0,0,0.1)', outline: 'none',
                padding: '0 12px', height: 40, fontSize: 14, borderRadius: 8,
                fontFamily: 'var(--font-family)', color: 'var(--color-on-surface)',
                background: '#F9FAFB',
              }}
            />
            <button
              onClick={handleSaveAlias}
              style={{
                background: 'var(--color-primary-container)',
                color: 'var(--color-primary-dark)',
                border: '1px solid var(--color-primary)',
                cursor: 'pointer', padding: '0 16px', height: 40, borderRadius: 8,
                fontFamily: 'var(--font-family)', fontWeight: 600, fontSize: 13, 
                transition: 'all 0.15s', whiteSpace: 'nowrap',
              }}
            >
              Guardar
            </button>
          </div>
          {aliasFeedback && (
            <p style={{ margin: '8px 0 0', fontSize: 12, fontWeight: 500, color: '#059669', animation: 'fadeIn 0.2s ease' }}>
              ✓ Guardado
            </p>
          )}
        </div>

        {user ? (
          <button
            className="account-sheet__signout-btn"
            onClick={handleSignOut}
            disabled={loading}
          >
            {t('account.sign_out')}
          </button>
        ) : (
          <>
            <button
              className="account-sheet__google-btn"
              onClick={handleSignIn}
              disabled={loading}
              aria-label={t('account.google_btn')}
            >
              {/* Official Google "G" logo colors */}
              <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" style={{ flexShrink: 0 }}>
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
              </svg>
              {t('account.google_btn')}
            </button>

            <p className="account-sheet__disclaimer">
              {t('account.disclaimer')}
            </p>
          </>
        )}


      </div>
    </>
  );
};
