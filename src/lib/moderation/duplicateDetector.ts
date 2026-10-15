/**
 * Detección determinista de duplicados para Moderación v1.1
 * Compara publicaciones del mismo usuario en una ventana de 24 horas.
 *
 * REGLAS ESTRUCTURALES Y CONSERVADORAS:
 * - Nunca se bloquea (BLOCK) automáticamente sólo por similitud textual.
 * - Casos legítimos (días distintos, horas distintas, zonas distintas, encuentros recurrentes) -> ALLOW.
 * - Ambigüedad (alta similitud sin diferenciación estructural clara pero sin ráfaga) -> REVIEW.
 * - BLOCK automático únicamente ante:
 *    1) Mismo contenido + misma fecha/hora + misma zona exacta (clon idéntico de slot).
 *    2) Ráfaga de spam masivo (múltiples clones en pocos minutos o volumen anormal >= 4 publicaciones casi idénticas).
 */

import { canonicalizeForComparison } from './normalizer.ts';
import type { RecentEncounterHistory } from './types.ts';

export interface DuplicateCheckContext {
  fecha?: string | null;
  hora?: string | null;
  zona?: string | null;
  open_public_zone?: string | null;
  locality_id?: string | null;
  created_at?: string | null;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  similarity: number; // 0.0 a 1.0
  matchedEncounterId?: string;
  isExactMatch: boolean;
  decision: 'allow' | 'review' | 'block';
  reason_code?: 'duplicate_content' | 'duplicate_content_burst';
  explanation_for_moderator?: string;
  user_friendly_message?: string;
  matchCount?: number;
}

