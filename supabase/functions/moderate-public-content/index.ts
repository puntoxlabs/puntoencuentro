// Supabase Edge Function: moderate-public-content
// Moderación v1.1 — Calidad pública + Anti-Spam Gate
// Clasificador determinista y reglas de seguridad para contenido público.
// Desacoplado de ai-interpret y del flujo de creación de encuentros.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: {
  env: {
    get: (key: string) => string | undefined;
  };
  serve: (handler: (req: Request) => Promise<Response>) => void;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export interface ModerateContentRequest {
  encounter_id: string;
}

export type ModerationDecision = "allow" | "review" | "block";

export type ModerationReasonCode =
  | "clean_social_meetup"
  | "unsupported_language"
  | "gibberish"
  | "excessive_symbols"
  | "external_contact"
  | "obfuscated_contact"
  | "commercial_spam"
  | "duplicate_content"
  | "suspicious_url"
  | "possible_scam"
  | "low_information_content"
  | "malicious_payload"
  | "violence_threat"
  | "illegal_activity"
  | "contains_link"
  | "contains_personal_contact_data"
  | "sensitive_terms_ambiguous"
  | "title_too_short"
  | "moderation_unavailable";

export interface ModerateContentResult {
  decision: ModerationDecision;
  categories: string[];
  confidence: number;
  reason_code: ModerationReasonCode;
  explanation_for_moderator?: string;
  user_friendly_message?: string;
}

// ------------------------------------------------------------------------------
// Sanitización y normalización Unicode
// ------------------------------------------------------------------------------
const INVISIBLE_CHARS_REGEX = /[\u200B-\u200D\uFEFF\u00AD\u2060\u200E\u200F\u202A-\u202E]/g;

const HOMOGLYPHS_MAP: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x",
  А: "A", Е: "E", О: "O", Р: "P", С: "C", У: "Y", Х: "X",
  α: "a", ο: "o", ρ: "p",
  "@": "a", "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "$": "s",
};

function normalizeUnicodeText(text: string): string {
  if (!text) return "";
  return text.normalize("NFKC").replace(INVISIBLE_CHARS_REGEX, "").trim();
}

function countInvisibleCharacters(text: string): number {
  if (!text) return 0;
  const matches = text.match(INVISIBLE_CHARS_REGEX);
  return matches ? matches.length : 0;
}

function replaceHomoglyphCharacters(text: string): string {
  if (!text) return "";
  let result = "";
  for (const char of text) {
    result += HOMOGLYPHS_MAP[char] || char;
  }
  return result;
}

function collapseSpacedLetters(text: string): string {
  if (!text) return "";
  return text.replace(/\b(?:[a-zA-Z0-9]\s+){2,}[a-zA-Z0-9]\b/g, (match) => match.replace(/\s+/g, ""));
}

function canonicalForCompare(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function calculateSymbolStats(text: string): { ratio: number; symbolCount: number } {
  if (!text) return { ratio: 0, symbolCount: 0 };
  const clean = normalizeUnicodeText(text);
  const symbols = clean.match(/[^\p{L}\p{N}\s]/gu) || [];
  const total = clean.replace(/\s+/g, "").length;
  if (total === 0) return { ratio: 0, symbolCount: 0 };
  return { ratio: symbols.length / total, symbolCount: symbols.length };
}

// ------------------------------------------------------------------------------
// Detección de idioma (ES, EN, PT soportados; otros -> REVIEW)
// ------------------------------------------------------------------------------
const ES_WORDS = new Set([
  "de", "la", "el", "en", "y", "que", "los", "se", "del", "las", "por", "un",
  "para", "con", "no", "una", "su", "al", "lo", "como", "mas", "pero", "sus",
  "le", "ya", "este", "si", "porque", "esta", "son", "entre", "cuando", "muy",
  "sin", "sobre", "tambien", "me", "hasta", "hay", "donde", "quien", "desde",
  "todo", "nos", "durante", "todos", "uno", "les", "ni", "contra", "otros",
  "ese", "eso", "ante", "ellos", "esto", "mi", "antes", "algunos", "unos", "yo",
  "vamos", "hacer", "juntada", "plaza", "parque", "cafe", "salida", "juegos",
  "amigos", "tarde", "noche", "charlar", "mate", "merendar", "compartir"
]);

const EN_WORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it", "for",
  "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his",
  "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my",
  "one", "all", "would", "there", "their", "what", "so", "up", "out", "if",
  "about", "who", "get", "which", "go", "me", "when", "make", "can", "like",
  "time", "no", "just", "him", "know", "take", "people", "into", "year", "your",
  "meet", "coffee", "games", "park"
]);

