import React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
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

  return (
    <>
      {/* Backdrop */}
      <div className="account-sheet-backdrop" onClick={onClose} />

      {/* Bottom Sheet */}
      <div className="account-sheet" role="dialog" aria-modal="true" aria-label={user ? t('account.your_account') : t('account.save_title')}>
        {/* Drag handle */}
        <div className="account-sheet__handle" />

        {/* Header */}
        <div className="account-sheet__header">
          <h2 className="account-sheet__title">
            {user ? t('account.your_account') : t('account.save_title')}
          </h2>
          <button
            className="account-sheet__close-btn"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {user ? (
          /* ── Estado: LOGUEADO ─────────────────────── */
          <>
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

            <button
              className="account-sheet__signout-btn"
              onClick={handleSignOut}
              disabled={loading}
            >
              {t('account.sign_out')}
            </button>
          </>
        ) : (
          /* ── Estado: NO LOGUEADO ──────────────────── */
          <>
            <div className="account-sheet__benefit-box">
              <p className="account-sheet__benefit-title">
                {t('account.save_desc')}
              </p>
              <p className="account-sheet__benefit-desc">
                Iniciando sesión, tus encuentros quedan vinculados a tu cuenta de Google — sin importar desde dónde los accedas.
              </p>
            </div>

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
