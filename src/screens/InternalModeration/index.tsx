import React, { useState, useEffect, useCallback } from 'react';
import { ScreenContainer } from '../../components/ui/ScreenContainer';
import { AppBar } from '../../components/ui/AppBar';
import { Button } from '../../components/ui/Button';
import {
  getModerationQueue,
  resolverModeracion,
  getControversiasModeracionQueue,
  resolverControversiaModeracion,
} from '../../services/moderationAdminService';
import { useAuth } from '@/contexts/AuthContext';
import type { ModerationQueueItem } from '../../types/trust';
import type { AttendanceDisputeItem, AttendanceDisputeResolution } from '@/types/attendanceDispute';
import { ShieldAlert, CheckCircle2 } from 'lucide-react';
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

export const formatDisputeStatus = (status: string): string => {
  switch (status) {
    case 'awaiting_response':
      return 'Esperando respuesta (plazo 7 días)';
    case 'in_human_review':
      return 'En revisión por moderador';
    case 'confirmed_by_participant':
      return 'Confirmado por participante';
    case 'unverified_timeout':
      return 'Sin respuesta (neutral no verificado)';
    case 'rectified':
      return 'Rectificado por moderador';
    case 'dismissed':
      return 'Desestimado';
    case 'justified':
      return 'Inasistencia justificada';
    case 'confirmed':
      return 'Inasistencia confirmada';
    case 'registration_error':
      return 'Error de registro corregido';
    case 'insufficient_evidence':
      return 'Evidencia insuficiente';
    default:
      return status;
  }
};

