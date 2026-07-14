import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';


const ALLOWED_POST_AUTH_ROUTES = new Set([
  '/create',
  '/create/coordination',
]);

export function usePostAuthRedirect() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;

    // Requiere usuario permanente para procesar el redirect post-auth de Google
    if (user && !user.is_anonymous) {
      const redirectPath = sessionStorage.getItem('post_auth_redirect');

      if (redirectPath) {
        sessionStorage.removeItem('post_auth_redirect');

        if (ALLOWED_POST_AUTH_ROUTES.has(redirectPath)) {
          navigate(redirectPath, { replace: true });
        } else {
          console.warn(`[usePostAuthRedirect] Ruta no permitida descartada: ${redirectPath}`);
        }
      }
    }
  }, [user, loading, navigate]);
}
