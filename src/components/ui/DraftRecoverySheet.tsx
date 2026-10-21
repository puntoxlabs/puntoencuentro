import React from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, ArrowRight, FileText } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import '@/components/ui/BottomSheet.css';
import './DraftRecoverySheet.css';

export interface DraftRecoverySheetProps {
  open: boolean;
  draftTitle?: string | null;
  onContinue: () => void;
  onDiscard: () => void;
}

export const DraftRecoverySheet: React.FC<DraftRecoverySheetProps> = ({
  open,
  draftTitle,
  onContinue,
  onDiscard,
}) => {
  const { t } = useTranslation();

  if (!open) return null;

  const displayTitle = draftTitle?.trim() || t('draft_recovery.untitled', 'Encuentro sin título');

  return (
    <>
      <div className="pe-sheet-overlay open" onClick={onContinue} />
      <div
        className="pe-sheet-container open draft-recovery-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('draft_recovery.title', 'Tenés un borrador pendiente')}
      >
        <div className="pe-sheet-handle" />

        <div className="pe-sheet-body" style={{ paddingTop: 16 }}>
          <div className="draft-recovery-header">
            <div className="draft-recovery-icon-wrap">
              <FileText size={22} />
            </div>
            <h2 className="draft-recovery-title">
              {t('draft_recovery.title', 'Tenés un borrador pendiente')}
            </h2>
          </div>

          <div className="draft-recovery-draft-card">
            <span className="draft-recovery-draft-label">Borrador</span>
            <p className="draft-recovery-draft-title">"{displayTitle}"</p>
          </div>

          <p className="draft-recovery-desc">
            {t(
              'draft_recovery.desc',
              'Podés continuar con los datos que estabas completando o descartarlos para empezar de cero.'
            )}
          </p>

          <div className="draft-recovery-actions">
            <Button
              variant="primary"
              fullWidth
              onClick={onContinue}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              <ArrowRight size={18} />
              <span>{t('draft_recovery.continue_btn', 'Continuar borrador')}</span>
            </Button>

            <Button
              variant="outline"
              fullWidth
              onClick={onDiscard}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              <RotateCcw size={16} />
              <span>{t('draft_recovery.discard_btn', 'Descartar y empezar de nuevo')}</span>
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};