export const InternalModerationScreen: React.FC = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'public' | 'disputes'>('public');

  // --- Public Content Moderation State ---
  const [queue, setQueue] = useState<ModerationQueueItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCase, setSelectedCase] = useState<ModerationQueueItem | null>(null);

  // Modal de confirmación contenido público
  const [confirmAction, setConfirmAction] = useState<'approve' | 'reject' | null>(null);
  const [rejectReasonPreset, setRejectReasonPreset] = useState<string>(REJECTION_PRESETS[0]);
  const [customRejectReason, setCustomRejectReason] = useState<string>('');
  const [useCustomReason, setUseCustomReason] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);

  // --- Attendance Disputes State ---
  const [disputesQueue, setDisputesQueue] = useState<AttendanceDisputeItem[]>([]);
  const [disputesLoading, setDisputesLoading] = useState<boolean>(false);
  const [disputesError, setDisputesError] = useState<string | null>(null);
  const [selectedDispute, setSelectedDispute] = useState<AttendanceDisputeItem | null>(null);
  const [disputeFilter, setDisputeFilter] = useState<string>('all');
  const [disputeResolution, setDisputeResolution] = useState<AttendanceDisputeResolution>('justified');
  const [disputeNotes, setDisputeNotes] = useState<string>('');
  const [disputeResolving, setDisputeResolving] = useState<boolean>(false);

  // Carga de contenido público
  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getModerationQueue();
      if (res.ok) {
        setQueue(res.queue || []);
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

  // Carga de controversias de asistencia
  const loadDisputes = useCallback(async () => {
    setDisputesLoading(true);
    setDisputesError(null);
    try {
      const filter = disputeFilter === 'all' ? undefined : disputeFilter;
      const res = await getControversiasModeracionQueue(filter);
      if (res.ok) {
        setDisputesQueue(res.queue || []);
        if (selectedDispute && !(res.queue || []).some((d: AttendanceDisputeItem) => d.id === selectedDispute.id)) {
          setSelectedDispute(null);
        }
      } else {
        setDisputesError(res.error || 'Error al cargar las controversias');
      }
    } catch (err: any) {
      setDisputesError(err?.message || 'Error de conexión con controversias');
    } finally {
      setDisputesLoading(false);
    }
  }, [disputeFilter, selectedDispute]);

  useEffect(() => {
    if (activeTab === 'public') {
      loadQueue();
    } else {
      loadDisputes();
    }
  }, [activeTab, disputeFilter]);

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

  const handleResolveDispute = async () => {
    if (!selectedDispute) return;
    if (!disputeNotes.trim()) {
      setFeedbackMsg({
        type: 'warning',
        text: 'Es obligatorio indicar la fundamentación de la resolución para el registro de auditoría.',
      });
      return;
    }

    setDisputeResolving(true);
    setFeedbackMsg(null);

    try {
      const res = await resolverControversiaModeracion(
        selectedDispute.id,
        disputeResolution,
        disputeNotes.trim()
      );

      if (res.ok) {
        setFeedbackMsg({
          type: 'success',
          text: 'Controversia resuelta y auditada exitosamente.',
        });
        setDisputeNotes('');
        await loadDisputes();
      } else if (res.error === 'conflict_of_interest') {
        setFeedbackMsg({
          type: 'error',
          text: 'Acción bloqueada: Conflicto de interés detectado. Como anfitrión o participante, no podés resolver esta controversia.',
        });
      } else {
        setFeedbackMsg({
          type: 'error',
          text: res.message || res.error || 'No se pudo resolver la controversia',
        });
      }
    } catch (err: any) {
      setFeedbackMsg({
        type: 'error',
        text: err?.message || 'Error al procesar la resolución de la controversia',
      });
    } finally {
      setDisputeResolving(false);
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

  // Verificación estricta de conflicto de interés en la UI
  const isConflictOfInterest = Boolean(
    user?.id &&
      selectedDispute &&
      (user.id === selectedDispute.iniciado_por ||
        user.id === selectedDispute.involucrado_id ||
        user.id === selectedDispute.host_id)
  );

  return (
    <ScreenContainer>
      <AppBar title="Moderación" showBack onBack={() => window.history.back()} />

      <div className="moderation-container">
        {/* Encabezado */}
        <header className="moderation-header">
          <div>
            <h1 className="moderation-title">Panel de Moderación</h1>
            <p className="moderation-subtitle">Revisión de contenidos públicos y resolución justa de controversias</p>
          </div>
          <div className="moderation-badge-count">
            {activeTab === 'public'
              ? `${queue.length} ${queue.length === 1 ? 'pendiente' : 'pendientes'}`
              : `${disputesQueue.length} ${disputesQueue.length === 1 ? 'controversia' : 'controversias'}`}
          </div>
        </header>

        {/* Selector de pestañas */}
        <nav className="moderation-tabs" aria-label="Secciones de moderación">
          <button
            type="button"
            className={`moderation-tab-btn ${activeTab === 'public' ? 'moderation-tab-btn--active' : ''}`}
            onClick={() => {
              setActiveTab('public');
              setFeedbackMsg(null);
            }}
          >
            Contenido Público ({queue.length})
          </button>
          <button
            type="button"
            className={`moderation-tab-btn ${activeTab === 'disputes' ? 'moderation-tab-btn--active' : ''}`}
            onClick={() => {
              setActiveTab('disputes');
              setFeedbackMsg(null);
            }}
          >
            Controversias de Asistencia ({disputesQueue.length})
          </button>
        </nav>

        {/* Notificaciones globales */}
        {feedbackMsg && (
          <div className={`moderation-alert moderation-alert--${feedbackMsg.type}`}>
            {feedbackMsg.text}
          </div>
        )}

        {/* TAB 1: CONTENIDO PÚBLICO */}
        {activeTab === 'public' && (
          <>
            {error && (
              <div className="moderation-alert moderation-alert--error">
                {error}
                <button type="button" onClick={loadQueue} className="moderation-retry-btn">
                  Reintentar
                </button>
              </div>
            )}

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
                    No hay casos de contenido público pendientes.
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
          </>
        )}

        {/* TAB 2: CONTROVERSIAS DE ASISTENCIA Y REALIZACIÓN */}
        {activeTab === 'disputes' && (
          <>
            {disputesError && (
              <div className="moderation-alert moderation-alert--error">
                {disputesError}
                <button type="button" onClick={loadDisputes} className="moderation-retry-btn">
                  Reintentar
                </button>
              </div>
            )}

            <div className="moderation-grid">
              {/* Columna 1: Lista de Controversias */}
              <div className="moderation-list-panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h2 className="moderation-section-title">Controversias de Asistencia</h2>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <select
                      value={disputeFilter}
                      onChange={(e) => setDisputeFilter(e.target.value)}
                      style={{
                        padding: '4px 8px',
                        fontSize: '12px',
                        borderRadius: '6px',
                        border: '1px solid var(--color-outline-variant, #E1E3EA)',
                      }}
                    >
                      <option value="all">Todas</option>
                      <option value="in_human_review">En revisión</option>
                      <option value="awaiting_response">Esperando respuesta</option>
                      <option value="rectified">Rectificadas</option>
                      <option value="unverified_timeout">Vencidas sin respuesta</option>
                    </select>
                    <button
                      type="button"
                      className="moderation-refresh-btn"
                      onClick={loadDisputes}
                      disabled={disputesLoading}
                    >
                      🔄
                    </button>
                  </div>
                </div>

                {disputesLoading && disputesQueue.length === 0 ? (
                  <div className="moderation-empty-state">Cargando controversias...</div>
                ) : disputesQueue.length === 0 ? (
                  <div className="moderation-empty-state">
                    <CheckCircle2 size={24} style={{ color: '#16a34a', margin: '0 auto 8px', display: 'block' }} />
                    No hay controversias pendientes en este filtro.
                  </div>
                ) : (
                  <div className="moderation-cards">
                    {disputesQueue.map((item) => {
                      const isSelected = selectedDispute?.id === item.id;
                      const isRealization = item.tipo_controversia !== 'absence_reported';

                      return (
                        <article
                          key={item.id}
                          className={`moderation-card ${isSelected ? 'moderation-card--selected' : ''}`}
                          onClick={() => {
                            setSelectedDispute(item);
                            setFeedbackMsg(null);
                          }}
                        >
                          <div className="moderation-card-header">
                            <span className="moderation-card-modality">
                              {isRealization ? '⚠️ Realización' : '👤 Asistencia'}
                            </span>
                            <span className="moderation-card-date">
                              {formatReviewDate(item.created_at)}
                            </span>
                          </div>

                          <h3 className="moderation-card-title">
                            {item.encuentro_title || 'Encuentro sin título'}
                          </h3>

                          <p className="moderation-card-snippet">
                            <strong>Tipo / Motivo: </strong> {item.tipo_controversia} {item.descargo_tipo ? `(${item.descargo_tipo})` : ''}
                          </p>

                          <div className="moderation-card-meta">
                            <span className={`moderation-meta-tag ${
                              item.estado === 'in_human_review'
                                ? 'moderation-meta-tag--review'
                                : item.estado === 'awaiting_response'
                                ? 'moderation-meta-tag--waiting'
                                : 'moderation-meta-tag--resolved'
                            }`}>
                              {formatDisputeStatus(item.estado)}
                            </span>

                            {item.participante_nombre && (
                              <span className="moderation-meta-tag">
                                Participante: {item.participante_nombre}
                              </span>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Columna 2: Detalle de la Controversia */}
              <div className="moderation-detail-panel">
                {!selectedDispute ? (
                  <div className="moderation-detail-placeholder">
                    <span style={{ fontSize: '32px', marginBottom: '8px' }}>👈</span>
                    <p>Seleccioná una controversia para examinar el descargo y resolverla.</p>
                  </div>
                ) : (
                  <div className="moderation-detail-card">
                    <div className="moderation-detail-header">
                      <div>
                        <span className="moderation-card-modality">
                          {selectedDispute.tipo_controversia === 'encounter_not_realized' ||
                          selectedDispute.tipo_controversia === 'host_no_show' ||
                          selectedDispute.tipo_controversia === 'closure_data_error'
                            ? 'Controversia de Realización'
                            : 'Controversia de Registro de Asistencia'}
                        </span>
                        <h2 className="moderation-detail-title">
                          {selectedDispute.encuentro_title}
                        </h2>
                      </div>
                      <span className="moderation-status-pill">
                        {formatDisputeStatus(selectedDispute.estado)}
                      </span>
                    </div>

                    {/* Partes y contexto */}
                    <div className="moderation-field-row">
                      <div className="moderation-field-group">
                        <label className="moderation-field-label">Participante involucrado</label>
                        <div className="moderation-field-value">
                          {selectedDispute.participante_nombre || selectedDispute.involucrado_id}
                        </div>
                      </div>
                      <div className="moderation-field-group">
                        <label className="moderation-field-label">Anfitrión del encuentro</label>
                        <div className="moderation-field-value">
                          {selectedDispute.host_nombre || selectedDispute.host_id}
                        </div>
                      </div>
                    </div>

                    <div className="moderation-field-group">
                      <label className="moderation-field-label">Tipo de controversia</label>
                      <div className="moderation-field-box">
                        {selectedDispute.tipo_controversia}
                      </div>
                    </div>

                    {/* Descargo del participante */}
                    {selectedDispute.descargo_texto && (
                      <div className="moderation-field-group">
                        <label className="moderation-field-label">Descargo o testimonio del participante</label>
                        <div className="moderation-field-box" style={{ background: '#F0F9FF', borderColor: '#BAE6FD' }}>
                          {selectedDispute.descargo_texto}
                        </div>
                      </div>
                    )}

                    {/* Aclaración del anfitrión */}
                    {selectedDispute.explicacion_contraparte && (
                      <div className="moderation-field-group">
                        <label className="moderation-field-label">Aclaración aportada por el anfitrión</label>
                        <div className="moderation-field-box" style={{ background: '#F0FDF4', borderColor: '#BBF7D0' }}>
                          {selectedDispute.explicacion_contraparte}
                        </div>
                      </div>
                    )}

                    {/* Alerta de Conflicto de Interés */}
                    {isConflictOfInterest ? (
                      <div className="moderation-alert moderation-alert--warning" style={{ margin: '20px 0' }}>
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                          <ShieldAlert size={22} style={{ flexShrink: 0, marginTop: '2px', color: '#B45309' }} />
                          <div>
                            <strong>Conflicto de interés detectado: </strong>
                            Tu usuario se encuentra registrado como parte involucrada (anfitrión, participante o iniciador) en este caso.
                            <br />
                            Por política de integridad y debida neutralidad, esta controversia debe ser evaluada y resuelta exclusivamente por otro moderador independiente.
                          </div>
                        </div>
                      </div>
                    ) : selectedDispute.estado === 'rectified' ||
                      selectedDispute.estado === 'confirmed_by_participant' ||
                      selectedDispute.estado === 'resolved_justified' ||
                      selectedDispute.estado === 'resolved_unjustified' ||
                      selectedDispute.estado === 'resolved_registration_error' ||
                      selectedDispute.estado === 'dismissed_insufficient_evidence' ? (
                      <div className="moderation-signals-box">
                        <h4 style={{ margin: '0 0 6px 0', fontSize: '13px', fontWeight: 600 }}>Caso ya finalizado</h4>
                        <p style={{ margin: 0, fontSize: '12px' }}>
                          Resolución: <strong>{selectedDispute.resolucion_tipo || formatDisputeStatus(selectedDispute.estado)}</strong>
                          {selectedDispute.resolucion_fundamentacion && (
                            <span> · Fundamento: {selectedDispute.resolucion_fundamentacion}</span>
                          )}
                        </p>
                      </div>
                    ) : (
                      /* Formulario de resolución de controversia */
                      <div className="moderation-confirm-box" style={{ marginTop: '20px' }}>
                        <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 700 }}>
                          Resolución de moderación independiente
                        </h4>

                        <div style={{ marginBottom: '14px' }}>
                          <label className="moderation-field-label">Dictamen de asistencia</label>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                            <label style={{ display: 'flex', gap: '8px', cursor: 'pointer' }}>
                              <input
                                type="radio"
                                name="dispute-res"
                                value="justified"
                                checked={disputeResolution === 'justified'}
                                onChange={() => setDisputeResolution('justified')}
                              />
                              <span>
                                <strong>Inasistencia justificada (con aviso / fuerza mayor): </strong>
                                Se asienta como ausencia con aviso previo.
                              </span>
                            </label>

                            <label style={{ display: 'flex', gap: '8px', cursor: 'pointer' }}>
                              <input
                                type="radio"
                                name="dispute-res"
                                value="registration_error"
                                checked={disputeResolution === 'registration_error'}
                                onChange={() => setDisputeResolution('registration_error')}
                              />
                              <span>
                                <strong>Error de registro (asistencia efectiva confirmada): </strong>
                                Se asienta como presente.
                              </span>
                            </label>

                            <label style={{ display: 'flex', gap: '8px', cursor: 'pointer' }}>
                              <input
                                type="radio"
                                name="dispute-res"
                                value="confirmed"
                                checked={disputeResolution === 'confirmed'}
                                onChange={() => setDisputeResolution('confirmed')}
                              />
                              <span>
                                <strong>Inasistencia comprobada sin aviso: </strong>
                                Se ratifica la ausencia no avisada.
                              </span>
                            </label>

                            <label style={{ display: 'flex', gap: '8px', cursor: 'pointer' }}>
                              <input
                                type="radio"
                                name="dispute-res"
                                value="insufficient_evidence"
                                checked={disputeResolution === 'insufficient_evidence'}
                                onChange={() => setDisputeResolution('insufficient_evidence')}
                              />
                              <span>
                                <strong>Evidencia insuficiente / no concluyente: </strong>
                                Permanece como estado neutral no verificado (sin sanción).
                              </span>
                            </label>

                            <label style={{ display: 'flex', gap: '8px', cursor: 'pointer' }}>
                              <input
                                type="radio"
                                name="dispute-res"
                                value="rectified"
                                checked={disputeResolution === 'rectified'}
                                onChange={() => setDisputeResolution('rectified')}
                              />
                              <span>
                                <strong>Rectificación general del caso: </strong>
                                Resolución administrativa sin alteración de asistencia individual.
                              </span>
                            </label>
                          </div>
                        </div>

                        <div style={{ marginBottom: '16px' }}>
                          <label className="moderation-field-label">
                            Fundamentación de la resolución (requerido para auditoría durable):
                          </label>
                          <textarea
                            rows={3}
                            maxLength={1000}
                            placeholder="Escribí los motivos de hecho y evidencia considerada para la resolución..."
                            value={disputeNotes}
                            onChange={(e) => setDisputeNotes(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '8px',
                              borderRadius: '6px',
                              border: '1px solid var(--color-outline-variant, #D1D5DB)',
                              fontSize: '13px',
                              boxSizing: 'border-box',
                            }}
                          />
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                          <Button
                            variant="primary"
                            onClick={handleResolveDispute}
                            disabled={disputeResolving || !disputeNotes.trim()}
                          >
                            {disputeResolving ? 'Resolviendo...' : 'Resolver controversia'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </ScreenContainer>
  );
};

export default InternalModerationScreen;
