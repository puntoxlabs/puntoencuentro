import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { openEncountersService } from '@/services/openEncountersService';
import type { MiSolicitudItem } from '@/components/home/openEncounters/types';
import { supabase } from '@/lib/supabase';
import { formatFriendlyDate } from '@/lib/formatDate';
import {
  Calendar,
  Clock,
  MapPin,
  Users,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Inbox,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { attendanceDisputeService } from '@/services/attendanceDisputeService';
import type { AttendanceDisputeItem } from '@/types/attendanceDispute';
import { AttendanceDisputeResponseModal } from '@/components/attendance/AttendanceDisputeResponseModal';
import { ReportEncounterRealizationModal } from '@/components/attendance/ReportEncounterRealizationModal';
import { FactualTrajectoryCard } from '@/components/attendance/FactualTrajectoryCard';
import './HomeSolicitudesSection.css';

export interface HomeSolicitudesSectionProps {
  onSelectEncuentro: (encuentroId: string) => void;
  initialLoading?: boolean;
}

export const HomeSolicitudesSection: React.FC<HomeSolicitudesSectionProps> = ({
  onSelectEncuentro,
  initialLoading = true,
}) => {
  const { t } = useTranslation();
  const { user, isPermanentUser } = useAuth();
  const [solicitudes, setSolicitudes] = useState<MiSolicitudItem[]>([]);
  const [misControversias, setMisControversias] = useState<AttendanceDisputeItem[]>([]);
  const [loading, setLoading] = useState(initialLoading);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [isPastExpanded, setIsPastExpanded] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [activeDisputeModal, setActiveDisputeModal] = useState<{
    isOpen: boolean;
    disputeId: string;
    encounterTitle: string;
    replyDeadline?: string;
  } | null>(null);

  const [realizationModal, setRealizationModal] = useState<{
    isOpen: boolean;
    encuentroId: string;
    encounterTitle: string;
  } | null>(null);

  const loadData = useCallback(async () => {
    if (!user || !isPermanentUser) {
      setSolicitudes([]);
      setMisControversias([]);
      setLoading(false);
      return;
    }

    try {
      setErrorMsg(null);
      const [solicitudesRes, controversiasRes] = await Promise.allSettled([
        openEncountersService.getMisSolicitudes(),
        attendanceDisputeService.getMisControversias(),
      ]);

      if (solicitudesRes.status === 'fulfilled') {
        setSolicitudes(solicitudesRes.value || []);
      }
      if (controversiasRes.status === 'fulfilled' && controversiasRes.value.ok) {
        setMisControversias(controversiasRes.value.controversias || []);
      }
    } catch (err: any) {
      console.error('[HomeSolicitudesSection] Error al cargar solicitudes:', err);
      setErrorMsg('No pudimos cargar tus solicitudes. Intentá nuevamente.');
    } finally {
      setLoading(false);
    }
  }, [user, isPermanentUser]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Deep link handler: detecta ?dispute_id=... o #controversia=... y auto-abre el modal si corresponde
  useEffect(() => {
    if (typeof window === 'undefined' || misControversias.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const disputeIdFromQuery = params.get('dispute_id');
    const hash = window.location.hash;
    const hashMatch = hash.match(/controversia=([a-f0-9-]+)/i);
    const targetDisputeId = disputeIdFromQuery || (hashMatch ? hashMatch[1] : null);

    if (targetDisputeId) {
      const matching = misControversias.find((c) => c.id === targetDisputeId);
      if (
        matching &&
        matching.tipo_controversia === 'absence_reported' &&
        (matching.estado === 'awaiting_response' || matching.estado === 'unverified_timeout')
      ) {
        setActiveDisputeModal({
          isOpen: true,
          disputeId: matching.id,
          encounterTitle: matching.encuentro_title || 'Encuentro',
          replyDeadline: matching.plazo_respuesta_vence_en,
        });
      }
    }
  }, [misControversias]);

  // Suscripción Realtime a cambios en solicitudes_encuentro_abierto del usuario
  useEffect(() => {
    if (!user?.id || !isPermanentUser) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel(`user_solicitudes_realtime_${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'solicitudes_encuentro_abierto',
          filter: `usuario_id=eq.${user.id}`,
        },
        () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            loadData();
          }, 300);
        }
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [user?.id, isPermanentUser, loadData]);

  const handleCancelar = async (requestId: string) => {
    const confirmed = window.confirm(
      '¿Estás seguro de que querés cancelar esta solicitud? Ya no se considerará para el encuentro.'
    );
    if (!confirmed) return;

    setCancellingId(requestId);
    setErrorMsg(null);
    try {
      const res = await openEncountersService.cancelarSolicitud(requestId);
      if (res.ok) {
        await loadData();
      } else {
        setErrorMsg(
          res.error === 'cannot_cancel_non_pending'
            ? 'Esta solicitud ya fue procesada y no puede cancelarse.'
            : 'No se pudo cancelar la solicitud.'
        );
      }
    } catch (err) {
      setErrorMsg('Ocurrió un error al cancelar la solicitud.');
    } finally {
      setCancellingId(null);
    }
  };

  const handleResponderOferta = async (requestId: string, acepta: boolean) => {
    setErrorMsg(null);
    try {
      const res = await openEncountersService.responderOfertaListaEspera(requestId, acepta);
      if (res.ok) {
        await loadData();
      } else {
        setErrorMsg(res.message || 'No se pudo procesar tu respuesta.');
      }
    } catch {
      setErrorMsg('Error al responder a la oferta.');
    }
  };

  const handleRetirarseWaitlist = async (requestId: string) => {
    const confirmed = window.confirm(
      '¿Estás seguro de que querés retirarte de la lista de espera?'
    );
    if (!confirmed) return;

    setErrorMsg(null);
    try {
      const res = await openEncountersService.retirarseListaEspera(requestId);
      if (res.ok) {
        await loadData();
      } else {
        setErrorMsg('No se pudo retirar de la lista de espera.');
      }
    } catch {
      setErrorMsg('Error al retirarse de la lista de espera.');
    }
  };

  if (loading) {
    return (
      <div className="pe-solicitudes-section">
        <div className="pe-solicitudes-loading" role="status" aria-live="polite">
          <div className="pe-solicitudes-spinner" />
          <span>Cargando tus solicitudes...</span>
        </div>
      </div>
    );
  }

  const ofertasEspera = solicitudes.filter((s) => s.estado === 'waitlist_offered');
  const enEspera = solicitudes.filter((s) => s.estado === 'waitlist_waiting' || s.estado === 'waitlist_confirmed');
  const pendientes = solicitudes.filter((s) => s.estado === 'pending' && !s.is_expired);
  const aceptadas = solicitudes.filter((s) => s.estado === 'approved');
  const anteriores = solicitudes.filter(
    (s) => s.estado === 'rejected' || s.estado === 'cancelled' || s.estado === 'waitlist_expired' || (s.estado === 'pending' && s.is_expired)
  );

  const activeAbsenceDisputes = misControversias.filter(
    (c) =>
      c.tipo_controversia === 'absence_reported' &&
      (c.estado === 'awaiting_response' || c.estado === 'unverified_timeout')
  );

  const renderDisputeBadge = (encuentroId: string) => {
    const d = misControversias.find((c) => c.encuentro_id === encuentroId);
    if (!d) return null;
    if (d.estado === 'awaiting_response') {
      return (
        <span className="pe-solicitud-badge" style={{ background: '#fffbeb', color: '#b45309' }}>
          <AlertCircle size={12} aria-hidden="true" /> Inasistencia en descargo
        </span>
      );
    }
    if (d.estado === 'in_human_review') {
      return (
        <span className="pe-solicitud-badge" style={{ background: '#eff6ff', color: '#1d4ed8' }}>
          <Clock size={12} aria-hidden="true" /> En revisión de moderación
        </span>
      );
    }
    if (d.estado === 'resolved_justified') {
      return (
        <span className="pe-solicitud-badge" style={{ background: '#f0fdf4', color: '#15803d' }}>
          <CheckCircle2 size={12} aria-hidden="true" /> Inasistencia justificada
        </span>
      );
    }
    if (d.estado === 'resolved_registration_error' || d.estado === 'rectified') {
      return (
        <span className="pe-solicitud-badge" style={{ background: '#f0fdf4', color: '#15803d' }}>
          <CheckCircle2 size={12} aria-hidden="true" /> Asistencia rectificada
        </span>
      );
    }
    if (d.estado === 'unverified_timeout' || d.estado === 'dismissed_insufficient_evidence') {
      return (
        <span className="pe-solicitud-badge" style={{ background: '#f1f5f9', color: '#475569' }}>
          <Clock size={12} aria-hidden="true" /> Estado neutral no verificado
        </span>
      );
    }
    return null;
  };

  if (solicitudes.length === 0 && activeAbsenceDisputes.length === 0) {
    return (
      <div className="pe-solicitudes-section">
        <FactualTrajectoryCard userId={user?.id} />
        <div className="pe-solicitudes-empty">
          <div className="pe-solicitudes-empty-icon" aria-hidden="true">
            <Inbox size={28} />
          </div>
          <h3 className="pe-solicitudes-empty-title">
            {t('your_encounters.solicitudes_empty_title', {
              defaultValue: 'No tenés solicitudes realizadas',
            })}
          </h3>
          <p className="pe-solicitudes-empty-desc">
            {t('your_encounters.solicitudes_empty_desc', {
              defaultValue: 'Cuando pidas sumarte a un encuentro abierto, vas a poder seguir el estado de tu solicitud acá.',
            })}
          </p>
        </div>
      </div>
    );
  }

  const renderBadge = (s: MiSolicitudItem) => {
    if (s.estado === 'waitlist_offered') {
      return (
        <span className="pe-solicitud-badge" style={{ background: '#ecfdf5', color: '#047857' }}>
          <CheckCircle2 size={12} aria-hidden="true" /> ¡Lugar disponible!
        </span>
      );
    }
    if (s.estado === 'waitlist_waiting') {
      return (
        <span className="pe-solicitud-badge" style={{ background: '#f0f9ff', color: '#0284c7' }}>
          <Users size={12} aria-hidden="true" /> Lista de espera {s.waitlist_position ? `(#${s.waitlist_position})` : ''}
        </span>
      );
    }
    if (s.estado === 'waitlist_confirmed') {
      return (
        <span className="pe-solicitud-badge" style={{ background: '#eff6ff', color: '#1d4ed8' }}>
          <Clock size={12} aria-hidden="true" /> En revisión del host
        </span>
      );
    }
    if (s.estado === 'waitlist_expired') {
      return (
        <span className="pe-solicitud-badge pe-solicitud-badge--expired">
          <Clock size={12} aria-hidden="true" /> Oferta vencida
        </span>
      );
    }
    if (s.estado === 'pending') {
      if (s.is_expired) {
        return (
          <span className="pe-solicitud-badge pe-solicitud-badge--expired">
            <Clock size={12} aria-hidden="true" /> Vencida
          </span>
        );
      }
      return (
        <span className="pe-solicitud-badge pe-solicitud-badge--pending">
          <Clock size={12} aria-hidden="true" /> Pendiente
        </span>
      );
    }
    if (s.estado === 'approved') {
      return (
        <span className="pe-solicitud-badge pe-solicitud-badge--approved">
          <CheckCircle2 size={12} aria-hidden="true" /> Aceptada
        </span>
      );
    }
    if (s.estado === 'rejected') {
      return (
        <span className="pe-solicitud-badge pe-solicitud-badge--rejected">
          <XCircle size={12} aria-hidden="true" /> Rechazada
        </span>
      );
    }
    return (
      <span className="pe-solicitud-badge pe-solicitud-badge--cancelled">
        <AlertCircle size={12} aria-hidden="true" /> Cancelada
      </span>
    );
  };

  return (
    <div className="pe-solicitudes-section">
      <FactualTrajectoryCard userId={user?.id} />
      {errorMsg && (
        <div
          role="alert"
          style={{
            background: '#fee2e2',
            color: '#b91c1c',
            padding: '0.75rem 1rem',
            borderRadius: '10px',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            fontWeight: 500,
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* ── Banner de controversias de asistencia con derecho a respuesta ── */}
      {activeAbsenceDisputes.length > 0 && (
        <div className="pe-solicitudes-group" style={{ marginBottom: '1.5rem' }}>
          <div
            style={{
              border: '2px solid #f59e0b',
              background: '#fffbeb',
              borderRadius: '16px',
              padding: '1.25rem',
              boxShadow: '0 2px 8px rgba(245, 158, 11, 0.08)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.5rem' }}>
              <AlertCircle size={20} color="#d97706" />
              <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#92400e' }}>
                Revisión de inasistencia — Derecho a respuesta
              </h4>
            </div>
            <p style={{ margin: '0 0 0.875rem 0', fontSize: '0.875rem', color: '#78350f', lineHeight: 1.45 }}>
              El anfitrión de un encuentro registró una inasistencia. Tenés derecho a responder, informar si avisaste previamente o pedir revisión humana imparcial.
            </p>
            {activeAbsenceDisputes.map((dispute) => (
              <div
                key={dispute.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  background: '#ffffff',
                  borderRadius: '10px',
                  border: '1px solid #fde68a',
                  marginTop: '0.5rem',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9375rem', color: '#1e293b' }}>
                    {dispute.encuentro_title || 'Encuentro'}
                  </div>
                  <div style={{ fontSize: '0.8125rem', color: '#64748b' }}>
                    Plazo de respuesta: {new Date(dispute.plazo_respuesta_vence_en).toLocaleDateString()}
                  </div>
                </div>
                <button
                  type="button"
                  className="pe-solicitud-btn pe-solicitud-btn--primary"
                  style={{ background: '#d97706', color: '#ffffff' }}
                  onClick={() =>
                    setActiveDisputeModal({
                      isOpen: true,
                      disputeId: dispute.id,
                      encounterTitle: dispute.encuentro_title || 'Encuentro',
                      replyDeadline: dispute.plazo_respuesta_vence_en,
                    })
                  }
                >
                  Responder reporte
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 0. Ofertas de Cupo Disponibles (Waitlist Offered) ── */}
      {ofertasEspera.length > 0 && (
        <div className="pe-solicitudes-group">
          <h3 className="pe-solicitudes-group-title" style={{ color: '#047857' }}>
            ¡Oportunidad de cupo disponible! ({ofertasEspera.length})
          </h3>
          <div className="pe-solicitudes-list">
            {ofertasEspera.map((s) => (
              <article
                key={s.request_id}
                className="pe-solicitud-card"
                style={{ border: '2px solid #10b981', background: '#f0fdf4' }}
              >
                <div className="pe-solicitud-card-top">
                  <h4 className="pe-solicitud-card-title">{s.open_public_title}</h4>
                  {renderBadge(s)}
                </div>

                <div className="pe-solicitud-confirmed-banner" style={{ background: '#dcfce7', color: '#15803d' }}>
                  <CheckCircle2 size={15} aria-hidden="true" />
                  <span>
                    Se liberaron cupos. Confirmá que seguís interesado para enviar tu postulación al anfitrión.
                  </span>
                </div>

                <div className="pe-solicitud-meta">
                  {s.fecha && (
                    <span className="pe-solicitud-meta-item">
                      <Calendar size={13} aria-hidden="true" />
                      {formatFriendlyDate(s.fecha, s.hora)}
                    </span>
                  )}
                  <span className="pe-solicitud-meta-item">
                    <MapPin size={13} aria-hidden="true" />
                    {s.open_public_zone}
                  </span>
                  <span className="pe-solicitud-meta-item">
                    <Users size={13} aria-hidden="true" />
                    {s.seat_count === 1 ? '1 lugar reservado' : `${s.seat_count} lugares reservados`}
                  </span>
                </div>

                <div className="pe-solicitud-actions" style={{ gap: '0.5rem' }}>
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--primary"
                    style={{ background: '#10b981', color: '#ffffff' }}
                    onClick={() => handleResponderOferta(s.request_id, true)}
                  >
                    Sigo interesado
                  </button>
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--cancel"
                    onClick={() => handleResponderOferta(s.request_id, false)}
                  >
                    Ceder lugar
                  </button>
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--secondary"
                    onClick={() => onSelectEncuentro(s.encuentro_id)}
                  >
                    Ver encuentro
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* ── 0.1 En Lista de Espera ────────────────────────────── */}
      {enEspera.length > 0 && (
        <div className="pe-solicitudes-group">
          <h3 className="pe-solicitudes-group-title" style={{ color: '#0369a1' }}>
            En lista de espera ({enEspera.length})
          </h3>
          <div className="pe-solicitudes-list">
            {enEspera.map((s) => (
              <article
                key={s.request_id}
                className="pe-solicitud-card"
                style={{ border: '1px solid #bae6fd', background: '#f8fafc' }}
              >
                <div className="pe-solicitud-card-top">
                  <h4 className="pe-solicitud-card-title">{s.open_public_title}</h4>
                  {renderBadge(s)}
                </div>

                {s.estado === 'waitlist_confirmed' ? (
                  <div className="pe-solicitud-confirmed-banner" style={{ background: '#eff6ff', color: '#1d4ed8' }}>
                    <Clock size={15} aria-hidden="true" />
                    <span>Interés confirmado. El anfitrión está evaluando tu solicitud.</span>
                  </div>
                ) : (
                  <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: '0.5rem 0' }}>
                    Te avisaremos automáticamente si se liberan cupos para este encuentro.
                  </p>
                )}

                <div className="pe-solicitud-meta">
                  {s.fecha && (
                    <span className="pe-solicitud-meta-item">
                      <Calendar size={13} aria-hidden="true" />
                      {formatFriendlyDate(s.fecha, s.hora)}
                    </span>
                  )}
                  <span className="pe-solicitud-meta-item">
                    <MapPin size={13} aria-hidden="true" />
                    {s.open_public_zone}
                  </span>
                  <span className="pe-solicitud-meta-item">
                    <Users size={13} aria-hidden="true" />
                    {s.seat_count === 1 ? '1 lugar en espera' : `${s.seat_count} lugares en espera`}
                  </span>
                </div>

                <div className="pe-solicitud-actions">
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--secondary"
                    onClick={() => onSelectEncuentro(s.encuentro_id)}
                  >
                    Ver encuentro <ArrowRight size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--cancel"
                    onClick={() => handleRetirarseWaitlist(s.request_id)}
                  >
                    Retirarme de la lista
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* ── 1. Solicitudes Aceptadas / Lugares Confirmados ───── */}
      {aceptadas.length > 0 && (
        <div className="pe-solicitudes-group">
          <h3 className="pe-solicitudes-group-title">
            Lugares confirmados ({aceptadas.length})
          </h3>
          <div className="pe-solicitudes-list">
            {aceptadas.map((s) => (
              <article
                key={s.request_id}
                className="pe-solicitud-card pe-solicitud-card--approved"
              >
                <div className="pe-solicitud-card-top">
                  <h4 className="pe-solicitud-card-title">{s.open_public_title}</h4>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
                    {renderBadge(s)}
                    {renderDisputeBadge(s.encuentro_id)}
                  </div>
                </div>

                <div className="pe-solicitud-confirmed-banner">
                  <CheckCircle2 size={15} aria-hidden="true" />
                  <span>
                    {s.seat_count === 1
                      ? 'Tu lugar está confirmado'
                      : `Tus ${s.seat_count} lugares están confirmados`}
                  </span>
                </div>

                <div className="pe-solicitud-meta">
                  {s.fecha && (
                    <span className="pe-solicitud-meta-item">
                      <Calendar size={13} aria-hidden="true" />
                      {formatFriendlyDate(s.fecha, s.hora)}
                    </span>
                  )}
                  <span className="pe-solicitud-meta-item">
                    <MapPin size={13} aria-hidden="true" />
                    {s.open_public_zone}
                  </span>
                  <span className="pe-solicitud-meta-item">
                    <Users size={13} aria-hidden="true" />
                    {s.seat_count === 1 ? '1 lugar' : `${s.seat_count} lugares`}
                  </span>
                </div>

                <div className="pe-solicitud-actions">
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--primary"
                    onClick={() => onSelectEncuentro(s.encuentro_id)}
                  >
                    Ver encuentro <ArrowRight size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--secondary"
                    onClick={() =>
                      setRealizationModal({
                        isOpen: true,
                        encuentroId: s.encuentro_id,
                        encounterTitle: s.open_public_title,
                      })
                    }
                    title="Informar si el encuentro no se realizó o hubo un problema relevante"
                  >
                    <ShieldAlert size={14} aria-hidden="true" /> Reportar no realización
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* ── 2. Solicitudes Pendientes ──────────────────────── */}
      {pendientes.length > 0 && (
        <div className="pe-solicitudes-group">
          <h3 className="pe-solicitudes-group-title">
            Solicitudes pendientes ({pendientes.length})
          </h3>
          <div className="pe-solicitudes-list">
            {pendientes.map((s) => (
              <article
                key={s.request_id}
                className="pe-solicitud-card pe-solicitud-card--pending"
              >
                <div className="pe-solicitud-card-top">
                  <h4 className="pe-solicitud-card-title">{s.open_public_title}</h4>
                  {renderBadge(s)}
                </div>

                <div className="pe-solicitud-meta">
                  {s.fecha && (
                    <span className="pe-solicitud-meta-item">
                      <Calendar size={13} aria-hidden="true" />
                      {formatFriendlyDate(s.fecha, s.hora)}
                    </span>
                  )}
                  <span className="pe-solicitud-meta-item">
                    <MapPin size={13} aria-hidden="true" />
                    {s.open_public_zone}
                  </span>
                  <span className="pe-solicitud-meta-item">
                    <Users size={13} aria-hidden="true" />
                    {s.seat_count === 1 ? '1 lugar solicitado' : `${s.seat_count} lugares solicitados`}
                  </span>
                </div>

                <div className="pe-solicitud-actions">
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--secondary"
                    onClick={() => onSelectEncuentro(s.encuentro_id)}
                  >
                    Ver encuentro <ArrowRight size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--cancel"
                    onClick={() => handleCancelar(s.request_id)}
                    disabled={cancellingId === s.request_id}
                  >
                    {cancellingId === s.request_id ? 'Cancelando...' : 'Cancelar solicitud'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* ── 3. Solicitudes Anteriores (Historial resuelto plegable) ─────────────── */}
      {anteriores.length > 0 && (
        <div className="pe-solicitudes-anteriores-section">
          <button
            type="button"
            className="pe-solicitudes-toggle-btn"
            onClick={() => setIsPastExpanded(!isPastExpanded)}
            aria-expanded={isPastExpanded}
          >
            <span>Ver solicitudes anteriores ({anteriores.length})</span>
            {isPastExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>

          {isPastExpanded && (
            <div className="pe-solicitudes-anteriores-wrap">
              <div className="pe-solicitudes-list">
                {anteriores.map((s) => (
                  <article
                    key={s.request_id}
                    className={`pe-solicitud-card pe-solicitud-card--${s.is_expired ? 'expired' : s.estado} pe-solicitud-card--compact`}
                  >
                    <div className="pe-solicitud-card-top">
                      <h4 className="pe-solicitud-card-title">{s.open_public_title}</h4>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
                        {renderBadge(s)}
                        {renderDisputeBadge(s.encuentro_id)}
                      </div>
                    </div>

                    <div className="pe-solicitud-meta">
                      {s.fecha && (
                        <span className="pe-solicitud-meta-item">
                          <Calendar size={13} aria-hidden="true" />
                          {formatFriendlyDate(s.fecha, s.hora)}
                        </span>
                      )}
                      <span className="pe-solicitud-meta-item">
                        <MapPin size={13} aria-hidden="true" />
                        {s.open_public_zone}
                      </span>
                      <span className="pe-solicitud-meta-item">
                        <Users size={13} aria-hidden="true" />
                        {s.seat_count === 1 ? '1 lugar' : `${s.seat_count} lugares`}
                      </span>
                    </div>

                    <div className="pe-solicitud-actions" style={{ marginTop: '0.5rem' }}>
                      <button
                        type="button"
                        className="pe-solicitud-btn pe-solicitud-btn--secondary"
                        onClick={() =>
                          setRealizationModal({
                            isOpen: true,
                            encuentroId: s.encuentro_id,
                            encounterTitle: s.open_public_title,
                          })
                        }
                        title="Informar si el encuentro no se realizó o hubo un problema relevante"
                      >
                        <ShieldAlert size={14} aria-hidden="true" /> Reportar no realización
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Modales de controversias montados ── */}
      {activeDisputeModal?.isOpen && (
        <AttendanceDisputeResponseModal
          isOpen={activeDisputeModal.isOpen}
          disputeId={activeDisputeModal.disputeId}
          encounterTitle={activeDisputeModal.encounterTitle}
          replyDeadline={activeDisputeModal.replyDeadline}
          onClose={() => setActiveDisputeModal(null)}
          onSuccess={() => {
            setActiveDisputeModal(null);
            void loadData();
          }}
        />
      )}

      {realizationModal?.isOpen && (
        <ReportEncounterRealizationModal
          isOpen={realizationModal.isOpen}
          encuentroId={realizationModal.encuentroId}
          encounterTitle={realizationModal.encounterTitle}
          onClose={() => setRealizationModal(null)}
          onSuccess={() => {
            setRealizationModal(null);
            void loadData();
          }}
        />
      )}
    </div>
  );
};
