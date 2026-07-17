import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MapPin, AlertCircle, Clock } from 'lucide-react';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { CoordinationAvailabilityForm } from '@/components/ui/CoordinationAvailabilityForm';
import { encuentrosService, type CoordinationPublicReadResult, type CoordinationAvailabilityInput, type CoordinationAvailabilityValue } from '@/services/encuentrosService';
import { formatCoordinationDuration } from '@/lib/formatDuration';
import { formatCoordinationDeadline } from '@/lib/formatDate';
import '../CoordinationGuest.css';

export default function JoinCoordination() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<CoordinationPublicReadResult & { ok: true } | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [submitErrorCode, setSubmitErrorCode] = useState<string | null>(null);
  
  const [nombre, setNombre] = useState('');
  const [respuestas, setRespuestas] = useState<Record<string, CoordinationAvailabilityInput>>({});
  const [showValidation, setShowValidation] = useState(false);
  
  const isSubmittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);



  const loadData = useCallback(async () => {
    if (!token) {
      setLoadErrorCode('invalid_token');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setLoadErrorCode(null);
      const res = await encuentrosService.getCoordinacionPublica(token);
      if (!res.ok) {
        setLoadErrorCode(res.error || 'encounter_not_found');
        return;
      }
      setData(res as CoordinationPublicReadResult & { ok: true });
    } catch {
      setLoadErrorCode('network_error');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (token) loadData();
  }, [token, loadData]);

  const getErrorMessage = (errCode: string | null) => {
    switch (errCode) {
      case 'invalid_token': return t('coordination.invalid_link', 'Esta invitación no está disponible o el enlace no es válido.');
      case 'encounter_not_found': return t('coordination.invalid_link', 'Esta invitación no está disponible o el enlace no es válido.');
      case 'encounter_cancelled': return t('coordination.cancelled', 'El encuentro ha sido cancelado.');
      case 'invalid_date_mode': return t('coordination.invalid_date_mode', 'El tipo de encuentro no es válido para coordinación.');
      case 'invalid_invitation_type': return t('coordination.invalid_invitation_type', 'El tipo de invitación no es válido.');
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

  const isValidUUID = (uuid: unknown): boolean => {
    if (typeof uuid !== 'string') return false;
    const trimmed = uuid.trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(trimmed);
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
              <Button variant="primary" onClick={() => loadErrorCode === 'network_error' ? loadData() : navigate('/', { replace: true })}>
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
          // Fallback a read only sin perder el local state de respuestas
          setData(prev => prev ? { ...prev, derived_status: res.error === 'coordination_closed' ? 'closed' : 'deadline_passed' } : prev);
        } else {
          setSubmitErrorCode(res.error || 'unknown_error');
        }
        return;
      }

      if (!isValidUUID(res.token_invitacion)) {
        setSubmitErrorCode('unknown_error');
        return;
      }

      // Exito: Navegar a la vista individual (previene re-submit y doble participante)
      navigate(`/coordination/invite/${res.token_invitacion}`, { replace: true });
    } catch {
      setSubmitErrorCode('network_error');
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
      <div className="coordination-guest-content">
        
        <div className="coordination-guest-header">
          <h1 className="coordination-guest-title">{encuentro?.titulo}</h1>
          {encuentro?.descripcion && <p className="coordination-guest-desc">{encuentro?.descripcion}</p>}
        </div>

        <div className="coordination-guest-info">
          {encuentro?.modalidad === 'presencial' && encuentro?.lugar_texto && (
            <div className="coordination-guest-info-row">
              <MapPin size={18} className="coordination-guest-info-icon" />
              <span>{encuentro?.lugar_texto}</span>
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

        {derived_status === 'closed' && (
          <div className="coordination-guest-status-banner">
            <AlertCircle size={24} />
            <span>{t('coordination.closed_msg', 'La coordinación ya fue cerrada')}</span>
          </div>
        )}

        {derived_status === 'deadline_passed' && (
          <div className="coordination-guest-status-banner">
            <Clock size={24} />
            <span>{t('coordination.deadline_passed_msg', 'El plazo para responder finalizó')}</span>
          </div>
        )}

        {!isReadOnly && (
          <div className="coordination-guest-form-section">
            <label className="coordination-guest-label">{t('coordination.your_name', 'Tu nombre')}</label>
            <Input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder={t('coordination.name_placeholder', 'Ingresá tu nombre')}
              maxLength={80}
              disabled={isSubmitting}
            />
            {showValidation && (nombre.trim().length < 1 || nombre.trim().length > 80) && (
              <span className="coordination-validation-msg" aria-live="polite">{t('coordination.invalid_name', 'El nombre es obligatorio (max 80 caracteres)')}</span>
            )}
          </div>
        )}

        {submitErrorCode && isSubmitting === false && (
          <div className="coordination-guest-status-banner error" aria-live="assertive">
            <AlertCircle size={24} />
            <span>{getSubmitErrorMessage(submitErrorCode)}</span>
          </div>
        )}

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

        {!isReadOnly && (
          <div className="coordination-guest-footer">
            <Button
              variant="primary"
              fullWidth
              disabled={isSubmitting || !isNameValid || !hasCompleteResponses || isReadOnly}
              onClick={handleSubmit}
            >
              {isSubmitting ? t('coordination.sending', 'Enviando...') : t('coordination.send_availability', 'Enviar disponibilidad')}
            </Button>
          </div>
        )}
      </div>
    </ScreenContainer>
  );
}
