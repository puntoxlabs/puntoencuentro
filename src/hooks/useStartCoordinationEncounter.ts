import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { DATE_COORDINATION_ENABLED } from '@/config/features';

export function isPermanentUser(user: unknown): boolean {
  if (typeof user !== 'object' || user === null) return false;
  return (user as Record<string, unknown>).is_anonymous !== true;
}

export function getFriendlyAuthError(error?: string): string {
  if (error === 'anonymous_account_linking_pending') {
    return 'No pudimos iniciar sesión con Google desde esta sesión. Cerrá esta ventana e intentá nuevamente, o elegí fecha definida.';
  }
  return 'No pudimos iniciar sesión con Google. Intentá nuevamente.';
}

export function useStartCoordinationEncounter() {
  const navigate = useNavigate();
  const { user, loading: authLoading, signInWithGoogle } = useAuth();
  const [isAnonWarningOpen, setIsAnonWarningOpen] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCoordinationEncounter = () => {
    if (!DATE_COORDINATION_ENABLED) return;
    if (authLoading) return;

    if (isPermanentUser(user)) {
      navigate('/create/coordination');
      return;
    }

    // Limpiar errores stale antes de abrir
    setError(null);
    // Mostrar el sheet si no tiene cuenta permanente (sea anónimo o no tenga sesión)
    setIsAnonWarningOpen(true);
  };

  const handleContinueWithGoogle = async () => {
    setIsGoogleLoading(true);
    setError(null);
    try {
      sessionStorage.setItem('post_auth_redirect', '/create/coordination');
      const result = await signInWithGoogle();
      
      if (result && result.ok === false) {
        setError(getFriendlyAuthError(result.error));
      }
    } catch (err) {
      console.error('[Coordination] Google sign-in failed', err);
      setError(getFriendlyAuthError());
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleClose = () => {
    setIsAnonWarningOpen(false);
    setError(null);
  };

  return {
    startCoordinationEncounter,
    coordinationWarningProps: {
      open: isAnonWarningOpen,
      onClose: handleClose,
      onContinueWithGoogle: handleContinueWithGoogle,
      googleLoading: isGoogleLoading,
      error,
    }
  };
}
