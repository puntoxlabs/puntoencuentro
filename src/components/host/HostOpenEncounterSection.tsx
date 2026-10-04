import React, { useState, useEffect, useCallback } from 'react';
import {
  Sparkles,
  MapPin,
  Users,
  CheckCircle2,
  XCircle,
  Clock,
  DoorClosed,
  ChevronDown,
  ChevronUp,
  Flag,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OpenEncounterRequest } from '@/components/home/openEncounters/types';
import type { ContextoReporte } from '@/types/trust';
import { openEncountersService } from '@/services/openEncountersService';
import { useAuth } from '@/contexts/AuthContext';
import { isEncuentroPasado } from '@/lib/formatDate';
import { LoginRequiredSheet } from '@/components/auth/LoginRequiredSheet';
import { OpenEncounterPublishModal } from './OpenEncounterPublishModal';
import { ApplicantTrustSignals } from './ApplicantTrustSignals';
import { ReportRequestModal } from './ReportRequestModal';
import { ContextualBlockAction } from '@/components/trust/ContextualBlockAction';
import './HostOpenEncounterSection.css';

export interface HostOpenEncounterSectionProps {
  encuentro: any;
  hostId: string;
  confirmedCount: number;
  onRefresh: () => void;
  onParticipantAdded: () => void;
  initialSolicitudes?: OpenEncounterRequest[];
}

