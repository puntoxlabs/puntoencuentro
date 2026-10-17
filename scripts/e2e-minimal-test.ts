/**
 * E2E Minimal Smoke Test on Real Staging (Playwright + Chromium)
 *
 * Objetivo:
 * Validar la infraestructura básica antes de ejecutar la suite completa:
 * 1. Comprobar que el entorno es estrictamente Staging (Guardrail assertStagingEnvironment)
 * 2. Limpiar proactivamente cualquier fixture huérfano de ejecuciones anteriores
 * 3. Abrir frontend real con Vercel Bypass restringido a staging.puntoencuentro.com.ar
 * 4. Confirmar que los recursos JavaScript y fuentes cargaron sin errores CORS
 * 5. Superar AccessGate mediante inyección local en el navegador
 * 6. Autenticar anfitrión de prueba en Supabase Staging
 * 7. Abrir encuentro en /meet/:id
 * 8. Confirmar mediante selector estable (h2.dh-title) y menú contextual (.dh-context-menu-btn) que el detalle cargó
 * 9. Guardar captura de evidencia en qa-evidence/minimal_host_detail.png
 * 10. Cerrar navegador y limpiar fixtures (incluyendo soporte SIGINT/SIGTERM)
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertStagingEnvironment,
  getStagingSecretKey,
  getStagingPublishableKey,
  getVercelBypassSecret,
  cleanOrphanQaFixtures,
} from './lib/environment-guard';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DEFAULT_STAGING_URL = 'https://staging.puntoencuentro.com.ar';
const TARGET_URL = (process.env.BASE_URL || DEFAULT_STAGING_URL).replace(/\/$/, '');
const isLocalTarget = TARGET_URL.includes('localhost') || TARGET_URL.includes('127.0.0.1');

const SUPABASE_STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
const STAGING_REF = 'wougfhfwqgmxhgvjqoua';

// 1. Guardrail de Seguridad: Garantizar que NUNCA ejecute contra Producción
assertStagingEnvironment(SUPABASE_STAGING_URL);
assertStagingEnvironment(STAGING_REF);

const bypassSecret = getVercelBypassSecret();

if (!isLocalTarget && (!bypassSecret || bypassSecret.trim() === '')) {
  console.error('\n❌ ERROR: La variable de entorno VERCEL_AUTOMATION_BYPASS_SECRET no está definida para target remoto.');
  console.error('Por favor, configúrela como secreto en su archivo .env.local:');
  console.error('   VERCEL_AUTOMATION_BYPASS_SECRET=<secreto>\n');
  process.exit(1);
}

const admin = createClient(SUPABASE_STAGING_URL, getStagingSecretKey(), {
  auth: { persistSession: false },
});
const publishableKey = getStagingPublishableKey();

const evidenceDir = path.join(rootDir, 'qa-evidence');
if (!fs.existsSync(evidenceDir)) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

interface RedirectRecord {
  url: string;
  resourceType: string;
  status: number;
  location: string;
}

interface FailedRequestRecord {
  url: string;
  resourceType: string;
  error: string;
}

async function main() {
  console.log('================================================================');
  console.log('PRUEBA MÍNIMA E2E: INFRAESTRUCTURA Y DETALLE DEL ORGANIZADOR');
  console.log(`Target: ${TARGET_URL} (${isLocalTarget ? 'Local Frontend' : 'Remote Staging'})`);
  console.log(`Supabase Target: ${SUPABASE_STAGING_URL} (${STAGING_REF})`);
  console.log('Guardrail de Seguridad: Staging verificado. Producción bloqueada.');
  console.log('================================================================\n');

  let browser: Browser | null = null;
  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];
  const redirects: RedirectRecord[] = [];
  const failedRequests: FailedRequestRecord[] = [];
  const consoleErrors: string[] = [];

  // Manejo de señales de interrupción (ej. cancelación en GitHub Actions)
  const cleanupOnSignal = async (signal: string) => {
    console.log(`\n[SIGNAL ${signal}] Interrupción recibida. Limpiando fixtures...`);
    if (browser) await browser.close().catch(() => null);
    for (const encId of createdEncounterIds) {
      await admin.from('encuentros').delete().eq('id', encId).catch(() => null);
    }
    for (const uid of createdUserIds) {
      await admin.auth.admin.deleteUser(uid).catch(() => null);
    }
    await cleanOrphanQaFixtures(admin).catch(() => null);
    process.exit(1);
  };
  process.once('SIGINT', () => cleanupOnSignal('SIGINT'));
  process.once('SIGTERM', () => cleanupOnSignal('SIGTERM'));

  try {
    // Identificador único de corrida para trazabilidad inequívoca y aislamiento de fixtures
    const runId = 'min_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);

    // 0. Limpieza proactiva de fixtures huérfanos de ejecuciones previas abortadas
    console.log('[0/6] Evaluando fixtures huérfanos antiguos de QA en Staging...');
    await cleanOrphanQaFixtures(admin, {
      currentRunId: runId,
      minAgeMinutes: 30,
    });

    // 1. Crear anfitrión temporal
    console.log('[1/6] Creando anfitrión temporal de QA en Supabase Staging...');
    const hostEmail = `qa-e2e-run-${runId}-host@puntoencuentro.test`;
    const hostPassword = 'QaPassword123!Secure';
    const { data: hostAuth, error: hostAuthErr } = await admin.auth.admin.createUser({
      email: hostEmail,
      password: hostPassword,
      email_confirm: true,
      user_metadata: {
        full_name: 'Anfitrión QA Mínimo',
        is_e2e_automation_fixture: true,
        e2e_run_id: runId,
        created_at: Date.now(),
      },
    });
    if (hostAuthErr || !hostAuth.user) {
      throw new Error(`Error creando anfitrión: ${hostAuthErr?.message}`);
    }
    const hostId = hostAuth.user.id;
    createdUserIds.push(hostId);

    // Obtener sesión válida
    const anonClient = createClient(SUPABASE_STAGING_URL, publishableKey, {
      auth: { persistSession: false },
    });
    const { data: signInData, error: signInErr } = await anonClient.auth.signInWithPassword({
      email: hostEmail,
      password: hostPassword,
    });
    if (signInErr || !signInData.session) {
      throw new Error(`Error autenticando anfitrión: ${signInErr?.message}`);
    }
    const hostSession = signInData.session;
    console.log(`   Host creado y autenticado (ID: ${hostId})`);

    // 2. Crear encuentro de prueba
    console.log('[2/6] Creando encuentro de prueba en base de datos...');
    const encounterTitle = `[QA-E2E:${runId}] Encuentro Mínimo QA`;
    const { data: encData, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostId,
        titulo: encounterTitle,
        open_public_title: encounterTitle,
        descripcion: `[AUTOMATED_QA_FIXTURE:${runId}] Encuentro de validación funcional E2E en Staging`,
        fecha: '2026-12-01',
        hora: '20:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Plaza San Martín, Mar del Plata',
        tipo_invitacion: 'individual',
        invitation_template: 'default',
        locality_id: 'centro',
        open_public_zone: 'Plaza San Martín',
        estado: 'activo',
        is_open: true,
        max_participants: 6,
        min_participants: 2,
        realization_status: 'pending',
        moderation_status: 'approved',
      })
      .select('id')
      .single();

    if (encErr || !encData?.id) {
      throw new Error(`Error creando encuentro: ${encErr?.message}`);
    }
    const encounterId = encData.id;
    createdEncounterIds.push(encounterId);
    console.log(`   Encuentro creado: "${encounterTitle}" (ID: ${encounterId})`);

    // 3. Iniciar Chromium y configurar contexto seguro
    console.log('[3/6] Iniciando Chromium y configurando cookie de bypass para Staging...');
    browser = await chromium.launch({ headless: true });

    // NO usar extraHTTPHeaders globales en newContext para evitar fugas a dominios externos
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    // Si el destino es remoto (Vercel Staging), asentar cookie de bypass
    if (!isLocalTarget && bypassSecret) {
      console.log('   Solicitando cookie de bypass a Staging (maxRedirects: 0)...');
      const bypassResponse = await context.request.get(TARGET_URL, {
        maxRedirects: 0,
        headers: {
          'x-vercel-protection-bypass': bypassSecret,
          'x-vercel-set-bypass-cookie': 'true',
        },
      });

      const cookies = await context.cookies(TARGET_URL);
      const hasBypassCookie = cookies.some(c => c.name.startsWith('_vercel_jwt') || c.name.includes('bypass') || c.name.includes('vercel'));
      console.log(`   Respuesta preflight: HTTP ${bypassResponse.status()}`);
      console.log(`   Cookies registradas en contexto para Staging: ${cookies.map(c => c.name).join(', ') || 'ninguna'}`);

      if (bypassResponse.status() === 401 || bypassResponse.status() === 403) {
        throw new Error(`El secreto de bypass de Vercel fue rechazado por Staging (HTTP ${bypassResponse.status()}). Deteniendo prueba.`);
      }
      if (!hasBypassCookie && bypassResponse.status() !== 200 && bypassResponse.status() !== 308) {
        throw new Error(`No se pudo asentar la cookie de bypass de Vercel (HTTP ${bypassResponse.status()}). Deteniendo prueba.`);
      }
    } else {
      console.log(`   Target local detectado (${TARGET_URL}). Omitiendo bypass de Vercel.`);
    }

    const page = await context.newPage();

    // Diagnóstico detallado de red y consola
    page.on('response', resp => {
      const status = resp.status();
      const req = resp.request();
      const rType = req.resourceType();
      const rUrl = resp.url();

      if (status >= 300 && status < 400) {
        const loc = resp.headers()['location'] || '(sin location)';
        redirects.push({ url: rUrl, resourceType: rType, status, location: loc });
      }
    });

    page.on('requestfailed', req => {
      failedRequests.push({
        url: req.url(),
        resourceType: req.resourceType(),
        error: req.failure()?.errorText || 'desconocido',
      });
    });

    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Pre-inyectar bypass de AccessGate y sesión de Supabase
    await page.addInitScript(({ sessionData, storageKey }) => {
      window.localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({
        granted: true,
        at: Date.now(),
      }));
      if (sessionData && storageKey) {
        window.localStorage.setItem(storageKey, JSON.stringify(sessionData));
      }
    }, {
      sessionData: hostSession,
      storageKey: `sb-${STAGING_REF}-auth-token`,
    });

    // 4. Navegar a /meet/:id
    console.log(`[4/6] Navegando a ${TARGET_URL}/meet/${encounterId}...`);
    await page.goto(`${TARGET_URL}/meet/${encounterId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Validar inmediatamente que no caímos en el Login de Vercel ni en AccessGate
    const pageTitle = await page.title();
    if (pageTitle.includes('Login – Vercel') || pageTitle.includes('Deployment Protection')) {
      throw new Error(`Acceso bloqueado: la página cargó el Login de Vercel ("${pageTitle}"). La cookie de bypass no fue aceptada.`);
    }

    // 5. Verificar elementos visibles con selectores estables
    console.log('[5/6] Verificando elementos estables del DOM en la pantalla del organizador...');
    
    // Esperar explícitamente a que aparezca h2.dh-title con el título real del encuentro
    await page.waitForSelector('h2.dh-title', { timeout: 15000 });
    const renderedTitle = await page.textContent('h2.dh-title');
    console.log(`   Título renderizado en DOM: "${renderedTitle?.trim()}"`);

    // Verificar presencia del menú contextual de tres puntos (.dh-context-menu-btn)
    await page.waitForSelector('.dh-context-menu-btn', { timeout: 10000 });
    const hasContextMenuBtn = await page.locator('.dh-context-menu-btn').count() > 0;
    console.log(`   Botón menú contextual (.dh-context-menu-btn) presente: ${hasContextMenuBtn ? 'SÍ' : 'NO'}`);

    // Abrir menú contextual para comprobar que responde y expone opciones de gestión
    await page.locator('.dh-context-menu-btn').click();
    await page.waitForSelector('.dh-context-menu-dropdown', { timeout: 5000 });
    
    const dropdownText = await page.textContent('.dh-context-menu-dropdown');
    const hasOptionInMenu = dropdownText?.includes('Cancelar encuentro') || dropdownText?.includes('Eliminar') || dropdownText?.includes('Ir al inicio');
    console.log(`   Opciones en menú contextual desplegado: ${hasOptionInMenu ? 'SÍ' : 'NO'}`);

    // Captura de evidencia con el menú contextual desplegado
    const evidenceScreenshot = path.join(evidenceDir, 'minimal_host_detail.png');
    await page.screenshot({ path: evidenceScreenshot, fullPage: true });
    console.log(`   Captura guardada en: ${evidenceScreenshot}`);

    // Cerrar menú haciendo click en el overlay o esc
    await page.keyboard.press('Escape').catch(() => null);

    // 6. Diagnóstico de recursos
    console.log('\n[6/6] Análisis de diagnóstico de red y recursos:');
    console.log(`   - Redirecciones detectadas: ${redirects.length}`);
    for (const r of redirects) {
      console.log(`     [${r.status}] (${r.resourceType}) ${r.url} -> ${r.location}`);
    }

    console.log(`   - Peticiones fallidas: ${failedRequests.length}`);
    for (const f of failedRequests) {
      console.log(`     [FALLÓ] (${f.resourceType}) ${f.url} - Error: ${f.error}`);
    }

    const hasFontCors = consoleErrors.some(e => e.includes('fonts.gstatic.com') || e.includes('CORS'));
    console.log(`   - Errores CORS en fuentes externas: ${hasFontCors ? 'SÍ (DETECTADO)' : 'NO (CORREGIDO)'}`);

    const isTitleMatching = renderedTitle?.trim() === encounterTitle;
    const isSuccess = isTitleMatching && hasContextMenuBtn && hasOptionInMenu && !hasFontCors;

    console.log('\n================================================================');
    if (isSuccess) {
      console.log('✅ RESULTADO PRUEBA MÍNIMA: PASS');
      console.log('La infraestructura de prueba está lista y validada con éxito.');
      console.log('El anfitrión cargó correctamente su encuentro en Staging.');
      console.log('================================================================\n');
    } else {
      console.log('❌ RESULTADO PRUEBA MÍNIMA: FAIL');
      if (!isTitleMatching) console.log(`   - El título no coincide: "${renderedTitle}" !== "${encounterTitle}"`);
      if (!hasContextMenuBtn) console.log('   - No se encontró el botón de menú contextual .dh-context-menu-btn');
      if (!hasOptionInMenu) console.log('   - No se encontraron opciones válidas en el menú contextual');
      if (hasFontCors) console.log('   - Persisten errores CORS en fonts.gstatic.com');
      console.log('================================================================\n');
      process.exit(1);
    }

    await context.close();
  } finally {
    if (browser) {
      await browser.close().catch(() => null);
    }

    console.log('--- Limpieza de fixtures de prueba mínima ---');
    for (const encId of createdEncounterIds) {
      try {
        await admin.from('encuentros').delete().eq('id', encId);
        console.log(`   Encuentro QA eliminado: ${encId}`);
      } catch (e: any) {
        console.warn(`   Error eliminando encuentro ${encId}: ${e.message}`);
      }
    }
    for (const uid of createdUserIds) {
      try {
        await admin.auth.admin.deleteUser(uid);
        console.log(`   Usuario QA eliminado: ${uid}`);
      } catch (e: any) {
        console.warn(`   Error eliminando usuario ${uid}: ${e.message}`);
      }
    }
    console.log('Limpieza completada.\n');
  }
}

main().catch(err => {
  console.error('\n❌ ERROR FATAL EN PRUEBA MÍNIMA:', err);
  process.exit(1);
});
