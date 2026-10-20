import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Calendar, MapPin, Users, Info, CheckCircle2, Clock, XCircle, ArrowRight, Flag, Video, AlertCircle, DoorClosed } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { OpenEncounterSummary, EncuentroParticipanteAutorizado } from './types';
import { getSlotLabel } from './types';
import { openEncountersService } from '@/services/openEncountersService';
import { getHostAlias } from '@/lib/hostAliasStorage';
import { getEncuentroHost } from '@/lib/meetHostsStorage';
import { useAuth } from '@/contexts/AuthContext';
import { LoginRequiredSheet } from '@/components/auth/LoginRequiredSheet';
import { ReportPublicEncounterModal } from './ReportPublicEncounterModal';
import { EncounterMessagesPanel } from '@/components/messages/EncounterMessagesPanel';
import type { PublicContentReportReason } from '@/types/trust';
import './HomeOpenEncounterDetailSheet.css';

// Clave de sessionStorage para persistir contexto de solicitud entre redirect OAuth
const PENDING_OPEN_REQUEST_KEY = 'pending_open_request';
const PENDING_OPEN_REPORT_KEY = 'pending_open_report';

export interface HomeOpenEncounterDetailSheetProps {
  isOpen: boolean;
  encounter: OpenEncounterSummary | null;
  onClose: () => void;
}

