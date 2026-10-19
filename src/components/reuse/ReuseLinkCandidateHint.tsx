import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useRepeatEncounterStore } from '@/store/repeatEncounterStore';
import './reuse.css';

interface ReuseLinkCandidateHintProps {
  currentValue: string;
  onConfirmReuse: (link: string) => void;
}

/**
 * Aviso para enlaces privados de reuniones virtuales: nunca se completan solos;
 * el organizador debe confirmar con un clic si desea reutilizar el enlace anterior.
 */
export const ReuseLinkCandidateHint: React.FC<ReuseLinkCandidateHintProps> = ({
  currentValue,
  onConfirmReuse,
}) => {
  const { t } = useTranslation();
  const storeCandidate = useRepeatEncounterStore((s) => s.linkCandidate);
  const candidate = storeCandidate ?? useRepeatEncounterStore.getState().linkCandidate;
  const clear = useRepeatEncounterStore((s) => s.clearLinkCandidate);

  if (!candidate || currentValue.trim() !== '') return null;

  return (
    <div className="pe-reuse-link-hint" role="note">
      <span>{t('encounter_reuse.virtual_link_prompt')}</span>
      <div className="pe-fav-item-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onConfirmReuse(candidate);
            clear();
          }}
        >
          {t('encounter_reuse.virtual_link_reuse_btn')}
        </Button>
        <button type="button" className="pe-fav-link-btn" onClick={clear}>
          {t('encounter_reuse.virtual_link_dismiss_btn')}
        </button>
      </div>
    </div>
  );
};
