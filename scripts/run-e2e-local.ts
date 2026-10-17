import { spawn, ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStagingEnvironment, STAGING_PROJECT_REF } from './lib/environment-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

// 1. Guardrail estricto de seguridad: validar que no se apunte a Producción
const SUPABASE_TARGET = process.env.VITE_SUPABASE_URL || 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(SUPABASE_TARGET);
assertStagingEnvironment(STAGING_PROJECT_REF);

console.log('================================================================');
console.log('RUNNER QA E2E LOCAL — PUNTOENCUENTRO');
console.log(`Frontend Local:  ${BASE_URL}`);
console.log(`Supabase Target: ${SUPABASE_TARGET} (Staging)`);
console.log('Seguridad:       Staging validado. Producción bloqueada.');
console.log('================================================================\n');

let viteProcess: ChildProcess | null = null;

function waitForServer(url: string, timeoutMs: number = 30000): Promise<void> {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode && res.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      });
      req.on('error', () => retry());
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Timeout esperando que el servidor responda en ${url}`));
      } else {
        setTimeout(check, 500);
      }
    };

    check();
  });
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: 'inherit',
      shell: true,
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function cleanup() {
  if (viteProcess && !viteProcess.killed) {
    console.log('\n[Runner] Deteniendo servidor local de Vite...');
    viteProcess.kill('SIGTERM');
    // En Windows a veces se requiere SIGKILL si el child process de shell no propaga
    setTimeout(() => {
      if (viteProcess && !viteProcess.killed) {
        try {
          viteProcess.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 2000);
  }
}

process.once('SIGINT', async () => {
  await cleanup();
  process.exit(1);
});

process.once('SIGTERM', async () => {
  await cleanup();
  process.exit(1);
});

async function main() {
  try {
    // A. Iniciar servidor Vite
    console.log('[1/4] Iniciando frontend local con Vite...');
    viteProcess = spawn('npx', ['--workspaces=false', 'vite', '--port', String(PORT)], {
      cwd: rootDir,
      stdio: 'pipe',
      shell: true,
      env: {
        ...process.env,
        VITE_APP_ENV: 'staging',
      },
    });

    viteProcess.stderr?.on('data', (d) => {
      const msg = d.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.warn(`[Vite Error]: ${msg}`);
      }
    });

    // B. Esperar a que el servidor esté listo
    console.log(`[2/4] Esperando disponibilidad en ${BASE_URL}...`);
    await waitForServer(BASE_URL);
    console.log('   -> Servidor local listo y respondiendo HTTP 200.\n');

    const testEnv = {
      ...process.env,
      BASE_URL,
    };

    // C. Ejecutar Prueba Mínima (Gate obligatorio)
    console.log('[3/4] Ejecutando Prueba Mínima Obligatoria (HOST-01)...');
    const minimalCode = await runCommand('npx', ['--workspaces=false', 'tsx', 'scripts/e2e-minimal-test.ts'], testEnv);
    if (minimalCode !== 0) {
      console.error(`\n❌ ERROR: La prueba mínima falló con código de salida ${minimalCode}. Abortando suite completa.`);
      process.exit(minimalCode);
    }
    console.log('   -> Prueba mínima aprobada exitosamente.\n');

    // D. Ejecutar Suite Completa H1-H10
    console.log('[4/4] Ejecutando Suite E2E Completa H1–H10...');
    const fullCode = await runCommand('npx', ['--workspaces=false', 'tsx', 'scripts/e2e-staging-playwright.ts'], testEnv);
    if (fullCode !== 0) {
      console.error(`\n❌ ERROR: La suite completa finalizó con código de salida ${fullCode}.`);
      process.exit(fullCode);
    }
    console.log('   -> Suite E2E completa finalizada exitosamente.\n');

  } catch (err: any) {
    console.error(`\n❌ Excepción durante la ejecución de QA: ${err.message}`);
    process.exit(1);
  } finally {
    await cleanup();
  }
}

main();
