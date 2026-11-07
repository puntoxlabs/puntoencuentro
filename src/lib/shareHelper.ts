import {
  buildPublicAppUrl,
  getBrandConfig,
  getCanonicalAppOrigin,
  type EnvSource,
} from '../config/domainConfig.js';

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

/**
 * Retorna el origen canónico público sin barra final.
 * Delega en la configuración centralizada de dominio para garantizar que enlaces nuevos
 * nunca hereden dominios legados ni barras dobles.
 */
export function getBaseAppUrl(envOverride?: EnvSource): string {
  return getCanonicalAppOrigin(envOverride);
}

/**
 * Enlace de invitación grupal general (/join/:public_token o /coordination/join/:token).
 */
export function buildGeneralInvitationUrl(
  publicToken: unknown,
  dateMode?: 'fixed' | 'coordination' | null,
  envOverride?: EnvSource
): string | null {
  if (!isValidPublicToken(publicToken)) return null;
  const basePath = dateMode === 'coordination' ? '/coordination/join/' : '/join/';
  return buildPublicAppUrl(`${basePath}${encodeURIComponent(publicToken.trim())}`, {
    env: envOverride,
  });
}

/**
 * Enlace de invitación individual (/invite/:token o /coordination/invite/:token).
 */
export function buildIndividualInvitationUrl(
  token: unknown,
  dateMode?: 'fixed' | 'coordination' | null,
  envOverride?: EnvSource
): string | null {
  if (!isValidPublicToken(token)) return null;
  const basePath = dateMode === 'coordination' ? '/coordination/invite/' : '/invite/';
  return buildPublicAppUrl(`${basePath}${encodeURIComponent(token.trim())}`, {
    env: envOverride,
  });
}

/**
 * Enlace de administración del anfitrión (/meet/:id).
 */
export function buildHostEncounterUrl(encounterId: unknown, envOverride?: EnvSource): string | null {
  if (!isValidPublicToken(encounterId)) return null;
  return buildPublicAppUrl(`/meet/${encodeURIComponent(encounterId.trim())}`, {
    env: envOverride,
  });
}

/**
 * Enlace público canónico de difusión de Encuentros Abiertos (/e/:uuid).
 */
export function buildOpenEncounterUrl(encounterId: string, envOverride?: EnvSource): string {
  return buildPublicAppUrl(`/e/${encodeURIComponent(encounterId.trim())}`, {
    env: envOverride,
  });
}

/**
 * Enlace de compatibilidad profunda con query param (/?open_encounter=:uuid).
 */
export function buildOpenEncounterQueryUrl(encounterId: string, envOverride?: EnvSource): string {
  return buildPublicAppUrl(`/?open_encounter=${encodeURIComponent(encounterId.trim())}`, {
    env: envOverride,
  });
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
  const brand = getBrandConfig();
  const url = urlOverride || buildOpenEncounterUrl(data.id);
  const title = (data.title || brand.openEncounterFallbackTitle).trim();

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
