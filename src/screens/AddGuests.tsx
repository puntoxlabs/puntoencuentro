import React, { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { useAuth } from '@/contexts/AuthContext';
import { getHostId } from '@/lib/auth';
import { getEncuentroHost } from '@/lib/meetHostsStorage';

const AddGuests: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading || !id) return;
    
    // Preservar la lógica robusta de hostId antes del redirect para asegurar consistencia
    const hostId = user?.id ?? getEncuentroHost(id) ?? getHostId();
    
    if (import.meta.env.DEV) {
      console.log('[AddGuests Redirect] Resolving hostId:', hostId);
    }
    
    // Redirect with replace to prevent breaking back navigation and support direct refresh
    navigate(`/meet/${id}?guests=1`, { replace: true });
  }, [id, authLoading, navigate, user]);

  return (
    <ScreenContainer>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--color-on-surface-variant)', fontWeight: 500 }}>
          Cargando invitaciones...
        </p>
      </div>
    </ScreenContainer>
  );
};

export default AddGuests;
