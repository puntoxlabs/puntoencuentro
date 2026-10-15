/**
 * Detector determinista y liviano de idiomas para Moderación v1.1
 * Idiomas soportados: ES / EN / PT / PT-BR
 *
 * Principio:
 * - Textos cortos (< 6 palabras significativas) o nombres propios: NUNCA producen falso positivo (se consideran soportados/neutros).
 * - Textos largos claramente en francés, alemán, italiano, ruso, etc.: retornan REVIEW si la confianza es alta.
 * - NUNCA bloquea por idioma.
 */

// Stopwords en Español
const ES_STOPWORDS = new Set([
  'de', 'la', 'el', 'en', 'y', 'que', 'los', 'se', 'del', 'las', 'por', 'un',
  'para', 'con', 'no', 'una', 'su', 'al', 'lo', 'como', 'mas', 'pero', 'sus',
  'le', 'ya', 'este', 'si', 'porque', 'esta', 'son', 'entre', 'cuando', 'muy',
  'sin', 'sobre', 'tambien', 'me', 'hasta', 'hay', 'donde', 'quien', 'desde',
  'todo', 'nos', 'durante', 'todos', 'uno', 'les', 'ni', 'contra', 'otros',
  'ese', 'eso', 'ante', 'ellos', 'esto', 'mi', 'antes', 'algunos', 'unos', 'yo',
  'otro', 'otras', 'otra', 'tanto', 'esa', 'estos', 'mucho', 'nada', 'cual',
  'vamos', 'hacer', 'juntada', 'plaza', 'parque', 'cafe', 'salida', 'juegos',
  'amigos', 'tarde', 'noche', 'charlar', 'mate', 'merendar', 'compartir'
]);

// Stopwords en Inglés
const EN_STOPWORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his',
  'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my',
  'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if',
  'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like',
  'time', 'no', 'just', 'him', 'know', 'take', 'people', 'into', 'year', 'your',
  'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'look',
  'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two',
  'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because',
  'any', 'these', 'give', 'day', 'most', 'us', 'meet', 'coffee', 'games', 'park'
]);

// Stopwords en Portugués
const PT_STOPWORDS = new Set([
  'de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com', 'nao',
  'uma', 'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'mas',
  'foi', 'ao', 'ele', 'das', 'tem', 'seu', 'sua', 'ou', 'ser', 'quando',
  'muito', 'ha', 'nos', 'ja', 'esta', 'eu', 'tambem', 'so', 'pelo', 'pela',
  'ate', 'isso', 'ela', 'entre', 'era', 'depois', 'sem', 'mesmo', 'aos',
  'ter', 'seus', 'quem', 'nas', 'me', 'esse', 'eles', 'estao', 'voce',
  'tinha', 'foram', 'essa', 'num', 'nem', 'suas', 'meu', 'minha', 'vamos',
  'encontro', 'fazer', 'jogos', 'parque', 'conversa', 'amigos'
]);

// Stopwords marcadoras de otros idiomas no soportados (Francés, Alemán, Italiano)
const FR_STOPWORDS = new Set([
  'le', 'la', 'des', 'du', 'avec', 'pour', 'dans', 'sur', 'est', 'une', 'nous',
  'vous', 'ils', 'elles', 'mais', 'donc', 'or', 'car', 'cette', 'cet', 'ces',
  'sont', 'faire', 'apres', 'meme', 'aussi', 'bien', 'peut', 'tout', 'tous',
  'rencontre', 'rendez', 'vous', 'parler', 'ensemble'
]);

const DE_STOPWORDS = new Set([
  'der', 'die', 'das', 'und', 'in', 'zu', 'den', 'mit', 'auf', 'fur', 'von',
  'im', 'des', 'ist', 'eine', 'nicht', 'ein', 'dem', 'sich', 'sie', 'als',
  'auch', 'nach', 'wie', 'an', 'so', 'bei', 'treffen', 'zusammen', 'heute',
  'abend', 'wir', 'machen'
]);

const IT_STOPWORDS = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'da', 'in', 'con', 'su', 'per',
  'tra', 'fra', 'questo', 'questa', 'sono', 'essere', 'avere', 'anche',
  'ci', 'vi', 'incontro', 'fare', 'insieme', 'amici', 'stasera'
]);

export interface LanguageDetectionResult {
  isSupported: boolean;
  detectedLanguage: 'es' | 'en' | 'pt' | 'other' | 'neutral_short';
  confidence: number;
}

/**
 * Evalúa si el texto está en uno de los idiomas soportados (ES, EN, PT).
 * Diseñado con protección estricta contra falsos positivos en nombres propios y frases cortas.
 */
export function detectSupportedLanguage(text: string): LanguageDetectionResult {
  if (!text) {
    return { isSupported: true, detectedLanguage: 'neutral_short', confidence: 0 };
  }

  // Normalizar: sin diacríticos, minúsculas, solo palabras
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\s]/gu, ' ')
    .trim();

  const words = normalized.split(/\s+/).filter((w) => w.length >= 2);

  // 1. Textos cortos o pocas palabras: proteger nombres de actividades o frases breves
  // ej. "Tech Meetup After Office", "Workshop Rust", "Pizza & Beer", "Running 5k"
  if (words.length < 6) {
    return { isSupported: true, detectedLanguage: 'neutral_short', confidence: 0.1 };
  }

  // 2. Detección de alfabetos no latinos dominantes (Cirílico, Árabe, Chino/Japonés)
  const nonLatinMatches = text.match(/[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u30FF]/g);
  if (nonLatinMatches && nonLatinMatches.length > 10 && nonLatinMatches.length / text.length > 0.3) {
    return { isSupported: false, detectedLanguage: 'other', confidence: 0.95 };
  }

  // 3. Conteo de stopwords por idioma
  let esScore = 0;
  let enScore = 0;
  let ptScore = 0;
  let frScore = 0;
  let deScore = 0;
  let itScore = 0;

  for (const word of words) {
    if (ES_STOPWORDS.has(word)) esScore++;
    if (EN_STOPWORDS.has(word)) enScore++;
    if (PT_STOPWORDS.has(word)) ptScore++;
    if (FR_STOPWORDS.has(word)) frScore++;
    if (DE_STOPWORDS.has(word)) deScore++;
    if (IT_STOPWORDS.has(word)) itScore++;
  }

  const supportedMax = Math.max(esScore, enScore, ptScore);
  const unsupportedMax = Math.max(frScore, deScore, itScore);

  // Si hay suficiente presencia de stopwords de idiomas soportados, es válido
  if (supportedMax >= 2 && supportedMax >= unsupportedMax) {
    const lang = esScore >= enScore && esScore >= ptScore ? 'es' : enScore >= ptScore ? 'en' : 'pt';
    return { isSupported: true, detectedLanguage: lang, confidence: 0.85 };
  }

  // Si no hay casi stopwords de ningún tipo (ej. lista de nombres o términos técnicos),
  // no asumir que es idioma extraño: tolerar y no bloquear
  if (unsupportedMax < 3) {
    return { isSupported: true, detectedLanguage: 'neutral_short', confidence: 0.2 };
  }

  // Si unsupportedMax tiene al menos 3 stopwords claras y supera significativamente al supported
  if (unsupportedMax >= 3 && unsupportedMax > supportedMax * 2) {
    return {
      isSupported: false,
      detectedLanguage: 'other',
      confidence: Math.min(0.9, 0.6 + unsupportedMax * 0.05),
    };
  }

  return { isSupported: true, detectedLanguage: 'es', confidence: 0.5 };
}
