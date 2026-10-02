/**
 * Validador seguro de deep links internos.
 * Previene open redirects, inyecciones de protocolos (javascript:, data:)
 * y garantiza compatibilidad con react-router-dom.
 */

export function validateDeepLink(link: string | null | undefined): string | null {
  if (!link || typeof link !== 'string') {
    return null;
  }

  const trimmed = link.trim();

  // 1. Debe comenzar con '/' y no ser una URL relativa de protocolo '//'
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return null;
  }

  // 2. Rechazar explícitamente cualquier intento de esquema de protocolo
  // (ej: javascript:, data:, vbscript:, http:, https:, mailto:)
  if (trimmed.includes(':')) {
    return null;
  }

  // 3. Caracteres permitidos: rutas alfanuméricas estándar, guiones, barras, query strings y fragmentos
  const internalRouteRegex = /^\/[a-zA-Z0-9_\-\/\.\?\=\&\#\%]+$/;
  if (!internalRouteRegex.test(trimmed)) {
    return null;
  }

  return trimmed;
}
