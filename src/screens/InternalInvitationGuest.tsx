import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Calendar,
  Clock,
  MapPin,
  Video,
  User,
  CheckCircle2,
  XCircle,
  AlertCircle,
  MessageSquare,
} from 'lucide-react';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { internalInvitationsService } from '@/services/internalInvitationsService';
import { formatFriendlyDate } from '@/lib/formatDate';
import type { InternalInvitationDetail } from '@/types/internalInvitations';
import './InternalInvitationGuest.css';

export const InternalInvitationGuest: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user, loading: authLoading, signInWithGoogle } = useAuth();
  const isPermanent = Boolean(user && !user.is_anonymous);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<InternalInvitationDetail | null>(null);

  const [mensajeRespuesta, setMensajeRespuesta] = useState('');
  const [responding, setResponding] = useState(false);
  const [responseFeedback, setResponseFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const loadDetail = useCallback(async () => {
    if (!id || authLoading) return;
    if (!isPermanent) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const res = await internalInvitationsService.getDetalleInvitacion(id);
      if (res.ok && res.data) {
        setDetail(res.data);
      } else {
        setError(res.error || 'No se encontró la invitación o no tenés permiso para verla.');
      }
    } catch (err: any) {
      setError(err?.message || 'Error al cargar la invitación.');
    } finally {
      setLoading(false);
    }
  }, [id, authLoading, isPermanent]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const handleResponder = async (respuesta: 'aceptada' | 'rechazada') => {
    if (!id || responding) return;

    try {
      setResponding(true);
      setResponseFeedback(null);
      const res = await internalInvitationsService.responderInvitacion(
        id,
        respuesta,
        mensajeRespuesta.trim() || undefined
      );

      if (res.ok) {
        setResponseFeedback({
          type: 'success',
          text:
            respuesta === 'aceptada'
              ? t('internal_invitations.accepted_banner')
              : t('internal_invitations.rejected_banner'),
        });

        // Recargar detalle
        await loadDetail();

        // Si fue aceptada en modo coordinación y tenemos token, ofrecer ir a disponibilidad
        if (respuesta === 'aceptada' && res.date_mode === 'coordination' && res.token_invitacion) {
          setTimeout(() => {
            navigate(`/coordination/invite/${res.token_invitacion}`);
          }, 1200);
        }
      } else {
        setResponseFeedback({
          type: 'error',
          text: res.message || res.error || 'No se pudo registrar la respuesta.',
        });
      }
    } catch (err: any) {
      setResponseFeedback({
        type: 'error',
        text: err?.message || 'Error inesperado al responder.',
      });
    } finally {
      setResponding(false);
    }
  };

  if (authLoading || loading) {
    return (
      <ScreenContainer>
        <AppBar title={t('internal_invitations.guest_screen_title')} />
        <div className="pe-inv-guest-loading">
          <div className="pe-inv-guest-spinner" />
          <p>Cargando invitación...</p>
        </div>
      </ScreenContainer>
    );
  }

  if (!isPermanent) {
    return (
      <ScreenContainer>
        <AppBar title={t('internal_invitations.guest_screen_title')} />
        <div className="pe-inv-guest-container">
          <div className="pe-inv-guest-card pe-inv-guest-card--auth">
            <User size={40} className="pe-inv-guest-auth-icon" />
            <h2 className="pe-inv-guest-auth-title">
              {t('internal_invitations.guest_screen_title')}
            </h2>
            <p className="pe-inv-guest-auth-desc">
              {t('internal_invitations.not_logged_in_prompt')}
            </p>
            <Button
              variant="primary"
              fullWidth
              onClick={async () => {
                const res = await signInWithGoogle();
                if (!res.ok && res.error !== 'anonymous_account_linking_pending') {
                  alert('Hubo un problema al iniciar sesión.');
                }
              }}
            >
              {t('account.continue_google')}
            </Button>
            <Button variant="ghost" fullWidth onClick={() => navigate('/')}>
              Volver al inicio
            </Button>
          </div>
        </div>
      </ScreenContainer>
    );
  }

  if (error || !detail) {
    return (
      <ScreenContainer>
        <AppBar title={t('internal_invitations.guest_screen_title')} />
        <div className="pe-inv-guest-container">
          <div className="pe-inv-guest-card pe-inv-guest-card--error">
            <AlertCircle size={40} className="pe-inv-guest-error-icon" />
            <h2 className="pe-inv-guest-error-title">No disponible</h2>
            <p className="pe-inv-guest-error-desc">
              {error || 'No fue posible cargar los detalles de esta invitación.'}
            </p>
            <Button variant="outline" fullWidth onClick={() => navigate('/')}>
              Volver al inicio
            </Button>
          </div>
        </div>
      </ScreenContainer>
    );
  }

  const { invitacion, encuentro } = detail;
  const isPending = invitacion.estado === 'pendiente';
  const isCoordination = encuentro.date_mode === 'coordination';

  return (
    <ScreenContainer>
      <AppBar
        title={t('internal_invitations.guest_screen_title')}
        showBack={true}
        onBack={() => navigate('/')}
      />

      <div className="pe-inv-guest-container">
        {/* Banner de estado */}
        {!isPending && (
          <div
            className={`pe-inv-guest-banner pe-inv-guest-banner--${invitacion.estado} dh-fade-in`}
            role="status"
          >
            {invitacion.estado === 'aceptada' && <CheckCircle2 size={18} />}
            {invitacion.estado === 'rechazada' && <XCircle size={18} />}
            {invitacion.estado === 'cancelada' && <AlertCircle size={18} />}
            {invitacion.estado === 'expirada' && <Clock size={18} />}
            <span>
              {invitacion.estado === 'aceptada' && t('internal_invitations.accepted_banner')}
              {invitacion.estado === 'rechazada' && t('internal_invitations.rejected_banner')}
              {invitacion.estado === 'cancelada' && t('internal_invitations.cancelled_banner')}
              {invitacion.estado === 'expirada' && t('internal_invitations.expired_banner')}
            </span>
          </div>
        )}

        {/* Tarjeta del Encuentro */}
        <div className="pe-inv-guest-card">
          <header className="pe-inv-guest-header">
            <span className="pe-inv-guest-badge">
              {encuentro.modalidad === 'presencial' ? (
                <>
                  <MapPin size={12} /> {t('internal_invitations.modalidad_presencial')}
                </>
              ) : (
                <>
                  <Video size={12} /> {t('internal_invitations.modalidad_virtual')}
                </>
              )}
            </span>
            <h1 className="pe-inv-guest-title">{encuentro.titulo}</h1>
            <p className="pe-inv-guest-host">
              {t('internal_invitations.organized_by')}{' '}
              <strong>{encuentro.host_name || 'Organizador'}</strong>
            </p>
          </header>

          {/* Fecha / Hora */}
          <div className="pe-inv-guest-meta-group">
            {isCoordination ? (
              <div className="pe-inv-guest-meta-item">
                <Calendar size={18} className="pe-inv-guest-meta-icon" />
                <div>
                  <strong className="pe-inv-guest-meta-label">
                    {t('internal_invitations.date_mode_coordination')}
                  </strong>
                  <span className="pe-inv-guest-meta-value">
                    Se coordinará la fecha entre los participantes.
                  </span>
                </div>
              </div>
            ) : (
              <>
                {encuentro.fecha && (
                  <div className="pe-inv-guest-meta-item">
                    <Calendar size={18} className="pe-inv-guest-meta-icon" />
                    <div>
                      <strong className="pe-inv-guest-meta-label">Fecha</strong>
                      <span className="pe-inv-guest-meta-value">
                        {formatFriendlyDate(encuentro.fecha)}
                      </span>
                    </div>
                  </div>
                )}
                {encuentro.hora && (
                  <div className="pe-inv-guest-meta-item">
                    <Clock size={18} className="pe-inv-guest-meta-icon" />
                    <div>
                      <strong className="pe-inv-guest-meta-label">Hora</strong>
                      <span className="pe-inv-guest-meta-value">
                        {encuentro.hora.slice(0, 5)} hs
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}

            {encuentro.modalidad === 'presencial' && encuentro.lugar_texto && (
              <div className="pe-inv-guest-meta-item">
                <MapPin size={18} className="pe-inv-guest-meta-icon" />
                <div>
                  <strong className="pe-inv-guest-meta-label">Lugar</strong>
                  <span className="pe-inv-guest-meta-value">{encuentro.lugar_texto}</span>
                </div>
              </div>
            )}
          </div>

          {encuentro.descripcion && (
            <div className="pe-inv-guest-description">
              <p>{encuentro.descripcion}</p>
            </div>
          )}

          {/* Mensaje del organizador */}
          {invitacion.mensaje && (
            <div className="pe-inv-guest-organizer-msg">
              <MessageSquare size={16} className="pe-inv-guest-msg-icon" />
              <div>
                <strong>Mensaje del organizador:</strong>
                <p>"{invitacion.mensaje}"</p>
              </div>
            </div>
          )}

          {/* Feedback interactivo */}
          {responseFeedback && (
            <div
              className={`pe-inv-guest-feedback pe-inv-guest-feedback--${responseFeedback.type} dh-fade-in`}
              role="status"
            >
              {responseFeedback.type === 'success' ? (
                <CheckCircle2 size={16} />
              ) : (
                <AlertCircle size={16} />
              )}
              <span>{responseFeedback.text}</span>
            </div>
          )}

          {/* Formulario de Respuesta (si está pendiente) */}
          {isPending && (
            <div className="pe-inv-guest-actions-section">
              <div className="pe-inv-guest-msg-field">
                <label htmlFor="inv-response-msg" className="pe-inv-guest-field-label">
                  Mensaje de respuesta (opcional)
                </label>
                <input
                  id="inv-response-msg"
                  type="text"
                  value={mensajeRespuesta}
                  onChange={(e) => setMensajeRespuesta(e.target.value)}
                  placeholder="ej. ¡Ahí estaré! / No llego ese día..."
                  className="dh-add-guest-input pe-inv-guest-input"
                  disabled={responding}
                />
              </div>

              <div className="pe-inv-guest-buttons-row">
                <Button
                  variant="primary"
                  fullWidth
                  disabled={responding}
                  onClick={() => handleResponder('aceptada')}
                  style={{ height: 48, fontSize: 15, fontWeight: 700 }}
                >
                  <CheckCircle2 size={18} style={{ marginRight: 6 }} />
                  {responding
                    ? t('internal_invitations.accepting_btn')
                    : t('internal_invitations.accept_btn')}
                </Button>

                <Button
                  variant="outline"
                  fullWidth
                  disabled={responding}
                  onClick={() => handleResponder('rechazada')}
                  style={{ height: 48, fontSize: 14, color: '#64748b', borderColor: '#cbd5e1' }}
                >
                  <XCircle size={18} style={{ marginRight: 6 }} />
                  {responding
                    ? t('internal_invitations.rejecting_btn')
                    : t('internal_invitations.reject_btn')}
                </Button>
              </div>
            </div>
          )}

          {/* Navegación posterior a la respuesta */}
          {!isPending && invitacion.estado === 'aceptada' && (
            <div className="pe-inv-guest-nav-actions">
              {isCoordination && invitacion.token_invitacion ? (
                <Button
                  variant="primary"
                  fullWidth
                  onClick={() => navigate(`/coordination/invite/${invitacion.token_invitacion}`)}
                  style={{ height: 48, fontSize: 15, fontWeight: 700 }}
                >
                  {t('internal_invitations.go_to_coordination')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  fullWidth
                  onClick={() => {
                    if (invitacion.token_invitacion) {
                      navigate(`/invite/${invitacion.token_invitacion}`);
                    } else {
                      navigate(`/meet/${encuentro.id}`);
                    }
                  }}
                  style={{ height: 48, fontSize: 15, fontWeight: 700 }}
                >
                  {t('internal_invitations.go_to_encounter')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </ScreenContainer>
  );
};