const PT_WORDS = new Set([
  "de", "a", "o", "que", "e", "do", "da", "em", "um", "para", "com", "nao",
  "uma", "os", "no", "se", "na", "por", "mais", "as", "dos", "como", "mas",
  "foi", "ao", "ele", "das", "tem", "seu", "sua", "ou", "ser", "quando",
  "muito", "ha", "nos", "ja", "esta", "eu", "tambem", "so", "pelo", "pela",
  "vamos", "encontro", "fazer", "jogos", "parque", "conversa", "amigos"
]);

const FR_WORDS = new Set([
  "le", "la", "des", "du", "avec", "pour", "dans", "sur", "est", "une", "nous",
  "vous", "ils", "elles", "mais", "donc", "cette", "sont", "rencontre", "ensemble"
]);

const DE_WORDS = new Set([
  "der", "die", "das", "und", "in", "zu", "den", "mit", "auf", "fur", "von",
  "im", "ist", "eine", "nicht", "ein", "dem", "sich", "treffen", "zusammen"
]);

const IT_WORDS = new Set([
  "il", "lo", "la", "i", "gli", "le", "di", "da", "in", "con", "su", "per",
  "tra", "fra", "questo", "questa", "sono", "incontro", "insieme", "amici"
]);

function evaluateLanguage(text: string): { isSupported: boolean; detectedLanguage: string; confidence: number } {
  if (!text) return { isSupported: true, detectedLanguage: "neutral_short", confidence: 0 };
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\s]/gu, " ")
    .trim();

  const words = normalized.split(/\s+/).filter((w) => w.length >= 2);
  // Proteger nombres propios y frases cortas (ej. "After Office Tech", "Meetup Rust")
  if (words.length < 6) {
    return { isSupported: true, detectedLanguage: "neutral_short", confidence: 0.1 };
  }

  // Detección de alfabetos no latinos dominantes
  const nonLatinMatches = text.match(/[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u30FF]/g);
  if (nonLatinMatches && nonLatinMatches.length > 10 && nonLatinMatches.length / text.length > 0.3) {
    return { isSupported: false, detectedLanguage: "other", confidence: 0.95 };
  }

  let esCount = 0;
  let enCount = 0;
  let ptCount = 0;
  let frCount = 0;
  let deCount = 0;
  let itCount = 0;

  for (const w of words) {
    if (ES_WORDS.has(w)) esCount++;
    if (EN_WORDS.has(w)) enCount++;
    if (PT_WORDS.has(w)) ptCount++;
    if (FR_WORDS.has(w)) frCount++;
    if (DE_WORDS.has(w)) deCount++;
    if (IT_WORDS.has(w)) itCount++;
  }

  const supportedMax = Math.max(esCount, enCount, ptCount);
  const unsupportedMax = Math.max(frCount, deCount, itCount);

  if (supportedMax >= 2 && supportedMax >= unsupportedMax) {
    const lang = esCount >= enCount && esCount >= ptCount ? "es" : enCount >= ptCount ? "en" : "pt";
    return { isSupported: true, detectedLanguage: lang, confidence: 0.85 };
  }

  if (unsupportedMax < 3) {
    return { isSupported: true, detectedLanguage: "neutral_short", confidence: 0.2 };
  }

  if (unsupportedMax >= 3 && unsupportedMax > supportedMax * 2) {
    return {
      isSupported: false,
      detectedLanguage: "other",
      confidence: Math.min(0.9, 0.6 + unsupportedMax * 0.05),
    };
  }

  return { isSupported: true, detectedLanguage: "es", confidence: 0.5 };
}

