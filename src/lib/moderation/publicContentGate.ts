/**
 * Public Quality + Anti-Spam Gate (Moderación v1.1)
 *
 * Evaluación determinista multicapa para contenido público:
 * 1. Sanitización y normalización Unicode (NFKC, zero-width, homógrafos, espacios colapsados).
 * 2. Payloads maliciosos y seguridad web.
 * 3. Amenazas y violencia explícita.
 * 4. Actividad ilegal / explotación.
 * 5. Scams, phishing y captación fraudulenta.
 * 6. Gibberish y secuencias aleatorias.
 * 7. Exceso de símbolos y repeticiones artificiales.
 * 8. Contenido de baja sustancia informativa (low_information_content).
 * 9. Detección de contactos expuestos y ofuscados (WhatsApp, Telegram, emails, teléfonos).
 * 10. Spam comercial masivo y URLs (múltiples vs únicas).
 * 11. Detección de idioma (ES, EN, PT soportados; otros -> REVIEW, frases cortas permitidas).
 * 12. Detección de duplicados contra publicaciones recientes del mismo usuario.
 */

import {
  normalizeUnicode,
  countInvisibleChars,
  replaceHomoglyphs,
  collapseArtificialSpaces,
  calculateSymbolRatio,
} from './normalizer.ts';
import { detectSupportedLanguage } from './languageDetector.ts';
import { checkDuplicateContent } from './duplicateDetector.ts';
import type { ModerationEvaluationResult, RecentEncounterHistory } from './types.ts';

