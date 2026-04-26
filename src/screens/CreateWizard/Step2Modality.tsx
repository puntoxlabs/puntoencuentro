import React, { useState, useRef, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { useWizardStore } from '@/store/wizardStore';

const Step2Modality: React.FC = () => {
  const { modalidad, setField, nextStep } = useWizardStore();
  const [isNavigating, setIsNavigating] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleSelect = (mod: 'presencial' | 'virtual') => {
    if (isNavigating) return;
    
    setField('modalidad', mod);
    setIsNavigating(true);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    timeoutRef.current = setTimeout(() => {
      nextStep();
    }, 250);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '16px' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 600 }}>¿Cómo será el encuentro?</h3>
        
        <Card 
          onClick={() => handleSelect('presencial')}
          style={{ 
            border: modalidad === 'presencial' ? '2px solid var(--color-primary)' : '1px solid var(--color-outline-variant)',
            opacity: isNavigating && modalidad !== 'presencial' ? 0.6 : 1,
            transition: 'all 0.2s ease',
            cursor: 'pointer'
          }}
        >
          <h4 style={{ marginBottom: '4px' }}>Presencial</h4>
          <p style={{ margin: 0 }}>En un lugar físico</p>
        </Card>

        <Card 
          onClick={() => handleSelect('virtual')}
          style={{ 
            border: modalidad === 'virtual' ? '2px solid var(--color-primary)' : '1px solid var(--color-outline-variant)',
            opacity: isNavigating && modalidad !== 'virtual' ? 0.6 : 1,
            transition: 'all 0.2s ease',
            cursor: 'pointer'
          }}
        >
          <h4 style={{ marginBottom: '4px' }}>Virtual</h4>
          <p style={{ margin: 0 }}>Por videollamada</p>
        </Card>
      </div>
    </div>
  );
};
export default Step2Modality;
