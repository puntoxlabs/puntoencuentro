import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { DATE_COORDINATION_ENABLED } from '@/config/features';
import { AppBar } from '@/components/ui/AppBar';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { Button } from '@/components/ui/Button';
import { AlertTriangle } from 'lucide-react';
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

  // C. Sin sesión: mostrar pantalla clara de acceso
  if (!user) {
    const handleGoogleSignIn = async () => {
      if (googleLoading) return;

      setGoogleLoading(true);
      setAuthError(null);

      try {
        sessionStorage.setItem('post_auth_redirect', '/create/coordination');

        const result = await signInWithGoogle();

        // Si signInWithGoogle devuelve un objeto con un estado (depende de la implementación real de AuthContext)
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
            Necesitas una cuenta
          </h2>
          <p style={{ fontSize: 16, color: 'var(--pe-text-muted)', marginBottom: 32 }}>
            La coordinación de fechas requiere una cuenta para poder invitar a otros y recibir sus respuestas en un solo lugar de forma segura.
          </p>

          {authError && (
            <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', padding: '12px 16px', borderRadius: 8, marginBottom: 24, width: '100%' }}>
              <p style={{ color: '#dc2626', margin: 0, fontSize: 14 }}>{authError}</p>
            </div>
          )}

          <Button variant="primary" fullWidth onClick={handleGoogleSignIn} disabled={googleLoading}>
            {googleLoading ? 'Conectando...' : 'Continuar con Google'}
          </Button>
          <Button variant="outline" fullWidth onClick={() => navigate('/')} style={{ marginTop: 16 }}>
            Volver
          </Button>
        </div>
      </ScreenContainer>
    );
  }

  // D. Sesión anónima: mostrar advertencia sin cerrar sesión
  if (user.is_anonymous) {
    return (
      <ScreenContainer>
        <AppBar title="Coordinar fecha" onBack={() => navigate('/')} />
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(245, 158, 11, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f59e0b', marginBottom: 24 }}>
            <AlertTriangle size={32} />
          </div>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--pe-text)', marginBottom: 12 }}>
            Protegé tu historial antes de coordinar
          </h2>
          <p style={{ fontSize: 16, color: 'var(--pe-text)', marginBottom: 16 }}>
            La coordinación de fechas requiere una cuenta. Todavía no podemos vincular automáticamente con Google los encuentros creados en esta sesión.
          </p>
          <div style={{ background: 'var(--pe-bg-hover)', padding: 16, borderRadius: 12, marginBottom: 32 }}>
            <p style={{ fontSize: 14, color: 'var(--pe-text-muted)', margin: 0 }}>
              <strong>Advertencia:</strong> Para no perder tus encuentros actuales, no cierres esta sesión ni borres los datos del navegador.
              <br/><br/>
              <em>Vinculación con Google: próximamente</em>
            </p>
          </div>
          <Button variant="primary" fullWidth onClick={() => navigate(-1)}>
            Entendido
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
