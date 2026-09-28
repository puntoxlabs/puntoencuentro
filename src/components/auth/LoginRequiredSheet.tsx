import React from 'react';
import { LogIn, X } from 'lucide-react';
import './LoginRequiredSheet.css';

export interface LoginRequiredSheetProps {
  /** Título descriptivo del recurso que requiere login */
  isOpen: boolean;
  onClose: () => void;
  onContinueWithGoogle: () => void;
  /** Cargando la operación OAuth */
  loading?: boolean;
  /** Contexto de acción: 'request_join' | 'open_encounter' */
  action?: 'request_join' | 'open_encounter';
}

const COPIES: Record<NonNullable<LoginRequiredSheetProps['action']>, { title: string; body: string }> = {
  request_join: {
    title: 'Para solicitar sumarte necesitás una cuenta',
    body: 'Esto nos ayuda a cuidar la comunidad y te permite seguir tu solicitud.',
  },
  open_encounter: {
    title: 'Para abrir tu encuentro necesitás una cuenta',
    body: 'Una cuenta nos permite vincular el encuentro a tu identidad y notificarte sobre las solicitudes.',
  },
};

const BENEFITS = [
  'Seguir el estado de tu solicitud',
  'Recibir la confirmación del anfitrión',
  'Conservar tus encuentros',
];

export const LoginRequiredSheet: React.FC<LoginRequiredSheetProps> = ({
  isOpen,
  onClose,
  onContinueWithGoogle,
  loading = false,
  action = 'request_join',
}) => {
  if (!isOpen) return null;

  const copy = COPIES[action];

  return (
    <>
      {/* Overlay */}
      <div
        className="login-required-overlay"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        className="login-required-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-required-title"
      >
        <div className="login-required-sheet__header">
          <button
            type="button"
            className="login-required-sheet__close"
            onClick={onClose}
            aria-label="Cerrar"
            disabled={loading}
          >
            <X size={20} />
          </button>
        </div>

        <div className="login-required-sheet__body">
          <div className="login-required-sheet__icon-wrap" aria-hidden="true">
            <LogIn size={28} />
          </div>

          <h2 id="login-required-title" className="login-required-sheet__title">
            {copy.title}
          </h2>

          <p className="login-required-sheet__body-text">{copy.body}</p>

          <ul className="login-required-sheet__benefits" aria-label="Beneficios de tener una cuenta">
            {BENEFITS.map((b) => (
              <li key={b} className="login-required-sheet__benefit-item">
                <span className="login-required-sheet__benefit-dot" aria-hidden="true">·</span>
                {b}
              </li>
            ))}
          </ul>

          <div className="login-required-sheet__actions">
            <button
              type="button"
              className="login-required-sheet__cta-primary"
              onClick={onContinueWithGoogle}
              disabled={loading}
            >
              {loading ? (
                'Redirigiendo...'
              ) : (
                <>
                  <svg
                    className="login-required-sheet__google-icon"
                    width="18"
                    height="18"
                    viewBox="0 0 18 18"
                    aria-hidden="true"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.616Z"
                      fill="#4285F4"
                    />
                    <path
                      d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
                      fill="#34A853"
                    />
                    <path
                      d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332Z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58Z"
                      fill="#EA4335"
                    />
                  </svg>
                  Continuar con Google
                </>
              )}
            </button>

            <button
              type="button"
              className="login-required-sheet__cta-secondary"
              onClick={onClose}
              disabled={loading}
            >
              Ahora no
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
