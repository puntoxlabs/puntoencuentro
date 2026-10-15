import React, { useState, useEffect, useCallback } from 'react';
import { ScreenContainer } from '../../components/ui/ScreenContainer';
import { AppBar } from '../../components/ui/AppBar';
import { Button } from '../../components/ui/Button';
import { getModerationQueue, resolverModeracion } from '../../services/moderationAdminService';
import type { ModerationQueueItem } from '../../types/trust';
import './InternalModeration.css';

export const REJECTION_PRESETS = [
  'Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.',
  'El contenido incluye información de contacto o datos personales que deben mantenerse privados hasta confirmar asistencia.',
  'La publicación contiene enlaces externos o publicidad no permitida en el contenido público.',
  'La publicación contiene elementos comerciales o promocionales no permitidos en Discovery.',
  'El texto no cumple con las pautas de respeto y convivencia de la comunidad.',
];

export const formatModerationReason = (reason?: string | null): string => {
  if (!reason) return 'Revisión por publicación o edición';
  switch (reason) {
    case 'unsupported_language':
      return 'Idioma no soportado (requiere revisión)';
    case 'gibberish':
      return 'Texto incomprensible o aleatorio';
    case 'excessive_symbols':
      return 'Uso excesivo de símbolos o caracteres repetidos';
    case 'external_contact':
      return 'Datos de contacto externos detectados';
    case 'obfuscated_contact':
      return 'Contacto ofuscado o indirecto';
    case 'commercial_spam':
      return 'Contenido comercial o publicitario';
    case 'duplicate_content':
      return 'Publicación duplicada o similar del mismo anfitrión';
    case 'duplicate_content_burst':
      return 'Ráfaga o volumen anormal de duplicados';
    case 'suspicious_url':
      return 'Enlace sospechoso o acortador externo';
    case 'possible_scam':
      return 'Posible estafa o captación engañosa';
    case 'low_information_content':
      return 'Contenido escaso o con baja información';
    case 'contains_link':
      return 'Contiene enlace externo';
    case 'contains_personal_contact_data':
      return 'Datos personales de contacto';
    case 'sensitive_terms_ambiguous':
      return 'Términos sensibles (verificar contexto)';
    case 'malicious_payload':
      return 'Código o script malicioso';
    case 'violence_threat':
      return 'Amenaza de violencia física';
    case 'illegal_activity':
      return 'Actividad ilícita o no permitida';
    default:
      return reason;
  }
};

