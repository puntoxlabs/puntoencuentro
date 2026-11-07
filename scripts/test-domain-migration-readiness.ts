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
import path from 'node:path';
import {
  DEFAULT_PRODUCTION_ORIGIN,
  DEFAULT_STAGING_ORIGIN,
  DomainConfigError,
  PERSISTENT_CALENDAR_UID_NAMESPACE,
  buildPublicAppUrl,
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

  console.log('=== DOMAIN MIGRATION READINESS SUITE: 10/10 BLOQUES APROBADOS ===\n');
}

await runDomainMigrationReadinessTests();
