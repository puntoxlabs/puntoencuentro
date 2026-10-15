/**
 * Detección determinista de duplicados para Moderación v1.1
 * Compara publicaciones del mismo usuario en una ventana de tiempo razonable (ej. 24 horas).
 * Sin LLMs ni embeddings: usa normalización canónica y similitud de n-gramas de palabras.
 */

import { canonicalizeForComparison } from './normalizer.ts';

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  similarity: number; // 0.0 a 1.0
  matchedEncounterId?: string;
  isExactMatch: boolean;
}

/**
 * Calcula similitud de Jaccard sobre conjuntos de n-gramas de palabras.
 */
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

/**
 * Compara el contenido de una publicación candidata contra publicaciones previas del mismo host.
 */
export function checkDuplicateContent(
  candidateTitle: string,
  candidateDescription: string = '',
  recentHistory: { id: string; title: string; description?: string | null; created_at?: string }[] = [],
  similarityThreshold: number = 0.85
): DuplicateCheckResult {
  if (!recentHistory || recentHistory.length === 0) {
    return { isDuplicate: false, similarity: 0, isExactMatch: false };
  }

  const candidateCombined = `${candidateTitle} ${candidateDescription || ''}`.trim();
  const normCandidate = canonicalizeForComparison(candidateCombined);

  let maxSimilarity = 0;
  let bestMatchId: string | undefined = undefined;

  for (const prev of recentHistory) {
    const prevCombined = `${prev.title} ${prev.description || ''}`.trim();
    const normPrev = canonicalizeForComparison(prevCombined);

    if (normCandidate === normPrev && normCandidate.length > 5) {
      return {
        isDuplicate: true,
        similarity: 1.0,
        matchedEncounterId: prev.id,
        isExactMatch: true,
      };
    }

    const sim = calculateWordJaccard(candidateCombined, prevCombined);
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      bestMatchId = prev.id;
    }
  }

  const isDup = maxSimilarity >= similarityThreshold;

  return {
    isDuplicate: isDup,
    similarity: maxSimilarity,
    matchedEncounterId: isDup ? bestMatchId : undefined,
    isExactMatch: false,
  };
}
