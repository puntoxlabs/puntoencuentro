/**
 * Suite Automatizada: Preparación de Migración de Dominio Reutilizable
 *
 * Valida exhaustivamente (casos positivos y pruebas negativas/adversariales de seguridad):
 * 1. Generación centralizada de URL canónica y normalización de barras.
 * 2. Variables de entorno ausentes o inválidas (fail-closed en builds publicados y runtime).
 * 3. Aislamiento estricto entre Staging, Producción, Preview y Desarrollo.
 * 4. Compatibilidad 1:1 de todas las rutas históricas y tokens (/join, /invite, /coordination/*, /invitation, /e, /?open_encounter, /meet, /share).
 * 5. Rechazo de hosts no autorizados y mitigación de Host Header Injection / Open Redirect / OG Poisoning en api/open-encounter.ts.
 * 6. Estrategia de redirección N->1 sin cadenas (Dominio A -> C y Dominio B -> C), inactiva por defecto, con exenciones PKCE/OAuth/SW/Bridge.
 * 7. Separación de marca y metadatos Open Graph sin fuga de datos privados.
 * 8. Generadores de enlaces privados y abiertos (shareHelper) inmunes a alias antiguos en window.location.origin.
 * 9. Redacción de tokens sensibles en logs/diagnósticos y normalización de rutas en feedback.
 * 10. Seguridad de OAuth Google y usePostAuthRedirect sin regresiones.
 * 11. Integridad de claves de localStorage/sessionStorage, UID persistente RFC 5545 (.ics) y ausencia de cambios destructivos.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build as viteBuild, type Plugin as VitePlugin } from 'vite';
import {
  DEFAULT_PRODUCTION_ORIGIN,
  DEFAULT_STAGING_ORIGIN,
  DomainConfigError,
  PERSISTENT_CALENDAR_UID_NAMESPACE,
  buildPublicAppUrl,
  extractTrustedVercelPreviewOrigins,
  isValidRouteInvitationToken,
  isValidRouteUuid,
  normalizeAppOrigin,
  parseLegacyOrigins,
  redactSensitiveUrlForLogs,
  resolveAppEnvironment,
  resolveBrandConfig,
  resolveDomainConfig,
  resolveLegacyDomainRedirect,
  resolveServerCanonicalOrigin,
  validateBuildDomainConfig,
  validateOriginForEnvironment,
} from '../src/config/domainConfig.js';
import {
  buildGeneralInvitationUrl,
  buildHostEncounterUrl,
  buildIndividualInvitationUrl,
  buildOpenEncounterQueryUrl,
  buildOpenEncounterShareText,
  buildOpenEncounterUrl,
  getBaseAppUrl,
} from '../src/lib/shareHelper.js';
import {
  isOwnershipDependentRoute,
  isValidPostAuthRedirect,
} from '../src/hooks/usePostAuthRedirect.js';
import { normalizeRouteForFeedback } from '../src/services/feedbackService.js';
import { generateIcsContent } from '../src/lib/calendarExport.js';
import openEncounterHandler, { generateOpenGraphHtml } from '../api/open-encounter.js';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
const SAMPLE_PUBLIC_TOKEN = 'tok_pub_987654321_AbCdEf';
const SAMPLE_PRIVATE_TOKEN = 'd9b2d63d-a233-4123-847a-763889a00111';

interface BrowserBundleBuildArtifact {
  indexHtml: string;
  bundleCode: string;
}

interface BrowserRuntimeEvaluation {
  hasNodeProcess: boolean;
  canonicalOrigin: string;
  environment: string;
  legacyOrigins: string[];
  brandName: string;
  generalInviteUrl: string;
  individualInviteUrl: string;
  openEncounterUrl: string;
  openEncounterQueryUrl: string;
}

const VIRTUAL_BROWSER_PROBE_ID = '\0pe-browser-domain-probe-entry';

/**
 * Compila un bundle real de cliente e `index.html` invocando el `vite.config.ts` productivo
 * en memoria (`write: false`), con reemplazo real de `import.meta.env.*` y `define` de Vite.
 * Aísla las variables del proceso durante el build y las restaura íntegramente al finalizar.
 */
async function buildRealClientArtifactForEnv(
  buildEnv: Record<string, string | undefined>
): Promise<BrowserBundleBuildArtifact> {
  const trackedKeys = new Set<string>([
    'NODE_ENV',
    'VITE_IGNORE_LOCAL_ENV_FILES',
    'VITE_APP_ENV',
    'VITE_APP_URL',
    'VITE_APP_BRAND_NAME',
    'VITE_APP_SHORT_NAME',
    'VITE_PUBLIC_SUPPORT_EMAIL',
    'VITE_APP_TWITTER_SITE',
    'VITE_REQUIRE_EXPLICIT_APP_URL',
    'PUBLIC_APP_ORIGIN',
    'PUBLIC_STAGING_ORIGIN',
    'LEGACY_APP_ORIGINS',
    'ENABLE_LEGACY_DOMAIN_REDIRECT',
    'APP_BRAND_NAME',
    'APP_SHORT_NAME',
    'PUBLIC_SUPPORT_EMAIL',
    'APP_TWITTER_SITE',
    'VERCEL_ENV',
    'VERCEL_GIT_COMMIT_REF',
    'VERCEL_URL',
    'VERCEL_BRANCH_URL',
    'VERCEL_PROJECT_PRODUCTION_URL',
    ...Object.keys(buildEnv),
  ]);

  const savedEnv = new Map<string, string | undefined>();
  for (const key of trackedKeys) {
    savedEnv.set(key, process.env[key]);
  }

  const emptyEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-vite-env-'));

  const probePlugin: VitePlugin = {
    name: 'pe-test-browser-probe-entry',
    enforce: 'pre',
    resolveId(source) {
      if (source === '/src/main.tsx' || source.endsWith('/src/main.tsx')) {
        return VIRTUAL_BROWSER_PROBE_ID;
      }
      return null;
    },
    load(id) {
      if (id !== VIRTUAL_BROWSER_PROBE_ID) return null;
      const domainCfgPath = path.resolve('src/config/domainConfig.ts').replace(/\\/g, '/');
      const shareHelperPath = path.resolve('src/lib/shareHelper.ts').replace(/\\/g, '/');
      return `
        import { getCanonicalAppOrigin, resolveDomainConfig, getBrandConfig } from '${domainCfgPath}';
        import {
          buildGeneralInvitationUrl,
          buildIndividualInvitationUrl,
          buildOpenEncounterUrl,
          buildOpenEncounterQueryUrl,
        } from '${shareHelperPath}';

        globalThis.__RUN_PE_BROWSER_PROBE__ = (pubToken, privToken, encId) => {
          const cfg = resolveDomainConfig({
            runtimeBrowserOrigin: globalThis.window?.location?.origin,
          });
          return {
            hasNodeProcess: typeof globalThis.process !== 'undefined',
            canonicalOrigin: getCanonicalAppOrigin(),
            environment: cfg.environment,
            legacyOrigins: [...cfg.legacyOrigins],
            brandName: getBrandConfig().brandName,
            generalInviteUrl: buildGeneralInvitationUrl(pubToken, 'fixed'),
            individualInviteUrl: buildIndividualInvitationUrl(privToken, 'fixed'),
            openEncounterUrl: buildOpenEncounterUrl(encId),
            openEncounterQueryUrl: buildOpenEncounterQueryUrl(encId),
          };
        };
      `;
    },
  };

  try {
    for (const key of trackedKeys) {
      delete process.env[key];
    }
    process.env.NODE_ENV = 'production';
    process.env.VITE_IGNORE_LOCAL_ENV_FILES = 'true';
    for (const [key, val] of Object.entries(buildEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      }
    }

    const buildResult = await viteBuild({
      configFile: path.resolve('vite.config.ts'),
      envDir: emptyEnvDir,
      logLevel: 'silent',
      plugins: [probePlugin],
      build: {
        write: false,
        modulePreload: false,
      },
    });

    const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
    let indexHtml = '';
    let bundleCode = '';

    for (const out of outputs) {
      if ('output' in out) {
        for (const item of out.output) {
          if (item.type === 'asset' && item.fileName === 'index.html') {
            indexHtml = typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8');
          } else if (item.type === 'chunk' && item.isEntry) {
            bundleCode = item.code;
          }
        }
      }
    }

    assert.ok(indexHtml.length > 0, 'Vite build debe emitir index.html transformado en memoria');
    assert.ok(bundleCode.length > 0, 'Vite build debe emitir el bundle JS de cliente en memoria');

    return { indexHtml, bundleCode };
  } finally {
    for (const [key, val] of savedEnv.entries()) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    fs.rmSync(emptyEnvDir, { recursive: true, force: true });
  }
}

