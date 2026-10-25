import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, ChevronDown, ChevronUp, UserCheck, Calendar, Info } from 'lucide-react';
import { factualTrajectoryService } from '@/services/factualTrajectoryService';
import type { FactualTrajectoryResponse } from '@/types/factualTrajectory';
import './FactualTrajectoryCard.css';

export interface FactualTrajectoryCardProps {
  userId?: string;
  defaultExpanded?: boolean;
}

export const FactualTrajectoryCard: React.FC<FactualTrajectoryCardProps> = ({
  userId,
  defaultExpanded = false,
}) => {
  const { t } = useTranslation();
  const [data, setData] = useState<FactualTrajectoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  useEffect(() => {
    let isMounted = true;
    factualTrajectoryService.getTrayectoria(userId).then((res) => {
      if (isMounted) {
        if (res.ok) {
          setData(res);
        }
        setLoading(false);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [userId]);

  if (loading || !data || !data.ok || !data.contexto_factual) {
    return null;
  }

  const { contexto_factual, trayectoria_anfitrion, trayectoria_participante } = data;
  const sampleStatus = contexto_factual.estado_muestra;

  const getBadgeClass = () => {
    switch (sampleStatus) {
      case 'establecida':
        return 'pe-trajectory-badge-established';
      case 'preliminar':
        return 'pe-trajectory-badge-preliminary';
      default:
        return 'pe-trajectory-badge-neutral';
    }
  };

  const getBadgeText = () => {
    switch (sampleStatus) {
      case 'establecida':
        return t('trajectory.sampleEstablished', '3 o más experiencias');
      case 'preliminar':
        return t('trajectory.samplePreliminary', '1 o 2 experiencias');
      default:
        return t('trajectory.sampleNeutral', 'Sin experiencias');
    }
  };

  return (
    <div className="pe-trajectory-card" data-testid="factual-trajectory-card">
      <div
        className="pe-trajectory-header"
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
        aria-expanded={isExpanded}
      >
        <div className="pe-trajectory-title-wrap">
          <ShieldCheck size={18} className="pe-trajectory-icon" />
          <h3 className="pe-trajectory-title">
            {t('trajectory.title', 'Mi Trayectoria en Encuentros Abiertos')}
          </h3>
          <span className={`pe-trajectory-badge ${getBadgeClass()}`}>
            {getBadgeText()}
          </span>
        </div>
        <button
          type="button"
          className="pe-trajectory-toggle-btn"
          aria-label={isExpanded ? 'Contraer' : 'Expandir'}
        >
          {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
      </div>

      {isExpanded && (
        <div className="pe-trajectory-body">
          <div className="pe-trajectory-grid">
            {/* Como Anfitrión */}
            <div className="pe-trajectory-column">
              <h4 className="pe-trajectory-col-title">
                <Calendar size={14} />
                {t('trajectory.asHost', 'Como Anfitrión')}
              </h4>
              <div className="pe-trajectory-stats">
                <div className="pe-trajectory-stat-row">
                  <span className="pe-trajectory-stat-label">
                    {t('trajectory.hostOrganized', 'Encuentros organizados')}:
                  </span>
                  <span className="pe-trajectory-stat-val">
                    {trayectoria_anfitrion?.datos_objetivos.encuentros_abiertos_organizados || 0}
                  </span>
                </div>
                <div className="pe-trajectory-stat-row">
                  <span className="pe-trajectory-stat-label">
                    {t('trajectory.hostClosedOnTime', 'Cierres a tiempo')}:
                  </span>
                  <span className="pe-trajectory-stat-val">
                    {trayectoria_anfitrion?.datos_objetivos.cierres_a_tiempo || 0}
                  </span>
                </div>
                <div className="pe-trajectory-stat-row">
                  <span className="pe-trajectory-stat-label">
                    {t('trajectory.hostGuestsReceived', 'Participantes recibidos')}:
                  </span>
                  <span className="pe-trajectory-stat-val">
                    {trayectoria_anfitrion?.datos_objetivos.participantes_recibidos_total || 0}
                  </span>
                </div>
              </div>
            </div>

            {/* Como Participante */}
            <div className="pe-trajectory-column">
              <h4 className="pe-trajectory-col-title">
                <UserCheck size={14} />
                {t('trajectory.asParticipant', 'Como Participante')}
              </h4>
              <div className="pe-trajectory-stats">
                <div className="pe-trajectory-stat-row">
                  <span className="pe-trajectory-stat-label">
                    {t('trajectory.partConfirmed', 'Encuentros confirmados')}:
                  </span>
                  <span className="pe-trajectory-stat-val">
                    {trayectoria_participante?.datos_objetivos.encuentros_abiertos_confirmados || 0}
                  </span>
                </div>
                <div className="pe-trajectory-stat-row">
                  <span className="pe-trajectory-stat-label">
                    {t('trajectory.partCorroborated', 'Asistencias corroboradas')}:
                  </span>
                  <span className="pe-trajectory-stat-val">
                    {trayectoria_participante?.hechos_corroborados.asistencias_corroboradas || 0}
                  </span>
                </div>
                <div className="pe-trajectory-stat-row">
                  <span className="pe-trajectory-stat-label">
                    {t('trajectory.partReconfirmed', 'Reconfirmaciones cumplidas')}:
                  </span>
                  <span className="pe-trajectory-stat-val">
                    {trayectoria_participante?.datos_objetivos.reconfirmaciones_completadas || 0}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="pe-trajectory-footer">
            <Info size={12} />
            <span>
              {t(
                'trajectory.neutralFooter',
                'Información fáctica y verificada de Encuentros Abiertos. No utiliza valoraciones públicas ni penalizaciones automáticas.'
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
