/**
 * Normalización Unicode y sanitización heurística para Moderación v1.1
 */

// Caracteres invisibles comunes y de control
const INVISIBLE_CHARS_REGEX = /[\u200B-\u200D\uFEFF\u00AD\u2060\u200E\u200F\u202A-\u202E]/g;

// Mapa de homógrafos / leetspeak comunes hacia ASCII estándar
const HOMOGLYPHS_MAP: Record<string, string> = {
  // Cirílico lookalikes
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'А': 'A', 'Е': 'E', 'О': 'O', 'Р': 'P', 'С': 'C', 'У': 'Y', 'Х': 'X',
  // Griego lookalikes
  'α': 'a', 'ο': 'o', 'ρ': 'p',
  // Leetspeak común
  '@': 'a', '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '$': 's',
};

/**
 * Normaliza Unicode mediante NFKC y remueve caracteres invisibles/zero-width.
 */
export function normalizeUnicode(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFKC')
    .replace(INVISIBLE_CHARS_REGEX, '')
    .trim();
}

/**
 * Cuenta cuántos caracteres invisibles o de control de formato había en el texto.
 */
export function countInvisibleChars(text: string): number {
  if (!text) return 0;
  const matches = text.match(INVISIBLE_CHARS_REGEX);
  return matches ? matches.length : 0;
}

/**
 * Reemplaza homógrafos conocidos y leetspeak básico para análisis de patrones.
 */
export function replaceHomoglyphs(text: string): string {
  if (!text) return '';
  let result = '';
  for (const char of text) {
    result += HOMOGLYPHS_MAP[char] || char;
  }
  return result;
}

/**
 * Detecta y colapsa palabras espaciadas artificialmente (ej. "s p a m" -> "spam", "w h a t s a p p" -> "whatsapp").
 */
export function collapseArtificialSpaces(text: string): string {
  if (!text) return '';
  // Encuentra secuencias de 3 o más letras individuales separadas por espacios: e.g. "s p a m"
  return text.replace(/\b(?:[a-zA-Z0-9]\s+){2,}[a-zA-Z0-9]\b/g, (match) => {
    return match.replace(/\s+/g, '');
  });
}

/**
 * Genera una representación canónica simplificada para comparación de similitud / duplicados.
 * Minúsculas, sin puntuación, espacios simples.
 */
export function canonicalizeForComparison(text: string): string {
  if (!text) return '';
  const clean = normalizeUnicode(text).toLowerCase();
  // Remover acentos básicos y caracteres especiales, mantener letras y números
  const normalized = clean
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quita diacríticos
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized;
}

/**
 * Calcula el ratio de puntuación/símbolos respecto a la longitud total.
 */
export function calculateSymbolRatio(text: string): { ratio: number; symbolCount: number; letterCount: number } {
  if (!text || text.length === 0) return { ratio: 0, symbolCount: 0, letterCount: 0 };
  const clean = normalizeUnicode(text);
  const letters = clean.match(/[\p{L}\p{N}]/gu) || [];
  const symbols = clean.match(/[^\p{L}\p{N}\s]/gu) || [];
  const total = clean.replace(/\s+/g, '').length;
  if (total === 0) return { ratio: 0, symbolCount: 0, letterCount: 0 };
  return {
    ratio: symbols.length / total,
    symbolCount: symbols.length,
    letterCount: letters.length,
  };
}
