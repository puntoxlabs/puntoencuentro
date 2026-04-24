import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { useWizardStore } from '@/store/wizardStore';

import Step1Data from '@/screens/CreateWizard/Step1Data';
import Step2Modality from '@/screens/CreateWizard/Step2Modality';
import Step3Location from '@/screens/CreateWizard/Step3Location';
import Step4InviteType from '@/screens/CreateWizard/Step4InviteType';

const CreateWizard: React.FC = () => {
  const { step, reset, prevStep } = useWizardStore();
  const navigate = useNavigate();

  // Reset wizard state whenever the wizard is mounted fresh
  useEffect(() => {
    reset();
  }, [reset]);

  const handleBack = () => {
    if (step === 1) {
      navigate(-1);
    } else {
      prevStep();
    }
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

  return (
    <ScreenContainer>
      <AppBar 
        title={`Crear Encuentro (Paso ${step}/4)`} 
        showBack={true} 
        onBack={handleBack}
      />
      
      {renderStep()}
    </ScreenContainer>
  );
};

export default CreateWizard;
