import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import { encuentrosService, getCoordinationCreateErrorMessage } from '@/services/encuentrosService';
import type { CoordinationCreatePayload, CoordinationOptionPayload } from '@/services/encuentrosService';
import { Button } from '@/components/ui/Button';
import { Clock, MapPin, Video, Link, Users, Palette } from 'lucide-react';
import { formatFriendlyDate, formatFriendlyDeadline } from '@/lib/formatDate';
import { getAllInvitationDesignOptions, findDesignOptionIndex } from '@/lib/invitationThemes';
import { useTranslation } from 'react-i18next';
import { formatCoordinationDuration } from '@/lib/formatDuration';
import { isArgentinaDateTimeInFuture, buildArgentinaLocalKey, compareArgentinaLocalDateTimes } from '@/lib/argentinaDateTime';

interface Step4ReviewProps {
  onBack: () => void;
  onNavigate?: (step: number) => void;
}

const Step4Review: React.FC<Step4ReviewProps> = ({ onBack, onNavigate }) => {
  const { draft, resetDraft } = useCoordinationWizardStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawErrorCode, setRawErrorCode] = useState<string | null>(null);
  const [rpcDetails, setRpcDetails] = useState<string | null>(null);
  const submittingRef = React.useRef(false);
  // Guards against duplicate creation if user taps the button again after a
  // successful RPC call that still ended in a frontend validation or nav error.
  const createdSuccessfullyRef = React.useRef(false);

  const handleSubmit = async () => {
    // Block if already mid-submit OR if creation already succeeded (prevents duplicates)
    if (submittingRef.current || createdSuccessfullyRef.current) return;

    submittingRef.current = true;
    setLoading(true);
    setError(null);
    setRawErrorCode(null);
    setRpcDetails(null);

    try {
      // 1. Revalidar opciones para evitar opción en el pasado
      for (const opt of draft.options) {
        if (!isArgentinaDateTimeInFuture(opt.date, opt.time)) {
          setError('Una de las fechas propuestas ya pasó. Volvé para editarla.');
          setRawErrorCode('frontend_option_in_past');
          setLoading(false);
          submittingRef.current = false;
          return;
        }
      }

      // 2. Revalidar plazo para evitar plazo en el pasado o después de opciones
      if (draft.responseDeadline) {
        const [dlDate, dlTimePart] = draft.responseDeadline.split('T');
        if (dlDate && dlTimePart) {
          const dlTime = dlTimePart.slice(0, 5);
          
          if (!isArgentinaDateTimeInFuture(dlDate, dlTime)) {
            setError('El plazo para responder debe ser futuro. Volvé para editarlo.');
            setRawErrorCode('frontend_deadline_in_past');
            setLoading(false);
            submittingRef.current = false;
            return;
          }

          const sortedOptions = [...draft.options].sort((a, b) => {
            return a.date.localeCompare(b.date) || a.time.localeCompare(b.time);
          });
          const earliestOption = sortedOptions[0];
          if (earliestOption) {
            const earliestOptionKey = buildArgentinaLocalKey(earliestOption.date, earliestOption.time);
            const deadlineKey = buildArgentinaLocalKey(dlDate, dlTime);
            if (compareArgentinaLocalDateTimes(deadlineKey, earliestOptionKey) >= 0) {
              setError('El plazo debe ser anterior a las fechas propuestas. Volvé para editarlo.');
              setRawErrorCode('frontend_deadline_after_options');
              setLoading(false);
              submittingRef.current = false;
              return;
            }
          }
        }
      }

      // Normalizar Payload para asegurar que no haya 'undefined' que rompa JSON
      const isPresencial = draft.modality === 'presencial';

      const payload: CoordinationCreatePayload = {
        titulo: draft.title,
        descripcion: draft.description || null, // null en vez de undefined
        modalidad: draft.modality,
        lugar_texto: isPresencial ? (draft.locationText || null) : null,
        link_virtual: !isPresencial ? (draft.virtualLink || null) : null,
        tipo_invitacion: draft.invitationType,
        tema: 'blue',
        tema_invitacion: draft.invitationTheme || null,
        invitation_template: draft.invitationTemplate || null,
        response_deadline: draft.responseDeadline || null,
        duration_minutes: draft.durationMinutes,
        mostrar_respuestas_a_invitados: draft.mostrarRespuestasAInvitados,
      };

      const options: CoordinationOptionPayload[] = draft.options.map(opt => ({
        fecha: opt.date,
        hora_inicio: opt.time
      }));

      const result = await encuentrosService.crearEncuentroConOpciones(payload, options);

      if (result.ok) {
        // Mark as created to prevent duplicate submissions
        createdSuccessfullyRef.current = true;
        resetDraft();
        navigate(`/coordination/${result.encuentro.id}`);
      } else {
        // Pass through details from RPC if present
        const resultWithDetails = result as { ok: false; error: string; details?: string };
        setRawErrorCode(result.error || 'unknown_error');
        if (resultWithDetails.details) setRpcDetails(resultWithDetails.details);

        if (result.error === 'invalid_response_format' || result.error === 'invalid_option_order' || result.error === 'duplicate_option_order' || result.error === 'invalid_option_order_sequence') {
          setError('No pudimos verificar la creación. Volvé a Home para comprobar si el encuentro aparece antes de intentar nuevamente.');
        } else {
          setError(getCoordinationCreateErrorMessage(result.error || 'unknown_error'));
        }
      }
    } catch (error: unknown) {
      console.error('[CreateCoordination] failed', error);
      setRawErrorCode('js_exception');
      setError(getCoordinationCreateErrorMessage('unknown_error'));
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };



  const getThemeDisplayName = () => {
    if (!draft.invitationTheme || draft.invitationTheme === 'classic') return 'Clásico';
    if (draft.invitationTheme === 'custom') return 'Diseño personalizado';

    const options = getAllInvitationDesignOptions();
    const index = findDesignOptionIndex(draft.invitationTheme, draft.invitationTemplate);
    const opt = options[index];

    if (opt && opt.templateLabel) {
      return `${opt.categoryLabel} · ${opt.templateLabel}`;
    }

    return opt?.categoryLabel || 'Clásico';
  };

  return (
    <div className="pe-wizard-step fade-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', flex: 1, paddingBottom: '180px', background: '#F8FAFC' }}>
      <div style={{ flex: 1, maxWidth: 600, margin: '0 auto', width: '100%' }}>
        <h2 style={{ fontSize: 26, fontWeight: 800, marginBottom: 8, color: '#0f172a', letterSpacing: '-0.5px' }}>
          Revisá tu propuesta
        </h2>
        <p style={{ color: '#64748b', marginBottom: 28, fontSize: 16, lineHeight: 1.5 }}>
          Asegurate de que todo esté correcto antes de enviar las opciones a tus invitados.
        </p>

        {error && (
          <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', padding: 16, borderRadius: 16, marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ color: '#dc2626', margin: 0, fontSize: 14, fontWeight: 500 }}>{error}</p>
            {/* TODO: Remover rawErrorCode y rpcDetails antes del lanzamiento público final */}
            {rawErrorCode && (
              <p style={{ margin: 0, color: '#ef4444', fontSize: 12, opacity: 0.8 }}>Código técnico: {rawErrorCode}</p>
            )}
            {rpcDetails && (
              <p style={{ margin: 0, color: '#ef4444', fontSize: 12, opacity: 0.7 }}>Detalle técnico: {rpcDetails}</p>
            )}
            {error.includes('Volvé a Home') && (
              <Button variant="outline" onClick={() => navigate('/')} style={{ marginTop: 12, borderRadius: 12 }}>
                Volver a Home
              </Button>
            )}
            {onNavigate && (error.includes('fecha') || error.includes('horario') || error.includes('opcion') || error.includes('opción') || error.includes('plazo')) && (
              <Button variant="outline" onClick={() => onNavigate(2)} style={{ alignSelf: 'flex-start', color: '#dc2626', borderColor: '#fecaca', background: '#fff', borderRadius: 12 }}>
                Corregir opciones y plazo
              </Button>
            )}
            {onNavigate && (error.includes('diseño') || error.includes('invitación')) && (
              <Button variant="outline" onClick={() => onNavigate(3)} style={{ alignSelf: 'flex-start', color: '#dc2626', borderColor: '#fecaca', background: '#fff', borderRadius: 12 }}>
                Corregir diseño de invitación
              </Button>
            )}
            {onNavigate && (error.includes('encuentro') || error.includes('modalidad') || error.includes('lugar') || error.includes('enlace')) && (
              <Button variant="outline" onClick={() => onNavigate(1)} style={{ alignSelf: 'flex-start', color: '#dc2626', borderColor: '#fecaca', background: '#fff', borderRadius: 12 }}>
                Corregir datos del encuentro
              </Button>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Card 1: Datos del encuentro */}
          <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid rgba(15,23,42,0.05)' }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#0f172a' }}>
                Datos del encuentro
              </h3>
              {onNavigate && (
                <button onClick={() => onNavigate(1)} style={{ background: '#f1f5f9', borderRadius: 20, border: 'none', color: '#3b82f6', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: '6px 14px', transition: 'background 0.2s' }}>
                  Editar
                </button>
              )}
            </div>

            <h4 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px 0', color: '#1e293b' }}>
              {draft.title}
            </h4>

            {draft.description ? (
              <p style={{ fontSize: 15, color: '#475569', marginBottom: 24, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {draft.description}
              </p>
            ) : (
              <p style={{ fontSize: 15, color: '#94a3b8', marginBottom: 24, fontStyle: 'italic' }}>
                Sin mensaje personalizado
              </p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ background: '#E0F2FE', padding: 8, borderRadius: 10 }}>
                  {draft.modality === 'presencial' ? <MapPin size={18} color="#0284C7" /> : <Video size={18} color="#0284C7" />}
                </div>
                <div style={{ marginTop: 2 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                    {draft.modality === 'presencial' ? 'Presencial' : 'Virtual'}
                  </span>
                  <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                    {draft.modality === 'presencial' ? draft.locationText : draft.virtualLink}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ background: '#DCFCE7', padding: 8, borderRadius: 10 }}>
                  <Clock size={18} color="#16A34A" />
                </div>
                <div style={{ marginTop: 2 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                    Duración
                  </span>
                  <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                    {formatCoordinationDuration(draft.durationMinutes, t) || 'Flexible'}
                  </span>
                </div>
              </div>
            </div>
            </div>

          {/* Card 2: Opciones propuestas */}
          <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid rgba(15,23,42,0.05)' }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#0f172a' }}>
                Opciones propuestas
              </h3>
              {onNavigate && (
                <button onClick={() => onNavigate(2)} style={{ background: '#f1f5f9', borderRadius: 20, border: 'none', color: '#3b82f6', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: '6px 14px' }}>
                  Editar
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {draft.options.map((opt, index) => {
                return (
                  <div key={opt.localId} style={{ display: 'flex', alignItems: 'center', gap: 14, background: '#f8fafc', padding: '14px 16px', borderRadius: 14, border: '1px solid rgba(15,23,42,0.05)' }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#475569', fontSize: 14, flexShrink: 0 }}>
                      {index + 1}
                    </div>
                    <span style={{ fontSize: 15, color: '#1e293b', fontWeight: 600 }}>
                      {formatFriendlyDate(opt.date, opt.time)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Card 3: Invitación y plazo */}
          <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid rgba(15,23,42,0.05)' }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#0f172a' }}>
                Invitación y Plazo
              </h3>
              {onNavigate && (
                <button onClick={() => onNavigate(3)} style={{ background: '#f1f5f9', borderRadius: 20, border: 'none', color: '#3b82f6', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: '6px 14px' }}>
                  Editar
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ background: '#FCE7F3', padding: 8, borderRadius: 10 }}>
                  <Clock size={18} color="#DB2777" />
                </div>
                <div style={{ marginTop: 2 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                    Plazo para responder
                  </span>
                  <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                    {draft.responseDeadline ? formatFriendlyDeadline(draft.responseDeadline) : 'Sin plazo definido'}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ background: '#EDE9FE', padding: 8, borderRadius: 10 }}>
                  {draft.invitationType === 'individual' ? <Users size={18} color="#7C3AED" /> : <Link size={18} color="#7C3AED" />}
                </div>
                <div style={{ marginTop: 2 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                    Tipo de invitación
                  </span>
                  <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                    {draft.invitationType === 'individual' ? 'Invitados individuales' : 'Link general'}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ background: '#FEF3C7', padding: 8, borderRadius: 10 }}>
                  <Palette size={18} color="#D97706" />
                </div>
                <div style={{ marginTop: 2 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                    Diseño
                  </span>
                  <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                    {getThemeDisplayName()}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ background: '#E0F2FE', padding: 8, borderRadius: 10 }}>
                  <Users size={18} color="#0284C7" />
                </div>
                <div style={{ marginTop: 2 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                    Visibilidad de respuestas
                  </span>
                  <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                    {draft.mostrarRespuestasAInvitados ? 'Los invitados podrán ver el resumen de respuestas.' : 'Las respuestas serán privadas para el host.'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer Sticky Avanzado */}
      <div style={{ position: 'sticky', bottom: 0, left: 0, right: 0, padding: '20px 20px', background: 'rgba(255, 255, 255, 0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderTop: '1px solid rgba(15,23,42,0.05)', boxShadow: '0 -4px 24px rgba(0,0,0,0.04)', marginTop: 'auto', display: 'flex', gap: 12, zIndex: 10, margin: '0 -20px' }}>
        <div style={{ display: 'flex', gap: 12, width: '100%', maxWidth: 600, margin: '0 auto' }}>
          <Button variant="outline" onClick={onBack} style={{ flex: 1, borderRadius: 14, border: '1px solid #cbd5e1' }} disabled={loading}>
            Atrás
          </Button>
          <Button variant="primary" onClick={handleSubmit} style={{ flex: 2, borderRadius: 14, background: '#4f46e5', boxShadow: '0 4px 12px rgba(79, 70, 229, 0.25)' }} disabled={loading || createdSuccessfullyRef.current}>
            {loading ? 'Creando...' : createdSuccessfullyRef.current ? 'Encuentro creado…' : 'Crear encuentro'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Step4Review;
