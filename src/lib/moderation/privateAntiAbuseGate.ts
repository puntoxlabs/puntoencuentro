/**
 * Private Minimum Anti-Abuse Gate (Moderación v1.1)
 *
 * Aplica EXCLUSIVAMENTE un piso mínimo antiabuso determinista y barato
 * sobre invitaciones privadas compartibles por link:
 * - NO bloquea por idioma (cualquier idioma es válido).
 * - NO bloquea por gibberish o títulos internos raros ('asdf sync', '1234 meeting').
 * - NO exige que 'parezca un encuentro'.
 * - NO impide reuniones privadas comerciales legítimas ('Balance trimestral ventas', 'Pitch clientes').
 * - NO envía contenido a LLMs ni modelos externos.
 *
 * Únicamente bloquea riesgo inequívoco y severo:
 * - Payloads maliciosos de inyección web (<script, javascript:, data:text/html, etc.).
 * - Phishing y robo de credenciales bancarias/contraseñas.
 * - Enlaces a malware o dominios de robo de identidad evidentes.
 */

import { normalizeUnicode, replaceHomoglyphs } from './normalizer.ts';
import type { PrivateContentGateResult } from './types.ts';

export function evaluatePrivateAntiAbuseGate(
  title: string,
  description?: string | null
): PrivateContentGateResult {
  const rawTitle = (title || '').trim();
  const rawDesc = (description || '').trim();
  const combined = (rawTitle + ' ' + rawDesc).trim();

  if (!combined) {
    return { allowed: true };
  }

  const normalized = normalizeUnicode(combined);
  const textLower = normalized.toLowerCase();
  const dehomoglyphed = replaceHomoglyphs(textLower);

  // 1. Payloads maliciosos (XSS / inyección directa)
  if (/<\s*script|javascript\s*:|data\s*:\s*text\/html|<\s*iframe|<\s*object|<\s*embed/i.test(normalized)) {
    return {
      allowed: false,
      reason: 'malicious_payload',
      user_friendly_message: 'El contenido de la invitación contiene código o enlaces no permitidos por seguridad.',
    };
  }

  // 2. Phishing explícito / Robo de credenciales o cuentas
  if (
    /(ingres[aá]\s+(?:tu|su)\s+contrase[ñn]a|verific[aá]\s+(?:tu|su)\s+clave\s+bancaria|actualiz[aá]\s+tus\s+datos\s+bancarios|robo\s+de\s+cuenta|inici[aá]\s+sesi[oó]n\s+en\s+home\s*banking|ingres[aá]\s+el\s+token\s+de\s+tu\s+banco)/i.test(
      dehomoglyphed
    )
  ) {
    return {
      allowed: false,
      reason: 'credential_theft',
      user_friendly_message: 'Este enlace de invitación no está disponible porque contiene solicitudes de seguridad no autorizadas.',
    };
  }

  // 3. Estafas financieras / scams masivos inequívocos
  if (
    /(ganaste\s+(?:un\s+sorteo|\$1000000|un\s+auto)\s+reclamalo\s+aqu[ií]|tarjeta\s+de\s+cr[eé]dito\s+gratis\s+sin\s+requisitos\s+click)/i.test(
      dehomoglyphed
    )
  ) {
    return {
      allowed: false,
      reason: 'severe_scam',
      user_friendly_message: 'Este enlace de invitación no está disponible por razones de seguridad.',
    };
  }

  // Todo lo demás (reuniones comerciales, títulos raros, otros idiomas, textos informales) está permitido
  return {
    allowed: true,
    reason: 'clean',
  };
}
