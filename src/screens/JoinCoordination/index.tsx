import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MapPin, AlertCircle, Clock, CheckCircle2 } from 'lucide-react';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { CoordinationAvailabilityForm } from '@/components/ui/CoordinationAvailabilityForm';
import { encuentrosService, type CoordinationPublicReadResult, type CoordinationAvailabilityInput, type CoordinationAvailabilityValue } from '@/services/encuentrosService';
import { formatCoordinationDuration } from '@/lib/formatDuration';
import { formatCoordinationDeadline, formatCoordinationOptionDate } from '@/lib/formatCoordinationDate';
import '../CoordinationGuest.css';

type CoordinationPublicSuccess = Extract<CoordinationPublicReadResult, { ok: true }>;

export default function JoinCoordination() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();

  const [loading, setLoading] = useState(!!token);
  const [data, setData] = useState<CoordinationPublicSuccess | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(!token ? 'invalid_token' : null);
  const [submitErrorCode, setSubmitErrorCode] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const [nombre, setNombre] = useState('');
  const [respuestas, setRespuestas] = useState<Record<string, CoordinationAvailabilityInput>>({});
  const [showValidation, setShowValidation] = useState(false);

  const isSubmittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);



  useEffect(() => {
    if (!token) return;
    let mounted = true;

    encuentrosService.getCoordinacionPublica(token)
      .then(res => {
        if (!mounted) return;
        if (!res.ok) {
          setLoadErrorCode(res.error);
        } else {
          setLoadErrorCode(null);
          setData(res);
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
      case 'invalid_name': return t('coordination.invalid_name', 'El nombre es obligatorio.');
      case 'invalid_responses': return t('coordination.invalid_responses', 'Revisá tus respuestas.');
      case 'incomplete_responses': return t('coordination.missing_responses', 'Falta responder alguna opción.');
      case 'duplicate_options': return t('coordination.duplicate_options', 'Las opciones enviadas están duplicadas.');
      case 'invalid_option': return t('coordination.invalid_option', 'Una de las opciones no es válida.');
      case 'invalid_response_value': return t('coordination.invalid_response_value', 'La respuesta enviada no es válida.');
      case 'invalid_preferred': return t('coordination.invalid_preferred', 'La opción preferida no es válida.');
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
    const normalizedName = nombre.trim();
    if (normalizedName.length < 1 || normalizedName.length > 80) return;

    const missing = data.opciones.some(op => !respuestas[op.id]);
    if (missing) return;

    try {
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setSubmitErrorCode(null);

      const payload = data.opciones.map(op => respuestas[op.id]);
      const res = await encuentrosService.crearDisponibilidadCoordinacionPublica(token, normalizedName, payload);

      if (!res.ok) {
        if (res.error === 'coordination_closed' || res.error === 'response_deadline_passed') {
          setShowValidation(true);
          setData(prev => prev ? { ...prev, derived_status: res.error === 'coordination_closed' ? 'closed' : 'deadline_passed' } : prev);
        } else {
          setSubmitErrorCode(res.error);
        }
        setIsSubmitting(false);
        return;
      }

      // Navegamos pasando el token_invitacion
      navigate(`/coordination/invite/${res.token_invitacion}`, { replace: true });
    } catch {
      setSubmitErrorCode('network_error');
      setIsSubmitting(false);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const formattedDuration = encuentro ? formatCoordinationDuration(encuentro.duration_minutes, t) : null;
  const isNameValid = nombre.trim().length >= 1 && nombre.trim().length <= 80;
  const hasCompleteResponses = data.opciones.every(op => Boolean(respuestas[op.id]));

  return (
    <ScreenContainer>
      <AppBar title={encuentro?.titulo || ''} />
      <div style={{ padding: '20px', paddingBottom: '160px', background: '#F8FAFC', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ maxWidth: 600, margin: '0 auto', width: '100%' }}>

          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 8px 0', color: '#0f172a', letterSpacing: '-0.5px' }}>
              {encuentro?.titulo}
            </h1>
            {encuentro?.descripcion && (
              <p style={{ fontSize: 16, color: '#475569', margin: 0, lineHeight: 1.6 }}>
                {encuentro?.descripcion}
              </p>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Card Informativa */}
            <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {encuentro?.modalidad === 'presencial' && encuentro?.lugar_texto && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                    <div style={{ background: '#E0F2FE', padding: 8, borderRadius: 10 }}>
                      <MapPin size={18} color="#0284C7" />
                    </div>
                    <div style={{ marginTop: 2 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                        Lugar
                      </span>
                      <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                        {encuentro?.lugar_texto}
                      </span>
                    </div>
                  </div>
                )}
                
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ background: '#DCFCE7', padding: 8, borderRadius: 10 }}>
                    <Clock size={18} color="#16A34A" />
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                      {t('coordination.duration_label', 'Duración aproximada')}
                    </span>
                    <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                      {formattedDuration || 'Flexible'}
                    </span>
                  </div>
                </div>

                {data.response_deadline && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                    <div style={{ background: '#FCE7F3', padding: 8, borderRadius: 10 }}>
                      <Clock size={18} color="#DB2777" />
                    </div>
                    <div style={{ marginTop: 2 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                        {t('coordination.deadline', 'Fecha límite')}
                      </span>
                      <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                        {formatCoordinationDeadline(data.response_deadline, i18n.language)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {derived_status === 'closed' && (
              <div style={{ backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', padding: '24px', borderRadius: 20, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 8px 24px rgba(22,163,74,0.08)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ background: '#dcfce7', padding: 6, borderRadius: '50%' }}>
                    <CheckCircle2 size={24} color="#16a34a" />
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

            {derived_status === 'deadline_passed' && (
              <div style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a', padding: '20px', borderRadius: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Clock size={20} color="#d97706" />
                  <span style={{ color: '#b45309', fontWeight: 700, fontSize: 16 }}>{t('coordination.deadline_passed_title', 'Plazo vencido')}</span>
                </div>
                <span style={{ color: '#92400e', fontSize: 15, lineHeight: 1.5 }}>
                  {t('coordination.deadline_passed_msg', 'El plazo para responder ya venció. El organizador está revisando las respuestas para confirmar la fecha definitiva.')}
                </span>
              </div>
            )}

            {!isReadOnly && (
              <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
                <label htmlFor="coordination-guest-name" style={{ display: 'block', fontSize: 16, fontWeight: 700, color: '#0f172a', marginBottom: 12 }}>
                  {t('coordination.your_name', 'Tu nombre')} <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <Input
                  id="coordination-guest-name"
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  placeholder={t('coordination.name_placeholder', 'Ej. María Pérez')}
                  maxLength={80}
                  aria-describedby={showValidation && !nombre.trim() ? "name-error" : undefined}
                  disabled={isSubmitting}
                  style={{ borderRadius: 12, padding: '12px 16px', fontSize: 16 }}
                />
                {showValidation && !nombre.trim() && (
                  <div id="name-error" style={{ color: '#dc2626', fontSize: 14, marginTop: 8, fontWeight: 500 }}>
                    {t('coordination.name_required', 'Por favor, ingresá tu nombre')}
                  </div>
                )}
              </div>
            )}

            {submitErrorCode && isSubmitting === false && (
              <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', padding: '16px', borderRadius: 16, display: 'flex', alignItems: 'center', gap: 12 }} aria-live="assertive">
                <AlertCircle size={24} color="#dc2626" />
                <span style={{ color: '#991b1b', fontWeight: 600, fontSize: 15 }}>{getSubmitErrorMessage(submitErrorCode)}</span>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {derived_status === 'closed' ? (
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: '8px 0 0 0', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {t('coordination.options_title_closed', 'Tu respuesta enviada')}
                </h3>
              ) : (
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: '8px 0 0 0', color: '#0f172a' }}>
                  {t('coordination.options_title', 'Opciones propuestas')}
                </h3>
              )}
              <CoordinationAvailabilityForm
                opciones={data.opciones}
                respuestas={respuestas}
                onChangeRespuesta={handleChangeRespuesta}
                onTogglePreferida={handleTogglePreferida}
                readOnly={isReadOnly || isSubmitting}
                showErrors={showValidation}
              />
            </div>
          </div>
        </div>
      </div>

      {!isReadOnly && (
        <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, padding: '20px 20px', background: 'rgba(255, 255, 255, 0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderTop: '1px solid rgba(15,23,42,0.05)', boxShadow: '0 -4px 24px rgba(0,0,0,0.04)', paddingBottom: 'calc(20px + env(safe-area-inset-bottom))', zIndex: 10 }}>
          <Button
            variant="primary"
            fullWidth
            disabled={isSubmitting || !isNameValid || !hasCompleteResponses}
            onClick={handleSubmit}
            style={{ borderRadius: 14, background: '#4f46e5', boxShadow: '0 4px 12px rgba(79, 70, 229, 0.25)', height: 48, fontSize: 16 }}
          >
            {isSubmitting ? t('coordination.sending', 'Enviando...') : t('coordination.send_availability', 'Enviar disponibilidad')}
          </Button>
        </div>
      )}
      
      {derived_status === 'deadline_passed' && (
        <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, padding: '20px 20px', background: 'rgba(255, 255, 255, 0.95)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderTop: '1px solid rgba(15,23,42,0.05)', boxShadow: '0 -4px 24px rgba(0,0,0,0.04)', paddingBottom: 'calc(20px + env(safe-area-inset-bottom))', zIndex: 10, textAlign: 'center' }}>
          <span style={{ color: '#b45309', fontWeight: 600, fontSize: 15 }}>Plazo vencido</span>
        </div>
      )}
    </ScreenContainer>
  );
}
