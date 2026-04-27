import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { useWizardStore } from '@/store/wizardStore';

import Step1Data from '@/screens/CreateWizard/Step1Data';
import Step2Modality from '@/screens/CreateWizard/Step2Modality';
import Step3Location from '@/screens/CreateWizard/Step3Location';
import Step4InviteType from '@/screens/CreateWizard/Step4InviteType';

const TOTAL_STEPS = 4;

const stepTitles = ['Nuevo encuentro', 'Modalidad', 'Lugar', 'Invitación'];

const CreateWizard: React.FC = () => {
  const { step, prevStep } = useWizardStore();
  const navigate = useNavigate();

  const handleBack = () => {
    if (step === 1) navigate(-1);
    else prevStep();
  };

  const renderStep = () => {
    switch (step) {
      case 1: return <Step1Data />;
      case 2: return <Step2Modality />;
      case 3: return <Step3Location />;
      case 4: return <Step4InviteType />;
      default: return null;
    }
  };

  const progress = (step / TOTAL_STEPS) * 100;

  return (
    <ScreenContainer>
      <AppBar title={stepTitles[step - 1]} showBack={true} onBack={handleBack} />

      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--color-outline-variant)', borderRadius: 99, marginBottom: 24, overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: `${progress}%`,
          background: 'var(--color-primary)',
          borderRadius: 99,
          transition: 'width 0.35s ease',
        }} />
      </div>

      {/* Step counter */}
      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface-variant)', marginBottom: 8, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        Paso {step} de {TOTAL_STEPS}
      </p>

      {renderStep()}
    </ScreenContainer>
  );
};

export default CreateWizard;
