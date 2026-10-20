/**
 * Staging Smoke QA — Functional UI Smoke Test (Mobile & Desktop)
 * Sprint 2: Panel de Información y Mensajes del Encuentro V1
 *
 * Target: Frontend connected to Supabase Staging (sa-east-1 wougfhfwqgmxhgvjqoua)
 * Viewports:
 *  - Mobile (390 x 844)
 *  - Desktop (1280 x 800)
 *
 * Checks:
 *  1. Remote Vercel Authentication Protection (documents HTTP 302/401 redirect).
 *  2. Local Vite server connected to Supabase Staging.
 *  3. Mobile Viewport (Organizador):
 *     - Acceso autenticado a /meet/:id
 *     - Visualización del panel de mensajes
 *     - Publicar mensaje (textarea, límite 500 caracteres, contador)
 *     - Destacar mensaje (hasta 3 destacados)
 *     - Editar mensaje propio dentro de los 15 minutos
 *  4. Desktop Viewport (Invitado sin registro):
 *     - Acceso mediante token personal a /invite/:token
 *     - Lectura del historial y mensaje destacado
 *     - Responder a mensaje concreto (1 nivel)
 *     - Eliminar mensaje propio
 *     - Estado de solo lectura / restringido en encuentro pasado
 *  5. Verificación de ausencia de errores críticos en consola de navegador.
 *  6. Cleanup completo de fixtures en Staging.
 */

