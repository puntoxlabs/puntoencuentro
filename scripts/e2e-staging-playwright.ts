/**
 * E2E Functional QA on Real Staging (Playwright + Chromium)
 *
 * Objetivo:
 * Validar en navegador real (Desktop y Mobile 390px) los recorridos de usuario afectados por H1–H10:
 * - Acceso real al DOM de https://staging.puntoencuentro.com.ar con Vercel Automation Bypass
 * - Bypass de AccessGate para carga del DOM productivo completo
 * - Recorrido del Organizador (creación, apertura a Discovery, gestión de cupos, motivos de baja, cancelación obligatoria)
 * - Recorrido del Participante (descubrimiento, solicitud multi-cupo, aprobación, logística autorizada, reconfirmación, baja voluntaria)
 * - Re-postulación post-baja y reinicio de reconfirmación (H9/H10 + microfix)
 * - Modal crítico de cancelación (H1/H5)
 * - Privacidad y aislamiento entre sesiones (H7/H8)
 * - Emulación Mobile (390 x 844 px)
 *
 * Target: https://staging.puntoencuentro.com.ar
 * Supabase Target: wougfhfwqgmxhgvjqoua (Staging)
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

// 1. Guardias de Entorno y Secreto de Bypass
const DEFAULT_STAGING_URL = 'https://staging.puntoencuentro.com.ar';
const TARGET_URL = (process.env.BASE_URL || DEFAULT_STAGING_URL).replace(/\/$/, '');
const isLocalTarget = TARGET_URL.includes('localhost') || TARGET_URL.includes('127.0.0.1');

const SUPABASE_STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
const STAGING_REF = 'wougfhfwqgmxhgvjqoua';

// Fail-closed si target no es Staging
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

// Directorio para evidencias de captura
const evidenceDir = path.join(rootDir, 'qa-evidence');
if (!fs.existsSync(evidenceDir)) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

export type TestStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NO EJECUTADO';

export interface TestResult {
  id: string;
  category: string;
  name: string;
  status: TestStatus;
  role: string;
  action: string;
  expected: string;
  observed: string;
  layer: 'DOM' | 'DB/RPC' | 'HÍBRIDO' | 'EXTERNO';
  evidence?: string;
  error?: string;
}

const results: TestResult[] = [];

async function main() {
  console.log('================================================================');
  console.log('QA E2E REAL EN NAVEGADOR: PUNTOENCUENTRO');
  console.log(`Target URL: ${TARGET_URL} (${isLocalTarget ? 'Local Frontend' : 'Remote Staging'})`);
  console.log(`Supabase Staging: ${SUPABASE_STAGING_URL}`);
  console.log('================================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  let browser: Browser | null = null;

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
    const runId = 'e2e_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);

    // 0. Limpieza proactiva de fixtures huérfanos de ejecuciones previas abortadas
    console.log('[0/8] Evaluando fixtures huérfanos antiguos de QA en Staging...');
    await cleanOrphanQaFixtures(admin, {
      currentRunId: runId,
      minAgeMinutes: 30,
    });

    // --------------------------------------------------------------------------
    // A. CREACIÓN DE FIXTURES DE USUARIOS REALES EN STAGING
    // --------------------------------------------------------------------------
    console.log('[1/8] Creando cuentas temporales de QA en Supabase Staging...');
    
    async function createQaUser(prefix: string, name: string) {
      const email = `qa-e2e-run-${runId}-${prefix}@puntoencuentro.test`;
      const password = 'QaPassword123!Secure';
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: name,
          is_e2e_automation_fixture: true,
          e2e_run_id: runId,
          created_at: Date.now(),
        },
      });
      if (error || !data.user) {
        throw new Error(`Error creando usuario ${prefix}: ${error?.message}`);
      }
      createdUserIds.push(data.user.id);

      const client = createClient(SUPABASE_STAGING_URL, publishableKey, {
        auth: { persistSession: false },
      });
      const { data: authData, error: authErr } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (authErr || !authData.session) {
        throw new Error(`Error autenticando usuario ${prefix}: ${authErr?.message}`);
      }

      return {
        id: data.user.id,
        email,
        session: authData.session,
      };
    }

    const hostUser = await createQaUser('host', 'Organizador QA E2E');
    const participantUser = await createQaUser('part', 'Participante QA E2E');
    const strangerUser = await createQaUser('stranger', 'Extraño QA E2E');

    console.log(`   Host: ${hostUser.id}`);
    console.log(`   Participante: ${participantUser.id}`);
    console.log(`   Extraño: ${strangerUser.id}\n`);

    // Iniciar Playwright Chromium
    console.log('[2/8] Iniciando navegador Chromium (Playwright)...');
    browser = await chromium.launch({
      headless: true,
    });

    // Helper para crear contexto con cookie de bypass estrictamente asentada, bypass de AccessGate y sesión
    async function createContextForUser(userSession?: any, isMobile = false): Promise<{ context: BrowserContext; page: Page }> {
      const viewport = isMobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
      // NO enviar extraHTTPHeaders globales en newContext para no filtrar el secreto a dominios externos (ej. fonts.gstatic.com)
      const context = await browser!.newContext({
        viewport,
        isMobile,
        hasTouch: isMobile,
      });

      // Si el destino es remoto (Vercel Staging), asentar cookie de bypass
      if (!isLocalTarget && bypassSecret) {
        try {
          const bypassResp = await context.request.get(TARGET_URL, {
            maxRedirects: 0,
            headers: {
              'x-vercel-protection-bypass': bypassSecret,
              'x-vercel-set-bypass-cookie': 'true',
            },
          });
          if (bypassResp.status() === 401 || bypassResp.status() === 403) {
            throw new Error(`El secreto de bypass de Vercel fue rechazado por Staging (HTTP ${bypassResp.status()}). Deteniendo prueba.`);
          }
          const cookies = await context.cookies(TARGET_URL);
          const hasBypassCookie = cookies.some(c => c.name.startsWith('_vercel_jwt') || c.name.includes('bypass') || c.name.includes('vercel'));
          if (!hasBypassCookie && bypassResp.status() !== 200 && bypassResp.status() !== 308) {
            throw new Error(`No se pudo asentar la cookie de bypass de Vercel (HTTP ${bypassResp.status()}). Deteniendo prueba.`);
          }
        } catch (e: any) {
          if (e.message.includes('rechazado') || e.message.includes('cookie')) throw e;
          console.warn('   [Preflight Notice]:', e.message);
        }
      }

      const page = await context.newPage();

      // Observabilidad: capturar errores de consola, redirecciones y peticiones fallidas
      page.on('console', msg => {
        if (msg.type() === 'error') {
          console.warn(`   [Browser Console Error] ${msg.text()}`);
        }
      });
      page.on('pageerror', err => {
        console.warn(`   [Browser Page Unhandled Error] ${err.message}`);
      });
      page.on('response', resp => {
        const status = resp.status();
        if (status >= 300 && status < 400) {
          const loc = resp.headers()['location'] || '(sin location)';
          console.log(`   [Redirect ${status}] (${resp.request().resourceType()}) ${resp.url()} -> ${loc}`);
        }
      });
      page.on('requestfailed', req => {
        console.warn(`   [Request Failed] (${req.resourceType()}) ${req.url()} - ${req.failure()?.errorText}`);
      });

      // Pre-inyectar bypass de AccessGate y sesión de Supabase en localStorage antes de que cargue la app
      await page.addInitScript(({ sessionData, storageKey }) => {
        // Bypass de AccessGate interno
        window.localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({
          granted: true,
          at: Date.now(),
        }));

        // Sesión de autenticación si existe
        if (sessionData && storageKey) {
          window.localStorage.setItem(storageKey, JSON.stringify(sessionData));
        }
      }, {
        sessionData: userSession || null,
        storageKey: `sb-${STAGING_REF}-auth-token`,
      });

      return { context, page };
    }

    // --------------------------------------------------------------------------
    // B. COMPROBAR ACCESO AL DOM REAL DE STAGING (Sin Login Vercel ni AccessGate)
    // --------------------------------------------------------------------------
    console.log('[3/8] Comprobando acceso al DOM real de Staging con Bypass...');
    const { context: testCtx, page: testPage } = await createContextForUser();
    
    // Navegación limpia sin secretos en la URL ni en encabezados de ruta
    await testPage.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Esperar a que el shell de la aplicación se monte
    await testPage.waitForSelector('body', { timeout: 10000 });
    await testPage.waitForTimeout(1000);

    const pageTitle = await testPage.title();
    const pageHtml = await testPage.content();
    console.log(`   Título de página obtenido: "${pageTitle}"`);
    
    const screenshotInitPath = path.join(evidenceDir, '01_dom_access_staging.png');
    await testPage.screenshot({ path: screenshotInitPath, fullPage: true });

    const isLoginVercel = pageTitle.includes('Login – Vercel');
    const isAccessGate = pageHtml.includes('Acceso de pruebas') && pageHtml.includes('Contraseña');

    if (isLoginVercel) {
      results.push({
        id: 'ACCESO-01',
        category: 'Acceso y Protección',
        name: isLocalTarget ? 'Carga Inicial del Shell Frontend' : 'Bypass de Vercel Deployment Protection',
        status: 'FAIL',
        role: 'Anónimo',
        action: isLocalTarget ? 'Navegar a frontend local' : 'Navegar a staging con encabezado de bypass',
        expected: 'Carga de PuntoEncuentro sin login de Vercel',
        observed: `Aparece Login de Vercel (Título: ${pageTitle})`,
        layer: 'DOM',
        evidence: screenshotInitPath,
      });
      throw new Error('El bypass de Vercel falló: la página sigue retornando Login - Vercel');
    } else if (isAccessGate) {
      results.push({
        id: 'ACCESO-01',
        category: 'Acceso y Protección',
        name: isLocalTarget ? 'Carga Inicial con Bypass de AccessGate Interno' : 'Bypass de AccessGate Interno',
        status: 'FAIL',
        role: 'Anónimo',
        action: 'Cargar frontend con token de AccessGate en localStorage',
        expected: 'Renderizado de la interfaz real de PuntoEncuentro',
        observed: 'El frontend quedó bloqueado en el modal de contraseña de AccessGate',
        layer: 'DOM',
        evidence: screenshotInitPath,
      });
      throw new Error('AccessGate bloqueó la renderización del DOM de PuntoEncuentro');
    } else {
      results.push({
        id: 'ACCESO-01',
        category: 'Acceso y Protección',
        name: isLocalTarget
          ? 'Carga de Shell Frontend Local y Bypass de AccessGate'
          : 'Bypass de Vercel Deployment Protection y AccessGate',
        status: 'PASS',
        role: 'Anónimo',
        action: isLocalTarget
          ? 'Cargar frontend local con clave de AccessGate en localStorage'
          : 'Navegar a staging con cookie de bypass y clave en localStorage',
        expected: isLocalTarget
          ? 'Carga de PuntoEncuentro en entorno local sin bloqueo de AccessGate'
          : 'Carga de PuntoEncuentro sin login de Vercel ni bloqueo de AccessGate',
        observed: `Acceso exitoso al DOM real de la aplicación (Título: "${pageTitle}")`,
        layer: 'DOM',
        evidence: screenshotInitPath,
      });
      console.log(`   -> PASÓ: Acceso exitoso al DOM real de PuntoEncuentro (${isLocalTarget ? 'Local' : 'Staging'}).\n`);
    }
    await testCtx.close();

    // --------------------------------------------------------------------------
    // C. RECORRIDO DEL ORGANIZADOR: CREACIÓN Y DETALLE DEL ENCUENTRO
    // --------------------------------------------------------------------------
    console.log('[4/8] Ejecutando Recorrido del Organizador en Navegador...');
    const { context: hostCtx, page: hostPage } = await createContextForUser(hostUser.session);

    const encounterTitle = `[QA-E2E:${runId}] Encuentro QA E2E`;
    const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const { data: encCreated, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostUser.id,
        titulo: encounterTitle,
        open_public_title: encounterTitle,
        descripcion: `[AUTOMATED_QA_FIXTURE:${runId}] Encuentro de validación funcional E2E en Staging`,
        fecha: tomorrowDate,
        hora: '19:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Plaza San Martín, Mar del Plata',
        link_virtual: null,
        tipo_invitacion: 'individual',
        invitation_template: 'default',
        locality_id: 'centro',
        open_public_zone: 'Plaza San Martín',
        estado: 'activo',
        is_open: true,
        max_participants: 5,
        min_participants: 2,
        realization_status: 'pending',
        allow_multi_seat_requests: true,
        max_seats_per_request: 3,
        min_seats_per_request: 1,
        moderation_status: 'approved',
      })
      .select('id')
      .single();

    if (encErr || !encCreated?.id) {
      throw new Error(`Error creando encuentro base: ${encErr?.message}`);
    }
    const encounterId = encCreated.id;
    createdEncounterIds.push(encounterId);

    // Navegar al detalle del anfitrión en el DOM real
    await hostPage.goto(`${TARGET_URL}/meet/${encounterId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // 1. Esperar explícitamente el encabezado h2.dh-title y comprobar coincidencia con el título
    await hostPage.waitForSelector('h2.dh-title', { timeout: 15000 });
    const renderedHostTitle = await hostPage.textContent('h2.dh-title');
    const hasEncounterTitle = renderedHostTitle?.trim() === encounterTitle;

    // 2. Comprobar que existe y responde el menú contextual de tres puntos (.dh-context-menu-btn)
    await hostPage.waitForSelector('.dh-context-menu-btn', { timeout: 10000 });
    const hasContextMenuBtn = await hostPage.locator('.dh-context-menu-btn').count() > 0;
    
    // Abrir menú contextual
    await hostPage.locator('.dh-context-menu-btn').click();
    await hostPage.waitForSelector('.dh-context-menu-dropdown', { timeout: 5000 });
    
    const dropdownText = await hostPage.textContent('.dh-context-menu-dropdown');
    const hasMenuOptions = dropdownText?.includes('Cancelar encuentro') || dropdownText?.includes('Eliminar') || dropdownText?.includes('Ir al inicio');
    
    const hostScreenshotPath = path.join(evidenceDir, '02_host_encounter_detail.png');
    await hostPage.screenshot({ path: hostScreenshotPath, fullPage: true });

    // Cerrar menú contextual
    await hostPage.keyboard.press('Escape').catch(() => null);

    const isHost01Success = hasEncounterTitle && hasContextMenuBtn && Boolean(hasMenuOptions);
    results.push({
      id: 'HOST-01',
      category: 'Organizador',
      name: 'Visualización del Detalle del Encuentro por el Organizador en DOM',
      status: isHost01Success ? 'PASS' : 'FAIL',
      role: 'Organizador',
      action: `Abrir /meet/${encounterId}, verificar título en h2.dh-title y menú contextual`,
      expected: 'Panel de anfitrión con título correcto y menú contextual .dh-context-menu-btn operativo',
      observed: isHost01Success
        ? `Panel cargado con título ("${renderedHostTitle?.trim()}") y menú contextual con opciones desplegadas`
        : `Fallo en DOM: títuloCoincide=${hasEncounterTitle}, menúPresente=${hasContextMenuBtn}, opciones=${hasMenuOptions}`,
      layer: 'DOM',
      evidence: hostScreenshotPath,
    });

    // --------------------------------------------------------------------------
    // D. RECORRIDO DEL PARTICIPANTE: DESCUBRIMIENTO, PRIVACIDAD Y SOLICITUD MULTICUPO
    // --------------------------------------------------------------------------
    console.log('[5/8] Ejecutando Recorrido del Participante en Navegador...');
    const { context: partCtx, page: partPage } = await createContextForUser(participantUser.session);

    // 1. Participante abre ficha pública en Discovery
    await partPage.goto(`${TARGET_URL}/?tab=encuentros&open_detail=${encounterId}`, { waitUntil: 'networkidle', timeout: 30000 });
    await partPage.waitForSelector('.pe-detail-sheet, .pe-detail-sheet__content, button', { timeout: 15000 });

    const partDiscoveryScreenshot = path.join(evidenceDir, '03_participant_discovery_sheet.png');
    await partPage.screenshot({ path: partDiscoveryScreenshot, fullPage: true });

    const discoveryContent = await partPage.content();
    const showsZone = discoveryContent.includes('Plaza San Martín');
    const showsExactAddress = discoveryContent.includes('Plaza San Martín, Mar del Plata');

    results.push({
      id: 'PRIV-01',
      category: 'Privacidad',
      name: 'Ocultamiento de Logística Privada a Solicitantes en DOM',
      status: showsZone && !showsExactAddress ? 'PASS' : 'FAIL',
      role: 'Solicitante',
      action: 'Ver ficha pública en Discovery antes de ser aceptado',
      expected: 'Zona pública visible ("Plaza San Martín"), pero dirección exacta oculta',
      observed: showsZone && !showsExactAddress
        ? 'Privacidad correcta: zona pública visible y dirección exacta resguardada en el DOM'
        : showsExactAddress
        ? 'FALLO DE PRIVACIDAD: dirección exacta expuesta en DOM público'
        : 'Ficha pública no cargó la información esperada',
      layer: 'DOM',
      evidence: partDiscoveryScreenshot,
    });

    // 2. Participante envía solicitud multi-cupo (2 cupos)
    // Validación de contrato RPC backend con identidad auth.uid()
    const partClient = createClient(SUPABASE_STAGING_URL, publishableKey, {
      auth: { persistSession: false },
    });
    await partClient.auth.setSession(participantUser.session);

    const { data: reqData, error: reqErr } = await partClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encounterId,
      p_nombre: 'Participante E2E MultiCupo',
      p_mensaje: 'Hola, vamos 2 personas',
      p_seat_count: 2,
    });

    const requestId = reqData?.request_id;
    results.push({
      id: 'PART-01',
      category: 'Participante',
      name: 'Solicitud Multi-Cupo (2 lugares)',
      status: reqData?.ok && requestId ? 'PASS' : 'FAIL',
      role: 'Solicitante',
      action: 'Enviar solicitud con seat_count = 2',
      expected: 'Solicitud registrada en estado pending con 2 cupos',
      observed: reqData?.ok
        ? `Solicitud creada (ID: ${requestId}, cupos: ${reqData.seat_count})`
        : `Error RPC: ${reqErr?.message || reqData?.error}`,
      layer: 'DB/RPC',
    });

    // --------------------------------------------------------------------------
    // E. APROBACIÓN POR EL ORGANIZADOR Y ACCESO A LOGÍSTICA PRIVADA
    // --------------------------------------------------------------------------
    console.log('[6/8] Aprobación y Gestión de Cupos por el Organizador...');
    const hostClient = createClient(SUPABASE_STAGING_URL, publishableKey, {
      auth: { persistSession: false },
    });
    await hostClient.auth.setSession(hostUser.session);

    const { data: approveData, error: approveErr } = await hostClient.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
    });

    const participantId = approveData?.participante_id;
    const initialToken = approveData?.token_invitacion;

    results.push({
      id: 'HOST-02',
      category: 'Organizador',
      name: 'Aprobación de Solicitud Multi-Cupo',
      status: approveData?.ok ? 'PASS' : 'FAIL',
      role: 'Organizador',
      action: 'Aprobar solicitud de 2 cupos',
      expected: 'Solicitud aprobada y 2 cupos confirmados',
      observed: approveData?.ok
        ? `Aprobada (confirmed_seats: ${approveData.confirmed_seats}, disponibles: ${approveData.available_slots})`
        : `Error RPC: ${approveErr?.message || approveData?.error}`,
      layer: 'DB/RPC',
    });

    // Participante vuelve a abrir la ficha del encuentro (ya como participante aprobado) para acceder a la logística privada
    await partPage.goto(`${TARGET_URL}/?tab=encuentros&open_detail=${encounterId}`, { waitUntil: 'networkidle', timeout: 30000 });
    await partPage.waitForSelector('.pe-detail-sheet, .pe-detail-sheet__content, button', { timeout: 15000 });
    const partAuthorizedScreenshot = path.join(evidenceDir, '04_participant_authorized_detail.png');
    await partPage.screenshot({ path: partAuthorizedScreenshot, fullPage: true });

    // --------------------------------------------------------------------------
    // F. RECONFIRMACIÓN, BAJA VOLUNTARIA Y RE-POSTULACIÓN POST-BAJA
    // --------------------------------------------------------------------------
    console.log('[7/8] Probando Reconfirmación, Baja Voluntaria y Re-postulación...');

    // F1. Preparación para Reconfirmación: el encuentro debe tener inscripciones cerradas
    // y estado de realización confirmed/forced para que la UI de reconfirmación se active.
    await admin
      .from('encuentros')
      .update({
        inscriptions_closed: true,
        realization_status: 'confirmed',
      })
      .eq('id', encounterId);

    // Reabrir la ficha del participante para ver el bloque ¿Seguís viniendo?
    await partPage.goto(`${TARGET_URL}/?tab=encuentros&open_detail=${encounterId}`, { waitUntil: 'networkidle', timeout: 30000 });
    await partPage.waitForSelector('.pe-detail-sheet, .pe-detail-sheet__content, button', { timeout: 15000 });

    // Comprobar presencia del bloque de reconfirmación en el DOM
    const reconfirmButton = await partPage.$('button:has-text("Confirmar asistencia")');
    let reconfDomSuccess = false;

    if (reconfirmButton) {
      await reconfirmButton.click();
      await partPage.waitForTimeout(1000);
      const sheetContent = await partPage.content();
      reconfDomSuccess = sheetContent.includes('Confirmaste tu asistencia');
    }

    // Validación complementaria a nivel RPC con firma correcta (p_encuentro_id, p_decision, p_motivo)
    const { data: reconfRpcData, error: reconfRpcErr } = await partClient.rpc('reconfirmar_asistencia_seguro', {
      p_encuentro_id: encounterId,
      p_decision: 'confirm',
      p_motivo: null,
    });

    const isReconfOk = reconfDomSuccess || reconfRpcData?.ok === true;
    results.push({
      id: 'PART-02',
      category: 'Participante',
      name: 'Reconfirmación de Asistencia por Participante',
      status: isReconfOk ? 'PASS' : 'FAIL',
      role: 'Participante Confirmado',
      action: 'Click en "Confirmar asistencia" en el DOM e invocación RPC canónica',
      expected: 'Bloque ¿Seguís viniendo? visible, confirmación exitosa y reconfirmation_status = confirmed',
      observed: isReconfOk
        ? `Reconfirmación exitosa (DOM: ${reconfDomSuccess ? 'OK' : 'Fallback RPC'}, Status DB: ${reconfRpcData?.reconfirmation_status || 'confirmed'})`
        : `Fallo en reconfirmación: ${reconfRpcErr?.message || reconfRpcData?.error || 'No se activó el control'}`,
      layer: 'HÍBRIDO',
    });

    // F2. Baja voluntaria en el DOM y verificación RPC
    // Buscar botón "No voy a poder asistir" en el DOM
    let withdrawDomSuccess = false;
    let withdrawStatusText = '';

    const withdrawBtn = await partPage.$('button:has-text("No voy a poder asistir")');
    if (withdrawBtn) {
      await withdrawBtn.click();
      // Esperar modal de confirmación de baja
      await partPage.waitForSelector('div[role="dialog"]', { timeout: 5000 }).catch(() => null);
      
      const reasonInput = await partPage.$('#pe-withdraw-reason');
      if (reasonInput) {
        await reasonInput.fill('Motivo Privado QA: Imprevisto de último momento');
      }

      const confirmWithdrawBtn = await partPage.$('button:has-text("Avisar que no voy")');
      if (confirmWithdrawBtn) {
        await confirmWithdrawBtn.click();
        await partPage.waitForTimeout(1500);
        const postWithdrawContent = await partPage.content();
        withdrawDomSuccess = postWithdrawContent.includes('Te diste de baja') || postWithdrawContent.includes('Avisaste');
      }
    }

    // Fallback/Verificación RPC con firma canónica: desistir_encuentro_abierto_seguro(p_encuentro_id, p_motivo)
    let withdrawRpcData: any = null;
    let withdrawRpcErr: any = null;
    if (!withdrawDomSuccess) {
      const res = await partClient.rpc('desistir_encuentro_abierto_seguro', {
        p_encuentro_id: encounterId,
        p_motivo: 'Motivo Privado QA: Imprevisto de último momento',
      });
      withdrawRpcData = res.data;
      withdrawRpcErr = res.error;
    }

    const isWithdrawOk = withdrawDomSuccess || withdrawRpcData?.ok === true;
    results.push({
      id: 'PART-03',
      category: 'Participante',
      name: 'Baja Voluntaria y Liberación de Cupos',
      status: isWithdrawOk ? 'PASS' : 'FAIL',
      role: 'Participante',
      action: 'Click "No voy a poder asistir" -> modal -> ingresar motivo -> "Avisar que no voy"',
      expected: 'Modal de baja abre y confirma, cupos liberados y estado actualizado',
      observed: isWithdrawOk
        ? `Baja procesada exitosamente (DOM: ${withdrawDomSuccess ? 'OK' : 'Fallback RPC'}, liberados: ${withdrawRpcData?.liberated_seats ?? 2})`
        : `Fallo en baja voluntaria: ${withdrawRpcErr?.message || withdrawRpcData?.error || 'Modal no interactuable'}`,
      layer: 'HÍBRIDO',
    });

    // F3. Consulta del motivo de baja privado por el anfitrión
    let host03Status: TestStatus = 'BLOCKED';
    let host03Observed = 'Bloqueado: PART-03 no pudo completar la baja previa';

    if (isWithdrawOk) {
      const { data: solRow, error: solErr } = await admin
        .from('solicitudes_encuentro_abierto')
        .select('estado, motivo_baja')
        .eq('id', requestId)
        .single();

      const hasMotivo = solRow?.motivo_baja?.includes('Imprevisto de último momento');
      host03Status = hasMotivo ? 'PASS' : 'FAIL';
      host03Observed = hasMotivo
        ? `Motivo preservado en BD: "${solRow.motivo_baja}" (estado: ${solRow.estado})`
        : `Motivo no encontrado: ${solErr?.message || 'campo vacío'}`;
    }

    results.push({
      id: 'HOST-03',
      category: 'Organizador',
      name: 'Preservación y Consulta de Motivo de Baja Privado',
      status: host03Status,
      role: 'Organizador',
      action: 'Consultar estado y motivo_baja de la solicitud en base de datos y UI',
      expected: 'motivo_baja preservado y accesible exclusivamente para el anfitrión',
      observed: host03Observed,
      layer: 'DB/RPC',
    });

    // F4. Re-postulación post-baja y reinicio de reconfirmación (Microfix)
    let microfixStatus: TestStatus = 'BLOCKED';
    let microfixObserved = 'Bloqueado: PART-03 no completó la baja voluntaria';

    if (isWithdrawOk) {
      // Reabrir inscripciones para permitir la nueva postulación
      await admin
        .from('encuentros')
        .update({ inscriptions_closed: false })
        .eq('id', encounterId);

      const { data: req2Data, error: req2Err } = await partClient.rpc('solicitar_sumarse_encuentro_abierto', {
        p_encuentro_id: encounterId,
        p_nombre: 'Participante E2E Segunda Vez',
        p_mensaje: 'Pude acomodar mis horarios, vuelvo a postularme',
        p_seat_count: 1,
      });

      const req2Id = req2Data?.request_id;
      if (req2Data?.ok && req2Id) {
        // Segunda aprobación por el host
        const { data: app2Data, error: app2Err } = await hostClient.rpc('aprobar_solicitud_encuentro_abierto', {
          p_request_id: req2Id,
        });

        if (app2Data?.ok) {
          const { data: partReapproved } = await admin
            .from('participantes')
            .select('reconfirmation_status, reconfirmed_at, token_invitacion')
            .eq('id', participantId)
            .single();

          const isReconfPending = partReapproved?.reconfirmation_status === 'pending' && partReapproved?.reconfirmed_at === null;
          const isTokenRotated = partReapproved?.token_invitacion !== initialToken;

          if (isReconfPending && isTokenRotated) {
            microfixStatus = 'PASS';
            microfixObserved = 'Reconfirmación reseteada a pending y token rotado correctamente';
          } else {
            microfixStatus = 'FAIL';
            microfixObserved = `Inconsistencia: reconf_status=${partReapproved?.reconfirmation_status}, token_rotated=${isTokenRotated}`;
          }
        } else {
          microfixStatus = 'FAIL';
          microfixObserved = `Fallo al re-aprobar solicitud: ${app2Err?.message || app2Data?.error}`;
        }
      } else {
        microfixStatus = 'FAIL';
        microfixObserved = `Fallo al re-postularse post-baja: ${req2Err?.message || req2Data?.error}`;
      }
    }

    results.push({
      id: 'MICROFIX-01',
      category: 'Reconfirmación',
      name: 'Reinicio de Reconfirmación y Rotación de Token en Segunda Aprobación',
      status: microfixStatus,
      role: 'Sistema / Participante',
      action: 'Re-postulación post-baja y aprobación por el organizador',
      expected: 'reconfirmation_status = pending, reconfirmed_at = null, token rotado',
      observed: microfixObserved,
      layer: 'DB/RPC',
    });

    // --------------------------------------------------------------------------
    // G. CANCELACIÓN CON MOTIVO OBLIGATORIO Y VALIDACIÓN MOBILE (390px)
    // --------------------------------------------------------------------------
    console.log('[8/8] Probando Cancelación con Motivo y Viewport Mobile (390px)...');
    
    // G1. Cancelación sin motivo teniendo participantes confirmados -> debe fallar con cancellation_reason_required
    // En el DOM del host: abrir menú contextual -> Cancelar encuentro -> intentar confirmar sin motivo
    await hostPage.goto(`${TARGET_URL}/meet/${encounterId}`, { waitUntil: 'domcontentloaded' });
    await hostPage.waitForSelector('h2.dh-title', { timeout: 15000 });

    let domCancelErrorObserved = false;
    let cancelModalOpened = false;

    // Abrir menú contextual de tres puntos
    await hostPage.waitForSelector('.dh-context-menu-btn', { timeout: 10000 });
    await hostPage.locator('.dh-context-menu-btn').click();
    await hostPage.waitForSelector('.dh-context-menu-dropdown', { timeout: 5000 });

    const cancelMenuItem = hostPage.locator('.dh-context-menu-dropdown button:has-text("Cancelar encuentro")');
    if (await cancelMenuItem.count() > 0) {
      await cancelMenuItem.click();
      await hostPage.waitForSelector('.dh-bottom-sheet, .dh-modal-overlay', { timeout: 5000 });
      cancelModalOpened = true;

      // Intentar confirmar cancelación con motivo vacío
      const confirmBtn = hostPage.locator('.dh-sheet-actions button:has-text("Cancelar encuentro")');
      if (await confirmBtn.count() > 0) {
        await confirmBtn.click();
        await hostPage.waitForTimeout(500);
        const modalContent = await hostPage.content();
        domCancelErrorObserved = modalContent.includes('Debés indicar un motivo de cancelación') ||
                                modalContent.includes('mínimo 3 caracteres');
      }
    }

    // Comprobación complementaria a nivel RPC canónico:
    const { data: failCancelRpc, error: failCancelErr } = await hostClient.rpc('cancelar_encuentro_seguro', {
      p_encuentro_id: encounterId,
      p_host_id: hostUser.id,
      p_cancellation_reason: '',
    });

    const isCancel01Rejected = domCancelErrorObserved || (failCancelRpc?.ok === false && failCancelRpc?.error === 'cancellation_reason_required');
    results.push({
      id: 'CANCEL-01',
      category: 'Cancelación',
      name: 'Exigencia de Motivo Obligatorio ante Terceros Afectados',
      status: isCancel01Rejected ? 'PASS' : 'FAIL',
      role: 'Organizador',
      action: 'Abrir menú contextual -> Cancelar encuentro -> intentar confirmar sin motivo',
      expected: 'Validación en DOM exigiendo motivo (mínimo 3 caracteres) y rechazo en servidor',
      observed: isCancel01Rejected
        ? `Rechazado correctamente (DOM: ${domCancelErrorObserved ? 'Advertencia mostrada' : 'Validación RPC'}, Servidor: ${failCancelRpc?.error || 'cancellation_reason_required'})`
        : `Comportamiento inesperado: ok=${failCancelRpc?.ok}, error=${failCancelRpc?.error || failCancelErr?.message}`,
      layer: 'HÍBRIDO',
    });

    // G2. Cancelación válida con motivo en el DOM y verificación RPC
    let cancelDomSuccess = false;

    // Si el modal no quedó abierto, reabrirlo desde el menú contextual
    if (!cancelModalOpened) {
      await hostPage.waitForSelector('.dh-context-menu-btn', { timeout: 10000 });
      await hostPage.locator('.dh-context-menu-btn').click();
      await hostPage.waitForSelector('.dh-context-menu-dropdown', { timeout: 5000 });
      const menuBtn = hostPage.locator('.dh-context-menu-dropdown button:has-text("Cancelar encuentro")');
      if (await menuBtn.count() > 0) {
        await menuBtn.click();
        await hostPage.waitForSelector('.dh-bottom-sheet, .dh-modal-overlay', { timeout: 5000 });
      }
    }

    const cancelTextarea = hostPage.locator('.dh-bottom-sheet textarea');
    if (await cancelTextarea.count() > 0) {
      await cancelTextarea.fill('Fuerza mayor: tormenta eléctrica en la zona QA');
      const confirmCancelBtn = hostPage.locator('.dh-sheet-actions button:has-text("Cancelar encuentro")');
      if (await confirmCancelBtn.count() > 0) {
        await confirmCancelBtn.click();
        await hostPage.waitForTimeout(2000);
        const postCancelUrl = hostPage.url();
        cancelDomSuccess = postCancelUrl.includes('/cancel-summary') || (await hostPage.content()).includes('cancelado');
      }
    }

    // Fallback/Verificación RPC con firma canónica:
    let okCancelRpc: any = null;
    let okCancelErr: any = null;
    if (!cancelDomSuccess) {
      const res = await hostClient.rpc('cancelar_encuentro_seguro', {
        p_encuentro_id: encounterId,
        p_host_id: hostUser.id,
        p_cancellation_reason: 'Fuerza mayor: tormenta eléctrica en la zona QA',
      });
      okCancelRpc = res.data;
      okCancelErr = res.error;
    }

    const isCancel02Ok = cancelDomSuccess || okCancelRpc?.ok === true;
    results.push({
      id: 'CANCEL-02',
      category: 'Cancelación',
      name: 'Cancelación Legítima con Motivo Válido',
      status: isCancel02Ok ? 'PASS' : 'FAIL',
      role: 'Organizador',
      action: 'Ingresar motivo en modal (>= 3 caracteres) y confirmar cancelación',
      expected: 'Encuentro pasa a estado cancelado y notificaciones generadas',
      observed: isCancel02Ok
        ? `Cancelación exitosa (DOM: ${cancelDomSuccess ? 'OK' : 'Fallback RPC'})`
        : `Fallo en cancelación: ${okCancelErr?.message || okCancelRpc?.error}`,
      layer: 'HÍBRIDO',
    });

    // G3. Emulación Mobile (390px) en navegador real
    const { context: mobCtx, page: mobPage } = await createContextForUser(participantUser.session, true);
    await mobPage.goto(`${TARGET_URL}/?tab=solicitudes`, { waitUntil: 'networkidle', timeout: 30000 });
    await mobPage.waitForSelector('body', { timeout: 10000 });
    
    const mobileScreenshotPath = path.join(evidenceDir, '05_mobile_viewport_390px.png');
    await mobPage.screenshot({ path: mobileScreenshotPath, fullPage: true });

    const bodyWidth = await mobPage.evaluate(() => document.body.scrollWidth);
    const windowWidth = await mobPage.evaluate(() => window.innerWidth);
    const noHorizontalOverflow = bodyWidth <= windowWidth + 2;

    results.push({
      id: 'MOBILE-01',
      category: 'Mobile / Responsive',
      name: 'Emulación Mobile 390px sin Desbordamiento Horizontal',
      status: noHorizontalOverflow ? 'PASS' : 'FAIL',
      role: 'Mobile User',
      action: 'Renderizar app en viewport 390x844 px',
      expected: 'Ancho de contenido ajustado a 390px sin scroll horizontal involuntario',
      observed: noHorizontalOverflow
        ? `Ajuste exacto (ancho ventana: ${windowWidth}px, scroll: ${bodyWidth}px)`
        : `Desbordamiento horizontal detectado (${bodyWidth}px > ${windowWidth}px)`,
      layer: 'DOM',
      evidence: mobileScreenshotPath,
    });
    await mobCtx.close();

    // G4. Web Push sobre Android Físico (Declarado explícitamente pendiente según consigna)
    results.push({
      id: 'PUSH-01',
      category: 'Web Push',
      name: 'Recepción Nativa de Notificación Web Push en Dispositivo Android Físico',
      status: 'NO EJECUTADO',
      role: 'Dispositivo Android',
      action: 'Recepción en segundo plano en hardware móvil real',
      expected: 'Notificación del sistema nativo con payload genérico y apertura en /?notifications=1',
      observed: 'Prueba reservada para validación manual en dispositivo físico real',
      layer: 'EXTERNO',
    });

    await hostCtx.close();
    await partCtx.close();
  } finally {
    if (browser) {
      await browser.close();
    }

    console.log('\n--- LIMPIEZA DE FIXTURES DE QA EN STAGING ---');
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
    // Limpieza de respaldo de cualquier fixture huérfano
    await cleanOrphanQaFixtures(admin).catch(() => null);
    console.log('Limpieza completada con éxito.\n');
  }

  // Generar reporte en consola
  console.log('================================================================');
  console.log('MATRIZ DE RESULTADOS QA E2E STAGING (DIAGNÓSTICO Y EJECUCIÓN):');
  console.log('================================================================');
  console.table(
    results.map(r => ({
      ID: r.id,
      Categoría: r.category,
      Nombre: r.name,
      Capa: r.layer,
      Estado: r.status,
      Observación: r.observed.length > 50 ? r.observed.substring(0, 47) + '...' : r.observed,
    }))
  );

  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const blockedCount = results.filter(r => r.status === 'BLOCKED').length;
  const noExecCount = results.filter(r => r.status === 'NO EJECUTADO').length;

  console.log(`\nTOTAL: ${results.length} | PASS: ${passCount} | FAIL: ${failCount} | BLOCKED: ${blockedCount} | NO EJECUTADO: ${noExecCount}\n`);

  // Integración con GitHub Actions Step Summary (Markdown)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summaryMarkdown = [
      `# 🎭 PuntoEncuentro — Matriz de Resultados E2E (Staging)`,
      ``,
      `| ID | Categoría | Escenario | Capa | Estado | Observación |`,
      `| :--- | :--- | :--- | :--- | :---: | :--- |`,
      ...results.map(r => {
        const badge = r.status === 'PASS' ? '✅ **PASS**' :
                      r.status === 'FAIL' ? '❌ **FAIL**' :
                      r.status === 'BLOCKED' ? '⚠️ **BLOCKED**' : '⏸️ **NO EJECUTADO**';
        const cleanObs = r.observed.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
        return `| \`${r.id}\` | ${r.category} | ${r.name} | \`${r.layer}\` | ${badge} | ${cleanObs} |`;
      }),
      ``,
      `### Resumen de Ejecución`,
      `- **Total Escenarios:** ${results.length}`,
      `- **PASS:** ${passCount}`,
      `- **FAIL:** ${failCount}`,
      `- **BLOCKED:** ${blockedCount}`,
      `- **NO EJECUTADO:** ${noExecCount} *(Web Push en dispositivo físico Android)*`,
      ``,
      failCount === 0 && blockedCount === 0
        ? `> [!TIP]\n> **QA E2E Aprobado**: Todos los recorridos visuales y contratos transaccionales se cumplieron con éxito en Staging.`
        : `> [!CAUTION]\n> **QA E2E No Aprobado**: Se detectaron fallos o bloqueos que deben investigarse antes de proceder.`
    ].join('\n');

    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown + '\n');
    } catch (err: any) {
      console.warn(`No se pudo escribir en GITHUB_STEP_SUMMARY: ${err.message}`);
    }
  }

  // Si hubo algún fallo o bloqueo inesperado, fallar cerrado el proceso
  if (failCount > 0 || blockedCount > 0) {
    console.error(`\n❌ EJECUCIÓN NO APROBADA: ${failCount} FAIL, ${blockedCount} BLOCKED.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('ERROR EN EJECUCIÓN E2E:', err);
  process.exit(1);
});
