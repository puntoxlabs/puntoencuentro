import React, { useState, useEffect, useCallback } from 'react';
import {
  getQAUserFeedback,
  updateQAFeedbackStatus,
  type QAUserFeedbackItem,
} from '../../services/qaAdminService';
import { formatQADateTime } from './index';

interface QAUserFeedbackSectionProps {
  periodDays: number;
}

export const QAUserFeedbackSection: React.FC<QAUserFeedbackSectionProps> = ({ periodDays }) => {
  const [feedback, setFeedback] = useState<QAUserFeedbackItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<'issue' | 'suggestion' | 'general' | null>(null);
  const [statusFilter, setStatusFilter] = useState<'unread' | 'reviewed' | 'archived' | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const loadFeedback = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getQAUserFeedback(periodDays, categoryFilter, statusFilter, 50, 0);
      setFeedback(res.feedback || []);
    } catch {
      setError('No se pudo cargar el feedback de usuarios.');
    } finally {
      setLoading(false);
    }
  }, [periodDays, categoryFilter, statusFilter]);

  useEffect(() => {
    loadFeedback();
  }, [loadFeedback]);

  const handleStatusChange = async (
    item: QAUserFeedbackItem,
    newStatus: 'unread' | 'reviewed' | 'archived'
  ) => {
    setUpdatingId(item.id);
    try {
      await updateQAFeedbackStatus(item.id, newStatus);
      setFeedback((prev) =>
        prev.map((f) => (f.id === item.id ? { ...f, status: newStatus } : f))
      );
    } catch {
      alert('Error al actualizar estado del feedback.');
    } finally {
      setUpdatingId(null);
    }
  };

  const getCategoryBadge = (cat: string) => {
    switch (cat) {
      case 'issue':
        return <span className="qa-badge qa-badge--problematic">⚠️ Problema</span>;
      case 'suggestion':
        return <span className="qa-badge qa-badge--review">💡 Mejora</span>;
      case 'general':
      default:
        return <span className="qa-badge qa-badge--status-started">💬 Opinión</span>;
    }
  };

  const getStatusBadge = (st: string) => {
    switch (st) {
      case 'unread':
        return <span className="qa-badge" style={{ background: '#fef3c7', color: '#92400e' }}>Nuevo</span>;
      case 'reviewed':
        return <span className="qa-badge qa-badge--status-completed">Revisado</span>;
      case 'archived':
        return <span className="qa-badge" style={{ background: '#f3f4f6', color: '#6b7280' }}>Archivado</span>;
      default:
        return <span className="qa-badge">{st}</span>;
    }
  };

  return (
    <section aria-label="Feedback recibido de usuarios" style={{ marginTop: '32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
        <h2 className="qa-section-title" style={{ marginBottom: 0 }}>
          Feedback de Usuarios ({feedback.length})
        </h2>
        <button
          type="button"
          className="qa-refresh-btn"
          onClick={loadFeedback}
          disabled={loading}
          title="Actualizar feedback"
        >
          🔄 Actualizar
        </button>
      </div>

      {/* Filtros de Categoría y Estado */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div className="qa-period-selector" role="group" aria-label="Filtro de categoría">
          <button
            type="button"
            className={`qa-period-btn ${categoryFilter === null ? 'qa-period-btn--active' : ''}`}
            onClick={() => setCategoryFilter(null)}
          >
            Todas categorías
          </button>
          <button
            type="button"
            className={`qa-period-btn ${categoryFilter === 'issue' ? 'qa-period-btn--active' : ''}`}
            onClick={() => setCategoryFilter('issue')}
          >
            Problemas
          </button>
          <button
            type="button"
            className={`qa-period-btn ${categoryFilter === 'suggestion' ? 'qa-period-btn--active' : ''}`}
            onClick={() => setCategoryFilter('suggestion')}
          >
            Mejoras
          </button>
          <button
            type="button"
            className={`qa-period-btn ${categoryFilter === 'general' ? 'qa-period-btn--active' : ''}`}
            onClick={() => setCategoryFilter('general')}
          >
            Generales
          </button>
        </div>

        <div className="qa-period-selector" role="group" aria-label="Filtro de estado">
          <button
            type="button"
            className={`qa-period-btn ${statusFilter === null ? 'qa-period-btn--active' : ''}`}
            onClick={() => setStatusFilter(null)}
          >
            Todos estados
          </button>
          <button
            type="button"
            className={`qa-period-btn ${statusFilter === 'unread' ? 'qa-period-btn--active' : ''}`}
            onClick={() => setStatusFilter('unread')}
          >
            Nuevos
          </button>
          <button
            type="button"
            className={`qa-period-btn ${statusFilter === 'reviewed' ? 'qa-period-btn--active' : ''}`}
            onClick={() => setStatusFilter('reviewed')}
          >
            Revisados
          </button>
          <button
            type="button"
            className={`qa-period-btn ${statusFilter === 'archived' ? 'qa-period-btn--active' : ''}`}
            onClick={() => setStatusFilter('archived')}
          >
            Archivados
          </button>
        </div>
      </div>

      {error && (
        <div className="qa-state-box">
          <p>{error}</p>
          <button type="button" className="qa-btn-retry" onClick={loadFeedback}>
            Reintentar
          </button>
        </div>
      )}

      {loading && (
        <div className="qa-sessions-list">
          <div className="qa-skeleton qa-skeleton-session" />
          <div className="qa-skeleton qa-skeleton-session" />
        </div>
      )}

      {!loading && !error && feedback.length === 0 && (
        <div className="qa-state-box">
          <p>No se registraron opiniones de usuarios con los filtros seleccionados en los últimos {periodDays} días.</p>
        </div>
      )}

      {!loading && !error && feedback.length > 0 && (
        <div className="qa-sessions-list">
          {feedback.map((item) => (
            <article key={item.id} className="qa-session-card" style={{ padding: '16px' }}>
              <div className="qa-session-top" style={{ marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span className="qa-session-time">{formatQADateTime(item.created_at)}</span>
                  {item.page_route && (
                    <span style={{ fontSize: '0.8rem', color: 'var(--color-outline)', background: 'var(--color-surface-variant)', padding: '2px 6px', borderRadius: '4px' }}>
                      Ruta: {item.page_route}
                    </span>
                  )}
                </div>

                <div className="qa-badges-wrap">
                  {getCategoryBadge(item.category)}
                  {getStatusBadge(item.status)}
                </div>
              </div>

              {/* Contenido del comentario */}
              <p style={{ margin: '8px 0 12px 0', fontSize: '0.95rem', lineHeight: 1.5, color: 'var(--color-on-surface)', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                {item.comment}
              </p>

              {/* Acciones de moderación de feedback */}
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', borderTop: '1px solid var(--color-outline-variant)', paddingTop: '8px' }}>
                {item.status !== 'reviewed' && (
                  <button
                    type="button"
                    className="qa-period-btn"
                    style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                    disabled={updatingId === item.id}
                    onClick={() => handleStatusChange(item, 'reviewed')}
                  >
                    ✓ Marcar revisado
                  </button>
                )}
                {item.status !== 'archived' && (
                  <button
                    type="button"
                    className="qa-period-btn"
                    style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                    disabled={updatingId === item.id}
                    onClick={() => handleStatusChange(item, 'archived')}
                  >
                    📦 Archivar
                  </button>
                )}
                {item.status !== 'unread' && (
                  <button
                    type="button"
                    className="qa-period-btn"
                    style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                    disabled={updatingId === item.id}
                    onClick={() => handleStatusChange(item, 'unread')}
                  >
                    ↩ Volver a nuevo
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
};
