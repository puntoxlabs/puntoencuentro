import React from 'react';
import { X, AlertCircle, ArrowRight, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import '@/components/ui/BottomSheet.css';
import './DraftOverwriteConfirmSheet.css';

export interface DraftOverwriteConfirmSheetProps {
  open: boolean;
  draftTitle?: string | null;
  newPrompt: string;
  onConfirmNew: () => void;
  onResumeOld: () => void;
  onClose: () => void;
}

export const DraftOverwriteConfirmSheet: React.FC<DraftOverwriteConfirmSheetProps> = ({
  open,
  draftTitle,
  newPrompt,
  onConfirmNew,
  onResumeOld,
  onClose,
}) => {
  if (!open) return null;

  const currentTitle = draftTitle?.trim() || 'Encuentro en borrador';

  return (
    <>
      <div className="pe-sheet-overlay open" onClick={onClose} />
      <div
        className="pe-sheet-container open draft-confirm-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Tenés un encuentro en preparación"
      >
        <div className="pe-sheet-handle" />

        <div className="pe-sheet-header">
          <h2 className="pe-sheet-title">Tenés un encuentro en preparación</h2>
          <button
            className="pe-sheet-close-btn"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="pe-sheet-body">
          <div className="draft-confirm-warning">
            <AlertCircle size={20} className="draft-confirm-warning-icon" />
            <div className="draft-confirm-warning-text">
              Ya tenés datos avanzados para: <strong>{currentTitle}</strong>.
            </div>
          </div>

          <p className="draft-confirm-desc">
            Si iniciás un nuevo encuentro ahora, se descartará el borrador anterior para comenzar con tu nueva idea:
          </p>

          <div className="draft-confirm-new-quote">
            "{newPrompt}"
          </div>
        </div>

        <div className="pe-sheet-footer draft-confirm-footer">
          <Button
            variant="primary"
            fullWidth
            onClick={onConfirmNew}
            className="draft-confirm-btn"
          >
            <RotateCcw size={16} />
            <span>Descartar anterior y empezar este</span>
          </Button>

          <Button
            variant="outline"
            fullWidth
            onClick={onResumeOld}
            className="draft-confirm-btn"
          >
            <ArrowRight size={16} />
            <span>Continuar el borrador anterior</span>
          </Button>

          <Button
            variant="ghost"
            fullWidth
            onClick={onClose}
            style={{ marginTop: 4 }}
          >
            Cancelar
          </Button>
        </div>
      </div>
    </>
  );
};
