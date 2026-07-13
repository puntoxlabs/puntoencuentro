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
import { AuthProvider } from '@/contexts/AuthContext';
import { usePostAuthRedirect } from '@/hooks/usePostAuthRedirect';

const AppRoutes: React.FC = () => {
  usePostAuthRedirect();

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/create" element={<CreateWizard />} />
      <Route path="/meet/:id" element={<DetailHost />} />
      <Route path="/add-guests/:id" element={<AddGuests />} />
      <Route path="/share/:id" element={<ShareLink />} />
      <Route path="/invite/:token" element={<InviteGuest />} />
      <Route path="/join/:public_token" element={<JoinGeneral />} />
      <Route path="/cancel-summary/:id" element={<CancelSummary />} />
    </Routes>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
};

export default App;
