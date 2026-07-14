import React from 'react';
import { X, Info } from 'lucide-react';
import { Button } from './Button';
import './BottomSheet.css';

export interface AnonymousCoordinationWarningSheetProps {
  open: boolean;
  onClose: () => void;
  onSelectFixed: () => void;
}

export const AnonymousCoordinationWarningSheet: React.FC<AnonymousCoordinationWarningSheetProps> = ({
  open,
  onClose,
  onSelectFixed,
}) => {
  if (!open) return null;

  return (
    <>
      <div className="pe-sheet-overlay open" onClick={onClose} />
      <div
        className="pe-sheet-container open"
        role="dialog"
        aria-modal="true"
        aria-label="Protegé tu historial antes de coordinar"
      >
        <div className="pe-sheet-handle" />

        <div className="pe-sheet-header">
          <h2 className="pe-sheet-title">Protegé tu historial antes de coordinar</h2>
          <button
            className="pe-sheet-close-btn"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="pe-sheet-body">
          <p style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--pe-text)', marginBottom: 16 }}>
            La coordinación de fechas requiere una cuenta. Todavía no podemos vincular automáticamente con Google los encuentros creados en esta sesión.
          </p>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, backgroundColor: '#fff8e1', border: '1px solid #ffca28', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
            <Info size={20} style={{ color: '#f57f17', flexShrink: 0, marginTop: 2 }} />
            <p style={{ fontSize: 14, lineHeight: 1.5, color: '#663c00', margin: 0 }}>
              Para no perder tus encuentros actuales, no cierres esta sesión ni borres los datos del navegador.
            </p>
          </div>

          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-text-muted)', marginBottom: 24, textAlign: 'center' }}>
            Vinculación con Google: próximamente
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button
              variant="primary"
              fullWidth
              onClick={onClose}
            >
              Entendido
            </Button>
            <div style={{ textAlign: 'center', marginTop: 8, paddingBottom: 16 }}>
              <button
                onClick={onSelectFixed}
                style={{ background: 'transparent', border: 'none', color: 'var(--pe-primary)', fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: '12px' }}
              >
                Elegir "Fecha definida"
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
