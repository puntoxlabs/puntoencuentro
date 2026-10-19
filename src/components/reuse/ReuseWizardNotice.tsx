import React from 'react';
import { useTranslation } from 'react-i18next';
import './reuse.css';

interface ReuseWizardNoticeProps {
  active: boolean;
}

/** Aviso discreto cuando el wizard fue precargado desde un favorito o repetición. */
export const ReuseWizardNotice: React.FC<ReuseWizardNoticeProps> = ({ active }) => {
  const { t } = useTranslation();
  if (!active) return null;
  return (
    <p className="pe-reuse-notice" role="status">
      {t('encounter_reuse.wizard_notice')}
    </p>
  );
};
