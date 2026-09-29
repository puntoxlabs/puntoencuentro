import React from 'react';
import { X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export interface AiLimitReachedSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onManualCreate: () => void;
}

export const AiLimitReachedSheet: React.FC<AiLimitReachedSheetProps> = ({
  isOpen,
  onClose,
  onManualCreate,
}) => {
  if (!isOpen) return null;

  return (
    <>
      <div className="pe-sheet-overlay" onClick={onClose} aria-hidden="true" />
      <div className="pe-sheet-container">
        <div className="pe-sheet-handle" />
        
        <div className="pe-sheet-slide-section">
          <div className="pe-sheet-header">
            <h2 className="pe-sheet-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Sparkles size={20} color="var(--color-primary)" />
              Límite alcanzado
            </h2>
            <button onClick={onClose} className="pe-sheet-close-btn" aria-label="Cerrar">
              <X size={18} />
            </button>
          </div>
          
          <p className="pe-sheet-text" style={{ marginBottom: 24 }}>
            Alcanzaste el límite mensual de creaciones con IA para tu plan actual. El cupo se renovará el próximo mes. Podés seguir organizando todos tus encuentros de forma manual, sin límites.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Button
              variant="primary"
              fullWidth
              style={{ height: 50, fontSize: 16, fontWeight: 600 }}
              onClick={onManualCreate}
            >
              Crear encuentro manual
            </Button>
            <Button
              variant="ghost"
              fullWidth
              style={{ height: 50, fontSize: 16 }}
              onClick={onClose}
            >
              Cerrar
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};