export const HostOpenEncounterSection: React.FC<HostOpenEncounterSectionProps> = ({
  encuentro,
  hostId,
  confirmedCount,
  onRefresh,
  onParticipantAdded,
  initialSolicitudes,
}) => {
  const { t } = useTranslation();
  const { isPermanentUser, signInWithGoogleForDiscovery } = useAuth();
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [isLoginRequired, setIsLoginRequired] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [solicitudes, setSolicitudes] = useState<OpenEncounterRequest[]>(initialSolicitudes || []);
  const [loadingSolicitudes, setLoadingSolicitudes] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState<boolean | null>(null);
  const [closing, setClosing] = useState(false);
  const [reportingRequest, setReportingRequest] = useState<{
    id: string;
    name: string;
    contexto: ContextoReporte;
  } | null>(null);
  const [reportedSolicitudIds, setReportedSolicitudIds] = useState<Set<string>>(new Set());

  const isOpen = Boolean(encuentro?.is_open);
  const isPast = isEncuentroPasado(
    encuentro?.fecha,
    encuentro?.hora,
    encuentro?.duration_minutes ?? encuentro?.post_event_active_minutes ?? 45
  );
  const maxParticipants = encuentro?.max_participants || 0;
  // Cupo total ocupado: 1 host + confirmados
  const totalOccupied = confirmedCount + 1;
  const availableSlots = Math.max(0, maxParticipants - totalOccupied);

  const loadSolicitudes = useCallback(async () => {
    if (!encuentro?.id || !hostId) return;
    setLoadingSolicitudes(true);
    try {
      const data = await openEncountersService.getSolicitudesHost(encuentro.id, hostId);
      setSolicitudes(data || []);
    } catch (err) {
      console.error('[HostOpenEncounterSection] Error cargando solicitudes:', err);
    } finally {
      setLoadingSolicitudes(false);
    }
  }, [encuentro?.id, hostId]);

  useEffect(() => {
    loadSolicitudes();
  }, [loadSolicitudes]);

  const handleCloseDiscovery = async () => {
    if (!window.confirm('¿Seguro que querés cerrar el encuentro al Discovery? Ya no aparecerá públicamente pero se conservarán todos los participantes confirmados.')) {
      return;
    }
    setClosing(true);
    try {
      await openEncountersService.cerrarEncuentro(encuentro.id, hostId);
      onRefresh();
    } catch (err) {
      console.error('[HostOpenEncounterSection] Error cerrando discovery:', err);
      alert('No se pudo cerrar el encuentro. Intentá de nuevo.');
    } finally {
      setClosing(false);
    }
  };

  const handleAprobar = async (requestId: string) => {
    setProcessingId(requestId);
    try {
      const res = await openEncountersService.aprobarSolicitud(requestId, hostId);
      if (res.ok) {
        await loadSolicitudes();
        onParticipantAdded();
        onRefresh();
      } else {
        alert(res.error === 'quota_exceeded' ? 'No hay cupo disponible para aprobar esta solicitud.' : 'Error al aprobar solicitud.');
      }
    } catch (err: any) {
      alert(err.message || 'Error al aprobar solicitud.');
    } finally {
      setProcessingId(null);
    }
  };

  const handleRechazar = async (requestId: string) => {
    setProcessingId(requestId);
    try {
      const res = await openEncountersService.rechazarSolicitud(requestId, hostId);
      if (res.ok) {
        await loadSolicitudes();
      } else {
        alert('Error al rechazar solicitud.');
      }
    } catch (err: any) {
      alert(err.message || 'Error al rechazar solicitud.');
    } finally {
      setProcessingId(null);
    }
  };

  const pendingRequests = solicitudes.filter((s) => s.estado === 'pending');
  const resolvedRequests = solicitudes.filter((s) => s.estado !== 'pending');
  const isResolvedExpanded = showResolved ?? (!isOpen && pendingRequests.length === 0);

  const handleStartPublish = () => {
    if (isPast) return;
    if (!isPermanentUser) {
      setIsLoginRequired(true);
      return;
    }
    setIsPublishModalOpen(true);
  };

  const handleLoginWithGoogle = async () => {
    setLoginLoading(true);
    const result = await signInWithGoogleForDiscovery();
    if (!result.ok) {
      setLoginLoading(false);
      alert('No se pudo iniciar sesión. Por favor reintentá.');
      setIsLoginRequired(false);
    }
  };

  if (!isOpen && solicitudes.length === 0) {
    if (isPast) return null;

    return (
      <div className="pe-host-open-banner pe-host-open-banner--inactive">
        <div className="pe-host-open-banner__content">
          <div className="pe-host-open-banner__title-row">
            <Sparkles size={18} className="pe-host-open-banner__icon" />
            <h3 className="pe-host-open-banner__title">
              {t('open_encounters.open_encounter_action', { defaultValue: 'Abrir este encuentro' })}
            </h3>
          </div>
          <p className="pe-host-open-banner__desc">
            ¿Te falta gente? Abrí lugares para que otras personas de tu zona puedan descubrir tu plan y pedir sumarse.
          </p>
        </div>
        <button
          type="button"
          className="pe-host-open-banner__btn"
          onClick={handleStartPublish}
        >
          {t('open_encounters.open_encounter_action', { defaultValue: 'Abrir este encuentro' })}
        </button>

        <OpenEncounterPublishModal
          isOpen={isPublishModalOpen}
          onClose={() => setIsPublishModalOpen(false)}
          encuentroId={encuentro.id}
          hostId={hostId}
          modalidad={encuentro.modalidad || 'presencial'}
          defaultDescription={encuentro.descripcion || ''}
          confirmedCount={confirmedCount}
          onPublished={() => {
            onRefresh();
          }}
        />

        <LoginRequiredSheet
          isOpen={isLoginRequired}
          onClose={() => setIsLoginRequired(false)}
          onContinueWithGoogle={handleLoginWithGoogle}
          loading={loginLoading}
          action="open_encounter"
        />
      </div>
    );
  }

  return (
    <div className="pe-host-open-card">
      <div className="pe-host-open-card__header">
        <div className="pe-host-open-card__status-row">
          <span
            className={`pe-host-open-card__badge ${
              isOpen
                ? 'pe-host-open-card__badge--active'
                : 'pe-host-open-card__badge--inactive'
            }`}
          >
            <span className="pe-host-open-card__dot" />
            {isOpen
              ? t('open_encounters.open_status_active', { defaultValue: 'Abierto en Discovery' })
              : isPast
              ? 'Finalizado'
              : 'Cerrado al Discovery'}
          </span>
          <span className="pe-host-open-card__zone">
            <MapPin size={12} />
            {encuentro.open_public_zone || 'Zona configurada'}
          </span>
        </div>

        {isOpen && (
          <button
            type="button"
            className="pe-host-open-card__close-btn"
            onClick={handleCloseDiscovery}
            disabled={closing}
            title="Cerrar al Discovery sin afectar participantes"
          >
            <DoorClosed size={14} />
            <span>{closing ? 'Cerrando…' : t('open_encounters.open_close_btn', { defaultValue: 'Cerrar al Discovery' })}</span>
          </button>
        )}

        {!isOpen && !isPast && (
          <button
            type="button"
            className="pe-host-open-card__close-btn"
            onClick={handleStartPublish}
            title="Reabrir este encuentro al Discovery"
          >
            <Sparkles size={14} />
            <span>{t('open_encounters.open_encounter_action', { defaultValue: 'Abrir este encuentro' })}</span>
          </button>
        )}
      </div>

      <div className="pe-host-open-card__slots-grid">
        <div className="pe-host-open-card__slot-metric">
          <span className="pe-host-open-card__metric-label">
            <Users size={12} /> Ocupación total
          </span>
          <span className="pe-host-open-card__metric-value">
            {totalOccupied} / {maxParticipants}
          </span>
        </div>

        <div className="pe-host-open-card__slot-metric">
          <span className="pe-host-open-card__metric-label">Lugares libres</span>
          <span
            className="pe-host-open-card__metric-value"
            style={{ color: availableSlots > 0 ? '#059669' : '#dc2626' }}
          >
            {availableSlots > 0 ? `${availableSlots} disponibles` : 'Completo'}
          </span>
        </div>
      </div>

      {encuentro.open_description && (
        <div className="pe-host-open-card__desc-box">
          <span className="pe-host-open-card__desc-label">Descripción en Discovery:</span>
          <p className="pe-host-open-card__desc">{encuentro.open_description}</p>
        </div>
      )}

      {/* Sección de Solicitudes */}
      <div className="pe-host-open-card__requests-section">
        <div className="pe-host-open-card__requests-header">
          <div className="pe-host-open-card__requests-title-row">
            <Clock size={16} />
            <h4 className="pe-host-open-card__requests-title">
              {t('open_encounters.requests_section_title', { defaultValue: 'Solicitudes para sumarse' })}
              {pendingRequests.length > 0 && (
                <span className="pe-host-open-card__requests-count">
                  {pendingRequests.length}
                </span>
              )}
            </h4>
          </div>
          <button
            type="button"
            className="pe-host-open-card__refresh-btn"
            onClick={loadSolicitudes}
            disabled={loadingSolicitudes}
          >
            {loadingSolicitudes ? 'Actualizando…' : 'Actualizar'}
          </button>
        </div>

        {/* Lista de Solicitudes Pendientes */}
        {pendingRequests.length === 0 ? (
          <p className="pe-host-open-card__empty-requests">
            No tenés solicitudes pendientes en este momento. Tu plan está visible en Discovery.
          </p>
        ) : (
          <div className="pe-host-open-card__requests-list">
            {pendingRequests.map((req) => (
              <div key={req.id} className="pe-host-request-item">
                <div className="pe-host-request-item__info">
                  <div className="pe-host-request-item__name-row">
                    <span className="pe-host-request-item__name">
                      {req.nombre_solicitante}
                    </span>
                    <span className="pe-host-request-item__time">
                      {new Date(req.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {req.mensaje && (
                    <p className="pe-host-request-item__msg">"{req.mensaje}"</p>
                  )}
                  <ApplicantTrustSignals solicitudId={req.id} />
                </div>

                <div className="pe-host-request-item__actions">
                  <ContextualBlockAction
                    solicitudId={req.id}
                    applicantName={req.nombre_solicitante}
                    variant="compact"
                    onBlockStateChange={() => {
                      loadSolicitudes();
                      onRefresh();
                    }}
                  />
                  <button
                    type="button"
                    className="pe-host-request-item__btn-report"
                    onClick={() => setReportingRequest({ id: req.id, name: req.nombre_solicitante, contexto: 'pre_solicitud' })}
                    title="Reportar solicitud"
                    aria-label={`Reportar solicitud de ${req.nombre_solicitante}`}
                  >
                    <Flag size={13} />
                    <span>{reportedSolicitudIds.has(req.id) ? 'Reportada' : 'Reportar'}</span>
                  </button>
                  <button
                    type="button"
                    className="pe-host-request-item__btn-reject"
                    onClick={() => handleRechazar(req.id)}
                    disabled={processingId === req.id}
                  >
                    <XCircle size={14} />
                    <span>{t('open_encounters.requests_reject', { defaultValue: 'Rechazar' })}</span>
                  </button>
                  <button
                    type="button"
                    className="pe-host-request-item__btn-accept"
                    onClick={() => handleAprobar(req.id)}
                    disabled={processingId === req.id || availableSlots <= 0}
                    title={availableSlots <= 0 ? 'Sin cupo disponible' : undefined}
                  >
                    <CheckCircle2 size={14} />
                    <span>{t('open_encounters.requests_accept', { defaultValue: 'Aceptar' })}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Solicitudes Resueltas (Colapsables) */}
        {resolvedRequests.length > 0 && (
          <div className="pe-host-open-card__resolved-wrapper">
            <button
              type="button"
              className="pe-host-open-card__resolved-toggle"
              onClick={() => setShowResolved(!isResolvedExpanded)}
            >
              <span>{`Historial de solicitudes (${resolvedRequests.length})`}</span>
              {isResolvedExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {isResolvedExpanded && (
              <div className="pe-host-open-card__resolved-list">
                {resolvedRequests.map((req) => (
                  <div key={req.id} className="pe-host-resolved-item">
                    <div className="pe-host-resolved-item__info">
                      <span className="pe-host-resolved-item__name">
                        {req.nombre_solicitante}
                      </span>
                      <span
                        className={`pe-host-resolved-item__status pe-host-resolved-item__status--${req.estado}`}
                      >
                        {req.estado === 'approved' ? 'Aceptada' : req.estado === 'withdrawn' ? 'Retirada' : 'Rechazada'}
                      </span>
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <ContextualBlockAction
                        solicitudId={req.id}
                        applicantName={req.nombre_solicitante}
                        variant="link"
                        onBlockStateChange={() => {
                          loadSolicitudes();
                          onRefresh();
                        }}
                      />
                      {(!isPast || req.estado === 'approved') && (
                        <button
                          type="button"
                          className="pe-host-resolved-item__btn-report"
                          onClick={() =>
                            setReportingRequest({
                              id: req.id,
                              name: req.nombre_solicitante,
                              contexto: isPast ? 'post_encuentro' : 'pre_solicitud',
                            })
                          }
                          title={isPast ? 'Reportar participante' : 'Reportar solicitud'}
                          aria-label={`${isPast ? 'Reportar participante' : 'Reportar solicitud'} de ${req.nombre_solicitante}`}
                        >
                          <Flag size={12} />
                          <span>{reportedSolicitudIds.has(req.id) ? 'Reportada' : 'Reportar'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <OpenEncounterPublishModal
        isOpen={isPublishModalOpen}
        onClose={() => setIsPublishModalOpen(false)}
        encuentroId={encuentro.id}
        hostId={hostId}
        modalidad={encuentro.modalidad || 'presencial'}
        defaultDescription={encuentro.descripcion || ''}
        confirmedCount={confirmedCount}
        onPublished={() => {
          onRefresh();
        }}
      />

      <LoginRequiredSheet
        isOpen={isLoginRequired}
        onClose={() => setIsLoginRequired(false)}
        onContinueWithGoogle={handleLoginWithGoogle}
        loading={loginLoading}
        action="open_encounter"
      />

      {reportingRequest && (
        <ReportRequestModal
          isOpen={Boolean(reportingRequest)}
          onClose={() => setReportingRequest(null)}
          solicitudId={reportingRequest.id}
          applicantName={reportingRequest.name}
          contexto={reportingRequest.contexto}
          targetLabel={reportingRequest.contexto === 'post_encuentro' ? 'Participante' : 'Solicitante'}
          onReportSuccess={() => {
            if (reportingRequest) {
              setReportedSolicitudIds((prev) => new Set([...prev, reportingRequest.id]));
            }
          }}
        />
      )}
    </div>
  );
};