/**
 * Ejecuta el bundle compilado por Vite dentro de un contexto aislado `node:vm` que reproduce
 * fielmente el navegador: `process` no existe (`undefined`) y solo están disponibles APIs Web
 * estándar (`window.location`, `URL`, `URLSearchParams`).
 */
function evaluateClientBundleInBrowserVm(
  bundleCode: string,
  browserLocationOrigin: string
): BrowserRuntimeEvaluation {
  const parsedLoc = new URL(browserLocationOrigin);
  const sandbox: Record<string, unknown> = {
    window: {
      location: {
        origin: parsedLoc.origin,
        href: parsedLoc.href,
        protocol: parsedLoc.protocol,
        host: parsedLoc.host,
        hostname: parsedLoc.hostname,
        pathname: parsedLoc.pathname,
        search: '',
        hash: '',
      },
    },
    URL,
    URLSearchParams,
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox.window;

  const context = vm.createContext(sandbox);
  vm.runInContext(bundleCode, context, { filename: 'vite-client-bundle.js' });

  const runner = sandbox.__RUN_PE_BROWSER_PROBE__ as (
    pubToken: string,
    privToken: string,
    encId: string
  ) => BrowserRuntimeEvaluation;
  assert.equal(typeof runner, 'function', 'El bundle compilado debe exponer la sonda de ejecución cliente');

  const result = JSON.parse(
    JSON.stringify(runner(SAMPLE_PUBLIC_TOKEN, SAMPLE_PRIVATE_TOKEN, SAMPLE_UUID))
  ) as BrowserRuntimeEvaluation;
  assert.equal(
    result.hasNodeProcess,
    false,
    'La prueba de navegador debe ejecutarse sin `process` de Node (typeof process === "undefined")'
  );
  return result;
}

async function runDomainMigrationReadinessTests(): Promise<void> {
  console.log('\n=== TEST SUITE: DOMAIN MIGRATION READINESS & SECURITY ===');

  // -------------------------------------------------------------------------
  // 1. Generación de URL canónica y normalización
  // -------------------------------------------------------------------------
  {
    assert.equal(
      normalizeAppOrigin('https://puntoencuentro.com.ar/'),
      'https://puntoencuentro.com.ar',
      'Debe remover barra final'
    );
    assert.equal(
      normalizeAppOrigin('  HTTPS://PuntoEncuentro.com.ar  '),
      'https://puntoencuentro.com.ar',
      'Debe normalizar mayúsculas de esquema/host y espacios'
    );
    assert.equal(
      normalizeAppOrigin('http://localhost:5173/', { requireHttps: false }),
      'http://localhost:5173',
      'Debe admitir http únicamente en localhost cuando requireHttps=false'
    );

    const prodDefault = resolveDomainConfig({ env: { VITE_APP_ENV: 'production' } });
    assert.equal(prodDefault.canonicalOrigin, DEFAULT_PRODUCTION_ORIGIN);
    assert.equal(prodDefault.legacyOrigins.length, 0);
    assert.equal(prodDefault.legacyRedirectEnabled, false);

    const stgDefault = resolveDomainConfig({ env: { VITE_APP_ENV: 'staging' } });
    assert.equal(stgDefault.canonicalOrigin, DEFAULT_STAGING_ORIGIN);

    // Simulación aislada de futuro Dominio B mediante configuración pura (sin tocar constantes productivas)
    const futureDomainB = resolveDomainConfig({
      env: {
        VITE_APP_ENV: 'production',
        VITE_APP_URL: 'https://encuentros-ejemplo.app/',
        LEGACY_APP_ORIGINS: 'https://puntoencuentro.com.ar',
        VITE_APP_BRAND_NAME: 'MarcaFuturaTest',
      },
      strict: true,
    });
    assert.equal(futureDomainB.canonicalOrigin, 'https://encuentros-ejemplo.app');
    assert.deepEqual(futureDomainB.legacyOrigins, ['https://puntoencuentro.com.ar']);
    assert.equal(futureDomainB.brand.brandName, 'MarcaFuturaTest');
    console.log('✔ 1. Generación y normalización de URL canónica verificada (actual y futura).');
  }

  // -------------------------------------------------------------------------
  // 2. Variables de entorno ausentes o inválidas (Fail-Closed)
  // -------------------------------------------------------------------------
  {
    // Compuerta explícita de corte: falla cerrado si falta VITE_APP_URL en producción o staging
    assert.throws(
      () =>
        validateBuildDomainConfig(
          { VITE_APP_ENV: 'production', VITE_APP_URL: '' },
          { requireExplicitOrigin: true }
        ),
      (err: unknown) => err instanceof DomainConfigError && err.code === 'missing_canonical_origin'
    );

    assert.throws(
      () =>
        validateBuildDomainConfig({
          VITE_APP_ENV: 'staging',
          VITE_REQUIRE_EXPLICIT_APP_URL: 'true',
        }),
      (err: unknown) => err instanceof DomainConfigError && err.code === 'missing_canonical_origin'
    );

    // Esquemas inseguros, credenciales embebidas, rutas y queries en origen
    const invalidOrigins: Array<{ raw: string; expectedCode: string }> = [
      { raw: 'http://puntoencuentro.com.ar', expectedCode: 'insecure_origin_scheme' },
      { raw: 'javascript:alert(1)', expectedCode: 'insecure_origin_scheme' },
      { raw: 'data:text/html,<script>alert(1)</script>', expectedCode: 'insecure_origin_scheme' },
      { raw: 'ftp://puntoencuentro.com.ar', expectedCode: 'insecure_origin_scheme' },
      { raw: 'https://admin:secret@puntoencuentro.com.ar', expectedCode: 'origin_contains_credentials' },
      { raw: 'https://puntoencuentro.com.ar/subpath', expectedCode: 'origin_contains_path_or_query' },
      { raw: 'https://puntoencuentro.com.ar?foo=bar', expectedCode: 'origin_contains_path_or_query' },
      { raw: 'https://puntoencuentro.com.ar#frag', expectedCode: 'origin_contains_path_or_query' },
      { raw: 'not a valid url', expectedCode: 'invalid_origin_url' },
      { raw: 'https://192.168.1.10', expectedCode: 'unauthorized_canonical_host' },
    ];

    for (const item of invalidOrigins) {
      assert.throws(
        () =>
          validateBuildDomainConfig({
            VITE_APP_ENV: 'production',
            VITE_APP_URL: item.raw,
          }),
        (err: unknown) =>
          err instanceof DomainConfigError && err.code === item.expectedCode,
        `Origen inválido debía fallar con ${item.expectedCode}: ${item.raw}`
      );
    }

    // En runtime no estricto, si llega una URL corrupta o insegura, falla cerrado al canónico seguro del entorno
    const safeRuntimeFallback = resolveDomainConfig({
      env: { VITE_APP_ENV: 'production', VITE_APP_URL: 'http://evil-insecure.example.com' },
      strict: false,
    });
    assert.equal(safeRuntimeFallback.canonicalOrigin, DEFAULT_PRODUCTION_ORIGIN);
    console.log('✔ 2. Variables ausentes o inválidas rechazadas de forma segura (fail-closed).');
  }

  // -------------------------------------------------------------------------
  // 3. Aislamiento estricto Staging / Producción / Preview / Local
  // -------------------------------------------------------------------------
  {
    assert.equal(resolveAppEnvironment({ VERCEL_GIT_COMMIT_REF: 'staging' }), 'staging');
    assert.equal(resolveAppEnvironment({ VERCEL_GIT_COMMIT_REF: 'main' }), 'production');
    assert.equal(resolveAppEnvironment({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feat/x' }), 'preview');
    assert.equal(resolveAppEnvironment({}), 'development');

    // Producción NO acepta URL de Staging, localhost ni *.vercel.app
    assert.throws(
      () => validateOriginForEnvironment('https://staging.puntoencuentro.com.ar', 'production'),
      (err: unknown) => err instanceof DomainConfigError && err.code === 'cross_environment_origin_mismatch'
    );
    assert.throws(
      () => validateOriginForEnvironment('https://staging.nueva-marca.app', 'production'),
      (err: unknown) => err instanceof DomainConfigError && err.code === 'cross_environment_origin_mismatch'
    );
    assert.throws(
      () => validateOriginForEnvironment('https://puntoencuentro-git-main.vercel.app', 'production'),
      (err: unknown) => err instanceof DomainConfigError && err.code === 'cross_environment_origin_mismatch'
    );
    assert.throws(
      () =>
        validateBuildDomainConfig({
          VITE_APP_ENV: 'production',
          VITE_APP_URL: 'http://localhost:5173',
        }),
      (err: unknown) => err instanceof DomainConfigError
    );

    // Staging NO acepta el dominio de Producción ni localhost
    assert.throws(
      () => validateOriginForEnvironment('https://puntoencuentro.com.ar', 'staging'),
      (err: unknown) => err instanceof DomainConfigError && err.code === 'cross_environment_origin_mismatch'
    );
    assert.throws(
      () =>
        validateBuildDomainConfig({
          VITE_APP_ENV: 'staging',
          VITE_APP_URL: 'https://puntoencuentro.com.ar',
        }),
      (err: unknown) => err instanceof DomainConfigError && err.code === 'cross_environment_origin_mismatch'
    );

    console.log('✔ 3. Separación estricta Staging / Producción / Preview / Local comprobada.');
  }

  // -------------------------------------------------------------------------
  // 4. Compatibilidad de rutas, tokens y generación centralizada de enlaces
  // -------------------------------------------------------------------------
  {
    const simEnv = {
      VITE_APP_ENV: 'production',
      VITE_APP_URL: 'https://dominio-canonico-test.app/',
    };

    assert.equal(getBaseAppUrl(simEnv), 'https://dominio-canonico-test.app');
    assert.equal(
      buildGeneralInvitationUrl(SAMPLE_PUBLIC_TOKEN, 'fixed', simEnv),
      `https://dominio-canonico-test.app/join/${SAMPLE_PUBLIC_TOKEN}`
    );
    assert.equal(
      buildGeneralInvitationUrl(SAMPLE_PUBLIC_TOKEN, 'coordination', simEnv),
      `https://dominio-canonico-test.app/coordination/join/${SAMPLE_PUBLIC_TOKEN}`
    );
    assert.equal(
      buildIndividualInvitationUrl(SAMPLE_PRIVATE_TOKEN, 'fixed', simEnv),
      `https://dominio-canonico-test.app/invite/${SAMPLE_PRIVATE_TOKEN}`
    );
    assert.equal(
      buildIndividualInvitationUrl(SAMPLE_PRIVATE_TOKEN, 'coordination', simEnv),
      `https://dominio-canonico-test.app/coordination/invite/${SAMPLE_PRIVATE_TOKEN}`
    );
    assert.equal(
      buildHostEncounterUrl(SAMPLE_UUID, simEnv),
      `https://dominio-canonico-test.app/meet/${SAMPLE_UUID}`
    );
    assert.equal(
      buildOpenEncounterUrl(SAMPLE_UUID, simEnv),
      `https://dominio-canonico-test.app/e/${SAMPLE_UUID}`
    );
    assert.equal(
      buildOpenEncounterQueryUrl(SAMPLE_UUID, simEnv),
      `https://dominio-canonico-test.app/?open_encounter=${SAMPLE_UUID}`
    );
    assert.equal(
      buildPublicAppUrl(`/invitation/${SAMPLE_UUID}`, { env: simEnv }),
      `https://dominio-canonico-test.app/invitation/${SAMPLE_UUID}`
    );
    assert.equal(
      buildPublicAppUrl(`/share/${SAMPLE_UUID}?share=1#top`, { env: simEnv }),
      `https://dominio-canonico-test.app/share/${SAMPLE_UUID}?share=1#top`
    );

    // Aunque el navegador esté abriendo el sitio desde un alias antiguo, el enlace generado usa el canónico
    const cfgFromOldBrowserAlias = resolveDomainConfig({
      env: simEnv,
      runtimeBrowserOrigin: 'https://puntoencuentro.com.ar',
    });
    assert.equal(cfgFromOldBrowserAlias.canonicalOrigin, 'https://dominio-canonico-test.app');

    // Validadores de ruta independientes del dominio
    assert.equal(isValidRouteInvitationToken(SAMPLE_PUBLIC_TOKEN), true);
    assert.equal(isValidRouteInvitationToken(SAMPLE_PRIVATE_TOKEN), true);
    assert.equal(isValidRouteUuid(SAMPLE_UUID), true);
    assert.equal(isValidRouteInvitationToken('https://puntoencuentro.com.ar/join/abc'), false);

    // Rechazo de rutas maliciosas en buildPublicAppUrl
    assert.throws(() => buildPublicAppUrl('//evil.com/phish', { env: simEnv }));
    assert.throws(() => buildPublicAppUrl('https://evil.com/phish', { env: simEnv }));
    assert.throws(() => buildPublicAppUrl('/join/../admin', { env: simEnv }));
    assert.throws(() => buildPublicAppUrl('/\\evil.com', { env: simEnv }));

    console.log('✔ 4. Todas las familias de rutas y tokens mantienen compatibilidad 1:1 y origen canónico.');
  }

  // -------------------------------------------------------------------------
  // 5. Rechazo de hosts no autorizados y seguridad de api/open-encounter.ts
  // -------------------------------------------------------------------------
  {
    const hostileHeadersList: Array<Record<string, string>> = [
      { host: 'evil.com', 'x-forwarded-proto': 'https' },
      { host: 'puntoencuentro.com.ar', 'x-forwarded-host': 'phishing.attacker.org' },
      { host: 'puntoencuentro.com.ar.evil.com' },
      { host: 'staging.puntoencuentro.com.ar@evil.com' },
      { host: 'evil.com/inject', 'x-forwarded-proto': 'javascript' },
      { host: 'puntoencuentro.com.ar', 'x-forwarded-proto': 'http' },
    ];

    for (const headers of hostileHeadersList) {
      const res = resolveServerCanonicalOrigin({
        headers,
        env: { VITE_APP_ENV: 'production' },
      });
      assert.equal(
        res.canonicalOrigin,
        DEFAULT_PRODUCTION_ORIGIN,
        `Host malicioso no fue neutralizado: ${JSON.stringify(headers)}`
      );
      assert.ok(res.canonicalOrigin.startsWith('https://'), 'Siempre debe forzar HTTPS');
    }

    // Ejecución real del handler serverless ante navegador con Host malicioso -> jamás redirige a evil.com
    const savedAppEnv = process.env.VITE_APP_ENV;
    const savedAppUrl = process.env.VITE_APP_URL;
    const savedPubOrigin = process.env.PUBLIC_APP_ORIGIN;
    try {
      process.env.VITE_APP_ENV = 'production';
      delete process.env.VITE_APP_URL;
      delete process.env.PUBLIC_APP_ORIGIN;

      let status = 0;
      let locationHeader = '';
      await openEncounterHandler(
        {
          query: { id: SAMPLE_UUID },
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
            host: 'evil.attacker.com',
            'x-forwarded-host': 'evil.attacker.com',
            'x-forwarded-proto': 'http',
          },
        },
        {
          writeHead(code: number, hdrs: Record<string, string>) {
            status = code;
            locationHeader = hdrs.Location || '';
          },
          end() {},
        }
      );

      assert.equal(status, 302);
      assert.equal(
        locationHeader,
        `${DEFAULT_PRODUCTION_ORIGIN}/?open_encounter=${SAMPLE_UUID}`,
        'CRÍTICO: api/open-encounter no debe emitir Open Redirect hacia Host no confiable'
      );

      // Rastreador WhatsApp con Host malicioso -> og:url y window.location.replace apuntan al canónico legítimo
      let botHtml = '';
      await openEncounterHandler(
        {
          query: { id: 'invalid-uuid' },
          headers: {
            'user-agent': 'WhatsApp/2.24.1 i',
            host: 'evil.attacker.com',
            'x-forwarded-host': 'evil.attacker.com',
          },
        },
        {
          writeHead(code: number) {
            assert.equal(code, 200);
          },
          end(body: string) {
            botHtml = body;
          },
        }
      );

      assert.equal(botHtml.includes('evil.attacker.com'), false, 'CRÍTICO: OG HTML contaminado con host atacante');
      assert.ok(botHtml.includes(`<meta property="og:url" content="${DEFAULT_PRODUCTION_ORIGIN}" />`));
      assert.ok(botHtml.includes(`<link rel="canonical" href="${DEFAULT_PRODUCTION_ORIGIN}" />`));
    } finally {
      if (savedAppEnv === undefined) delete process.env.VITE_APP_ENV;
      else process.env.VITE_APP_ENV = savedAppEnv;
      if (savedAppUrl === undefined) delete process.env.VITE_APP_URL;
      else process.env.VITE_APP_URL = savedAppUrl;
      if (savedPubOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
      else process.env.PUBLIC_APP_ORIGIN = savedPubOrigin;
    }

    console.log('✔ 5. Hosts no autorizados rechazados en servidor y en api/open-encounter.ts (cero Open Redirect / cero OG poisoning).');
  }

  // -------------------------------------------------------------------------
  // 6. Estrategia de redirección N->1 sin cadenas (Dominio A / B -> Dominio C)
  // -------------------------------------------------------------------------
  {
    // 6.1 Por defecto desactivada (cumple restricción: no activar redirección global ahora)
    const inactiveCfg = resolveDomainConfig({
      env: {
        VITE_APP_ENV: 'production',
        PUBLIC_APP_ORIGIN: 'https://dominio-c.app',
        LEGACY_APP_ORIGINS: 'https://puntoencuentro.com.ar,https://dominio-b.app',
      },
    });
    assert.equal(inactiveCfg.legacyRedirectEnabled, false);
    const disabledDecision = resolveLegacyDomainRedirect(
      `https://puntoencuentro.com.ar/join/${SAMPLE_PUBLIC_TOKEN}`,
      inactiveCfg
    );
    assert.deepEqual(disabledDecision, { shouldRedirect: false, reason: 'redirect_disabled' });

    // 6.2 Simulación con compuerta activada para validar topología N->1 directa (A->C y B->C sin pasar por B)
    const activeThirdDomainCfg = resolveDomainConfig({
      env: {
        VITE_APP_ENV: 'production',
        PUBLIC_APP_ORIGIN: 'https://dominio-c.app',
        LEGACY_APP_ORIGINS: 'https://puntoencuentro.com.ar, https://dominio-b.app, https://dominio-c.app',
        ENABLE_LEGACY_DOMAIN_REDIRECT: 'true',
      },
      strict: true,
    });

    // Prevención de auto-bucle: dominio-c.app se excluye automáticamente de legacyOrigins
    assert.deepEqual(activeThirdDomainCfg.legacyOrigins, [
      'https://puntoencuentro.com.ar',
      'https://dominio-b.app',
    ]);

    const fromDomainA = resolveLegacyDomainRedirect(
      `https://puntoencuentro.com.ar/coordination/invite/${SAMPLE_PRIVATE_TOKEN}?utm_source=wa#rsvp`,
      activeThirdDomainCfg
    );
    assert.deepEqual(fromDomainA, {
      shouldRedirect: true,
      statusCode: 302,
      destinationUrl: `https://dominio-c.app/coordination/invite/${SAMPLE_PRIVATE_TOKEN}?utm_source=wa#rsvp`,
    });

    const fromDomainB = resolveLegacyDomainRedirect(
      `https://dominio-b.app/e/${SAMPLE_UUID}`,
      activeThirdDomainCfg,
      { permanent: true }
    );
    assert.deepEqual(fromDomainB, {
      shouldRedirect: true,
      statusCode: 308,
      destinationUrl: `https://dominio-c.app/e/${SAMPLE_UUID}`,
    });

    // Petición ya en Dominio C -> no redirige
    const alreadyCanonical = resolveLegacyDomainRedirect(
      `https://dominio-c.app/join/${SAMPLE_PUBLIC_TOKEN}`,
      activeThirdDomainCfg
    );
    assert.deepEqual(alreadyCanonical, {
      shouldRedirect: false,
      reason: 'already_canonical_or_non_legacy',
    });

    // Host externo desconocido -> jamás redirige
    const unknownHost = resolveLegacyDomainRedirect(
      'https://attacker.org/join/12345678',
      activeThirdDomainCfg
    );
    assert.deepEqual(unknownHost, {
      shouldRedirect: false,
      reason: 'already_canonical_or_non_legacy',
    });

    // Exenciones críticas: puente de migración de identidad, Service Worker y callbacks OAuth/PKCE en vuelo
    assert.equal(
      resolveLegacyDomainRedirect('https://puntoencuentro.com.ar/auth/domain-bridge', activeThirdDomainCfg)
        .shouldRedirect,
      false
    );
    assert.equal(
      resolveLegacyDomainRedirect('https://puntoencuentro.com.ar/sw.js', activeThirdDomainCfg)
        .shouldRedirect,
      false
    );
    assert.equal(
      resolveLegacyDomainRedirect(
        'https://puntoencuentro.com.ar/?code=pkce_auth_code_xyz',
        activeThirdDomainCfg
      ).shouldRedirect,
      false
    );
    assert.equal(
      resolveLegacyDomainRedirect(
        'https://puntoencuentro.com.ar/#access_token=jwt_here&refresh_token=ref_here',
        activeThirdDomainCfg
      ).shouldRedirect,
      false
    );

    // Rechazo de paths ambiguos / open-redirect bypass (//evil.com)
    const doubleSlashBypass = resolveLegacyDomainRedirect(
      'https://puntoencuentro.com.ar//evil.com/phish',
      activeThirdDomainCfg
    );
    assert.deepEqual(doubleSlashBypass, {
      shouldRedirect: false,
      reason: 'unsafe_path_rejected',
    });

    // parseLegacyOrigins rechaza esquemas inseguros en dominios históricos
    assert.throws(
      () => parseLegacyOrigins('http://puntoencuentro.com.ar'),
      (err: unknown) => err instanceof DomainConfigError && err.code === 'insecure_origin_scheme'
    );

    console.log('✔ 6. Estrategia N->1 de dominios históricos (cero cadenas, exenciones OAuth/Bridge/SW y anti-bypass) verificada.');
  }

  // -------------------------------------------------------------------------
  // 7. Metadatos Open Graph, separación de marca y privacidad
  // -------------------------------------------------------------------------
  {
    const customBrand = resolveBrandConfig({
      APP_BRAND_NAME: 'ConOtrosTest',
      APP_SHORT_NAME: 'ConOtros',
      PUBLIC_SUPPORT_EMAIL: 'hola@conotros.example',
      APP_TWITTER_SITE: '@conotros',
    });
    assert.equal(customBrand.brandName, 'ConOtrosTest');
    assert.equal(customBrand.shortName, 'ConOtros');
    assert.equal(customBrand.publicSupportMailto, 'mailto:hola@conotros.example');
    assert.equal(customBrand.calendarUidNamespace, PERSISTENT_CALENDAR_UID_NAMESPACE);

    const og = generateOpenGraphHtml({
      title: 'Mates al sol',
      description: 'Parque San Martín — Traer equipo de mate',
      url: `https://conotros.example/e/${SAMPLE_UUID}`,
      imageUrl: 'https://conotros.example/images/og-share.png',
      siteName: customBrand.brandName,
      ctaLabel: customBrand.openEncounterCtaLabel,
      twitterSite: customBrand.twitterSiteHandle,
      targetSpaUrl: `https://conotros.example/?open_encounter=${SAMPLE_UUID}`,
    });
    assert.ok(og.includes('<title>Mates al sol | ConOtrosTest</title>'));
    assert.ok(og.includes('Ver encuentro en ConOtrosTest'));
    assert.ok(og.includes('content="@conotros"'));

    const shareText = buildOpenEncounterShareText(
      { id: SAMPLE_UUID, title: '' },
      `https://puntoencuentro.com.ar/e/${SAMPLE_UUID}`
    );
    assert.ok(shareText.includes('Encuentro en PuntoEncuentro'));

    console.log('✔ 7. Separación entre marca visible, metadatos sociales y dominio físico validada.');
  }

  // -------------------------------------------------------------------------
  // 8. Redacción anti-fuga de tokens en logs y normalización de feedback
  // -------------------------------------------------------------------------
  {
    assert.equal(
      redactSensitiveUrlForLogs(`https://puntoencuentro.com.ar/invite/${SAMPLE_PRIVATE_TOKEN}?token=sec123#frag`),
      'https://puntoencuentro.com.ar/invite/[REDACTED_TOKEN]?token=%5BREDACTED%5D#[REDACTED_FRAGMENT]'
    );
    assert.equal(
      redactSensitiveUrlForLogs(`/coordination/join/${SAMPLE_PUBLIC_TOKEN}`),
      '/coordination/join/[REDACTED_TOKEN]'
    );
    assert.equal(
      redactSensitiveUrlForLogs(`/join/${SAMPLE_PUBLIC_TOKEN}`),
      '/join/[REDACTED_TOKEN]'
    );

    assert.equal(normalizeRouteForFeedback(`/e/${SAMPLE_UUID}`), '/e/:id');
    assert.equal(normalizeRouteForFeedback('/solicitudes?open_encounter=' + SAMPLE_UUID), '/solicitudes');
    assert.equal(normalizeRouteForFeedback(`/invite/${SAMPLE_PRIVATE_TOKEN}`), '/invite/:token');

    console.log('✔ 8. Sanitización de tokens privados en logs y rutas de feedback verificada.');
  }

  // -------------------------------------------------------------------------
  // 9. Seguridad de redirección post-OAuth Google
  // -------------------------------------------------------------------------
  {
    assert.equal(isValidPostAuthRedirect(`/e/${SAMPLE_UUID}`), true);
    assert.equal(isValidPostAuthRedirect(`/?open_encounter=${SAMPLE_UUID}`), true);
    assert.equal(isValidPostAuthRedirect(`/solicitudes?open_encounter=${SAMPLE_UUID}`), true);
    assert.equal(isOwnershipDependentRoute(`/e/${SAMPLE_UUID}`), false);
    assert.equal(isOwnershipDependentRoute(`/meet/${SAMPLE_UUID}`), true);

    // Pruebas negativas de seguridad post-auth
    assert.equal(isValidPostAuthRedirect(`/?open_encounter=https://evil.com`), false);
    assert.equal(isValidPostAuthRedirect(`/?access_token=secret`), false);
    assert.equal(isValidPostAuthRedirect(`/e/not-a-uuid`), false);
    assert.equal(isValidPostAuthRedirect('https://evil.com/e/' + SAMPLE_UUID), false);
    assert.equal(isValidPostAuthRedirect('//evil.com'), false);

    // Verificar que AuthContext conserva redirectTo: window.location.origin (same-origin OAuth PKCE)
    const authCtxSource = fs.readFileSync(path.resolve('src/contexts/AuthContext.tsx'), 'utf8');
    assert.match(authCtxSource, /redirectTo:\s*window\.location\.origin/);

    console.log('✔ 9. Flujo Google OAuth y validación post-auth seguros y sin regresiones.');
  }

  // -------------------------------------------------------------------------
  // 10. Integridad de claves locales, UID RFC 5545 e invariantes no destructivas
  // -------------------------------------------------------------------------
  {
    // Claves críticas de localStorage NO renombradas ni eliminadas (Restricción 6)
    const authLibSource = fs.readFileSync(path.resolve('src/lib/auth.ts'), 'utf8');
    assert.ok(authLibSource.includes("'puntoencuentro_host_id'"), 'Clave puntoencuentro_host_id intacta');

    const partTokensSource = fs.readFileSync(path.resolve('src/lib/participatedTokens.ts'), 'utf8');
    assert.ok(partTokensSource.includes("'participated_tokens'"), 'Clave participated_tokens intacta');
    assert.ok(partTokensSource.includes("'encuentros_general'"), 'Clave encuentros_general intacta');

    const meetHostsSource = fs.readFileSync(path.resolve('src/lib/meetHostsStorage.ts'), 'utf8');
    assert.ok(meetHostsSource.includes("'puntoencuentro_meet_hosts'"), 'Clave puntoencuentro_meet_hosts intacta');

    // Identificador persistente RFC 5545 en exportación .ics desacoplado del cambio de dominio web
    const ics = generateIcsContent({
      id: SAMPLE_UUID,
      titulo: 'Cena de prueba',
      fecha: '2027-03-15',
      hora: '21:00',
      modalidad: 'presencial',
      lugar_texto: 'Punto acordado',
    });
    assert.ok(ics.includes(`UID:pe-${SAMPLE_UUID}@puntoencuentro.com.ar\r\n`));

    // vercel.json NO debe tener redirecciones globales activadas prematuramente (Restricción 4)
    const vercelConfig = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8'));
    assert.equal(vercelConfig.redirects, undefined, 'No deben existir redirecciones globales activas en vercel.json');

    // Branding actual conservado (Restricciones 2 y 3)
    const manifest = JSON.parse(fs.readFileSync(path.resolve('public/manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.name, 'PuntoEncuentro');
    assert.equal(manifest.short_name, 'PuntoEncuentro');

    console.log('✔ 10. Claves de almacenamiento local, UID .ics, manifest y vercel.json conservados sin cambios destructivos.');
  }

  // -------------------------------------------------------------------------
  // 11. Despliegues Preview en Vercel (VERCEL_URL / VERCEL_BRANCH_URL) y JS Escaping OG
  // -------------------------------------------------------------------------
  {
    const previewEnv = {
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'chore/domain-migration-readiness',
      VERCEL_BRANCH_URL: 'nueva-marca-git-chore-domain-migration-puntoxlabs.vercel.app',
      VERCEL_URL: 'nueva-marca-9f8e7d6c5-puntoxlabs.vercel.app',
    };

    const extracted = extractTrustedVercelPreviewOrigins(previewEnv);
    assert.deepEqual(extracted, [
      'https://nueva-marca-git-chore-domain-migration-puntoxlabs.vercel.app',
      'https://nueva-marca-9f8e7d6c5-puntoxlabs.vercel.app',
    ]);

    // En build de Preview sin VITE_APP_URL explícita, adopta el origen oficial de la rama
    const previewBuildCfg = resolveDomainConfig({ env: previewEnv, strict: true });
    assert.equal(previewBuildCfg.environment, 'preview');
    assert.equal(
      previewBuildCfg.canonicalOrigin,
      'https://nueva-marca-git-chore-domain-migration-puntoxlabs.vercel.app'
    );

    // En navegador sobre la URL inmutable con hash (<proyecto>-<hash>-<equipo>.vercel.app), conserva ese origen
    const previewHashBrowserCfg = resolveDomainConfig({
      env: previewEnv,
      runtimeBrowserOrigin: 'https://nueva-marca-9f8e7d6c5-puntoxlabs.vercel.app',
    });
    assert.equal(
      previewHashBrowserCfg.canonicalOrigin,
      'https://nueva-marca-9f8e7d6c5-puntoxlabs.vercel.app'
    );

    // En api/open-encounter.ts sobre Preview: acepta ambos hosts asignados por Vercel,
    // proyectando siempre el canonicalOrigin único del build (coherente con dist/index.html)
    // y manteniendo spaRedirectOrigin en el host confiable consultado; rechaza .vercel.app ajenos.
    const serverHashRes = resolveServerCanonicalOrigin({
      headers: { host: 'nueva-marca-9f8e7d6c5-puntoxlabs.vercel.app' },
      env: previewEnv,
    });
    assert.equal(serverHashRes.isTrustedRequestHost, true);
    assert.equal(
      serverHashRes.canonicalOrigin,
      'https://nueva-marca-git-chore-domain-migration-puntoxlabs.vercel.app'
    );
    assert.equal(
      serverHashRes.spaRedirectOrigin,
      'https://nueva-marca-9f8e7d6c5-puntoxlabs.vercel.app'
    );

    const serverForgedVercelTenant = resolveServerCanonicalOrigin({
      headers: { host: 'puntoencuentro-git-evil-attacker.vercel.app' },
      env: previewEnv,
    });
    assert.equal(serverForgedVercelTenant.isTrustedRequestHost, false);
    assert.equal(
      serverForgedVercelTenant.canonicalOrigin,
      'https://nueva-marca-git-chore-domain-migration-puntoxlabs.vercel.app'
    );
    assert.equal(
      serverForgedVercelTenant.spaRedirectOrigin,
      'https://nueva-marca-git-chore-domain-migration-puntoxlabs.vercel.app'
    );

    // Verificar que en Producción las variables VERCEL_URL jamás alteren el dominio canónico
    const prodWithVercelUrl = resolveDomainConfig({
      env: {
        VERCEL_ENV: 'production',
        VERCEL_GIT_COMMIT_REF: 'main',
        VERCEL_URL: 'puntoencuentro-prodhash-puntoxlabs.vercel.app',
      },
      strict: true,
    });
    assert.equal(prodWithVercelUrl.canonicalOrigin, DEFAULT_PRODUCTION_ORIGIN);

    // Verificar serialización JS segura en generateOpenGraphHtml (<script> context)
    const ogWithMultiParams = generateOpenGraphHtml({
      title: 'Encuentro Seguro',
      description: 'Desc',
      url: `https://puntoencuentro.com.ar/e/${SAMPLE_UUID}`,
      imageUrl: 'https://puntoencuentro.com.ar/images/og-share.png',
      targetSpaUrl: `https://puntoencuentro.com.ar/?open_encounter=${SAMPLE_UUID}&ref=1`,
    });
    assert.ok(
      ogWithMultiParams.includes(
        `window.location.replace("https://puntoencuentro.com.ar/?open_encounter=${SAMPLE_UUID}&ref=1");`
      ),
      'El bloque <script> no debe corromper & como &amp; en URLs válidas'
    );

    const ogScriptBreakoutAttempt = generateOpenGraphHtml({
      title: 'Test',
      description: 'Test',
      url: 'https://puntoencuentro.com.ar',
      imageUrl: 'https://puntoencuentro.com.ar/images/og-share.png',
      targetSpaUrl: 'https://puntoencuentro.com.ar/</script><script>alert(1)</script>',
    });
    assert.ok(
      !ogScriptBreakoutAttempt.includes('</script><script>alert(1)'),
      'Intento de cierre prematuro de </script> neutralizado'
    );

    // Caso real de topología Vercel (dpl_8vUaWgPPFrmZego7u2oFmrnCkTHr):
    // En ramas PR de Preview distintas de `staging`, Vercel inyecta la variable transversal
    // `VITE_APP_URL=https://puntoencuentro.com.ar` ("Production, Preview, Development").
    // El build estricto, el cliente y el serverless deben ignorar esa herencia productiva
    // y resolver el origen efímero de Preview sin fallar ni apuntar enlaces a Producción.
    const inheritedProdViteUrlPreviewEnv = {
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'chore/domain-migration-readiness',
      VITE_APP_URL: 'https://puntoencuentro.com.ar',
      VERCEL_BRANCH_URL:
        'puntoencuentro-git-chore-dom-a1b2c3-puntoxlabs-projects.vercel.app',
      VERCEL_URL: 'puntoencuentro-8vuawgppfrmz-puntoxlabs-projects.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'puntoencuentro.com.ar',
    };

    const previewInheritedBuildCfg = validateBuildDomainConfig(inheritedProdViteUrlPreviewEnv);
    assert.equal(previewInheritedBuildCfg.environment, 'preview');
    assert.equal(
      previewInheritedBuildCfg.canonicalOrigin,
      'https://puntoencuentro-git-chore-dom-a1b2c3-puntoxlabs-projects.vercel.app'
    );

    const previewInheritedBrowserCfg = resolveDomainConfig({
      env: inheritedProdViteUrlPreviewEnv,
      runtimeBrowserOrigin: 'https://puntoencuentro-8vuawgppfrmz-puntoxlabs-projects.vercel.app',
    });
    assert.equal(
      previewInheritedBrowserCfg.canonicalOrigin,
      'https://puntoencuentro-8vuawgppfrmz-puntoxlabs-projects.vercel.app'
    );

    const previewInheritedServerRes = resolveServerCanonicalOrigin({
      headers: { host: 'puntoencuentro-8vuawgppfrmz-puntoxlabs-projects.vercel.app' },
      env: inheritedProdViteUrlPreviewEnv,
    });
    assert.equal(previewInheritedServerRes.isTrustedRequestHost, true);
    assert.equal(
      previewInheritedServerRes.canonicalOrigin,
      'https://puntoencuentro-git-chore-dom-a1b2c3-puntoxlabs-projects.vercel.app'
    );
    assert.equal(
      previewInheritedServerRes.spaRedirectOrigin,
      'https://puntoencuentro-8vuawgppfrmz-puntoxlabs-projects.vercel.app'
    );

    // También cubre futura migración a Dominio B vía VERCEL_PROJECT_PRODUCTION_URL
    const futureBrandInheritedPreviewCfg = validateBuildDomainConfig({
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'feat/nueva-funcionalidad',
      VITE_APP_URL: 'https://encuentros-nuevamarca.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'encuentros-nuevamarca.app',
      VERCEL_BRANCH_URL: 'nuevamarca-git-feat-nueva-a1b2c3-puntoxlabs-projects.vercel.app',
    });
    assert.equal(
      futureBrandInheritedPreviewCfg.canonicalOrigin,
      'https://nuevamarca-git-feat-nueva-a1b2c3-puntoxlabs-projects.vercel.app'
    );

    // Seguridad preservada: esquemas inseguros o PUBLIC_APP_ORIGIN productivo explícito en Preview siguen fallando cerrado
    assert.throws(
      () =>
        validateBuildDomainConfig({
          VERCEL_ENV: 'preview',
          VERCEL_GIT_COMMIT_REF: 'feat/test',
          VITE_APP_URL: 'http://puntoencuentro.com.ar',
        }),
      (err: unknown) => err instanceof DomainConfigError && err.code === 'insecure_origin_scheme'
    );
    assert.throws(
      () =>
        validateBuildDomainConfig({
          VERCEL_ENV: 'preview',
          VERCEL_GIT_COMMIT_REF: 'feat/test',
          PUBLIC_APP_ORIGIN: 'https://puntoencuentro.com.ar',
        }),
      (err: unknown) =>
        err instanceof DomainConfigError && err.code === 'cross_environment_origin_mismatch'
    );

    console.log('✔ 11. Despliegues Preview en Vercel (VERCEL_URL/VERCEL_BRANCH_URL y herencia transversal) y escapado JS OG verificados.');
  }

  // -------------------------------------------------------------------------
  // 12. Reproducción real del bundle de navegador (sin `process.env` de Node),
  //     coherencia HTML estático vs api/open-encounter.ts y ciclo Dominio A -> B -> C
  // -------------------------------------------------------------------------
  {
    // 12.1 Escenario exacto Dominio B (`https://nuevamarca.app`):
    // - Producción usa `https://nuevamarca.app` (`VERCEL_PROJECT_PRODUCTION_URL=nuevamarca.app`).
    // - Vercel Preview hereda `VITE_APP_URL=https://nuevamarca.app`.
    // - `VERCEL_PROJECT_PRODUCTION_URL` existe en build y serverless, pero NO existe `process.env` en navegador.
    // - `__APP_ENV__="preview"` y el navegador ejecuta en `https://preview-ejemplo.vercel.app`.
    const domainBPreviewEnv = {
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'feat/rebrand-dominio-b',
      VITE_APP_URL: 'https://nuevamarca.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'nuevamarca.app',
      VERCEL_BRANCH_URL: 'preview-ejemplo.vercel.app',
      VERCEL_URL: 'nuevamarca-9f8e7d6c5-puntoxlabs.vercel.app',
      // Verificar además que secretos exclusivos de servidor jamás se filtren a `__PUBLIC_DOMAIN_BUILD_ENV__`
      SUPABASE_STAGING_SECRET_KEY: 'SENTINEL_DO_NOT_INLINE_SECRET_999',
    };

    const domainBPreviewArtifact = await buildRealClientArtifactForEnv(domainBPreviewEnv);
    assert.equal(
      domainBPreviewArtifact.bundleCode.includes('SENTINEL_DO_NOT_INLINE_SECRET_999'),
      false,
      'CRÍTICO: Secretos de servidor jamás deben inyectarse al bundle público del navegador'
    );

    // Evaluación en VM pura de navegador sobre URL de rama (`https://preview-ejemplo.vercel.app`)
    const browserOnBranch = evaluateClientBundleInBrowserVm(
      domainBPreviewArtifact.bundleCode,
      'https://preview-ejemplo.vercel.app'
    );
    assert.equal(browserOnBranch.environment, 'preview');
    assert.equal(
      browserOnBranch.canonicalOrigin,
      'https://preview-ejemplo.vercel.app',
      'El frontend de Preview NO debe emitir la URL productiva heredada (https://nuevamarca.app)'
    );
    assert.equal(
      browserOnBranch.generalInviteUrl,
      `https://preview-ejemplo.vercel.app/join/${SAMPLE_PUBLIC_TOKEN}`
    );
    assert.equal(
      browserOnBranch.individualInviteUrl,
      `https://preview-ejemplo.vercel.app/invite/${SAMPLE_PRIVATE_TOKEN}`
    );
    assert.equal(
      browserOnBranch.openEncounterUrl,
      `https://preview-ejemplo.vercel.app/e/${SAMPLE_UUID}`
    );
    assert.equal(
      browserOnBranch.openEncounterQueryUrl,
      `https://preview-ejemplo.vercel.app/?open_encounter=${SAMPLE_UUID}`
    );

    // Evaluación del mismo bundle en navegador sobre la URL inmutable (`VERCEL_URL`) y sobre un alias PR `.vercel.app`
    const browserOnImmutable = evaluateClientBundleInBrowserVm(
      domainBPreviewArtifact.bundleCode,
      'https://nuevamarca-9f8e7d6c5-puntoxlabs.vercel.app'
    );
    assert.equal(
      browserOnImmutable.canonicalOrigin,
      'https://nuevamarca-9f8e7d6c5-puntoxlabs.vercel.app'
    );

    const browserOnPrAlias = evaluateClientBundleInBrowserVm(
      domainBPreviewArtifact.bundleCode,
      'https://nuevamarca-pr-42-puntoxlabs.vercel.app'
    );
    assert.equal(
      browserOnPrAlias.canonicalOrigin,
      'https://nuevamarca-pr-42-puntoxlabs.vercel.app'
    );

    // 12.2 Coherencia de URLs canónicas entre HTML estático (`dist/index.html`) y `api/open-encounter.ts`
    // cuando un mismo despliegue Preview se consulta por URL de rama y por URL inmutable:
    assert.ok(
      domainBPreviewArtifact.indexHtml.includes(
        '<meta property="og:url" content="https://preview-ejemplo.vercel.app/" />'
      ),
      'HTML estático debe proyectar el origen canónico de la rama de Preview en og:url'
    );
    assert.ok(
      domainBPreviewArtifact.indexHtml.includes(
        '<link rel="canonical" href="https://preview-ejemplo.vercel.app/" />'
      ),
      'HTML estático debe proyectar el origen canónico de la rama de Preview en rel=canonical'
    );
    assert.ok(
      domainBPreviewArtifact.indexHtml.includes(
        '<meta property="og:image" content="https://preview-ejemplo.vercel.app/images/og-share.png" />'
      ),
      'HTML estático debe proyectar og:image sobre el origen canónico de Preview'
    );

    // Ejecutar handler real de `api/open-encounter.ts` bajo las mismas variables de entorno de Preview
    const savedServerEnv = new Map<string, string | undefined>();
    const serverKeys = [
      'VITE_APP_ENV',
      'VITE_APP_URL',
      'PUBLIC_APP_ORIGIN',
      'VERCEL_ENV',
      'VERCEL_GIT_COMMIT_REF',
      'VERCEL_BRANCH_URL',
      'VERCEL_URL',
      'VERCEL_PROJECT_PRODUCTION_URL',
      'VITE_SUPABASE_URL',
      'SUPABASE_URL',
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ];
    for (const k of serverKeys) savedServerEnv.set(k, process.env[k]);

    try {
      for (const k of serverKeys) delete process.env[k];
      process.env.VERCEL_ENV = 'preview';
      process.env.VERCEL_GIT_COMMIT_REF = 'feat/rebrand-dominio-b';
      process.env.VITE_APP_URL = 'https://nuevamarca.app';
      process.env.VERCEL_PROJECT_PRODUCTION_URL = 'nuevamarca.app';
      process.env.VERCEL_BRANCH_URL = 'preview-ejemplo.vercel.app';
      process.env.VERCEL_URL = 'nuevamarca-9f8e7d6c5-puntoxlabs.vercel.app';

      // Crawler en URL de rama vs Crawler en URL inmutable -> idéntica URL canónica y og:image que dist/index.html
      let botBranchHtml = '';
      await openEncounterHandler(
        {
          query: { id: SAMPLE_UUID },
          headers: {
            'user-agent': 'WhatsApp/2.24.1 i',
            host: 'preview-ejemplo.vercel.app',
          },
        },
        {
          writeHead(code: number) {
            assert.equal(code, 200);
          },
          end(body: string) {
            botBranchHtml = body;
          },
        }
      );

      let botImmutableHtml = '';
      await openEncounterHandler(
        {
          query: { id: SAMPLE_UUID },
          headers: {
            'user-agent': 'WhatsApp/2.24.1 i',
            host: 'nuevamarca-9f8e7d6c5-puntoxlabs.vercel.app',
          },
        },
        {
          writeHead(code: number) {
            assert.equal(code, 200);
          },
          end(body: string) {
            botImmutableHtml = body;
          },
        }
      );

      const expectedCanonicalEncounterUrl = `https://preview-ejemplo.vercel.app/e/${SAMPLE_UUID}`;
      const expectedCanonicalOgImage = 'https://preview-ejemplo.vercel.app/images/og-share.png';

      for (const [label, html] of [
        ['URL de rama', botBranchHtml],
        ['URL inmutable', botImmutableHtml],
      ] as const) {
        assert.ok(
          html.includes(`<meta property="og:url" content="${expectedCanonicalEncounterUrl}" />`),
          `og:url incoherente en ${label}`
        );
        assert.ok(
          html.includes(`<link rel="canonical" href="${expectedCanonicalEncounterUrl}" />`),
          `rel=canonical incoherente en ${label}`
        );
        assert.ok(
          html.includes(`<meta property="og:image" content="${expectedCanonicalOgImage}" />`),
          `og:image incoherente en ${label}`
        );
        assert.equal(
          html.includes('nuevamarca.app'),
          false,
          `No debe filtrarse el dominio productivo heredado en ${label}`
        );
      }

      // Navegador humano en URL de rama vs URL inmutable -> 302 permanece en el subdominio confiable visitado
      let branch302 = '';
      await openEncounterHandler(
        {
          query: { id: SAMPLE_UUID },
          headers: {
            'user-agent': 'Mozilla/5.0 Chrome/130.0',
            host: 'preview-ejemplo.vercel.app',
          },
        },
        {
          writeHead(code: number, hdrs: Record<string, string>) {
            assert.equal(code, 302);
            branch302 = hdrs.Location || '';
          },
          end() {},
        }
      );
      assert.equal(branch302, `https://preview-ejemplo.vercel.app/?open_encounter=${SAMPLE_UUID}`);

      let immutable302 = '';
      await openEncounterHandler(
        {
          query: { id: SAMPLE_UUID },
          headers: {
            'user-agent': 'Mozilla/5.0 Chrome/130.0',
            host: 'nuevamarca-9f8e7d6c5-puntoxlabs.vercel.app',
          },
        },
        {
          writeHead(code: number, hdrs: Record<string, string>) {
            assert.equal(code, 302);
            immutable302 = hdrs.Location || '';
          },
          end() {},
        }
      );
      assert.equal(
        immutable302,
        `https://nuevamarca-9f8e7d6c5-puntoxlabs.vercel.app/?open_encounter=${SAMPLE_UUID}`
      );
    } finally {
      for (const [k, v] of savedServerEnv.entries()) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // 12.3 Escenario futuro Dominio B -> Dominio C (`https://nuevamarca.app` -> `https://marcac.app`) en navegador real:
    // Cubre TANTO herencia de `VITE_APP_URL=https://marcac.app` (Dominio C activo) COMO herencia rezagada de
    // `VITE_APP_URL=https://nuevamarca.app` (Dominio B en `LEGACY_APP_ORIGINS`) durante la transición a Dominio C.
    const domainCPreviewInheritedActive = await buildRealClientArtifactForEnv({
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'feat/migracion-dominio-c',
      VITE_APP_URL: 'https://marcac.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'marcac.app',
      LEGACY_APP_ORIGINS: 'https://puntoencuentro.com.ar,https://nuevamarca.app',
      VERCEL_BRANCH_URL: 'marcac-git-feat-puntoxlabs.vercel.app',
    });
    const evalDomainCActive = evaluateClientBundleInBrowserVm(
      domainCPreviewInheritedActive.bundleCode,
      'https://marcac-git-feat-puntoxlabs.vercel.app'
    );
    assert.equal(evalDomainCActive.canonicalOrigin, 'https://marcac-git-feat-puntoxlabs.vercel.app');
    assert.equal(
      evalDomainCActive.generalInviteUrl,
      `https://marcac-git-feat-puntoxlabs.vercel.app/join/${SAMPLE_PUBLIC_TOKEN}`
    );

    const domainCPreviewStaleDomainB = await buildRealClientArtifactForEnv({
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'feat/migracion-dominio-c',
      VITE_APP_URL: 'https://nuevamarca.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'marcac.app',
      LEGACY_APP_ORIGINS: 'https://puntoencuentro.com.ar,https://nuevamarca.app',
      VERCEL_BRANCH_URL: 'marcac-git-feat-puntoxlabs.vercel.app',
    });
    const evalDomainCStaleB = evaluateClientBundleInBrowserVm(
      domainCPreviewStaleDomainB.bundleCode,
      'https://marcac-git-feat-puntoxlabs.vercel.app'
    );
    assert.equal(evalDomainCStaleB.canonicalOrigin, 'https://marcac-git-feat-puntoxlabs.vercel.app');

    // Producción sobre Dominio C en navegador real (incluso si un usuario entra por alias antiguo Dominio B)
    const domainCProdArtifact = await buildRealClientArtifactForEnv({
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: 'main',
      VITE_APP_URL: 'https://marcac.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'marcac.app',
      LEGACY_APP_ORIGINS: 'https://puntoencuentro.com.ar,https://nuevamarca.app',
      APP_BRAND_NAME: 'MarcaC',
    });
    const evalDomainCProd = evaluateClientBundleInBrowserVm(
      domainCProdArtifact.bundleCode,
      'https://nuevamarca.app'
    );
    assert.equal(evalDomainCProd.environment, 'production');
    assert.equal(evalDomainCProd.canonicalOrigin, 'https://marcac.app');
    assert.deepEqual(evalDomainCProd.legacyOrigins, [
      'https://puntoencuentro.com.ar',
      'https://nuevamarca.app',
    ]);
    assert.equal(evalDomainCProd.brandName, 'MarcaC');
    assert.equal(
      evalDomainCProd.openEncounterUrl,
      `https://marcac.app/e/${SAMPLE_UUID}`
    );

    // 12.4 Preservación de overrides legítimos de Staging y Preview + bloqueo de cruce Staging/Producción en Dominio B/C:
    const stagingOverrideArtifact = await buildRealClientArtifactForEnv({
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'staging',
      VITE_APP_ENV: 'staging',
      VITE_APP_URL: 'https://staging.marcac.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'marcac.app',
      LEGACY_APP_ORIGINS: 'https://puntoencuentro.com.ar,https://nuevamarca.app',
    });
    const evalStagingOverride = evaluateClientBundleInBrowserVm(
      stagingOverrideArtifact.bundleCode,
      'https://staging.marcac.app'
    );
    assert.equal(evalStagingOverride.environment, 'staging');
    assert.equal(evalStagingOverride.canonicalOrigin, 'https://staging.marcac.app');

    const customPreviewOverrideArtifact = await buildRealClientArtifactForEnv({
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'feat/custom-qa-domain',
      VITE_APP_URL: 'https://qa-preview.marcac.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'marcac.app',
      VERCEL_BRANCH_URL: 'marcac-git-feat-puntoxlabs.vercel.app',
    });
    const evalCustomPreviewOverride = evaluateClientBundleInBrowserVm(
      customPreviewOverrideArtifact.bundleCode,
      'https://marcac-git-feat-puntoxlabs.vercel.app'
    );
    assert.equal(evalCustomPreviewOverride.environment, 'preview');
    assert.equal(evalCustomPreviewOverride.canonicalOrigin, 'https://qa-preview.marcac.app');

    // Si Staging hereda accidentalmente el nuevo dominio productivo (Dominio B o C), falla cerrado en build
    assert.throws(
      () =>
        validateBuildDomainConfig({
          VITE_APP_ENV: 'staging',
          VITE_APP_URL: 'https://marcac.app',
          VERCEL_PROJECT_PRODUCTION_URL: 'marcac.app',
        }),
      (err: unknown) =>
        err instanceof DomainConfigError && err.code === 'cross_environment_origin_mismatch'
    );

    console.log(
      '✔ 12. Bundle real de navegador (sin process.env), coherencia HTML estático vs api/open-encounter.ts y transición Dominio A -> B -> C verificados.'
    );
  }

  console.log('=== DOMAIN MIGRATION READINESS SUITE: 12/12 BLOQUES APROBADOS ===\n');
}

await runDomainMigrationReadinessTests();
