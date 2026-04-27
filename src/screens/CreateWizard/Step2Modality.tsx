import React, { useState } from 'react';
import { useWizardStore } from '@/store/wizardStore';

const optionCard = (selected: boolean): React.CSSProperties => ({
  background: selected ? 'var(--color-primary-container)' : '#fff',
  border: selected ? '2px solid var(--color-primary)' : '1.5px solid var(--color-outline-variant)',
  borderRadius: 16,
  padding: '18px 20px',
  cursor: 'pointer',
  transition: 'all 0.18s ease',
  boxShadow: selected ? '0 0 0 3px rgba(26, 86, 240, 0.1)' : '0 2px 6px rgba(0,0,0,0.04)',
});

const Step2Modality: React.FC = () => {
  const { modalidad, setField, nextStep } = useWizardStore();
  const [isNavigating, setIsNavigating] = useState(false);

  const handleSelect = (mod: 'presencial' | 'virtual') => {
    if (isNavigating) return;
    setIsNavigating(true);
    setField('modalidad', mod);
    nextStep();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 0 }}>
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>¿Cómo se encuentran?</h2>
        <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)' }}>Elegí la modalidad del encuentro.</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div
          style={{ ...optionCard(modalidad === 'presencial'), opacity: isNavigating && modalidad !== 'presencial' ? 0.5 : 1 }}
          onClick={() => handleSelect('presencial')}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>🤝</div>
          <h4 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Presencial</h4>
          <p style={{ margin: 0, fontSize: 14 }}>Se ven en un lugar físico</p>
        </div>

        <div
          style={{ ...optionCard(modalidad === 'virtual'), opacity: isNavigating && modalidad !== 'virtual' ? 0.5 : 1 }}
          onClick={() => handleSelect('virtual')}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>💻</div>
          <h4 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Virtual</h4>
          <p style={{ margin: 0, fontSize: 14 }}>Por videollamada</p>
        </div>
      </div>
    </div>
  );
};

export default Step2Modality;
