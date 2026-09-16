import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '../../components/ui/ScreenContainer';
import { AppBar } from '../../components/ui/AppBar';
import {
  getQADashboardMetrics,
  getQASessions,
} from '../../services/qaAdminService';
import type {
  QADashboardMetrics,
  QASession,
} from '../../services/qaAdminService';
import './InternalQA.css';

interface QAOverviewServiceOverride {
  getMetrics?: (days: number) => Promise<QADashboardMetrics>;
  getSessions?: (days: number, status: null, source: null, limit: number, offset: number) => Promise<{ sessions: QASession[] }>;
}

interface InternalQAOverviewProps {
  serviceOverride?: QAOverviewServiceOverride;
  initialMetrics?: QADashboardMetrics | null;
  initialSessions?: QASession[];
  initialLoading?: boolean;
  initialError?: string | null;
  initialPeriodDays?: number;
}

export const formatQADateTime = (isoString?: string): string => {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('es-AR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '-';
  }
};

export const formatQAElapsed = (elapsedMs?: number | null): string => {
  if (!elapsedMs || elapsedMs <= 0) return '< 1s';
  const totalSeconds = Math.round(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
};

export const formatQAStatus = (status?: string | null): string => {
  if (!status) return '-';
  switch (status) {
    case 'completed':
      return 'Completada';
    case 'cancelled':
      return 'Cancelada';
    case 'started':
      return 'Iniciada';
    case 'error':
      return 'Error';
    case 'fallback_manual':
      return 'Continuó manualmente';
    default:
      return status;
  }
};

const InternalQAOverview: React.FC<InternalQAOverviewProps> = ({
  serviceOverride,
  initialMetrics = null,
  initialSessions = [],
  initialLoading = !initialMetrics,
  initialError = null,
  initialPeriodDays = 7,
}) => {
  const navigate = useNavigate();
  const [periodDays, setPeriodDays] = useState<number>(initialPeriodDays);
  const [metrics, setMetrics] = useState<QADashboardMetrics | null>(initialMetrics);
  const [sessions, setSessions] = useState<QASession[]>(initialSessions);
  const [loading, setLoading] = useState<boolean>(initialLoading);
  const [error, setError] = useState<string | null>(initialError);

  const fetchMetricsFn = serviceOverride?.getMetrics || getQADashboardMetrics;
  const fetchSessionsFn = serviceOverride?.getSessions || getQASessions;

  const loadData = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      // Exactamente 1 llamada a metrics + 1 llamada a sessions
      const [metricsData, sessionsResponse] = await Promise.all([
        fetchMetricsFn(days),
        fetchSessionsFn(days, null, null, 20, 0),
      ]);

      setMetrics(metricsData);
      setSessions(sessionsResponse?.sessions || []);
    } catch {
      setError('No se pudieron cargar los datos.');
    } finally {
      setLoading(false);
    }
  }, [fetchMetricsFn, fetchSessionsFn]);

  useEffect(() => {
    loadData(periodDays);
  }, [periodDays, loadData]);

  const handlePeriodChange = (days: number) => {
    if (days === periodDays) return;
    setPeriodDays(days);
  };

  const handleRefresh = () => {
    loadData(periodDays);
  };

  // Filtrar sesiones con banderas de fricción asignadas por el backend
  const sessionsToReview = sessions.filter(
    (s) => s.is_problematic === true || s.needs_review === true
  ).slice(0, 10);

  return (
    <ScreenContainer>
      <AppBar title="QA Console" showBack onBack={() => navigate('/')} />
      <div className="qa-container">
        {/* Encabezado y controles de período */}
        <div className="qa-header-row">
          <div className="qa-header-titles">
            <h1>QA Console</h1>
            <p>Actividad de creación y calidad operativa</p>
          </div>

          <div className="qa-controls">
            <div className="qa-period-selector" role="group" aria-label="Selector de período">
              <button
                type="button"
                className={`qa-period-btn ${periodDays === 1 ? 'qa-period-btn--active' : ''}`}
                onClick={() => handlePeriodChange(1)}
              >
                24 h
              </button>
              <button
                type="button"
                className={`qa-period-btn ${periodDays === 7 ? 'qa-period-btn--active' : ''}`}
                onClick={() => handlePeriodChange(7)}
              >
                7 días
              </button>
              <button
                type="button"
                className={`qa-period-btn ${periodDays === 30 ? 'qa-period-btn--active' : ''}`}
                onClick={() => handlePeriodChange(30)}
              >
                30 días
              </button>
            </div>

            <button
              type="button"
              className="qa-refresh-btn"
              onClick={handleRefresh}
              disabled={loading}
              title="Actualizar datos"
            >
              🔄 Actualizar
            </button>
          </div>
        </div>

        {/* Estado Error */}
        {error && !loading && (
          <div className="qa-state-box">
            <p>{error}</p>
            <button type="button" className="qa-btn-retry" onClick={handleRefresh}>
              Reintentar
            </button>
          </div>
        )}

        {/* Estado Loading (Skeletons) */}
        {loading && (
          <>
            <div className="qa-metrics-grid">
              <div className="qa-skeleton qa-skeleton-metric" />
              <div className="qa-skeleton qa-skeleton-metric" />
              <div className="qa-skeleton qa-skeleton-metric" />
              <div className="qa-skeleton qa-skeleton-metric" />
            </div>
            <div className="qa-sessions-list">
              <div className="qa-skeleton qa-skeleton-session" />
              <div className="qa-skeleton qa-skeleton-session" />
            </div>
          </>
        )}

        {/* Contenido principal cuando no hay error ni loading */}
        {!loading && !error && metrics && (
          <>
            {/* Tarjetas Principales */}
            <section aria-label="Métricas principales">
              <h2 className="qa-section-title">Métricas de Creación</h2>
              <div className="qa-metrics-grid">
                <div className="qa-metric-card qa-metric-card--accent">
                  <span className="qa-metric-label">Sesiones iniciadas</span>
                  <span className="qa-metric-value">{metrics.total_sessions}</span>
                  <span className="qa-metric-subtext">Total en {metrics.period_days} días</span>
                </div>

                <div className="qa-metric-card">
                  <span className="qa-metric-label">Encuentros creados</span>
                  <span className="qa-metric-value">{metrics.completed_sessions}</span>
                  <span className="qa-metric-subtext">Completados con éxito</span>
                </div>

                <div className="qa-metric-card">
                  <span className="qa-metric-label">Tasa de finalización</span>
                  <span className="qa-metric-value">{`${metrics.conversion_rate}%`}</span>
                  <span className="qa-metric-subtext">Conversión sobre total</span>
                </div>

                <div className="qa-metric-card qa-metric-card--warning">
                  <span className="qa-metric-label">Probables abandonos</span>
                  <span className="qa-metric-value">{metrics.abandoned_sessions}</span>
                  <span className="qa-metric-subtext">&gt; 30 min inactivo</span>
                </div>
              </div>
            </section>

            {/* Métricas Secundarias / Operativas */}
            <section aria-label="Distribución y calidad operativa">
              <div className="qa-secondary-grid">
                <div className="qa-secondary-card">
                  <span className="qa-secondary-card-title">Canal de Creación</span>
                  <span className="qa-secondary-card-val">
                    {`🤖 ${metrics.ai_sessions} IA · ✍️ ${metrics.manual_sessions} Manual`}
                  </span>
                </div>

                <div className="qa-secondary-card">
                  <span className="qa-secondary-card-title">Modo de Fecha</span>
                  <span className="qa-secondary-card-val">
                    {`📅 ${metrics.fixed_encounters} Fijo · 👥 ${metrics.coordination_encounters} Coord.`}
                  </span>
                </div>

                <div className="qa-secondary-card">
                  <span className="qa-secondary-card-title">Calidad IA & Inferencia</span>
                  <span className="qa-secondary-card-val">
                    {`⚠️ ${metrics.fallback_events} Fallbacks · 💬 ${metrics.clarification_events} Aclar.`}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--color-outline)' }}>
                    {`P90 latencia: ${metrics.p90_latency_ms} ms`}
                  </span>
                </div>
              </div>
            </section>

            {/* Sesiones a revisar */}
            <section aria-label="Sesiones recientes a revisar">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                <h2 className="qa-section-title" style={{ marginBottom: 0 }}>Sesiones recientes a revisar</h2>
                <button
                  type="button"
                  className="qa-refresh-btn"
                  onClick={() => navigate('/internal/qa/sessions')}
                >
                  Ver todas las sesiones →
                </button>
              </div>

              {metrics.total_sessions === 0 ? (
                <div className="qa-state-box">
                  <p>No hay sesiones en este período.</p>
                </div>
              ) : sessionsToReview.length === 0 ? (
                <div className="qa-state-box">
                  <p>No se detectaron sesiones a revisar.</p>
                </div>
              ) : (
                <div className="qa-sessions-list">
                  {sessionsToReview.map((s) => {
                    const shortId = s.id ? s.id.slice(0, 8) : 'unknown';
                    const isManual = s.creation_source === 'manual';
                    const isCoord = s.date_mode === 'coordination';

                    return (
                      <article key={s.id} className="qa-session-card">
                        <div className="qa-session-top">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="qa-session-time">
                              {formatQADateTime(s.created_at)}
                            </span>
                            <span className="qa-session-id">{`ID: ${shortId}`}</span>
                          </div>

                          <div className="qa-badges-wrap">
                            {/* Badges de Fricción basados estrictamente en flags de Backend */}
                            {s.is_problematic && (
                              <span className="qa-badge qa-badge--problematic">
                                Problemática
                              </span>
                            )}
                            {!s.is_problematic && s.needs_review && (
                              <span className="qa-badge qa-badge--review">
                                Revisar
                              </span>
                            )}

                            {/* Badge de Estado */}
                            <span
                              className={`qa-badge qa-badge--status-${s.status}`}
                            >
                              {formatQAStatus(s.status)}
                            </span>
                          </div>
                        </div>

                        {/* Detalles de la sesión */}
                        <div className="qa-session-details">
                          <span className="qa-detail-item">
                            {isManual ? '✍️ Manual' : '🤖 Crear con IA'}
                          </span>
                          <span className="qa-detail-item">
                            {isCoord ? '👥 Coordinación' : s.date_mode === 'fixed' ? '📅 Fecha definida' : '⏳ Modo pendiente'}
                          </span>
                          <span className="qa-detail-item">
                            🔄 {s.turns} {s.turns === 1 ? 'turno' : 'turnos'}
                          </span>
                          <span className="qa-detail-item">
                            ⏱️ {formatQAElapsed(s.elapsed_ms)}
                          </span>
                        </div>

                        {/* Botón Ver Detalle */}
                        <div className="qa-session-bottom">
                          <button
                            type="button"
                            className="qa-detail-btn"
                            onClick={() => navigate(`/internal/qa/sessions/${s.id}`)}
                          >
                            Ver detalle →
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </ScreenContainer>
  );
};

export default InternalQAOverview;
