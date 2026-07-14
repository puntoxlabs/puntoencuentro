import React from 'react';
import { X, AlertCircle } from 'lucide-react';
import { Button } from './Button';
import './BottomSheet.css'; // Asumiendo que las clases base están aquí
import './CreationAccountChoiceSheet.css';

export interface CreationAccountChoiceSheetProps {
  open: boolean;
  googleLoading: boolean;
  anonymousLoading: boolean;
  error?: string | null;
  onContinueWithGoogle: () => void;
  onContinueAnonymously: () => void;
  onClose: () => void;
}

export const CreationAccountChoiceSheet: React.FC<CreationAccountChoiceSheetProps> = ({
  open,
  googleLoading,
  anonymousLoading,
  error,
  onContinueWithGoogle,
  onContinueAnonymously,
  onClose,
}) => {
  if (!open) return null;

  const isLoading = googleLoading || anonymousLoading;

  const handleBackdropClick = () => {
    if (!isLoading) {
      onClose();
    }
  };

  return (
    <>
      <div className="pe-sheet-overlay open" onClick={handleBackdropClick} />
      <div
        className="pe-sheet-container open creation-choice-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="¿Cómo querés guardar tus encuentros?"
      >
        <div className="pe-sheet-handle" />

        <div className="pe-sheet-header">
          <h2 className="pe-sheet-title">¿Cómo querés guardar tus encuentros?</h2>
          <button
            className="pe-sheet-close-btn"
            onClick={handleBackdropClick}
            aria-label="Cerrar"
            disabled={isLoading}
          >
            <X size={18} />
          </button>
        </div>

        <div className="pe-sheet-body">
          <p className="creation-choice-desc">
            Podés crear este encuentro sin registrarte, pero tu historial quedará vinculado a este navegador.
          </p>

          <div className="creation-choice-warning">
            <AlertCircle size={20} className="creation-choice-warning-icon" />
            <p className="creation-choice-warning-text">
              Si borrás los datos del navegador, cambiás de dispositivo, usás una ventana privada o perdés esta sesión, podrías perder el acceso a tus encuentros.
            </p>
          </div>

          <p className="creation-choice-recommendation">
            Iniciá sesión con Google para conservar tu historial y acceder desde otros dispositivos.
          </p>

          {error && (
            <p className="creation-choice-error" style={{ color: 'var(--pe-error)', margin: '8px 0', fontSize: '14px' }}>
              {error}
            </p>
          )}

          <div className="creation-choice-actions">
            <Button
              variant="primary"
              fullWidth
              onClick={onContinueWithGoogle}
              disabled={isLoading}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '16px' }}
            >
              {googleLoading ? 'Cargando...' : (
                <>
                  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                  </svg>
                  Continuar con Google
                </>
              )}
            </Button>

            <div className="creation-choice-secondary-action">
              <button
                className="creation-choice-btn-secondary"
                onClick={onContinueAnonymously}
                disabled={isLoading}
              >
                {anonymousLoading ? 'Iniciando sesión...' : 'Crear sin registrarme'}
              </button>
              <p className="creation-choice-secondary-desc">
                Podrás usar y administrar el encuentro desde este navegador mientras conserves esta sesión.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
