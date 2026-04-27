import React from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useWizardStore } from '@/store/wizardStore';

const Step1Data: React.FC = () => {
  const { titulo, fecha, hora, descripcion, setField, nextStep } = useWizardStore();
  const isValid = titulo.trim() !== '' && fecha !== '' && hora !== '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 0 }}>
      <div style={{ marginBottom: 8 }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>¿Cuándo y dónde?</h2>
        <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 0 }}>Ponele un nombre y una fecha a tu encuentro.</p>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 24 }}>
        <Input
          label="Nombre del encuentro"
          value={titulo}
          onChange={(e) => setField('titulo', e.target.value)}
          placeholder="Ej: Cena de fin de año"
        />
        <Input
          label="Fecha"
          type="date"
          value={fecha}
          onChange={(e) => setField('fecha', e.target.value)}
        />
        <Input
          label="Hora"
          type="time"
          value={hora}
          onChange={(e) => setField('hora', e.target.value)}
        />
        <Input
          label="Descripción (opcional)"
          value={descripcion}
          onChange={(e) => setField('descripcion', e.target.value)}
          placeholder="Agregá más detalles…"
        />
      </div>

      <div style={{ paddingTop: 24 }}>
        <Button fullWidth onClick={nextStep} disabled={!isValid}>
          Continuar
        </Button>
      </div>
    </div>
  );
};

export default Step1Data;
