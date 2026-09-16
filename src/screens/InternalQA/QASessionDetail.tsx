import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '../../components/ui/ScreenContainer';
import { AppBar } from '../../components/ui/AppBar';
import * as qaAdminService from '../../services/qaAdminService';
import { formatQAStatus } from './index';
import './InternalQA.css';

// DI for testing
export interface QASessionDetailProps {
  serviceOverride?: typeof qaAdminService;
  initialData?: qaAdminService.QASessionTimelineResponse | null;
  initialError?: string | null;
  initialLoading?: boolean;
}

const formatLatency = (ms: number | null) => {
  if (ms === null || ms === undefined || isNaN(ms)) return null;
  if (ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
};

const mapEventType = (type: string) => {
  switch (type) {
    case 'session_started': return 'Sesión iniciada';
    case 'turn_resolved': return 'Turno resuelto';
    case 'clarification_requested': return 'Aclaración solicitada';
    case 'provider_fallback': return 'Fallback de proveedor';
    case 'technical_error': return 'Error técnico';
    case 'encounter_created': return 'Encuentro creado';
    case 'session_cancelled': return 'Sesión cancelada';
    default: return 'Evento';
  }
};

const formatField = (field: string) => {
  const map: Record<string, string> = {
    title: 'título',
    date: 'fecha',
    location: 'ubicación',
    description: 'descripción',
  };
  return map[field] || field.replace(/_/g, ' ');
};

const METADATA_WHITELIST = [
  'resolver',
  'turn_intent',
  'ambiguity_type',
  'ambiguity_reason',
  'error_code',
  'action_status',
  'input_length'
];

const METADATA_LABELS: Record<string, string> = {
  resolver: 'Resolver',
  turn_intent: 'Intención',
  ambiguity_type: 'Tipo de ambigüedad',
  ambiguity_reason: 'Razón',
  error_code: 'Código de error',
  action_status: 'Estado de acción',
  input_length: 'Longitud de entrada'
};

const QASessionDetail: React.FC<QASessionDetailProps> = ({ 
  serviceOverride, 
  initialData = null, 
  initialError = null, 
  initialLoading = true 
}) => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const service = serviceOverride || qaAdminService;

  const [loading, setLoading] = useState(initialLoading);
  const [error, setError] = useState<string | null>(initialError);
  const [data, setData] = useState<qaAdminService.QASessionTimelineResponse | null>(initialData);

  const fetchTimeline = async (id: string, isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const res = await service.getQASessionTimeline(id);
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Error loading timeline');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionId) {
      fetchTimeline(sessionId);
    } else {
      setLoading(false);
      setError('Sesión no disponible.');
    }
  }, [sessionId, service]);

  const handleRefresh = () => {
    if (sessionId) fetchTimeline(sessionId, true);
  };

  if (!sessionId) {
    return (
      <ScreenContainer>
        <AppBar title="Detalle de Sesión" showBack onBack={() => navigate('/internal/qa/sessions')} />
        <div className="qa-container">
          <div className="qa-state-box">
            <p>Sesión no disponible.</p>
          </div>
        </div>
      </ScreenContainer>
    );
  }

  if (loading && !data) {
    return (
      <ScreenContainer>
        <AppBar title="Detalle de Sesión" showBack onBack={() => navigate('/internal/qa/sessions')} />
        <div className="qa-container">
          <div className="qa-skeleton qa-skeleton-session"></div>
          <div className="qa-skeleton qa-skeleton-session"></div>
        </div>
      </ScreenContainer>
    );
  }

  if (error && !data) {
    return (
      <ScreenContainer>
        <AppBar title="Detalle de Sesión" showBack onBack={() => navigate('/internal/qa/sessions')} />
        <div className="qa-container">
          <div className="qa-state-box">
            <p>{error}</p>
            <button className="qa-btn-retry" onClick={handleRefresh}>Reintentar</button>
          </div>
        </div>
      </ScreenContainer>
    );
  }

  if (!data || !data.session) {
    return (
      <ScreenContainer>
        <AppBar title="Detalle de Sesión" showBack onBack={() => navigate('/internal/qa/sessions')} />
        <div className="qa-container">
          <div className="qa-state-box">
            <p>Sesión no disponible.</p>
          </div>
        </div>
      </ScreenContainer>
    );
  }

  const { session, events } = data;
  const shortId = session.id.slice(0, 8);
  const encounterShort = session.encounter_id ? session.encounter_id.slice(0, 8) : null;

  // Defensive sort
  const sortedEvents = [...events].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return (
    <ScreenContainer>
      <AppBar 
        title="Detalle de Sesión" 
        subtitle={shortId} 
        showBack 
        onBack={() => navigate('/internal/qa/sessions')}
      />
      <div className="qa-container">
        
        <div className="qa-header-row">
          <div className="qa-header-titles">
            <h1>Sesión {shortId}</h1>
            <p>{new Date(session.created_at).toLocaleString()}</p>
          </div>
          <div className="qa-controls">
            <button 
              className="qa-refresh-btn" 
              onClick={handleRefresh}
              disabled={loading}
            >
              <span>{loading ? '↻' : '↻ Actualizar'}</span>
            </button>
          </div>
        </div>

        <div className="qa-secondary-grid">
          <div className="qa-secondary-card">
            <span className="qa-secondary-card-title">Estado</span>
            <div className="qa-badges-wrap" style={{ marginTop: '4px' }}>
              <span className={`qa-badge qa-badge--status-${session.status}`}>
                {formatQAStatus(session.status)}
              </span>
            </div>
          </div>
          <div className="qa-secondary-card">
            <span className="qa-secondary-card-title">Canal</span>
            <span className="qa-secondary-card-val">
              {session.creation_source === 'ai' ? 'IA' : 'Manual'}
            </span>
          </div>
          <div className="qa-secondary-card">
            <span className="qa-secondary-card-title">Modo</span>
            <span className="qa-secondary-card-val">
              {session.date_mode === 'fixed' ? 'Fija' : session.date_mode === 'coordination' ? 'Coordinación' : 'N/A'}
            </span>
          </div>
          <div className="qa-secondary-card">
            <span className="qa-secondary-card-title">Turnos</span>
            <span className="qa-secondary-card-val">{session.turns}</span>
          </div>
          <div className="qa-secondary-card">
            <span className="qa-secondary-card-title">Duración</span>
            <span className="qa-secondary-card-val">{formatLatency(session.elapsed_ms) || '0 s'}</span>
          </div>
          <div className="qa-secondary-card">
            <span className="qa-secondary-card-title">Encuentro</span>
            <span className="qa-secondary-card-val">{encounterShort || 'N/A'}</span>
          </div>
          <div className="qa-secondary-card">
            <span className="qa-secondary-card-title">Versión FE</span>
            <span className="qa-secondary-card-val">{session.frontend_version || 'N/A'}</span>
          </div>
          <div className="qa-secondary-card">
            <span className="qa-secondary-card-title">Versión Edge</span>
            <span className="qa-secondary-card-val">{session.edge_version || 'N/A'}</span>
          </div>
        </div>

        <div>
          <h2 className="qa-section-title">Timeline</h2>
          {sortedEvents.length === 0 ? (
            <div className="qa-state-box">
              <p>No hay eventos registrados.</p>
            </div>
          ) : (
            <div className="qa-timeline">
              {sortedEvents.map((evt) => {
                let dotClass = 'qa-timeline-dot';
                if (evt.event_type === 'technical_error' || evt.result === 'technical_error') {
                  dotClass += ' qa-timeline-dot--danger';
                } else if (evt.event_type === 'provider_fallback' || evt.event_type === 'clarification_requested' || evt.result === 'needs_clarification') {
                  dotClass += ' qa-timeline-dot--warning';
                } else if (evt.event_type === 'encounter_created' || evt.result === 'success') {
                  dotClass += ' qa-timeline-dot--success';
                } else {
                  dotClass += ' qa-timeline-dot--primary';
                }

                const latency = formatLatency(evt.latency_ms);

                return (
                  <div key={evt.id} className="qa-timeline-item">
                    <div className={dotClass}></div>
                    <div className="qa-timeline-content">
                      <div className="qa-timeline-header">
                        <span className="qa-timeline-title">{mapEventType(evt.event_type)}</span>
                        <span className="qa-timeline-time">{new Date(evt.created_at).toLocaleTimeString()}</span>
                      </div>
                      
                      <div className="qa-timeline-body">
                        <div className="qa-timeline-row">
                          <span className="qa-timeline-label">Source:</span>
                          <span>{evt.source}</span>
                          {evt.provider && (
                            <>
                              <span className="qa-timeline-label" style={{marginLeft: 8}}>Provider:</span>
                              <span>{evt.provider}</span>
                            </>
                          )}
                        </div>

                        {evt.operation && (
                          <div className="qa-timeline-row">
                            <span className="qa-timeline-label">Operación:</span>
                            <span>{evt.operation}</span>
                          </div>
                        )}

                        {evt.result && (
                          <div className="qa-timeline-row">
                            <span className="qa-timeline-label">Resultado:</span>
                            <span>{evt.result}</span>
                          </div>
                        )}

                        {latency && (
                          <div className="qa-timeline-row">
                            <span className="qa-timeline-label">Latencia:</span>
                            <span>{latency}</span>
                          </div>
                        )}

                        {evt.fields_changed && evt.fields_changed.length > 0 && (
                          <div className="qa-timeline-row">
                            <span className="qa-timeline-label">Campos:</span>
                            <span>{evt.fields_changed.map(formatField).join(', ')}</span>
                          </div>
                        )}

                        {evt.metadata && Object.keys(evt.metadata).filter(k => METADATA_WHITELIST.includes(k)).length > 0 && (
                          <div className="qa-timeline-metadata">
                            {Object.entries(evt.metadata)
                              .filter(([k]) => METADATA_WHITELIST.includes(k))
                              .map(([k, v]) => (
                                <div key={k} className="qa-metadata-item">
                                  <span className="qa-metadata-key">{METADATA_LABELS[k] || k}:</span>
                                  <span>
                                    {k === 'input_length' 
                                      ? `${v} caracteres` 
                                      : (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? String(v) : 'Complex'
                                    }
                                  </span>
                                </div>
                              ))
                            }
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </ScreenContainer>
  );
};

export default QASessionDetail;
