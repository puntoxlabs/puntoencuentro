/**
 * Environment Guard for PuntoEncuentro QA & Migration Scripts
 *
 * Ensures that destructive scripts, QA generation, and mutating tests
 * NEVER accidentally execute against Production (aurbicjwftjhwryhyjiq).
 *
 * Strictly enforces that target environment is Staging (wougfhfwqgmxhgvjqoua).
 */

import fs from 'node:fs';
import path from 'node:path';

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

export function getStagingServiceRoleKey(): string {
  if (process.env.SUPABASE_STAGING_SERVICE_ROLE_KEY) {
    return process.env.SUPABASE_STAGING_SERVICE_ROLE_KEY;
  }

  // Fallback: leer de .env.local no versionado si existe
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/SUPABASE_STAGING_SERVICE_ROLE_KEY\s*=\s*([^\r\n]+)/);
      if (match && match[1]) {
        return match[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Silently continue to error exit below
  }

  console.error('\n==========================================================');
  console.error('[CRITICAL SECURITY ERROR] SUPABASE_STAGING_SERVICE_ROLE_KEY no encontrada.');
  console.error('Para ejecutar scripts E2E en Staging, defina la variable en su entorno o en .env.local (no versionado).');
  console.error('El script se aborta inmediatamente sin exponer credenciales.');
  console.error('==========================================================\n');
  throw new Error('Execution aborted: SUPABASE_STAGING_SERVICE_ROLE_KEY is required and missing.');
}