export const HomeOpenEncounterDetailSheet: React.FC<HomeOpenEncounterDetailSheetProps> = ({
  isOpen,
  encounter,
  onClose,
}) => {
  const { t } = useTranslation();
  let navigate = (_path: string) => {};
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    navigate = useNavigate();
  } catch {
    /* Safe fallback when rendered outside Router in tests */
  }
  const { user, isPermanentUser, signInWithGoogleForDiscovery } = useAuth();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const reportBtnRef = useRef<HTMLButtonElement>(null);

  // Estados de solicitud
  const [requestState, setRequestState] = useState<{
    hasRequest: boolean;
    status?: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'cancelled';
    tokenParticipante?: string;
  }>({ hasRequest: false });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isLoginRequired, setIsLoginRequired] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [applicantName, setApplicantName] = useState('');
  const [applicantMessage, setApplicantMessage] = useState('');
  const [requestedSeats, setRequestedSeats] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [isReported, setIsReported] = useState(false);
  const [authorizedDetail, setAuthorizedDetail] = useState<EncuentroParticipanteAutorizado | null>(null);
  const [reconfirming, setReconfirming] = useState(false);
  const [reconfirmStatus, setReconfirmStatus] = useState<'pending' | 'confirmed' | 'declined' | undefined>(undefined);
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [pendingReportData, setPendingReportData] = useState<{
    reason?: PublicContentReportReason | null;
    comment?: string;
  } | null>(null);

  useEffect(() => {
    if (authorizedDetail?.reconfirmation_status) {
      setReconfirmStatus(authorizedDetail.reconfirmation_status);
    } else {
      setReconfirmStatus(undefined);
    }
  }, [authorizedDetail?.reconfirmation_status]);

  const handleReconfirm = async (decision: 'confirm' | 'decline') => {
    if (!encounter?.id || reconfirming) return;
    if (decision === 'decline') {
      setIsWithdrawModalOpen(true);
      return;
    }
    setReconfirming(true);
    try {
      const res = await openEncountersService.reconfirmarAsistencia(encounter.id, decision);
      if (res.ok) {
        setReconfirmStatus('confirmed');
      } else {
        setErrorMsg(res.error || 'No se pudo actualizar tu confirmación de asistencia.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error al reconfirmar asistencia.');
    } finally {
      setReconfirming(false);
    }
  };

  const handleExecuteWithdrawal = async () => {
    if (!encounter?.id || withdrawing) return;
    setWithdrawing(true);
    setErrorMsg(null);
    try {
      const res = await openEncountersService.desistirEncuentroAbierto(
        encounter.id,
        withdrawReason.trim() ? withdrawReason.trim() : undefined
      );
      if (res.ok) {
        setReconfirmStatus('declined');
        setIsWithdrawModalOpen(false);
        setWithdrawReason('');
        setAuthorizedDetail(null);
        setRequestState({ hasRequest: true, status: 'withdrawn' });
      } else {
        setErrorMsg(res.error || 'No se pudo procesar la baja del encuentro.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error al darse de baja del encuentro.');
    } finally {
      setWithdrawing(false);
    }
  };

  const isDemo = encounter?.id?.startsWith('demo-') ?? false;
  const isHost = Boolean(
    encounter?.id && (
      getEncuentroHost(encounter.id) ||
      (user?.id && (encounter.hostId === user.id || (encounter as any)?.host_id === user.id)) ||
      authorizedDetail?.is_host === true
    )
  );

  const isApprovedParticipant = Boolean(
    !isHost && (
      (requestState.hasRequest && requestState.status === 'approved') ||
      (authorizedDetail && !authorizedDetail.is_host)
    )
  );
  const participantSeats = authorizedDetail?.seat_count || requestedSeats || 1;

  const minSeats = encounter?.minSeatsPerRequest || 1;
  const effectiveMax = Math.min(encounter?.maxSeatsPerRequest || 1, encounter?.openSlots ?? 1);
  const isBelowMin = Boolean(encounter && encounter.openSlots > 0 && encounter.openSlots < minSeats);

  useEffect(() => {
    if (encounter) {
      const minS = encounter.minSeatsPerRequest || 1;
      const effMax = Math.min(encounter.maxSeatsPerRequest || 1, encounter.openSlots);
      setRequestedSeats((prev) => Math.max(minS, Math.min(prev, effMax > 0 ? effMax : minS)));
    }
  }, [encounter?.id, encounter?.minSeatsPerRequest, encounter?.maxSeatsPerRequest, encounter?.openSlots]);

  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Bloqueo de scroll de fondo con compensación de scrollbar y restauración de foco
  useEffect(() => {
    if (!isOpen) return;

    previousActiveElementRef.current = document.activeElement as HTMLElement | null;

    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
      if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === 'function') {
        previousActiveElementRef.current.focus();
      }
    };
  }, [isOpen]);

  // userId solo para consultar estado de solicitud propio — SOLO si es permanente
  const userId = isPermanentUser ? user?.id ?? null : null;

  useEffect(() => {
    if (!isOpen || !encounter) return;

    // Resetear formulario y estado de login
    setIsFormOpen(false);
    setIsLoginRequired(false);
    setIsReportModalOpen(false);
    setIsReported(false);
    setErrorMsg(null);
    setAuthorizedDetail(null);
    setApplicantName(getHostAlias() || user?.user_metadata?.full_name || '');
    setApplicantMessage('');
    setRequestedSeats(1);

    // Consultar estado de solicitud previa y detalle autorizado — solo si usuario permanente
    if (!isDemo && userId) {
      openEncountersService
        .getMiSolicitud(encounter.id, userId)
        .then((res) => {
          if (res.ok && res.has_request) {
            setRequestState({
              hasRequest: true,
              status: res.estado,
              tokenParticipante: res.token_participante,
            });
          } else {
            setRequestState({ hasRequest: false });
          }
        })
        .catch(() => {
          setRequestState({ hasRequest: false });
        });

      openEncountersService
        .getEncuentroParticipanteAutorizado(encounter.id)
        .then((authRes) => {
          if (authRes && authRes.ok) {
            setAuthorizedDetail(authRes);
            if (authRes.is_host) {
              setIsFormOpen(false);
              try {
                sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY);
              } catch {
                /* storage fallback */
              }
            }
          } else {
            setAuthorizedDetail(null);
          }
        })
        .catch(() => {
          setAuthorizedDetail(null);
        });
    } else {
      setRequestState({ hasRequest: false });
      setAuthorizedDetail(null);
    }

    // Si es host, asegurar que nunca abra formulario ni persista draft
    if (isHost) {
      setIsFormOpen(false);
      try {
        sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY);
      } catch {
        /* storage fallback */
      }
      return;
    }

    // Recuperar contexto de solicitud pendiente post-OAuth
    // Si el usuario acaba de loguearse y hay un pending_open_request para ESTE encuentro,
    // abrimos automáticamente el formulario de solicitud sin auto-submit.
    if (isPermanentUser && !isDemo && !isHost) {
      try {
        const raw = sessionStorage.getItem(PENDING_OPEN_REQUEST_KEY);
        if (raw) {
          const pending = JSON.parse(raw) as {
            encounterId: string;
            applicantName?: string;
            applicantMessage?: string;
            requestedSeats?: number;
            action: string;
          };
          if (pending.action === 'request_join' && pending.encounterId === encounter.id) {
            // Recuperar nombre, mensaje y cupos del contexto guardado
            if (pending.applicantName) {
              setApplicantName(pending.applicantName);
            } else if (user?.user_metadata?.full_name) {
              setApplicantName(user.user_metadata.full_name);
            }
            if (pending.applicantMessage) setApplicantMessage(pending.applicantMessage);
            if (pending.requestedSeats) setRequestedSeats(pending.requestedSeats);
            setIsFormOpen(true);
            sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY);
          }
        }
      } catch {
        sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY);
      }

      try {
        const rawReport = sessionStorage.getItem(PENDING_OPEN_REPORT_KEY);
        if (rawReport) {
          const pendingReport = JSON.parse(rawReport) as { encounterId: string; reason?: PublicContentReportReason; comment?: string };
          if (pendingReport.encounterId === encounter.id) {
            setPendingReportData({
              reason: pendingReport.reason || null,
              comment: pendingReport.comment || '',
            });
            setIsReportModalOpen(true);
          }
          sessionStorage.removeItem(PENDING_OPEN_REPORT_KEY);
        }
      } catch {
        sessionStorage.removeItem(PENDING_OPEN_REPORT_KEY);
      }
    }
  }, [isOpen, encounter?.id, isDemo, userId, isPermanentUser, user?.user_metadata?.full_name]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isLoginRequired) {
          setIsLoginRequired(false);
        } else {
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 50);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, isLoginRequired]);

  if (!isOpen || !encounter) return null;

  const slotLabel = getSlotLabel(encounter.openSlots, t);
  const confirmedPersons = encounter.confirmedSeats ?? encounter.confirmedCount ?? 0;
  const confirmedLabel =
    confirmedPersons === 0
      ? t('open_encounters.confirmed_zero', { defaultValue: '0 personas confirmadas' })
      : confirmedPersons === 1
      ? t('open_encounters.confirmed_single', { defaultValue: '1 persona confirmada' })
      : t('open_encounters.confirmed_people', {
          count: confirmedPersons,
          defaultValue: `${confirmedPersons} personas confirmadas`,
        });

  const handleStartRequest = () => {
    if (isDemo) {
      // Para demo simplemente mostramos estado simulado
      setRequestState({ hasRequest: true, status: 'pending' });
      return;
    }

    if (isHost || (authorizedDetail && !authorizedDetail.is_host)) {
      return;
    }

    if (encounter.inscriptionsClosed) {
      setErrorMsg('Las inscripciones para este encuentro están cerradas.');
      return;
    }

    if (encounter.openSlots <= 0) {
      setErrorMsg('No quedan lugares disponibles para este encuentro.');
      return;
    }

    if (isBelowMin) {
      setErrorMsg(`Quedan ${encounter.openSlots} ${encounter.openSlots === 1 ? 'lugar' : 'lugares'}, pero el mínimo por solicitud es ${minSeats}.`);
      return;
    }

    // Verificación de identidad: requiere cuenta permanente
    if (!isPermanentUser) {
      // Preservar draft y contexto en sessionStorage antes de abrir LoginRequiredSheet
      try {
        const pendingRequest = {
          encounterId: encounter.id,
          applicantName: applicantName || undefined,
          applicantMessage: applicantMessage || undefined,
          requestedSeats: requestedSeats || 1,
          action: 'request_join' as const,
        };
        sessionStorage.setItem(PENDING_OPEN_REQUEST_KEY, JSON.stringify(pendingRequest));
      } catch {
        /* storage fallback */
      }
      setIsLoginRequired(true);
      return;
    }

    setIsFormOpen(true);
  };

  const handleLoginWithGoogle = async () => {
    if (!encounter) return;

    setLoginLoading(true);

    // Guardar contexto antes del redirect OAuth
    try {
      const pendingRequest = {
        encounterId: encounter.id,
        applicantName: applicantName || undefined,
        applicantMessage: applicantMessage || undefined,
        requestedSeats: requestedSeats || 1,
        action: 'request_join' as const,
      };
      sessionStorage.setItem(PENDING_OPEN_REQUEST_KEY, JSON.stringify(pendingRequest));
    } catch {
      // Si falla sessionStorage (modo privado), continuar igual
    }

    const result = await signInWithGoogleForDiscovery();

    if (!result.ok) {
      setLoginLoading(false);
      try {
        sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY);
      } catch {
        /* storage fallback */
      }

      setErrorMsg('No pudimos iniciar sesión con Google. Intentá nuevamente.');
      setIsLoginRequired(false);
    }
    // Si ok: el redirect OAuth ocurrirá — no hacemos nada más (la página cambia)
  };

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!applicantName.trim()) {
      setErrorMsg('Por favor ingresá tu nombre');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      // SEGURIDAD: solo se envía el nombre, mensaje y cupo solicitado — la identidad la provee el JWT en el backend
      const res = await openEncountersService.solicitarSumarse(
        encounter.id,
        applicantName.trim(),
        applicantMessage.trim(),
        encounter.allowMultiSeatRequests ? requestedSeats : 1
      );

      if (res.ok) {
        setRequestState({
          hasRequest: true,
          status: 'pending',
        });
        setIsFormOpen(false);
      } else {
        if (res.error === 'cannot_join_own_encounter') {
          setErrorMsg('No podés solicitar sumarte a un encuentro que organizás.');
        } else if (res.error === 'duplicate_pending_request') {
          setErrorMsg('Ya tenés una solicitud pendiente para este encuentro.');
        } else if (res.error === 'already_participant') {
          setErrorMsg('Ya estás registrado como participante de este encuentro.');
        } else if (res.error === 'encounter_full') {
          setErrorMsg('El cupo para este encuentro ya se encuentra completo.');
        } else if (res.error === 'available_seats_below_min_request') {
          setErrorMsg(res.message || `Quedan ${encounter.openSlots} lugares, pero el mínimo por solicitud es ${minSeats}.`);
        } else if (res.error === 'seats_below_minimum') {
          setErrorMsg(res.message || `El mínimo de lugares por solicitud es ${minSeats}.`);
        } else if (res.error === 'insufficient_available_slots') {
          setErrorMsg(res.message || 'No hay suficientes lugares disponibles.');
        } else if (res.error === 'seats_exceed_limit' || res.error === 'seats_exceed_capacity') {
          setErrorMsg('La cantidad de lugares solicitados supera el límite disponible para este encuentro.');
        } else if (res.error === 'permanent_account_required' || res.error === 'authentication_required') {
          setErrorMsg('Se requiere iniciar sesión para solicitar sumarte.');
          setIsFormOpen(false);
          setIsLoginRequired(true);
        } else if (res.error === 'rate_limit_exceeded') {
          setErrorMsg('Hiciste varias solicitudes en poco tiempo. Esperá un rato e intentá nuevamente.');
        } else if (res.error === 'rate_limit_unavailable') {
          setErrorMsg('No pudimos enviar tu solicitud en este momento. Intentá nuevamente en unos minutos.');
        } else if (
          res.error === 'encuentro_not_found' ||
          res.error === 'encuentro_not_active' ||
          res.error === 'encuentro_not_open' ||
          res.error === 'encuentro_not_available' ||
          res.error === 'encounter_not_available'
        ) {
          setErrorMsg('Este encuentro ya no está disponible para sumarse.');
        } else if (res.error === 'request_not_available') {
          setErrorMsg('Esta solicitud no está disponible en este momento.');
        } else {
          setErrorMsg(res.message || 'No pudimos enviar tu solicitud. Intentá nuevamente.');
        }
      }
    } catch (err: any) {
      if (err?.message === 'rate_limit_exceeded') {
        setErrorMsg('Hiciste varias solicitudes en poco tiempo. Esperá un rato e intentá nuevamente.');
      } else if (err?.message === 'cannot_join_own_encounter') {
        setErrorMsg('No podés solicitar sumarte a un encuentro que organizás.');
      } else if (err?.message === 'request_not_available') {
        setErrorMsg('Esta solicitud no está disponible en este momento.');
      } else {
        setErrorMsg(err?.message && !err.message.includes('{') ? err.message : 'Error al enviar la solicitud');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleNavigateToEncounter = () => {
    onClose();
    navigate(`/?tab=encuentros&scope=participo`);
  };

  const modalContent = (
    <>
      <div className="pe-detail-overlay" onClick={onClose} aria-hidden="true" />

      <div
        className="pe-detail-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pe-detail-title"
      >
        <div className="pe-detail-sheet__handle" aria-hidden="true" />

        <div className="pe-detail-sheet__header">
          <div className="pe-detail-sheet__title-row">
            {encounter.emoji && (
              <span className="pe-detail-sheet__emoji" aria-hidden="true">
                {encounter.emoji}
              </span>
            )}
            <h2 id="pe-detail-title" className="pe-detail-sheet__title">
              {authorizedDetail?.open_public_title || encounter.title}
            </h2>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="pe-detail-sheet__close-btn"
            onClick={onClose}
            aria-label="Cerrar detalle"
          >
            <X size={18} />
          </button>
        </div>

        {/* Banner Demo de Lanzamiento (solo para demo) */}
        {isDemo && (
          <div className="pe-detail-sheet__demo-banner">
            <span className="pe-detail-sheet__demo-badge">
              {t('open_encounters.demo_badge', { defaultValue: 'Lanzamiento · Demo' })}
            </span>
            <span>
              {t('open_encounters.demo_disclaimer', {
                defaultValue:
                  'Esta es una vista previa del lanzamiento de PuntoEncuentro 1.0. Las solicitudes se habilitarán con la versión final.',
              })}
            </span>
          </div>
        )}

        {/* Banner de Encuentro Cancelado */}
        {authorizedDetail?.estado === 'cancelado' && (
          <div className="pe-detail-sheet__cancellation-banner" style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '12px', padding: '1rem', margin: '0 1rem 1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#dc2626', fontWeight: 600 }}>
              <XCircle size={18} />
              <span>Este encuentro fue cancelado por el anfitrión</span>
            </div>
            {authorizedDetail.cancellation_reason && (
              <p style={{ color: '#991b1b', fontSize: '0.875rem', margin: '0.5rem 0 0', lineHeight: 1.4 }}>
                <strong>Motivo:</strong> {authorizedDetail.cancellation_reason}
              </p>
            )}
          </div>
        )}

        {/* Banner de Participante Aprobado */}
        {isApprovedParticipant && authorizedDetail?.estado !== 'cancelado' && (
          <div className="pe-detail-sheet__approved-banner">
            <div className="pe-detail-sheet__approved-title-row">
              <CheckCircle2 size={18} className="pe-detail-sheet__approved-icon" aria-hidden="true" />
              <h3 className="pe-detail-sheet__approved-title">
                {participantSeats > 1
                  ? `Tus ${participantSeats} lugares están confirmados`
                  : 'Tu lugar está confirmado'}
              </h3>
            </div>
            <p className="pe-detail-sheet__approved-subtitle">
              {participantSeats > 1
                ? `${participantSeats} lugares confirmados para este encuentro.`
                : '1 lugar confirmado para este encuentro.'}
            </p>
            {authorizedDetail?.realization_status === 'pending' && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#b45309', background: '#fef3c7', padding: '0.35rem 0.6rem', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Clock size={14} />
                <span>Esperando mínimo de participantes para confirmar realización.</span>
              </div>
            )}
            {authorizedDetail?.realization_status === 'confirmed' && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#047857', background: '#d1fae5', padding: '0.35rem 0.6rem', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <CheckCircle2 size={14} />
                <span>¡Se hace! El encuentro alcanzó el mínimo de participantes.</span>
              </div>
            )}
            {authorizedDetail?.realization_status === 'forced' && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#047857', background: '#d1fae5', padding: '0.35rem 0.6rem', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <CheckCircle2 size={14} />
                <span>¡Confirmado por el anfitrión! El encuentro se realizará.</span>
              </div>
            )}
          </div>
        )}

        {/* Grilla de Metadatos */}
        <div className="pe-detail-sheet__meta-grid">
          <div className="pe-detail-sheet__meta-block">
            <span className="pe-detail-sheet__meta-label">
              <Calendar size={12} aria-hidden="true" /> Fecha y hora
            </span>
            <span className="pe-detail-sheet__meta-value">{encounter.dateLabel}</span>
          </div>

          {isApprovedParticipant ? (
            <div className="pe-detail-sheet__meta-block pe-detail-sheet__meta-block--highlight">
              <span className="pe-detail-sheet__meta-label" style={{ color: '#047857' }}>
                <Users size={12} aria-hidden="true" /> Tu reserva
              </span>
              <span className="pe-detail-sheet__meta-value" style={{ color: '#065f46', fontWeight: 700 }}>
                {participantSeats > 1
                  ? `${participantSeats} lugares confirmados`
                  : '1 lugar confirmado'}
              </span>
            </div>
          ) : (
            <div className="pe-detail-sheet__meta-block">
              <span className="pe-detail-sheet__meta-label">
                <Users size={12} aria-hidden="true" /> Disponibilidad
              </span>
              <span className="pe-detail-sheet__meta-value" style={{ color: '#059669' }}>
                {slotLabel}
              </span>
            </div>
          )}

          {authorizedDetail?.lugar_texto ? (
            <div className="pe-detail-sheet__meta-block pe-detail-sheet__meta-block--full pe-detail-sheet__meta-block--authorized">
              <span className="pe-detail-sheet__meta-label" style={{ color: '#047857', fontWeight: 600 }}>
                <MapPin size={12} aria-hidden="true" /> Dirección
              </span>
              <span className="pe-detail-sheet__meta-value" style={{ fontWeight: 600, color: '#065f46', wordBreak: 'break-word' }}>
                {authorizedDetail.lugar_texto}
              </span>
            </div>
          ) : authorizedDetail?.link_virtual ? (
            <div className="pe-detail-sheet__meta-block pe-detail-sheet__meta-block--full pe-detail-sheet__meta-block--authorized">
              <span className="pe-detail-sheet__meta-label" style={{ color: '#047857', fontWeight: 600 }}>
                <Video size={12} aria-hidden="true" /> Enlace para participar
              </span>
              <a
                href={authorizedDetail.link_virtual}
                target="_blank"
                rel="noopener noreferrer"
                className="pe-detail-sheet__meta-value pe-detail-sheet__virtual-link"
                style={{ color: '#2563eb', textDecoration: 'underline', wordBreak: 'break-all' }}
              >
                {authorizedDetail.link_virtual}
              </a>
            </div>
          ) : (
            <div className="pe-detail-sheet__meta-block">
              <span className="pe-detail-sheet__meta-label">
                <MapPin size={12} aria-hidden="true" /> Zona aproximada
              </span>
              <span className="pe-detail-sheet__meta-value">{encounter.approximateZone}</span>
            </div>
          )}

          {isApprovedParticipant && (
            <div className="pe-detail-sheet__meta-block">
              <span className="pe-detail-sheet__meta-label">
                <MapPin size={12} aria-hidden="true" /> Zona pública
              </span>
              <span className="pe-detail-sheet__meta-value">{authorizedDetail?.open_public_zone || encounter.approximateZone}</span>
            </div>
          )}

          <div className="pe-detail-sheet__meta-block">
            <span className="pe-detail-sheet__meta-label">
              <Info size={12} aria-hidden="true" /> Confirmados
            </span>
            <span className="pe-detail-sheet__meta-value">{confirmedLabel}</span>
          </div>
        </div>

        {/* Descripción */}
        {(authorizedDetail?.open_description || encounter.description) && (
          <div className="pe-detail-sheet__desc-box">
            <h4 className="pe-detail-sheet__desc-title">Sobre este plan</h4>
            <p className="pe-detail-sheet__desc">
              {authorizedDetail?.open_description !== undefined && authorizedDetail.open_description !== ''
                ? authorizedDetail.open_description
                : encounter.description}
            </p>
          </div>
        )}

        {authorizedDetail?.lugar_texto || authorizedDetail?.link_virtual ? (
          <p className="pe-detail-sheet__privacy-note" style={{ color: '#047857' }}>
            📍 Como tu participación está confirmada, acá tenés los datos para asistir.
          </p>
        ) : (
          <p className="pe-detail-sheet__privacy-note">
            📍 Solo compartimos la zona aproximada para cuidar la privacidad de la juntada. La dirección puntual se compartirá una vez confirmada la participación.
          </p>
        )}

        {!isDemo && !isHost && (
          <div className="pe-detail-sheet__report-row">
            <button
              ref={reportBtnRef}
              type="button"
              className={`pe-detail-sheet__btn-report ${isReported ? 'pe-detail-sheet__btn-report--reported' : ''}`}
              onClick={() => !isReported && setIsReportModalOpen(true)}
              disabled={isReported}
              title={
                isReported
                  ? t('open_encounters.reported_status', { defaultValue: 'Reportada' })
                  : t('open_encounters.report_action', { defaultValue: 'Reportar publicación' })
              }
            >
              <Flag size={13} aria-hidden="true" />
              <span>
                {isReported
                  ? t('open_encounters.reported_status', { defaultValue: 'Reportada' })
                  : t('open_encounters.report_action', { defaultValue: 'Reportar publicación' })}
              </span>
            </button>
          </div>
        )}

        {/* Error global (fuera del form) */}
        {errorMsg && !isFormOpen && (
          <div className="pe-detail-sheet__form-error" style={{ margin: '0 1rem 0.75rem' }}>
            {errorMsg}
          </div>
        )}

        {/* Acciones y Formulario */}
        <div className="pe-detail-sheet__actions">
          {isHost ? (
            <div className="pe-detail-sheet__host-box">
              <div className="pe-detail-sheet__host-notice">
                <Users size={16} aria-hidden="true" />
                <span>{t('open_encounters.host_own_encounter', { defaultValue: 'Este encuentro lo organizás vos' })}</span>
              </div>
              <button
                type="button"
                className="pe-detail-sheet__cta pe-detail-sheet__cta--primary"
                onClick={() => {
                  navigate(`/meet/${encounter.id}`);
                  onClose();
                }}
              >
                {t('open_encounters.manage_encounter', { defaultValue: 'Gestionar encuentro' })}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
          ) : isApprovedParticipant ? (
            <div className="pe-detail-sheet__status-box pe-detail-sheet__status-box--approved">
              <div className="pe-detail-sheet__status-title" style={{ color: '#059669' }}>
                <CheckCircle2 size={16} />
                <span>
                  {participantSeats > 1
                    ? `Tus ${participantSeats} lugares están confirmados`
                    : 'Tu lugar está confirmado'}
                </span>
              </div>
              <p className="pe-detail-sheet__status-desc">
                Ya formás parte de este encuentro. Podés ver los detalles y coordinar en Mis encuentros.
              </p>

              {/* Reconfirmación de asistencia si inscripciones están cerradas y el encuentro está confirmado o forzado */}
              {authorizedDetail?.inscriptions_closed &&
                (authorizedDetail.realization_status === 'confirmed' || authorizedDetail.realization_status === 'forced') && (
                  <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <p style={{ fontWeight: 600, fontSize: '0.875rem', color: '#1e293b', marginBottom: '0.25rem' }}>
                      ¿Seguís viniendo?
                    </p>
                    {reconfirmStatus === 'confirmed' ? (
                      <p style={{ fontSize: '0.8rem', color: '#059669', display: 'flex', alignItems: 'center', gap: '0.25rem', margin: 0 }}>
                        <CheckCircle2 size={14} /> Confirmaste tu asistencia. ¡Nos vemos!
                      </p>
                    ) : reconfirmStatus === 'declined' ? (
                      <p style={{ fontSize: '0.8rem', color: '#dc2626', display: 'flex', alignItems: 'center', gap: '0.25rem', margin: 0 }}>
                        <XCircle size={14} /> Avisaste que no vas a poder asistir. Tus lugares fueron liberados.
                      </p>
                    ) : (
                      <>
                        <p style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '0.5rem' }}>
                          El encuentro ya está confirmado. Por favor confirmale al anfitrión si vas a asistir.
                        </p>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button
                            type="button"
                            className="pe-detail-sheet__cta"
                            style={{ flex: 1, padding: '0.4rem 0.6rem', fontSize: '0.8rem', background: '#059669', color: '#fff', borderRadius: '6px', border: 'none', cursor: 'pointer' }}
                            onClick={() => handleReconfirm('confirm')}
                            disabled={reconfirming}
                          >
                            {reconfirming ? 'Guardando…' : 'Confirmar asistencia'}
                          </button>
                          <button
                            type="button"
                            className="pe-detail-sheet__btn-cancel"
                            style={{ flex: 1, padding: '0.4rem 0.6rem', fontSize: '0.8rem', borderRadius: '6px', cursor: 'pointer', border: '1px solid #cbd5e1' }}
                            onClick={() => handleReconfirm('decline')}
                            disabled={reconfirming}
                          >
                            No voy a poder
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

              <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="pe-detail-sheet__cta pe-detail-sheet__cta--primary"
                  onClick={handleNavigateToEncounter}
                >
                  {t('open_encounters.request_view_encounter', { defaultValue: 'Ir a Mis encuentros' })}
                  <ArrowRight size={16} />
                </button>
                <button
                  type="button"
                  className="pe-detail-sheet__btn-cancel"
                  style={{ color: '#dc2626', borderColor: '#fca5a5', padding: '0.5rem', fontSize: '0.8125rem' }}
                  onClick={() => setIsWithdrawModalOpen(true)}
                  disabled={withdrawing}
                >
                  {t('open_encounters.withdraw_action', { defaultValue: 'No voy a poder asistir' })}
                </button>
              </div>
              {/* Panel de mensajes para participante confirmado */}
              {encounter?.id && (
                <div style={{ marginTop: '1rem' }}>
                  <EncounterMessagesPanel
                    encuentroId={encounter.id}
                    isHost={false}
                    isConfirmed={true}
                  />
                </div>
              )}
            </div>

          ) : requestState.hasRequest ? (
            <div className={`pe-detail-sheet__status-box pe-detail-sheet__status-box--${requestState.status}`}>
              {requestState.status === 'pending' && (
                <>
                  <div className="pe-detail-sheet__status-title">
                    <Clock size={16} />
                    <span>{t('open_encounters.request_pending', { defaultValue: 'Solicitud pendiente' })}</span>
                  </div>
                  <p className="pe-detail-sheet__status-desc">
                    {t('open_encounters.request_success_notice', {
                      defaultValue: 'Tu solicitud fue enviada al organizador. Te avisaremos cuando sea aprobada.',
                    })}
                  </p>
                </>
              )}

              {requestState.status === 'rejected' && (
                <>
                  <div className="pe-detail-sheet__status-title" style={{ color: '#dc2626' }}>
                    <XCircle size={16} />
                    <span>{t('open_encounters.request_rejected', { defaultValue: 'Solicitud no aceptada' })}</span>
                  </div>
                  <p className="pe-detail-sheet__status-desc">
                    El organizador no pudo sumar más participantes en esta ocasión.
                  </p>
                </>
              )}

              {(requestState.status === 'withdrawn' || requestState.status === 'cancelled') && (
                <>
                  <div className="pe-detail-sheet__status-title" style={{ color: '#64748b' }}>
                    <XCircle size={16} />
                    <span>{t('open_encounters.request_withdrawn_title', { defaultValue: 'Te diste de baja' })}</span>
                  </div>
                  <p className="pe-detail-sheet__status-desc">
                    {t('open_encounters.request_withdrawn_desc', {
                      defaultValue: 'Avisaste que no podías asistir y tus lugares fueron liberados.',
                    })}
                  </p>
                  {!encounter.inscriptionsClosed && encounter.openSlots > 0 && (
                    <button
                      type="button"
                      className="pe-detail-sheet__cta pe-detail-sheet__cta--primary"
                      style={{ marginTop: '0.5rem' }}
                      onClick={() => setIsFormOpen(true)}
                    >
                      {t('open_encounters.reapply_action', { defaultValue: 'Volver a solicitar sumarme' })}
                    </button>
                  )}
                </>
              )}
            </div>

          ) : isFormOpen ? (
            <form onSubmit={handleSubmitRequest} className="pe-detail-sheet__request-form">
              <h4 className="pe-detail-sheet__form-title">
                {t('open_encounters.request_modal_title', { defaultValue: 'Sumarme a este encuentro' })}
              </h4>

              {errorMsg && <div className="pe-detail-sheet__form-error">{errorMsg}</div>}

              <div className="pe-detail-sheet__form-field">
                <label className="pe-detail-sheet__label">
                  {t('open_encounters.request_name_label', { defaultValue: 'Tu nombre' })} *
                </label>
                <input
                  type="text"
                  required
                  className="pe-detail-sheet__input"
                  placeholder={t('open_encounters.request_name_placeholder', { defaultValue: '¿Cómo te llamás?' })}
                  value={applicantName}
                  onChange={(e) => setApplicantName(e.target.value)}
                  maxLength={50}
                />
              </div>

              {encounter.allowMultiSeatRequests && (
                <div className="pe-detail-sheet__form-field pe-detail-sheet__seats-selector">
                  <div className="pe-detail-sheet__seats-header">
                    <label className="pe-detail-sheet__label" style={{ marginBottom: 0 }}>
                      Lugares que querés reservar
                    </label>
                    <span className="pe-detail-sheet__seats-helper">
                      Incluyéndote a vos{minSeats > 1 ? ` (mínimo ${minSeats})` : ''}
                    </span>
                  </div>
                  <div className="pe-detail-sheet__seats-stepper">
                    <button
                      type="button"
                      className="pe-detail-sheet__seats-btn pe-detail-sheet__seats-btn--minus"
                      onClick={() => setRequestedSeats((s) => Math.max(minSeats, Math.max(1, s - 1)))}
                      disabled={requestedSeats <= 1 || requestedSeats <= minSeats}
                      aria-label="Disminuir lugares"
                    >
                      −
                    </button>
                    <span className="pe-detail-sheet__seats-count" aria-live="polite">
                      {requestedSeats}
                    </span>
                    <button
                      type="button"
                      className="pe-detail-sheet__seats-btn pe-detail-sheet__seats-btn--plus"
                      onClick={() =>
                        setRequestedSeats((s) =>
                          Math.min(
                            effectiveMax,
                            s + 1
                          )
                        )
                      }
                      disabled={requestedSeats >= effectiveMax}
                      aria-label="Aumentar lugares"
                    >
                      +
                    </button>
                  </div>
                </div>
              )}

              <div className="pe-detail-sheet__form-field">
                <label className="pe-detail-sheet__label">
                  {t('open_encounters.request_msg_label', { defaultValue: 'Mensaje para el anfitrión (opcional)' })}
                </label>
                <textarea
                  className="pe-detail-sheet__textarea"
                  placeholder={t('open_encounters.request_msg_placeholder', {
                    defaultValue: 'Contale un poco sobre vos o tu interés en el plan',
                  })}
                  value={applicantMessage}
                  onChange={(e) => setApplicantMessage(e.target.value)}
                  maxLength={300}
                  rows={3}
                />
              </div>

              <div className="pe-detail-sheet__form-actions">
                <button
                  type="button"
                  className="pe-detail-sheet__btn-cancel"
                  onClick={() => setIsFormOpen(false)}
                  disabled={submitting}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="pe-detail-sheet__cta pe-detail-sheet__cta--primary"
                  disabled={submitting}
                >
                  {submitting ? 'Enviando…' : t('open_encounters.request_submit', { defaultValue: 'Enviar solicitud' })}
                </button>
              </div>
            </form>
          ) : encounter.inscriptionsClosed ? (
            <div className="pe-detail-sheet__status-box pe-detail-sheet__status-box--closed" style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', padding: '1rem', borderRadius: '12px' }}>
              <div className="pe-detail-sheet__status-title" style={{ color: '#4b5563', display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
                <DoorClosed size={16} />
                <span>Inscripciones cerradas</span>
              </div>
              <p className="pe-detail-sheet__status-desc" style={{ color: '#6b7280', fontSize: '0.875rem', marginTop: '0.25rem' }}>
                El anfitrión ha cerrado las inscripciones para este encuentro.
              </p>
            </div>
          ) : encounter.openSlots <= 0 ? (
            <div className="pe-detail-sheet__status-box pe-detail-sheet__status-box--full" style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', padding: '1rem', borderRadius: '12px' }}>
              <div className="pe-detail-sheet__status-title" style={{ color: '#4b5563', display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
                <AlertCircle size={16} />
                <span>Completo · Sin lugares disponibles</span>
              </div>
              <p className="pe-detail-sheet__status-desc" style={{ color: '#6b7280', fontSize: '0.875rem', marginTop: '0.25rem' }}>
                No quedan lugares disponibles para este encuentro.
              </p>
            </div>
          ) : isBelowMin ? (
            <div className="pe-detail-sheet__status-box pe-detail-sheet__status-box--rejected">
              <div className="pe-detail-sheet__status-title" style={{ color: '#d97706' }}>
                <AlertCircle size={16} />
                <span>Lugares no disponibles</span>
              </div>
              <p className="pe-detail-sheet__status-desc">
                Quedan {encounter.openSlots} {encounter.openSlots === 1 ? 'lugar' : 'lugares'}, pero el mínimo por solicitud es {minSeats}.
              </p>
            </div>
          ) : (
            <>
              <button
                type="button"
                className={`pe-detail-sheet__cta ${isDemo ? 'pe-detail-sheet__cta--demo' : 'pe-detail-sheet__cta--primary'}`}
                onClick={handleStartRequest}
                disabled={isDemo || encounter.openSlots <= 0}
                title={isDemo ? 'Función demo para el lanzamiento' : undefined}
              >
                {t('open_encounters.request_join', { defaultValue: 'Solicitar sumarme' })}
              </button>
              {isDemo && (
                <p className="pe-detail-sheet__demo-hint">
                  Vista previa no interactiva con backend real.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* LoginRequiredSheet — aparece por encima del DetailSheet cuando corresponde */}
      <LoginRequiredSheet
        isOpen={isLoginRequired}
        onClose={() => {
          setIsLoginRequired(false);
          try {
            sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY);
          } catch {
            /* storage fallback */
          }
        }}
        onContinueWithGoogle={handleLoginWithGoogle}
        loading={loginLoading}
        action="request_join"
      />

      {encounter && !isDemo && (
        <ReportPublicEncounterModal
          isOpen={isReportModalOpen}
          onClose={() => {
            setIsReportModalOpen(false);
            setPendingReportData(null);
            try {
              sessionStorage.removeItem(PENDING_OPEN_REPORT_KEY);
            } catch {
              /* storage fallback */
            }
            setTimeout(() => {
              if (reportBtnRef.current && !reportBtnRef.current.disabled) {
                reportBtnRef.current.focus();
              } else {
                closeBtnRef.current?.focus();
              }
            }, 50);
          }}
          encuentroId={encounter.id}
          encounterTitle={encounter.title}
          initialReason={pendingReportData?.reason}
          initialComment={pendingReportData?.comment}
          onReportSuccess={() => {
            setIsReported(true);
            setPendingReportData(null);
            try {
              sessionStorage.removeItem(PENDING_OPEN_REPORT_KEY);
            } catch {
              /* storage fallback */
            }
          }}
        />
      )}

      {/* Modal de confirmación de baja voluntaria (H9 / H10) */}

      {isWithdrawModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pe-withdraw-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10001,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '16px',
              padding: '1.25rem',
              maxWidth: '400px',
              width: '100%',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
            }}
          >
            <h3
              id="pe-withdraw-dialog-title"
              style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}
            >
              {t('open_encounters.withdraw_confirm_title', { defaultValue: '¿No vas a poder asistir?' })}
            </h3>
            <p style={{ margin: '0 0 1rem 0', fontSize: '0.85rem', color: '#475569', lineHeight: 1.4 }}>
              {t('open_encounters.withdraw_confirm_desc', {
                defaultValue: 'Tus lugares se liberarán inmediatamente para que otras personas puedan sumarse. Le avisaremos al organizador.',
              })}
            </p>

            <div style={{ marginBottom: '1rem' }}>
              <label
                htmlFor="pe-withdraw-reason"
                style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: '0.35rem' }}
              >
                {t('open_encounters.withdraw_reason_label', {
                  defaultValue: 'Mensaje para el organizador (opcional)',
                })}
              </label>
              <textarea
                id="pe-withdraw-reason"
                rows={3}
                maxLength={280}
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                placeholder={t('open_encounters.withdraw_reason_placeholder', {
                  defaultValue: 'ej. Me surgió un imprevisto familiar…',
                })}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  border: '1px solid #cbd5e1',
                  borderRadius: '8px',
                  padding: '0.5rem',
                  fontSize: '0.85rem',
                  fontFamily: 'inherit',
                  resize: 'none',
                }}
              />
              <span style={{ display: 'block', textAlign: 'right', fontSize: '0.7rem', color: '#94a3b8', marginTop: '2px' }}>
                {withdrawReason.length}/280
              </span>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="pe-detail-sheet__btn-cancel"
                onClick={() => {
                  setIsWithdrawModalOpen(false);
                  setWithdrawReason('');
                }}
                disabled={withdrawing}
              >
                {t('common.cancel', { defaultValue: 'Volver' })}
              </button>
              <button
                type="button"
                style={{
                  backgroundColor: '#dc2626',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '0.5rem 1rem',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                onClick={handleExecuteWithdrawal}
                disabled={withdrawing}
              >
                {withdrawing
                  ? t('common.loading', { defaultValue: 'Avisando…' })
                  : t('open_encounters.withdraw_confirm_btn', { defaultValue: 'Avisar que no voy' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </>

  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(modalContent, document.body);
  }

  return modalContent;
};
