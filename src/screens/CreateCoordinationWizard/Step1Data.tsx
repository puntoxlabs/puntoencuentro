import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MapPin, Video } from 'lucide-react';
import { SelectableOptionCard } from '@/components/ui/SelectableOptionCard';
import '../CreateWizard.css';

interface Step1DataProps {
  onNext: () => void;
  onBack: () => void;
}

const Step1Data: React.FC<Step1DataProps> = ({ onNext, onBack }) => {
  const { draft, updateDraft } = useCoordinationWizardStore();
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  
  const locationState = useLocation().state as { autoFocusTitle?: boolean } | null;
  const nameInputRef = useRef<HTMLInputElement>(null);
  const didAutoFocusRef = useRef(false);

  useEffect(() => {
    if (didAutoFocusRef.current) return;
    didAutoFocusRef.current = true;
    if (locationState?.autoFocusTitle === false) return;

    const runFocus = () => {
      const input = nameInputRef.current;
      if (!input) return;

      window.scrollTo({ top: 0, behavior: 'auto' });
      input.focus();

      setTimeout(() => {
        window.history.replaceState({}, document.title);
      }, 250);
    };

    requestAnimationFrame(() => {
      setTimeout(runFocus, 120);
    });
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>, nextFieldSelector?: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (nextFieldSelector) {
        const nextElement = document.querySelector(nextFieldSelector) as HTMLElement;
        if (nextElement && 'focus' in nextElement) {
          nextElement.focus();
        }
      }
    }
  };

  const validate = () => {
    const newErrors: { [key: string]: string } = {};
    if (!draft.title.trim()) {
      newErrors.title = 'El título es obligatorio';
    }
    if (draft.modality === 'presencial' && !draft.locationText.trim()) {
      newErrors.locationText = 'Ingresá el lugar o dirección';
    }
    if (draft.modality === 'virtual' && !draft.virtualLink.trim()) {
      newErrors.virtualLink = 'Ingresá el enlace de la videollamada';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (validate()) {
      onNext();
    } else {
      setTimeout(() => {
        const firstError = document.querySelector('.input-error, [style*="color: #DC2626"]');
        if (firstError) {
          firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
          (firstError as HTMLElement).focus?.();
        }
      }, 50);
    }
  };

  return (
    <div className="pe-wizard-step fade-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', flex: 1, paddingBottom: '120px' }}>
      <div style={{ flex: 1 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, color: 'var(--pe-text)' }}>
          ¿De qué se trata el encuentro?
        </h2>
        <p style={{ color: 'var(--pe-text-muted)', marginBottom: 24, fontSize: 15, lineHeight: 1.5 }}>
          Completá los datos básicos para que todos sepan de qué se trata.
        </p>

        <Input
          ref={nameInputRef}
          label="Título"
          placeholder="Ej: Asado del domingo, Reunión de equipo..."
          value={draft.title}
          enterKeyHint="next"
          onKeyDown={(e) => handleKeyDown(e, '#desc-textarea')}
          onChange={(e) => {
            updateDraft({ title: e.target.value });
            if (errors.title) setErrors({ ...errors, title: '' });
          }}
          error={errors.title}
          required
        />

        <div className="input-group cw-textarea-wrapper" style={{ marginTop: 16 }}>
          <label className="input-label">Descripción del encuentro (opcional)</label>
          <textarea
            id="desc-textarea"
            className="input-field cw-textarea-field"
            placeholder="Agregá detalles útiles para tus invitados"
            value={draft.description}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !draft.description.trim()) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateDraft({ description: e.target.value })}
            rows={3}
          />
        </div>

        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--pe-text)', marginTop: 24, marginBottom: 16 }}>
          Modalidad
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
          <SelectableOptionCard
            title="Presencial"
            icon={<MapPin size={24} />}
            selected={draft.modality === 'presencial'}
            onClick={() => {
              updateDraft({ modality: 'presencial', virtualLink: '' });
              setErrors({});
            }}
          />
          <SelectableOptionCard
            title="Virtual"
            icon={<Video size={24} />}
            selected={draft.modality === 'virtual'}
            onClick={() => {
              updateDraft({ modality: 'virtual', locationText: '' });
              setErrors({});
            }}
          />
        </div>

        {draft.modality === 'presencial' && (
          <div className="slide-from-right">
            <Input
              label="Lugar o dirección"
              placeholder="Ej: Mi casa, Parque Saavedra..."
              value={draft.locationText}
              onChange={(e) => {
                updateDraft({ locationText: e.target.value });
                if (errors.locationText) setErrors({ ...errors, locationText: '' });
              }}
              error={errors.locationText}
              required
            />
          </div>
        )}

        {draft.modality === 'virtual' && (
          <div className="slide-from-right">
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--pe-text)', marginBottom: 6, marginLeft: 2 }}>
              Link de videollamada
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <Input
                  placeholder="Pegá el enlace de Zoom, Meet, Teams..."
                  value={draft.virtualLink}
                  onChange={(e) => {
                    updateDraft({ virtualLink: e.target.value });
                    if (errors.virtualLink) setErrors({ ...errors, virtualLink: '' });
                  }}
                  error={errors.virtualLink}
                  required
                />
              </div>
              <Button
                variant="outline"
                type="button"
                style={{ height: '52px', padding: '0 16px' }}
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text) {
                      updateDraft({ virtualLink: text });
                      if (errors.virtualLink) setErrors({ ...errors, virtualLink: '' });
                    }
                  } catch (err) {
                    console.error('Failed to read clipboard', err);
                    alert('No se pudo acceder al portapapeles. Asegurate de dar permisos o pegá el link manualmente.');
                  }
                }}
              >
                Pegar
              </Button>
            </div>
          </div>
        )}

        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--pe-text)', marginTop: 24, marginBottom: 16 }}>
          Duración estimada
        </h3>
        <div style={{ marginBottom: 24 }}>
          <select
            className="input-field"
            value={draft.durationMinutes === null ? 'flexible' : [30, 45, 60, 90, 120].includes(draft.durationMinutes) ? draft.durationMinutes.toString() : 'custom'}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'flexible') updateDraft({ durationMinutes: null });
              else if (val === 'custom') updateDraft({ durationMinutes: 15 });
              else updateDraft({ durationMinutes: parseInt(val, 10) });
            }}
          >
            <option value="flexible">Flexible</option>
            <option value="30">30 minutos</option>
            <option value="45">45 minutos</option>
            <option value="60">1 hora</option>
            <option value="90">1 hora y 30 minutos</option>
            <option value="120">2 horas</option>
            <option value="custom">Personalizada</option>
          </select>

          {draft.durationMinutes !== null && ![30, 45, 60, 90, 120].includes(draft.durationMinutes) && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 12 }} className="slide-from-right">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--pe-text-muted)', marginLeft: 2 }}>Horas</label>
                <input
                  type="number"
                  className="input-field"
                  style={{ width: 100 }}
                  min={0}
                  max={24}
                  value={draft.durationMinutes !== null ? Math.floor(draft.durationMinutes / 60) : 0}
                  onChange={(e) => {
                    let h = parseInt(e.target.value, 10);
                    if (isNaN(h)) h = 0;
                    const m = (draft.durationMinutes || 0) % 60;
                    let total = h * 60 + m;
                    if (total < 15) total = 15;
                    updateDraft({ durationMinutes: total });
                  }}
                  onBlur={(e) => {
                    let h = parseInt(e.target.value, 10);
                    if (isNaN(h)) h = 0;
                    const m = (draft.durationMinutes || 0) % 60;
                    let total = h * 60 + m;
                    if (total < 15) total = 15;
                    updateDraft({ durationMinutes: total });
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--pe-text-muted)', marginLeft: 2 }}>Minutos</label>
                <input
                  type="number"
                  className="input-field"
                  style={{ width: 100 }}
                  min={0}
                  max={59}
                  value={draft.durationMinutes !== null ? draft.durationMinutes % 60 : 0}
                  onChange={(e) => {
                    let m = parseInt(e.target.value, 10);
                    if (isNaN(m)) m = 0;
                    const h = Math.floor((draft.durationMinutes || 0) / 60);
                    let total = h * 60 + m;
                    if (total < 15) total = 15;
                    updateDraft({ durationMinutes: total });
                  }}
                  onBlur={(e) => {
                    let m = parseInt(e.target.value, 10);
                    if (isNaN(m)) m = 0;
                    const h = Math.floor((draft.durationMinutes || 0) / 60);
                    let total = h * 60 + m;
                    if (total < 15) total = 15;
                    updateDraft({ durationMinutes: total });
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ position: 'sticky', bottom: 0, padding: '16px 0', background: 'var(--pe-bg)', marginTop: 'auto', display: 'flex', gap: 12 }}>
        <Button variant="outline" onClick={onBack} style={{ flex: 1 }}>
          Atrás
        </Button>
        <Button variant="primary" onClick={handleNext} style={{ flex: 2 }}>
          Siguiente
        </Button>
      </div>
    </div>
  );
};

export default Step1Data;
