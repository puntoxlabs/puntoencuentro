import React from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useWizardStore } from '@/store/wizardStore';

const Step1Data: React.FC = () => {
  const { titulo, fecha, hora, descripcion, setField, nextStep } = useWizardStore();
  
  const isValid = titulo.trim() !== '' && fecha !== '' && hora !== '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '16px' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <Input 
          label="Título del encuentro" 
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
          placeholder="Agregá más detalles..." 
        />
      </div>
      <Button fullWidth onClick={nextStep} disabled={!isValid}>
        Continuar
      </Button>
    </div>
  );
};
export default Step1Data;
