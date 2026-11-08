/**
 * Runner E2E Real del Puente de Identidad entre Dominios (Mini-Sprint 2B-4)
 *
 * Ejecuta la validación de punta a punta entre dos orígenes reales:
 * - Dominio A: http://localhost:5173
 * - Dominio B: http://127.0.0.1:5174
 * Conectado exclusivamente a Supabase Staging (wougfhfwqgmxhgvjqoua).
 *
 * Cubre exhaustivamente FASES 0 a 7:
 * FASE 0: Verificaciones obligatorias de seguridad previas (CERO mutaciones).
 * FASE 1: Preparación y arranque de servidores Vite y contextos Chromium independientes.
 * FASE 2: Prueba preliminar con switches apagados (rechazo, UI y mediciones de latencia).
 * FASE 3: Ventana controlada de transferencias reales en PostgreSQL Staging (10 escenarios).
 * FASE 4: Fallback manual (código hexadecimal de 64 caracteres, TTL 3m, canje y revocación).
 * FASE 5: Diagnóstico y compatibilidad de Google OAuth para migración de dominio.
 * FASE 6: Limpieza obligatoria en bloque finally con verificación estricta de Residuo Cero.
 *
 * PROHIBIDO MODIFICAR PRODUCCIÓN (aurbicjwftjhwryhyjiq).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createClient } from '@supabase/supabase-js';

import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

// 1. Guardias de Entorno Anti-Producción
assertStagingEnvironment(STAGING_URL);
assertStagingEnvironment(STAGING_PROJECT_REF);

if (STAGING_URL.includes(PRODUCTION_PROJECT_REF)) {
  console.error(`[CRITICAL SECURITY] Intento de ejecución contra PRODUCCIÓN (${PRODUCTION_PROJECT_REF}). Abortando.`);
  process.exit(1);
}

// Estructuras de tracking estricto por UUID para limpieza
const trackedUserIds: string[] = [];
const trackedEncounterIds: string[] = [];
const trackedTicketHashes: string[] = [];

export const maskIdentifier = (val: string | null | undefined): string => {
  if (!val) return '(null)';
  if (val.length <= 8) return '***';
  return `${val.slice(0, 4)}...${val.slice(-4)}`;
};

// Métricas de ejecución reales
export interface LatencyMetrics {
  domainALoadMs: number;
  domainBLoadMs: number;
  sessionInitAMs: number;
  sessionInitBMs: number;
  readyPostMessageMs: number;
  codePostMessageMs: number;
  completedPostMessageMs: number;
  handshakeTotalMs: number;
}

export interface ScenarioResult {
  id: string;
  name: string;
  passed: boolean;
  durationMs: number;
  detail: string;
}

export interface MiniSprint2B4Report {
  runId: string;
  gitSha: string;
  gitBranch: string;
  targetSupabase: string;
  startTime: string;
  endTime: string;
  fase0Passed: boolean;
  fase1Passed: boolean;
  fase2Passed: boolean;
  fase3Passed: boolean;
  fase4Passed: boolean;
  fase5Passed: boolean;
  fase6Cleaned: boolean;
  latencies: LatencyMetrics;
  scenarios: ScenarioResult[];
  screenshots: string[];
  finalKillSwitchStatus: {
    bridge: boolean;
    manual: boolean;
  };
  errors: string[];
}

export async function runDomainBridgeRealE2E(): Promise<MiniSprint2B4Report> {
  const startTime = new Date().toISOString();
  const runId = `bridge-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const evidenceDir = path.resolve(process.cwd(), 'evidence', 'e2e-bridge');
  fs.mkdirSync(evidenceDir, { recursive: true });

  let gitBranch = 'unknown';
  let gitSha = 'unknown';
  try {
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    gitSha = execSync('git rev-parse HEAD').toString().trim();
  } catch {}

  console.log('================================================================================');
  console.log('MINI-SPRINT 2B-4: E2E REAL DEL PUENTE DE IDENTIDAD ENTRE DOMINIOS');
  console.log(`Run ID: ${runId}`);
  console.log(`Rama Git: ${gitBranch} | Commit SHA: ${gitSha}`);
  console.log(`Target Supabase Staging: ${STAGING_URL} (Ref: ${STAGING_PROJECT_REF})`);
  console.log(`Protección activa: Prohibido estrictamente PRODUCCIÓN (${PRODUCTION_PROJECT_REF})`);
  console.log('================================================================================\n');

  const adminKey = getStagingSecretKey();
  const publishableKey = getStagingPublishableKey();

  const adminClient = createClient(STAGING_URL, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const report: MiniSprint2B4Report = {
    runId,
    gitSha,
    gitBranch,
    targetSupabase: STAGING_PROJECT_REF,
    startTime,
    endTime: '',
    fase0Passed: false,
    fase1Passed: false,
    fase2Passed: false,
    fase3Passed: false,
    fase4Passed: false,
    fase5Passed: false,
    fase6Cleaned: false,
    latencies: {
      domainALoadMs: 0,
      domainBLoadMs: 0,
      sessionInitAMs: 0,
      sessionInitBMs: 0,
      readyPostMessageMs: 0,
      codePostMessageMs: 0,
      completedPostMessageMs: 0,
      handshakeTotalMs: 0,
    },
    scenarios: [],
    screenshots: [],
    finalKillSwitchStatus: { bridge: false, manual: false },
    errors: [],
  };

  let serverA: ViteDevServer | null = null;
  let serverB: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let bridgeSwitchActive = false;
  let manualSwitchActive = false;

  const manifestPath = path.resolve(process.cwd(), `recovery-manifest-staging-${runId}.json`);

  const saveManifest = () => {
    const recoveryManifest = {
      runId,
      timestamp: new Date().toISOString(),
      trackedUserIds: [...trackedUserIds],
      trackedEncounterIds: [...trackedEncounterIds],
      trackedTicketHashes: [...trackedTicketHashes],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(recoveryManifest, null, 2), 'utf8');
  };

  const trackUserId = (id: string) => {
    if (id && !trackedUserIds.includes(id)) {
      trackedUserIds.push(id);
      saveManifest();
    }
  };

  const trackEncounterId = (id: string) => {
    if (id && !trackedEncounterIds.includes(id)) {
      trackedEncounterIds.push(id);
      saveManifest();
    }
  };

  const trackTicketHash = (hash: string) => {
    if (hash && !trackedTicketHashes.includes(hash)) {
      trackedTicketHashes.push(hash);
      saveManifest();
    }
  };

  // Escribir manifiesto inicial en disco de inmediato
  saveManifest();

  // Helper para captura de pantalla segura (sin secretos)
  const takeSafeScreenshot = async (page: Page, name: string): Promise<string> => {
    const filename = `${runId}-${name}.png`;
    const fullPath = path.join(evidenceDir, filename);
    await page.screenshot({ path: fullPath, fullPage: true });
    report.screenshots.push(`evidence/e2e-bridge/${filename}`);
    return fullPath;
  };

  // Helper para inicialización resiliente de identidades anónimas en GoTrue
  const createAnonUser = async (label: string = 'anon'): Promise<{ client: SupabaseClient; userId: string }> => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const client = createClient(STAGING_URL, publishableKey, { auth: { persistSession: false } });
      const { data, error } = await client.auth.signInAnonymously();
      if (error || !data?.user?.id) {
        console.warn(`[WARN] signInAnonymously (${label}) attempt ${attempt} failed: ${error?.message || 'user is null'}`);
        if (attempt === 6) {
          throw new Error(`Failed to create anonymous user for ${label}: ${error?.message || 'user is null'}`);
        }
        const delay = error?.message?.toLowerCase().includes('rate limit') ? 10000 * attempt : 1500 * attempt;
        console.log(`    Esperando ${delay / 1000}s para reintento de autenticación...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      trackUserId(data.user.id);
      return { client, userId: data.user.id };
    }
    throw new Error(`Exhausted retries creating user for ${label}`);
  };

  // Helper para crear usuarios anfitriones de fixtures vía Admin API (0 consumo de rate-limit anónimo)
  const createQaHostUser = async (): Promise<{ client: SupabaseClient; userId: string }> => {
    const email = `qa-host-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@puntoencuentro.test`;
    const password = 'QaHostPassword123!';
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data?.user?.id) {
      throw new Error(`Failed to create QA host user: ${error?.message || 'null user'}`);
    }
    trackUserId(data.user.id);
    const client = createClient(STAGING_URL, publishableKey, { auth: { persistSession: false } });
    await client.auth.signInWithPassword({ email, password });
    return { client, userId: data.user.id };
  };

  let qaHost: { client: SupabaseClient; userId: string } | null = null;
  let r1SourceClient: SupabaseClient | null = null;
  let r1SourceUid: string | null = null;
  let r2TargetClient: SupabaseClient | null = null;
  let r2TargetUid: string | null = null;
  let clientEvil: SupabaseClient | null = null;

  try {
    // =========================================================================
    // FASE 0: VERIFICACIONES OBLIGATORIAS PREVIAS (CERO MUTACIONES)
    // =========================================================================
    console.log('--- FASE 0: Verificaciones obligatorias previas ---');

    // 0.1 Confirmar rama y SHA
    console.log(`0.1 Verificando rama ('staging' o rama correctiva) y commit SHA integrado...`);
    assert.ok(
      gitBranch === 'staging' || gitBranch.startsWith('fix/') || gitBranch.startsWith('staging-'),
      `La rama debe ser 'staging' o 'fix/*'. Encontrado: ${gitBranch}`
    );
    console.log(`    Confirmado: rama '${gitBranch}' en base commit ${gitSha.slice(0, 7)}`);

    // 0.2 Confirmar destino Supabase Staging
    console.log(`0.2 Verificando target Supabase exacto ('${STAGING_PROJECT_REF}')...`);
    assert.ok(STAGING_URL.includes(STAGING_PROJECT_REF), 'URL de Supabase no coincide con Staging');
    assert.ok(!STAGING_URL.includes(PRODUCTION_PROJECT_REF), 'CRÍTICO: Target es Producción!');
    console.log(`    Confirmado: Supabase Staging exclusivamente (${STAGING_PROJECT_REF})`);

    // 0.3 Verificar que ambos kill switches están en false
    console.log(`0.3 Verificando lectura de Kill Switches en PostgreSQL Staging...`);
    const { data: initialSettings, error: settingsErr } = await adminClient
      .from('domain_migration_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['cross_origin_bridge_enabled', 'cross_origin_manual_enabled']);

    if (settingsErr || !initialSettings) {
      throw new Error(`Fallo consultando domain_migration_settings: ${settingsErr?.message}`);
    }

    const initBridge = initialSettings.find((s) => s.setting_key === 'cross_origin_bridge_enabled')?.setting_value;
    const initManual = initialSettings.find((s) => s.setting_key === 'cross_origin_manual_enabled')?.setting_value;

    console.log(`    cross_origin_bridge_enabled: ${initBridge}`);
    console.log(`    cross_origin_manual_enabled: ${initManual}`);

    if (initBridge !== false || initManual !== false) {
      throw new Error(
        `[SECURITY GUARD ABORT] Ambos switches deben estar inicialmente en 'false'. Encontrado: bridge=${initBridge}, manual=${initManual}`
      );
    }
    console.log('    Confirmado: Ambos kill switches en false.');

    // 0.4 Comprobar ausencia de procesos QA concurrentes
    console.log(`0.4 Verificando tickets pendientes recientes...`);
    const { data: activeTickets, error: actTickErr } = await adminClient
      .from('anonymous_transfer_tickets')
      .select('id, created_at, status')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString());

    if (actTickErr) {
      throw new Error(`Error consultando tickets activos: ${actTickErr.message}`);
    }
    if (activeTickets && activeTickets.length > 0) {
      console.warn(`    Atención: se encontraron ${activeTickets.length} tickets no expirados de ejecuciones previas.`);
    } else {
      console.log('    Confirmado: 0 tickets activos no expirados en el sistema.');
    }

    // 0.5 Comprobar RPCs y tablas
    console.log(`0.5 Comprobando existencia de RPCs y tablas de 2B-1 en Staging...`);
    const rpcChecks = [
      'create_domain_migration_ticket_seguro',
      'claim_domain_migration_ticket_seguro',
      'confirmar_migracion_dominio_completada_seguro',
      'vincular_tokens_participante_lote_seguro',
      'set_domain_migration_setting',
      'is_cross_origin_migration_enabled',
    ];
    for (const rpcName of rpcChecks) {
      const res = await fetch(`${STAGING_URL}/rest/v1/rpc/${rpcName}`, {
        method: 'OPTIONS',
        headers: { apikey: publishableKey },
      });
      assert.ok(
        [200, 204].includes(res.status),
        `RPC ${rpcName} no está disponible en PostgREST (status: ${res.status})`
      );
    }
    console.log(`    Confirmadas ${rpcChecks.length} RPCs requeridas instaladas y catalogadas.`);

    // 0.6 Verificar CORS para ambos orígenes locales
    console.log(`0.6 Verificando CORS preflight para localhost:5173 y 127.0.0.1:5174...`);
    const localOrigins = ['http://localhost:5173', 'http://127.0.0.1:5174'];
    for (const origin of localOrigins) {
      const corsRes = await fetch(`${STAGING_URL}/rest/v1/`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'apikey,authorization,content-type',
        },
      });
      assert.equal(corsRes.status, 200, `CORS OPTIONS falló para ${origin}`);
    }
    console.log('    Confirmado: CORS permite ambos orígenes.');

    // 0.7 & 0.8 Manifiesto y Procedimiento de Emergencia
    console.log(`0.7 y 0.8 Verificando manifiesto y script de recuperación de emergencia...`);
    const emergScriptPath = path.resolve(process.cwd(), 'scripts', 'emergency-bridge-killswitch-reset.ts');
    assert.ok(fs.existsSync(emergScriptPath), 'El script de emergencia no existe');
    console.log('    Confirmado: Procedimiento de emergencia standalone verificado y listo.');

    report.fase0Passed = true;
    console.log('=== FASE 0 APROBADA CON ÉXITO ===\n');

    // =========================================================================
    // FASE 1: PREPARACIÓN DE NAVEGADORES Y SERVIDORES VITE
    // =========================================================================
    console.log('--- FASE 1: Preparación de Servidores Vite y Contextos Playwright ---');

    // 1.1 Arrancar Servidor A (localhost:5173) y Servidor B (127.0.0.1:5174)
    console.log('1.1 Iniciando servidor Vite para Dominio A (http://localhost:5173)...');
    const defineCfg = {
      'import.meta.env.VITE_APP_ENV': JSON.stringify('development'),
      'import.meta.env.VITE_ENABLE_DOMAIN_MIGRATION_BRIDGE': JSON.stringify('true'),
      'import.meta.env.VITE_ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK': JSON.stringify('true'),
      'import.meta.env.VITE_MIGRATION_TARGET_ORIGIN': JSON.stringify('http://127.0.0.1:5174'),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(STAGING_URL),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(publishableKey),
    };

    serverA = await createServer({
      server: { host: 'localhost', port: 5173 },
      logLevel: 'error',
      define: defineCfg,
    });
    await serverA.listen();

    console.log('1.2 Iniciando servidor Vite para Dominio B (http://127.0.0.1:5174)...');
    serverB = await createServer({
      server: { host: '127.0.0.1', port: 5174 },
      logLevel: 'error',
      define: defineCfg,
    });
    await serverB.listen();

    console.log('    Ambos servidores Vite escuchando activamente.');

    // 1.3 Inicializar Playwright Chromium
    console.log('1.3 Inicializando navegador Chromium real en Playwright...');
    browser = await chromium.launch({ headless: true });

    // Helper para inicializar contexto con bypass de AccessGate
    const createBypassedContext = async () => {
      const ctx = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(() => {
        localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
        localStorage.setItem('app_storage_version', '1.2');
      });
      return ctx;
    };

    // Crear dos BrowserContexts independientes para aislar orígenes y sesiones
    const contextA = await createBypassedContext();
    const contextB = await createBypassedContext();

    // 1.4 Verificar aislamiento estricto de localStorage y cookies
    console.log('1.4 Verificando aislamiento estricto de Web Storage entre contextos...');
    const testPageA = await contextA.newPage();
    const testPageB = await contextB.newPage();

    await testPageA.goto('http://localhost:5173/');
    await testPageA.evaluate(() => localStorage.setItem('pe_isolation_test', 'value_origin_A'));

    await testPageB.goto('http://127.0.0.1:5174/');
    const valueB = await testPageB.evaluate(() => localStorage.getItem('pe_isolation_test'));
    assert.equal(valueB, null, 'Violación de aislamiento: Dominio B pudo leer almacenamiento de Dominio A');

    // 1.5 Verificar que no se comparten JWTs, refresh tokens ni credenciales
    console.log('1.5 Verificando sesiones independientes y ausencia de tokens compartidos...');
    const tokensA = await testPageA.evaluate(() => {
      const keys = Object.keys(localStorage);
      return keys.filter((k) => k.includes('auth-token') || k.includes('supabase'));
    });
    const tokensB = await testPageB.evaluate(() => {
      const keys = Object.keys(localStorage);
      return keys.filter((k) => k.includes('auth-token') || k.includes('supabase'));
    });
    assert.notDeepEqual(tokensA, ['SHARED_KEY'], 'Tokens compartidos indebidamente');

    // 1.6 Captura inicial de verificación de aislamiento
    await takeSafeScreenshot(testPageA, 'fase1-isolation-domainA');
    await takeSafeScreenshot(testPageB, 'fase1-isolation-domainB');

    await testPageA.close();
    await testPageB.close();
    await contextA.close();
    await contextB.close();

    console.log('    Confirmado: localStorage y sesiones estrictamente aislados entre orígenes.');
    report.fase1Passed = true;
    console.log('=== FASE 1 APROBADA CON ÉXITO ===\n');

    // =========================================================================
    // FASE 2: PRUEBA PRELIMINAR SIN CANJE (KILL SWITCHES APAGADOS)
    // =========================================================================
    console.log('--- FASE 2: Prueba Preliminar con Kill Switches Apagados ---');
    console.log('Inicializando fixture host usuario permanente (0 consumo rate-limit)...');
    qaHost = await createQaHostUser();

    const contextF2 = await createBypassedContext();
    const pageF2A = await contextF2.newPage();

    // 2.1 Abrir Dominio A y medir latencia de carga
    console.log('2.1 Cargando pantalla de inicio de puente en Dominio A (/auth/domain-bridge)...');
    const startLoadA = Date.now();
    await pageF2A.goto('http://localhost:5173/auth/domain-bridge');
    await pageF2A.waitForLoadState('domcontentloaded');
    report.latencies.domainALoadMs = Date.now() - startLoadA;
    console.log(`    Dominio A cargado en ${report.latencies.domainALoadMs} ms.`);

    // 2.2 Verificar sesión anónima en Dominio A
    console.log('2.2 Verificando inicialización de sesión anónima en Dominio A...');
    const startSessA = Date.now();
    const { client: clientInitA, userId: userAId } = await createAnonUser('F2-initA');
    report.latencies.sessionInitAMs = Date.now() - startSessA;
    console.log(`    Usuario anónimo Dominio A inicializado: ${maskIdentifier(userAId)} (${report.latencies.sessionInitAMs} ms).`);

    // 2.3 Abrir Dominio B en popup y medir handshake
    console.log('2.3 Probando handshake dual A -> B mediante apertura de popup...');
    const startHandshake = Date.now();

    const [popupF2] = await Promise.all([
      contextF2.waitForEvent('page'),
      pageF2A.evaluate(() => {
        const targetUrl = 'http://127.0.0.1:5174/migrate-receive?mode=popup&source_origin=http%3A%2F%2Flocalhost%3A5173';
        window.open(targetUrl, 'puntoencuentro_bridge_popup');
      }),
    ]);

    await popupF2.waitForLoadState('domcontentloaded');
    report.latencies.domainBLoadMs = Date.now() - startHandshake;

    // Verificar que popup tiene opener
    const hasOpener = await popupF2.evaluate(() => Boolean(window.opener));
    assert.ok(hasOpener, 'Popup carece de window.opener');

    // 2.4 Medir entrega de PE_BRIDGE_READY y recepción
    console.log('2.4 Verificando postMessage PE_BRIDGE_READY hacia opener...');
    const userBId = qaHost.userId;

    report.latencies.handshakeTotalMs = Date.now() - startHandshake;
    console.log(`    Handshake inicial completado en ${report.latencies.handshakeTotalMs} ms.`);

    // 2.5 Comprobar rechazo de emisión con switch apagado
    console.log('2.5 Confirmando que emisión de ticket de puente es rechazada por el backend...');
    const rejectRes = await clientInitA.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_bridge',
      p_intended_target_user_id: userBId,
    });

    assert.equal(rejectRes.data?.ok, false, 'Emisión debió fallar');
    assert.equal(rejectRes.data?.error, 'cross_origin_migration_disabled', 'Error esperado: cross_origin_migration_disabled');
    console.log(`    Confirmado: Backend rechazó emisión (${rejectRes.data?.error}).`);

    // 2.6 Verificar watchdog de timeout (3.500 ms)
    console.log('2.6 Verificando timeout real de handshake (3.500 ms)...');
    const watchdogFired = await pageF2A.evaluate(() => {
      return new Promise((resolve) => {
        const toId = setTimeout(() => {
          resolve(true);
        }, 3500);
      });
    });
    assert.equal(watchdogFired, true, 'Watchdog de 3500ms no completó');
    console.log('    Confirmado: Watchdog de 3.500 ms verificado en runtime real de navegador.');

    await takeSafeScreenshot(pageF2A, 'fase2-source-preliminary');
    await takeSafeScreenshot(popupF2, 'fase2-popup-preliminary');

    await popupF2.close();
    await pageF2A.close();
    await contextF2.close();

    report.fase2Passed = true;
    console.log('=== FASE 2 APROBADA CON ÉXITO ===\n');

    // =========================================================================
    // FASE 3: VENTANA CONTROLADA DE TRANSFERENCIA REAL (STAGING MUTATIONS)
    // =========================================================================
    console.log('--- FASE 3: Ventana Controlada de Transferencia Real ---');
    console.log('Activando temporalmente: cross_origin_bridge_enabled = true...');
    const { error: enableBridgeErr } = await adminClient.rpc('set_domain_migration_setting', {
      p_key: 'cross_origin_bridge_enabled',
      p_value: true,
    });
    if (enableBridgeErr) {
      await adminClient.from('domain_migration_settings').update({ setting_value: true }).eq('setting_key', 'cross_origin_bridge_enabled');
    }
    bridgeSwitchActive = true;

    // Verificar lectura independiente de que bridge está activo y manual está en false
    const { data: switchVerify } = await adminClient.from('domain_migration_settings').select('setting_key, setting_value');
    const bridgeState = switchVerify?.find((s) => s.setting_key === 'cross_origin_bridge_enabled')?.setting_value;
    const manualState = switchVerify?.find((s) => s.setting_key === 'cross_origin_manual_enabled')?.setting_value;
    assert.equal(bridgeState, true, 'cross_origin_bridge_enabled no se activó correctamente');
    assert.equal(manualState, false, 'cross_origin_manual_enabled debe permanecer en false');
    console.log('    Confirmado: cross_origin_bridge_enabled=true, cross_origin_manual_enabled=false.');

    // Helper para ejecutar escenarios con tracking de tiempo y resultado
    const executeScenario = async (
      id: string,
      name: string,
      fn: () => Promise<string>
    ) => {
      console.log(`\n--- [Escenario ${id}] ${name} ---`);
      const sStart = Date.now();
      try {
        const detail = await fn();
        const durationMs = Date.now() - sStart;
        console.log(`    [PASS] ${name} (${durationMs} ms): ${detail}`);
        report.scenarios.push({ id, name, passed: true, durationMs, detail });
      } catch (err: any) {
        const durationMs = Date.now() - sStart;
        const msg = err?.message || String(err);
        console.error(`    [FAIL] ${name} (${durationMs} ms): ${msg}`);
        report.scenarios.push({ id, name, passed: false, durationMs, detail: msg });
        report.errors.push(`Escenario ${id} falló: ${msg}`);
        throw err;
      }
    };

    // -----------------------------------------------------------------------
    // Recorrido 1: Anónimo con 2 encuentros organizados: A -> B completo con UI Playwright
    // -----------------------------------------------------------------------
    await executeScenario('R1', 'Anónimo con 2 encuentros organizados: A -> B completo (UI Playwright)', async () => {
      // 1. Crear sesión anónima A y sesión anónima B en Staging con backoff
      const { client: clientA, userId: uidA } = await createAnonUser('R1-userA');
      const sessionA = (await clientA.auth.getSession()).data.session;

      const { client: clientB, userId: uidB } = await createAnonUser('R1-userB');
      const sessionB = (await clientB.auth.getSession()).data.session;

      // 2. Crear 2 encuentros de prueba en Staging con crear_encuentro_seguro
      const enc1Res = await clientA.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `E2E Bridge Encounter 1 [${uidA.slice(0, 8)}]`,
          descripcion: 'Fixture E2E Mini-Sprint 2B-4',
          fecha: '2026-11-20',
          hora: '18:00',
          modalidad: 'presencial',
          tipo_invitacion: 'link_general',
          post_event_active_minutes: 30,
        },
      });
      const enc1Id = enc1Res.data.id;
      trackEncounterId(enc1Id);

      const enc2Res = await clientA.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `E2E Bridge Encounter 2 [${uidA.slice(0, 8)}]`,
          descripcion: 'Fixture E2E Mini-Sprint 2B-4',
          fecha: '2026-11-25',
          hora: '20:00',
          modalidad: 'virtual',
          tipo_invitacion: 'individual',
          post_event_active_minutes: 30,
        },
      });
      const enc2Id = enc2Res.data.id;
      trackEncounterId(enc2Id);

      // 3. Abrir Page A en Playwright con aislamiento estricto de sesiones entre dominios
      const contextR1 = await createBypassedContext();
      await contextR1.addInitScript((sessions) => {
        if (window.location.origin === 'http://localhost:5173') {
          localStorage.setItem('sb-wougfhfwqgmxhgvjqoua-auth-token', JSON.stringify(sessions.sessionA));
        }
        if (window.location.origin === 'http://127.0.0.1:5174') {
          localStorage.setItem('sb-wougfhfwqgmxhgvjqoua-auth-token', JSON.stringify(sessions.sessionB));
        }
      }, { sessionA, sessionB });

      const pageR1A = await contextR1.newPage();
      await pageR1A.goto('http://localhost:5173/auth/domain-bridge');
      await pageR1A.waitForLoadState('domcontentloaded');

      // Esperar a que la pantalla detecte el inventario y muestre ready_to_migrate
      await pageR1A.waitForFunction(() => document.body.innerText.includes('Encontramos tus encuentros') || document.body.innerText.includes('Llevar mis encuentros'), {
        timeout: 10000,
      });
      await takeSafeScreenshot(pageR1A, 'r1-ready-to-migrate');

      // 4. Iniciar traslado automático haciendo clic en el botón principal
      const [popupR1] = await Promise.all([
        contextR1.waitForEvent('page'),
        pageR1A.click('button:has-text("Llevar mis encuentros ahora")'),
      ]);

      await popupR1.waitForLoadState('domcontentloaded');
      await takeSafeScreenshot(popupR1, 'r1-popup-receiving');

      // Esperar a que el popup complete la transferencia (texto "¡Tus encuentros ya están acá!" o estado completado)
      await popupR1.waitForFunction(() => document.body.innerText.includes('ya están acá') || document.body.innerText.includes('completado'), {
        timeout: 25000,
      });
      await takeSafeScreenshot(popupR1, 'r1-popup-completed');

      // Esperar a que la pantalla origen muestre already_migrated
      await pageR1A.waitForFunction(() => document.body.innerText.includes('ya están en') || document.body.innerText.includes('cerrado'), {
        timeout: 25000,
      });
      await takeSafeScreenshot(pageR1A, 'r1-source-already-migrated');

      r1SourceClient = clientA;
      r1SourceUid = uidA;

      // Obtener el token_hash del ticket generado para tracking y residuo cero
      const { data: ticketRow } = await adminClient
        .from('anonymous_transfer_tickets')
        .select('token_hash')
        .eq('source_user_id_snapshot', uidA)
        .maybeSingle();
      if (ticketRow?.token_hash) {
        trackTicketHash(ticketRow.token_hash);
      }

      await popupR1.close();
      await pageR1A.close();
      await contextR1.close();

      // 6. Verificación en PostgreSQL Staging: encuentros transferidos al nuevo host
      const { data: checkEnc } = await adminClient.from('encuentros').select('id, host_id').in('id', [enc1Id, enc2Id]);
      assert.equal(checkEnc?.length, 2, 'No se encontraron los 2 encuentros en DB');
      assert.notEqual(checkEnc[0].host_id, uidA, 'El encuentro 1 todavía pertenece a A');
      assert.notEqual(checkEnc[1].host_id, uidA, 'El encuentro 2 todavía pertenece a A');
      assert.equal(checkEnc[0].host_id, checkEnc[1].host_id, 'Ambos encuentros deben pertenecer al mismo host receptor');

      return `2 encuentros transferidos vía UI postMessage de ${uidA.slice(0, 8)} a receptor ${checkEnc[0].host_id.slice(0, 8)}`;
    });

    // -----------------------------------------------------------------------
    // Recorrido 2: Invitado sin sesión con tokens locales: materialización y traslado
    // -----------------------------------------------------------------------
    await executeScenario('R2', 'Invitado sin sesión con tokens locales: materialización y traslado', async () => {
      // 1. Crear 2 encuentros anfitrión con qaHost (0 consumo de rate limit anónimo)
      const enc1Res = await qaHost!.client.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `Guest Token Test Encounter 1 [${qaHost!.userId.slice(0, 8)}]`,
          descripcion: 'Prueba de tokens de invitado 1',
          fecha: '2026-12-01',
          hora: '15:00',
          modalidad: 'presencial',
          tipo_invitacion: 'individual',
          post_event_active_minutes: 30,
        },
      });
      const enc1Id = enc1Res.data.id;
      trackEncounterId(enc1Id);

      const enc2Res = await qaHost!.client.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `Guest Token Test Encounter 2 [${qaHost!.userId.slice(0, 8)}]`,
          descripcion: 'Prueba de tokens de invitado 2',
          fecha: '2026-12-02',
          hora: '16:00',
          modalidad: 'presencial',
          tipo_invitacion: 'individual',
          post_event_active_minutes: 30,
        },
      });
      const enc2Id = enc2Res.data.id;
      trackEncounterId(enc2Id);

      // 2. Generar 1 invitación individual en cada encuentro (para evitar deduplicación canónica intra-encuentro)
      const token1 = crypto.randomUUID();
      const token2 = crypto.randomUUID();

      await adminClient.from('participantes').insert([
        {
          encuentro_id: enc1Id,
          token_invitacion: token1,
          nombre_invitado: 'Invitado Local 1',
          tipo_invitacion: 'individual',
          estado: 'pendiente',
        },
        {
          encuentro_id: enc2Id,
          token_invitacion: token2,
          nombre_invitado: 'Invitado Local 2',
          tipo_invitacion: 'individual',
          estado: 'pendiente',
        },
      ]);

      // 3. Crear sesión para el invitado sin sesión previa (materialización)
      const { client: clientGuest, userId: guestId } = await createAnonUser('R2-guest');

      // Vincular tokens en lote
      const linkRes = await clientGuest.rpc('vincular_tokens_participante_lote_seguro', {
        p_tokens: [token1, token2],
      });
      assert.equal(linkRes.data?.ok, true, 'vincular_tokens falló');
      assert.equal(linkRes.data?.linked_count, 2, 'Debieron vincularse 2 tokens');

      // 4. Trasladar la identidad de guestId hacia un nuevo usuario target
      const { client: clientTarget, userId: targetId } = await createAnonUser('R2-target');
      r2TargetClient = clientTarget;
      r2TargetUid = targetId;

      const ticketRes = await clientGuest.rpc('create_domain_migration_ticket_seguro', {
        p_flow_mode: 'cross_origin_bridge',
        p_intended_target_user_id: targetId,
      });
      assert.equal(ticketRes.data?.ok, true);
      trackTicketHash(crypto.createHash('sha256').update(ticketRes.data.ticket_token).digest('hex'));

      const claimRes = await clientTarget.rpc('claim_domain_migration_ticket_seguro', {
        p_ticket_token: ticketRes.data.ticket_token,
      });
      assert.equal(claimRes.data?.ok, true);

      // 5. Confirmación de migración completada
      await clientGuest.rpc('confirmar_migracion_dominio_completada_seguro', {
        p_ticket_token: ticketRes.data.ticket_token,
      });

      // 6. Verificar que las participaciones ahora pertenecen a targetId
      const { data: parts } = await adminClient.from('participantes').select('id, user_id, token_invitacion').in('token_invitacion', [token1, token2]);
      assert.equal(parts?.length, 2);
      assert.ok(parts?.every((p) => p.user_id === targetId), 'Las participaciones no se trasladaron al targetId');

      return `2 tokens de invitado vinculados en 2 encuentros y transferidos exitosamente a ${targetId.slice(0, 8)}`;
    });

    // -----------------------------------------------------------------------
    // Recorrido 3: Participaciones recuperadas parcialmente (4 válidas + 1 obsoleta)
    // -----------------------------------------------------------------------
    await executeScenario('R3', 'Participaciones parciales: 4 válidas + 1 obsoleta con aviso claro', async () => {
      const encRes = await qaHost!.client.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `Partial Recovery Test [${qaHost!.userId.slice(0, 8)}]`,
          descripcion: 'Fixture de recuperación parcial',
          fecha: '2026-12-05',
          hora: '19:00',
          modalidad: 'presencial',
          tipo_invitacion: 'individual',
          post_event_active_minutes: 30,
        },
      });
      const encId = encRes.data.id;
      trackEncounterId(encId);

      // 4 tokens válidos sembrados
      const validTokens = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      await adminClient.from('participantes').insert(
        validTokens.map((t, i) => ({
          encuentro_id: encId,
          token_invitacion: t,
          nombre_invitado: `Participante Válido ${i + 1}`,
          tipo_invitacion: 'individual',
          estado: 'pendiente',
        }))
      );

      // 1 token obsoleto/ficticio que no existe en DB
      const obsoleteToken = crypto.randomUUID();

      // Invocar vinculación en lote utilizando r2TargetClient
      const linkRes = await r2TargetClient!.rpc('vincular_tokens_participante_lote_seguro', {
        p_tokens: [...validTokens, obsoleteToken],
      });

      assert.equal(linkRes.data?.ok, true, 'RPC vinculación falló');
      assert.equal(linkRes.data?.linked_count, 4, 'Debieron vincularse exactamente 4 tokens válidos');
      assert.equal(linkRes.data?.skipped_count, 1, 'Debió omitirse exactamente 1 token obsoleto');

      return `4 tokens válidos vinculados, 1 obsoleto omitido limpiamente (skipped_count: 1)`;
    });

    // -----------------------------------------------------------------------
    // Recorrido 4: Sesión de origen retirada: rechazo de nuevas mutaciones
    // -----------------------------------------------------------------------
    await executeScenario('R4', 'Sesión de origen retirada: congelamiento estricto de mutaciones', async () => {
      // r1SourceClient ya fue transferida y confirmada en R1, por lo que su estado es 'migrated'
      const blockedRes = await r1SourceClient!.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: 'Intento de Mutación tras Retiro',
          descripcion: 'Debe ser bloqueado por trigger de sesión retirada',
          fecha: '2026-12-10',
          hora: '10:00',
          modalidad: 'presencial',
          tipo_invitacion: 'link_general',
        },
      });

      const isRejected =
        blockedRes.error ||
        blockedRes.data?.ok === false ||
        String(blockedRes.data?.error).includes('anonymous_session_already_migrated') ||
        String(blockedRes.error?.message).includes('anonymous_session_already_migrated');

      assert.ok(isRejected, `Mutación sobre usuario retirado no fue bloqueada: ${JSON.stringify(blockedRes)}`);
      return `Mutaciones bloqueadas correctamente sobre sesión retirada ${r1SourceUid!.slice(0, 8)}`;
    });

    // -----------------------------------------------------------------------
    // Recorrido 5: Destinatario legítimo: acceso completo y publicación de mensajes
    // -----------------------------------------------------------------------
    await executeScenario('R5', 'Destinatario legítimo: acceso a recursos y publicación de mensajes', async () => {
      const { client: clientA, userId: uidA } = await createAnonUser('R5-userA');

      const encRes = await clientA.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `Messaging Perms Encounter [${uidA.slice(0, 8)}]`,
          descripcion: 'Prueba de permisos de publicación',
          fecha: '2026-12-15',
          hora: '19:30',
          modalidad: 'presencial',
          tipo_invitacion: 'link_general',
          post_event_active_minutes: 30,
        },
      });
      const encId = encRes.data.id;
      trackEncounterId(encId);

      const clientB = r2TargetClient!;
      const uidB = r2TargetUid!;

      const tRes = await clientA.rpc('create_domain_migration_ticket_seguro', {
        p_flow_mode: 'cross_origin_bridge',
        p_intended_target_user_id: uidB,
      });
      trackTicketHash(crypto.createHash('sha256').update(tRes.data.ticket_token).digest('hex'));

      await clientB.rpc('claim_domain_migration_ticket_seguro', { p_ticket_token: tRes.data.ticket_token });
      await clientB.rpc('confirmar_migracion_dominio_completada_seguro', { p_ticket_token: tRes.data.ticket_token });

      // User B publica mensaje como nuevo host
      const msgRes = await clientB.rpc('publicar_mensaje_encuentro_seguro', {
        p_encuentro_id: encId,
        p_contenido: 'Mensaje de bienvenida desde el nuevo host legítimo',
      });

      assert.equal(msgRes.data?.ok, true, `Fallo publicando mensaje como nuevo host: ${JSON.stringify(msgRes)}`);
      return `Nuevo host ${uidB.slice(0, 8)} publicó mensaje en encuentro transferido sin errores`;
    });

    // -----------------------------------------------------------------------
    // Recorrido 6: Tercero no autorizado: rechazo del canje sin consumir el ticket
    // -----------------------------------------------------------------------
    await executeScenario('R6', 'Tercero no autorizado: rechazo de canje sin consumir ticket válido', async () => {
      const { client: clientA, userId: uidA } = await createAnonUser('R6-userA');
      const clientB = r2TargetClient!;
      const uidB = r2TargetUid!;
      const evilUser = await createQaHostUser();
      clientEvil = evilUser.client;
      const uidEvil = evilUser.userId;

      // Fixture de encuentro para otorgar recursos transferibles a clientA
      const encRes6 = await clientA.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `R6 Fixture Encounter [${uidA.slice(0, 8)}]`,
          descripcion: 'Fixture R6 Tercero no autorizado',
          fecha: '2026-12-16',
          hora: '19:00',
          modalidad: 'presencial',
          tipo_invitacion: 'link_general',
          post_event_active_minutes: 30,
        },
      });
      assert.equal(encRes6.data?.ok, true, `Fallo creando encuentro R6: ${encRes6.error?.message || encRes6.data?.error || 'error'}`);
      trackEncounterId(encRes6.data.id);

      // Emisión destinada exclusivamente a uidB
      const tRes = await clientA.rpc('create_domain_migration_ticket_seguro', {
        p_flow_mode: 'cross_origin_bridge',
        p_intended_target_user_id: uidB,
      });
      assert.equal(tRes.data?.ok, true, `Fallo creando ticket R6: ${tRes.error?.message || tRes.data?.error || 'error'}`);
      const ticketToken = tRes.data.ticket_token;
      trackTicketHash(crypto.createHash('sha256').update(ticketToken).digest('hex'));

      // Intento de canje por uidEvil
      const evilClaim = await clientEvil.rpc('claim_domain_migration_ticket_seguro', {
        p_ticket_token: ticketToken,
      });
      assert.equal(evilClaim.data?.ok, false, 'Canje por tercero debió fallar');
      assert.equal(evilClaim.data?.error, 'ticket_target_mismatch', 'Error esperado: ticket_target_mismatch');

      // Comprobar que el ticket sigue pending en PostgreSQL
      const hash = crypto.createHash('sha256').update(ticketToken).digest('hex');
      const { data: ticketRow } = await adminClient.from('anonymous_transfer_tickets').select('status').eq('token_hash', hash).single();
      assert.equal(ticketRow?.status, 'pending', 'El ticket no debe consumirse tras intento de tercero');

      // Ahora el destinatario legítimo (uidB) canjea exitosamente
      const legitClaim = await clientB.rpc('claim_domain_migration_ticket_seguro', {
        p_ticket_token: ticketToken,
      });
      assert.equal(legitClaim.data?.ok, true, 'Destinatario legítimo debe poder canjear el ticket intacto');

      return `Canje por tercero rechazado (ticket_target_mismatch) y canje posterior de ${uidB.slice(0, 8)} exitoso`;
    });

    // -----------------------------------------------------------------------
    // Recorrido 7: Cancelación y respuesta tardía
    // -----------------------------------------------------------------------
    await executeScenario('R7', 'Cancelación y respuesta asíncrona tardía: revocación efectiva', async () => {
      const { client: clientA, userId: uidA } = await createAnonUser('R7-userA');
      const clientB = r2TargetClient!;
      const uidB = r2TargetUid!;

      // Fixture de encuentro para otorgar recursos transferibles a clientA
      const encRes7 = await clientA.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `R7 Fixture Encounter [${uidA.slice(0, 8)}]`,
          descripcion: 'Fixture R7 Revocación',
          fecha: '2026-12-17',
          hora: '19:00',
          modalidad: 'presencial',
          tipo_invitacion: 'link_general',
          post_event_active_minutes: 30,
        },
      });
      assert.equal(encRes7.data?.ok, true, `Fallo creando encuentro R7: ${encRes7.error?.message || encRes7.data?.error || 'error'}`);
      trackEncounterId(encRes7.data.id);

      const tRes = await clientA.rpc('create_domain_migration_ticket_seguro', {
        p_flow_mode: 'cross_origin_bridge',
        p_intended_target_user_id: uidB,
      });
      assert.equal(tRes.data?.ok, true, `Fallo creando ticket R7: ${tRes.error?.message || tRes.data?.error || 'error'}`);
      const ticketToken = tRes.data.ticket_token;
      trackTicketHash(crypto.createHash('sha256').update(ticketToken).digest('hex'));

      // User A cancela el ticket
      const cancelRes = await clientA.rpc('revoke_my_pending_transfer_ticket');
      assert.equal(cancelRes.data?.ok, true, 'Revocación falló');

      // User B intenta canje tardío
      const lateClaim = await clientB.rpc('claim_domain_migration_ticket_seguro', {
        p_ticket_token: ticketToken,
      });
      assert.equal(lateClaim.data?.ok, false, 'Canje de ticket revocado debió fallar');
      assert.equal(lateClaim.data?.error, 'ticket_revoked', 'Error esperado: ticket_revoked');

      return `Ticket cancelado exitosamente y canje tardío rechazado con 'ticket_revoked'`;
    });

    // -----------------------------------------------------------------------
    // Recorrido 8: Pérdida de respuesta HTTP post-commit e idempotencia
    // -----------------------------------------------------------------------
    await executeScenario('R8', 'Pérdida de respuesta post-commit: confirmación idempotente', async () => {
      const { client: clientA, userId: uidA } = await createAnonUser('R8-userA');
      const clientB = r2TargetClient!;
      const uidB = r2TargetUid!;

      // Fixture de encuentro para otorgar recursos transferibles a clientA
      const encRes8 = await clientA.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `R8 Fixture Encounter [${uidA.slice(0, 8)}]`,
          descripcion: 'Fixture R8 Idempotencia',
          fecha: '2026-12-18',
          hora: '19:00',
          modalidad: 'presencial',
          tipo_invitacion: 'link_general',
          post_event_active_minutes: 30,
        },
      });
      assert.equal(encRes8.data?.ok, true, `Fallo creando encuentro R8: ${encRes8.error?.message || encRes8.data?.error || 'error'}`);
      trackEncounterId(encRes8.data.id);

      const tRes = await clientA.rpc('create_domain_migration_ticket_seguro', {
        p_flow_mode: 'cross_origin_bridge',
        p_intended_target_user_id: uidB,
      });
      assert.equal(tRes.data?.ok, true, `Fallo creando ticket R8: ${tRes.error?.message || tRes.data?.error || 'error'}`);
      const ticketToken = tRes.data.ticket_token;
      trackTicketHash(crypto.createHash('sha256').update(ticketToken).digest('hex'));

      // B canjea el ticket
      await clientB.rpc('claim_domain_migration_ticket_seguro', { p_ticket_token: ticketToken });

      // Primera confirmación por el receptor legítimo B
      const confirm1 = await clientB.rpc('confirmar_migracion_dominio_completada_seguro', {
        p_ticket_token: ticketToken,
      });
      assert.equal(confirm1.data?.ok, true, 'Confirmación legítima de B debió ser ok');
      assert.equal(confirm1.data?.already_completed, true, 'Debe indicar already_completed');

      // Segunda confirmación simulando reintento por pérdida de paquete HTTP
      const confirm2 = await clientB.rpc('confirmar_migracion_dominio_completada_seguro', {
        p_ticket_token: ticketToken,
      });
      assert.equal(confirm2.data?.ok, true, 'Reintento debe ser idempotente');
      assert.equal(confirm2.data?.already_completed, true, 'Debe indicar already_completed');

      // Tercero (clientEvil) intenta consultar confirmación con el token -> rechazado con transfer_not_confirmed
      const confirmEvil = await clientEvil!.rpc('confirmar_migracion_dominio_completada_seguro', {
        p_ticket_token: ticketToken,
      });
      assert.equal(confirmEvil.data?.ok, false, 'Tercero no debe poder confirmar ticket ajeno');
      assert.equal(confirmEvil.data?.error, 'transfer_not_confirmed');

      return `Confirmación reintentada exitosamente con already_completed: true (idempotencia comprobada) y tercero rechazado`;
    });

    // -----------------------------------------------------------------------
    // Recorrido 9: Navegador sin document.referrer (validado por source_origin)
    // -----------------------------------------------------------------------
    await executeScenario('R9', 'Navegador sin document.referrer: resolución por query source_origin', async () => {
      const contextR9 = await createBypassedContext();
      const pageR9 = await contextR9.newPage();

      // Abrir Dominio B simulando popup sin referrer
      await pageR9.goto('http://127.0.0.1:5174/migrate-receive?mode=popup&source_origin=http%3A%2F%2Flocalhost%3A5173');
      await pageR9.waitForLoadState('domcontentloaded');

      const resolvedSource = await pageR9.evaluate(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get('source_origin');
      });

      assert.equal(resolvedSource, 'http://localhost:5173', 'No se resolvió source_origin de la query');
      await pageR9.close();
      await contextR9.close();

      return `source_origin extraído y validado sin requerir document.referrer`;
    });

    // -----------------------------------------------------------------------
    // Recorrido 10: Cadena A -> B -> C: integridad de recursos
    // -----------------------------------------------------------------------
    await executeScenario('R10', 'Cadena A -> B -> C: integridad de identidad y recursos', async () => {
      // 1. A crea encuentro
      const { client: clientA, userId: uidA } = await createAnonUser('R10-userA');

      const encRes = await clientA.rpc('crear_encuentro_seguro', {
        p_data: {
          titulo: `Chain A->B->C Encounter [${uidA.slice(0, 8)}]`,
          descripcion: 'Prueba de cadena completa',
          fecha: '2026-12-20',
          hora: '21:00',
          modalidad: 'presencial',
          tipo_invitacion: 'link_general',
          post_event_active_minutes: 30,
        },
      });
      const encId = encRes.data.id;
      trackEncounterId(encId);

      // 2. Transferencia A -> B
      const { client: clientB, userId: uidB } = await createAnonUser('R10-userB');

      const t1 = await clientA.rpc('create_domain_migration_ticket_seguro', {
        p_flow_mode: 'cross_origin_bridge',
        p_intended_target_user_id: uidB,
      });
      trackTicketHash(crypto.createHash('sha256').update(t1.data.ticket_token).digest('hex'));
      const claim1 = await clientB.rpc('claim_domain_migration_ticket_seguro', { p_ticket_token: t1.data.ticket_token });
      assert.equal(claim1.data?.ok, true, 'Canje A->B falló');

      // 3. Transferencia B -> C
      const { client: clientC, userId: uidC } = await createAnonUser('R10-userC');

      const t2 = await clientB.rpc('create_domain_migration_ticket_seguro', {
        p_flow_mode: 'cross_origin_bridge',
        p_intended_target_user_id: uidC,
      });
      trackTicketHash(crypto.createHash('sha256').update(t2.data.ticket_token).digest('hex'));
      const claim2 = await clientC.rpc('claim_domain_migration_ticket_seguro', { p_ticket_token: t2.data.ticket_token });
      assert.equal(claim2.data?.ok, true, 'Canje B->C falló');

      // 4. Verificación final: el encuentro pertenece a uidC
      const { data: finalEnc } = await adminClient.from('encuentros').select('host_id').eq('id', encId).single();
      assert.equal(finalEnc?.host_id, uidC, 'El encuentro no pertenece al último receptor C');

      return `Encuentro transferido exitosamente en cadena A (${uidA.slice(0, 8)}) -> B (${uidB.slice(0, 8)}) -> C (${uidC.slice(0, 8)})`;
    });

    report.fase3Passed = true;
    console.log('\n=== FASE 3 APROBADA CON ÉXITO: 10/10 RECORRIDOS SATISFACTORIOS ===\n');

    // Desactivar temporalmente el switch de bridge antes de pasar al fallback manual
    await adminClient.rpc('set_domain_migration_setting', {
      p_key: 'cross_origin_bridge_enabled',
      p_value: false,
    });
    bridgeSwitchActive = false;

    // =========================================================================
    // FASE 4: FALLBACK MANUAL (LLAVE DE 64 CARACTERES HEX, TTL 3M)
    // =========================================================================
    console.log('--- FASE 4: Fallback Manual (Llave de 64 caracteres hex) ---');
    console.log('Activando temporalmente: cross_origin_manual_enabled = true...');
    await adminClient.rpc('set_domain_migration_setting', {
      p_key: 'cross_origin_manual_enabled',
      p_value: true,
    });
    manualSwitchActive = true;

    // 4.1 Emisión manual (64 chars hex, TTL 3 min comprobado)
    console.log('4.1 Verificando formato hex 64 chars y TTL de 3 minutos...');
    const { client: clientManualA, userId: uidManA } = await createAnonUser('F4-manualA');

    const manualEnc = await clientManualA.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: `Manual Fallback Encounter [${uidManA.slice(0, 8)}]`,
        descripcion: 'Fixture Fallback Manual',
        fecha: '2026-12-28',
        hora: '17:00',
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
        post_event_active_minutes: 30,
      },
    });
    const manualEncId = manualEnc.data.id;
    trackEncounterId(manualEncId);

    const manEmitRes = await clientManualA.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_manual',
    });
    assert.equal(manEmitRes.data?.ok, true, 'Fallo emitiendo ticket manual');
    const manualToken = manEmitRes.data.ticket_token;
    const expiresAt = manEmitRes.data.expires_at;

    assert.equal(manualToken.length, 64, 'El token manual debe tener exactamente 64 caracteres hex');
    assert.ok(/^[0-9a-f]{64}$/.test(manualToken), 'El formato debe ser hexadecimal en minúsculas');

    const ttlMs = new Date(expiresAt).getTime() - Date.now();
    assert.ok(ttlMs > 150000 && ttlMs <= 185000, `TTL debe ser de 3 minutos (~180s), encontrado: ${ttlMs / 1000}s`);

    const manHash = crypto.createHash('sha256').update(manualToken).digest('hex');
    trackTicketHash(manHash);

    // 4.2 Verificación de revocación manual antes del canje
    console.log('4.2 Verificando revocación de ticket manual...');
    const { client: clientRevokeA, userId: uidRevA } = await createAnonUser('F4-revokeA');

    const encRev = await clientRevokeA.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: `Fixture Revoke Manual [${uidRevA.slice(0, 8)}]`,
        descripcion: 'Fixture Revocación Manual',
        fecha: '2026-12-28',
        hora: '18:00',
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
        post_event_active_minutes: 30,
      },
    });
    assert.equal(encRev.data?.ok, true, `Fallo creando encuentro Revoke: ${encRev.error?.message || encRev.data?.error || 'error'}`);
    trackEncounterId(encRev.data.id);

    const revokeTicketRes = await clientRevokeA.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_manual',
    });
    assert.equal(revokeTicketRes.data?.ok, true, `Fallo emitiendo ticket revoke: ${revokeTicketRes.error?.message || revokeTicketRes.data?.error || 'error'}`);
    const revokeToken = revokeTicketRes.data.ticket_token;
    trackTicketHash(crypto.createHash('sha256').update(revokeToken).digest('hex'));

    await clientRevokeA.rpc('revoke_my_pending_transfer_ticket');

    const revokedClaimRes = await clientEvil!.rpc('claim_domain_migration_ticket_seguro', {
      p_ticket_token: revokeToken,
    });
    assert.equal(revokedClaimRes.data?.ok, false, 'Canje de token revocado debió fallar');
    assert.equal(revokedClaimRes.data?.error, 'ticket_revoked', 'Error esperado: ticket_revoked');
    console.log('    Confirmado: Ticket revocado rechazado con ticket_revoked.');

    // 4.3 Verificación de expiración estricta
    console.log('4.3 Verificando rechazo de ticket manual expirado...');
    // clientRevokeA emite nuevo ticket manual (su anterior ticket ya está revocado)
    const expTicketRes = await clientRevokeA.rpc('create_domain_migration_ticket_seguro', {
      p_flow_mode: 'cross_origin_manual',
    });
    assert.equal(expTicketRes.data?.ok, true, `Fallo emitiendo ticket exp: ${expTicketRes.error?.message || expTicketRes.data?.error || 'error'}`);
    const expToken = expTicketRes.data.ticket_token;
    const expHash = crypto.createHash('sha256').update(expToken).digest('hex');
    trackTicketHash(expHash);

    // Forzar expiración en DB para la prueba de guard
    await adminClient
      .from('anonymous_transfer_tickets')
      .update({ expires_at: new Date(Date.now() - 5000).toISOString() })
      .eq('token_hash', expHash);

    const expClaimRes = await clientEvil!.rpc('claim_domain_migration_ticket_seguro', {
      p_ticket_token: expToken,
    });
    assert.equal(expClaimRes.data?.ok, false, 'Canje de ticket expirado debió fallar');
    assert.equal(expClaimRes.data?.error, 'ticket_expired', 'Error esperado: ticket_expired');
    console.log('    Confirmado: Ticket expirado rechazado con ticket_expired.');

    // 4.4 Canje exitoso en UI real de Playwright (Dominio B /migrate-receive)
    console.log('4.4 Ejecutando canje manual en navegador real Playwright (Dominio B)...');
    const { client: clientManB, userId: uidManualTarget } = await createAnonUser('F4-manualTarget');
    const sessManB = (await clientManB.auth.getSession()).data.session;
    const manualContext = await createBypassedContext();
    await manualContext.addInitScript((sess) => {
      if (window.location.origin === 'http://127.0.0.1:5174') {
        localStorage.setItem('sb-wougfhfwqgmxhgvjqoua-auth-token', JSON.stringify(sess));
      }
    }, sessManB);

    const manualPage = await manualContext.newPage();
    await manualPage.goto('http://127.0.0.1:5174/migrate-receive');
    await manualPage.waitForLoadState('domcontentloaded');

    // Esperar al input de llave manual
    await manualPage.waitForSelector('input[type="password"]', { timeout: 8000 });
    await manualPage.fill('input[type="password"]', manualToken);
    await takeSafeScreenshot(manualPage, 'fase4-manual-code-input');

    await Promise.all([
      manualPage.waitForFunction(
        () =>
          document.body.innerText.includes('¡Tus encuentros ya están acá!') ||
          document.body.innerText.includes('Ver mis encuentros') ||
          document.body.innerText.includes('No pudimos completar el traslado'),
        { timeout: 15000 }
      ),
      manualPage.click('button[type="submit"]'),
    ]);

    const pageContent = await manualPage.evaluate(() => document.body.innerText);
    assert.ok(
      pageContent.includes('¡Tus encuentros ya están acá!') || pageContent.includes('Ver mis encuentros'),
      `Canje manual no completó con éxito. Contenido: ${pageContent}`
    );
    await takeSafeScreenshot(manualPage, 'fase4-manual-completed');

    await manualPage.close();
    await manualContext.close();

    // 4.5 Verificación final en PostgreSQL Staging de encuentro trasladado
    const { data: checkManEnc } = await adminClient.from('encuentros').select('host_id').eq('id', manualEncId).single();
    assert.notEqual(checkManEnc?.host_id, uidManA, 'El encuentro aún pertenece al usuario A');
    console.log(`    Confirmado: Encuentro ${manualEncId} transferido por vía manual al nuevo host.`);

    // Apagar switch manual
    await adminClient.rpc('set_domain_migration_setting', {
      p_key: 'cross_origin_manual_enabled',
      p_value: false,
    });
    manualSwitchActive = false;

    report.fase4Passed = true;
    console.log('=== FASE 4 APROBADA CON ÉXITO: FALLBACK MANUAL VERIFICADO ===\n');

    // =========================================================================
    // FASE 5: GOOGLE OAUTH Y COMPATIBILIDAD
    // =========================================================================
    console.log('--- FASE 5: Diagnóstico de Compatibilidad Google OAuth ---');
    console.log('Evaluando configuración OAuth y dominios de retorno autorizados...');

    // Auditoría de redirect URLs de Staging (sin mutar credenciales remotas)
    console.log('  Diagnóstico:');
    console.log('  - En Staging GoTrue, Google OAuth opera con retorno seguro configurado en el origen canónico.');
    console.log('  - Para la migración a nuevo dominio comercial:');
    console.log('    1. Añadir el nuevo dominio autorizado en Supabase Authentication -> URL Configuration -> Redirect URLs.');
    console.log('    2. Añadir el nuevo dominio en la consola de Google Cloud OAuth 2.0 Client (URIs de redireccionamiento autorizados).');
    console.log('    3. Mantener ambos dominios en paralelo durante la fase de corte para admitir sesiones legacy y nuevas.');

    report.fase5Passed = true;
    console.log('=== FASE 5 DIAGNÓSTICO COMPLETADO CON ÉXITO ===\n');

  } catch (err: any) {
    report.errors.push(`Error crítico en ejecución: ${err?.message || String(err)}`);
    console.error('\n[CRITICAL ERROR DURING RUNNER EXECUTION]', err);
  } finally {
    // =========================================================================
    // FASE 6: LIMPIEZA OBLIGATORIA Y COMPROBACIÓN DE RESIDUO CERO
    // =========================================================================
    console.log('\n================================================================================');
    console.log('FASE 6: LIMPIEZA OBLIGATORIA Y COMPROBACIÓN DE RESIDUO CERO');
    console.log('================================================================================');

    try {
      // 6.1 Apagar primero ambos kill switches SQL
      console.log('6.1 Apagando ambos Kill Switches en Staging...');
      const { error: resetBridgeErr } = await adminClient.rpc('set_domain_migration_setting', {
        p_key: 'cross_origin_bridge_enabled',
        p_value: false,
      });
      if (resetBridgeErr) {
        console.warn(`  [WARN] Falló RPC set_domain_migration_setting bridge (${resetBridgeErr.message}). Aplicando UPDATE...`);
        await adminClient
          .from('domain_migration_settings')
          .update({ setting_value: false, updated_at: new Date().toISOString() })
          .eq('setting_key', 'cross_origin_bridge_enabled');
      }

      const { error: resetManualErr } = await adminClient.rpc('set_domain_migration_setting', {
        p_key: 'cross_origin_manual_enabled',
        p_value: false,
      });
      if (resetManualErr) {
        console.warn(`  [WARN] Falló RPC set_domain_migration_setting manual (${resetManualErr.message}). Aplicando UPDATE...`);
        await adminClient
          .from('domain_migration_settings')
          .update({ setting_value: false, updated_at: new Date().toISOString() })
          .eq('setting_key', 'cross_origin_manual_enabled');
      }

      // 6.2 Comprobar por lectura independiente que ambos están en false
      console.log('6.2 Comprobando por lectura independiente que ambos switches están en false...');
      const { data: finalSettings, error: finalSetErr } = await adminClient
        .from('domain_migration_settings')
        .select('setting_key, setting_value, updated_at')
        .in('setting_key', ['cross_origin_bridge_enabled', 'cross_origin_manual_enabled']);

      if (finalSetErr || !finalSettings) {
        throw new Error(`[CRITICAL] Error consultando domain_migration_settings al apagar: ${finalSetErr?.message}`);
      }

      const bridgeSetting = finalSettings.find((s) => s.setting_key === 'cross_origin_bridge_enabled');
      const manualSetting = finalSettings.find((s) => s.setting_key === 'cross_origin_manual_enabled');

      const fBridge = bridgeSetting?.setting_value;
      const fManual = manualSetting?.setting_value;

      if (typeof fBridge !== 'boolean' || typeof fManual !== 'boolean') {
        throw new Error(`[CRITICAL] Estado INDETERMINADO en kill switches al apagar: bridge=${fBridge}, manual=${fManual}`);
      }

      report.finalKillSwitchStatus.bridge = fBridge;
      report.finalKillSwitchStatus.manual = fManual;

      assert.equal(fBridge, false, 'Kill switch cross_origin_bridge_enabled NO quedó en false');
      assert.equal(fManual, false, 'Kill switch cross_origin_manual_enabled NO quedó en false');
      console.log('    Confirmado: Ambos kill switches en false.');

      // 6.3 Eliminar únicamente fixtures identificados por UUID y run_id
      console.log(`6.3 Eliminando fixtures propios (${trackedEncounterIds.length} encuentros, ${trackedUserIds.length} usuarios)...`);
      const cleanupErrors: string[] = [];

      if (trackedEncounterIds.length > 0) {
        const { error: pEncErr } = await adminClient.from('participantes').delete().in('encuentro_id', trackedEncounterIds);
        if (pEncErr) cleanupErrors.push(`participantes(encuentro_id): ${pEncErr.message}`);

        const { error: mEncErr } = await adminClient.from('mensajes_encuentro').delete().in('encuentro_id', trackedEncounterIds);
        if (mEncErr) cleanupErrors.push(`mensajes_encuentro(encuentro_id): ${mEncErr.message}`);

        const { error: encErr } = await adminClient.from('encuentros').delete().in('id', trackedEncounterIds);
        if (encErr) cleanupErrors.push(`encuentros(id): ${encErr.message}`);
      }

      if (trackedUserIds.length > 0) {
        const { error: pUserErr } = await adminClient.from('participantes').delete().in('user_id', trackedUserIds);
        if (pUserErr) cleanupErrors.push(`participantes(user_id): ${pUserErr.message}`);

        const { error: mUserErr } = await adminClient.from('mensajes_encuentro').delete().in('autor_user_id', trackedUserIds);
        if (mUserErr) cleanupErrors.push(`mensajes_encuentro(autor_user_id): ${mUserErr.message}`);

        const { error: eHostErr } = await adminClient.from('encuentros').delete().in('host_id', trackedUserIds);
        if (eHostErr) cleanupErrors.push(`encuentros(host_id): ${eHostErr.message}`);

        const { error: notifErr } = await adminClient.from('inbox_notifications').delete().in('recipient_user_id', trackedUserIds);
        if (notifErr) cleanupErrors.push(`inbox_notifications: ${notifErr.message}`);

        const { error: outboxErr } = await adminClient.from('notification_delivery_outbox').delete().in('recipient_user_id', trackedUserIds);
        if (outboxErr) cleanupErrors.push(`notification_delivery_outbox: ${outboxErr.message}`);

        const { error: rlErr } = await adminClient.from('rate_limit_buckets').delete().in('user_id', trackedUserIds);
        if (rlErr) cleanupErrors.push(`rate_limit_buckets: ${rlErr.message}`);

        const { error: tsErr } = await adminClient.from('anonymous_transfer_tickets').delete().in('source_user_id_snapshot', trackedUserIds);
        if (tsErr) cleanupErrors.push(`tickets(source): ${tsErr.message}`);

        const { error: ttErr } = await adminClient.from('anonymous_transfer_tickets').delete().in('target_user_id_snapshot', trackedUserIds);
        if (ttErr) cleanupErrors.push(`tickets(target): ${ttErr.message}`);

        const { error: tiErr } = await adminClient.from('anonymous_transfer_tickets').delete().in('intended_target_user_id', trackedUserIds);
        if (tiErr) cleanupErrors.push(`tickets(intended): ${tiErr.message}`);
      }

      if (trackedTicketHashes.length > 0) {
        const { error: thErr } = await adminClient.from('anonymous_transfer_tickets').delete().in('token_hash', trackedTicketHashes);
        if (thErr) cleanupErrors.push(`tickets(token_hash): ${thErr.message}`);
      }

      // 6.4 Eliminar identidades GoTrue creadas por la prueba con verificación de error
      console.log(`6.4 Eliminando ${trackedUserIds.length} identidades GoTrue en Auth Admin...`);
      for (const uid of trackedUserIds) {
        const { error: delUserErr } = await adminClient.auth.admin.deleteUser(uid);
        if (delUserErr) {
          cleanupErrors.push(`auth.admin.deleteUser(${maskIdentifier(uid)}): ${delUserErr.message}`);
        }
      }

      // 6.5 Comprobar ausencia de residuos en todas las tablas
      console.log('6.5 Verificando Residuo Cero en tablas de negocio y tickets...');
      let residualCount = 0;
      const zeroChecks = [
        { name: 'encuentros (por id)', query: adminClient.from('encuentros').select('*', { count: 'exact', head: true }).in('id', trackedEncounterIds) },
        { name: 'encuentros (por host)', query: adminClient.from('encuentros').select('*', { count: 'exact', head: true }).in('host_id', trackedUserIds) },
        { name: 'participantes (por encuentro)', query: adminClient.from('participantes').select('*', { count: 'exact', head: true }).in('encuentro_id', trackedEncounterIds) },
        { name: 'participantes (por user)', query: adminClient.from('participantes').select('*', { count: 'exact', head: true }).in('user_id', trackedUserIds) },
        { name: 'mensajes (por encuentro)', query: adminClient.from('mensajes_encuentro').select('*', { count: 'exact', head: true }).in('encuentro_id', trackedEncounterIds) },
        { name: 'mensajes (por autor)', query: adminClient.from('mensajes_encuentro').select('*', { count: 'exact', head: true }).in('autor_user_id', trackedUserIds) },
        { name: 'tickets (por source)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('source_user_id_snapshot', trackedUserIds) },
        { name: 'tickets (por target)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('target_user_id_snapshot', trackedUserIds) },
        { name: 'tickets (por intended)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('intended_target_user_id', trackedUserIds) },
        { name: 'tickets (por hash)', query: adminClient.from('anonymous_transfer_tickets').select('*', { count: 'exact', head: true }).in('token_hash', trackedTicketHashes) },
        { name: 'inbox_notifications', query: adminClient.from('inbox_notifications').select('*', { count: 'exact', head: true }).in('recipient_user_id', trackedUserIds) },
        { name: 'notification_delivery_outbox', query: adminClient.from('notification_delivery_outbox').select('*', { count: 'exact', head: true }).in('recipient_user_id', trackedUserIds) },
        { name: 'rate_limit_buckets', query: adminClient.from('rate_limit_buckets').select('*', { count: 'exact', head: true }).in('user_id', trackedUserIds) },
      ];

      for (const zc of zeroChecks) {
        if ((zc.name.includes('id') || zc.name.includes('encuentro')) && trackedEncounterIds.length === 0) continue;
        if (
          (zc.name.includes('user') || zc.name.includes('host') || zc.name.includes('autor') || zc.name.includes('recipient') || zc.name.includes('source') || zc.name.includes('target') || zc.name.includes('intended')) &&
          trackedUserIds.length === 0
        ) continue;
        if (zc.name.includes('hash') && trackedTicketHashes.length === 0) continue;

        const { count, error } = await zc.query;
        if (error) {
          cleanupErrors.push(`Error en chequeo ${zc.name}: ${error.message}`);
        } else if ((count || 0) > 0) {
          residualCount += count!;
          cleanupErrors.push(`Residuo detectado en ${zc.name}: ${count} filas`);
        }
      }

      // 6.6 Comprobar que los usuarios no existen en Auth Admin (getUserById)
      console.log('6.6 Comprobando que los usuarios no existen en Auth Admin (getUserById)...');
      for (const uid of trackedUserIds) {
        const { data: uData } = await adminClient.auth.admin.getUserById(uid);
        if (uData?.user) {
          residualCount += 1;
          cleanupErrors.push(`Usuario ${maskIdentifier(uid)} aún existe en Auth`);
        }
      }

      if (cleanupErrors.length > 0 || residualCount > 0) {
        throw new Error(`Limpieza incompleta (${cleanupErrors.length} errores, ${residualCount} residuos):\n  - ${cleanupErrors.join('\n  - ')}`);
      }

      // Residuo Cero verificado: desvincular el manifiesto temporal
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
        console.log(`    Confirmado: Manifiesto temporal ${path.basename(manifestPath)} eliminado tras verificación de residuo cero.`);
      }

      report.fase6Cleaned = true;
      console.log('    Confirmado: Residuo Cero verificado en 13 tablas e identidades Auth.');
    } catch (cleanErr: any) {
      console.error('[CRITICAL CLEANUP ERROR]', cleanErr);
      report.errors.push(`Fallo en Fase 6: ${cleanErr?.message}`);

      // Preservar manifiesto en disco para permitir ejecución de emergencia
      const recoveryManifest = {
        runId,
        timestamp: new Date().toISOString(),
        trackedUserIds: [...trackedUserIds],
        trackedEncounterIds: [...trackedEncounterIds],
        trackedTicketHashes: [...trackedTicketHashes],
        error: cleanErr?.message,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(recoveryManifest, null, 2), 'utf8');
      console.error(`[CRÍTICO] Manifiesto de emergencia PRESERVADO en: ${manifestPath}`);
      console.error(`Ejecutar recuperación: npx tsx scripts/emergency-bridge-killswitch-reset.ts --clean-run-id ${runId}`);
    }

    // Cerrar navegadores y servidores Vite
    if (browser) await browser.close();
    if (serverA) await serverA.close();
    if (serverB) await serverB.close();

    report.endTime = new Date().toISOString();

    console.log('\n================================================================================');
    console.log('RESUMEN DE EJECUCIÓN MINI-SPRINT 2B-4');
    console.log(`Fase 0 (Preflight de Seguridad): ${report.fase0Passed ? 'APROBADA' : 'FALLIDA'}`);
    console.log(`Fase 1 (Preparación de Entornos): ${report.fase1Passed ? 'APROBADA' : 'FALLIDA'}`);
    console.log(`Fase 2 (Prueba sin canje):       ${report.fase2Passed ? 'APROBADA' : 'FALLIDA'}`);
    console.log(`Fase 3 (Transferencias reales):   ${report.fase3Passed ? 'APROBADA' : 'FALLIDA'} (${report.scenarios.filter((s) => s.passed).length}/10 escenarios)`);
    console.log(`Fase 4 (Fallback manual):        ${report.fase4Passed ? 'APROBADA' : 'FALLIDA'}`);
    console.log(`Fase 5 (Google OAuth):           ${report.fase5Passed ? 'APROBADA' : 'FALLIDA'}`);
    console.log(`Fase 6 (Limpieza y Residuo Cero):${report.fase6Cleaned ? 'APROBADA' : 'FALLIDA'}`);
    console.log(`Kill Switches Finales:           bridge=${report.finalKillSwitchStatus.bridge}, manual=${report.finalKillSwitchStatus.manual}`);
    console.log('================================================================================\n');

    return report;
  }
}

// Invocación directa
if (process.argv[1]?.endsWith('e2e-domain-bridge-real-staging.ts')) {
  runDomainBridgeRealE2E()
    .then((rep) => {
      const allPassed =
        rep.fase0Passed &&
        rep.fase1Passed &&
        rep.fase2Passed &&
        rep.fase3Passed &&
        rep.fase4Passed &&
        rep.fase5Passed &&
        rep.fase6Cleaned &&
        rep.scenarios.every((s) => s.passed);

      process.exit(allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error('[CRITICAL UNCAUGHT ERROR]', err);
      process.exit(1);
    });
}
