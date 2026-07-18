import React from 'react';
import { X, Info } from 'lucide-react';
import { Button } from './Button';
import './BottomSheet.css';

export interface AnonymousCoordinationWarningSheetProps {
  open: boolean;
  onClose: () => void;
  onSelectFixed: () => void;
  onContinueWithGoogle?: () => void;
  googleLoading?: boolean;
  error?: string | null;
}

export const AnonymousCoordinationWarningSheet: React.FC<AnonymousCoordinationWarningSheetProps> = ({
  open,
  onClose,
  onSelectFixed,
  onContinueWithGoogle,
  googleLoading = false,
  error = null,
}) => {
  if (!open) return null;

  const handleBackdropClick = () => {
    if (!googleLoading) onClose();
  };

  return (
    <>
      <div className="pe-sheet-overlay open" onClick={handleBackdropClick} />
      <div
        className="pe-sheet-container open"
        role="dialog"
        aria-modal="true"
        aria-label="Creá una cuenta para coordinar fechas"
      >
        <div className="pe-sheet-handle" />

        <div className="pe-sheet-header">
          <h2 className="pe-sheet-title">Creá una cuenta para coordinar fechas</h2>
          <button
            className="pe-sheet-close-btn"
            onClick={onClose}
            aria-label="Cerrar"
            disabled={googleLoading}
          >
            <X size={18} />
          </button>
        </div>

        <div className="pe-sheet-body">
          <p style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--pe-text)', marginBottom: 16 }}>
            Para coordinar fechas necesitás iniciar sesión con Google. Así vas a poder volver al panel, ver respuestas y confirmar la fecha desde tu cuenta.
          </p>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, backgroundColor: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
            <Info size={20} style={{ color: '#4b5563', flexShrink: 0, marginTop: 2 }} />
            <p style={{ fontSize: 14, lineHeight: 1.5, color: '#374151', margin: 0 }}>
              Tus encuentros con fecha definida pueden crearse sin cuenta, pero la coordinación necesita guardar respuestas y el estado del organizador.
            </p>
          </div>

          {error && (
            <p style={{ color: 'var(--pe-error)', margin: '8px 0 16px', fontSize: '14px', textAlign: 'center' }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Button
              variant="primary"
              fullWidth
              onClick={onContinueWithGoogle}
              disabled={googleLoading}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
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

            <button
              onClick={onSelectFixed}
              disabled={googleLoading}
              style={{ background: 'transparent', border: '1px solid var(--pe-primary)', color: 'var(--pe-primary)', fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: '12px', borderRadius: '12px', width: '100%' }}
            >
              Elegir fecha definida
            </button>
            
            <button
              onClick={onClose}
              disabled={googleLoading}
              style={{ background: 'transparent', border: 'none', color: 'var(--pe-text-muted)', fontSize: 15, fontWeight: 500, cursor: 'pointer', padding: '12px', width: '100%', marginTop: '4px' }}
            >
              Ahora no
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
