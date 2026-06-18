const PARTICIPATED_TOKENS_KEY = 'participated_tokens';

// Obtener todos los tokens de invitaciones individuales guardados localmente
export function getParticipatedIndividualTokens(): string[] {
  try {
    const raw = localStorage.getItem(PARTICIPATED_TOKENS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string' && t.length > 0) : [];
  } catch { return []; }
}

// Guardar un token de invitación individual (si no existe ya)
export function saveParticipatedToken(token: string): void {
  if (!token) return;
  try {
    const existing = getParticipatedIndividualTokens();
    if (!existing.includes(token)) {
      localStorage.setItem(PARTICIPATED_TOKENS_KEY, JSON.stringify([...existing, token]));
    }
  } catch { /* silencioso */ }
}

// Obtener todos los tokens de link general desde localStorage['encuentros_general']
export function getGeneralParticipatedTokens(): string[] {
  try {
    const raw = localStorage.getItem('encuentros_general');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const encuentros = parsed?.encuentros || {};
    return Object.values(encuentros)
      .map((e: any) => e?.token_invitacion)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
  } catch { return []; }
}

// Combinar todos los tokens (individual + general) para llamar la RPC
export function getAllParticipatedTokens(): string[] {
  const individual = getParticipatedIndividualTokens();
  const general = getGeneralParticipatedTokens();
  const all = [...new Set([...individual, ...general])];
  return all;
}
