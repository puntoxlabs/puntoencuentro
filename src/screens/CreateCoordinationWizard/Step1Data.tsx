import React, { useState } from 'react';
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
    }
  };

  return (
    <div className="pe-wizard-step fade-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div style={{ flex: 1 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, color: 'var(--pe-text)' }}>
          ¿De qué se trata el encuentro?
        </h2>
        <p style={{ color: 'var(--pe-text-muted)', marginBottom: 24, fontSize: 15, lineHeight: 1.5 }}>
          Completá los datos básicos para que todos sepan de qué se trata.
        </p>

        <Input
          label="Título"
          placeholder="Ej: Asado del domingo, Reunión de equipo..."
          value={draft.title}
          onChange={(e) => {
            updateDraft({ title: e.target.value });
            if (errors.title) setErrors({ ...errors, title: '' });
          }}
          error={errors.title}
          required
        />

        <div style={{ marginTop: 16 }}>
          <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--pe-text)', marginBottom: 8 }}>
            Descripción (opcional)
          </label>
          <textarea
            className="input-field"
            placeholder="Agregá más detalles sobre el encuentro..."
            value={draft.description}
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
            <Input
              label="Enlace de la videollamada"
              placeholder="https://meet.google.com/..."
              value={draft.virtualLink}
              onChange={(e) => {
                updateDraft({ virtualLink: e.target.value });
                if (errors.virtualLink) setErrors({ ...errors, virtualLink: '' });
              }}
              error={errors.virtualLink}
              required
            />
          </div>
        )}
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
