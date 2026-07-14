import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import { encuentrosService, getCoordinationCreateErrorMessage } from '@/services/encuentrosService';
import type { CoordinationCreatePayload, CoordinationOptionPayload } from '@/services/encuentrosService';
import { Button } from '@/components/ui/Button';
import { Calendar, Clock, MapPin, Video, Link, Users, Palette } from 'lucide-react';
import { formatFriendlyDate, formatFriendlyDeadline } from '@/lib/formatDate';
import { getAllInvitationDesignOptions, findDesignOptionIndex } from '@/lib/invitationThemes';

interface Step4ReviewProps {
  onBack: () => void;
  onNavigate?: (step: number) => void;
}

const Step4Review: React.FC<Step4ReviewProps> = ({ onBack, onNavigate }) => {
  const { draft, resetDraft } = useCoordinationWizardStore();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = React.useRef(false);

  const handleSubmit = async () => {
    if (submittingRef.current) return;

    submittingRef.current = true;
    setLoading(true);
    setError(null);

    try {
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
      };

      const options: CoordinationOptionPayload[] = draft.options.map(opt => ({
        fecha: opt.date,
        hora_inicio: opt.time
      }));

      const result = await encuentrosService.crearEncuentroConOpciones(payload, options);

      if (result.ok) {
        resetDraft();
        navigate(`/coordination/${result.encuentro.id}`);
      } else {
        if (result.error === 'invalid_response_format' || result.error === 'invalid_option_order' || result.error === 'duplicate_option_order' || result.error === 'invalid_option_order_sequence') {
          setError('No pudimos verificar la creación. Volvé a Home para comprobar si el encuentro aparece antes de intentar nuevamente.');
        } else {
          setError(getCoordinationCreateErrorMessage(result.error || 'unknown_error'));
        }
      }
    } catch (error: unknown) {
      console.error('[CreateCoordination] failed', error);
      setError(getCoordinationCreateErrorMessage('unknown_error'));
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  const hasOptions = draft.options.length > 0;

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
    <div className="pe-wizard-step fade-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div style={{ flex: 1 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, color: 'var(--pe-text)' }}>
          Revisá tu propuesta
        </h2>
        <p style={{ color: 'var(--pe-text-muted)', marginBottom: 24, fontSize: 15, lineHeight: 1.5 }}>
          Asegurate de que todo esté correcto antes de enviar las opciones a tus invitados.
        </p>

        {error && (
          <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', padding: 16, borderRadius: 8, marginBottom: 24 }}>
            <p style={{ color: '#dc2626', margin: 0, fontSize: 14, fontWeight: 500 }}>{error}</p>
            {error.includes('Volvé a Home') && (
              <Button variant="outline" onClick={() => navigate('/')} style={{ marginTop: 12 }}>
                Volver a Home
              </Button>
            )}
          </div>
        )}

        <div style={{ background: 'var(--pe-bg-hover)', borderRadius: 12, padding: 20, border: '1px solid var(--pe-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: 'var(--pe-text)' }}>
              {draft.title}
            </h3>
            {onNavigate && (
              <button onClick={() => onNavigate(1)} style={{ background: 'none', border: 'none', color: 'var(--pe-primary)', fontWeight: 600, fontSize: 14, cursor: 'pointer', padding: '4px 8px' }}>
                Editar
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
            {draft.modality === 'presencial' ? <MapPin size={20} color="var(--pe-text-muted)" /> : <Video size={20} color="var(--pe-text-muted)" />}
            <div>
              <span style={{ display: 'block', fontWeight: 600, color: 'var(--pe-text)' }}>
                {draft.modality === 'presencial' ? 'Presencial' : 'Virtual'}
              </span>
              <span style={{ display: 'block', fontSize: 14, color: 'var(--pe-text-muted)' }}>
                {draft.modality === 'presencial' ? draft.locationText : draft.virtualLink}
              </span>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--pe-border)', margin: '20px 0' }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h4 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--pe-text)' }}>
              Opciones propuestas ({draft.options.length})
            </h4>
            {onNavigate && (
              <button onClick={() => onNavigate(2)} style={{ background: 'none', border: 'none', color: 'var(--pe-primary)', fontWeight: 600, fontSize: 14, cursor: 'pointer', padding: '4px 8px' }}>
                Editar
              </button>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            {hasOptions && draft.options.map((opt, index) => {
              return (
                <div key={opt.localId} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--pe-bg)', padding: 12, borderRadius: 8, border: '1px solid var(--pe-border)' }}>
                  <Calendar size={18} color="var(--pe-text-muted)" />
                  <span style={{ fontSize: 15, color: 'var(--pe-text)' }}>
                    <span style={{ fontWeight: 600, marginRight: 8 }}>Opción {index + 1}:</span>
                    {formatFriendlyDate(opt.date, opt.time)}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ height: 1, background: 'var(--pe-border)', margin: '20px 0' }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h4 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--pe-text)' }}>
              Invitación y Plazo
            </h4>
            {onNavigate && (
              <button onClick={() => onNavigate(3)} style={{ background: 'none', border: 'none', color: 'var(--pe-primary)', fontWeight: 600, fontSize: 14, cursor: 'pointer', padding: '4px 8px' }}>
                Editar
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <Clock size={20} color="var(--pe-text-muted)" />
            <div>
              <span style={{ display: 'block', fontWeight: 600, color: 'var(--pe-text)' }}>
                Plazo para responder
              </span>
              <span style={{ display: 'block', fontSize: 14, color: 'var(--pe-text-muted)' }}>
                {draft.responseDeadline ? formatFriendlyDeadline(draft.responseDeadline) : 'Sin plazo'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            {draft.invitationType === 'individual' ? <Users size={20} color="var(--pe-text-muted)" /> : <Link size={20} color="var(--pe-text-muted)" />}
            <div>
              <span style={{ display: 'block', fontWeight: 600, color: 'var(--pe-text)' }}>
                Tipo de invitación
              </span>
              <span style={{ display: 'block', fontSize: 14, color: 'var(--pe-text-muted)' }}>
                {draft.invitationType === 'individual' ? 'Invitados individuales' : 'Link general'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Palette size={20} color="var(--pe-text-muted)" />
            <div>
              <span style={{ display: 'block', fontWeight: 600, color: 'var(--pe-text)' }}>
                Diseño
              </span>
              <span style={{ display: 'block', fontSize: 14, color: 'var(--pe-text-muted)' }}>
                {getThemeDisplayName()}
              </span>
            </div>
          </div>

        </div>
      </div>

      <div style={{ position: 'sticky', bottom: 0, padding: '16px 0', background: 'var(--pe-bg)', marginTop: 'auto', display: 'flex', gap: 12 }}>
        <Button variant="outline" onClick={onBack} style={{ flex: 1 }} disabled={loading}>
          Atrás
        </Button>
        <Button variant="primary" onClick={handleSubmit} style={{ flex: 2 }} disabled={loading}>
          {loading ? 'Creando...' : 'Crear encuentro'}
        </Button>
      </div>
    </div>
  );
};

export default Step4Review;
