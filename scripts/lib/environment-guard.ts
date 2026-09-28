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

/**
 * Reads a named variable from process.env or .env.local (not versioned).
 * Aborts with a clear security error if the variable is absent.
 */
function requireEnvVar(name: string, description: string): string {
  if (process.env[name]) {
    return process.env[name] as string;
  }

  // Fallback: read from .env.local if it exists
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(new RegExp(name + '\\s*=\\s*([^\\r\\n]+)'));
      if (match && match[1]) {
        return match[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Silently continue to error below
  }

  console.error('\n==========================================================');
  console.error(`[CRITICAL SECURITY ERROR] ${name} not found.`);
  console.error(`Required for: ${description}`);
  console.error('Define it in your environment or in .env.local (not versioned).');
  console.error('Script aborted. No credentials are printed.');
  console.error('==========================================================\n');
  throw new Error(`Execution aborted: ${name} is required and missing.`);
}

/**
 * Returns the Staging publishable key (sb_publishable_...) for use in
 * Supabase JS client calls within QA scripts (replaces legacy anon key).
 */
export function getStagingPublishableKey(): string {
  return requireEnvVar(
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    'Supabase JS client in staging E2E scripts'
  );
}

/**
 * Returns the Staging secret key (sb_secret_...) for use in admin
 * service-role calls within QA scripts (replaces legacy service_role key).
 */
export function getStagingSecretKey(): string {
  return requireEnvVar(
    'SUPABASE_STAGING_SECRET_KEY',
    'Supabase admin client in staging E2E scripts'
  );
}

/**
 * @deprecated Use getStagingSecretKey() instead.
 * Kept as alias for backward compatibility while migrating scripts.
 */
export function getStagingServiceRoleKey(): string {
  // Try new secret key first, then fall back to old variable name
  try {
    return getStagingSecretKey();
  } catch {
    return requireEnvVar(
      'SUPABASE_STAGING_SERVICE_ROLE_KEY',
      'Legacy service_role key (migrate to SUPABASE_STAGING_SECRET_KEY)'
    );
  }
}
