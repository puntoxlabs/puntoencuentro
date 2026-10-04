import React, { useEffect, useRef, useState } from 'react';
import { X, Calendar, MapPin, Users, Info, CheckCircle2, Clock, XCircle, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { OpenEncounterSummary } from './types';
import { getSlotLabel } from './types';
import { openEncountersService } from '@/services/openEncountersService';
import { getHostAlias } from '@/lib/hostAliasStorage';
import { useAuth } from '@/contexts/AuthContext';
import { LoginRequiredSheet } from '@/components/auth/LoginRequiredSheet';
import './HomeOpenEncounterDetailSheet.css';

// Clave de sessionStorage para persistir contexto de solicitud entre redirect OAuth
const PENDING_OPEN_REQUEST_KEY = 'pending_open_request';

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

  // Estados de solicitud
  const [requestState, setRequestState] = useState<{
    hasRequest: boolean;
    status?: 'pending' | 'approved' | 'rejected' | 'withdrawn';
    tokenParticipante?: string;
  }>({ hasRequest: false });
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isLoginRequired, setIsLoginRequired] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [applicantName, setApplicantName] = useState('');
  const [applicantMessage, setApplicantMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isDemo = encounter?.id?.startsWith('demo-') ?? false;

  // userId solo para consultar estado de solicitud propio — SOLO si es permanente
  const userId = isPermanentUser ? user?.id ?? null : null;

  useEffect(() => {
    if (!isOpen || !encounter) return;

    // Resetear formulario y estado de login
    setIsFormOpen(false);
    setIsLoginRequired(false);
    setErrorMsg(null);
    setApplicantName(getHostAlias() || '');
    setApplicantMessage('');

    // Consultar estado de solicitud previa — solo si usuario permanente
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
    } else {
      setRequestState({ hasRequest: false });
    }

    // Recuperar contexto de solicitud pendiente post-OAuth
    // Si el usuario acaba de loguearse y hay un pending_open_request para ESTE encuentro,
    // abrimos automáticamente el formulario de solicitud.
    if (isPermanentUser && !isDemo) {
      try {
        const raw = sessionStorage.getItem(PENDING_OPEN_REQUEST_KEY);
        if (raw) {
          const pending = JSON.parse(raw) as { encounterId: string; applicantName?: string; applicantMessage?: string; action: string };
          if (pending.action === 'request_join' && pending.encounterId === encounter.id) {
            // Recuperar nombre y mensaje del contexto guardado
            if (pending.applicantName) setApplicantName(pending.applicantName);
            if (pending.applicantMessage) setApplicantMessage(pending.applicantMessage);
            setIsFormOpen(true);
            sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY);
          }
        }
      } catch {
        sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY);
      }
    }
  }, [isOpen, encounter?.id, isDemo, userId, isPermanentUser]);

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
  const confirmedLabel =
    encounter.confirmedCount === 0
      ? t('open_encounters.confirmed_zero', { defaultValue: '0 personas confirmadas' })
      : encounter.confirmedCount === 1
      ? t('open_encounters.confirmed_single', { defaultValue: '1 persona confirmada' })
      : t('open_encounters.confirmed_people', {
          count: encounter.confirmedCount,
          defaultValue: `${encounter.confirmedCount} personas confirmadas`,
        });

  const handleStartRequest = () => {
    if (isDemo) {
      // Para demo simplemente mostramos estado simulado
      setRequestState({ hasRequest: true, status: 'pending' });
      return;
    }

    // Verificación de identidad: requiere cuenta permanente
    if (!isPermanentUser) {
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
        action: 'request_join' as const,
      };
      sessionStorage.setItem(PENDING_OPEN_REQUEST_KEY, JSON.stringify(pendingRequest));
    } catch {
      // Si falla sessionStorage (modo privado), continuar igual
    }

    const result = await signInWithGoogleForDiscovery();

    if (!result.ok) {
      setLoginLoading(false);
      sessionStorage.removeItem(PENDING_OPEN_REQUEST_KEY);

      if (result.error === 'anonymous_has_critical_resources') {
        setErrorMsg(
          'Tu cuenta tiene encuentros activos. Por favor contactá soporte para hacer el cambio sin perder datos.'
        );
      } else {
        setErrorMsg('No pudimos iniciar el login. Intentá nuevamente.');
      }
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
      // SEGURIDAD: solo se envía el nombre y mensaje — la identidad la provee el JWT en el backend
      const res = await openEncountersService.solicitarSumarse(
        encounter.id,
        applicantName.trim(),
        applicantMessage.trim()
      );

      if (res.ok) {
        setRequestState({
          hasRequest: true,
          status: 'pending',
        });
        setIsFormOpen(false);
      } else {
        if (res.error === 'encounter_full') {
          setErrorMsg('El cupo para este encuentro ya se encuentra completo.');
        } else if (res.error === 'already_participant') {
          setErrorMsg('Ya estás registrado como participante de este encuentro.');
        } else if (res.error === 'permanent_account_required') {
          // El backend rechazó el JWT anónimo — forzar logout local (no debería ocurrir)
          setErrorMsg('Se requiere una cuenta permanente para solicitar sumarte.');
          setIsFormOpen(false);
          setIsLoginRequired(true);
        } else if (res.error === 'rate_limit_exceeded') {
          setErrorMsg('Hiciste varias solicitudes en poco tiempo. Esperá un rato e intentá nuevamente.');
        } else if (res.error === 'rate_limit_unavailable') {
          setErrorMsg('No pudimos enviar tu solicitud en este momento. Intentá nuevamente en unos minutos.');
        } else if (res.error === 'request_not_available') {
          setErrorMsg('Esta solicitud no está disponible en este momento.');
        } else {
          setErrorMsg('No pudimos enviar tu solicitud. Intentá nuevamente.');
        }
      }
    } catch (err: any) {
      if (err?.message === 'rate_limit_exceeded') {
        setErrorMsg('Hiciste varias solicitudes en poco tiempo. Esperá un rato e intentá nuevamente.');
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
    if (requestState.tokenParticipante) {
      navigate(`/invite/${encodeURIComponent(requestState.tokenParticipante)}`);
    }
    onClose();
  };

  return (
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
              {encounter.title}
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

        {/* Grilla de Metadatos */}
        <div className="pe-detail-sheet__meta-grid">
          <div className="pe-detail-sheet__meta-block">
            <span className="pe-detail-sheet__meta-label">
              <Calendar size={12} aria-hidden="true" /> Fecha y hora
            </span>
            <span className="pe-detail-sheet__meta-value">{encounter.dateLabel}</span>
          </div>

          <div className="pe-detail-sheet__meta-block">
            <span className="pe-detail-sheet__meta-label">
              <MapPin size={12} aria-hidden="true" /> Zona aproximada
            </span>
            <span className="pe-detail-sheet__meta-value">{encounter.approximateZone}</span>
          </div>

          <div className="pe-detail-sheet__meta-block">
            <span className="pe-detail-sheet__meta-label">
              <Users size={12} aria-hidden="true" /> Disponibilidad
            </span>
            <span className="pe-detail-sheet__meta-value" style={{ color: '#059669' }}>
              {slotLabel}
            </span>
          </div>

          <div className="pe-detail-sheet__meta-block">
            <span className="pe-detail-sheet__meta-label">
              <Info size={12} aria-hidden="true" /> Confirmados
            </span>
            <span className="pe-detail-sheet__meta-value">{confirmedLabel}</span>
          </div>
        </div>

        {/* Descripción */}
        {encounter.description && (
          <div className="pe-detail-sheet__desc-box">
            <h4 className="pe-detail-sheet__desc-title">Sobre este plan</h4>
            <p className="pe-detail-sheet__desc">{encounter.description}</p>
          </div>
        )}

        <p className="pe-detail-sheet__privacy-note">
          📍 Solo compartimos la zona aproximada para cuidar la privacidad de la juntada. La dirección puntual se compartirá una vez confirmada la participación.
        </p>

        {/* Error global (fuera del form) */}
        {errorMsg && !isFormOpen && (
          <div className="pe-detail-sheet__form-error" style={{ margin: '0 1rem 0.75rem' }}>
            {errorMsg}
          </div>
        )}

        {/* Acciones y Formulario */}
        <div className="pe-detail-sheet__actions">
          {requestState.hasRequest ? (
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

              {requestState.status === 'approved' && (
                <>
                  <div className="pe-detail-sheet__status-title" style={{ color: '#059669' }}>
                    <CheckCircle2 size={16} />
                    <span>{t('open_encounters.request_approved', { defaultValue: '¡Solicitud aceptada!' })}</span>
                  </div>
                  <p className="pe-detail-sheet__status-desc">
                    Ya formás parte de este encuentro. Podés ver la dirección y coordinar.
                  </p>
                  <button
                    type="button"
                    className="pe-detail-sheet__cta pe-detail-sheet__cta--primary"
                    onClick={handleNavigateToEncounter}
                  >
                    {t('open_encounters.request_view_encounter', { defaultValue: 'Ver encuentro' })}
                    <ArrowRight size={16} />
                  </button>
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
          ) : (
            <>
              <button
                type="button"
                className={`pe-detail-sheet__cta ${isDemo ? 'pe-detail-sheet__cta--demo' : 'pe-detail-sheet__cta--primary'}`}
                onClick={handleStartRequest}
                disabled={isDemo || encounter.openSlots <= 0}
                title={isDemo ? 'Función demo para el lanzamiento' : undefined}
              >
                {encounter.openSlots <= 0
                  ? t('open_encounters.full', { defaultValue: 'Completo' })
                  : t('open_encounters.request_join', { defaultValue: 'Solicitar sumarme' })}
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
        onClose={() => setIsLoginRequired(false)}
        onContinueWithGoogle={handleLoginWithGoogle}
        loading={loginLoading}
        action="request_join"
      />
    </>
  );
};
