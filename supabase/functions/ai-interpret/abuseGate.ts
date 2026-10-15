// Supabase Edge Function: ai-interpret abuse gate
// Deterministic, sub-millisecond, low-cost pre-LLM validation.
// Enforces technical abuse prevention WITHOUT editorial content moderation.

export type AbuseGateReason =
  | 'empty_input'
  | 'too_short'
  | 'input_too_long'
  | 'malicious_payload'
  | 'extreme_repetition'
  | 'excessive_symbols'
  | 'automated_gibberish';

export interface AbuseGateResult {
  allowed: boolean;
  reason?: AbuseGateReason;
  message?: string;
}

// Regex detection for obvious web injection & executable payloads
const MALICIOUS_PAYLOAD_REGEX =
  /<\s*script|javascript\s*:|data\s*:\s*text\/html|<\s*iframe|<\s*object|<\s*embed|<\s*svg[\s>][^>]*onload|<\s*img[\s>][^>]*onerror/i;

// 15+ consecutive non-alphanumeric punctuation/symbols (excluding whitespace)
const CONSECUTIVE_SYMBOLS_REGEX = /[^\p{L}\p{N}\s]{15,}/u;

// 15+ consecutive latin consonants without any vowels or whitespace (automated random strings)
const CONSECUTIVE_CONSONANTS_REGEX = /[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]{15,}/;

// Random high-entropy token of 60+ chars with no spaces
const HIGH_ENTROPY_TOKEN_REGEX = /^[a-zA-Z0-9_-]{60,}$/;

// 25+ consecutive repetitions of the exact same character
const REPEATED_CHAR_REGEX = /(.)\1{24,}/u;

// 10+ consecutive repetitions of the exact same word/token
const REPEATED_TOKEN_REGEX = /\b([\p{L}\p{N}]+)(?:\s+\1){9,}\b/iu;

/**
 * Deterministically evaluates user natural language input for severe technical abuse.
 * 
 * Rules:
 * - Empty / whitespace only -> reject (invalid_input)
 * - Length < 2 -> reject (too_short)
 * - Length > 1000 -> reject (input_too_long)
 * - Obvious web injection / script payload -> reject (malicious_payload)
 * - Extreme character/word repetition -> reject (extreme_repetition)
 * - Massive symbol sequences or extreme symbol density -> reject (excessive_symbols)
 * - Obvious automated gibberish / consonant clusters -> reject (automated_gibberish)
 * 
 * Conservative Principle:
 * - Private intent input.
 * - DOES NOT block legitimate commercial meetups, foreign languages, informal text, or unusual but plausible social ideas.
 * - In case of doubt: ALLOW.
 */
export function evaluateAiInputAbuseGate(input: unknown): AbuseGateResult {
  if (typeof input !== 'string') {
    return {
      allowed: false,
      reason: 'empty_input',
      message: 'Escribí brevemente qué te gustaría hacer.',
    };
  }

  const trimmed = input.trim();

  // 1. Empty / whitespace
  if (!trimmed) {
    return {
      allowed: false,
      reason: 'empty_input',
      message: 'Escribí brevemente qué te gustaría hacer.',
    };
  }

  // 2. Minimum length (at least 2 meaningful chars, e.g. "té", "ir", "asado")
  if (trimmed.length < 2) {
    return {
      allowed: false,
      reason: 'too_short',
      message: 'Escribí brevemente qué te gustaría hacer.',
    };
  }

  // 3. Maximum length bound
  if (trimmed.length > 1000) {
    return {
      allowed: false,
      reason: 'input_too_long',
      message: 'El mensaje es demasiado largo. Contame brevemente qué querés organizar o cambiar.',
    };
  }

  // 4. Malicious code injection / payloads
  if (MALICIOUS_PAYLOAD_REGEX.test(trimmed)) {
    return {
      allowed: false,
      reason: 'malicious_payload',
      message: 'El mensaje contiene caracteres o código no permitidos.',
    };
  }

  // 5. Extreme repetition
  // 5a. Same character repeated 25+ times in a row
  if (REPEATED_CHAR_REGEX.test(trimmed)) {
    return {
      allowed: false,
      reason: 'extreme_repetition',
      message: 'Hubo demasiados intentos en poco tiempo. Probá nuevamente en unos minutos.',
    };
  }

  // 5b. Same token repeated 10+ times consecutively
  if (REPEATED_TOKEN_REGEX.test(trimmed)) {
    return {
      allowed: false,
      reason: 'extreme_repetition',
      message: 'Hubo demasiados intentos en poco tiempo. Probá nuevamente en unos minutos.',
    };
  }

  // 5c. Single character represents > 80% of text in long messages (> 30 chars)
  if (trimmed.length >= 30) {
    const nonSpace = trimmed.replace(/\s+/g, '');
    if (nonSpace.length >= 25) {
      const counts: Record<string, number> = {};
      let maxCount = 0;
      for (const char of nonSpace) {
        counts[char] = (counts[char] || 0) + 1;
        if (counts[char] > maxCount) maxCount = counts[char];
      }
      if (maxCount / nonSpace.length > 0.8) {
        return {
          allowed: false,
          reason: 'extreme_repetition',
          message: 'Hubo demasiados intentos en poco tiempo. Probá nuevamente en unos minutos.',
        };
      }
    }
  }

  // 6. Excessive symbols
  // 6a. 15+ consecutive non-alphanumeric symbols
  if (CONSECUTIVE_SYMBOLS_REGEX.test(trimmed)) {
    return {
      allowed: false,
      reason: 'excessive_symbols',
      message: 'El mensaje contiene caracteres o código no permitidos.',
    };
  }

  // 6b. Symbol density > 70% in messages of length >= 30
  if (trimmed.length >= 30) {
    const nonSpace = trimmed.replace(/\s+/g, '');
    const alphanumericCount = (nonSpace.match(/[\p{L}\p{N}]/gu) || []).length;
    const symbolDensity = 1 - alphanumericCount / nonSpace.length;
    if (symbolDensity > 0.7) {
      return {
        allowed: false,
        reason: 'excessive_symbols',
        message: 'El mensaje contiene caracteres o código no permitidos.',
      };
    }
  }

  // 7. Automated manifest gibberish
  // 7a. 15+ consecutive consonants without any vowels or spaces
  if (CONSECUTIVE_CONSONANTS_REGEX.test(trimmed)) {
    return {
      allowed: false,
      reason: 'automated_gibberish',
      message: 'El mensaje contiene caracteres o código no permitidos.',
    };
  }

  // 7b. High entropy long random token without spaces (e.g. 60+ chars hex/base64 strings)
  if (HIGH_ENTROPY_TOKEN_REGEX.test(trimmed)) {
    return {
      allowed: false,
      reason: 'automated_gibberish',
      message: 'El mensaje contiene caracteres o código no permitidos.',
    };
  }

  // Clean / legitimate intent
  return { allowed: true };
}
