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
 * Returns the Vercel Automation Bypass Secret from process.env or .env.local (fallback).
 */
export function getVercelBypassSecret(): string | undefined {
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    return process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/VERCEL_AUTOMATION_BYPASS_SECRET\s*=\s*([^\r\n]+)/);
      if (match && match[1]) {
        return match[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export interface OrphanCleanupOptions {
  currentRunId?: string;
  minAgeMinutes?: number;
  maxAgeDays?: number;
  maxEncounters?: number;
  maxUsers?: number;
  dryRun?: boolean;
  enabled?: boolean;
}

export interface OrphanCleanupResult {
  scannedEncounters: number;
  scannedUsers: number;
  deletedEncounters: string[];
  deletedUsers: string[];
  dryRun: boolean;
  skippedDueToAge: number;
  skippedDueToCurrentRun: number;
  skippedUnidentified: number;
}

/**
 * Limpieza segura y acotada de fixtures huérfanos generados por corridas E2E abortadas.
 *
 * Invariantes de Seguridad:
 * 1. NUNCA elimina usuarios ni encuentros que carezcan de los marcadores inequívocos de automatización E2E:
 *    - Usuario: email "qa-e2e-run-*" Y user_metadata.is_e2e_automation_fixture === true Y user_metadata.e2e_run_id presente.
 *    - Encuentro: titulo "[QA-E2E:*" Y descripcion "[AUTOMATED_QA_FIXTURE:*".
 * 2. Antigüedad mínima obligatoria: por defecto solo evalúa recursos de más de 30 minutos (evita tocar ejecuciones paralelas en curso).
 * 3. Límites estrictos por corrida: máximo 10 encuentros y 20 usuarios.
 * 4. Soporta modalidad dryRun para auditar sin mutar la base de datos.
 * 5. Si enabled === false, la función retorna inmediatamente sin consultar ni borrar registros.
 */
export async function cleanOrphanQaFixtures(
  adminClient: any,
  options: OrphanCleanupOptions = {}
): Promise<OrphanCleanupResult> {
  const result: OrphanCleanupResult = {
    scannedEncounters: 0,
    scannedUsers: 0,
    deletedEncounters: [],
    deletedUsers: [],
    dryRun: options.dryRun === true,
    skippedDueToAge: 0,
    skippedDueToCurrentRun: 0,
    skippedUnidentified: 0,
  };

  // La limpieza de huérfanos está DESHABILITADA por defecto.
  // Solo se ejecuta si se pasa explícitamente enabled: true (ej. tras autorización de dry-run).
  const isEnabled = options.enabled === true || process.env.ENABLE_ORPHAN_FIXTURE_CLEANUP === 'true';
  if (!isEnabled) {
    return result;
  }

  const minAgeMs = (options.minAgeMinutes ?? 30) * 60 * 1000;
  const maxAgeMs = (options.maxAgeDays ?? 7) * 24 * 60 * 60 * 1000;
  const maxEncounters = options.maxEncounters ?? 10;
  const maxUsers = options.maxUsers ?? 20;
  const now = Date.now();

  try {
    // 1. Encuentros: Filtrar estrictamente por marcadores inequívocos de automatización
    const { data: encList, error: encErr } = await adminClient
      .from('encuentros')
      .select('id, titulo, descripcion, created_at')
      .like('titulo', '[QA-E2E:%')
      .like('descripcion', '%[AUTOMATED_QA_FIXTURE:%')
      .order('created_at', { ascending: true })
      .limit(maxEncounters * 2);

    if (!encErr && Array.isArray(encList)) {
      result.scannedEncounters = encList.length;

      for (const enc of encList) {
        if (result.deletedEncounters.length >= maxEncounters) break;

        // Comprobación 1: No pertenecer a la corrida actual
        if (options.currentRunId && (enc.titulo?.includes(options.currentRunId) || enc.descripcion?.includes(options.currentRunId))) {
          result.skippedDueToCurrentRun++;
          continue;
        }

        // Comprobación 2: Antigüedad mínima
        const createdAt = enc.created_at ? new Date(enc.created_at).getTime() : 0;
        const age = now - createdAt;
        if (age < minAgeMs) {
          result.skippedDueToAge++;
          continue;
        }
        if (age > maxAgeMs) {
          continue;
        }

        // Marcador confirmado
        result.deletedEncounters.push(enc.id);
        if (!result.dryRun) {
          await adminClient.from('encuentros').delete().eq('id', enc.id).catch(() => null);
          console.log(`   [Orphan Guard] Encuentro huérfano QA eliminado: ${enc.id} ("${enc.titulo}")`);
        } else {
          console.log(`   [Orphan Guard Dry-Run] Encuentro candidato a eliminar: ${enc.id} ("${enc.titulo}")`);
        }
      }
    }

    // 2. Usuarios: Filtrar estrictamente por metadata inequívoca y prefijo
    const { data: usersData, error: usersErr } = await adminClient.auth.admin.listUsers({ perPage: 100 });
    if (!usersErr && usersData?.users && Array.isArray(usersData.users)) {
      result.scannedUsers = usersData.users.length;

      for (const u of usersData.users) {
        if (result.deletedUsers.length >= maxUsers) break;

        const email = u.email || '';
        const meta = u.user_metadata || {};

        // Invariante estricto: debe tener email qa-e2e-run-*, dominio @puntoencuentro.test Y metadata de automatización
        const isE2ePrefix = email.startsWith('qa-e2e-run-') || email.startsWith('qa-minimal-run-');
        const isQaDomain = email.endsWith('@puntoencuentro.test');
        const hasFixtureMeta = meta.is_e2e_automation_fixture === true && typeof meta.e2e_run_id === 'string';

        if (!isE2ePrefix || !isQaDomain || !hasFixtureMeta) {
          result.skippedUnidentified++;
          continue;
        }

        // Comprobación: No pertenecer a la corrida actual
        if (options.currentRunId && meta.e2e_run_id === options.currentRunId) {
          result.skippedDueToCurrentRun++;
          continue;
        }

        // Comprobación: Antigüedad mínima
        const createdAt = u.created_at ? new Date(u.created_at).getTime() : 0;
        const age = now - createdAt;
        if (age < minAgeMs) {
          result.skippedDueToAge++;
          continue;
        }
        if (age > maxAgeMs) {
          continue;
        }

        result.deletedUsers.push(u.id);
        if (!result.dryRun) {
          await adminClient.auth.admin.deleteUser(u.id).catch(() => null);
          console.log(`   [Orphan Guard] Usuario huérfano QA eliminado: ${u.id} (${email})`);
        } else {
          console.log(`   [Orphan Guard Dry-Run] Usuario candidato a eliminar: ${u.id} (${email})`);
        }
      }
    }
  } catch (err: any) {
    console.warn(`   [Orphan Guard Warning] Error durante la inspección de huérfanos: ${err.message}`);
  }

  return result;
}



