import React, { useState } from 'react';
import { useWizardStore } from '@/store/wizardStore';
import { Button } from '@/components/ui/Button';



const Step2Modality: React.FC = () => {
  const { modalidad, setField, nextStep } = useWizardStore();
  const [isNavigating, setIsNavigating] = useState(false);
  const [hasInitialValue] = useState(!!modalidad);

  const handleSelect = (mod: 'presencial' | 'virtual') => {
    if (isNavigating) return;
    setIsNavigating(true);
    setField('modalidad', mod);
    nextStep();
  };

  return (
    <div className="cw-container">
      <div className="cw-step-header cw-step-header--padded">
        <h2 className="cw-step-title">¿Cómo se encuentran?</h2>
        <p className="cw-step-subtitle">Elegí la modalidad del encuentro.</p>
      </div>

      <div className="cw-options-grid">
        <div
          className={`cw-option-card ${modalidad === 'presencial' ? 'cw-option-card--selected' : ''} ${isNavigating && modalidad !== 'presencial' ? 'cw-option-card--disabled' : ''}`}
          onClick={() => handleSelect('presencial')}
        >
          <div className="cw-option-icon">🤝</div>
          <h4 className="cw-option-title">Presencial</h4>
          <p className="cw-option-desc">Se ven en un lugar físico</p>
        </div>

        <div
          className={`cw-option-card ${modalidad === 'virtual' ? 'cw-option-card--selected' : ''} ${isNavigating && modalidad !== 'virtual' ? 'cw-option-card--disabled' : ''}`}
          onClick={() => handleSelect('virtual')}
        >
          <div className="cw-option-icon">💻</div>
          <h4 className="cw-option-title">Virtual</h4>
          <p className="cw-option-desc">Por videollamada</p>
        </div>
      </div>

      {hasInitialValue && (
        <div className="cw-bottom-actions">
          <Button
            fullWidth
            onClick={() => {
              if (!isNavigating) {
                setIsNavigating(true);
                nextStep();
              }
            }}
          >
            Continuar
          </Button>
        </div>
      )}
    </div>
  );
};

export default Step2Modality;
