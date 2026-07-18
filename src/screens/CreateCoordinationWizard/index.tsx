import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { DATE_COORDINATION_ENABLED } from '@/config/features';
import { AppBar } from '@/components/ui/AppBar';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { Button } from '@/components/ui/Button';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';

import Step1Data from './Step1Data';
import Step2Options from './Step2Options';
import Step3Invitation from './Step3Invitation';
import Step4Review from './Step4Review';

const steps = [
  { id: 1, label: 'Datos' },
  { id: 2, label: 'Opciones' },
  { id: 3, label: 'Invitación' },
  { id: 4, label: 'Revisión' },
];

const CreateCoordinationWizard: React.FC = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [currentStep, setCurrentStep] = useState(1);
  const resetDraft = useCoordinationWizardStore((state) => state.resetDraft);

  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const { signInWithGoogle } = useAuth();

  useEffect(() => {
    // Siempre reiniciar el borrador al entrar a la ruta base para crear un nuevo encuentro
    resetDraft();
  }, [resetDraft]);

  useEffect(() => {
    if (authLoading) return;

    if (!DATE_COORDINATION_ENABLED) {
      navigate('/', { replace: true });
      return;
    }
  }, [authLoading, navigate]);

  if (authLoading || !DATE_COORDINATION_ENABLED) {
    return (
      <ScreenContainer>
        <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <p>Cargando...</p>
        </div>
      </ScreenContainer>
    );
  }

  // C. Sin cuenta permanente (sin sesión o anónima): mostrar pantalla de login
  const isPermanentUser = user && !user.is_anonymous;
  
  if (!isPermanentUser) {
    const handleGoogleSignIn = async () => {
      if (googleLoading) return;

      setGoogleLoading(true);
      setAuthError(null);

      try {
        sessionStorage.setItem('post_auth_redirect', '/create/coordination');
        const result = await signInWithGoogle();

        if (result && result.ok === false) {
          sessionStorage.removeItem('post_auth_redirect');
          setAuthError(result.error || 'No pudimos iniciar sesión con Google. Intentá nuevamente.');
        }
      } catch (error) {
        sessionStorage.removeItem('post_auth_redirect');
        console.error('[Coordination] Google sign-in failed', error);
        setAuthError('No pudimos iniciar sesión con Google. Intentá nuevamente.');
      } finally {
        setGoogleLoading(false);
      }
    };

    return (
      <ScreenContainer>
        <AppBar title="Coordinar fecha" onBack={() => navigate('/')} />
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, textAlign: 'center' }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--pe-text)', marginBottom: 12 }}>
            Necesitás una cuenta
          </h2>
          <p style={{ fontSize: 16, color: 'var(--pe-text-muted)', marginBottom: 32 }}>
            La coordinación de fechas requiere una cuenta para guardar las respuestas de tus invitados y acceder desde cualquier dispositivo.
          </p>

          {authError && (
            <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', padding: '12px 16px', borderRadius: 8, marginBottom: 24, width: '100%' }}>
              <p style={{ color: '#dc2626', margin: 0, fontSize: 14 }}>{authError}</p>
            </div>
          )}

          <Button variant="primary" fullWidth onClick={handleGoogleSignIn} disabled={googleLoading} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
            {googleLoading ? 'Conectando...' : (
              <>
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                Continuar con Google
              </>
            )}
          </Button>
          <Button variant="outline" fullWidth onClick={() => navigate('/')} style={{ marginTop: 16 }}>
            Volver
          </Button>
        </div>
      </ScreenContainer>
    );
  }

  const handleNext = () => {
    setCurrentStep((prev) => Math.min(prev + 1, steps.length));
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    } else {
      resetDraft();
      navigate(-1);
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return <Step1Data onNext={handleNext} onBack={handleBack} />;
      case 2:
        return <Step2Options onBack={handleBack} onNext={handleNext} />;
      case 3:
        return <Step3Invitation onBack={handleBack} onNext={handleNext} />;
      case 4:
        return <Step4Review onBack={handleBack} onNavigate={setCurrentStep} />;
      default:
        return null;
    }
  };

  return (
    <ScreenContainer>
      <AppBar
        title="Coordinar una fecha"
        onBack={handleBack}
      />
      {/* Progress bar */}
      <div style={{ padding: '0 20px', paddingTop: 16, paddingBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-primary)' }}>
            Paso {currentStep} de {steps.length} &middot; <span style={{ color: 'var(--pe-text-muted)' }}>{steps[currentStep - 1].label}</span>
          </span>
        </div>
        <div style={{ background: 'var(--pe-bg-hover)', height: 4, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            width: `${(currentStep / steps.length) * 100}%`,
            background: 'var(--pe-primary)',
            height: '100%',
            transition: 'width 0.3s ease'
          }} />
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {renderStep()}
      </div>
    </ScreenContainer>
  );
};

export default CreateCoordinationWizard;
