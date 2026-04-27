import React from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useWizardStore } from '@/store/wizardStore';

const Step3Location: React.FC = () => {
  const { modalidad, lugar_texto, link_virtual, setField, nextStep } = useWizardStore();
  
  const isPresencial = modalidad === 'presencial';
  const isValid = isPresencial ? lugar_texto.trim() !== '' : link_virtual.trim() !== '';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && isValid) {
      nextStep();
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setField('link_virtual', text);
      }
    } catch (err) {
      console.error('Failed to read clipboard', err);
    }
  };

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
              onKeyDown={handleKeyDown}
              placeholder="Ej: Club Padel Norte - Av. Libertador 1234" 
            />
          </>
        ) : (
          <>
            <h3 style={{ fontSize: '18px', fontWeight: 600 }}>Enlace de la videollamada</h3>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <Input 
                  label="Link" 
                  value={link_virtual} 
                  onChange={(e) => setField('link_virtual', e.target.value)} 
                  onKeyDown={handleKeyDown}
                  placeholder="https://meet.google.com/..." 
                  type="url"
                />
              </div>
              <Button variant="outline" onClick={handlePaste} style={{ height: '48px', marginBottom: '4px' }}>
                Pegar
              </Button>
            </div>
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
