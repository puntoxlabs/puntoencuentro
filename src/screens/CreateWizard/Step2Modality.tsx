import React from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useWizardStore } from '@/store/wizardStore';

const Step2Modality: React.FC = () => {
  const { modalidad, setField, nextStep } = useWizardStore();
  
  const isValid = modalidad !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '16px' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 600 }}>¿Cómo será el encuentro?</h3>
        
        <Card 
          onClick={() => setField('modalidad', 'presencial')}
          style={{ border: modalidad === 'presencial' ? '2px solid var(--color-primary)' : '1px solid var(--color-outline-variant)' }}
        >
          <h4 style={{ marginBottom: '4px' }}>Presencial</h4>
          <p style={{ margin: 0 }}>En un lugar físico</p>
        </Card>

        <Card 
          onClick={() => setField('modalidad', 'virtual')}
          style={{ border: modalidad === 'virtual' ? '2px solid var(--color-primary)' : '1px solid var(--color-outline-variant)' }}
        >
          <h4 style={{ marginBottom: '4px' }}>Virtual</h4>
          <p style={{ margin: 0 }}>Por videollamada</p>
        </Card>
      </div>
      <Button fullWidth onClick={nextStep} disabled={!isValid}>
        Continuar
      </Button>
    </div>
  );
};
export default Step2Modality;