// ------------------------------------------------------------------------------
// Detección de duplicados entre publicaciones del mismo host en 24h
// ------------------------------------------------------------------------------
function checkDuplicates(
  candidateTitle: string,
  candidateDesc: string,
  previousEncounters: any[],
  candidateContext?: { fecha?: string | null; hora?: string | null; zona?: string | null; created_at?: string | null }
): {
  isDuplicate: boolean;
  similarity: number;
  isExactMatch: boolean;
  decision: "allow" | "review" | "block";
  reason_code?: string;
  explanation?: string;
  user_friendly_message?: string;
} {
  if (!previousEncounters || previousEncounters.length === 0) {
    return { isDuplicate: false, similarity: 0, isExactMatch: false, decision: "allow" };
  }

  const candNorm = canonicalForCompare(`${candidateTitle} ${candidateDesc || ""}`);
  const candWords = candNorm.split(/\s+/).filter(Boolean);
  const candSet = new Set(candWords);

  const candFecha = candidateContext?.fecha ? candidateContext.fecha.trim() : null;
  const candHora = candidateContext?.hora ? candidateContext.hora.trim().slice(0, 5) : null;
  const candZona = (candidateContext?.zona || "").trim().toLowerCase();
  const candCreatedAt = candidateContext?.created_at ? new Date(candidateContext.created_at).getTime() : Date.now();

  let maxSim = 0;
  const matchingItems: { prev: any; sim: number; isExact: boolean }[] = [];

  for (const prev of previousEncounters) {
    const prevTitle = (prev.open_public_title || prev.title || "").trim();
    const prevDesc = (prev.open_description || prev.description || "").trim();
    const prevNorm = canonicalForCompare(`${prevTitle} ${prevDesc}`);

    let sim = 0;
    let isExact = false;

    if (candNorm === prevNorm && candNorm.length > 5) {
      sim = 1.0;
      isExact = true;
    } else {
      const prevWords = prevNorm.split(/\s+/).filter(Boolean);
      const prevSet = new Set(prevWords);

      let inter = 0;
      for (const w of candSet) {
        if (prevSet.has(w)) inter++;
      }
      const union = candSet.size + prevSet.size - inter;
      sim = union > 0 ? inter / union : 0;
    }

    if (sim > maxSim) {
      maxSim = sim;
    }

    if (sim >= 0.85) {
      matchingItems.push({ prev, sim, isExact });
    }
  }

  if (matchingItems.length === 0) {
    return { isDuplicate: false, similarity: maxSim, isExactMatch: false, decision: "allow" };
  }

  // 1. Clon exacto de slot (mismo contenido + misma fecha + misma hora + misma zona)
  const exactSlotMatch = matchingItems.find(({ prev }) => {
    const prevFecha = prev.fecha ? prev.fecha.trim() : null;
    const prevHora = prev.hora ? prev.hora.trim().slice(0, 5) : null;
    const prevZona = (prev.open_public_zone || prev.locality_id || prev.zona || "").trim().toLowerCase();

    const sameFecha = Boolean(candFecha && prevFecha && candFecha === prevFecha);
    const sameHora = Boolean(candHora && prevHora && candHora === prevHora);
    const sameZona = Boolean(candZona === prevZona || (!candZona && !prevZona));

    return sameFecha && sameHora && sameZona;
  });

  if (exactSlotMatch) {
    return {
      isDuplicate: true,
      similarity: exactSlotMatch.sim,
      isExactMatch: exactSlotMatch.isExact,
      decision: "block",
      reason_code: "duplicate_content",
      explanation: "Mismo contenido público duplicado para la misma fecha, horario y zona exacta.",
      user_friendly_message: "Ya existe una publicación activa para este mismo horario y lugar.",
    };
  }

  // 2. Ráfaga de spam masivo
  if (matchingItems.length >= 3) {
    return {
      isDuplicate: true,
      similarity: maxSim,
      isExactMatch: false,
      decision: "block",
      reason_code: "duplicate_content_burst",
      explanation: `Volumen anormal de publicaciones casi idénticas (${matchingItems.length + 1} publicaciones en 24h).`,
      user_friendly_message: "Se detectaron múltiples publicaciones similares en un lapso breve. Por favor esperá antes de publicar nuevamente.",
    };
  }

  if (matchingItems.length >= 2) {
    const hasBurstTiming = matchingItems.some(({ prev }) => {
      const prevDateStr = prev.creado_en || prev.created_at;
      if (!prevDateStr) return false;
      const prevTime = new Date(prevDateStr).getTime();
      return Math.abs(candCreatedAt - prevTime) <= 10 * 60 * 1000;
    });

    if (hasBurstTiming) {
      return {
        isDuplicate: true,
        similarity: maxSim,
        isExactMatch: false,
        decision: "block",
        reason_code: "duplicate_content_burst",
        explanation: `Ráfaga de publicaciones similares detectada en un intervalo corto (${matchingItems.length + 1} publicaciones creadas en pocos minutos).`,
        user_friendly_message: "Se detectaron múltiples publicaciones similares en un lapso muy breve. Por favor esperá antes de publicar nuevamente.",
      };
    }
  }

  // 3. Encuentros legítimos diferenciados (recurrente semanal, días distintos, horas distintas, zonas distintas)
  const allDifferentiated = matchingItems.every(({ prev }) => {
    const prevFecha = prev.fecha ? prev.fecha.trim() : null;
    const prevHora = prev.hora ? prev.hora.trim().slice(0, 5) : null;
    const prevZona = (prev.open_public_zone || prev.locality_id || prev.zona || "").trim().toLowerCase();

    const diffFecha = Boolean(candFecha && prevFecha && candFecha !== prevFecha);
    const diffHora = Boolean(candHora && prevHora && candHora !== prevHora);
    const diffZona = Boolean(candZona && prevZona && candZona !== prevZona);

    return diffFecha || diffHora || diffZona;
  });

  if (allDifferentiated) {
    return {
      isDuplicate: false,
      similarity: maxSim,
      isExactMatch: false,
      decision: "allow",
      explanation: "Contenido similar pero con fecha, horario o zona diferenciada legítima (encuentro recurrente).",
    };
  }

  // 4. Ambigüedad -> REVIEW (Nunca BLOCK por texto solo)
  return {
    isDuplicate: true,
    similarity: maxSim,
    isExactMatch: false,
    decision: "review",
    reason_code: "duplicate_content",
    explanation: `Publicación con alta similitud (${Math.round(maxSim * 100)}%) respecto a otra reciente del mismo anfitrión. Requiere verificación humana.`,
    user_friendly_message: "Estamos revisando esta publicación antes de mostrarla públicamente.",
  };
}

