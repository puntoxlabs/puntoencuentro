import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from '@/screens/Home';
import CreateWizard from '@/screens/CreateWizard';
import DetailHost from '@/screens/DetailHost';
import AddGuests from '@/screens/AddGuests';
import ShareLink from '@/screens/ShareLink';
import InviteGuest from '@/screens/InviteGuest';
import JoinGeneral from '@/screens/JoinGeneral';
import CancelSummary from '@/screens/CancelSummary';
import CreateCoordinationWizard from '@/screens/CreateCoordinationWizard';
import DetailHostCoordination from '@/screens/DetailHostCoordination';
import JoinCoordination from '@/screens/JoinCoordination';
import InviteCoordination from '@/screens/InviteCoordination';
import { AuthProvider } from '@/contexts/AuthContext';
import { usePostAuthRedirect } from '@/hooks/usePostAuthRedirect';
import { DATE_COORDINATION_ENABLED } from '@/config/features';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AccessGate } from '@/components/AccessGate';

const CoordinationFeatureGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  if (!DATE_COORDINATION_ENABLED) {
    return (
      <ScreenContainer>
        <AppBar title={t('app_name', 'PuntoEncuentro')} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem' }}>
          <EmptyState
            icon={<AlertCircle size={48} />}
            title={t('coordination.feature_disabled', 'Función no disponible')}
            description={t('coordination.feature_disabled_desc', 'La coordinación de fechas no está activa en este momento.')}
            actions={
              <Button variant="primary" onClick={() => navigate('/', { replace: true })}>
                {t('coordination.go_home', 'Volver al inicio')}
              </Button>
            }
          />
        </div>
      </ScreenContainer>
    );
  }
  return <>{children}</>;
};

const AppRoutes: React.FC = () => {
  usePostAuthRedirect();

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/create" element={<CreateWizard />} />
      <Route path="/create/coordination" element={<CreateCoordinationWizard />} />
      <Route path="/meet/:id" element={<DetailHost />} />
      <Route path="/coordination/:id" element={<DetailHostCoordination />} />
      <Route path="/add-guests/:id" element={<AddGuests />} />
      <Route path="/share/:id" element={<ShareLink />} />
      <Route path="/invite/:token" element={<InviteGuest />} />
      <Route path="/join/:public_token" element={<JoinGeneral />} />
      <Route path="/coordination/join/:token" element={
        <CoordinationFeatureGate>
          <JoinCoordination />
        </CoordinationFeatureGate>
      } />
      <Route path="/coordination/invite/:token" element={
        <CoordinationFeatureGate>
          <InviteCoordination />
        </CoordinationFeatureGate>
      } />
      <Route path="/cancel-summary/:id" element={<CancelSummary />} />
    </Routes>
  );
};

const App: React.FC = () => {
  return (
    <AccessGate>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </AccessGate>
  );
};

export default App;
