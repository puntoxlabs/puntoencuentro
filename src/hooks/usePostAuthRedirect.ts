import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-zA-Z_-]{8,64}$/i;

export const STATIC_ALLOWED_POST_AUTH_ROUTES = new Set([
  '/',
  '/solicitudes',
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

/**
 * Determina si una ruta depende de recursos transferidos (titularidad de anfitrión / creador).
 *
 * Rutas de propiedad:
 * - /meet/:id
 * - /add-guests/:id
 * - /share/:id
 * - /cancel-summary/:id
 * - /coordination/:id (coordinación gestionada por el anfitrión)
 *
 * Rutas no dependientes de propiedad transferida (invitaciones y creación libre):
 * - /invitation/:id
 * - /invite/:token
 * - /join/:token
 * - /coordination/invite/:token
 * - /coordination/join/:token
 * - /, /create, /create/coordination, /create/ai
 */
export function isOwnershipDependentRoute(path: unknown): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;

  // /meet/:id
  const meetMatch = path.match(/^\/meet\/([^/]+)$/);
  if (meetMatch && UUID_REGEX.test(meetMatch[1])) return true;

  // /add-guests/:id
  const addGuestsMatch = path.match(/^\/add-guests\/([^/]+)$/);
  if (addGuestsMatch && UUID_REGEX.test(addGuestsMatch[1])) return true;

  // /share/:id
  const shareMatch = path.match(/^\/share\/([^/]+)$/);
  if (shareMatch && UUID_REGEX.test(shareMatch[1])) return true;

  // /cancel-summary/:id
  const cancelMatch = path.match(/^\/cancel-summary\/([^/]+)$/);
  if (cancelMatch && UUID_REGEX.test(cancelMatch[1])) return true;

  // /coordination/:id (exclusivo para el ID de coordinación, sin sub-rutas invite/join)
  const coordMatch = path.match(/^\/coordination\/([^/]+)$/);
  if (coordMatch && UUID_REGEX.test(coordMatch[1])) return true;

  return false;
}

export function usePostAuthRedirect() {
  const { user, loading, transferClaimStatus } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // Invariante de seguridad: esperar a que auth termine de inicializarse
    if (loading) return;

    // Requiere usuario permanente para procesar el redirect post-auth de Google
    if (!user || user.is_anonymous) return;

    const redirectPath = sessionStorage.getItem('post_auth_redirect');
    if (!redirectPath) return;

    if (!isValidPostAuthRedirect(redirectPath)) {
      console.warn(`[usePostAuthRedirect] Ruta no permitida descartada: ${redirectPath}`);
      sessionStorage.removeItem('post_auth_redirect');
      return;
    }

    const isOwnershipRoute = isOwnershipDependentRoute(redirectPath);

    if (isOwnershipRoute) {
      // 1. Reclamo de transferencia en curso: ESPERAR estrictamente
      if (transferClaimStatus === 'claiming') {
        return;
      }

      // 2. Error transitorio de transferencia (red, 5xx, reintentos agotados pero ticket vigente):
      // NO avanzar a la ruta de anfitrión (fallaría con 403 o vista degradada).
      // NO eliminar post_auth_redirect: se preserva para que al reintentar y tener éxito,
      // la navegación se reanude automáticamente.
      if (transferClaimStatus === 'error_transient') {
        if (import.meta.env.DEV) {
          console.warn('[usePostAuthRedirect] Transferencia en error transitorio. Pausando redirección a ruta de propiedad:', redirectPath);
        }
        return;
      }

      // 3. Error terminal de transferencia (ticket expirado, revocado, ya usado o no encontrado):
      // Descartar post_auth_redirect para evitar bucles infinitos de navegación, pero NO navegar a la pantalla de anfitrión.
      if (transferClaimStatus === 'error_terminal') {
        console.warn('[usePostAuthRedirect] Error terminal en ticket de transferencia. Descartando redirección a ruta de propiedad:', redirectPath);
        sessionStorage.removeItem('post_auth_redirect');
        return;
      }

      // 4. Éxito comprobado ('success') o sin transferencia requerida ('idle'):
      // Navegación segura hacia el recurso propio.
      sessionStorage.removeItem('post_auth_redirect');
      navigate(redirectPath, { replace: true });
    } else {
      // Rutas no dependientes de propiedad (/invitation/:id, /invite/:token, /create, etc.):
      // Si aún está claiming, esperar para unificar la sesión limpiamente.
      if (transferClaimStatus === 'claiming') {
        return;
      }

      // Una vez resuelto (idle, success, error_transient o error_terminal), navegar.
      sessionStorage.removeItem('post_auth_redirect');
      navigate(redirectPath, { replace: true });
    }
  }, [user, loading, transferClaimStatus, navigate]);
}
