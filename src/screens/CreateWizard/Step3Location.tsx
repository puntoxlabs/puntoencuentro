import React from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useWizardStore } from '@/store/wizardStore';

const Step3Location: React.FC = () => {
  const { modalidad, lugar_texto, link_virtual, setField, nextStep } = useWizardStore();
  
  const isPresencial = modalidad === 'presencial';
  const isValid = isPresencial ? lugar_texto.trim() !== '' : link_virtual.trim() !== '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '16px' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {isPresencial ? (
          <>
            <h3 style={{ fontSize: '18px', fontWeight: 600 }}>¿Dónde será?</h3>
            <Input 
              label="Lugar" 
              value={lugar_texto} 
              onChange={(e) => setField('lugar_texto', e.target.value)} 
              placeholder="Ej: Club Padel Norte - Av. Libertador 1234" 
            />
          </>
        ) : (
          <>
            <h3 style={{ fontSize: '18px', fontWeight: 600 }}>Enlace de la videollamada</h3>
            <Input 
              label="Link" 
              value={link_virtual} 
              onChange={(e) => setField('link_virtual', e.target.value)} 
              placeholder="https://meet.google.com/..." 
              type="url"
            />
          </>
        )}
      </div>
      <Button fullWidth onClick={nextStep} disabled={!isValid}>
        Continuar
      </Button>
    </div>
  );
};
export default Step3Location;