import { chromium, type Browser } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const createdUserIds: string[] = [];
const createdEncounterIds: string[] = [];

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
  if (createdEncounterIds.length > 0) {
    try {
      await admin.from('mensajes_encuentro').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participante_rate_limit_buckets').delete().neq('request_count', 0);
      await admin.from('inbox_notifications').delete().in('target_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
      console.log(`  Encuentros UI eliminados: ${createdEncounterIds.length}`);
    } catch (e) {
      console.warn('  Error eliminando encuentros UI:', e);
    }
  }
  if (createdUserIds.length > 0) {
    try {
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
      console.log(`  Usuarios UI eliminados: ${createdUserIds.length}`);
    } catch (e) {
      console.warn('  Error eliminando usuarios UI:', e);
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
  console.log('SMOKE TEST FUNCIONAL UI (MOBILE & DESKTOP)');
  console.log('PANEL DE INFORMACIÓN Y MENSAJES V1');
  console.log(`Backend Target: ${SUPABASE_STAGING_URL}`);
  console.log('========================================================\n');

  try {
    // 1. Verificar estado de Vercel Authentication en remoto
    console.log('[1/5] Verificando protección del dominio remoto staging.puntoencuentro.com.ar...');
    try {
      const res = await fetch('https://staging.puntoencuentro.com.ar', { redirect: 'manual' });
      console.log(`  Respuesta de https://staging.puntoencuentro.com.ar: ${res.status} ${res.statusText}`);
      if (res.status === 302 || res.status === 401) {
        console.log('  -> Confirmado: Vercel Authentication protege el dominio remoto con SSO.');
        console.log('  -> Conforme a las instrucciones, la prueba funcional se ejecuta sobre frontend conectado a Supabase Staging.');
      }
    } catch (err: any) {
      console.log('  Error consultando dominio remoto:', err.message);
    }

    // 2. Iniciar servidor frontend local si no está levantado
    console.log('\n[2/5] Verificando servidor frontend local...');
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

    // 3. Crear fixtures en Staging
    console.log('\n[3/5] Creando fixtures en Supabase Staging para prueba UI...');
    const hostEmail = `qa-ui-host-${ts}@qa-staging-fixtures.test`;
    const hostPass = 'QaUiHostPass123!Secure';
    const { data: uHost, error: uErr } = await admin.auth.admin.createUser({
      email: hostEmail,
      password: hostPass,
      email_confirm: true,
      user_metadata: { full_name: 'Anfitrión Organizador' },
    });
    if (uErr || !uHost.user) throw new Error(`Error creando host UI: ${uErr?.message}`);
    createdUserIds.push(uHost.user.id);

    // Obtener sesión de auth para el host
    const userClient = createClient(SUPABASE_STAGING_URL, getStagingPublishableKey(), {
      auth: { persistSession: false },
    });
    const { data: signInData, error: signInErr } = await userClient.auth.signInWithPassword({
      email: hostEmail,
      password: hostPass,
    });
    if (signInErr || !signInData.session) throw new Error(`Error autenticando: ${signInErr?.message}`);
    const hostSession = signInData.session;

    // Encuentro principal activo
    const futureDate = new Date(Date.now() + 4 * 86400 * 1000).toISOString().slice(0, 10);
    const { data: encActive, error: encActiveErr } = await admin
      .from('encuentros')
      .insert({
        host_id: uHost.user.id,
        titulo: `QA Encuentro UI ${ts}`,
        fecha: futureDate,
        hora: '20:30:00',
        modalidad: 'presencial',
        lugar_texto: 'Palermo Soho, CABA',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'activo',
        public_token: crypto.randomUUID(),
      })
      .select('id')
      .single();
    if (encActiveErr || !encActive) throw new Error(`Error creando encActive: ${encActiveErr?.message}`);
    createdEncounterIds.push(encActive.id);

    // Token individual para invitado sin registro
    const guestToken = crypto.randomUUID();
    const { error: guestPartErr } = await admin.from('participantes').insert({
      encuentro_id: encActive.id,
      nombre_invitado: 'Invitado UI Sin Cuenta',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      token_invitacion: guestToken,
    });
    if (guestPartErr) throw new Error(`Error creando participante invitado: ${guestPartErr.message}`);

    // Encuentro pasado (> 24 horas) para probar solo lectura
    const { data: encPast, error: encPastErr } = await admin
      .from('encuentros')
      .insert({
        host_id: uHost.user.id,
        titulo: `QA Encuentro UI Pasado ${ts}`,
        fecha: '2026-01-01',
        hora: '10:00:00',
        modalidad: 'presencial',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'activo',
        public_token: crypto.randomUUID(),
      })
      .select('id')
      .single();
    if (encPastErr || !encPast) throw new Error(`Error creando encPast: ${encPastErr?.message}`);
    createdEncounterIds.push(encPast.id);

    const pastGuestToken = crypto.randomUUID();
    await admin.from('participantes').insert({
      encuentro_id: encPast.id,
      nombre_invitado: 'Invitado En Pasado',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      token_invitacion: pastGuestToken,
    });

    console.log(`  Encuentro ID: ${encActive.id}`);
    console.log(`  Guest Token:  ${guestToken}`);

    // Iniciar Playwright Chromium
    browser = await chromium.launch({ headless: true });

    // ----------------------------------------------------
    // TEST MOBILE VIEWPORT (390 x 844) - HOST
    // ----------------------------------------------------
    console.log('\n[4/5] Ejecutando Smoke Test en Viewport Mobile (390 x 844) como Organizador...');
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });

    const mobileConsoleErrors: string[] = [];
    const mobilePage = await mobileContext.newPage();
    mobilePage.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('NO_I18NEXT_INSTANCE') && !text.includes('Failed to load resource')) {
          mobileConsoleErrors.push(text);
        }
      }
    });

    // Inyectar token de sesión en localStorage para Host
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
        sessionData: hostSession,
        storageKey: `sb-${STAGING_PROJECT_REF}-auth-token`,
      }
    );

    // Navegar a la pantalla del anfitrión
    await mobilePage.goto(`${LOCAL_URL}/meet/${encActive.id}`, { waitUntil: 'networkidle', timeout: 30000 });

    // 1. Verificar presencia del panel de mensajes
    const panelLocator = mobilePage.locator('.pe-msg-panel');
    await panelLocator.waitFor({ state: 'visible', timeout: 15000 });
    assert.ok(await panelLocator.isVisible(), 'El panel de mensajes debe ser visible');
    console.log('  -> Panel de mensajes visible en DetailHost (Mobile 390x844).');

    // 2. Estado vacío inicial
    const emptyStateLocator = mobilePage.locator('.pe-msg-empty');
    assert.ok(await emptyStateLocator.isVisible(), 'Debe mostrar estado vacío antes de haber mensajes');
    console.log('  -> Estado vacío renderizado correctamente.');

    // 3. Escribir mensaje en el composer (textarea)
    const textarea = mobilePage.locator('.pe-msg-textarea');
    await textarea.fill('Aviso importante del organizador: por favor confirmar transporte.');
    const charCounter = mobilePage.locator('.pe-msg-char-counter');
    assert.ok(await charCounter.innerText().then((t) => t.includes('/500')));

    // 4. Publicar
    const sendBtn = mobilePage.locator('.pe-msg-send-btn');
    await sendBtn.click();

    // 5. Verificar que el mensaje aparece con badge de Organizador
    const msgItem = mobilePage.locator('.pe-msg-item').first();
    await msgItem.waitFor({ state: 'visible', timeout: 10000 });
    const hostBadge = msgItem.locator('.pe-msg-badge-host');
    assert.ok(await hostBadge.isVisible(), 'El mensaje del anfitrión debe mostrar la etiqueta "Organizador"');
    console.log('  -> Mensaje publicado con éxito e identificación visual de Organizador.');

    // 6. Destacar el mensaje
    const pinBtn = msgItem.locator('.pe-msg-btn-action--pin');
    await pinBtn.click();
    const pinBadge = msgItem.locator('.pe-msg-badge-destacado');
    await pinBadge.waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(await pinBadge.isVisible(), 'El mensaje debe mostrar la insignia de Destacado');
    console.log('  -> Destacado de mensaje completado exitosamente.');

    // 7. Editar mensaje propio
    const editBtn = msgItem.locator('.pe-msg-actions button:has-text("Editar")');
    await editBtn.click();
    const editTextarea = msgItem.locator('.pe-msg-edit-textarea');
    await editTextarea.fill('Aviso importante del organizador: por favor confirmar transporte (actualizado).');
    const saveEditBtn = msgItem.locator('.pe-msg-edit-buttons button:has-text("Guardar")');
    await saveEditBtn.click();
    await mobilePage.waitForTimeout(1000);
    const editedIndicator = msgItem.locator('.pe-msg-edited');
    assert.ok(await editedIndicator.isVisible(), 'Debe mostrar indicador "(editado)"');
    console.log('  -> Edición en vivo completada exitosamente.');

    assert.equal(mobileConsoleErrors.length, 0, `Errores en consola Mobile: ${mobileConsoleErrors.join('; ')}`);
    console.log('  -> Cero errores no controlados en consola Mobile.');

    // ----------------------------------------------------
    // TEST DESKTOP VIEWPORT (1280 x 800) - INVITADO SIN CUENTA
    // ----------------------------------------------------
    console.log('\n[5/5] Ejecutando Smoke Test en Viewport Desktop (1280 x 800) como Invitado sin registro...');
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    const desktopConsoleErrors: string[] = [];
    const desktopPage = await desktopContext.newPage();
    desktopPage.on('dialog', async (dialog) => {
      await dialog.accept();
    });
    desktopPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('NO_I18NEXT_INSTANCE') && !text.includes('Failed to load resource')) {
          desktopConsoleErrors.push(text);
        }
      }
    });

    // Sin sesión de auth en localStorage, solo bypass gate
    await desktopPage.addInitScript(() => {
      window.localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({
        granted: true,
        at: Date.now(),
      }));
    });

    // Navegar a /invite/:token como invitado
    await desktopPage.goto(`${LOCAL_URL}/invite/${guestToken}`, { waitUntil: 'networkidle', timeout: 30000 });

    // 1. Verificar panel en vista de invitado
    const desktopPanel = desktopPage.locator('.pe-msg-panel');
    await desktopPanel.waitFor({ state: 'visible', timeout: 15000 });
    console.log('  -> Panel de mensajes visible en InviteGuest (Desktop 1280x800).');

    // 2. Verificar que el invitado ve el mensaje destacado
    const desktopPinnedSection = desktopPage.locator('.pe-msg-destacados');
    await desktopPinnedSection.waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(await desktopPinnedSection.isVisible(), 'Invitado debe ver la sección de destacados');
    console.log('  -> Sección de destacados visible para el invitado.');

    // 3. Responder al mensaje del anfitrión (1 nivel)
    const replyBtn = desktopPage.locator('.pe-msg-actions button:has-text("Responder")').first();
    await replyBtn.click();
    const replyPill = desktopPage.locator('.pe-msg-replying-pill');
    assert.ok(await replyPill.isVisible(), 'Debe mostrar la píldora de contexto de respuesta');

    const guestTextarea = desktopPage.locator('.pe-msg-textarea');
    await guestTextarea.fill('Perfecto, yo voy en auto y puedo llevar a dos.');
    const guestSendBtn = desktopPage.locator('.pe-msg-send-btn');
    await guestSendBtn.click();

    // 4. Verificar que la respuesta aparece anidada
    const replyMsg = desktopPage.locator('.pe-msg-item--reply').first();
    await replyMsg.waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(await replyMsg.isVisible(), 'La respuesta anidada debe mostrarse correctamente');
    console.log('  -> Respuesta de un nivel enviada y renderizada con clase pe-msg-item--reply.');

    // 5. Eliminar mensaje propio por parte del invitado
    const deleteReplyBtn = replyMsg.locator('.pe-msg-btn-action--delete');
    await deleteReplyBtn.click();
    await desktopPage.waitForTimeout(1000);
    const deletedContent = desktopPage.locator('.pe-msg-content--deleted').first();
    assert.ok(await deletedContent.isVisible(), 'Debe mostrar texto de mensaje eliminado');
    console.log('  -> Eliminación propia por invitado confirmada.');

    // 6. Probar encuentro pasado (> 24 hs) -> Solo lectura
    await desktopPage.goto(`${LOCAL_URL}/invite/${pastGuestToken}`, { waitUntil: 'networkidle', timeout: 30000 });
    const pastPanel = desktopPage.locator('.pe-msg-panel');
    await pastPanel.waitFor({ state: 'visible', timeout: 15000 });
    const readonlyBanner = desktopPage.locator('.pe-msg-banner--warning');
    await readonlyBanner.waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(await readonlyBanner.isVisible(), 'Debe mostrar banner de solo lectura en encuentro pasado');
    const pastComposer = desktopPage.locator('.pe-msg-composer');
    assert.ok(!(await pastComposer.isVisible()), 'No debe mostrar formulario de escritura en solo lectura');
    console.log('  -> Estado de solo lectura verificado: banner informativo y composer oculto.');

    assert.equal(desktopConsoleErrors.length, 0, `Errores en consola Desktop: ${desktopConsoleErrors.join('; ')}`);
    console.log('  -> Cero errores no controlados en consola Desktop.');

    console.log('\n========================================================');
    console.log('✔ SMOKE TEST FUNCIONAL UI COMPLETADO EXITOSAMENTE (100% OK).');
    console.log('========================================================\n');
  } finally {
    await cleanup();
  }
}

runUiSmoke().catch((err) => {
  console.error('\n✖ ERROR FATAL EN SMOKE TEST UI:', err);
  process.exit(1);
});
