import { validatePatchOutput } from '../../supabase/functions/ai-interpret/validation.ts';
import type { EncounterDraftPatch } from '../../src/lib/encounterDraftPatch.ts';

export interface ExpectedGroundTruth {
  title?: string | null;
  dateIntent?: {
    type: 'absolute' | 'relative' | 'weekday' | 'range' | 'vague';
    day?: number;
    month?: number;
    year?: number;
    value?: string;
    weekday?: string;
    modifier?: 'this' | 'next';
    values?: string[];
  } | null;
  timeIntent?: {
    type: 'exact' | 'approximate' | 'period' | 'after' | 'range' | 'vague';
    hour?: number;
    minute?: number;
    value?: string;
    startHour?: number;
    startMinute?: number;
    endHour?: number;
    endMinute?: number;
  } | null;
  modality?: 'presencial' | 'virtual' | null;
  locationText?: string | null;
  virtualLink?: string | null;
  dateModeSignal?: 'fixed' | 'coordination' | null;
  themeHint?: string | null;
  isAmbiguous?: boolean;
  isCoordination?: boolean;
}

export interface CaseScoreResult {
  caseId: number;
  status: 'success' | 'provider_error';
  httpStatus?: number;
  error?: string;
  schemaCompliant: boolean;
  schemaError?: string;
  exactMatches: number;
  expectedTotal: number;
  exactExtractionRate: number; // percentage 0 - 100
  omissions: number;
  omissionRate: number; // percentage 0 - 100
  hallucinations: number;
  hallucinationDetails: string[];
  ambiguityCorrect: boolean | null;
}

export interface AggregatedBenchmarkScore {
  totalCases: number;
  successfulCases: number;
  failedCases: number;
  apiSuccessRate: number;
  apiFailureRate: number;
  failureReasons: string[];
  evaluableCases: number;
  validSchemaPercentage: number;
  exactExtractionRate: number;
  omissionRate: number;
  hallucinationRate: number;
  ambiguityDetectionRate: number;
}

function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Evaluates a single LLM output patch against ground truth expectations.
 */