export const InternalModerationScreen: React.FC = () => {
  const [queue, setQueue] = useState<ModerationQueueItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCase, setSelectedCase] = useState<ModerationQueueItem | null>(null);

  // Modal de confirmación
  const [confirmAction, setConfirmAction] = useState<'approve' | 'reject' | null>(null);
  const [rejectReasonPreset, setRejectReasonPreset] = useState<string>(REJECTION_PRESETS[0]);
  const [customRejectReason, setCustomRejectReason] = useState<string>('');
  const [useCustomReason, setUseCustomReason] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getModerationQueue();
      if (res.ok) {
        setQueue(res.queue || []);
        // Si el caso actualmente abierto fue resuelto, cerrarlo
        if (selectedCase && !(res.queue || []).some((item) => item.id === selectedCase.id)) {
          setSelectedCase(null);
        }
      } else {
        setError(res.error || 'Error al obtener la cola de moderación');
      }
    } catch (err: any) {
      setError(err?.message || 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, [selectedCase]);

  useEffect(() => {
    loadQueue();
  }, []);

  const handleOpenCase = (item: ModerationQueueItem) => {
    setSelectedCase(item);
    setFeedbackMsg(null);
    setConfirmAction(null);
  };

  const handleStartApprove = () => {
    setConfirmAction('approve');
    setFeedbackMsg(null);
  };

  const handleStartReject = () => {
    setConfirmAction('reject');
    setRejectReasonPreset(REJECTION_PRESETS[0]);
    setCustomRejectReason('');
    setUseCustomReason(false);
    setFeedbackMsg(null);
  };

  const handleCancelConfirmation = () => {
    setConfirmAction(null);
  };

  const handleExecuteResolution = async () => {
    if (!selectedCase || !confirmAction) return;

    setActionLoading(true);
    setFeedbackMsg(null);

    const note =
      confirmAction === 'reject'
        ? useCustomReason
          ? customRejectReason.trim()
          : rejectReasonPreset
        : undefined;

    try {
      const res = await resolverModeracion(
        selectedCase.id,
        confirmAction,
        note,
        selectedCase.content_hash ?? undefined
      );

      if (res.ok) {
        setFeedbackMsg({
          type: 'success',
          text:
            confirmAction === 'approve'
              ? 'El encuentro fue aprobado exitosamente y notificado al anfitrión.'
              : 'El encuentro fue rechazado. Se notificó al anfitrión con el motivo especificado.',
        });
        setConfirmAction(null);
        setSelectedCase(null);
        await loadQueue();
      } else if (res.error === 'already_resolved') {
        setFeedbackMsg({
          type: 'warning',
          text: 'Este caso ya fue resuelto por otro moderador.',
        });
        setConfirmAction(null);
        await loadQueue();
      } else if (res.error === 'content_hash_mismatch') {
        setFeedbackMsg({
          type: 'warning',
          text: 'El contenido fue modificado por el anfitrión mientras estaba en revisión. Se recargará el caso con la última versión.',
        });
        setConfirmAction(null);
        await loadQueue();
      } else {
        setFeedbackMsg({
          type: 'error',
          text: res.message || res.error || 'No se pudo resolver el caso',
        });
      }
    } catch (err: any) {
      setFeedbackMsg({
        type: 'error',
        text: err?.message || 'Error técnico al ejecutar la resolución',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const formatReviewDate = (iso?: string | null) => {
    if (!iso) return '-';
    try {
      const d = new Date(iso);
      return d.toLocaleString('es-AR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '-';
    }
  };

  return (
    <ScreenContainer>
      <AppBar title="Moderación" showBack onBack={() => window.history.back()} />

      <div className="moderation-container">
        {/* Encabezado */}
        <header className="moderation-header">
          <div>
            <h1 className="moderation-title">Moderación</h1>
            <p className="moderation-subtitle">Contenido público pendiente de revisión</p>
          </div>
          <div className="moderation-badge-count">
            {loading ? 'Cargando...' : `${queue.length} ${queue.length === 1 ? 'pendiente' : 'pendientes'}`}
          </div>
        </header>

        {/* Notificaciones globales */}
        {feedbackMsg && (
          <div className={`moderation-alert moderation-alert--${feedbackMsg.type}`}>
            {feedbackMsg.text}
          </div>
        )}

        {error && (
          <div className="moderation-alert moderation-alert--error">
            {error}
            <button type="button" onClick={loadQueue} className="moderation-retry-btn">
              Reintentar
            </button>
          </div>
        )}

        {/* Vista principal: Listado y Detalle */}
        <div className="moderation-grid">
          {/* Columna 1: Lista de Casos */}
          <div className="moderation-list-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h2 className="moderation-section-title">Pendientes de revisión</h2>
              <button
                type="button"
                className="moderation-refresh-btn"
                onClick={loadQueue}
                disabled={loading}
              >
                🔄 Actualizar
              </button>
            </div>

            {loading && queue.length === 0 ? (
              <div className="moderation-empty-state">Cargando cola de moderación...</div>
            ) : queue.length === 0 ? (
              <div className="moderation-empty-state">
                <span style={{ fontSize: '24px', display: 'block', marginBottom: '8px' }}>✨</span>
                No hay casos pendientes.
              </div>
            ) : (
              <div className="moderation-cards">
                {queue.map((item) => {
                  const isSelected = selectedCase?.id === item.id;
                  return (
                    <article
                      key={item.id}
                      className={`moderation-card ${isSelected ? 'moderation-card--selected' : ''}`}
                      onClick={() => handleOpenCase(item)}
                    >
                      <div className="moderation-card-header">
                        <span className="moderation-card-modality">
                          {item.modalidad === 'virtual' ? '🌐 Virtual' : '📍 Presencial'}
                        </span>
                        <span className="moderation-card-date">
                          Entró: {formatReviewDate(item.opened_at || item.created_at)}
                        </span>
                      </div>

                      <h3 className="moderation-card-title">
                        {item.open_public_title || item.titulo || 'Sin título público'}
                      </h3>

                      <p className="moderation-card-snippet">
                        {item.open_description || 'Sin descripción pública cargada.'}
                      </p>

                      <div className="moderation-card-meta">
                        {item.open_public_zone && (
                          <span className="moderation-meta-tag">Zona: {item.open_public_zone}</span>
                        )}
                        {item.moderation_reason && (
                          <span className="moderation-meta-tag moderation-meta-tag--reason">
                            Motivo: {formatModerationReason(item.moderation_reason)}
                          </span>
                        )}
                        {item.report_count > 0 && (
                          <span className="moderation-meta-tag moderation-meta-tag--report">
                            ⚠️ {item.report_count} {item.report_count === 1 ? 'reporte' : 'reportes'}
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {/* Columna 2: Detalle del Caso Seleccionado */}
          <div className="moderation-detail-panel">
            {!selectedCase ? (
              <div className="moderation-detail-placeholder">
                <span style={{ fontSize: '32px', marginBottom: '8px' }}>👈</span>
                <p>Seleccioná un caso de la lista para evaluarlo.</p>
              </div>
            ) : (
              <div className="moderation-detail-card">
                <div className="moderation-detail-header">
                  <div>
                    <span className="moderation-card-modality">
                      {selectedCase.modalidad === 'virtual' ? '🌐 Encuentro Virtual' : '📍 Encuentro Presencial'}
                    </span>
                    <h2 className="moderation-detail-title">
                      {selectedCase.open_public_title || selectedCase.titulo || 'Sin título'}
                    </h2>
                  </div>
                  <span className="moderation-status-pill">
                    {selectedCase.moderation_status}
                  </span>
                </div>

                <div className="moderation-field-group">
                  <label className="moderation-field-label">Descripción pública completa</label>
                  <div className="moderation-field-box">
                    {selectedCase.open_description || '—'}
                  </div>
                </div>

                <div className="moderation-field-row">
                  <div className="moderation-field-group">
                    <label className="moderation-field-label">Zona pública</label>
                    <div className="moderation-field-value">{selectedCase.open_public_zone || '—'}</div>
                  </div>
                  <div className="moderation-field-group">
                    <label className="moderation-field-label">Fecha y hora pública</label>
                    <div className="moderation-field-value">
                      {selectedCase.fecha ? `${selectedCase.fecha} ${selectedCase.hora ? `· ${selectedCase.hora.substring(0, 5)}` : ''}` : '—'}
                    </div>
                  </div>
                </div>

                {/* Señales automáticas y motivo de review */}
                <div className="moderation-signals-box">
                  <h4 style={{ margin: '0 0 6px 0', fontSize: '13px', fontWeight: 600 }}>Señales de moderación</h4>
                  <div style={{ fontSize: '12px', lineHeight: 1.5 }}>
                    <div><strong>Motivo inicial:</strong> {formatModerationReason(selectedCase.moderation_reason)}</div>
                    {selectedCase.moderation_categories && selectedCase.moderation_categories.length > 0 && (
                      <div><strong>Categorías detectadas:</strong> {selectedCase.moderation_categories.join(', ')}</div>
                    )}
                    {selectedCase.report_count > 0 && (
                      <div style={{ color: '#DC2626', marginTop: '4px' }}>
                        <strong>Reportes comunitarios:</strong> {selectedCase.report_count} (motivos: {selectedCase.report_reasons?.join(', ') || 'sin detalle'})
                      </div>
                    )}
                  </div>
                </div>

                {/* Formulario / Diálogo de Confirmación */}
                {confirmAction ? (
                  <div className="moderation-confirm-box">
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 700 }}>
                      {confirmAction === 'approve'
                        ? '¿Confirmás aprobar esta publicación?'
                        : '¿Confirmás rechazar esta publicación?'}
                    </h4>

                    {confirmAction === 'approve' ? (
                      <p style={{ fontSize: '13px', color: 'var(--color-on-surface-variant, #4B5162)', marginBottom: '14px' }}>
                        Al aprobar, si el encuentro continúa activo y no cancelado, quedará visible en Discovery y se notificará al anfitrión.
                      </p>
                    ) : (
                      <div style={{ marginBottom: '14px' }}>
                        <p style={{ fontSize: '13px', color: 'var(--color-on-surface-variant, #4B5162)', marginBottom: '8px' }}>
                          Seleccioná o redactá un motivo claro y constructivo para el anfitrión:
                        </p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
                          {REJECTION_PRESETS.map((preset, idx) => (
                            <label key={idx} style={{ fontSize: '12px', display: 'flex', gap: '8px', cursor: 'pointer' }}>
                              <input
                                type="radio"
                                name="reject-preset"
                                checked={!useCustomReason && rejectReasonPreset === preset}
                                onChange={() => {
                                  setUseCustomReason(false);
                                  setRejectReasonPreset(preset);
                                }}
                              />
                              <span>{preset}</span>
                            </label>
                          ))}
                          <label style={{ fontSize: '12px', display: 'flex', gap: '8px', cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name="reject-preset"
                              checked={useCustomReason}
                              onChange={() => setUseCustomReason(true)}
                            />
                            <span>Escribir otro motivo...</span>
                          </label>
                        </div>

                        {useCustomReason && (
                          <textarea
                            rows={3}
                            placeholder="Explicá en tono respetuoso qué cambios requiere la publicación..."
                            value={customRejectReason}
                            onChange={(e) => setCustomRejectReason(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '8px',
                              borderRadius: '6px',
                              border: '1px solid var(--color-outline-variant, #D1D5DB)',
                              fontSize: '13px',
                              boxSizing: 'border-box',
                            }}
                          />
                        )}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                      <Button
                        variant="ghost"
                        onClick={handleCancelConfirmation}
                        disabled={actionLoading}
                        style={{ fontSize: '13px' }}
                      >
                        Cancelar
                      </Button>
                      <Button
                        variant={confirmAction === 'approve' ? 'primary' : 'outline'}
                        onClick={handleExecuteResolution}
                        disabled={actionLoading || (confirmAction === 'reject' && useCustomReason && !customRejectReason.trim())}
                        style={{
                          fontSize: '13px',
                          color: confirmAction === 'reject' ? '#DC2626' : undefined,
                          borderColor: confirmAction === 'reject' ? '#FCA5A5' : undefined,
                        }}
                      >
                        {actionLoading ? 'Procesando...' : confirmAction === 'approve' ? 'Confirmar Aprobación' : 'Confirmar Rechazo'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  /* Barra de Acciones */
                  <div className="moderation-actions-bar">
                    <Button
                      variant="outline"
                      onClick={handleStartReject}
                      style={{ color: '#DC2626', borderColor: '#FCA5A5' }}
                    >
                      ✕ Rechazar
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handleStartApprove}
                    >
                      ✓ Aprobar
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </ScreenContainer>
  );
};

export default InternalModerationScreen;
