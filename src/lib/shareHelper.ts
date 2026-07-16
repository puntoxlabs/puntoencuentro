export function isMobileShareEnvironment(): boolean {
  // Same regex logic as before to detect mobile environment
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

export function isValidPublicToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildGeneralInvitationUrl(publicToken: unknown, dateMode?: 'fixed' | 'coordination' | null): string | null {
  if (!isValidPublicToken(publicToken)) return null;
  const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
  // Ensure we don't have double slashes if baseUrl has a trailing slash
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const basePath = dateMode === 'coordination' ? '/coordination/join/' : '/join/';
  return `${cleanBaseUrl}${basePath}${encodeURIComponent(publicToken.trim())}`;
}
