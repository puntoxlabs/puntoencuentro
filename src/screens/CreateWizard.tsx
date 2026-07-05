import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { ScrollHint } from '@/components/ui/ScrollHint';
import { useWizardStore } from '@/store/wizardStore';

import Step1Data from '@/screens/CreateWizard/Step1Data';
import Step2Modality from '@/screens/CreateWizard/Step2Modality';
import Step3Location from '@/screens/CreateWizard/Step3Location';
import Step4InviteType from '@/screens/CreateWizard/Step4InviteType';

import './CreateWizard.css';

const TOTAL_STEPS = 4;

const stepTitles = ['Nuevo encuentro', 'Modalidad', 'Lugar', 'Invitación'];

const CreateWizard: React.FC = () => {
  const { step, prevStep, encuentro_id } = useWizardStore();
  const navigate = useNavigate();
  const [showScrollHint, setShowScrollHint] = React.useState(false);

  React.useEffect(() => {
    const checkScroll = () => {
      const scrollY = window.scrollY;
      const viewportHeight = window.innerHeight;
      const totalHeight = document.documentElement.scrollHeight;
      
      const hasOverflow = totalHeight > viewportHeight + 12;
      const isBottom = totalHeight - scrollY - viewportHeight < 120;
      setShowScrollHint(hasOverflow && !isBottom);
    };

    window.addEventListener('scroll', checkScroll);
    window.addEventListener('resize', checkScroll);
    const timer = setTimeout(checkScroll, 350);

    return () => {
      window.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
      clearTimeout(timer);
    };
  }, [step]);

  const handleBack = () => {
    if (encuentro_id) {
      navigate(`/meet/${encuentro_id}`);
      return;
    }
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
      <div className="cw-progress-track">
        <div 
          className="cw-progress-fill"
          style={{ width: `${progress}%` }} 
        />
      </div>

      {/* Step counter */}
      <p className="cw-step-counter">
        Paso {step} de {TOTAL_STEPS}
      </p>

      {renderStep()}
      <ScrollHint visible={showScrollHint} />
    </ScreenContainer>
  );
};

export default CreateWizard;
