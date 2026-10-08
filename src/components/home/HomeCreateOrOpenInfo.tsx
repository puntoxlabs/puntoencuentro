import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Calendar, Share2, Users } from 'lucide-react';
import './HomeCreateOrOpenInfo.css';

interface HomeCreateOrOpenInfoProps {
  isAnonymous?: boolean;
  className?: string;
}

export const HomeCreateOrOpenInfo: React.FC<HomeCreateOrOpenInfoProps> = ({
  isAnonymous = false,
  className = '',
}) => {
  const { t } = useTranslation();

  return (
    <section
      className={`home-create-or-open-info ${isAnonymous ? 'home-create-or-open-info--anonymous' : ''} ${className}`}
      aria-label="Información sobre crear o abrir encuentros"
    >
      <div className="home-create-or-open-info__main">
        <div className="home-create-or-open-info__header">
          <Sparkles size={16} className="home-create-or-open-info__icon" aria-hidden="true" />
          <h3 className="home-create-or-open-info__title">
            {t('create_or_open.title_v2', { defaultValue: 'Crear o abrir un encuentro' })}
          </h3>
        </div>
        <p className="home-create-or-open-info__desc">
          {t('create_or_open.desc_v2', {
            defaultValue: 'Organizá algo con los tuyos o abrí lugares en un encuentro que ya creaste.',
          })}
        </p>
      </div>

      {isAnonymous && (
        <div className="home-create-or-open-info__onboarding">
          <div className="home-create-or-open-info__step">
            <Calendar size={14} className="home-create-or-open-info__step-icon" aria-hidden="true" />
            <span>
              {t('create_or_open.step1_v2', {
                defaultValue: 'Elegí fecha u opciones para coordinar',
              })}
            </span>
          </div>
          <div className="home-create-or-open-info__step">
            <Share2 size={14} className="home-create-or-open-info__step-icon" aria-hidden="true" />
            <span>
              {t('create_or_open.step2_v2', {
                defaultValue: 'Invitá con un link, sin registro previo',
              })}
            </span>
          </div>
          <div className="home-create-or-open-info__step">
            <Users size={14} className="home-create-or-open-info__step-icon" aria-hidden="true" />
            <span>
              {t('create_or_open.step3_v2', {
                defaultValue: 'Abrí lugares en tus zonas si te falta gente',
              })}
            </span>
          </div>
        </div>
      )}
    </section>
  );
};

export default HomeCreateOrOpenInfo;
