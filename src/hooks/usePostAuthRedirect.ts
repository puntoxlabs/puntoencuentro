import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-zA-Z_-]{8,64}$/i;

export const STATIC_ALLOWED_POST_AUTH_ROUTES = new Set([
  '/',
  '/create',
  '/create/coordination',
  '/create/ai',
]);

// Mantenido para retrocompatibilidad
export const ALLOWED_POST_AUTH_ROUTES = STATIC_ALLOWED_POST_AUTH_ROUTES;

/**
 * Validador estricto de rutas de redirección post-autenticación.
 *
 * Rechaza:
 * - URLs externas (http:, https:, //evil.com, ftp:)
 * - Rutas ambiguas relativas o con bypass de barras (/\evil.com, \\evil.com)
 * - Doble barra interna (//)
 * - Inyección de esquemas o caracteres de escape (://, null bytes, saltos de línea)
 * - Traversal de directorios (..)
 * - Parámetros de consulta o hashes manipulados (?token=..., #...)
 * - Prefijos abiertos que no coincidan exactamente con un patrón reconocido
 *
 * Admite exclusivamente:
 * - Rutas estáticas de creación y home: /, /create, /create/coordination, /create/ai
 * - /meet/:id (donde :id es UUID)
 * - /invitation/:id (donde :id es UUID)
 * - /invite/:token (donde :token es UUID o token seguro de 8 a 64 chars)
 * - /join/:token (donde :token es UUID o token seguro de 8 a 64 chars)
 * - /coordination/:id (donde :id es UUID)
 * - /coordination/invite/:token (donde :token es UUID o token seguro)
 * - /coordination/join/:token (donde :token es UUID o token seguro)
 * - /share/:id, /add-guests/:id, /cancel-summary/:id (donde :id es UUID)
 */
export function isValidPostAuthRedirect(path: unknown): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;

  // 1. Debe comenzar exactamente con una barra normal; rechazar dobles barras y backslashes
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\') || path.includes('\\')) {
    return false;
  }

  // 2. Rechazar esquemas, traversal, caracteres de control, saltos de línea y espacios
  if (path.includes('://') || path.includes('..') || /[\s\r\n\t\0]/.test(path)) {
    return false;
  }

  // 3. Rechazar dobles barras en cualquier posición
  if (path.includes('//')) {
    return false;
  }

  // 4. Rechazar query params o fragmentos para evitar fuga o inyección de tokens en URL
  if (path.includes('?') || path.includes('#')) {
    return false;
  }

  // 5. Rutas estáticas autorizadas
  if (STATIC_ALLOWED_POST_AUTH_ROUTES.has(path)) {
    return true;
  }

  // 6. Validación estricta por familia de rutas dinámicas

  // /meet/:id
  const meetMatch = path.match(/^\/meet\/([^/]+)$/);
  if (meetMatch && UUID_REGEX.test(meetMatch[1])) return true;

  // /invitation/:id
  const invMatch = path.match(/^\/invitation\/([^/]+)$/);
  if (invMatch && UUID_REGEX.test(invMatch[1])) return true;

  // /invite/:token
  const inviteMatch = path.match(/^\/invite\/([^/]+)$/);
  if (inviteMatch && TOKEN_REGEX.test(inviteMatch[1])) return true;

  // /join/:token
  const joinMatch = path.match(/^\/join\/([^/]+)$/);
  if (joinMatch && TOKEN_REGEX.test(joinMatch[1])) return true;

  // /coordination/:id
  const coordMatch = path.match(/^\/coordination\/([^/]+)$/);
  if (coordMatch && UUID_REGEX.test(coordMatch[1])) return true;

  // /coordination/invite/:token
  const coordInviteMatch = path.match(/^\/coordination\/invite\/([^/]+)$/);
  if (coordInviteMatch && TOKEN_REGEX.test(coordInviteMatch[1])) return true;

  // /coordination/join/:token
  const coordJoinMatch = path.match(/^\/coordination\/join\/([^/]+)$/);
  if (coordJoinMatch && TOKEN_REGEX.test(coordJoinMatch[1])) return true;

  // Rutas de gestión de encuentro propio
  const addGuestsMatch = path.match(/^\/add-guests\/([^/]+)$/);
  if (addGuestsMatch && UUID_REGEX.test(addGuestsMatch[1])) return true;

  const shareMatch = path.match(/^\/share\/([^/]+)$/);
  if (shareMatch && UUID_REGEX.test(shareMatch[1])) return true;

  const cancelMatch = path.match(/^\/cancel-summary\/([^/]+)$/);
  if (cancelMatch && UUID_REGEX.test(cancelMatch[1])) return true;

  return false;
}

export function usePostAuthRedirect() {
  const { user, loading, isTransferClaimPending } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // Invariante de seguridad: esperar a que auth y cualquier reclamo de transferencia
    // pendiente concluyan antes de restaurar rutas que dependen de propiedad de recursos.
    if (loading || isTransferClaimPending) return;

    // Requiere usuario permanente para procesar el redirect post-auth de Google
    if (user && !user.is_anonymous) {
      const redirectPath = sessionStorage.getItem('post_auth_redirect');

      if (redirectPath) {
        sessionStorage.removeItem('post_auth_redirect');

        if (isValidPostAuthRedirect(redirectPath)) {
          navigate(redirectPath, { replace: true });
        } else {
          console.warn(`[usePostAuthRedirect] Ruta no permitida descartada: ${redirectPath}`);
        }
      }
    }
  }, [user, loading, isTransferClaimPending, navigate]);
}
