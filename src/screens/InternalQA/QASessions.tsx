import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '../../components/ui/ScreenContainer';
import { AppBar } from '../../components/ui/AppBar';
import { getQASessions } from '../../services/qaAdminService';
import type { QASession, QASessionsResponse } from '../../services/qaAdminService';
import { formatQADateTime, formatQAElapsed, formatQAStatus } from './index';
import './InternalQA.css';

interface QASessionsServiceOverride {
  getSessions?: (
    days: number,
    status: 'started' | 'completed' | 'cancelled' | null,
    source: 'ai' | 'manual' | null,
    limit: number,
    offset: number
  ) => Promise<QASessionsResponse>;
}

interface QASessionsProps {
  serviceOverride?: QASessionsServiceOverride;
  initialSessions?: QASession[];
  initialTotal?: number;
  initialLoading?: boolean;
  initialError?: string | null;
  initialPeriodDays?: number;
  initialStatus?: 'started' | 'completed' | 'cancelled' | null;
  initialSource?: 'ai' | 'manual' | null;
  initialOffset?: number;
}

const PAGE_SIZE = 20;

const QASessions: React.FC<QASessionsProps> = ({
  serviceOverride,
  initialSessions = null,
  initialTotal = 0,
  initialLoading = initialSessions === null,
  initialError = null,
  initialPeriodDays = 7,
  initialStatus = null,
  initialSource = null,
  initialOffset = 0,
}) => {
  const navigate = useNavigate();

  // Filtros soportados exactamente por contrato RPC
  const [periodDays, setPeriodDays] = useState<number>(initialPeriodDays);
  const [statusFilter, setStatusFilter] = useState<'started' | 'completed' | 'cancelled' | null>(initialStatus);
  const [sourceFilter, setSourceFilter] = useState<'ai' | 'manual' | null>(initialSource);
  const [offset, setOffset] = useState<number>(initialOffset);

  const [sessions, setSessions] = useState<QASession[]>(initialSessions || []);
  const [total, setTotal] = useState<number>(initialTotal);
  const [loading, setLoading] = useState<boolean>(initialLoading);
  const [error, setError] = useState<string | null>(initialError);

  const fetchSessionsFn = serviceOverride?.getSessions || getQASessions;

  // Stale-response guard para prevenir race conditions en filtros rápidos
  const reqSequenceRef = useRef<number>(0);

  const loadSessions = useCallback(
    async (days: number, status: 'started' | 'completed' | 'cancelled' | null, source: 'ai' | 'manual' | null, off: number) => {
      const currentReqId = ++reqSequenceRef.current;
      setLoading(true);
      setError(null);

      try {
        const res = await fetchSessionsFn(days, status, source, PAGE_SIZE, off);

        // Si otra petición más reciente ya inició, descartar esta respuesta vieja
        if (currentReqId !== reqSequenceRef.current) return;

        setSessions(res?.sessions || []);
        setTotal(typeof res?.total === 'number' ? res.total : 0);
      } catch {
        if (currentReqId !== reqSequenceRef.current) return;
        setError('No se pudieron cargar las sesiones.');
      } finally {
        if (currentReqId === reqSequenceRef.current) {
          setLoading(false);
        }
      }
    },
    [fetchSessionsFn]
  );

  useEffect(() => {
    // Si se inyectaron initialSessions (como en tests estáticos) y no hubo interacción, no disparar fetch innecesario
    if (initialSessions !== null && reqSequenceRef.current === 0) {
      return;
    }
    loadSessions(periodDays, statusFilter, sourceFilter, offset);
  }, [periodDays, statusFilter, sourceFilter, offset, loadSessions, initialSessions]);

  const handlePeriodChange = (days: number) => {
    if (days === periodDays) return;
    setPeriodDays(days);
    setOffset(0); // Reset offset al cambiar filtro
  };

  const handleStatusChange = (val: string) => {
    const next = val === 'all' ? null : (val as 'started' | 'completed' | 'cancelled');
    setStatusFilter(next);
    setOffset(0);
  };

  const handleSourceChange = (val: string) => {
    const next = val === 'all' ? null : (val as 'ai' | 'manual');
    setSourceFilter(next);
    setOffset(0);
  };

  const handlePrevPage = () => {
    setOffset((prev) => Math.max(0, prev - PAGE_SIZE));
  };

  const handleNextPage = () => {
    setOffset((prev) => prev + PAGE_SIZE);
  };

  const handleRetry = () => {
    loadSessions(periodDays, statusFilter, sourceFilter, offset);
  };

  const isNextDisabled = loading || (total > 0 ? offset + PAGE_SIZE >= total : sessions.length < PAGE_SIZE);
  const isPrevDisabled = loading || offset === 0;

  return (
    <ScreenContainer>
      <AppBar title="Sesiones de Creación" showBack onBack={() => navigate('/internal/qa')} />
      <div className="qa-container">
        {/* Encabezado */}
        <div className="qa-header-row">
          <div className="qa-header-titles">
            <h1>Sesiones de Creación</h1>
            <p>Registro operativo y auditoría de embudos</p>
          </div>

          <button
            type="button"
            className="qa-refresh-btn"
            onClick={handleRetry}
            disabled={loading}
            title="Actualizar sesiones"
          >
            🔄 Actualizar
          </button>
        </div>

        {/* Barra de Filtros (exactamente admitidos por RPC) */}
        <div className="qa-filters-row" role="search" aria-label="Filtros de sesiones">
          <div className="qa-filter-group">
            <span>Período:</span>
            <div className="qa-period-selector" role="group" aria-label="Filtro de período">
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
          </div>

          <div className="qa-filter-group">
            <label htmlFor="qa-status-select">Estado:</label>
            <select
              id="qa-status-select"
              className="qa-select"
              value={statusFilter || 'all'}
              onChange={(e) => handleStatusChange(e.target.value)}
              aria-label="Filtrar por estado"
            >
              <option value="all">Todos</option>
              <option value="started">Iniciada</option>
              <option value="completed">Completada</option>
              <option value="cancelled">Cancelada</option>
            </select>
          </div>

          <div className="qa-filter-group">
            <label htmlFor="qa-source-select">Canal:</label>
            <select
              id="qa-source-select"
              className="qa-select"
              value={sourceFilter || 'all'}
              onChange={(e) => handleSourceChange(e.target.value)}
              aria-label="Filtrar por canal"
            >
              <option value="all">Todos</option>
              <option value="manual">Manual</option>
              <option value="ai">IA</option>
            </select>
          </div>
        </div>

        {/* Estado Error */}
        {error && !loading && (
          <div className="qa-state-box">
            <p>{error}</p>
            <button type="button" className="qa-btn-retry" onClick={handleRetry}>
              Reintentar
            </button>
          </div>
        )}

        {/* Estado Loading (Skeletons) */}
        {loading && (
          <div className="qa-sessions-list">
            <div className="qa-skeleton qa-skeleton-session" />
            <div className="qa-skeleton qa-skeleton-session" />
            <div className="qa-skeleton qa-skeleton-session" />
          </div>
        )}

        {/* Estado Vacío */}
        {!loading && !error && sessions.length === 0 && (
          <div className="qa-state-box">
            <p>No hay sesiones para estos filtros.</p>
          </div>
        )}

        {/* Lista con Datos */}
        {!loading && !error && sessions.length > 0 && (
          <>
            {/* Vista Desktop: Tabla Compacta */}
            <div className="qa-desktop-only">
              <div className="qa-table-container">
                <table className="qa-table" aria-label="Tabla de sesiones de creación">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>ID</th>
                      <th>Canal</th>
                      <th>Modo</th>
                      <th>Estado</th>
                      <th>Turnos</th>
                      <th>Duración</th>
                      <th>Fricción</th>
                      <th>Versión</th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const shortId = s.id ? s.id.slice(0, 8) : '-';
                      const isManual = s.creation_source === 'manual';
                      const isCoord = s.date_mode === 'coordination';

                      const versions: string[] = [];
                      if (s.frontend_version) versions.push(`FE: ${s.frontend_version}`);
                      if (s.edge_version) versions.push(`Edge: ${s.edge_version}`);

                      return (
                        <tr key={s.id}>
                          <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                            {formatQADateTime(s.created_at)}
                          </td>
                          <td>
                            <span className="qa-session-id">{`ID: ${shortId}`}</span>
                          </td>
                          <td>{isManual ? '✍️ Manual' : '🤖 IA'}</td>
                          <td>{isCoord ? '👥 Coord.' : s.date_mode === 'fixed' ? '📅 Fijo' : '⏳ Pendiente'}</td>
                          <td>
                            <span className={`qa-badge qa-badge--status-${s.status}`}>
                              {formatQAStatus(s.status)}
                            </span>
                          </td>
                          <td>{s.turns}</td>
                          <td>{formatQAElapsed(s.elapsed_ms)}</td>
                          <td>
                            {s.is_problematic && (
                              <span className="qa-badge qa-badge--problematic">Problemática</span>
                            )}
                            {!s.is_problematic && s.needs_review && (
                              <span className="qa-badge qa-badge--review">Revisar</span>
                            )}
                            {!s.is_problematic && !s.needs_review && (
                              <span style={{ color: 'var(--color-outline)' }}>-</span>
                            )}
                          </td>
                          <td style={{ fontSize: '11px', color: 'var(--color-outline)' }}>
                            {versions.length > 0 ? versions.join(' · ') : '-'}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="qa-detail-btn"
                              onClick={() => navigate(`/internal/qa/sessions/${s.id}`)}
                            >
                              Ver detalle →
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Vista Mobile: Cards apiladas */}
            <div className="qa-mobile-only">
              {sessions.map((s) => {
                const shortId = s.id ? s.id.slice(0, 8) : '-';
                const isManual = s.creation_source === 'manual';
                const isCoord = s.date_mode === 'coordination';

                const versions: string[] = [];
                if (s.frontend_version) versions.push(`FE: ${s.frontend_version}`);
                if (s.edge_version) versions.push(`Edge: ${s.edge_version}`);

                return (
                  <article key={s.id} className="qa-session-card">
                    <div className="qa-session-top">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="qa-session-time">{formatQADateTime(s.created_at)}</span>
                        <span className="qa-session-id">{`ID: ${shortId}`}</span>
                      </div>

                      <div className="qa-badges-wrap">
                        {s.is_problematic && (
                          <span className="qa-badge qa-badge--problematic">Problemática</span>
                        )}
                        {!s.is_problematic && s.needs_review && (
                          <span className="qa-badge qa-badge--review">Revisar</span>
                        )}
                        <span className={`qa-badge qa-badge--status-${s.status}`}>
                          {formatQAStatus(s.status)}
                        </span>
                      </div>
                    </div>

                    <div className="qa-session-details">
                      <span className="qa-detail-item">{isManual ? '✍️ Manual' : '🤖 IA'}</span>
                      <span className="qa-detail-item">
                        {isCoord ? '👥 Coordinación' : s.date_mode === 'fixed' ? '📅 Fecha definida' : '⏳ Pendiente'}
                      </span>
                      <span className="qa-detail-item">
                        {`🔄 ${s.turns} ${s.turns === 1 ? 'turno' : 'turnos'}`}
                      </span>
                      <span className="qa-detail-item">⏱️ {formatQAElapsed(s.elapsed_ms)}</span>
                      {versions.length > 0 && (
                        <span className="qa-detail-item" style={{ color: 'var(--color-outline)' }}>
                          🏷️ {versions.join(' · ')}
                        </span>
                      )}
                    </div>

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

            {/* Paginación */}
            <div className="qa-pagination">
              <span className="qa-pagination-info">
                {total > 0
                  ? `Mostrando ${offset + 1} - ${Math.min(offset + sessions.length, total)} de ${total}`
                  : `Mostrando ${sessions.length} sesiones`}
              </span>

              <div className="qa-pagination-btns">
                <button
                  type="button"
                  className="qa-page-btn"
                  onClick={handlePrevPage}
                  disabled={isPrevDisabled}
                  aria-label="Página anterior"
                >
                  ← Anterior
                </button>
                <button
                  type="button"
                  className="qa-page-btn"
                  onClick={handleNextPage}
                  disabled={isNextDisabled}
                  aria-label="Página siguiente"
                >
                  Siguiente →
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </ScreenContainer>
  );
};

export default QASessions;
