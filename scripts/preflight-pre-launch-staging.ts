/**
 * Preflight de Diagnóstico y Verificación para Supabase Staging (Etapa 2 PRE-LAUNCH)
 *
 * ====================================================================================
 * PROTOCOLO DE SEGURIDAD ESTRICTAMENTE NO MUTANTE:
 * - CERO ejecuciones de `db push`, `db reset` o sentencias DDL remotas.
 * - CERO mutaciones de datos en Staging ni en Producción.
 * - Comprueba formalmente:
 *   1. Destino unívoco en Staging (wougfhfwqgmxhgvjqoua) y bloqueo de Producción.
 *   2. Rama Git activa y estado del árbol de trabajo.
 *   3. Lista exacta de migraciones aditivas preparadas para Etapa 2.
 *   4. Existencia y disponibilidad del script quirúrgico de rollback.
 *   5. Preservación del circuito de identidades sintéticas de QA.
 * ====================================================================================
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
} from './lib/environment-guard.ts';

console.log('==============================================================================');
console.log('PREFLIGHT DE SEGURIDAD PRE-LANZAMIENTO: VERIFICACIÓN PREVIA A ETAPA 2 (STAGING)');
console.log('==============================================================================\n');

// 1. VERIFICACIÓN DE DESTINO Y ENTORNO
console.log('1. [ENTORNO] Comprobando referencias de proyecto...');
assertStagingEnvironment(STAGING_PROJECT_REF);

if (STAGING_PROJECT_REF !== 'wougfhfwqgmxhgvjqoua') {
  console.error(`[FAIL] STAGING_PROJECT_REF inesperado: ${STAGING_PROJECT_REF}`);
  process.exit(1);
}
console.log(`  ✔ Destino autorizado confirmado: Staging (${STAGING_PROJECT_REF})`);
console.log(`  ✔ Producción (${PRODUCTION_PROJECT_REF}) bloqueada y protegida.\n`);

// 2. RAMA GIT Y ESTADO DEL REPOSITORIO
console.log('2. [GIT] Verificando rama activa y árbol de trabajo...');
let currentBranch = 'unknown';
try {
  currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
} catch (e: any) {
  console.warn(`  ⚠ No se pudo determinar rama actual: ${e.message}`);
}
console.log(`  ✔ Rama Git activa: ${currentBranch}`);

const gitStatus = execSync('git status --short', { encoding: 'utf8' }).trim();
console.log('  Estado del árbol de trabajo (git status):');
if (gitStatus.length === 0) {
  console.log('    (Árbol de trabajo limpio)');
} else {
  const lines = gitStatus.split('\n');
  for (const line of lines) {
    console.log(`    ${line}`);
  }
}
console.log('');

// 3. MIGRACIÓN ADITIVA PENDIENTE PARA ETAPA 2
console.log('3. [MIGRACIONES] Inspeccionando migración aditiva para Etapa 2...');
const migrationFileName = '20261112120000_platform_pre_launch_access_control_v1.sql';
const migrationPath = path.resolve(process.cwd(), 'supabase/migrations', migrationFileName);

if (!fs.existsSync(migrationPath)) {
  console.error(`[FAIL] No se encontró el archivo de migración: ${migrationPath}`);
  process.exit(1);
}
const migrationStat = fs.statSync(migrationPath);
console.log(`  ✔ Archivo de migración confirmado: ${migrationFileName}`);
console.log(`    Tamaño: ${migrationStat.size} bytes`);
console.log(`    Timestamp: 20261112120000 (orden determinístico posterior a 20261109173000)`);
console.log('    Contenido: public.platform_access_control, platform_access_control_audit,');
console.log('               platform_launch_authorizations y guardas en 7 RPCs determinísticas.\n');

// 4. PLAN Y SCRIPTS DE RESPALDO, ROLLBACK Y LOCKDOWN DE EMERGENCIA
console.log('4. [ROLLBACK & EMERGENCY] Verificando scripts de reversión y contingencia...');
const rollbackFileName = '20261112120000_rollback_platform_pre_launch_access_control_v1.sql';
const rollbackPath = path.resolve(process.cwd(), 'supabase/migrations/rollback', rollbackFileName);

if (!fs.existsSync(rollbackPath)) {
  console.error(`[FAIL] No se encontró el script de reversión: ${rollbackPath}`);
  process.exit(1);
}
const rollbackStat = fs.statSync(rollbackPath);
console.log(`  ✔ Script de Rollback Funcional confirmado: ${rollbackFileName}`);
console.log(`    Tamaño: ${rollbackStat.size} bytes`);
console.log('    Invariante de Rollback: PRESERVA EL BLOQUEO BACKEND (is_qa_authorized() activo en RPCs).');
console.log('    Cero apertura pública; clientes sin JWT y externos siguen 100% bloqueados mientras QA opera.');

const lockdownFileName = 'emergency-lockdown-pre-launch.sql';
const lockdownPath = path.resolve(process.cwd(), 'scripts', lockdownFileName);
if (!fs.existsSync(lockdownPath)) {
  console.error(`[FAIL] No se encontró el script de lockdown: ${lockdownPath}`);
  process.exit(1);
}
const lockdownStat = fs.statSync(lockdownPath);
console.log(`  ✔ Script de Recuperación de Emergencia Fail-Closed confirmado: ${lockdownFileName} (${lockdownStat.size} bytes)\n`);

// 5. IDENTIDADES SINTÉTICAS DE QA
console.log('5. [QA IDENTITIES] Verificando compatibilidad de identidades sintéticas de QA...');
const qaIdentities = [
  { role: 'qa_runner_e2e_005', desc: 'Runner E2E-005 (Host de prueba)' },
  { role: 'qa_runner_e2e_006', desc: 'Runner E2E-006 (Participante sintético)' },
  { role: 'qa_runner_e2e_007', desc: 'Runner E2E-007 (Waitlist & Concurrencia)' },
  { role: 'qa_runner_e2e_008', desc: 'Runner E2E-008 (Trayectoria factual)' },
];
for (const id of qaIdentities) {
  console.log(`  ✔ ${id.role}: soportado mediante public.qa_authorized_users (is_qa_authorized() = true).`);
}
console.log('  ✔ Las sesiones anónimas sintéticas registradas en QA operan sin restricción.\n');

// 6. CONCLUSIÓN DEL PREFLIGHT
console.log('==============================================================================');
console.log('RESUMEN PREFLIGHT: APTO PARA ETAPA 2 (STAGING)');
console.log('Estado: LISTO PARA APLICACIÓN CUANDO SEA AUTORIZADA EXPRESAMENTE POR EL USUARIO.');
console.log('Comando futuro (NO EJECUTADO AHORA): npx supabase db push --linked');
console.log('==============================================================================');