export function evaluatePublicContentGate(
  title: string,
  description: string = '',
  recentHostHistory: RecentEncounterHistory[] = []
): ModerationEvaluationResult {
  const rawTitle = (title || '').trim();
  const rawDesc = (description || '').trim();

  // 1. Longitud básica técnica
  if (rawTitle.length < 3) {
    return {
      decision: 'block',
      categories: ['garbage'],
      confidence: 1.0,
      reason_code: 'title_too_short',
      explanation_for_moderator: 'El título tiene menos de 3 caracteres.',
      user_friendly_message: 'El título debe tener al menos 3 caracteres.',
    };
  }

  // 2. Normalización de caracteres
  const normTitle = normalizeUnicode(rawTitle);
  const normDesc = normalizeUnicode(rawDesc);
  const combinedNorm = (normTitle + ' ' + normDesc).trim();

  // Detección de inyección de caracteres invisibles anormales (ej. > 3 caracteres invisibles en el texto)
  const invisibleCount = countInvisibleChars(rawTitle) + countInvisibleChars(rawDesc);
  if (invisibleCount > 4) {
    return {
      decision: 'block',
      categories: ['garbage', 'obfuscation'],
      confidence: 0.95,
      reason_code: 'obfuscated_contact',
      explanation_for_moderator: `Se detectaron ${invisibleCount} caracteres invisibles/zero-width utilizados para ofuscación.`,
      user_friendly_message: 'La publicación contiene caracteres no permitidos.',
    };
  }

  // Versiones para inspección heurística
  const textLower = combinedNorm.toLowerCase();
  const collapsedSpaces = collapseArtificialSpaces(textLower);
  const dehomoglyphed = replaceHomoglyphs(collapsedSpaces);

  // 3. Payloads maliciosos y ataques web (XSS, iframes, javascript URI)
  if (/<\s*script|javascript\s*:|data\s*:\s*text\/html|<\s*iframe|<\s*object|<\s*embed|<\s*svg/i.test(combinedNorm)) {
    return {
      decision: 'block',
      categories: ['malicious_payload'],
      confidence: 1.0,
      reason_code: 'malicious_payload',
      explanation_for_moderator: 'Contiene payload malicioso de inyección o script HTML.',
      user_friendly_message: 'El contenido no cumple con las pautas de seguridad de la plataforma.',
    };
  }

  // 4. Amenazas y violencia física explícita
  if (/(te voy a matar|los voy a matar|amenaza de muerte|te voy a reventar|tiroteo|poner una bomba|vamos a golpear|masacre)/i.test(dehomoglyphed)) {
    return {
      decision: 'block',
      categories: ['violence_threat'],
      confidence: 1.0,
      reason_code: 'violence_threat',
      explanation_for_moderator: 'Contiene amenazas explícitas de violencia física.',
      user_friendly_message: 'El contenido infringe las normas de convivencia de la comunidad.',
    };
  }

  // 5. Actividad ilegal tarifada / sustancias ilegales
  if (/(vendo coca[ií]na|vendo droga|vendo armas|servicios sexuales tarifados|escort tarifas)/i.test(dehomoglyphed)) {
    return {
      decision: 'block',
      categories: ['illegal_activity'],
      confidence: 1.0,
      reason_code: 'illegal_activity',
      explanation_for_moderator: 'Oferta comercial de sustancias ilícitas, armas o servicios sexuales tarifados.',
      user_friendly_message: 'El contenido infringe las normas comunitarias.',
    };
  }

  // 6. Scams, phishing y captación fraudulenta
  if (
    /(ingres[aá] tu contrase[ñn]a|verific[aá] tu cuenta bancaria|actualiz[aá] tus datos bancarios|ganaste un sorteo de|tarjeta de cr[eé]dito gratis|click aqu[ií] para reclamar premio|inversi[oó]n en cripto asegurada|ganancias garantizadas en d[oó]lares|esquema piramidal|forex trading garantizado|duplica tu inversi[oó]n)/i.test(
      dehomoglyphed
    )
  ) {
    return {
      decision: 'block',
      categories: ['fraud_scam'],
      confidence: 0.95,
      reason_code: 'possible_scam',
      explanation_for_moderator: 'Patrones inequívocos de estafa, captación financiera o phishing.',
      user_friendly_message: 'El contenido infringe las pautas contra promociones y estafas.',
    };
  }

  // 7. Exceso de símbolos y puntuación abusiva
  // Secuencias de símbolos repetidos (ej. "!!!!!!!", "???????", "$$$$$$$")
  if (/([!?#$%&*+=~^_\-]){5,}/.test(combinedNorm)) {
    return {
      decision: 'block',
      categories: ['excessive_symbols'],
      confidence: 0.95,
      reason_code: 'excessive_symbols',
      explanation_for_moderator: 'Uso reiterado y abusivo de signos o símbolos de puntuación.',
      user_friendly_message: 'Por favor evitá el uso excesivo de símbolos y signos en el texto público.',
    };
  }

  // Ratio de símbolos en textos de tamaño mediano
  const symbolStats = calculateSymbolRatio(combinedNorm);
  if (symbolStats.symbolCount > 8 && symbolStats.ratio > 0.4) {
    return {
      decision: 'block',
      categories: ['excessive_symbols'],
      confidence: 0.9,
      reason_code: 'excessive_symbols',
      explanation_for_moderator: `Proporción excesiva de símbolos no alfanuméricos (${Math.round(symbolStats.ratio * 100)}%).`,
      user_friendly_message: 'Por favor evitá el uso excesivo de símbolos en la publicación.',
    };
  }

  // 8. Gibberish, secuencias aleatorias y repeticiones absurdas
  // Repetición masiva del mismo carácter (6+ seguidos)
  if (/([a-zA-Z0-9])\1{5,}/.test(combinedNorm)) {
    return {
      decision: 'block',
      categories: ['garbage'],
      confidence: 1.0,
      reason_code: 'gibberish',
      explanation_for_moderator: 'Repetición masiva y absurda de caracteres idénticos.',
      user_friendly_message: 'Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.',
    };
  }

  // Mashing de teclado
  if (/(asdf|qwer|zxcv|1234|lkjh|hjkl){3,}/i.test(combinedNorm)) {
    return {
      decision: 'block',
      categories: ['garbage'],
      confidence: 1.0,
      reason_code: 'gibberish',
      explanation_for_moderator: 'Secuencia aleatoria de teclado (keyboard mashing).',
      user_friendly_message: 'Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.',
    };
  }

  // Consonantes consecutivas sin sentido en una sola palabra (6+ consonantes seguidas)
  if (/\b[bcdfghjklmnpqrstvwxyz]{6,}\b/i.test(dehomoglyphed)) {
    return {
      decision: 'block',
      categories: ['garbage'],
      confidence: 0.9,
      reason_code: 'gibberish',
      explanation_for_moderator: 'Palabra con 6 o más consonantes seguidas sin vocales.',
      user_friendly_message: 'Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.',
    };
  }

  // Palabras repetidas en bucle (ej. "fiesta fiesta fiesta fiesta fiesta")
  const wordsList = textLower.split(/\s+/).filter(Boolean);
  if (wordsList.length >= 5) {
    let maxConsecutive = 1;
    let currentConsecutive = 1;
    for (let i = 1; i < wordsList.length; i++) {
      if (wordsList[i] === wordsList[i - 1]) {
        currentConsecutive++;
        if (currentConsecutive > maxConsecutive) maxConsecutive = currentConsecutive;
      } else {
        currentConsecutive = 1;
      }
    }
    if (maxConsecutive >= 5) {
      return {
        decision: 'block',
        categories: ['garbage'],
        confidence: 0.95,
        reason_code: 'gibberish',
        explanation_for_moderator: 'Repetición absurda de la misma palabra 5 o más veces consecutivas.',
        user_friendly_message: 'Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.',
      };
    }
  }

  // 9. Contenido casi vacío o de baja sustancia (low_information_content)
  const descWords = normDesc.toLowerCase().split(/\s+/).filter(Boolean);
  const descSubstantiveWords = descWords.filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  if (rawDesc.length > 0 && (rawDesc.length < 15 || descSubstantiveWords.length <= 1)) {
    return {
      decision: 'review',
      categories: ['low_quality'],
      confidence: 0.8,
      reason_code: 'low_information_content',
      explanation_for_moderator: 'Contenido extremadamente escaso o vago en descripción.',
      user_friendly_message: 'Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.',
    };
  }

  // 10. URLs y Enlaces
  const urlMatches = textLower.match(/(?:https?:\/\/[^\s]+|(?:www\.|bit\.ly\/|tinyurl\.com\/|t\.co\/|wa\.me\/|t\.me\/|linktr\.ee\/|discord\.gg\/|cutt\.ly\/)[^\s]+)/gi);
  if (urlMatches && urlMatches.length >= 2) {
    return {
      decision: 'block',
      categories: ['spam'],
      confidence: 0.95,
      reason_code: 'commercial_spam',
      explanation_for_moderator: 'Múltiples enlaces o URLs en contenido público (spam de enlaces).',
      user_friendly_message: 'No está permitido publicar enlaces múltiples en el contenido público.',
    };
  } else if (urlMatches && urlMatches.length === 1) {
    const singleUrl = urlMatches[0].toLowerCase();
    // Si el enlace único es un acortador o mensajería directa
    if (singleUrl.includes('wa.me') || singleUrl.includes('t.me')) {
      return {
        decision: 'review',
        categories: ['external_contact'],
        confidence: 0.85,
        reason_code: 'external_contact',
        explanation_for_moderator: 'Enlace directo de mensajería (WhatsApp/Telegram).',
        user_friendly_message: 'Los datos de contacto deben mantenerse privados hasta confirmar asistencia.',
      };
    }
    return {
      decision: 'review',
      categories: ['advertising'],
      confidence: 0.8,
      reason_code: 'contains_link',
      explanation_for_moderator: 'La publicación contiene un enlace externo en texto público.',
      user_friendly_message: 'Estamos revisando esta publicación antes de mostrarla públicamente.',
    };
  }

  // 11. Datos de contacto expuestos y ofuscados (Emails, Teléfonos, Redes/Handles)
  // Email explícito
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(textLower)) {
    return {
      decision: 'review',
      categories: ['personal_data'],
      confidence: 0.9,
      reason_code: 'external_contact',
      explanation_for_moderator: 'Contiene dirección de correo electrónico.',
      user_friendly_message: 'Los datos de contacto deben mantenerse privados hasta confirmar asistencia.',
    };
  }

  // Email ofuscado: ej. "juan arroba gmail punto com" o "[at] domain [dot] com"
  if (/(?:arroba|\(at\)|\[at\])\s*[a-z0-9.-]+\s*(?:punto|\(dot\)|\[dot\]|\.)\s*[a-z]{2,}/i.test(collapsedSpaces)) {
    return {
      decision: 'review',
      categories: ['personal_data', 'obfuscation'],
      confidence: 0.85,
      reason_code: 'obfuscated_contact',
      explanation_for_moderator: 'Correo electrónico ofuscado mediante palabras (arroba / punto).',
      user_friendly_message: 'Los datos de contacto deben mantenerse privados hasta confirmar asistencia.',
    };
  }

  // Teléfonos ofuscados con espacios entre cada dígito (ej. "1 1 2 3 4 5 6 7 8 9" o "1 1 5 6 7 8 9 0 1 2")
  const spacedDigitsMatch = textLower.match(/\b(?:\d\s+){6,}\d\b/);
  if (spacedDigitsMatch) {
    return {
      decision: 'review',
      categories: ['personal_data', 'obfuscation'],
      confidence: 0.9,
      reason_code: 'obfuscated_contact',
      explanation_for_moderator: 'Número de teléfono ofuscado con espacios entre cada dígito.',
      user_friendly_message: 'Los datos de contacto deben mantenerse privados hasta confirmar asistencia.',
    };
  }

  // Teléfonos (estándar o con formato internacional)
  if (/\b(?:\+?\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/.test(textLower)) {
    // Evitar falsos positivos con años o horas comunes (ej. "2026", "18:00")
    const digitsOnly = textLower.replace(/\D/g, '');
    if (digitsOnly.length >= 8 && digitsOnly.length <= 13) {
      return {
        decision: 'review',
        categories: ['personal_data'],
        confidence: 0.85,
        reason_code: 'external_contact',
        explanation_for_moderator: 'Número de teléfono detectado en contenido público.',
        user_friendly_message: 'Los datos de contacto deben mantenerse privados hasta confirmar asistencia.',
      };
    }
  }

  // Redes sociales / Handles directos
  if (/(?:mi\s+ig|mi\s+wsp|mi\s+wapp|escribime\s+al\s+wsp|hablame\s+al\s+wsp|contactame\s+al|telegram:\s*@?|instagram:\s*@?)\s*[@a-z0-9_.]+/i.test(textLower)) {
    return {
      decision: 'review',
      categories: ['personal_data'],
      confidence: 0.85,
      reason_code: 'external_contact',
      explanation_for_moderator: 'Indicación directa para contactar por redes o mensajería privada externa.',
      user_friendly_message: 'Los datos de contacto deben mantenerse privados hasta confirmar asistencia.',
    };
  }

  // 12. Publicidad comercial y captación
  if (
    /(trabaja desde casa|gana dinero f[aá]cil|inversi[oó]n de bajo riesgo|compr[aá] ya con descuento|oferta exclusiva por tiempo limitado|distribuidor mayorista oficial|venta directa por cat[aá]logo)/i.test(
      dehomoglyphed
    )
  ) {
    return {
      decision: 'block',
      categories: ['advertising', 'commercial_spam'],
      confidence: 0.9,
      reason_code: 'commercial_spam',
      explanation_for_moderator: 'Captación comercial o publicidad masiva no permitida en Discovery.',
      user_friendly_message: 'La publicación no cumple con las pautas de contenido comunitario.',
    };
  }

  // Términos sensibles ambiguos
  if (/\b(drogas?|armas?|pistolas?|balas?|coca[ií]na|marihuana)\b/i.test(dehomoglyphed)) {
    return {
      decision: 'review',
      categories: ['other'],
      confidence: 0.75,
      reason_code: 'sensitive_terms_ambiguous',
      explanation_for_moderator: 'Contiene términos sensibles que requieren confirmación de contexto humano.',
      user_friendly_message: 'Estamos revisando esta publicación antes de mostrarla públicamente.',
    };
  }

  // 13. Detección de Idioma (Soportados: ES, EN, PT)
  const langResult = detectSupportedLanguage(combinedNorm);
  if (!langResult.isSupported) {
    return {
      decision: 'review',
      categories: ['language'],
      confidence: langResult.confidence,
      reason_code: 'unsupported_language',
      explanation_for_moderator: `Idioma detectado no soportado (${langResult.detectedLanguage}) con confianza ${Math.round(langResult.confidence * 100)}%. Requiere revisión humana.`,
      user_friendly_message: 'Estamos revisando esta publicación antes de mostrarla públicamente.',
    };
  }

  // 14. Detección de Duplicados contra el historial reciente del mismo anfitrión (24 horas)
  if (recentHostHistory && recentHostHistory.length > 0) {
    const dupResult = checkDuplicateContent(normTitle, normDesc, recentHostHistory, 0.85);
    if (dupResult.isDuplicate) {
      if (dupResult.isExactMatch || dupResult.similarity >= 0.95) {
        return {
          decision: 'block',
          categories: ['spam', 'duplicate'],
          confidence: 0.95,
          reason_code: 'duplicate_content',
          explanation_for_moderator: `Publicación idéntica o casi idéntica (${Math.round(dupResult.similarity * 100)}% de similitud) creada recientemente por el mismo anfitrión.`,
          user_friendly_message: 'Ya creaste una publicación idéntica o muy similar recientemente.',
        };
      } else {
        return {
          decision: 'review',
          categories: ['duplicate'],
          confidence: 0.8,
          reason_code: 'duplicate_content',
          explanation_for_moderator: `Publicación con alta similitud (${Math.round(dupResult.similarity * 100)}%) respecto a otra reciente del mismo anfitrión.`,
          user_friendly_message: 'Estamos revisando esta publicación antes de mostrarla públicamente.',
        };
      }
    }
  }

  // 15. Contenido Limpio
  return {
    decision: 'allow',
    categories: [],
    confidence: 0.95,
    reason_code: 'clean_social_meetup',
    explanation_for_moderator: 'Contenido apto para publicación pública directa.',
    user_friendly_message: 'Encuentro moderado y publicado exitosamente.',
  };
}
