import React from 'react';
import { AlertCircle, Clock, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './PendingClosureBanner.css';

export interface PendingClosureBannerProps {
  encuentroId: string;
  encuentroTitle: string;
  isOverdue: boolean;
  onOpenClosure: () => void;
}

export const PendingClosureBanner: React.FC<PendingClosureBannerProps> = ({
  encuentroTitle,
  isOverdue,
  onOpenClosure,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className={`pe-pending-closure-banner ${
        isOverdue ? 'pe-pending-closure-banner--overdue' : 'pe-pending-closure-banner--pending'
      }`}
      role="alert"
    >
      <div className="pe-pending-closure-banner__content">
        {isOverdue ? (
          <AlertCircle size={20} className="pe-pending-closure-banner__icon" aria-hidden="true" />
        ) : (
          <Clock size={20} className="pe-pending-closure-banner__icon" aria-hidden="true" />
        )}
        <div>
          <h4 className="pe-pending-closure-banner__title">
            {isOverdue
              ? t('post_event_closure.banner_overdue_title', {
                  defaultValue: 'Cierre pendiente (plazo vencido)',
                })
              : t('post_event_closure.banner_pending_title', {
                  defaultValue: 'Encuentro finalizado: registrar cierre',
                })}
          </h4>
          <p className="pe-pending-closure-banner__desc">
            {isOverdue
              ? t('post_event_closure.banner_overdue_desc', {
                  title: encuentroTitle,
                  defaultValue:
                    'Completá el registro de asistencia de "{{title}}" para poder publicar nuevos encuentros abiertos.',
                })
              : t('post_event_closure.banner_pending_desc', {
                  title: encuentroTitle,
                  defaultValue:
                    'Tenés 48 h de gracia para registrar qué pasó en "{{title}}" y la presencia de los participantes.',
                })}
          </p>
        </div>
      </div>
      <button
        type="button"
        className="pe-pending-closure-banner__action"
        onClick={onOpenClosure}
      >
        <span>
          {isOverdue
            ? t('post_event_closure.banner_action_overdue', { defaultValue: 'Cerrar ahora' })
            : t('post_event_closure.banner_action_pending', { defaultValue: 'Registrar cierre' })}
        </span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
};
