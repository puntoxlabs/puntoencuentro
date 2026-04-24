import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from '@/screens/Home';
import CreateWizard from '@/screens/CreateWizard';
import DetailHost from '@/screens/DetailHost';
import AddGuests from '@/screens/AddGuests';
import ShareLink from '@/screens/ShareLink';
import InviteGuest from '@/screens/InviteGuest';
import JoinGeneral from '@/screens/JoinGeneral';
import { getHostId } from '@/lib/auth';

const App: React.FC = () => {
  useEffect(() => {
    // Ensure host_id is generated on load
    getHostId();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/create" element={<CreateWizard />} />
        <Route path="/meet/:id" element={<DetailHost />} />
        <Route path="/add-guests/:id" element={<AddGuests />} />
        <Route path="/share/:id" element={<ShareLink />} />
        <Route path="/invite/:token" element={<InviteGuest />} />
        <Route path="/join/:public_token" element={<JoinGeneral />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