// ------------------------------------------------------------------------------
// Función de evaluación determinista multicapa
// ------------------------------------------------------------------------------
function evaluatePublicQualityGate(
  title: string,
  description: string,
  previousEncounters: any[] = [],
  candidateContext?: { fecha?: string | null; hora?: string | null; zona?: string | null; created_at?: string | null }
): ModerateContentResult {
  const cleanTitle = (title || "").trim();
  const cleanDesc = (description || "").trim();

  // 1. Longitud básica
  if (cleanTitle.length < 3) {
    return {
      decision: "block",
      categories: ["garbage"],
      confidence: 1.0,
      reason_code: "title_too_short",
      explanation_for_moderator: "Título con menos de 3 caracteres.",
      user_friendly_message: "El título debe tener al menos 3 caracteres.",
    };
  }

  // 2. Normalización Unicode y conteo de invisibles
  const normTitle = normalizeUnicodeText(cleanTitle);
  const normDesc = normalizeUnicodeText(cleanDesc);
  const combined = (normTitle + " " + normDesc).trim();

  const invisibleCount = countInvisibleCharacters(cleanTitle) + countInvisibleCharacters(cleanDesc);
  if (invisibleCount > 4) {
    return {
      decision: "block",
      categories: ["garbage", "obfuscation"],
      confidence: 0.95,
      reason_code: "obfuscated_contact",
      explanation_for_moderator: `Se detectaron ${invisibleCount} caracteres invisibles/zero-width.`,
      user_friendly_message: "La publicación contiene caracteres no permitidos.",
    };
  }

  const textLower = combined.toLowerCase();
  const collapsed = collapseSpacedLetters(textLower);
  const dehomoglyphed = replaceHomoglyphCharacters(collapsed);

  // 3. Payloads maliciosos
  if (/<\s*script|javascript\s*:|data\s*:\s*text\/html|<\s*iframe|<\s*object|<\s*embed|<\s*svg/i.test(combined)) {
    return {
      decision: "block",
      categories: ["malicious_payload"],
      confidence: 1.0,
      reason_code: "malicious_payload",
      explanation_for_moderator: "Contiene script HTML o payload malicioso.",
      user_friendly_message: "El contenido no cumple las normas de seguridad comunitaria.",
    };
  }

  // 4. Amenazas y violencia
  if (/(te voy a matar|los voy a matar|amenaza de muerte|te voy a reventar|tiroteo|poner una bomba|vamos a golpear|masacre)/i.test(dehomoglyphed)) {
    return {
      decision: "block",
      categories: ["violence_threat"],
      confidence: 1.0,
      reason_code: "violence_threat",
      explanation_for_moderator: "Amenaza explícita de violencia física.",
      user_friendly_message: "El contenido infringe las normas comunitarias.",
    };
  }

  // 5. Actividad ilegal tarifada / estupefacientes
  if (/(vendo coca[ií]na|vendo droga|vendo armas|servicios sexuales tarifados|escort tarifas)/i.test(dehomoglyphed)) {
    return {
      decision: "block",
      categories: ["illegal_activity"],
      confidence: 1.0,
      reason_code: "illegal_activity",
      explanation_for_moderator: "Oferta de sustancias ilícitas, armas o servicios sexuales tarifados.",
      user_friendly_message: "El contenido infringe las normas comunitarias.",
    };
  }

  // 6. Scams / phishing / captación fraudulenta
  if (
    /(ingres[aá] tu contrase[ñn]a|verific[aá] tu cuenta bancaria|actualiz[aá] tus datos bancarios|ganaste un sorteo de|tarjeta de cr[eé]dito gratis|click aqu[ií] para reclamar premio|inversi[oó]n en cripto asegurada|ganancias garantizadas en d[oó]lares|esquema piramidal|forex trading garantizado)/i.test(
      dehomoglyphed
    )
  ) {
    return {
      decision: "block",
      categories: ["fraud_scam"],
      confidence: 0.95,
      reason_code: "possible_scam",
      explanation_for_moderator: "Patrones inequívocos de captación financiera engañosa o phishing.",
      user_friendly_message: "El contenido infringe las pautas contra promociones y estafas.",
    };
  }

  // 7. Basura / Gibberish
  if (/([a-zA-Z0-9])\1{5,}/.test(combined)) {
    return {
      decision: "block",
      categories: ["garbage"],
      confidence: 1.0,
      reason_code: "gibberish",
      explanation_for_moderator: "Repetición masiva de caracteres idénticos.",
      user_friendly_message: "Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.",
    };
  }

  if (/(asdf|qwer|zxcv|1234|lkjh|hjkl){3,}/i.test(combined)) {
    return {
      decision: "block",
      categories: ["garbage"],
      confidence: 1.0,
      reason_code: "gibberish",
      explanation_for_moderator: "Secuencia aleatoria de teclado (keyboard mashing).",
      user_friendly_message: "Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.",
    };
  }

  if (/\b[bcdfghjklmnpqrstvwxyz]{6,}\b/i.test(dehomoglyphed)) {
    return {
      decision: "block",
      categories: ["garbage"],
      confidence: 0.9,
      reason_code: "gibberish",
      explanation_for_moderator: "Palabra con 6 o más consonantes seguidas sin vocales.",
      user_friendly_message: "Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.",
    };
  }

  const words = textLower.split(/\s+/).filter(Boolean);
  if (words.length >= 5) {
    let maxConsecutive = 1;
    let curr = 1;
    for (let i = 1; i < words.length; i++) {
      if (words[i] === words[i - 1]) {
        curr++;
        if (curr > maxConsecutive) maxConsecutive = curr;
      } else {
        curr = 1;
      }
    }
    if (maxConsecutive >= 5) {
      return {
        decision: "block",
        categories: ["garbage"],
        confidence: 0.95,
        reason_code: "gibberish",
        explanation_for_moderator: "Repetición absurda de la misma palabra 5 o más veces consecutivas.",
        user_friendly_message: "Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.",
      };
    }
  }

  // 8. Exceso de símbolos
  if (/([!?#$%&*+=~^_\-]){5,}/.test(combined)) {
    return {
      decision: "block",
      categories: ["excessive_symbols"],
      confidence: 0.95,
      reason_code: "excessive_symbols",
      explanation_for_moderator: "Secuencia reiterada y abusiva de símbolos o signos de puntuación.",
      user_friendly_message: "Por favor evitá el uso excesivo de símbolos y signos en el texto público.",
    };
  }

  const symStats = calculateSymbolStats(combined);
  if (symStats.symbolCount > 8 && symStats.ratio > 0.4) {
    return {
      decision: "block",
      categories: ["excessive_symbols"],
      confidence: 0.9,
      reason_code: "excessive_symbols",
      explanation_for_moderator: `Proporción excesiva de signos no alfanuméricos (${Math.round(symStats.ratio * 100)}%).`,
      user_friendly_message: "Por favor evitá el uso excesivo de símbolos en la publicación.",
    };
  }

  // 9. Contenido vacío o casi vacío (low_information_content)
  const substantive = words.filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  if (cleanDesc.length > 0 && cleanDesc.length < 8 && substantive.length <= 1) {
    return {
      decision: "review",
      categories: ["low_quality"],
      confidence: 0.8,
      reason_code: "low_information_content",
      explanation_for_moderator: "Descripción con muy baja sustancia informativa.",
      user_friendly_message: "Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.",
    };
  }

  // 10. URLs y Enlaces
  const urlMatches = textLower.match(/(https?:\/\/|www\.|bit\.ly|tinyurl\.com|t\.co|wa\.me|t\.me|linktr\.ee|discord\.gg|cutt\.ly)/gi);
  if (urlMatches && urlMatches.length >= 2) {
    return {
      decision: "block",
      categories: ["spam"],
      confidence: 0.95,
      reason_code: "commercial_spam",
      explanation_for_moderator: "Múltiples enlaces o URLs en texto público.",
      user_friendly_message: "No está permitido publicar enlaces múltiples en el contenido público.",
    };
  } else if (urlMatches && urlMatches.length === 1) {
    const singleUrl = urlMatches[0].toLowerCase();
    if (singleUrl.includes("wa.me") || singleUrl.includes("t.me")) {
      return {
        decision: "review",
        categories: ["external_contact"],
        confidence: 0.85,
        reason_code: "external_contact",
        explanation_for_moderator: "Enlace directo de mensajería (WhatsApp/Telegram).",
        user_friendly_message: "Los datos de contacto deben mantenerse privados hasta confirmar asistencia.",
      };
    }
    return {
      decision: "review",
      categories: ["advertising"],
      confidence: 0.8,
      reason_code: "contains_link",
      explanation_for_moderator: "Contiene un enlace externo en texto público.",
      user_friendly_message: "Estamos revisando esta publicación antes de mostrarla públicamente.",
    };
  }

  // 11. Contactos expuestos u ofuscados
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(dehomoglyphed)) {
    return {
      decision: "review",
      categories: ["personal_data"],
      confidence: 0.9,
      reason_code: "external_contact",
      explanation_for_moderator: "Dirección de email en texto público.",
      user_friendly_message: "Los datos de contacto deben mantenerse privados hasta confirmar asistencia.",
    };
  }

  if (/(?:arroba|\(at\)|\[at\])\s*[a-z0-9.-]+\s*(?:punto|\(dot\)|\[dot\]|\.)\s*[a-z]{2,}/i.test(collapsed)) {
    return {
      decision: "review",
      categories: ["personal_data", "obfuscation"],
      confidence: 0.85,
      reason_code: "obfuscated_contact",
      explanation_for_moderator: "Email ofuscado mediante palabras (arroba/punto).",
      user_friendly_message: "Los datos de contacto deben mantenerse privados hasta confirmar asistencia.",
    };
  }

  if (/\b(?:\+?\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/.test(dehomoglyphed)) {
    const digitsOnly = dehomoglyphed.replace(/\D/g, "");
    if (digitsOnly.length >= 8 && digitsOnly.length <= 13) {
      return {
        decision: "review",
        categories: ["personal_data"],
        confidence: 0.85,
        reason_code: "external_contact",
        explanation_for_moderator: "Número telefónico en texto público.",
        user_friendly_message: "Los datos de contacto deben mantenerse privados hasta confirmar asistencia.",
      };
    }
  }

  if (/\b(?:\d\s+){7,}\d\b/.test(dehomoglyphed)) {
    return {
      decision: "review",
      categories: ["personal_data", "obfuscation"],
      confidence: 0.9,
      reason_code: "obfuscated_contact",
      explanation_for_moderator: "Número telefónico ofuscado con espacios entre dígitos.",
      user_friendly_message: "Los datos de contacto deben mantenerse privados hasta confirmar asistencia.",
    };
  }

  if (/(?:mi\s+ig|mi\s+wsp|mi\s+wapp|escribime\s+al\s+wsp|hablame\s+al\s+wsp|contactame\s+al|telegram:\s*@?|instagram:\s*@?)\s*[@a-z0-9_.]+/i.test(dehomoglyphed)) {
    return {
      decision: "review",
      categories: ["personal_data"],
      confidence: 0.85,
      reason_code: "external_contact",
      explanation_for_moderator: "Indicación de contacto por redes o mensajería externa.",
      user_friendly_message: "Los datos de contacto deben mantenerse privados hasta confirmar asistencia.",
    };
  }

  // 12. Publicidad comercial y captación
  if (
    /(trabaja desde casa|gana dinero f[aá]cil|inversi[oó]n de bajo riesgo|compr[aá] ya con descuento|oferta exclusiva por tiempo limitado|distribuidor mayorista oficial|venta directa por cat[aá]logo)/i.test(
      dehomoglyphed
    )
  ) {
    return {
      decision: "block",
      categories: ["advertising", "commercial_spam"],
      confidence: 0.9,
      reason_code: "commercial_spam",
      explanation_for_moderator: "Captación comercial o publicidad masiva en Discovery.",
      user_friendly_message: "La publicación no cumple las pautas de contenido comunitario.",
    };
  }

  if (/\b(drogas?|armas?|pistolas?|balas?|coca[ií]na|marihuana)\b/i.test(dehomoglyphed)) {
    return {
      decision: "review",
      categories: ["other"],
      confidence: 0.75,
      reason_code: "sensitive_terms_ambiguous",
      explanation_for_moderator: "Términos sensibles que requieren confirmación de contexto.",
      user_friendly_message: "Estamos revisando esta publicación antes de mostrarla públicamente.",
    };
  }

  // 13. Detección de idioma
  const langRes = evaluateLanguage(combined);
  if (!langRes.isSupported) {
    return {
      decision: "review",
      categories: ["language"],
      confidence: langRes.confidence,
      reason_code: "unsupported_language",
      explanation_for_moderator: `Idioma detectado no soportado (${langRes.detectedLanguage}) con confianza ${Math.round(langRes.confidence * 100)}%.`,
      user_friendly_message: "Estamos revisando esta publicación antes de mostrarla públicamente.",
    };
  }

  // 14. Detección de Duplicados en ventana 24h
  if (previousEncounters && previousEncounters.length > 0) {
    const dupRes = checkDuplicates(cleanTitle, cleanDesc, previousEncounters, candidateContext);
    if (dupRes.decision === "block") {
      return {
        decision: "block",
        categories: ["spam", "duplicate"],
        confidence: 0.95,
        reason_code: dupRes.reason_code || "duplicate_content",
        explanation_for_moderator: dupRes.explanation || "Duplicado en ráfaga o clon idéntico.",
        user_friendly_message: dupRes.user_friendly_message || "Ya creaste una publicación idéntica o muy similar recientemente.",
      };
    } else if (dupRes.decision === "review") {
      return {
        decision: "review",
        categories: ["duplicate"],
        confidence: 0.8,
        reason_code: "duplicate_content",
        explanation_for_moderator: dupRes.explanation || "Publicación similar que requiere verificación humana.",
        user_friendly_message: "Estamos revisando esta publicación antes de mostrarla públicamente.",
      };
    }
    // Si dupRes.decision === "allow", el encuentro es legítimo y se permite continuar limpio
  }

  // 15. Contenido Aprobado
  return {
    decision: "allow",
    categories: [],
    confidence: 0.95,
    reason_code: "clean_social_meetup",
    explanation_for_moderator: "Contenido limpio para Discovery.",
    user_friendly_message: "Encuentro moderado y publicado exitosamente.",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || serviceRoleKey;

  try {
    // 1. Autenticación estricta del caller mediante JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ ok: false, error: "not_authenticated" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return new Response(
        JSON.stringify({ ok: false, error: "not_authenticated" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: authData, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authData?.user) {
      return new Response(
        JSON.stringify({ ok: false, error: "not_authenticated" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const callerId = authData.user.id;

    // 2. Extracción de encounter_id (NO confiar en texto enviado por cliente)
    const payload = (await req.json().catch(() => ({}))) as Partial<ModerateContentRequest>;
    if (!payload || !payload.encounter_id) {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid_payload", message: "encounter_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase configuration");
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    // 3. Fuente Canónica de Contenido: leer estrictamente desde DB
    // Exclusión estricta de datos privados: NO se lee lugar_texto, link_virtual, public_token, etc.
    const { data: enc, error: encErr } = await supabaseAdmin
      .from("encuentros")
      .select("id, open_public_title, open_description, modalidad, open_public_zone, host_id, moderation_status, is_open")
      .eq("id", payload.encounter_id)
      .single();

    if (encErr || !enc) {
      return new Response(
        JSON.stringify({ ok: false, error: "encuentro_not_found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Autorización: sólo el host del encuentro o personal de moderación autorizado
    if (enc.host_id !== callerId) {
      const { data: isStaff } = await supabaseAdmin
        .from("moderation_authorized_users")
        .select("user_id, role")
        .eq("user_id", callerId)
        .eq("active", true)
        .in("role", ["admin", "moderator"])
        .maybeSingle();

      if (!isStaff) {
        return new Response(
          JSON.stringify({ ok: false, error: "unauthorized", message: "Only the encounter host or authorized moderation staff may trigger moderation" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 5. State Machine Precondition: sólo puede moderarse si está en 'review_pending'
    if (enc.moderation_status !== "review_pending") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "invalid_status_transition",
          current_status: enc.moderation_status,
          message: "Encounter is not in review_pending status",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Invariante de Privacidad: La moderación pública evalúa estrictamente open_public_title.
    if (!enc.open_public_title || !enc.open_public_title.trim()) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "missing_open_public_title",
          message: "Encounter has no valid open_public_title to moderate",
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const effectiveTitle = enc.open_public_title.trim();

    // 6. Consultar publicaciones recientes del mismo host en ventana 24 horas para detección de duplicados
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentEncounters } = await supabaseAdmin
      .from("encuentros")
      .select("id, open_public_title, open_description, fecha, hora, open_public_zone, locality_id, creado_en")
      .eq("host_id", enc.host_id)
      .neq("id", payload.encounter_id)
      .gte("creado_en", oneDayAgo);

    // 7. TOCTOU Protection: calcular fingerprint canónico sobre los campos en DB
    const { data: expectedHash } = await supabaseAdmin.rpc("calcular_content_hash_moderacion", {
      p_title: effectiveTitle,
      p_open_description: enc.open_description,
      p_modalidad: enc.modalidad,
      p_open_public_zone: enc.open_public_zone,
    });

    const candidateContext = {
      fecha: enc.fecha,
      hora: enc.hora,
      zona: enc.open_public_zone || enc.locality_id,
      created_at: enc.creado_en,
    };

    // 8. Evaluación sobre contenido canónico exclusivamente
    const gateResult = evaluatePublicQualityGate(
      effectiveTitle,
      enc.open_description || "",
      recentEncounters || [],
      candidateContext
    );

    // 9. Choke point: aplicar resolución atómica con service_role validando hash
    if (gateResult.decision === "allow") {
      const { data: resolveResult, error: resolveErr } = await supabaseAdmin.rpc(
        "resolver_moderacion_encuentro_seguro",
        {
          p_encuentro_id: payload.encounter_id,
          p_action: "approve",
          p_note: `Automated moderation allow: ${gateResult.reason_code}`,
          p_expected_content_hash: expectedHash,
        }
      );

      if (resolveErr || !resolveResult?.ok) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: resolveResult?.error || "approval_failed",
            moderation_status: "review_pending",
            is_open: false,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else if (gateResult.decision === "block") {
      await supabaseAdmin.rpc("resolver_moderacion_encuentro_seguro", {
        p_encuentro_id: payload.encounter_id,
        p_action: "reject",
        p_note: `Automated moderation block: ${gateResult.reason_code}`,
        p_expected_content_hash: expectedHash,
      });
    } else {
      // gateResult.decision === 'review'
      // Actualizar registro en DB con las razones estructuradas para la cola /internal/moderation
      await supabaseAdmin
        .from("encuentros")
        .update({
          moderation_reason: gateResult.reason_code,
          moderation_categories: gateResult.categories,
          moderation_decision_source: "automated_pipeline",
        })
        .eq("id", payload.encounter_id)
        .eq("moderation_status", "review_pending");

      // Registrar auditoría del flag
      await supabaseAdmin
        .from("public_content_moderation_audit")
        .insert({
          encuentro_id: payload.encounter_id,
          moderator_id: null,
          action: "automated_review_flagged",
          previous_status: "review_pending",
          new_status: "review_pending",
          reason: gateResult.reason_code,
          categories: gateResult.categories,
          source: "automated_pipeline",
          metadata: {
            confidence: gateResult.confidence,
            explanation: gateResult.explanation_for_moderator,
            content_hash: expectedHash,
          },
        });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          ...gateResult,
          is_open: gateResult.decision === "allow",
          moderation_status:
            gateResult.decision === "allow"
              ? "approved"
              : gateResult.decision === "block"
              ? "rejected"
              : "review_pending",
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[moderate-public-content] Fail-safe error:", err);
    // FAIL-SAFE ESTRICTO: ante cualquier error no previsto, jamás fail-open
    const fallbackResult: ModerateContentResult = {
      decision: "review",
      categories: [],
      confidence: 0,
      reason_code: "moderation_unavailable",
      explanation_for_moderator: "Falla de ejecución en Edge Function. Derivado a revisión humana.",
      user_friendly_message: "Estamos revisando esta publicación antes de mostrarla públicamente.",
    };

    return new Response(
      JSON.stringify({
        ok: false,
        error: "moderation_unavailable",
        data: {
          ...fallbackResult,
          is_open: false,
          moderation_status: "review_pending",
        },
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
