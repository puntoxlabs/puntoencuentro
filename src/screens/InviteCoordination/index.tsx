import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Clock, CheckCircle } from 'lucide-react';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { CoordinationAvailabilityForm } from '@/components/ui/CoordinationAvailabilityForm';
import { encuentrosService, type CoordinationParticipantReadResult, type CoordinationAvailabilityInput, type CoordinationAvailabilityValue } from '@/services/encuentrosService';
import { formatCoordinationDuration } from '@/lib/formatDuration';
import { formatCoordinationDeadline, formatCoordinationOptionDate } from '@/lib/formatCoordinationDate';
import { normalizeInvitationTheme } from '@/lib/invitationThemes';
import { getThemeStyle } from '@/lib/themes';
import { CoordinationThemeHero } from '@/components/ui/CoordinationThemeHero';
import { getCelebrationTemplateConfig } from '@/lib/celebrationTemplates';
import { getRomanticTemplateConfig } from '@/lib/romanticTemplates';
import '../CoordinationGuest.css';

type CoordinationParticipantSuccess = Extract<CoordinationParticipantReadResult, { ok: true }>;

export default function InviteCoordination() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, i18n } = useTranslation();

  const [loading, setLoading] = useState(!!token);
  const [data, setData] = useState<CoordinationParticipantSuccess | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(!token ? 'invalid_token' : null);
  const [submitErrorCode, setSubmitErrorCode] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const [respuestas, setRespuestas] = useState<Record<string, CoordinationAvailabilityInput>>({});
  const [showValidation, setShowValidation] = useState(false);
  const [successMsg, setSuccessMsg] = useState<'saved' | 'updated' | null>(null);

  useEffect(() => {
    if (location.state?.availabilitySaved) {
      setSuccessMsg('saved');
      // Clear state so it doesn't reappear on refresh
      navigate(location.pathname, { replace: true, state: {} });
      const timer = setTimeout(() => setSuccessMsg(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [location, navigate]);

  const isSubmittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    let mounted = true;

    encuentrosService.getCoordinacionParticipante(token)
      .then(res => {
        if (!mounted) return;
        if (!res.ok) {
          setLoadErrorCode(res.error);
        } else {
          setLoadErrorCode(null);
          setData(res);

          const validOptionIds = new Set(res.opciones.map(o => o.id));
          const iniciales: Record<string, CoordinationAvailabilityInput> = {};
          res.mis_respuestas.forEach(r => {
            if (validOptionIds.has(r.opcion_fecha_id)) {
              iniciales[r.opcion_fecha_id] = r;
            }
          });
          setRespuestas(iniciales);
        }
      })
      .catch(() => {
        if (!mounted) return;
        setLoadErrorCode('network_error');
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [token, retryCount]);

  const getErrorMessage = (errCode: string | null) => {
    switch (errCode) {
      case 'invalid_token': return t('coordination.invalid_link', 'Esta invitación no está disponible o el enlace no es válido.');
      case 'encounter_not_found': return t('coordination.invalid_link', 'Esta invitación no está disponible o el enlace no es válido.');
      case 'encounter_cancelled': return t('coordination.cancelled', 'El encuentro ha sido cancelado.');
      case 'invalid_date_mode': return t('coordination.invalid_date_mode', 'El tipo de encuentro no es válido para coordinación.');
      case 'invalid_invitation_type': return t('coordination.invalid_invitation_type', 'El tipo de invitación no es válido.');
      case 'rpc_error': return t('coordination.service_error', 'Ocurrió un error en el servidor. Por favor, intentá nuevamente.');
      case 'network_error': return t('coordination.network_error', 'Ocurrió un error de conexión. Por favor, intentá nuevamente.');
      default: return t('coordination.invalid_link', 'Esta invitación no está disponible o el enlace no es válido.');
    }
  };

  const getSubmitErrorMessage = (errCode: string | null) => {
    switch (errCode) {
      case 'invalid_responses': return t('coordination.invalid_responses', 'Revisá tus respuestas.');
      case 'incomplete_responses': return t('coordination.missing_responses', 'Falta responder alguna opción.');
      case 'duplicate_options': return t('coordination.duplicate_options', 'Las opciones enviadas están duplicadas.');
      case 'invalid_option': return t('coordination.invalid_option', 'Una de las opciones no es válida.');
      case 'invalid_response_value': return t('coordination.invalid_response_value', 'La respuesta enviada no es válida.');
      case 'invalid_preferred': return t('coordination.invalid_preferred', 'La opción preferida no es válida.');
      case 'network_error': return t('coordination.network_error', 'Ocurrió un error de conexión. Por favor, intentá nuevamente.');
      default: return t('coordination.submit_error', 'No pudimos guardar tu respuesta. Intentá nuevamente.');
    }
  };

  if (loading) {
    return (
      <ScreenContainer>
        <AppBar title={t('coordination.loading_coordination', 'Cargando coordinación...')} />
        <div className="coordination-guest-content" style={{ justifyContent: 'center', alignItems: 'center' }}>
          <p>{t('coordination.loading', 'Cargando...')}</p>
        </div>
      </ScreenContainer>
    );
  }

  if (loadErrorCode || !data) {
    return (
      <ScreenContainer>
        <AppBar title={t('coordination.error_title', 'Invitación no disponible')} />
        <div className="coordination-guest-content">
          <EmptyState
            icon={<AlertCircle size={48} />}
            title={t('coordination.error_title', 'Invitación no disponible')}
            description={getErrorMessage(loadErrorCode)}
            actions={
              <Button variant="primary" onClick={() => {
                if (loadErrorCode === 'network_error') {
                  setLoading(true);
                  setLoadErrorCode(null);
                  setRetryCount(c => c + 1);
                } else {
                  navigate('/', { replace: true });
                }
              }}>
                {loadErrorCode === 'network_error' ? t('coordination.retry', 'Volver a intentar') : t('coordination.go_home', 'Volver al inicio')}
              </Button>
            }
          />
        </div>
      </ScreenContainer>
    );
  }

  const { encuentro, derived_status } = data;
  const isReadOnly = derived_status === 'closed' || derived_status === 'deadline_passed';

  const handleChangeRespuesta = (opcionId: string, value: CoordinationAvailabilityValue) => {
    setSuccessMsg(null);
    setRespuestas(prev => {
      const existing = prev[opcionId] || { opcion_fecha_id: opcionId, es_preferida: false };
      const newPreferida = value === 'unavailable' ? false : existing.es_preferida;
      return {
        ...prev,
        [opcionId]: {
          ...existing,
          respuesta: value,
          es_preferida: newPreferida
        }
      };
    });
  };

  const handleTogglePreferida = (opcionId: string) => {
    setSuccessMsg(null);
    setRespuestas(prev =>
      Object.fromEntries(
        Object.entries(prev).map(([id, response]) => [
          id,
          {
            ...response,
            es_preferida: id === opcionId ? !response.es_preferida : false
          }
        ])
      )
    );
  };

  const handleSubmit = async () => {
    if (isSubmittingRef.current || !token) return;

    setShowValidation(true);
    const missing = data.opciones.some(op => !respuestas[op.id]);
    if (missing) return;

    try {
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setSubmitErrorCode(null);

      const payload = data.opciones.map(op => respuestas[op.id]);
      const res = await encuentrosService.guardarDisponibilidadCoordinacionParticipante(token, payload);

      if (!res.ok) {
        if (res.error === 'coordination_closed' || res.error === 'response_deadline_passed') {
          setData(prev => prev ? { ...prev, derived_status: res.error === 'coordination_closed' ? 'closed' : 'deadline_passed' } : prev);
        } else {
          setSubmitErrorCode(res.error);
        }
        return;
      }

      setSubmitErrorCode(null);
      setShowValidation(false);
      setSuccessMsg('updated');
      setTimeout(() => setSuccessMsg(null), 5000);
      setData(prev => prev ? { ...prev, participante: { ...prev.participante, respondio_disponibilidad: true } } : prev);
    } catch {
      setSubmitErrorCode('network_error');
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleConfirmAttendance = async (estadoFinal: 'confirmado' | 'rechazado') => {
    if (isSubmittingRef.current || !token) return;

    try {
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setSubmitErrorCode(null);

      const { participantesService } = await import('@/services/participantesService');
      const res = await participantesService.responderInvitacion(token, estadoFinal);

      setData(prev => prev ? { ...prev, participante: { ...prev.participante, estado: res.estado } } : prev);
    } catch (err: any) {
      console.error(err);
      if (err.message === 'meeting_expired') {
        setSubmitErrorCode('meeting_expired');
      } else {
        setSubmitErrorCode('network_error');
      }
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const formattedDuration = encuentro ? formatCoordinationDuration(encuentro.duration_minutes, t) : null;
  const hasCompleteResponses = data?.opciones.every(op => Boolean(respuestas[op.id])) ?? false;

  const invitationTheme = normalizeInvitationTheme(encuentro?.tema_invitacion);

  const celebrationTemplate = encuentro?.tema_invitacion === 'celebration'
    ? getCelebrationTemplateConfig(encuentro.invitation_template)
    : null;
  const romanticTemplate = encuentro?.tema_invitacion === 'romantic'
    ? getRomanticTemplateConfig(encuentro.invitation_template)
    : null;

  let templateBgStyle: React.CSSProperties = {};
  if (celebrationTemplate?.background) {
    templateBgStyle = {
      backgroundImage: `linear-gradient(rgba(255,255,255,0.25), rgba(255,255,255,0.25)), url(${celebrationTemplate.background})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center top',
      backgroundAttachment: 'fixed',
      backgroundRepeat: 'no-repeat',
    };
  } else if (romanticTemplate?.background) {
    templateBgStyle = {
      '--guest-bg-image': `url(${romanticTemplate.background})`,
    } as React.CSSProperties;
  }

  return (
    <ScreenContainer
      className={`guest-page guest-theme guest-theme--${invitationTheme}`}
      style={{ ...getThemeStyle(encuentro?.tema), ...templateBgStyle }}
    >
      <AppBar title={encuentro?.titulo || ''} />
      <div style={{ padding: '20px', paddingBottom: '160px', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

        <div style={{ marginBottom: 24 }}>
          <CoordinationThemeHero
            encuentro={{
              titulo: encuentro?.titulo || '',
              descripcion: encuentro?.descripcion || null,
              modalidad: encuentro?.modalidad || 'presencial',
              lugar_texto: encuentro?.lugar_texto || null,
              tema: encuentro?.tema || null,
              tema_invitacion: encuentro?.tema_invitacion || 'classic',
              invitation_template: encuentro?.invitation_template || null
            }}
            publicToken={token!}
            isClosed={derived_status === 'closed'}
            fechaConfirmada={data.fecha}
            horaConfirmada={data.hora}
          />
        </div>

        <div className="coordination-guest-info">
          {data.participante?.nombre_invitado && (
            <div className="coordination-guest-info-row">
              <span className="coordination-guest-info-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>👤</span>
              <span>
                {t('coordination.participant_name', 'Nombre:')}{' '}
                <strong>{data.participante.nombre_invitado}</strong>
              </span>
            </div>
          )}
          {formattedDuration && (
            <div className="coordination-guest-info-row">
              <Clock size={18} className="coordination-guest-info-icon" />
              <span>{t('coordination.duration_label', 'Duración aproximada:')} {formattedDuration}</span>
            </div>
          )}
          {data.response_deadline && (
            <div className="coordination-guest-info-row">
              <AlertCircle size={18} className="coordination-guest-info-icon" />
              <span>{t('coordination.deadline', 'Fecha límite para responder:')} {formatCoordinationDeadline(data.response_deadline, i18n.language)}</span>
            </div>
          )}
        </div>

        {derived_status === 'closed' && data.participante?.estado === 'pendiente' && (
          <div className="coordination-guest-status-banner">
            <AlertCircle size={24} />
            <span>{t('coordination.closed_msg_confirm_pending', 'La coordinación ya fue cerrada. Por favor, confirmá tu asistencia.')}</span>
          </div>
        )}

        {derived_status === 'deadline_passed' && (
          <div className="coordination-guest-status-banner">
            <Clock size={24} />
            <span>{t('coordination.deadline_passed_msg', 'El plazo para responder finalizó')}</span>
          </div>
        )}

        {successMsg === 'saved' && (
          <div className="coordination-guest-status-banner" style={{ backgroundColor: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', flexDirection: 'column', alignItems: 'flex-start', padding: '16px 20px', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle size={20} />
              <span style={{ fontWeight: 700 }}>Disponibilidad registrada</span>
            </div>
            <span style={{ fontSize: 14, marginLeft: 28, color: '#15803d', lineHeight: 1.4 }}>
              Tu respuesta fue enviada correctamente al organizador. Podés modificarla mientras la coordinación siga abierta.
            </span>
          </div>
        )}

        {successMsg === 'updated' && (
          <div className="coordination-guest-status-banner" style={{ backgroundColor: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', flexDirection: 'column', alignItems: 'flex-start', padding: '16px 20px', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle size={20} />
              <span style={{ fontWeight: 700 }}>Disponibilidad actualizada</span>
            </div>
            <span style={{ fontSize: 14, marginLeft: 28, color: '#15803d', lineHeight: 1.4 }}>
              Tus cambios fueron enviados correctamente.
            </span>
          </div>
        )}

        {submitErrorCode && isSubmitting === false && (
          <div className="coordination-guest-status-banner error" aria-live="assertive">
            <AlertCircle size={24} />
            <span>{getSubmitErrorMessage(submitErrorCode)}</span>
          </div>
        )}

        {derived_status === 'closed' && (
          <div style={{ backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', padding: '24px', borderRadius: 20, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 8px 24px rgba(22,163,74,0.08)', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ background: '#dcfce7', padding: 6, borderRadius: '50%' }}>
                <CheckCircle size={24} color="#16a34a" />
              </div>
              <span style={{ color: '#166534', fontWeight: 700, fontSize: 18 }}>Fecha confirmada</span>
            </div>
            <div>
              <span style={{ color: '#166534', fontSize: 15, display: 'block', marginBottom: 6 }}>
                {t('coordination.closed_msg_confirmed', 'El encuentro quedó confirmado para:')}
              </span>
              <span style={{ color: '#14532d', fontWeight: 800, fontSize: 16 }}>
                {data.fecha && data.hora ? formatCoordinationOptionDate(data.fecha, data.hora, i18n.language) : ''}
              </span>
            </div>
          </div>
        )}

        {derived_status === 'closed' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
            {data.participante?.estado === 'confirmado' ? (
              <div style={{ background: '#dcfce7', padding: '16px', borderRadius: 16, border: '1px solid #bbf7d0', textAlign: 'center' }}>
                <span style={{ color: '#166534', fontWeight: 700, fontSize: 16 }}>¡Confirmaste tu asistencia!</span>
                <div style={{ marginTop: 12 }}>
                  <Button variant="outline" onClick={() => handleConfirmAttendance('rechazado')} disabled={isSubmitting} style={{ borderColor: '#fca5a5', color: '#dc2626' }}>Cambiar a "No asisto"</Button>
                </div>
              </div>
            ) : data.participante?.estado === 'rechazado' ? (
              <div style={{ background: '#fee2e2', padding: '16px', borderRadius: 16, border: '1px solid #fecaca', textAlign: 'center' }}>
                <span style={{ color: '#991b1b', fontWeight: 700, fontSize: 16 }}>Indicaste que no vas a asistir.</span>
                <div style={{ marginTop: 12 }}>
                  <Button variant="outline" onClick={() => handleConfirmAttendance('confirmado')} disabled={isSubmitting} style={{ borderColor: '#86efac', color: '#16a34a' }}>Cambiar a "Confirmo asistencia"</Button>
                </div>
              </div>
            ) : (
              <>
                <h3 style={{ fontSize: 18, fontWeight: 800, margin: '0', color: '#0f172a', textAlign: 'center' }}>
                  ¿Confirmás tu asistencia?
                </h3>
                <div style={{ display: 'flex', gap: 12 }}>
                  <Button
                    variant="outline"
                    fullWidth
                    disabled={isSubmitting}
                    onClick={() => handleConfirmAttendance('rechazado')}
                    style={{ 
                      borderRadius: 14, 
                      height: 48, 
                      fontSize: 16,
                      color: '#dc2626',
                      borderColor: '#fca5a5',
                      background: '#fef2f2'
                    }}
                  >
                    No voy a poder
                  </Button>
                  <Button
                    variant="primary"
                    fullWidth
                    disabled={isSubmitting}
                    onClick={() => handleConfirmAttendance('confirmado')}
                    style={{ 
                      borderRadius: 14, 
                      background: '#16a34a', 
                      boxShadow: '0 4px 12px rgba(22, 163, 74, 0.25)', 
                      height: 48, 
                      fontSize: 16 
                    }}
                  >
                    {isSubmitting ? 'Confirmando...' : 'Confirmo asistencia'}
                  </Button>
                </div>
              </>
            )}

            <div className="coordination-guest-form-section" style={{ marginTop: 16 }}>
              <label className="coordination-guest-label">{t('coordination.options_title_closed', 'Tu disponibilidad enviada')}</label>
              <CoordinationAvailabilityForm
                opciones={data.opciones}
                respuestas={respuestas}
                onChangeRespuesta={handleChangeRespuesta}
                onTogglePreferida={handleTogglePreferida}
                readOnly={true}
                showErrors={showValidation}
              />
            </div>
          </div>
        ) : (
          <div className="coordination-guest-form-section">
            <label className="coordination-guest-label">{t('coordination.options_title', 'Opciones propuestas')}</label>
            <CoordinationAvailabilityForm
              opciones={data.opciones}
              respuestas={respuestas}
              onChangeRespuesta={handleChangeRespuesta}
              onTogglePreferida={handleTogglePreferida}
              readOnly={isReadOnly || isSubmitting}
              showErrors={showValidation}
            />
          </div>
        )}

        {data.mostrar_respuestas_a_invitados && data.opciones && (
          <div className="coordination-guest-form-section" style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid rgba(15,23,42,0.1)' }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 16px 0', color: '#0f172a' }}>
              Resumen de respuestas
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {data.opciones.map((opt) => {
                const hasVotes = (opt.available_count || 0) > 0 || (opt.maybe_count || 0) > 0 || (opt.unavailable_count || 0) > 0;
                if (!hasVotes) return null;
                
                return (
                  <div key={opt.id} style={{ background: '#f8fafc', borderRadius: 12, padding: '16px', border: '1px solid rgba(15,23,42,0.06)' }}>
                    <span style={{ fontWeight: 700, color: '#1e293b', fontSize: 15, display: 'block', marginBottom: 12 }}>
                      Opción {opt.orden}
                    </span>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {(opt.available_count || 0) > 0 && <span style={{ background: '#dcfce7', color: '#166534', padding: '4px 10px', borderRadius: 12, fontWeight: 600, fontSize: 13 }}>Sí: {opt.available_count}</span>}
                      {(opt.maybe_count || 0) > 0 && <span style={{ background: '#fef9c3', color: '#854d0e', padding: '4px 10px', borderRadius: 12, fontWeight: 600, fontSize: 13 }}>Tal vez: {opt.maybe_count}</span>}
                      {(opt.unavailable_count || 0) > 0 && <span style={{ background: '#fee2e2', color: '#991b1b', padding: '4px 10px', borderRadius: 12, fontWeight: 600, fontSize: 13 }}>No: {opt.unavailable_count}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!isReadOnly && (
          <div className="coordination-guest-footer">
            <Button
              variant="primary"
              fullWidth
              disabled={isSubmitting || !hasCompleteResponses || isReadOnly}
              onClick={handleSubmit}
            >
              {isSubmitting ? t('coordination.saving', 'Guardando...') : t('coordination.save_changes', 'Guardar cambios')}
            </Button>
            <p style={{ textAlign: 'center', fontSize: '0.875rem', color: '#6b7280', marginTop: '1rem' }}>
              {t('coordination.can_modify', 'Podés modificar tu respuesta mientras la coordinación siga abierta.')}
            </p>
          </div>
        )}
      </div>
    </ScreenContainer>
  );
}
