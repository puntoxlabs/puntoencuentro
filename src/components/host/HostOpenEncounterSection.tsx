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
  AlertCircle,
  Edit2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OpenEncounterRequest } from '@/components/home/openEncounters/types';
import type { ContextoReporte } from '@/types/trust';
import { supabase } from '@/lib/supabase';
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
  confirmedCount?: number;
  confirmedSeats?: number;
  confirmedRequests?: number;
  onRefresh: () => void;
  onParticipantAdded: () => void;
  onUpdateLocation?: (loc: { lugar_texto?: string; link_virtual?: string }) => Promise<void>;
  initialSolicitudes?: OpenEncounterRequest[];
}

export const HostOpenEncounterSection: React.FC<HostOpenEncounterSectionProps> = ({
  encuentro,
  hostId,
  confirmedCount = 0,
  confirmedSeats: confirmedSeatsProp,
  confirmedRequests: confirmedRequestsProp,
  onRefresh,
  onParticipantAdded,
  onUpdateLocation,
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
  const [postEditNotice, setPostEditNotice] = useState<string | null>(null);

  const [isEditingMin, setIsEditingMin] = useState(false);
  const [newMinVal, setNewMinVal] = useState<string>(encuentro?.min_participants ? String(encuentro.min_participants) : '');
  const [savingMin, setSavingMin] = useState(false);
  const [forcingRealization, setForcingRealization] = useState(false);
  const [togglingInscriptions, setTogglingInscriptions] = useState(false);

  useEffect(() => {
    if (encuentro?.min_participants) {
      setNewMinVal(String(encuentro.min_participants));
    } else {
      setNewMinVal('');
    }
  }, [encuentro?.min_participants]);

  const handleSaveMinParticipants = async () => {
    const val = parseInt(newMinVal, 10);
    if (isNaN(val) || val < 1) {
      alert('Ingresá un número válido mayor a 0');
      return;
    }

    let confirmReversion = false;
    const wouldRevert =
      encuentro?.realization_status === 'confirmed' &&
      Boolean(encuentro?.inscriptions_closed) &&
      val > confirmedSeats;

    if (wouldRevert) {
      const ok = window.confirm(
        'Este cambio hará que el encuentro vuelva a depender del mínimo de participantes. ¿Querés continuar?'
      );
      if (!ok) return;
      confirmReversion = true;
    }

    setSavingMin(true);
    try {
      let res = await openEncountersService.setMinParticipants(encuentro.id, hostId, val, confirmReversion);

      if (!res.ok && res.error === 'reversion_confirmation_required') {
        const ok = window.confirm(
          res.message || 'Este cambio hará que el encuentro vuelva a depender del mínimo de participantes. ¿Querés continuar?'
        );
        if (ok) {
          res = await openEncountersService.setMinParticipants(encuentro.id, hostId, val, true);
        } else {
          return;
        }
      }

      if (res.ok) {
        setIsEditingMin(false);
        onRefresh();
      } else {
        alert(res.message || res.error || 'Error al actualizar el mínimo de participantes');
      }
    } catch (err: any) {
      alert(err?.message || 'Error al actualizar el mínimo');
    } finally {
      setSavingMin(false);
    }
  };

  const handleRemoveMinParticipants = async () => {
    setSavingMin(true);
    try {
      const res = await openEncountersService.setMinParticipants(encuentro.id, hostId, null);
      if (res.ok) {
        setIsEditingMin(false);
        setNewMinVal('');
        onRefresh();
      } else {
        alert(res.error || 'Error al quitar el mínimo');
      }
    } catch (err: any) {
      alert(err?.message || 'Error al quitar el mínimo');
    } finally {
      setSavingMin(false);
    }
  };

  const handleHacerloIgual = async () => {
    if (!window.confirm('¿Confirmar que el encuentro se realiza de todas formas? Se notificará a los participantes confirmados.')) {
      return;
    }
    setForcingRealization(true);
    try {
      const res = await openEncountersService.hacerloIgual(encuentro.id, hostId);
      if (res.ok) {
        onRefresh();
      } else {
        alert(res.error || 'Error al confirmar realización');
      }
    } catch (err: any) {
      alert(err?.message || 'Error al confirmar realización');
    } finally {
      setForcingRealization(false);
    }
  };

  const handleCerrarInscripciones = async () => {
    if (!window.confirm('¿Cerrar inscripciones para nuevas solicitudes? Si el encuentro ya está confirmado, se enviará la confirmación final a los participantes.')) {
      return;
    }
    setTogglingInscriptions(true);
    try {
      const res = await openEncountersService.cerrarInscripciones(encuentro.id, hostId);
      if (res.ok) {
        onRefresh();
      } else {
        alert(res.error || 'Error al cerrar inscripciones');
      }
    } catch (err: any) {
      alert(err?.message || 'Error al cerrar inscripciones');
    } finally {
      setTogglingInscriptions(false);
    }
  };

  const handleReabrirInscripciones = async () => {
    setTogglingInscriptions(true);
    try {
      const res = await openEncountersService.reabrirInscripciones(encuentro.id, hostId);
      if (res.ok) {
        onRefresh();
      } else {
        alert(res.error || 'Error al reabrir inscripciones');
      }
    } catch (err: any) {
      alert(err?.message || 'Error al reabrir inscripciones');
    } finally {
      setTogglingInscriptions(false);
    }
  };

  const isOpen = Boolean(encuentro?.is_open);
  const hasActiveModeration = Boolean(
    encuentro?.moderation_status && encuentro?.moderation_status !== 'draft'
  );
  const isPast = isEncuentroPasado(
    encuentro?.fecha,
    encuentro?.hora,
    encuentro?.duration_minutes ?? encuentro?.post_event_active_minutes ?? 45
  );
  const maxParticipants = encuentro?.max_participants || 0;
  // Semántica canónica: confirmed_seats = SUM(seat_count).
  // Fuente de verdad server-side (encuentro.confirmed_seats de get_detalle_host_seguro) con fallback a props.
  const confirmedSeats = typeof encuentro?.confirmed_seats === 'number'
    ? encuentro.confirmed_seats
    : (confirmedSeatsProp ?? confirmedCount ?? 0);

  const confirmedRequests = typeof confirmedRequestsProp === 'number'
    ? confirmedRequestsProp
    : (typeof encuentro?.confirmed_requests === 'number' ? encuentro.confirmed_requests : undefined);

  // Semántica canónica: available_slots = max_participants - confirmed_seats
  const availableSlots = typeof encuentro?.available_slots === 'number'
    ? encuentro.available_slots
    : Math.max(0, maxParticipants - confirmedSeats);

  const handlePublished = (res?: { ok: boolean; moderation_status?: string; message?: string }) => {
    if (res?.moderation_status === 'review_pending') {
      setPostEditNotice(
        t('open_encounters.post_edit_review_notice', {
          defaultValue: 'Guardamos los cambios. La publicación se está revisando nuevamente.',
        })
      );
      setTimeout(() => setPostEditNotice(null), 8000);
    }
    onRefresh();
  };

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

  // Suscripción Realtime para actualizar la lista de solicitudes sin reload con app abierta
  useEffect(() => {
    if (!encuentro?.id || !isOpen) return;

    const channel = supabase
      .channel(`solicitudes_encuentro:${encuentro.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'solicitudes_encuentro_abierto',
          filter: `encuentro_id=eq.${encuentro.id}`,
        },
        () => {
          loadSolicitudes();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [encuentro?.id, isOpen, loadSolicitudes]);

  // Soporte de navegación y foco por hash #solicitudes
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#solicitudes') {
      const el = document.getElementById('solicitudes');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, []);

  const handleCloseDiscovery = async () => {
    if (!window.confirm('¿Seguro que querés dejar de mostrar el encuentro en Encuentros Abiertos? Ya no aparecerá públicamente pero se conservarán todos los participantes confirmados.')) {
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
    try {
      if (encuentro?.id) {
        sessionStorage.setItem('post_auth_redirect', `/meet/${encuentro.id}`);
      }
      const result = await signInWithGoogleForDiscovery();
      if (!result.ok) {
        sessionStorage.removeItem('post_auth_redirect');
        setLoginLoading(false);
        alert('No se pudo iniciar sesión con Google. Por favor reintentá.');
        setIsLoginRequired(false);
      }
    } catch {
      sessionStorage.removeItem('post_auth_redirect');
      setLoginLoading(false);
      alert('No se pudo iniciar sesión con Google. Por favor reintentá.');
      setIsLoginRequired(false);
    }
  };

  if (!isOpen && solicitudes.length === 0 && !hasActiveModeration) {
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
          lugarTexto={encuentro.lugar_texto || ''}
          linkVirtual={encuentro.link_virtual || ''}
          defaultDescription={encuentro.open_description || encuentro.descripcion || ''}
          defaultSlots={availableSlots > 0 ? availableSlots : 2}
          defaultLocalityId={encuentro.locality_id || 'guemes'}
          confirmedCount={confirmedSeats}
          confirmedSeats={confirmedSeats}
          onUpdateLocation={onUpdateLocation}
          onPublished={handlePublished}
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
                : encuentro?.moderation_status === 'review_pending'
                ? 'pe-host-open-card__badge--review'
                : encuentro?.moderation_status === 'hidden_pending_review'
                ? 'pe-host-open-card__badge--hidden'
                : encuentro?.moderation_status === 'rejected'
                ? 'pe-host-open-card__badge--rejected'
                : 'pe-host-open-card__badge--inactive'
            }`}
          >
            <span className="pe-host-open-card__dot" />
            {isOpen
              ? t('open_encounters.open_status_active', { defaultValue: 'Abierto para sumarse' })
              : isPast
              ? 'Finalizado'
              : encuentro?.moderation_status === 'review_pending'
              ? t('open_encounters.status_review_badge', { defaultValue: 'En revisión' })
              : encuentro?.moderation_status === 'hidden_pending_review'
              ? t('open_encounters.status_hidden_badge', { defaultValue: 'En revisión' })
              : encuentro?.moderation_status === 'rejected'
              ? t('open_encounters.status_rejected_badge', { defaultValue: 'No publicada' })
              : t('open_encounters.open_status_closed', { defaultValue: 'No visible en Encuentros Abiertos' })}
          </span>
          <span className="pe-host-open-card__zone">
            <MapPin size={12} />
            {encuentro.open_public_zone || 'Zona configurada'}
          </span>
        </div>

        <div className="pe-host-open-card__actions-row">
          {isOpen && (
            <>
              <button
                type="button"
                className="pe-host-open-card__action-btn"
                onClick={handleStartPublish}
                title="Modificar los datos de la publicación"
              >
                <Edit2 size={13} aria-hidden="true" />
                <span>{t('open_encounters.action_edit_publication', { defaultValue: 'Editar publicación' })}</span>
              </button>
              {encuentro?.inscriptions_closed ? (
                <button
                  type="button"
                  className="pe-host-open-card__action-btn pe-host-open-card__action-btn--primary"
                  onClick={handleReabrirInscripciones}
                  disabled={togglingInscriptions}
                  title="Permitir nuevas solicitudes"
                >
                  <Sparkles size={13} aria-hidden="true" />
                  <span>{togglingInscriptions ? 'Reabriendo…' : 'Reabrir inscripciones'}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="pe-host-open-card__action-btn"
                  onClick={handleCerrarInscripciones}
                  disabled={togglingInscriptions}
                  title="No recibir nuevas solicitudes"
                >
                  <DoorClosed size={13} aria-hidden="true" />
                  <span>{togglingInscriptions ? 'Cerrando…' : 'Cerrar inscripciones'}</span>
                </button>
              )}
              <button
                type="button"
                className="pe-host-open-card__close-btn"
                onClick={handleCloseDiscovery}
                disabled={closing}
                title="Dejar de mostrar sin afectar participantes"
              >
                <DoorClosed size={14} aria-hidden="true" />
                <span>{closing ? 'Cerrando…' : t('open_encounters.open_close_btn', { defaultValue: 'Dejar de mostrar' })}</span>
              </button>
            </>
          )}

          {!isOpen && !isPast && (
            <>
              {encuentro?.moderation_status === 'review_pending' && (
                <button
                  type="button"
                  className="pe-host-open-card__action-btn"
                  onClick={handleStartPublish}
                  title="Modificar los datos de la publicación"
                >
                  <Edit2 size={13} aria-hidden="true" />
                  <span>{t('open_encounters.action_edit_publication', { defaultValue: 'Editar publicación' })}</span>
                </button>
              )}

              {encuentro?.moderation_status === 'rejected' && (
                <button
                  type="button"
                  className="pe-host-open-card__action-btn pe-host-open-card__action-btn--primary"
                  onClick={handleStartPublish}
                  title="Corregir los datos y volver a publicar"
                >
                  <Sparkles size={13} aria-hidden="true" />
                  <span>{t('open_encounters.action_edit_publication', { defaultValue: 'Editar publicación' })}</span>
                </button>
              )}

              {encuentro?.moderation_status === 'hidden_pending_review' && (
                <button
                  type="button"
                  className="pe-host-open-card__action-btn"
                  onClick={handleStartPublish}
                  title="Modificar los datos de la publicación"
                >
                  <Edit2 size={13} aria-hidden="true" />
                  <span>{t('open_encounters.action_edit_publication', { defaultValue: 'Editar publicación' })}</span>
                </button>
              )}

              {(!encuentro?.moderation_status || encuentro?.moderation_status === 'draft' || (!isOpen && encuentro?.moderation_status === 'approved')) && (
                <button
                  type="button"
                  className="pe-host-open-card__close-btn"
                  onClick={handleStartPublish}
                  title="Reabrir este encuentro para sumarse"
                >
                  <Sparkles size={14} aria-hidden="true" />
                  <span>{t('open_encounters.open_encounter_action', { defaultValue: 'Abrir este encuentro' })}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {postEditNotice && (
        <div className="pe-host-open-card__notice pe-host-open-card__notice--post-edit" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>{postEditNotice}</span>
        </div>
      )}

      {encuentro?.moderation_status === 'review_pending' && (
        <div className="pe-host-open-card__notice pe-host-open-card__notice--review" role="status">
          <Clock size={16} aria-hidden="true" />
          <div className="pe-host-open-card__notice-text">
            <strong>{t('open_encounters.review_pending_notice', { defaultValue: 'Estamos revisando esta publicación antes de mostrarla públicamente.' })}</strong>
            <span>{t('open_encounters.review_pending_helper', { defaultValue: 'Mientras tanto, tu encuentro sigue activo y no necesitás volver a publicarlo.' })}</span>
          </div>
        </div>
      )}

      {encuentro?.moderation_status === 'hidden_pending_review' && (
        <div className="pe-host-open-card__notice pe-host-open-card__notice--hidden" role="status">
          <AlertCircle size={16} aria-hidden="true" />
          <div className="pe-host-open-card__notice-text">
            <span>{t('open_encounters.hidden_review_notice', { defaultValue: 'Esta publicación está temporalmente en revisión. Mientras la revisamos, no se muestra en Me sumo.' })}</span>
          </div>
        </div>
      )}

      {encuentro?.moderation_status === 'rejected' && (
        <div className="pe-host-open-card__notice pe-host-open-card__notice--rejected" role="status">
          <AlertCircle size={16} aria-hidden="true" />
          <div className="pe-host-open-card__notice-text">
            <span>{t('open_encounters.rejected_notice', { defaultValue: 'Esta publicación no puede mostrarse públicamente con el contenido actual. Podés editarla e intentarlo nuevamente.' })}</span>
          </div>
        </div>
      )}

      <div className="pe-host-open-card__slots-grid">
        <div className="pe-host-open-card__slot-metric">
          <span className="pe-host-open-card__metric-label">
            <Users size={12} /> Personas confirmadas
          </span>
          <span className="pe-host-open-card__metric-value">
            {confirmedSeats}
          </span>
          <span className="pe-host-open-card__metric-subtext" style={{ fontSize: 11, color: '#64748b' }}>
            {confirmedSeats === 0
              ? 'Sin personas externas confirmadas'
              : confirmedSeats === 1
              ? '1 persona confirmada'
              : (confirmedRequests && confirmedRequests !== confirmedSeats
                  ? `${confirmedSeats} personas confirmadas (${confirmedRequests} ${confirmedRequests === 1 ? 'titular' : 'titulares'})`
                  : `${confirmedSeats} personas confirmadas`)}
          </span>
        </div>

        <div className="pe-host-open-card__slot-metric">
          <span className="pe-host-open-card__metric-label">Lugares disponibles</span>
          <span
            className="pe-host-open-card__metric-value"
            style={{ color: availableSlots > 0 ? '#059669' : '#dc2626' }}
          >
            {availableSlots > 0 ? availableSlots : 'Completo'}
          </span>
          <span className="pe-host-open-card__metric-subtext" style={{ fontSize: 11, color: '#64748b' }}>
            {availableSlots > 0 ? `${availableSlots} ${availableSlots === 1 ? 'lugar para sumarse' : 'lugares para sumarse'}` : 'Sin lugares libres'}
          </span>
        </div>
      </div>

      {/* Realización y Mínimo de participantes */}
      <div className="pe-host-realization-card" style={{ marginTop: '0.75rem', padding: '0.75rem 1rem', background: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#334155', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Users size={14} /> Mínimo de participantes: {encuentro.min_participants ? `${encuentro.min_participants} personas` : 'Sin mínimo'}
          </span>
          <button
            type="button"
            onClick={() => setIsEditingMin(!isEditingMin)}
            style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: '0.75rem', cursor: 'pointer', textDecoration: 'underline' }}
          >
            {isEditingMin ? 'Cancelar' : (encuentro.min_participants ? 'Cambiar mínimo' : 'Definir mínimo')}
          </button>
        </div>

        {isEditingMin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="number"
              min={1}
              max={maxParticipants || 50}
              placeholder="Ej: 4"
              value={newMinVal}
              onChange={(e) => setNewMinVal(e.target.value)}
              style={{ width: '80px', padding: '0.25rem 0.5rem', fontSize: '0.8125rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            />
            <button
              type="button"
              onClick={handleSaveMinParticipants}
              disabled={savingMin}
              style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem', background: '#2563eb', color: '#fff', borderRadius: '6px', border: 'none', cursor: 'pointer' }}
            >
              {savingMin ? 'Guardando…' : 'Guardar'}
            </button>
            {encuentro.min_participants && (
              <button
                type="button"
                onClick={() => handleRemoveMinParticipants()}
                disabled={savingMin}
                style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem', background: '#f1f5f9', color: '#475569', borderRadius: '6px', border: '1px solid #cbd5e1', cursor: 'pointer' }}
              >
                Quitar mínimo
              </button>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            {encuentro.min_participants ? (
              encuentro.realization_status === 'confirmed' ? (
                <span style={{ fontSize: '0.8rem', color: '#047857', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <CheckCircle2 size={14} /> ¡Se hace! Alcanzó el mínimo ({confirmedSeats}/{encuentro.min_participants}).
                </span>
              ) : encuentro.realization_status === 'forced' ? (
                <span style={{ fontSize: '0.8rem', color: '#047857', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <CheckCircle2 size={14} /> Confirmado por vos (hacerlo igual).
                </span>
              ) : (
                <span style={{ fontSize: '0.8rem', color: '#b45309', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <Clock size={14} /> Pendiente del mínimo: {confirmedSeats}/{encuentro.min_participants} personas confirmadas.
                </span>
              )
            ) : (
              <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                Sin condición de mínimo para realizarse.
              </span>
            )}
          </div>

          {encuentro.min_participants && encuentro.realization_status === 'pending' && (
            <button
              type="button"
              onClick={handleHacerloIgual}
              disabled={forcingRealization}
              style={{
                padding: '0.3rem 0.6rem',
                fontSize: '0.75rem',
                fontWeight: 600,
                background: '#047857',
                color: '#fff',
                borderRadius: '6px',
                border: 'none',
                cursor: 'pointer',
              }}
              title="Confirmar que se realiza aunque no llegue al mínimo"
            >
              {forcingRealization ? 'Confirmando…' : 'Hacerlo igual'}
            </button>
          )}
        </div>

        {encuentro.inscriptions_closed && (
          <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#475569', fontSize: '0.75rem' }}>
            <DoorClosed size={14} />
            <span>Inscripciones cerradas para nuevas solicitudes.</span>
          </div>
        )}
      </div>

      {encuentro.open_description && (
        <div className="pe-host-open-card__desc-box">
          <span className="pe-host-open-card__desc-label">Descripción pública:</span>
          <p className="pe-host-open-card__desc">{encuentro.open_description}</p>
        </div>
      )}

      {/* Sección de Solicitudes */}
      <div id="solicitudes" className="pe-host-open-card__requests-section">
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
            No tenés solicitudes pendientes en este momento. Tu plan está visible en Encuentros Abiertos.
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
                    {req.seat_count && req.seat_count > 1 ? (
                      <span
                        className="pe-host-request-item__seats-badge"
                        style={{
                          marginLeft: 6,
                          fontSize: 11,
                          fontWeight: 600,
                          color: '#047857',
                          backgroundColor: '#ecfdf5',
                          padding: '2px 6px',
                          borderRadius: 6,
                        }}
                      >
                        · {req.seat_count} lugares
                      </span>
                    ) : null}
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
                    disabled={processingId === req.id || availableSlots < (req.seat_count || 1)}
                    title={availableSlots < (req.seat_count || 1) ? 'Cupo insuficiente' : undefined}
                  >
                    <CheckCircle2 size={14} />
                    <span>
                      {(req.seat_count || 1) > 1
                        ? `Aceptar ${req.seat_count} lugares`
                        : t('open_encounters.requests_accept', { defaultValue: 'Aceptar' })}
                    </span>
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
                        {req.estado === 'approved'
                          ? 'Aceptada'
                          : req.estado === 'withdrawn' || req.estado === 'cancelled'
                          ? 'Baja'
                          : 'Rechazada'}
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
        lugarTexto={encuentro.lugar_texto || ''}
        linkVirtual={encuentro.link_virtual || ''}
        defaultTitle={encuentro.open_public_title || encuentro.titulo || ''}
        defaultDescription={encuentro.open_description || encuentro.descripcion || ''}
        defaultSlots={encuentro.max_participants ? encuentro.max_participants : (availableSlots > 0 ? availableSlots : 2)}
        defaultLocalityId={encuentro.locality_id || 'guemes'}
        confirmedCount={confirmedSeats}
        confirmedSeats={confirmedSeats}
        defaultAllowMultiSeat={Boolean(encuentro.allow_multi_seat_requests)}
        defaultMaxSeats={encuentro.max_seats_per_request || 2}
        onUpdateLocation={onUpdateLocation}
        onPublished={handlePublished}
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