export function scoreTestCase(
  caseId: number,
  rawPatch: unknown,
  expected: ExpectedGroundTruth
): CaseScoreResult {
  const schemaValidation = validatePatchOutput(rawPatch);
  const schemaCompliant = schemaValidation.valid;
  const schemaError = schemaValidation.error;

  const patch = (schemaCompliant ? rawPatch : {}) as EncounterDraftPatch;

  let exactMatches = 0;
  let expectedTotal = 0;
  let omissions = 0;
  let hallucinations = 0;
  const hallucinationDetails: string[] = [];

  // 1. Title evaluation
  if (expected.title !== undefined) {
    if (expected.title !== null) {
      expectedTotal++;
      if (patch.title?.value && typeof patch.title.value === 'string') {
        const patchNorm = normalizeString(patch.title.value);
        const expNorm = normalizeString(expected.title);
        if (patchNorm.includes(expNorm) || expNorm.includes(patchNorm)) {
          exactMatches++;
        } else {
          omissions++;
        }
      } else {
        omissions++;
      }
    } else {
      // Expected no title
      if (patch.title?.value) {
        hallucinations++;
        hallucinationDetails.push('Invented title when none was present');
      }
    }
  }

  // 2. DateIntent evaluation
  if (expected.dateIntent !== undefined) {
    if (expected.dateIntent !== null) {
      expectedTotal++;
      const pDate = patch.dateIntent?.value;
      if (pDate && pDate.type === expected.dateIntent.type) {
        let matches = true;

        if (expected.dateIntent.type === 'weekday') {
          if (expected.dateIntent.weekday) {
            matches = normalizeString(pDate.weekday || '') === normalizeString(expected.dateIntent.weekday);
          }
          if (matches && expected.dateIntent.modifier) {
            matches = pDate.modifier === expected.dateIntent.modifier;
          }
        } else if (expected.dateIntent.type === 'relative') {
          if (expected.dateIntent.value) {
            matches = pDate.value === expected.dateIntent.value;
          }
        } else if (expected.dateIntent.type === 'absolute') {
          if (expected.dateIntent.day !== undefined) {
            matches = matches && pDate.day === expected.dateIntent.day;
          }
          if (expected.dateIntent.month !== undefined) {
            matches = matches && pDate.month === expected.dateIntent.month;
          }
          // Ajuste 3: If expected.year is undefined, the model MUST NOT invent a year
          if (expected.dateIntent.year === undefined && pDate.year !== undefined) {
            hallucinations++;
            hallucinationDetails.push(`Ajuste 3 violation: Invented year ${pDate.year} for date without year`);
            matches = false;
          }
        } else if (expected.dateIntent.type === 'range') {
          matches = pDate.type === 'range';
        }

        if (matches) {
          exactMatches++;
        } else {
          omissions++;
        }
      } else {
        omissions++;
      }
    } else {
      // Expected no date
      if (patch.dateIntent?.value) {
        hallucinations++;
        hallucinationDetails.push('Invented dateIntent when none was present');
      }
    }
  }

  // 3. TimeIntent evaluation
  if (expected.timeIntent !== undefined) {
    if (expected.timeIntent !== null) {
      expectedTotal++;
      const pTime = patch.timeIntent?.value;
      if (pTime) {
        let matches = false;
        if (expected.timeIntent.type === 'exact' || expected.timeIntent.type === 'approximate') {
          if (pTime.type === 'exact' || pTime.type === 'approximate') {
            matches = pTime.hour === expected.timeIntent.hour;
            if (matches && expected.timeIntent.minute !== undefined) {
              matches = pTime.minute === expected.timeIntent.minute;
            }
          }
        } else if (expected.timeIntent.type === 'period') {
          matches = pTime.type === 'period' && pTime.value === expected.timeIntent.value;
        } else if (expected.timeIntent.type === 'after') {
          matches = pTime.type === 'after' && pTime.hour === expected.timeIntent.hour;
        } else if (expected.timeIntent.type === 'range') {
          matches = pTime.type === 'range';
        }

        if (matches) {
          exactMatches++;
        } else {
          omissions++;
        }
      } else {
        omissions++;
      }
    } else {
      // Expected no time
      if (patch.timeIntent?.value) {
        hallucinations++;
        hallucinationDetails.push('Invented timeIntent when none was present');
      }
    }
  }

  // 4. Modality evaluation (Crucial: NO silent default!)
  if (expected.modality !== undefined) {
    if (expected.modality !== null) {
      expectedTotal++;
      if (patch.modality?.value === expected.modality) {
        exactMatches++;
      } else {
        omissions++;
      }
    } else {
      // Modality must be null/omitted. If model invented presencial or virtual, that is a hallucination.
      if (patch.modality?.value) {
        hallucinations++;
        hallucinationDetails.push(`Hallucinated modality '${patch.modality.value}' when none was indicated`);
      }
    }
  }

  // 5. LocationText evaluation
  if (expected.locationText !== undefined) {
    if (expected.locationText !== null) {
      expectedTotal++;
      if (patch.locationText?.value) {
        const pLoc = normalizeString(patch.locationText.value);
        const expLoc = normalizeString(expected.locationText);
        if (pLoc.includes(expLoc) || expLoc.includes(pLoc)) {
          exactMatches++;
        } else {
          omissions++;
        }
      } else {
        omissions++;
      }
    } else {
      if (patch.locationText?.value) {
        hallucinations++;
        hallucinationDetails.push(`Hallucinated location '${patch.locationText.value}'`);
      }
    }
  }

  // 6. VirtualLink evaluation
  if (expected.virtualLink !== undefined) {
    if (expected.virtualLink !== null) {
      expectedTotal++;
      if (patch.virtualLink?.value && patch.virtualLink.value.includes(expected.virtualLink)) {
        exactMatches++;
      } else {
        omissions++;
      }
    } else {
      if (patch.virtualLink?.value) {
        hallucinations++;
        hallucinationDetails.push('Hallucinated virtual link');
      }
    }
  }

  // 7. Coordination Intent evaluation
  if (expected.isCoordination) {
    expectedTotal++;
    const isDetected =
      patch.dateModeSignal?.value === 'coordination' ||
      patch.dateIntent?.value?.type === 'range';
    if (isDetected) {
      exactMatches++;
    } else {
      omissions++;
    }
  }

  // 8. Ambiguity Handling evaluation
  let ambiguityCorrect: boolean | null = null;
  if (expected.isAmbiguous) {
    const isFlaggedAmbiguous =
      patch.timeIntent?.confidence === 'ambiguous' ||
      patch.timeIntent?.confidence === 'inferred_low' ||
      patch.dateIntent?.confidence === 'ambiguous' ||
      patch.dateIntent?.confidence === 'inferred_low' ||
      patch.timeIntent?.value?.type === 'period' ||
      patch.timeIntent?.value?.type === 'approximate' ||
      patch.timeIntent?.value?.type === 'after' ||
      patch.timeIntent?.value?.type === 'range' ||
      patch.dateIntent?.value?.type === 'range' ||
      patch.dateIntent?.value?.type === 'vague';

    ambiguityCorrect = !!isFlaggedAmbiguous;
  }

  const exactExtractionRate = expectedTotal > 0 ? (exactMatches / expectedTotal) * 100 : 100;
  const omissionRate = expectedTotal > 0 ? (omissions / expectedTotal) * 100 : 0;

  return {
    caseId,
    status: 'success',
    schemaCompliant,
    schemaError,
    exactMatches,
    expectedTotal,
    exactExtractionRate: Math.round(exactExtractionRate * 10) / 10,
    omissions,
    omissionRate: Math.round(omissionRate * 10) / 10,
    hallucinations,
    hallucinationDetails,
    ambiguityCorrect,
  };
}

