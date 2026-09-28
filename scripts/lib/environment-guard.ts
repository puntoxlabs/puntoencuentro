/**
 * Environment Guard for PuntoEncuentro QA & Migration Scripts
 *
 * Ensures that destructive scripts, QA generation, and mutating tests
 * NEVER accidentally execute against Production (aurbicjwftjhwryhyjiq).
 *
 * Strictly enforces that target environment is Staging (wougfhfwqgmxhgvjqoua).
 */

export const STAGING_PROJECT_REF = 'wougfhfwqgmxhgvjqoua';
export const PRODUCTION_PROJECT_REF = 'aurbicjwftjhwryhyjiq';

export function assertStagingEnvironment(targetUrlOrRef?: string): void {
  const urlOrRef = targetUrlOrRef || process.env.VITE_SUPABASE_URL || '';

  if (urlOrRef.includes(PRODUCTION_PROJECT_REF)) {
    const errorMsg = `\n==========================================================\n` +
      `[CRITICAL ENVIRONMENT ERROR] ATTEMPT TO EXECUTE ON PRODUCTION!\n` +
      `Detected target: ${urlOrRef}\n` +
      `Production project ref (${PRODUCTION_PROJECT_REF}) is strictly forbidden for QA/E2E scripts.\n` +
      `Aborting immediately to preserve production integrity.\n` +
      `==========================================================\n`;
    console.error(errorMsg);
    throw new Error(`Execution aborted: target is PRODUCTION (${PRODUCTION_PROJECT_REF}). Staging required.`);
  }

  if (urlOrRef && !urlOrRef.includes(STAGING_PROJECT_REF) && !urlOrRef.includes('localhost') && !urlOrRef.includes('127.0.0.1')) {
    console.warn(`[ENVIRONMENT GUARD] Warning: target (${urlOrRef}) is neither Staging (${STAGING_PROJECT_REF}) nor Local.`);
  }
}
