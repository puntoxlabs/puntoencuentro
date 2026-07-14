import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { DATE_COORDINATION_ENABLED } from '@/config/features';

export function isPermanentUser(user: unknown): boolean {
  if (typeof user !== 'object' || user === null) return false;
  return (user as Record<string, unknown>).is_anonymous !== true;
}

export function useStartCoordinationEncounter() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [isAnonWarningOpen, setIsAnonWarningOpen] = useState(false);

  const startCoordinationEncounter = () => {
    if (!DATE_COORDINATION_ENABLED) return;

    if (authLoading) return;

    if (isPermanentUser(user)) {
      navigate('/create/coordination');
      return;
    }

    if (user?.is_anonymous) {
      setIsAnonWarningOpen(true);
      return;
    }

    // Sin sesión: navegar a la ruta para que muestre la pantalla clara de acceso
    navigate('/create/coordination');
  };

  return {
    startCoordinationEncounter,
    coordinationWarningProps: {
      open: isAnonWarningOpen,
      onClose: () => setIsAnonWarningOpen(false),
    }
  };
}