/**
 * Creates a provider error score object representing an infrastructure/transport failure.
 * Provider errors are tracked separately and excluded from semantic quality metrics.
 */
export function createProviderErrorScore(
  caseId: number,
  httpStatus?: number,
  errorMessage?: string
): CaseScoreResult {
  return {
    caseId,
    status: 'provider_error',
    httpStatus,
    error: errorMessage,
    schemaCompliant: false,
    schemaError: errorMessage,
    exactMatches: 0,
    expectedTotal: 0,
    exactExtractionRate: 0,
    omissions: 0,
    omissionRate: 0,
    hallucinations: 0,
    hallucinationDetails: [],
    ambiguityCorrect: null,
  };
}

/**
 * Aggregates individual case scores into benchmark summary metrics.
 * Separates provider/API infrastructure failures from semantic quality evaluation.
 */
export function aggregateScores(caseScores: CaseScoreResult[]): AggregatedBenchmarkScore {
  const totalCases = caseScores.length;
  if (totalCases === 0) {
    return {
      totalCases: 0,
      successfulCases: 0,
      failedCases: 0,
      apiSuccessRate: 0,
      apiFailureRate: 0,
      failureReasons: [],
      evaluableCases: 0,
      validSchemaPercentage: 0,
      exactExtractionRate: 0,
      omissionRate: 0,
      hallucinationRate: 0,
      ambiguityDetectionRate: 0,
    };
  }

  const failed = caseScores.filter((c) => c.status === 'provider_error');
  const evaluable = caseScores.filter((c) => c.status === 'success');

  const successfulCases = evaluable.length;
  const failedCases = failed.length;
  const apiSuccessRate = Math.round((successfulCases / totalCases) * 1000) / 10;
  const apiFailureRate = Math.round((failedCases / totalCases) * 1000) / 10;

  const failureReasons = Array.from(
    new Set(failed.map((c) => c.error || (c.httpStatus ? `HTTP ${c.httpStatus}` : 'Unknown provider error')))
  );

  // If there are no evaluable cases, semantic metrics are 0
  if (evaluable.length === 0) {
    return {
      totalCases,
      successfulCases: 0,
      failedCases,
      apiSuccessRate,
      apiFailureRate,
      failureReasons,
      evaluableCases: 0,
      validSchemaPercentage: 0,
      exactExtractionRate: 0,
      omissionRate: 0,
      hallucinationRate: 0,
      ambiguityDetectionRate: 0,
    };
  }

  const validSchemaCount = evaluable.filter((c) => c.schemaCompliant).length;
  const sumExactRate = evaluable.reduce((acc, c) => acc + c.exactExtractionRate, 0);
  const sumOmissionRate = evaluable.reduce((acc, c) => acc + c.omissionRate, 0);
  const casesWithHallucination = evaluable.filter((c) => c.hallucinations > 0).length;

  const ambiguityCases = evaluable.filter((c) => c.ambiguityCorrect !== null);
  const correctAmbiguityCount = ambiguityCases.filter((c) => c.ambiguityCorrect === true).length;
  const ambiguityDetectionRate =
    ambiguityCases.length > 0 ? (correctAmbiguityCount / ambiguityCases.length) * 100 : 100;

  return {
    totalCases,
    successfulCases,
    failedCases,
    apiSuccessRate,
    apiFailureRate,
    failureReasons,
    evaluableCases: evaluable.length,
    validSchemaPercentage: Math.round((validSchemaCount / evaluable.length) * 1000) / 10,
    exactExtractionRate: Math.round((sumExactRate / evaluable.length) * 10) / 10,
    omissionRate: Math.round((sumOmissionRate / evaluable.length) * 10) / 10,
    hallucinationRate: Math.round((casesWithHallucination / evaluable.length) * 1000) / 10,
    ambiguityDetectionRate: Math.round(ambiguityDetectionRate * 10) / 10,
  };
}
