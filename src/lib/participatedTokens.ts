const PARTICIPATED_TOKENS_KEY = 'participated_tokens';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuidToken(val: unknown): val is string {
  return typeof val === 'string' && UUID_REGEX.test(val.trim());
}

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

/**
 * Obtener todos los tokens de invitaciones individuales guardados localmente
 */
export function getParticipatedIndividualTokens(): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem(PARTICIPATED_TOKENS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isValidUuidToken).map(normalizeToken)
      : [];
  } catch {
    return [];
  }
}

/**
 * Guardar un token de invitación individual (si no existe ya)
 */
export function saveParticipatedToken(token: string): void {
  if (!isValidUuidToken(token) || typeof window === 'undefined' || !window.localStorage) return;
  try {
    const normalized = normalizeToken(token);
    const existing = getParticipatedIndividualTokens();
    if (!existing.includes(normalized)) {
      localStorage.setItem(PARTICIPATED_TOKENS_KEY, JSON.stringify([...existing, normalized]));
    }
  } catch {
    /* silencioso */
  }
}

/**
 * Obtener todos los tokens de link general desde localStorage['encuentros_general']
 */
export function getGeneralParticipatedTokens(): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem('encuentros_general');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const encuentros = parsed?.encuentros || {};
    return Object.values(encuentros)
      .map((e: any) => e?.token_invitacion)
      .filter(isValidUuidToken)
      .map(normalizeToken);
  } catch {
    return [];
  }
}

/**
 * Obtener todos los tokens de link general de coordinación desde localStorage['encuentros_coordination_general']
 */
export function getCoordinationGeneralParticipatedTokens(): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem('encuentros_coordination_general');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const encuentros = parsed?.encuentros || {};
    return Object.values(encuentros)
      .map((e: any) => e?.token_invitacion)
      .filter(isValidUuidToken)
      .map(normalizeToken);
  } catch {
    return [];
  }
}

/**
 * Recolector unificado y exhaustivo de tokens de invitación y participación locales.
 *
 * Reúne y deduplica tokens válidos desde 6 fuentes locales:
 * 1. localStorage['participated_tokens'] (invitaciones individuales fecha fija)
 * 2. localStorage['puntoencuentro_guest_token_by_public_*'] (tokens de link general de fecha fija)
 * 3. localStorage['puntoencuentro_coordination_guest_token_by_public_*'] (tokens de link general de coordinación)
 * 4. localStorage['encuentros_general'] (mapa histórico de links generales)
 * 5. localStorage['encuentros_coordination_general'] (mapa histórico de links generales de coordinación)
 * 6. sessionStorage['pending_participant_invitation_token'] (última invitación activa en la pestaña)
 *
 * Invariante: Cero pérdida de participaciones de invitados anónimos o no registrados.
 */
export function collectAllLocalInvitationTokens(): string[] {
  const tokenSet = new Set<string>();

  // 1. Invitaciones individuales fecha fija
  for (const token of getParticipatedIndividualTokens()) {
    tokenSet.add(token);
  }

  // 2. Mapa histórico encuentros_general
  for (const token of getGeneralParticipatedTokens()) {
    tokenSet.add(token);
  }

  // 3. Mapa histórico encuentros_coordination_general
  for (const token of getCoordinationGeneralParticipatedTokens()) {
    tokenSet.add(token);
  }

  // 4 & 5. Claves con prefijo puntoencuentro_guest_token_by_public_ y puntoencuentro_coordination_guest_token_by_public_
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const fixedPrefix = 'puntoencuentro_guest_token_by_public_';
      const coordPrefix = 'puntoencuentro_coordination_guest_token_by_public_';

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;

        if (key.startsWith(fixedPrefix) || key.startsWith(coordPrefix)) {
          const val = localStorage.getItem(key);
          if (isValidUuidToken(val)) {
            tokenSet.add(normalizeToken(val));
          }
        }
      }
    } catch {
      /* fail-open */
    }
  }

  // 6. sessionStorage['pending_participant_invitation_token']
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const sessionToken = sessionStorage.getItem('pending_participant_invitation_token');
      if (isValidUuidToken(sessionToken)) {
        tokenSet.add(normalizeToken(sessionToken));
      }
    } catch {
      /* fail-open */
    }
  }

  return Array.from(tokenSet);
}

/**
 * Combinar todos los tokens para consultar la RPC o migrar hacia otro dominio.
 * Delega en collectAllLocalInvitationTokens() garantizando paridad total de inventario.
 */
export function getAllParticipatedTokens(): string[] {
  return collectAllLocalInvitationTokens();
}
