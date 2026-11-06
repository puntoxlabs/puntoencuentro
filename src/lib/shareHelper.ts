export function isMobileShareEnvironment(): boolean {
  if (typeof navigator === 'undefined' || !navigator.userAgent) return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

export function isValidPublicToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

export function getBaseAppUrl(): string {
  const envUrl = typeof import.meta !== 'undefined' && import.meta.env ? (import.meta.env.VITE_APP_URL as string) : '';
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  const base = envUrl || origin || 'https://puntoencuentro.com.ar';
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

export function buildGeneralInvitationUrl(publicToken: unknown, dateMode?: 'fixed' | 'coordination' | null): string | null {
  if (!isValidPublicToken(publicToken)) return null;
  const cleanBaseUrl = getBaseAppUrl();
  const basePath = dateMode === 'coordination' ? '/coordination/join/' : '/join/';
  return `${cleanBaseUrl}${basePath}${encodeURIComponent(publicToken.trim())}`;
}

/**
 * Enlace público canónico de difusión de Encuentros Abiertos (/e/:uuid).
 */
export function buildOpenEncounterUrl(encounterId: string): string {
  const cleanBaseUrl = getBaseAppUrl();
  return `${cleanBaseUrl}/e/${encodeURIComponent(encounterId.trim())}`;
}

/**
 * Enlace de compatibilidad profunda con query param (/?open_encounter=:uuid).
 */
export function buildOpenEncounterQueryUrl(encounterId: string): string {
  const cleanBaseUrl = getBaseAppUrl();
  return `${cleanBaseUrl}/?open_encounter=${encodeURIComponent(encounterId.trim())}`;
}

export interface OpenEncounterShareData {
  id: string;
  title: string;
  dateLabel?: string;
  approximateZone?: string;
  description?: string;
}

/**
 * Genera el texto formateado para difusión social de un encuentro abierto.
 * Proyecta estrictamente información pública autorizada; jamás datos logísticos privados.
 */
export function buildOpenEncounterShareText(
  data: OpenEncounterShareData,
  urlOverride?: string
): string {
  const url = urlOverride || buildOpenEncounterUrl(data.id);
  const title = (data.title || 'Encuentro en PuntoEncuentro').trim();

  const details: string[] = [];
  if (data.approximateZone && data.approximateZone.trim()) {
    details.push(data.approximateZone.trim());
  }
  if (data.dateLabel && data.dateLabel.trim()) {
    details.push(data.dateLabel.trim());
  }
  const detailsLine = details.join(' · ');

  const desc = data.description ? data.description.trim() : '';

  const parts = [
    '¡Tenemos un encuentro abierto!',
    '',
    title,
  ];

  if (detailsLine) {
    parts.push(detailsLine);
  }

  if (desc) {
    parts.push('', desc);
  }

  parts.push(
    '',
    '¿Te gustaría sumarte? Conocé la propuesta y solicitá participar:',
    url
  );

  return parts.join('\n');
}

/**
 * Genera el enlace de apertura directa para WhatsApp Web / App con texto preparado.
 */
export function buildWhatsAppShareUrl(text: string): string {
  return `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
}
