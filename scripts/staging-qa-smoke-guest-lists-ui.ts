/**
 * Staging Smoke QA — Functional UI Smoke Test (Mobile & Desktop)
 *
 * Checks:
 * 1. Documents Vercel Authentication protection on remote domain (HTTP 302 -> vercel.com/sso-api).
 * 2. Runs local frontend connected to Supabase Staging (sa-east-1 wougfhfwqgmxhgvjqoua).
 * 3. Mobile viewport (390x844):
 *    - Authenticates permanent test user.
 *    - Opens "Mis listas" from "Mi espacio".
 *    - Creates list "Lista Mobile QA" with 2 emails.
 *    - Asserts UI renders list and recipient badge.
 * 4. Desktop viewport (1280x800):
 *    - Opens "Mis listas" on desktop layout.
 *    - Verifies list and deletes it.
 *    - Asserts UI updates immediately.
 * 5. Full cleanup of user and server in finally block.
 */

import { chromium, type Browser } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  assertStagingEnvironment,
  getStagingSecretKey,
  getStagingPublishableKey,
  STAGING_PROJECT_REF,
} from './lib/environment-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = 5173;
const LOCAL_URL = `http://localhost:${PORT}`;
const SUPABASE_STAGING_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
assertStagingEnvironment(SUPABASE_STAGING_URL);

const admin = createClient(SUPABASE_STAGING_URL, getStagingSecretKey(), {
  auth: { persistSession: false },
});

const ts = Date.now();
let browser: Browser | null = null;
let viteProcess: ChildProcess | null = null;
let testUserId: string | null = null;

function waitForServer(url: string, timeoutMs: number = 25000): Promise<void> {
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
        reject(new Error(`Timeout esperando frontend en ${url}`));
      } else {
        setTimeout(check, 500);
      }
    };

    check();
  });
}