function calculateWordJaccard(textA: string, textB: string): number {
  const normA = canonicalizeForComparison(textA);
  const normB = canonicalizeForComparison(textB);

  if (!normA || !normB) return 0;
  if (normA === normB) return 1.0;

  const wordsA = normA.split(/\s+/).filter(Boolean);
  const wordsB = normB.split(/\s+/).filter(Boolean);

  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function checkDuplicateContent(
  candidateTitle: string,
  candidateDescription: string = '',
  recentHistory: RecentEncounterHistory[] = [],
  candidateContext?: DuplicateCheckContext,
  similarityThreshold: number = 0.85
): DuplicateCheckResult {
  if (!recentHistory || recentHistory.length === 0) {
    return { isDuplicate: false, similarity: 0, isExactMatch: false, decision: 'allow' };
  }

  const candidateCombined = `${candidateTitle} ${candidateDescription || ''}`.trim();
  const normCandidate = canonicalizeForComparison(candidateCombined);

  const candFecha = candidateContext?.fecha ? candidateContext.fecha.trim() : null;
  const candHora = candidateContext?.hora ? candidateContext.hora.trim().slice(0, 5) : null;
  const candZona = (candidateContext?.zona || candidateContext?.open_public_zone || candidateContext?.locality_id || '').trim().toLowerCase();
  const candCreatedAt = candidateContext?.created_at ? new Date(candidateContext.created_at).getTime() : Date.now();

  let maxSimilarity = 0;
  let bestMatchId: string | undefined = undefined;

  const matchingItems: { prev: RecentEncounterHistory; sim: number; isExact: boolean }[] = [];

  for (const prev of recentHistory) {
    const prevTitle = (prev.title || prev.open_public_title || '').trim();
    const prevDesc = (prev.description || prev.open_description || '').trim();
    const prevCombined = `${prevTitle} ${prevDesc}`.trim();
    const normPrev = canonicalizeForComparison(prevCombined);

    let sim = 0;
    let isExact = false;

    if (normCandidate === normPrev && normCandidate.length > 5) {
      sim = 1.0;
      isExact = true;
    } else {
      sim = calculateWordJaccard(candidateCombined, prevCombined);
    }

    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      bestMatchId = prev.id;
    }

    if (sim >= similarityThreshold) {
      matchingItems.push({ prev, sim, isExact });
    }
  }

  if (matchingItems.length === 0) {
    return {
      isDuplicate: false,
      similarity: maxSimilarity,
      matchedEncounterId: undefined,
      isExactMatch: false,
      decision: 'allow',
    };
  }

  // 1. REGLA DE BLOQUEO 1: Clon idéntico de slot (mismo contenido + misma fecha + misma hora + misma zona)
  const exactSlotMatch = matchingItems.find(({ prev }) => {
    const prevFecha = prev.fecha ? prev.fecha.trim() : null;
    const prevHora = prev.hora ? prev.hora.trim().slice(0, 5) : null;
    const prevZona = (prev.zona || prev.open_public_zone || prev.locality_id || '').trim().toLowerCase();

    const sameFecha = Boolean(candFecha && prevFecha && candFecha === prevFecha);
    const sameHora = Boolean(candHora && prevHora && candHora === prevHora);
    const sameZona = Boolean(candZona === prevZona || (!candZona && !prevZona));

    return sameFecha && sameHora && sameZona;
  });

  if (exactSlotMatch) {
    return {
      isDuplicate: true,
      similarity: exactSlotMatch.sim,
      matchedEncounterId: exactSlotMatch.prev.id,
      isExactMatch: exactSlotMatch.isExact,
      decision: 'block',
      reason_code: 'duplicate_content',
      explanation_for_moderator: 'Mismo contenido público duplicado para la misma fecha, horario y zona exacta.',
      user_friendly_message: 'Ya existe una publicación activa para este mismo horario y lugar.',
      matchCount: matchingItems.length,
    };
  }

  // 2. REGLA DE BLOQUEO 2: Ráfaga / Spam masivo (burst posting)
  // Caso 2a: 3 o más publicaciones previas similares en 24h (el candidato sería la 4ta o 5ta)
  if (matchingItems.length >= 3) {
    return {
      isDuplicate: true,
      similarity: maxSimilarity,
      matchedEncounterId: bestMatchId,
      isExactMatch: false,
      decision: 'block',
      reason_code: 'duplicate_content_burst',
      explanation_for_moderator: `Volumen anormal de publicaciones casi idénticas (${matchingItems.length + 1} publicaciones del mismo anfitrión en 24h).`,
      user_friendly_message: 'Se detectaron múltiples publicaciones similares en un lapso breve. Por favor esperá antes de publicar nuevamente.',
      matchCount: matchingItems.length,
    };
  }

  // Caso 2b: Al menos 2 publicaciones previas creadas en ráfaga (intervalo corto <= 10 min)
  if (matchingItems.length >= 2) {
    const hasBurstTiming = matchingItems.some(({ prev }) => {
      if (!prev.created_at) return false;
      const prevTime = new Date(prev.created_at).getTime();
      return Math.abs(candCreatedAt - prevTime) <= 10 * 60 * 1000;
    });

    if (hasBurstTiming) {
      return {
        isDuplicate: true,
        similarity: maxSimilarity,
        matchedEncounterId: bestMatchId,
        isExactMatch: false,
        decision: 'block',
        reason_code: 'duplicate_content_burst',
        explanation_for_moderator: `Ráfaga de publicaciones similares detectada en un intervalo corto (${matchingItems.length + 1} publicaciones creadas en pocos minutos).`,
        user_friendly_message: 'Se detectaron múltiples publicaciones similares en un lapso muy breve. Por favor esperá antes de publicar nuevamente.',
        matchCount: matchingItems.length,
      };
    }
  }

  // 3. REGLA DE PROTECCIÓN: Encuentros legítimos diferenciados (días distintos, horarios distintos, zonas distintas)
  const allDifferentiated = matchingItems.every(({ prev }) => {
    const prevFecha = prev.fecha ? prev.fecha.trim() : null;
    const prevHora = prev.hora ? prev.hora.trim().slice(0, 5) : null;
    const prevZona = (prev.zona || prev.open_public_zone || prev.locality_id || '').trim().toLowerCase();

    const diffFecha = Boolean(candFecha && prevFecha && candFecha !== prevFecha);
    const diffHora = Boolean(candHora && prevHora && candHora !== prevHora);
    const diffZona = Boolean(candZona && prevZona && candZona !== prevZona);

    return diffFecha || diffHora || diffZona;
  });

  if (allDifferentiated) {
    return {
      isDuplicate: false,
      similarity: maxSimilarity,
      matchedEncounterId: bestMatchId,
      isExactMatch: false,
      decision: 'allow',
      explanation_for_moderator: 'Contenido similar pero con fecha, horario o zona diferenciada legítima (encuentro recurrente).',
      matchCount: matchingItems.length,
    };
  }

  // 4. REGLA CONSERVADORA ANTE AMBIGÜEDAD (Sin diferenciación estructural explícita pero sin ráfaga)
  // Nunca BLOCK: pasa a revisión humana en /internal/moderation
  return {
    isDuplicate: true,
    similarity: maxSimilarity,
    matchedEncounterId: bestMatchId,
    isExactMatch: false,
    decision: 'review',
    reason_code: 'duplicate_content',
    explanation_for_moderator: `Publicación con alta similitud (${Math.round(maxSimilarity * 100)}%) respecto a otra reciente del mismo anfitrión. Requiere verificación humana.`,
    user_friendly_message: 'Estamos revisando esta publicación antes de mostrarla públicamente.',
    matchCount: matchingItems.length,
  };
}
