import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { ensureHostSession } from '@/lib/ensureHostSession';

export const POST_AUTH_REDIRECT_KEY = 'post_auth_redirect';

export function useCreateEncounter() {
  const navigate = useNavigate();
  const { user, loading: authLoading, signInWithGoogle } = useAuth();

  const [isChoiceOpen, setIsChoiceOpen] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [anonymousLoading, setAnonymousLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creatingRef = useRef(false);

  const startFixedEncounter = () => {
    if (authLoading || creatingRef.current) return;

    if (user) {
      navigate('/create');
      return;
    }

    setIsChoiceOpen(true);
  };

  const closeChoice = () => {
    if (googleLoading || anonymousLoading) return;
    setIsChoiceOpen(false);
    setError(null);
  };

  const continueWithGoogle = async () => {
    if (googleLoading || anonymousLoading) return;

    setGoogleLoading(true);
    setError(null);

    // Guardar intención
    sessionStorage.setItem(POST_AUTH_REDIRECT_KEY, '/create');

    const result = await signInWithGoogle();

    if (!result.ok) {
      setGoogleLoading(false);
      if (result.error !== 'anonymous_account_linking_pending') {
        setError('No pudimos iniciar sesión con Google. Intentá nuevamente.');
      } else {
        // En teoría no deberíamos llegar aquí porque el visitante no tiene sesión,
        // pero por seguridad:
        sessionStorage.removeItem(POST_AUTH_REDIRECT_KEY);
      }
    }
    // Si ok = true, la redirección de OAuth ocurre o ya estaba logueado.
  };

  const continueAnonymously = async () => {
    if (googleLoading || anonymousLoading || creatingRef.current) return;

    creatingRef.current = true;
    setAnonymousLoading(true);
    setError(null);

    try {
      await ensureHostSession();
      setIsChoiceOpen(false);
      navigate('/create');
    } catch (err) {
      console.error('[CreateEncounter] unable to start anonymous fixed encounter', err);
      setError('No pudimos iniciar la creación. Intentá nuevamente.');
    } finally {
      creatingRef.current = false;
      setAnonymousLoading(false);
    }
  };

  return {
    startFixedEncounter,
    continueWithGoogle,
    continueAnonymously,
    closeChoice,
    choiceSheetProps: {
      open: isChoiceOpen,
      googleLoading,
      anonymousLoading,
      error,
      onContinueWithGoogle: continueWithGoogle,
      onContinueAnonymously: continueAnonymously,
      onClose: closeChoice,
    }
  };
}
