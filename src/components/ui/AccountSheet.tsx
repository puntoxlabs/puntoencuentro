import React, { useState, useEffect } from 'react';
import { X, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { getHostAlias, setHostAlias } from '@/lib/hostAliasStorage';
import { getPostEventMinutes, setPostEventMinutes } from '@/lib/preferencesStorage';
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
  const { user, isPermanentUser, isAnonymousUser, signInWithGoogle, signOut } = useAuth();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [hostAlias, setHostAliasState] = useState('');
  const [aliasFeedback, setAliasFeedback] = useState(false);
  const [postEventMinutes, setPostEventMinutesState] = useState<number>(45);

  useEffect(() => {
    if (isOpen) {
      setHostAliasState(getHostAlias());
      setPostEventMinutesState(getPostEventMinutes());
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
    setLoading(true);
    setError(null);
    try {
      // Guardar intención para después de oauth
      sessionStorage.setItem('post_auth_redirect', window.location.pathname);
      const result = await signInWithGoogle();
      if (!result.ok) {
        if (result.error === 'anonymous_account_linking_pending') {
          setError('Todavía no es posible vincular automáticamente estos encuentros con Google. Para no perderlos, no cierres esta sesión ni borres los datos del navegador.');
        } else {
          setError(t('account.google_error', 'No se pudo iniciar sesión. Intentá nuevamente.'));
        }
      }
    } catch (err) {
      console.error('Sign in error:', err);
      setError(t('account.google_error', 'No se pudo iniciar sesión. Intentá nuevamente.'));
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    if (isAnonymousUser && !showSignOutConfirm) {
      setShowSignOutConfirm(true);
      return;
    }
    setLoading(true);
    try {
      await signOut();
      onClose();
    } catch (err) {
      console.error('Sign out error:', err);
      setError(t('account.sign_out_error', 'No se pudo cerrar sesión.'));
    } finally {
      setLoading(false);
      setShowSignOutConfirm(false);
    }
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
            {user ? (isAnonymousUser ? 'Historial vinculado a este navegador' : t('account.your_account')) : 'Guardá tus encuentros con tu cuenta'}
          </h2>
          <button
            className="pe-sheet-close-btn"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {isPermanentUser ? (
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
              <p className="account-sheet__profile-email">{user?.email}</p>
            </div>
          </div>
        ) : isAnonymousUser ? (
          <div className="account-sheet__benefit-box" style={{ background: '#fff8e1', borderColor: '#ffca28' }}>
            <p className="account-sheet__benefit-title" style={{ color: '#f57f17', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertCircle size={18} />
              Advertencia
            </p>
            <p className="account-sheet__benefit-desc" style={{ color: '#663c00' }}>
              Si borrás los datos, cambiás de navegador o dispositivo, usás una sesión privada o perdés esta sesión, podrías perder el acceso a tus encuentros.
            </p>
            <p className="account-sheet__benefit-desc" style={{ color: '#663c00', marginTop: '8px', fontWeight: 500 }}>
              La vinculación segura con Google estará disponible próximamente.
            </p>
          </div>
        ) : (
          <div className="account-sheet__benefit-box">
            <p className="account-sheet__benefit-desc">
              Iniciá sesión con Google para conservar tu historial y acceder desde otros dispositivos.
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

        {/* ── Preferencias ───────────────────── */}
        <div style={{
          marginTop: 8, marginBottom: 24, padding: '16px', borderRadius: 14,
          background: '#fff', border: '1px solid rgba(0,0,0,0.06)',
          boxShadow: '0 1px 4px rgba(0,0,0,0.02)'
        }}>
          <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Tiempo visible después del inicio
          </p>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#4B5563', lineHeight: 1.4 }}>
            Define cuánto tiempo un encuentro seguirá apareciendo como próximo después de la hora de inicio. Se aplicará a los encuentros que crees a partir de ahora.
          </p>
          <select
            value={postEventMinutes}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              setPostEventMinutesState(val);
              setPostEventMinutes(val);
            }}
            style={{
              width: '100%', border: '1px solid rgba(0,0,0,0.1)', outline: 'none',
              padding: '0 12px', height: 40, fontSize: 14, borderRadius: 8,
              fontFamily: 'var(--font-family)', color: 'var(--color-on-surface)',
              background: '#F9FAFB', cursor: 'pointer'
            }}
          >
            <option value={15}>15 minutos</option>
            <option value={30}>30 minutos</option>
            <option value={45}>45 minutos</option>
            <option value={60}>60 minutos (1 hora)</option>
            <option value={90}>90 minutos (1.5 horas)</option>
            <option value={120}>120 minutos (2 horas)</option>
          </select>
        </div>

        {error && (
          <p style={{ color: '#DC2626', fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
            {error}
          </p>
        )}

        {isPermanentUser ? (
          <button
            className="account-sheet__signout-btn"
            onClick={handleSignOut}
            disabled={loading}
          >
            {t('account.sign_out')}
          </button>
        ) : isAnonymousUser ? (
          <>
            {showSignOutConfirm ? (
              <div style={{ marginTop: '16px', padding: '16px', background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: '12px' }}>
                <p style={{ margin: '0 0 8px', fontWeight: 600, color: '#991B1B', fontSize: 15 }}>¿Salir de esta sesión?</p>
                <p style={{ margin: '0 0 16px', fontSize: 13, color: '#991B1B', lineHeight: 1.5 }}>
                  Podrías perder el acceso a los encuentros creados sin cuenta. Esta acción no se puede deshacer desde otro dispositivo.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    onClick={() => setShowSignOutConfirm(false)}
                    style={{ background: '#991B1B', color: 'white', border: 'none', padding: '10px', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}
                  >
                    Permanecer en esta sesión
                  </button>
                  <button
                    onClick={handleSignOut}
                    disabled={loading}
                    style={{ background: 'transparent', color: '#991B1B', border: '1px solid #FCA5A5', padding: '10px', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}
                  >
                    {loading ? 'Saliendo...' : 'Salir igualmente'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="account-sheet__signout-btn"
                onClick={handleSignOut}
                disabled={loading}
              >
                Cerrar sesión anónima
              </button>
            )}
          </>
        ) : (
          <>
            <button
              className="account-sheet__google-btn"
              onClick={handleSignIn}
              disabled={loading}
              aria-label="Iniciar sesión con Google"
            >
              <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" style={{ flexShrink: 0 }}>
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
              </svg>
              Iniciar sesión con Google
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