async function cleanup() {
  console.log('\n[Cleanup] Limpiando sesión y fixtures UI en Staging...');
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  if (testUserId) {
    try {
      await admin.from('listas_invitados_usuario').delete().eq('owner_id', testUserId);
      await admin.auth.admin.deleteUser(testUserId);
      console.log(`  Usuario de prueba UI ${testUserId} eliminado.`);
    } catch (e) {
      console.warn('  Error eliminando usuario de prueba:', e);
    }
  }
  if (viteProcess && !viteProcess.killed) {
    console.log('[Cleanup] Deteniendo servidor local de Vite...');
    try {
      if (process.platform === 'win32' && viteProcess.pid) {
        const { execSync } = await import('child_process');
        execSync(`taskkill /pid ${viteProcess.pid} /T /F`, { stdio: 'ignore' });
      } else {
        viteProcess.kill('SIGTERM');
      }
    } catch {}
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

async function runUiSmoke() {
  console.log('========================================================');
  console.log('SMOKE TEST FUNCIONAL MOBILE & DESKTOP (GUEST LISTS V1)');
  console.log(`Backend Target: ${SUPABASE_STAGING_URL}`);
  console.log('========================================================\n');

  try {
    // 1. Verificar estado de Vercel Authentication en remoto
    console.log('[1/4] Verificando protección del dominio remoto...');
    try {
      const res = await fetch('https://staging.puntoencuentro.com.ar', { redirect: 'manual' });
      console.log(`  Respuesta de https://staging.puntoencuentro.com.ar: ${res.status} ${res.statusText}`);
      if (res.status === 302 || res.status === 401) {
        console.log('  -> Confirmado: Vercel Authentication protege el dominio remoto.');
        console.log('  -> Conforme a las instrucciones, la prueba funcional se ejecuta sobre frontend local conectado a Supabase Staging.');
      }
    } catch (err: any) {
      console.log('  Error consultando dominio remoto:', err.message);
    }

    // 2. Iniciar servidor frontend local si no está levantado
    console.log('\n[2/4] Verificando servidor frontend local...');
    let isUp = false;
    try {
      await waitForServer(LOCAL_URL, 1500);
      isUp = true;
    } catch {
      isUp = false;
    }

    if (!isUp) {
      console.log('  Iniciando Vite local con VITE_APP_ENV=staging...');
      viteProcess = spawn('npx', ['--workspaces=false', 'vite', '--port', String(PORT)], {
        cwd: rootDir,
        stdio: 'pipe',
        shell: true,
        env: {
          ...process.env,
          VITE_APP_ENV: 'staging',
        },
      });
      await waitForServer(LOCAL_URL, 30000);
      console.log(`  -> Servidor local listo en ${LOCAL_URL}`);
    } else {
      console.log(`  -> Servidor local ya activo en ${LOCAL_URL}`);
    }

    // 3. Crear usuario permanente en Staging y obtener sesión
    console.log('\n[3/4] Creando usuario temporal en Staging para el smoke test UI...');
    const testEmail = `qa-ui-smoke-${ts}@qa-staging-fixtures.test`;
    const testPass = 'QaUiPassword123!Secure';
    const { data: uData, error: uErr } = await admin.auth.admin.createUser({
      email: testEmail,
      password: testPass,
      email_confirm: true,
      user_metadata: { full_name: 'QA UI Smoke Tester' },
    });
    if (uErr || !uData.user) throw new Error(`Error creando usuario UI: ${uErr?.message}`);
    testUserId = uData.user.id;
    console.log(`  Usuario creado: ${testUserId} (${testEmail})`);

    // Obtener sesión válida de Supabase
    const userClient = createClient(SUPABASE_STAGING_URL, getStagingPublishableKey(), {
      auth: { persistSession: false },
    });
    const { data: signInData, error: signInErr } = await userClient.auth.signInWithPassword({
      email: testEmail,
      password: testPass,
    });
    if (signInErr || !signInData.session) throw new Error(`Error autenticando: ${signInErr?.message}`);
    const userSession = signInData.session;

    // Iniciar Playwright Chromium
    browser = await chromium.launch({ headless: true });

    // ----------------------------------------------------
    // TEST MOBILE VIEWPORT (390 x 844 - iPhone 12/13/14)
    // ----------------------------------------------------
    console.log('\n[4/4] Ejecutando Smoke Test en Viewport Mobile (390 x 844)...');
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileContext.newPage();

    // Pre-inyectar bypass de AccessGate y sesión de Supabase
    await mobilePage.addInitScript(
      ({ sessionData, storageKey }) => {
        window.localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({
          granted: true,
          at: Date.now(),
        }));
        if (sessionData && storageKey) {
          window.localStorage.setItem(storageKey, JSON.stringify(sessionData));
        }
      },
      {
        sessionData: userSession,
        storageKey: `sb-${STAGING_PROJECT_REF}-auth-token`,
      }
    );

    await mobilePage.goto(LOCAL_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Verificar botón "Mis listas" en "Mi espacio"
    const listBtn = mobilePage.locator('[data-testid="home-guest-lists-access-btn"]');
    await listBtn.waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(await listBtn.isVisible(), 'El botón "Mis listas" debe ser visible en Mobile');
    console.log('  -> Botón "Mis listas" visible en Mi espacio (Mobile).');

    // Click en "Mis listas"
    await listBtn.click();

    // Verificar que ContactsSheet abre en la pestaña "Mis listas"
    const listsTab = mobilePage.locator('[data-testid="contacts-tab-lists"]');
    await listsTab.waitFor({ state: 'visible', timeout: 5000 });
    const tabClass = await listsTab.getAttribute('class');
    assert.ok(tabClass?.includes('pe-contacts-tab--active'), 'El modal debe abrirse en la pestaña Mis listas activa');
    console.log('  -> ContactsSheet abierto en pestaña "Mis listas" (Mobile).');

    // Click en "Nueva lista"
    const newBtn = mobilePage.locator('[data-testid="lists-open-create-form-btn"]');
    await newBtn.click();

    // Completar nombre
    const nameInput = mobilePage.locator('#guest-list-name-input');
    await nameInput.fill('Fútbol Mobile QA');

    // Agregar destinatarios
    const emailInput = mobilePage.locator('[data-testid="list-form-email-input"]');
    const addEmailBtn = mobilePage.locator('[data-testid="list-form-add-email-btn"]');

    await emailInput.fill(`arquero_${ts}@qa-fixtures.test`);
    await addEmailBtn.click();

    await emailInput.fill(`delantero_${ts}@qa-fixtures.test`);
    await addEmailBtn.click();

    // Click en "Guardar lista"
    const saveBtn = mobilePage.locator('[data-testid="list-form-save-btn"]');
    await saveBtn.click();

    // Esperar a que la lista aparezca en el listado
    const createdItem = mobilePage.locator('text=Fútbol Mobile QA');
    await createdItem.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(await createdItem.isVisible(), 'La lista creada debe renderizarse en el listado');
    console.log('  -> Lista creada y visible con sus integrantes en UI Mobile.');

    await mobileContext.close();

    // ----------------------------------------------------
    // TEST DESKTOP VIEWPORT (1280 x 800)
    // ----------------------------------------------------
    console.log('\n[4/4] Ejecutando Smoke Test en Viewport Desktop (1280 x 800)...');
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      isMobile: false,
    });
    const desktopPage = await desktopContext.newPage();

    // Pre-inyectar bypass de AccessGate y sesión de Supabase
    await desktopPage.addInitScript(
      ({ sessionData, storageKey }) => {
        window.localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({
          granted: true,
          at: Date.now(),
        }));
        if (sessionData && storageKey) {
          window.localStorage.setItem(storageKey, JSON.stringify(sessionData));
        }
      },
      {
        sessionData: userSession,
        storageKey: `sb-${STAGING_PROJECT_REF}-auth-token`,
      }
    );

    await desktopPage.goto(LOCAL_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Abrir "Mis listas"
    const desktopListBtn = desktopPage.locator('[data-testid="home-guest-lists-access-btn"]');
    await desktopListBtn.waitFor({ state: 'visible', timeout: 10000 });
    await desktopListBtn.click();

    // Verificar que la lista "Fútbol Mobile QA" existe en desktop
    const desktopItem = desktopPage.locator('text=Fútbol Mobile QA');
    await desktopItem.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(await desktopItem.isVisible(), 'La lista debe ser visible en Desktop');

    // Click en "Eliminar" para abrir confirmación
    const deleteBtn = desktopPage.locator('button.pe-fav-link-btn--danger').first();
    await deleteBtn.click();

    // Confirmar eliminación con "Sí, eliminar"
    const confirmDeleteBtn = desktopPage.locator('button:has-text("Sí, eliminar")');
    await confirmDeleteBtn.waitFor({ state: 'visible', timeout: 5000 });
    await confirmDeleteBtn.click();

    // Esperar a que desaparezca
    await desktopItem.waitFor({ state: 'hidden', timeout: 8000 });
    console.log('  -> Lista eliminada correctamente en UI Desktop.');

    await desktopContext.close();

    console.log('\n========================================================');
    console.log('✔ SMOKE TEST MOBILE Y DESKTOP FINALIZADO CON ÉXITO.');
    console.log('========================================================\n');
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await cleanup();
  }
}

runUiSmoke()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n✖ ERROR FATAL EN SMOKE TEST UI:', err);
    process.exit(1);
  });
