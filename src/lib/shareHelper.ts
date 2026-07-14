export function isMobileShareEnvironment(): boolean {
  // Same regex logic as before to detect mobile environment
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

export function isValidPublicToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildGeneralInvitationUrl(publicToken: unknown): string | null {
  if (!isValidPublicToken(publicToken)) return null;
  const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
  // Ensure we don't have double slashes if baseUrl has a trailing slash
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${cleanBaseUrl}/join/${encodeURIComponent(publicToken.trim())}`;
}
